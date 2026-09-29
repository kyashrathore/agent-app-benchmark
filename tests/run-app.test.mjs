import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { comparabilityProblems } from "../src/compare-results.mjs";
import { writeCorpus } from "../src/corpus.mjs";
import { readRegistered } from "../src/registry.mjs";
import { planAppRun } from "../src/run-app.mjs";

const execute = promisify(execFile);
const CLI = path.resolve("bin/agent-app-benchmark.mjs");
const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const MONITOR = path.resolve("native/resource-monitor/target/release/agent-app-resource-monitor");
const monitorBuilt = await access(MONITOR).then(() => true, () => false);

const CORPUS = {
  schemaVersion: 1,
  id: "test-private-corpus",
  generator: "opencode-completed-sessions",
  seed: "run-app-test",
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
  description: "Private corpus for the run-app tests.",
};
const START = {
  schemaVersion: 1,
  id: "test-app-start",
  title: "Test app start",
  description: "test",
  kind: "app-start",
  corpusId: CORPUS.id,
  cases: { startModes: ["new-application-state", "initialized-application-state"] },
  metrics: [{ id: "start.duration_ms", description: "Launch duration.", unit: "ms" }],
  runProfiles: { smoke: 4, quick: 4, publication: 4 },
};
const SWITCH = {
  schemaVersion: 1,
  id: "test-session-switch",
  title: "Test walk",
  description: "test",
  kind: "session-switch",
  corpusId: CORPUS.id,
  cases: {
    walk: {
      controlWorkspaceId: "workspace-a",
      passes: ["cold", "warm"],
      sessions: [{ sessionId: "walk-a", workspaceId: "workspace-a", transcriptBytes: 4096 }, { sessionId: "walk-b", workspaceId: "workspace-b", transcriptBytes: 4096 }],
    },
    workspaceRelations: ["within-workspace", "across-workspaces"],
    sessionStates: ["cold", "warm"],
    transcriptBytes: [4096],
  },
  metrics: [{ id: "switch.duration_ms", description: "Switch duration.", unit: "ms" }],
  resourceMeasurement: { processScope: "application-family", activeSampleIntervalMs: 250, idleSampleIntervalMs: 250, settleBeforeIdleMs: 100, idleWindowMs: 1000 },
  runProfiles: { smoke: 4, quick: 4, publication: 4 },
};

async function privateCorpus(root) {
  const folder = path.join(root, "private");
  const corpus = await writeCorpus(CORPUS, path.join(folder, "corpus"));
  await writeFile(path.join(folder, "corpus-definition.json"), JSON.stringify(CORPUS));
  await writeFile(path.join(folder, "start.json"), JSON.stringify(START));
  await writeFile(path.join(folder, "switch.json"), JSON.stringify(SWITCH));
  return { definition: path.join(folder, "corpus-definition.json"), directory: corpus.path };
}

async function runMock(appId, corpus, output) {
  const materialization = (await readRegistered("app", appId)).value.materializationModes[0];
  const { stdout } = await execute(process.execPath, [
    CLI, "run", "--app", appId,
    "--driver", process.execPath, "--driver-arg", DRIVER, "--driver-env", `BENCHMARK_MOCK_APP_ID=${appId}`,
    "--driver-env", `BENCHMARK_MOCK_MATERIALIZATION=${materialization}`, "--driver-env", "BENCHMARK_MOCK_FRAME_LOG=settled",
    "--corpus-definition", corpus.definition, "--corpus-directory", corpus.directory,
    "--output", output,
  ]);
  return stdout.trim().split("\n");
}

test("run takes a private corpus's scenarios from beside its definition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-run-plan-"));
  try {
    const corpus = await privateCorpus(root);
    const plan = await planAppRun({
      app: "t3",
      driver: process.execPath,
      corpusDefinition: corpus.definition,
      corpusDirectory: corpus.directory,
      resourceMonitor: process.execPath,
      frameworkRevision: "test",
    });
    assert.deepEqual(plan.scenarios.map((scenario) => [scenario.value.id, scenario.status]), [["test-app-start", "custom/non-comparable"], ["test-session-switch", "custom/non-comparable"]]);
    assert.equal(plan.corpus.status, "custom/non-comparable");
    await assert.rejects(planAppRun({ app: "t3", corpusDefinition: corpus.definition }), /needs both --corpus-definition and --corpus-directory/u);
    await rm(path.join(path.dirname(corpus.definition), "switch.json"));
    await assert.rejects(
      planAppRun({ app: "t3", driver: process.execPath, corpusDefinition: corpus.definition, corpusDirectory: corpus.directory, resourceMonitor: process.execPath, frameworkRevision: "test" }),
      /needs exactly one app-start and one session-switch scenario beside its definition/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run measures one app, then verdict compares separate runs with their load", { skip: !monitorBuilt && "the resource monitor is not built" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-run-app-"));
  try {
    const corpus = await privateCorpus(root);
    const t3 = await runMock("t3", corpus, path.join(root, "t3"));
    await runMock("opencode", corpus, path.join(root, "opencode"));
    assert.deepEqual(t3, [path.join(root, "t3/test-app-start/result.json"), path.join(root, "t3/test-session-switch/result.json")]);
    const result = JSON.parse(await readFile(t3[1], "utf8"));
    assert.equal(result.scenario.status, "custom/non-comparable");
    assert.deepEqual(result.clockRule.frameLogs, { checked: result.observations.length, failed: 0, missing: 0 });
    assert.match(await readFile(path.join(root, "t3/host-conditions.jsonl"), "utf8"), /"event":"run-end"/u);

    const { stdout } = await execute(process.execPath, [CLI, "verdict", "--result", path.join(root, "t3"), "--result", path.join(root, "opencode")]);
    assert.match(stdout, /^Runs \(apps run separately; load is shown, not gated\):$/mu);
    assert.match(stdout, /clock rule settle-31-frames, conformance \d+ checked, 0 failed, 1-minute load /u);
    assert.match(stdout, /^### Mock Native GUI vs Mock Native GUI$/mu);
    assert.match(stdout, /\| App start, fresh profile /u);
    assert.match(stdout, /\| Next session down the list, return: 0\.00390625 MiB session /u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runs from different hosts, scenarios, corpora, clock rules or frameworks, or with a failed frame log, are not compared", () => {
  const result = (appId, overrides = {}) => ({
    app: { id: appId },
    scenario: { id: "session-switch-walk", digestSha256: "s" },
    corpus: { digestSha256: "c", definitionDigestSha256: "d" },
    clockRule: { id: "settle-31-frames", declared: "settle-31-frames", frameLogs: { checked: 3, failed: 0, missing: 0 } },
    provenance: { frameworkRevision: "f" },
    environment: { platform: "darwin", architecture: "arm64", cpuModel: "Apple M4 Pro", logicalCpuCount: 12, totalMemoryBytes: 24 * 2 ** 30 },
    ...overrides,
  });
  assert.deepEqual(comparabilityProblems([{ file: "a", result: result("a") }, { file: "b", result: result("b") }]), []);
  assert.deepEqual(comparabilityProblems([
    { file: "a", result: result("a") },
    { file: "b", result: result("b", { scenario: { id: "session-switch-walk", digestSha256: "other" }, provenance: { frameworkRevision: "g" } }) },
  ]), [
    "session-switch-walk: runs differ in scenario digest (s vs other)",
    "session-switch-walk: runs differ in framework revision (f vs g)",
  ]);
  assert.deepEqual(comparabilityProblems([
    { file: "a", result: result("a") },
    { file: "b", result: result("b", { environment: { platform: "darwin", architecture: "arm64", cpuModel: "Apple M1", logicalCpuCount: 8, totalMemoryBytes: 16 * 2 ** 30 } }) },
  ]), ["runs come from different hosts (darwin arm64 Apple M4 Pro, 12 CPUs, 24 GiB vs darwin arm64 Apple M1, 8 CPUs, 16 GiB)"]);
  assert.deepEqual(comparabilityProblems([
    { file: "a", result: result("a") },
    { file: "b", result: result("b", { clockRule: { id: "settle-31-frames", declared: null, frameLogs: { checked: 3, failed: 1, missing: 0 } } }) },
  ]), [
    "session-switch-walk: runs differ in clock rule (settle-31-frames vs not declared)",
    "b: 1 observation(s) failed the clock-rule conformance check",
  ]);
});
