import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digest } from "../src/canonical-json.mjs";
import { runBenchmark, validateResultFile } from "../src/runner.mjs";

const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const APP = { id: "mock-native", name: "Mock Native GUI", materializationModes: ["translated"] };
const CORPUS_VALUE = {
  schemaVersion: 1,
  id: "test-corpus",
  generator: "opencode-completed-sessions",
  seed: "runner-test",
  sourceEventFormat: { id: "opencode-event", sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a", envelope: "EventV2.SerializedEvent", eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"] },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [4096],
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
  description: "runner test",
};
const START_SCENARIO = {
  schemaVersion: 1,
  id: "test-app-start",
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
  id: "test-session-switch",
  title: "Test walk",
  description: "test",
  kind: "session-switch",
  corpusId: CORPUS_VALUE.id,
  cases: {
    walk: {
      controlWorkspaceId: "workspace-a",
      passes: ["cold", "warm"],
      sessions: [
        { sessionId: "walk-a", workspaceId: "workspace-a", transcriptBytes: 4096 },
        { sessionId: "walk-b", workspaceId: "workspace-b", transcriptBytes: 4096, rowShape: "long" },
      ],
    },
    workspaceRelations: ["within-workspace", "across-workspaces"],
    sessionStates: ["cold", "warm"],
    transcriptBytes: [4096],
  },
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

test("a frame log that re-derives the reported clock is counted and keeps the observation valid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-frames-"));
  try {
    const input = baseInput(path.join(root, "result"), START_SCENARIO);
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_FRAME_LOG: "settled" } } });
    assert.deepEqual(result.clockRule, { id: "settle-31-frames", declared: "settle-31-frames", frameLogs: { checked: 6, failed: 0, missing: 0 } });
    assert.ok(result.observations.every((item) => item.status === "valid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an observation whose frame log settles after the reported clock end is invalid with the reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-frames-late-"));
  try {
    const input = baseInput(path.join(root, "result"), START_SCENARIO);
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_FRAME_LOG: "late" } } });
    assert.deepEqual(result.clockRule.frameLogs, { checked: 2, failed: 2, missing: 0 }, "each row's first failure withholds the rest of that row");
    assert.match(result.observations[0].reason, /^Clock rule settle-31-frames: the settle re-derives to 48 ms, the driver reported 40 ms\.$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a driver without frame logs is counted as missing, not checked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-frames-missing-"));
  try {
    const result = await runBenchmark(baseInput(path.join(root, "result"), START_SCENARIO));
    assert.deepEqual(result.clockRule, { id: "settle-31-frames", declared: null, frameLogs: { checked: 0, failed: 0, missing: 6 } });
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

test("the walk runner derives one row per pass and shape, and valid framework-observed resources", async () => {
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
    assert.deepEqual(Object.fromEntries(Object.entries(result.derivation.summary).map(([key, metric]) => [key, metric.valid])), { "cold-4096": 2, "cold-long-4096": 2, "warm-4096": 2, "warm-long-4096": 2 });
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

test("a row with an invalid observation is not attempted again, and every skipped case stays invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-withheld-"));
  try {
    const launches = path.join(root, "launches.log");
    const result = await runBenchmark({
      ...baseInput(path.join(root, "result"), { ...SWITCH_SCENARIO, runProfiles: { smoke: 2, quick: 2, publication: 2 } }),
      driver: { executable: process.execPath, args: [DRIVER], env: { BENCHMARK_MOCK_MODE: "wrong-content", BENCHMARK_MOCK_LAUNCH_LOG: launches } },
    });
    const walk = result.observations.filter((item) => item.case.workload === "list-walk");
    assert.equal(walk.length, 8);
    assert.ok(walk.every((item) => item.status === "invalid"));
    assert.deepEqual(walk.slice(0, 4).map((item) => item.reason.startsWith("Not attempted:")), [false, false, false, false]);
    assert.match(walk[4].reason, /^Not attempted: Next session down the list, first visit: 0\.00390625 MiB session already has an invalid observation \(list-walk-0-cold-00-walk-a\)/u);
    // The second walk process is never launched: every one of its cases belongs to a withheld row.
    assert.deepEqual((await readFile(launches, "utf8")).trim().split("\n"), ["list-walk-0"]);
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
