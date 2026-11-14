import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { after, before } from "node:test";
import { digest } from "../src/canonical-json.mjs";
import { runBenchmark, validateResultFile } from "../src/runner.mjs";
import { buildTestCorpus, WALK_CORPUS } from "./support/recorded-corpus.mjs";

const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const APP = { id: "mock-native", name: "Mock Native GUI", materializationModes: ["translated"] };
const START_SCENARIO = {
  schemaVersion: 1,
  id: "test-app-start",
  title: "Test app start",
  description: "test",
  kind: "app-start",
  corpusId: WALK_CORPUS.id,
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
  corpusId: WALK_CORPUS.id,
  cases: {
    walk: {
      controlWorkspaceId: "workspace-a",
      passes: ["cold", "warm"],
      sessions: [
        { sessionId: "walk-b", workspaceId: "workspace-b", nominalBytes: 4096 },
        { sessionId: "walk-a", workspaceId: "workspace-a", nominalBytes: 4096 },
      ],
    },
    workspaceRelations: ["within-workspace", "across-workspaces"],
    sessionStates: ["cold", "warm"],
    nominalBytes: [4096],
  },
  metrics: [],
  resourceMeasurement: { processScope: "application-family", activeSampleIntervalMs: 250, idleSampleIntervalMs: 1000, settleBeforeIdleMs: 1000, idleWindowMs: 2000 },
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};
const NEW_THREAD_SCENARIO = {
  schemaVersion: 1,
  id: "test-new-thread",
  title: "Test new thread",
  description: "test",
  kind: "new-thread",
  corpusId: WALK_CORPUS.id,
  cases: { sourceSessionId: "control", profiles: { smoke: { samplesPerProcess: 3 }, quick: { samplesPerProcess: 3 }, publication: { samplesPerProcess: 3 } } },
  metrics: [],
  runProfiles: { smoke: 2, quick: 2, publication: 2 },
};
const LONG_THREAD_SCENARIO = {
  schemaVersion: 1,
  id: "test-long-thread",
  title: "Test long thread",
  description: "test",
  kind: "long-thread",
  corpusId: WALK_CORPUS.id,
  cases: { sourceSessionId: "control", sessionId: "long-thread-20", visits: ["cold", "warm"], scroll: { wheelCount: 20, deltaY: -480, intervalMs: 50, tailMs: 500, longFrameMs: 33.4 } },
  metrics: [],
  runProfiles: { smoke: 2, quick: 2, publication: 2 },
};
const TYPING_SCENARIO = {
  schemaVersion: 1,
  id: "test-typing",
  title: "Test typing",
  description: "test",
  kind: "typing-while-streaming",
  corpusId: WALK_CORPUS.id,
  cases: {
    prompt: "Write the replay benchmark reply.",
    firstWordChars: 8,
    streams: { startIntervalMs: 150 },
    keys: { sequence: "thequickbrown", intervalMs: 250, jitter: 0.2, seed: "runner-test", missAfterMs: 2000 },
    replay: { deltaChars: 8, intervalMs: 10 },
    profiles: { smoke: { streamCount: 3, keyCount: 6, deltaCount: 40 }, quick: { streamCount: 3, keyCount: 6, deltaCount: 40 }, publication: { streamCount: 3, keyCount: 6, deltaCount: 40 } },
  },
  metrics: [],
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};

let corpusRoot;
let corpusDirectory;
before(async () => {
  corpusRoot = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-corpus-"));
  corpusDirectory = (await buildTestCorpus(corpusRoot, WALK_CORPUS)).path;
});
after(() => rm(corpusRoot, { recursive: true, force: true }));

test("app-start runner preserves raw attempts and derives both exact launch states", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-start-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark(baseInput(output, START_SCENARIO));
    assert.equal(result.observations.filter((item) => item.status === "valid").length, 6);
    assert.equal(result.derivation.summary["start-new"].valid, 3);
    assert.equal(result.derivation.summary["start-initialized"].valid, 3);
    assert.match(await readFile(path.join(output, "report.md"), "utf8"), /\| App start, existing profile \| 25\.0 ms \|/u);
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
    assert.equal(result.derivation.summary["start-new"].attempted, 2);
    assert.equal(result.derivation.summary["start-initialized"].attempted, 2);
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
    assert.deepEqual(Object.fromEntries(Object.entries(result.derivation.summary).map(([key, metric]) => [key, metric.valid])), { "walk-cold-0.00390625": 4, "walk-warm-0.00390625": 4 });
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
    assert.equal(result.derivation.summary["start-new"].status, "invalid");
    assert.equal(result.derivation.summary["start-new"].attempted, 3);
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
    assert.deepEqual(walk.slice(0, 4).map((item) => item.reason.startsWith("Not attempted:")), [false, true, false, true]);
    assert.match(walk[3].reason, /^Not attempted: Next session down the list, return: 0\.00390625 MiB session already has an invalid observation \(list-walk-0-warm-00-walk-b\)/u);
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

test("new thread runs its samples in each fresh process and settles every one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-new-thread-"));
  try {
    const launches = path.join(root, "launches.log");
    const input = baseInput(path.join(root, "result"), NEW_THREAD_SCENARIO);
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_FRAME_LOG: "settled", BENCHMARK_MOCK_LAUNCH_LOG: launches } } });
    assert.deepEqual(result.observations.map((item) => item.case.caseId), ["new-thread-0-00", "new-thread-0-01", "new-thread-0-02", "new-thread-1-00", "new-thread-1-01", "new-thread-1-02"]);
    assert.deepEqual(result.derivation.summary["new-thread"].valid, 6);
    assert.deepEqual(result.clockRule.frameLogs, { checked: 6, failed: 0, missing: 0 });
    assert.deepEqual((await readFile(launches, "utf8")).trim().split("\n"), ["new-thread-0", "new-thread-1"]);
    assert.equal(result.resources, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long thread opens twice per process and re-derives each scroll's long frames and p95 frame interval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-long-thread-"));
  try {
    const input = baseInput(path.join(root, "result"), LONG_THREAD_SCENARIO);
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_FRAME_LOG: "settled" } } });
    assert.deepEqual(result.observations.slice(0, 4).map((item) => item.case.caseId), ["long-thread-open-0-cold", "long-thread-scroll-0-cold", "long-thread-open-0-warm", "long-thread-scroll-0-warm"]);
    assert.ok(result.observations.every((item) => item.status === "valid"));
    const scroll = result.observations[1];
    assert.deepEqual(scroll.measures, { "long-thread.scroll_long_frames": 1, "long-thread.scroll_p95_frame_ms": 8.3 });
    assert.deepEqual(Object.keys(result.derivation.summary), ["long-thread-open", "long-thread-scroll-long-frames", "long-thread-scroll-p95-frame"]);
    assert.equal(result.derivation.summary["long-thread-scroll-long-frames"].p50, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a scroll recording that ends before its tail invalidates the scroll rows, and a missing recording is never a value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-long-thread-short-"));
  try {
    const input = baseInput(path.join(root, "result"), { ...LONG_THREAD_SCENARIO, runProfiles: { smoke: 1, quick: 1, publication: 1 } });
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_FRAME_LOG: "settled", BENCHMARK_MOCK_RECORDING: "short" } } });
    assert.match(result.observations[1].reason, /^Clock rule settle-31-frames: the recording ends before 500 ms after the last wheel event\.$/u);
    assert.match(result.observations[3].reason, /^Not attempted: Scroll the 2,000-message thread: frames over 33\.4 ms already has an invalid observation/u);
    assert.equal(result.observations[2].status, "valid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typing while streaming starts the replay server, streams from it, and derives one observation per key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-typing-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark(baseInput(output, TYPING_SCENARIO));
    const firstWords = result.observations.filter((item) => item.case.workload === "stream-first-word");
    const keys = result.observations.filter((item) => item.case.workload === "typing-key");
    assert.equal(firstWords.length, 3);
    assert.deepEqual(firstWords.map((item) => item.reason ?? item.status), ["valid", "valid", "valid"]);
    assert.ok(firstWords[1].clock.start - firstWords[0].clock.start >= 150);
    assert.deepEqual(keys.map((item) => item.case.key).join(""), "thequi");
    assert.ok(keys.every((item) => item.status === "valid" && item.durationMs >= 12 && item.durationMs < 20 && item.measures["typing.missed"] === 0));
    assert.deepEqual(keys.map((item) => item.case.delayMs).slice(0, 1), [0]);
    assert.ok(keys.slice(1).every((item) => item.case.delayMs >= 200 && item.case.delayMs <= 300));
    assert.ok(result.derivation.summary["typing-lag"].p50 >= 12);
    assert.equal(result.derivation.summary["typing-missed"].missed, 0);
    const requests = (await readFile(path.join(output, "replay-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((entry) => entry.kind), ["reply", "reply", "reply"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a key painted after 2 s is a miss counted at 2 s, not an invalid observation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-typing-miss-"));
  try {
    const input = baseInput(path.join(root, "result"), TYPING_SCENARIO);
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_RECORDING: "miss-last" } } });
    const keys = result.observations.filter((item) => item.case.workload === "typing-key");
    assert.deepEqual(keys.map((item) => item.measures["typing.missed"]), [0, 0, 0, 0, 0, 1]);
    assert.equal(keys.at(-1).durationMs, 2000);
    assert.equal(result.derivation.summary["typing-missed"].missed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a scenario the driver declares it cannot run is recorded with its reason, without launching the app", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-unsupported-"));
  try {
    const launches = path.join(root, "launches.log");
    const input = baseInput(path.join(root, "result"), NEW_THREAD_SCENARIO);
    const result = await runBenchmark({ ...input, driver: { ...input.driver, env: { BENCHMARK_MOCK_UNSUPPORTED: "test-new-thread=The session view has no new-thread control", BENCHMARK_MOCK_LAUNCH_LOG: launches } } });
    assert.equal(result.observations.length, 6);
    assert.ok(result.observations.every((item) => item.reason === "Unsupported: The session view has no new-thread control"));
    assert.deepEqual(result.derivation.summary["new-thread"], { title: "New thread", unit: "ms", status: "unsupported", valid: 0, attempted: 6, reason: "The session view has no new-thread control" });
    await assert.rejects(readFile(launches, "utf8"), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function baseInput(output, scenario) {
  return {
    driver: { executable: process.execPath, args: [DRIVER] },
    app: APP,
    scenario: { value: scenario, digest: digest(scenario), status: "custom/non-comparable" },
    corpus: { value: WALK_CORPUS, digest: digest(WALK_CORPUS), status: "custom/non-comparable" },
    corpusDirectory,
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
