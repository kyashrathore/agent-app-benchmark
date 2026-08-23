import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  id: "test-conformance-corpus-v1",
  generator: "opencode-completed-transcripts-v1",
  seed: "conformance-test",
  sourceEventFormat: {
    id: "opencode-event-v1",
    sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a",
    envelope: "EventV2.SerializedEvent",
    eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"],
  },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [16],
  messageChunkBytes: 8,
  description: "Small CLI conformance corpus.",
};

test("CLI conformance sends the complete canonical prepare identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-conformance-"));
  try {
    const corpus = await writeCorpus(SMALL, path.join(root, "corpus"));
    const { stdout } = await execute(process.execPath, [
      CLI,
      "conformance",
      "--driver",
      process.execPath,
      "--driver-arg",
      DRIVER,
      "--driver-env",
      "BENCHMARK_MOCK_APP_ID=claxedo",
      "--app",
      "claxedo",
      "--scenario",
      "session-switch-v1",
      "--corpus-directory",
      corpus.path,
      "--run-directory",
      path.join(root, "run"),
    ]);
    assert.equal(stdout.trim(), "claxedo\ttranslated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI runs a local custom scenario and marks it non-comparable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-custom-scenario-"));
  try {
    const corpusDefinition = { ...SMALL, id: "custom-corpus-v1", transcriptBytes: [2048], messageChunkBytes: 1024 };
    const scenario = {
      schemaVersion: 1,
      id: "custom-start-v1",
      title: "Custom local start",
      description: "A local scenario that uses the V1 app-start lifecycle.",
      kind: "app-start",
      corpusId: corpusDefinition.id,
      cases: { startModes: ["new-application-state", "initialized-application-state"] },
      metrics: [{ id: "start.duration_ms", description: "Launch duration.", unit: "ms" }],
      runProfiles: { smoke: 1, quick: 1, publication: 1 },
    };
    const corpusFile = path.join(root, "corpus.json");
    const scenarioFile = path.join(root, "scenario.json");
    await writeFile(corpusFile, JSON.stringify(corpusDefinition));
    await writeFile(scenarioFile, JSON.stringify(scenario));
    const generated = await writeCorpus(corpusDefinition, path.join(root, "corpus"));
    const output = path.join(root, "result");
    await execute(process.execPath, [
      CLI, "run", "--driver", process.execPath, "--driver-arg", DRIVER,
      "--driver-env", "BENCHMARK_MOCK_SCENARIO_ID=custom-start-v1",
      "--driver-env", "BENCHMARK_MOCK_APP_ID=t3",
      "--app", "t3", "--scenario", scenarioFile, "--corpus", corpusFile,
      "--corpus-directory", generated.path, "--run-profile", "smoke", "--output", output,
    ]);
    const result = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
    assert.equal(result.scenario.status, "custom/non-comparable");
    assert.equal(result.corpus.status, "custom/non-comparable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
