import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSessionDefinitions, verifyCorpus, writeCorpus } from "../src/corpus.mjs";
import { digest } from "../src/canonical-json.mjs";
import { copiesPrivateContent, readDefinition, readRegistered, validateDefinition } from "../src/registry.mjs";

const SMALL = {
  schemaVersion: 1,
  id: "test-corpus",
  generator: "opencode-completed-sessions",
  seed: "test-seed",
  sourceEventFormat: {
    id: "opencode-event",
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

test("the benchmark corpus holds every session the list walk visits, plus control and the memory run", async () => {
  const corpus = await readRegistered("corpus", "opencode-completed-sessions");
  const walk = (await readRegistered("scenario", "session-switch-walk")).value.cases.walk;
  const sessions = buildSessionDefinitions(corpus.value);
  assert.equal(sessions.length, 25);
  const ids = new Set(sessions.map((session) => session.logicalSessionId));
  assert.equal(ids.size, sessions.length);
  assert.ok(ids.has("control"));
  assert.ok(walk.sessions.every((session) => ids.has(session.sessionId)));
  const longRows = sessions.filter((session) => session.role === "size-latency-long");
  assert.deepEqual(longRows.map((session) => session.logicalSessionId), ["size-latency-long-0-1048576", "size-latency-long-1-1048576"]);
  assert.ok(longRows.every((session) => session.profile.toolCalls === 0 && session.profile.payloadPermille.text === 1000));
});

const REAL_SESSION_DERIVATION = {
  method: "redacted real agent sessions",
  sourceFamilies: ["claude-code", "codex"],
  privateContentCopied: true,
};

const REAL = {
  schemaVersion: 1,
  id: "test-real-sessions",
  generator: "redacted-real-sessions",
  seed: "test-real-seed",
  sourceEventFormat: SMALL.sourceEventFormat,
  workspaceIds: SMALL.workspaceIds,
  transcriptBytes: [1048576, 8388608],
  benchmarkTopology: { standardTranscriptBytes: 1048576, latencySamplesPerProcess: 4, sizeSamplesPerProcess: 2, longRowTranscriptBytes: [1048576] },
  derivation: REAL_SESSION_DERIVATION,
  description: "Redacted real sessions for a private run.",
};

async function rewriteDerivation(root, derivation) {
  const file = path.join(root, "manifest.json");
  const { corpusDigestSha256: _, ...core } = JSON.parse(await readFile(file, "utf8"));
  const manifestCore = { ...core, derivation };
  const corpusDigestSha256 = digest(manifestCore);
  await writeFile(file, `${JSON.stringify({ ...manifestCore, corpusDigestSha256 }, null, 2)}\n`);
  await writeFile(path.join(root, ".agent-app-benchmark-corpus"), `${corpusDigestSha256}\n`);
  return corpusDigestSha256;
}

test("a synthetic corpus keeps the synthetic derivation and cannot claim copied content", async () => {
  const { value: synthetic } = await readRegistered("corpus", "opencode-completed-sessions");
  assert.equal(copiesPrivateContent(synthetic), false);
  assert.throws(() => validateDefinition("corpus", { ...synthetic, derivation: REAL_SESSION_DERIVATION }), /schema validation/);
  assert.throws(() => validateDefinition("corpus", { ...synthetic, derivation: { ...synthetic.derivation, privateContentCopied: true } }), /schema validation/);
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-"));
  try {
    const output = path.join(root, "corpus");
    await writeCorpus(SMALL, output);
    await rewriteDerivation(output, { ...SMALL.derivation, privateContentCopied: true });
    await assert.rejects(verifyCorpus(output), /schema validation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real-session corpus verifies, runs only as custom and is never generated", async () => {
  validateDefinition("corpus", REAL);
  assert.throws(() => validateDefinition("corpus", { ...REAL, derivation: SMALL.derivation }), /schema validation/);
  assert.throws(() => validateDefinition("corpus", { ...REAL, sessionProfiles: SMALL.sessionProfiles }), /schema validation/);
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-"));
  try {
    const output = path.join(root, "corpus");
    await writeCorpus(SMALL, output);
    const corpusDigest = await rewriteDerivation(output, REAL_SESSION_DERIVATION);
    const verified = await verifyCorpus(output);
    assert.equal(verified.digestSha256, corpusDigest);
    assert.deepEqual(verified.manifest.derivation, REAL_SESSION_DERIVATION);

    const definitionFile = path.join(root, "real-corpus.json");
    await writeFile(definitionFile, JSON.stringify(REAL));
    const definition = await readDefinition("corpus", definitionFile);
    assert.equal(definition.status, "custom/non-comparable");
    assert.equal(copiesPrivateContent(definition.value), true);
    await assert.rejects(writeCorpus(REAL, path.join(root, "generated")), /cannot be generated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
