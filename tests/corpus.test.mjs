import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSessionDefinitions, verifyCorpus, writeCorpus } from "../src/corpus.mjs";
import { readRegistered } from "../src/registry.mjs";

const SMALL = {
  schemaVersion: 1,
  id: "test-corpus-v1",
  generator: "opencode-completed-transcripts-v1",
  seed: "test-seed",
  sourceEventFormat: {
    id: "opencode-event-v1",
    sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a",
    envelope: "EventV2.SerializedEvent",
    eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"],
  },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [32, 64],
  messageChunkBytes: 16,
  description: "Small deterministic test corpus.",
};

test("public corpus defines one control and four lane sessions per size", async () => {
  const corpus = await readRegistered("corpus", "opencode-completed-transcripts-v1");
  const sessions = buildSessionDefinitions(corpus.value);
  assert.equal(sessions.length, 25);
  assert.equal(sessions[0].role, "control");
  for (const bytes of corpus.value.transcriptBytes) {
    assert.deepEqual(sessions.filter((session) => session.transcriptBytes === bytes && session.role !== "control").map((session) => session.role), [
      "within-workspace-cold",
      "within-workspace-warm",
      "across-workspaces-cold",
      "across-workspaces-warm",
    ]);
  }
});

test("streamed OpenCode corpus is byte-for-byte deterministic and verifies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-"));
  try {
    const first = await writeCorpus(SMALL, path.join(root, "first"));
    const second = await writeCorpus(SMALL, path.join(root, "second"));
    assert.equal(first.digestSha256, second.digestSha256);
    assert.deepEqual(first.manifest.sessions.map((session) => session.fileDigestSha256), second.manifest.sessions.map((session) => session.fileDigestSha256));
    const verified = await verifyCorpus(first.path);
    assert.equal(verified.digestSha256, first.digestSha256);
    assert.ok(verified.manifest.sessions.every((session) => session.eventCount === 1 + 2 * (session.transcriptBytes / SMALL.messageChunkBytes)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification rejects reordered event sequences", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-invalid-"));
  try {
    const generated = await writeCorpus(SMALL, path.join(root, "corpus"));
    const session = generated.manifest.sessions[0];
    const file = path.join(generated.path, session.file);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    const event = JSON.parse(lines[1]);
    event.seq = 99;
    lines[1] = JSON.stringify(event);
    await writeFile(file, `${lines.join("\n")}\n`);
    await assert.rejects(verifyCorpus(generated.path), /invalid sequence|digest mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generator never overwrites an existing directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-existing-"));
  try {
    await assert.rejects(writeCorpus(SMALL, root), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
