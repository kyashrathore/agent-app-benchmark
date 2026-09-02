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
  generator: "opencode-completed-sessions-v2",
  seed: "test-seed",
  sourceEventFormat: {
    id: "opencode-event-v2",
    sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a",
    envelope: "EventV2.SerializedEvent",
    eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"],
  },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [4096, 8192],
  sessionProfiles: [4096, 8192].map((transcriptBytes) => ({
    transcriptBytes,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    patches: 0,
    payloadPermille: { text: 250, reasoning: 250, toolInput: 250, toolOutput: 250 },
  })),
  derivation: {
    method: "rounded structural distributions with entirely synthetic payloads",
    sourceFamilies: ["opencode", "claude-code", "codex"],
    privateContentCopied: false,
  },
  description: "Small deterministic test corpus.",
};

test("public corpus defines one control and four lane sessions per size", async () => {
  const corpus = await readRegistered("corpus", "opencode-completed-sessions-v2");
  const sessions = buildSessionDefinitions(corpus.value);
  assert.equal(sessions.length, 17);
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

test("V3 corpus provides independent latency, size-sweep, and retention destinations", async () => {
  const corpus = await readRegistered("corpus", "opencode-completed-sessions-v3");
  const sessions = buildSessionDefinitions(corpus.value);
  assert.equal(sessions.length, 53);
  assert.equal(sessions.filter((session) => session.logicalSessionId.startsWith("latency-")).length, 40);
  assert.equal(sessions.filter((session) => session.role === "size-latency").length, 8);
  assert.equal(sessions.filter((session) => session.role === "progressive-resource").length, 4);
  assert.equal(new Set(sessions.map((session) => session.logicalSessionId)).size, sessions.length);
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
    assert.ok(verified.manifest.sessions.every((session) => session.eventCount === 9));
    const controlEvents = (await readFile(path.join(first.path, first.manifest.sessions[0].file), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const messages = controlEvents
      .filter((event) => event.type === "message.updated.1")
      .map((event) => event.data.info);
    assert.deepEqual(messages.map((message) => message.id).toSorted(), messages.map((message) => message.id));
    assert.ok(messages.every((message) => /^msg_[0-9a-f]{26}$/.test(message.id)));
    const textParts = controlEvents
      .filter((event) => event.type === "message.part.updated.1")
      .filter((event) => event.data.part.type === "text")
      .map((event) => event.data.part.text);
    assert.ok(textParts.every((text) => text.length > 0 && !text.includes("/Users/") && !text.includes("@")));
    assert.deepEqual(new Set(controlEvents.filter((event) => event.type === "message.part.updated.1").map((event) => event.data.part.type)), new Set([
      "text", "reasoning", "tool", "step-start", "step-finish",
    ]));
    assert.equal(verified.manifest.derivation.privateContentCopied, false);
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

test("V4 corpus halves the latency lanes and adds long-row size destinations", async () => {
  const corpus = await readRegistered("corpus", "opencode-completed-sessions-v4");
  const sessions = buildSessionDefinitions(corpus.value);
  assert.equal(sessions.length, 1 + 4 * 5 + 2 * 4 + 2 * 3 + 4);
  assert.equal(sessions.filter((session) => session.logicalSessionId.startsWith("latency-")).length, 20);
  assert.equal(sessions.filter((session) => session.role === "size-latency").length, 8);
  const longRows = sessions.filter((session) => session.role === "size-latency-long");
  assert.deepEqual(longRows.map((session) => session.logicalSessionId), [
    "size-latency-long-0-1048576", "size-latency-long-0-8388608", "size-latency-long-0-33554432",
    "size-latency-long-1-1048576", "size-latency-long-1-8388608", "size-latency-long-1-33554432",
  ]);
  // Eight text rows carry the whole transcript: no tools, no reasoning.
  assert.ok(longRows.every((session) => session.profile.toolCalls === 0 && session.profile.transcriptBytes / (session.profile.userMessages + session.profile.assistantMessages) <= 1048576 && session.profile.payloadPermille.text === 1000));
  assert.equal(new Set(sessions.map((session) => session.logicalSessionId)).size, sessions.length);
});
