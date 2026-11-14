import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { comparabilityProblems } from "../src/compare-results.mjs";
import { buildTestCorpus, WALK_CORPUS } from "./support/recorded-corpus.mjs";
import { readRegistered } from "../src/registry.mjs";
import { planAppRun } from "../src/run-app.mjs";

const execute = promisify(execFile);
const CLI = path.resolve("bin/agent-app-benchmark.mjs");
const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const MONITOR = path.resolve("native/resource-monitor/target/release/agent-app-resource-monitor");
const monitorBuilt = await access(MONITOR).then(() => true, () => false);

const CORPUS = { ...WALK_CORPUS, id: "test-private-corpus" };
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
      sessions: [{ sessionId: "walk-b", workspaceId: "workspace-b", nominalBytes: 4096 }, { sessionId: "walk-a", workspaceId: "workspace-a", nominalBytes: 4096 }],
    },
    workspaceRelations: ["within-workspace", "across-workspaces"],
    sessionStates: ["cold", "warm"],
    nominalBytes: [4096],
  },
  metrics: [{ id: "switch.duration_ms", description: "Switch duration.", unit: "ms" }],
  resourceMeasurement: { processScope: "application-family", activeSampleIntervalMs: 250, idleSampleIntervalMs: 250, settleBeforeIdleMs: 100, idleWindowMs: 1000 },
  runProfiles: { smoke: 4, quick: 4, publication: 4 },
};

const NEW_THREAD = {
  schemaVersion: 1,
  id: "test-new-thread",
  title: "Test new thread",
  description: "test",
  kind: "new-thread",
  corpusId: CORPUS.id,
  cases: { sourceSessionId: "control", profiles: { smoke: { samplesPerProcess: 4 }, quick: { samplesPerProcess: 4 }, publication: { samplesPerProcess: 4 } } },
  metrics: [{ id: "new-thread.duration_ms", description: "New thread.", unit: "ms" }],
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};
const LONG_THREAD = {
  schemaVersion: 1,
  id: "test-long-thread",
  title: "Test long thread",
  description: "test",
  kind: "long-thread",
  corpusId: CORPUS.id,
  cases: { sourceSessionId: "control", sessionId: "long-thread-20", visits: ["cold", "warm"], scroll: { wheelCount: 20, deltaY: -480, intervalMs: 50, tailMs: 500, longFrameMs: 33.4 } },
  metrics: [{ id: "long-thread.open_ms", description: "Open.", unit: "ms" }],
  runProfiles: { smoke: 2, quick: 2, publication: 2 },
};
const TYPING = {
  schemaVersion: 1,
  id: "test-typing",
  title: "Test typing",
  description: "test",
  kind: "typing-while-streaming",
  corpusId: CORPUS.id,
  cases: {
    prompt: "Write the replay benchmark reply.",
    firstWordChars: 8,
    streams: { startIntervalMs: 100 },
    keys: { sequence: "thequickbrownfox", intervalMs: 250, jitter: 0.2, seed: "run-app-test", missAfterMs: 2000 },
    replay: { deltaChars: 8, intervalMs: 10 },
    profiles: { smoke: { streamCount: 4, keyCount: 16, deltaCount: 40 }, quick: { streamCount: 4, keyCount: 16, deltaCount: 40 }, publication: { streamCount: 4, keyCount: 16, deltaCount: 40 } },
  },
  metrics: [{ id: "typing.lag_p50_ms", description: "Lag.", unit: "ms" }],
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};

async function privateCorpus(root) {
  const folder = path.join(root, "private");
  await mkdir(folder);
  const corpus = await buildTestCorpus(folder, CORPUS);
  await writeFile(path.join(folder, "corpus-definition.json"), JSON.stringify(CORPUS));
  await writeFile(path.join(folder, "start.json"), JSON.stringify(START));
  await writeFile(path.join(folder, "switch.json"), JSON.stringify(SWITCH));
  await writeFile(path.join(folder, "new-thread.json"), JSON.stringify(NEW_THREAD));
  await writeFile(path.join(folder, "long-thread.json"), JSON.stringify(LONG_THREAD));
  await writeFile(path.join(folder, "typing.json"), JSON.stringify(TYPING));
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
    assert.deepEqual(plan.scenarios.map((scenario) => [scenario.value.id, scenario.status]), ["test-app-start", "test-session-switch", "test-new-thread", "test-long-thread", "test-typing"].map((id) => [id, "custom/non-comparable"]));
    assert.equal(plan.corpus.status, "custom/non-comparable");
    await assert.rejects(planAppRun({ app: "t3", corpusDefinition: corpus.definition }), /needs both --corpus-definition and --corpus-directory/u);
    await writeFile(path.join(path.dirname(corpus.definition), "switch.json"), JSON.stringify(START));
    await assert.rejects(
      planAppRun({ app: "t3", driver: process.execPath, corpusDefinition: corpus.definition, corpusDirectory: corpus.directory, resourceMonitor: process.execPath, frameworkRevision: "test" }),
      /needs at most one scenario of each kind/u,
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
    assert.deepEqual(t3, ["test-app-start", "test-session-switch", "test-new-thread", "test-long-thread", "test-typing"].map((id) => path.join(root, `t3/${id}/result.json`)));
    for (const file of t3) {
      const result = JSON.parse(await readFile(file, "utf8"));
      assert.equal(result.scenario.status, "custom/non-comparable");
      assert.deepEqual(result.observations.filter((observation) => observation.status !== "valid"), [], file);
      assert.equal(result.clockRule.frameLogs.failed, 0);
    }
    assert.match(await readFile(path.join(root, "t3/host-conditions.jsonl"), "utf8"), /"event":"run-end"/u);

    const { stdout } = await execute(process.execPath, [CLI, "verdict", "--result", path.join(root, "t3"), "--result", path.join(root, "opencode")]);
    assert.match(stdout, /^Runs \(apps run separately; load is shown, not gated\):$/mu);
    assert.match(stdout, /clock rule settle-31-frames, conformance \d+ checked, 0 failed, 1-minute load /u);
    assert.match(stdout, /^### Mock Native GUI vs Mock Native GUI$/mu);
    assert.match(stdout, /\| App start, fresh profile /u);
    assert.match(stdout, /\| Next session down the list, return: 0\.00390625 MiB session /u);
    for (const title of ["New thread", "Open the 2,000-message thread", "Scroll the 2,000-message thread: frames over 33\\.4 ms", "Scroll the 2,000-message thread: p95 frame interval", "Streaming reply: first word painted", "Typing while replies stream: key to paint", "Typing while replies stream: keys not painted within 2 s"]) {
      assert.match(stdout, new RegExp(`\\| ${title} +\\| [0-9]`, "u"), title);
    }
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
