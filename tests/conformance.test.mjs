import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { writeCorpus } from "../src/corpus.mjs";

const execute = promisify(execFile);
const CLI = path.resolve("bin/agent-app-benchmark.mjs");
const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const SMALL = {
  schemaVersion: 1,
  id: "test-conformance-corpus",
  generator: "opencode-completed-sessions",
  seed: "conformance-test",
  sourceEventFormat: {
    id: "opencode-event",
    sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a",
    envelope: "EventV2.SerializedEvent",
    eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"],
  },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [4096],
  benchmarkTopology: { standardTranscriptBytes: 4096, latencySamplesPerProcess: 1, sizeSamplesPerProcess: 1 },
  sessionProfiles: [{
    transcriptBytes: 4096,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    patches: 0,
    payloadPermille: { text: 250, reasoning: 250, toolInput: 250, toolOutput: 250 },
  }],
  derivation: {
    method: "rounded structural distributions with entirely synthetic payloads",
    sourceFamilies: ["opencode", "claude-code", "codex"],
    privateContentCopied: false,
  },
  description: "Small CLI conformance corpus.",
};

async function conformance(root, corpus, frameLog) {
  return execute(process.execPath, [
    CLI, "conformance",
    "--driver", process.execPath, "--driver-arg", DRIVER,
    "--driver-env", "BENCHMARK_MOCK_APP_ID=t3",
    ...(frameLog ? ["--driver-env", `BENCHMARK_MOCK_FRAME_LOG=${frameLog}`] : []),
    "--app", "t3", "--scenario", "session-switch-walk",
    "--corpus-directory", corpus.path, "--run-directory", path.join(root, "run"),
  ]);
}

test("CLI conformance passes a driver whose frame log re-derives its clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-conformance-"));
  try {
    const corpus = await writeCorpus(SMALL, path.join(root, "corpus"));
    const { stdout } = await conformance(root, corpus, "settled");
    assert.equal(stdout.trim(), "t3\ttranslated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI conformance rejects a driver without a frame log or whose settle differs from its clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-conformance-"));
  try {
    const corpus = await writeCorpus(SMALL, path.join(root, "corpus"));
    await assert.rejects(conformance(root, corpus), /returned no frame log/u);
    await assert.rejects(conformance(root, corpus, "late"), /does not follow settle-31-frames: the settle re-derives to/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
