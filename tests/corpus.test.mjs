import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPublicValue, buildCorpus, measureEvents, readRecording, recordingTurns, turnsForCut, verifyCorpus } from "../src/corpus.mjs";
import { convertOpenCodeExport, RECORDED_WORKSPACE_DIRECTORY } from "../src/opencode-export.mjs";
import { readDefinition, readRegistered, recordingFileOf, validateDefinition } from "../src/registry.mjs";
import { buildTestCorpus, convertFixture, corpusDefinition, fixtureExport, HOME, WALK_CORPUS } from "./support/recorded-corpus.mjs";

const events = (file) => readFile(file, "utf8").then((text) => text.trimEnd().split("\n").map((line) => JSON.parse(line)));

test("a 2.3 export converts into one session's corpus events, with every 2.x message type mapped or counted", () => {
  const { events: converted, dropped } = convertFixture({ turns: 2 });
  assert.deepEqual(dropped, { idle: 2 });
  assert.deepEqual(converted.map((event) => event.seq), converted.map((_, index) => index));
  const parts = converted.filter((event) => event.type === "message.part.updated.1").map((event) => event.data.part);
  assert.deepEqual(parts.slice(0, 7).map((part) => part.type), ["text", "step-start", "reasoning", "tool", "tool", "patch", "step-finish"]);
  const [read, shell] = parts.filter((part) => part.type === "tool");
  assert.deepEqual([read.tool, read.state.status, shell.tool, shell.state.status], ["read", "completed", "shell", "error"]);
  assert.equal(shell.state.metadata.output, "FAIL");
  assert.deepEqual(parts.find((part) => part.type === "patch").files, ["src/dates.ts"]);
  assert.deepEqual(parts.find((part) => part.type === "reasoning").metadata, { reasoningField: "reasoning_content" });
  const assistants = converted.filter((event) => event.type === "message.updated.1" && event.data.info.role === "assistant").map((event) => event.data.info);
  const user = converted.find((event) => event.type === "message.updated.1" && event.data.info.role === "user").data.info;
  assert.ok(assistants.slice(0, 2).every((info) => info.parentID === user.id && info.path.cwd === RECORDED_WORKSPACE_DIRECTORY));
  assert.deepEqual(user.model, { providerID: "opencode", modelID: "big-pickle" });
});

test("the converter redacts the workspace, home directory and user name in every string, and counts a failed tool's error as its output", () => {
  const { events: converted } = convertFixture({ turns: 1, payload: 10 });
  const serialized = JSON.stringify(converted);
  assert.ok(!serialized.includes(HOME) && !/alice/iu.test(serialized));
  assert.match(serialized, /Read file \/benchmark\/workspace-a\/src\/dates\.ts/u);
  assert.match(serialized, /exit 1, log in \/benchmark\/workspace-a\/\.npm\/_logs/u);
  assert.match(serialized, /fix it, user\./u);
  const measured = measureEvents(converted);
  const shell = converted.find((event) => event.data.part?.tool === "shell").data.part;
  assert.equal(measured.toolOutputBytes, Buffer.byteLength(converted.find((event) => event.data.part?.tool === "read").data.part.state.output) + Buffer.byteLength(shell.state.error));
});

test("the import fails on an email, a credential, or a 1.x export", () => {
  const options = { version: "2.3.0", home: HOME, username: "alice" };
  const withEmail = fixtureExport({ turns: 1 });
  withEmail.messages[0].text += " Mail ops@ledger-corp.io.";
  assert.throws(() => convertOpenCodeExport(withEmail, options), /contains an email address/u);
  const withExampleEmail = fixtureExport({ turns: 1 });
  withExampleEmail.messages[0].text += " Bill billing@example.com.";
  convertOpenCodeExport(withExampleEmail, options);
  const withKey = fixtureExport({ turns: 1 });
  withKey.messages[0].text += ` export OPENAI_API_KEY=sk-${"a1".repeat(16)}`;
  assert.throws(() => convertOpenCodeExport(withKey, options), /contains an OpenAI-style key/u);
  assert.throws(() => convertOpenCodeExport({ info: {}, messages: [{ info: {}, parts: [] }] }, options), /OpenCode 1\.x export/u);
  assert.throws(() => assertPublicValue({ text: "cat /home/bob/.ssh/config" }, "x"), /home-directory path/u);
  assert.doesNotThrow(() => assertPublicValue({ text: "tsconfig.json\n@AGENTS.md" }, "x"));
});

test("cuts take whole turns of the recording repeated end to end", () => {
  const { events: converted } = convertFixture({ turns: 3 });
  const turns = recordingTurns(converted);
  assert.equal(turns.length, 3);
  const perTurn = turns[0].measured.transcriptBytes;
  assert.equal(turnsForCut(turns, { turns: 1 }), 1);
  assert.equal(turnsForCut(turns, { transcriptBytes: perTurn }), 1);
  assert.equal(turnsForCut(turns, { transcriptBytes: perTurn + 1 }), 2);
  assert.equal(turnsForCut(turns, { transcriptBytes: perTurn * 7 }), 7);
  assert.equal(turnsForCut(turns, { messages: 20 }), 7, "three messages a turn");
});

test("built sessions repeat the recording with fresh ids, later times and their own workspace, and verify byte for byte", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-"));
  try {
    const built = await buildTestCorpus(root, WALK_CORPUS);
    const again = await buildCorpus(WALK_CORPUS, path.join(root, "recording.ndjson"), path.join(root, "again"));
    assert.equal(again.digestSha256, built.digestSha256);
    assert.equal((await verifyCorpus(built.path)).digestSha256, built.digestSha256);
    const [longThread, control, walkA, , walkB] = built.manifest.sessions;
    assert.deepEqual([longThread.turns, longThread.copies, longThread.messageCount], [7, 3, 21]);
    assert.deepEqual([control.turns, control.copies], [1, 1]);
    assert.ok(walkA.transcriptBytes >= 4096);
    assert.equal(walkA.copies, Math.ceil(walkA.turns / 3));
    const long = await events(path.join(built.path, longThread.file));
    const messageIds = long.filter((event) => event.type === "message.updated.1").map((event) => event.data.info.id);
    assert.equal(new Set(messageIds).size, messageIds.length);
    assert.deepEqual(messageIds.toSorted(), messageIds);
    const created = long.filter((event) => event.type === "message.updated.1").map((event) => event.data.info.time.created);
    assert.deepEqual(created.toSorted((a, b) => a - b), created);
    const last = long[0].data.info.time.updated;
    const controlEvents = await events(path.join(built.path, control.file));
    assert.ok(last < controlEvents[0].data.info.time.created, "the long thread is older than the control, so it lists below it");
    const across = JSON.stringify(await events(path.join(built.path, walkB.file)));
    assert.ok(across.includes("/benchmark/workspace-b") && !across.includes("/benchmark/workspace-a"));
    const file = path.join(built.path, walkA.file);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    const event = JSON.parse(lines[1]);
    event.seq = 99;
    lines[1] = JSON.stringify(event);
    await writeFile(file, `${lines.join("\n")}\n`);
    await assert.rejects(verifyCorpus(built.path), /invalid sequence|digest mismatch/u);
    await assert.rejects(buildCorpus(WALK_CORPUS, path.join(root, "recording.ndjson"), path.join(root, "again")), /already exists/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the registered corpus is the committed recording, built to its registered digests, and holds every session the scenarios open", async () => {
  const corpus = await readRegistered("corpus", "opencode-recorded-sessions");
  const artifact = await readRegistered("corpusArtifact", "opencode-recorded-sessions");
  const recording = await readRecording(recordingFileOf(corpus.value.id));
  assert.equal(recording.digestSha256, artifact.value.recordingDigestSha256);
  assert.equal(artifact.value.definitionDigestSha256, corpus.digest);
  assert.equal(recording.events[0].data.info.version, corpus.value.recording.version);
  const ids = new Set(corpus.value.sessions.map((session) => session.logicalSessionId));
  const walk = (await readRegistered("scenario", "session-switch-walk")).value.cases.walk;
  assert.ok(walk.sessions.every((session) => ids.has(session.sessionId)));
  assert.ok(ids.has((await readRegistered("scenario", "long-thread")).value.cases.sessionId));
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-registered-"));
  try {
    const built = await buildCorpus(corpus.value, recordingFileOf(corpus.value.id), path.join(root, "corpus"));
    assert.equal(built.digestSha256, artifact.value.corpusDigestSha256);
    const sessions = Object.fromEntries(built.manifest.sessions.map((session) => [session.logicalSessionId, session]));
    assert.ok(sessions["long-thread-2000"].messageCount >= 2000);
    assert.ok(sessions["size-latency-0-8388608"].transcriptBytes >= 8388608);
    assert.ok(sessions["latency-within-workspace-cold-0-1048576"].transcriptBytes >= 1048576);
    assert.equal(sessions.control.turns, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a private recorded corpus validates as custom and is never registered", async () => {
  const definition = { ...WALK_CORPUS, id: "test-private", derivation: { ...WALK_CORPUS.derivation, privateContentCopied: true } };
  validateDefinition("corpus", definition);
  assert.throws(() => validateDefinition("corpus", { ...WALK_CORPUS, sessions: [...WALK_CORPUS.sessions, WALK_CORPUS.sessions[0]] }), /defined twice/u);
  assert.throws(() => validateDefinition("corpus", corpusDefinition("test-no-control", WALK_CORPUS.sessions.filter((session) => session.role !== "control"))), /control session/u);
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-corpus-private-"));
  try {
    const file = path.join(root, "private.json");
    await writeFile(file, JSON.stringify(definition));
    assert.equal((await readDefinition("corpus", file)).status, "custom/non-comparable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
