import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digest } from "../src/canonical-json.mjs";
import { runBenchmark, validateResultFile } from "../src/runner.mjs";

const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const APP = { id: "mock-native", name: "Mock Native GUI", materializationModes: ["translated"] };
const CORPUS_VALUE = {
  schemaVersion: 1,
  id: "test-corpus-v1",
  generator: "opencode-completed-transcripts-v1",
  seed: "runner-test",
  sourceEventFormat: { id: "opencode-event-v1", sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a", envelope: "EventV2.SerializedEvent", eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"] },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [16],
  messageChunkBytes: 8,
  description: "runner test",
};
const START_SCENARIO = {
  schemaVersion: 1,
  id: "app-start-v1",
  title: "Test app start",
  description: "test",
  kind: "app-start",
  corpusId: CORPUS_VALUE.id,
  cases: { startModes: ["new-application-state", "initialized-application-state"] },
  metrics: [],
  runProfiles: { smoke: 3, quick: 5, publication: 20 },
};
const SWITCH_SCENARIO = {
  schemaVersion: 1,
  id: "session-switch-v1",
  title: "Test switches",
  description: "test",
  kind: "session-switch",
  corpusId: CORPUS_VALUE.id,
  cases: { workspaceRelations: ["within-workspace", "across-workspaces"], sessionStates: ["cold", "warm"], transcriptBytes: [16] },
  metrics: [],
  resourceMeasurement: { processScope: "application-family", activeSampleIntervalMs: 250, idleSampleIntervalMs: 1000, settleBeforeIdleMs: 1000, idleWindowMs: 2000 },
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};

test("app-start runner preserves raw attempts and derives both exact launch states", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-start-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark(baseInput(output, START_SCENARIO));
    assert.equal(result.observations.filter((item) => item.status === "valid").length, 6);
    assert.equal(result.derivation.summary["new-application-state"].valid, 3);
    assert.equal(result.derivation.summary["initialized-application-state"].valid, 3);
    assert.match(await readFile(path.join(output, "report.md"), "utf8"), /Repeat launch — initialized application state/);
    assert.deepEqual((await readdir(output)).toSorted(), ["report.md", "result.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner applies and records a caller-selected repetition count", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-repetitions-"));
  try {
    const result = await runBenchmark({
      ...baseInput(path.join(root, "result"), START_SCENARIO),
      repetitions: 2,
    });
    assert.equal(result.repetitions, 2);
    assert.equal(result.observations.length, 4);
    assert.equal(result.derivation.summary["new-application-state"].attempted, 2);
    assert.equal(result.derivation.summary["initialized-application-state"].attempted, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session runner derives latency and valid framework-observed resource results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-switch-"));
  let clock = 1_000_000;
  let monitor;
  try {
    const result = await runBenchmark({ ...baseInput(path.join(root, "result"), SWITCH_SCENARIO), repetitions: 2, resourceMonitor: "fake-monitor" }, {
      now: () => clock,
      delay: async (milliseconds) => {
        const end = clock + milliseconds;
        while (monitor && clock + monitor.interval <= end) {
          clock += monitor.interval;
          monitor.pushSample();
        }
        clock = end;
      },
      startMonitor: async () => {
        monitor = fakeMonitor(() => clock, (value) => { clock = value; });
        return monitor;
      },
    });
    assert.equal(result.derivation.summary["within-workspace-cold"].valid, 2);
    assert.equal(result.derivation.summary["across-workspaces-warm"].valid, 2);
    assert.equal(result.observations.length, 10);
    assert.equal(result.resourceTrace.boundaries.length, 1);
    assert.equal(result.resources.status, "valid");
    assert.equal(result.resources.trend.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid readiness is retained and never summarized as zero", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-invalid-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark({ ...baseInput(output, START_SCENARIO), driver: { executable: process.execPath, args: [DRIVER], env: { BENCHMARK_MOCK_MODE: "wrong-content" } } });
    assert.equal(result.derivation.summary["new-application-state"].status, "invalid");
    assert.equal(result.derivation.summary["new-application-state"].attempted, 3);
    assert.ok(result.observations.every((item) => item.status === "invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("driver failures are sanitized before publication and validation rejects sensitive edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-private-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark({ ...baseInput(output, START_SCENARIO), driver: { executable: process.execPath, args: [DRIVER], env: { BENCHMARK_MOCK_MODE: "sensitive-error" } } });
    const reasons = result.observations.map((item) => item.reason ?? "");
    assert.ok(reasons.every((reason) => !reason.includes("/Users/example") && !reason.includes("super-secret-value")));
    const file = path.join(output, "result.json");
    const edited = JSON.parse(await readFile(file, "utf8"));
    edited.observations[0].reason = "C:\\Users\\example\\private\\result.json";
    await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
    await assert.rejects(validateResultFile(file), /absolute path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked reports match deterministic regeneration", async (context) => {
  const comparisonFile = path.resolve("results/comparisons/initial-macos-arm64/comparison.json");
  try {
    await access(comparisonFile);
  } catch {
    context.skip("No tracked comparison has been generated yet.");
    return;
  }
  const manifest = JSON.parse(await readFile(comparisonFile, "utf8"));
  for (const entry of manifest.results) await validateResultFile(path.resolve(path.dirname(comparisonFile), entry.path));
});

function baseInput(output, scenario) {
  return {
    driver: { executable: process.execPath, args: [DRIVER] },
    app: APP,
    scenario: { value: scenario, digest: digest(scenario), status: "custom/non-comparable" },
    corpus: { value: CORPUS_VALUE, digest: digest(CORPUS_VALUE), status: "custom/non-comparable" },
    runProfile: "smoke",
    output,
    runId: `mock-${scenario.kind}`,
  };
}

function fakeMonitor(getClock, setClock) {
  let cpuTime = 0;
  let rssBytes = 100 * 1024 * 1024;
  const value = {
    samples: [],
    errors: [],
    interval: 1000,
    setSampleInterval(interval) { this.interval = interval; },
    pushSample() {
      cpuTime += 5;
      rssBytes += 1024;
      this.samples.push(snapshot(getClock(), cpuTime, rssBytes));
    },
    async sampleNow() {
      setClock(getClock() + 10);
      cpuTime += 5;
      rssBytes += 1024;
      const result = snapshot(getClock(), cpuTime, rssBytes);
      this.samples.push(result);
      return result;
    },
    async stop() {},
  };
  return value;
}

function snapshot(atMs, cpuTimeMs, rssBytes) {
  return {
    atMs,
    collectionDurationMicros: 100,
    rssBytes,
    cumulativeCpuTimeMs: cpuTimeMs,
    inaccessibleProcessCount: 0,
    rootProcessFound: true,
    missingExternalProcessCount: 0,
    processes: [{ pid: 1, startTimeMs: 1, cpuTimeMs, rssBytes, name: "mock" }],
  };
}
