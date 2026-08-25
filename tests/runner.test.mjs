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
  generator: "opencode-completed-sessions-v2",
  seed: "runner-test",
  sourceEventFormat: { id: "opencode-event-v2", sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a", envelope: "EventV2.SerializedEvent", eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"] },
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
  cases: { workspaceRelations: ["within-workspace", "across-workspaces"], sessionStates: ["cold", "warm"], transcriptBytes: [4096] },
  metrics: [],
  resourceMeasurement: { processScope: "application-family", activeSampleIntervalMs: 250, idleSampleIntervalMs: 1000, settleBeforeIdleMs: 1000, idleWindowMs: 2000 },
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};
const WORKSPACE_LOAD = { generator: "agent-app-workspace-v1", directoryCount: 16, sourceFileCount: 160, sourceFileBytes: 32768, changedFileCount: 24, diffHunksPerFile: 8, diffLinesPerHunk: 24, openFileTabCount: 4 };
const PANEL_LOADS = [
  { id: "light", expandedDirectoryCount: 2, retainedFileTabCount: 2, expandedReviewFileCount: 1 },
  { id: "moderate", expandedDirectoryCount: 8, retainedFileTabCount: 3, expandedReviewFileCount: 6 },
  { id: "heavy", expandedDirectoryCount: 16, retainedFileTabCount: 4, expandedReviewFileCount: 24 },
];
const PANEL_SCENARIO = {
  schemaVersion: 1,
  id: "workspace-panel-v1",
  title: "Test panel",
  description: "test",
  kind: "workspace-panel",
  corpusId: CORPUS_VALUE.id,
  cases: { workspaceLoad: WORKSPACE_LOAD, actions: ["open-cold", "toggle-open-close", "toggle-close-open", "open-warm-data", "switch-surface", "open-file", "switch-file-tab", "toggle-diff-view", "collapse-all", "expand-all"] },
  metrics: [{ id: "panel.duration_ms", description: "Panel duration.", unit: "ms" }],
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};
const PANEL_SWITCH_SCENARIO = {
  schemaVersion: 1,
  id: "session-switch-workspace-panel-v1",
  title: "Test panel switches",
  description: "test",
  kind: "session-switch-workspace-panel",
  corpusId: CORPUS_VALUE.id,
  cases: { workspaceRelations: ["within-workspace", "across-workspaces"], sessionStates: ["cold", "warm"], panelProfiles: ["closed", "files", "diff"], transcriptBytes: 4096, workspaceLoad: WORKSPACE_LOAD },
  metrics: [{ id: "panel.switch_ms", description: "Panel switch duration.", unit: "ms" }],
  runProfiles: { smoke: 1, quick: 1, publication: 1 },
};
const NAVIGATION_SCENARIO = {
  schemaVersion: 1,
  id: "session-navigation-v1",
  title: "Test navigation",
  description: "test",
  kind: "session-navigation",
  corpusId: CORPUS_VALUE.id,
  cases: {
    historyNavigationTypes: ["first-visit", "return-visited-panel-closed"],
    panelNavigationType: "return-visited-panel-open",
    transcriptBytes: [4096],
    standardTranscriptBytes: 4096,
    panelLoads: PANEL_LOADS,
    workspaceLoad: WORKSPACE_LOAD,
  },
  metrics: [{ id: "navigation.duration_ms", description: "Navigation duration.", unit: "ms" }],
  runProfiles: { smoke: 1, quick: 1, publication: 20 },
};
const PANEL_V2_SCENARIO = {
  schemaVersion: 1,
  id: "workspace-panel-v2",
  title: "Test panel trends",
  description: "test",
  kind: "workspace-panel",
  corpusId: CORPUS_VALUE.id,
  cases: {
    workspaceLoad: WORKSPACE_LOAD,
    panelLoads: PANEL_LOADS,
    actions: ["open-panel", "close-panel", "files-to-review", "review-to-files", "open-file", "switch-file-tab", "expand-all", "collapse-all"],
  },
  metrics: [{ id: "panel.duration_ms", description: "Panel duration.", unit: "ms" }],
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

test("workspace-panel runner preserves per-action traces and derives renderer summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-panel-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark(baseInput(output, PANEL_SCENARIO));
    assert.equal(result.observations.length, 10);
    assert.ok(result.observations.every((item) => item.status === "valid" && item.rendererTrace.frameTimestampsMs.length >= 2));
    assert.equal(result.derivation.summary["open-cold"].durationMs.average, 70);
    assert.equal(result.derivation.summary["open-cold"].milestones.inputToShellMs.average, 3);
    assert.equal(result.derivation.summary["toggle-open-close"].milestones.secondToggleResponseMs.average, 6);
    assert.equal(result.derivation.summary["open-cold"].longAnimationFrames.count.average, 1);
    assert.equal(result.derivation.summary["open-cold"].longAnimationFrames.worstBlockingDurationMs.maximum, 5);
    assert.equal(result.derivation.summary["open-cold"].rendererWork.taskDurationMs.average, 35);
    assert.equal(result.observations[0].rendererTrace.longAnimationFrames[0].scripts[0].functionName, "renderWorkspacePanel");
    assert.match(result.materialization.workspaceFixtureDigestSha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.resources, null);
    const report = await readFile(path.join(output, "report.md"), "utf8");
    assert.match(report, /Data-ready to interactive/);
    assert.match(report, /Worst blocking max/);
    assert.match(report, /Task avg/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("panel-switch runner derives closed, Files, Diff, and open-minus-closed costs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-panel-switch-"));
  try {
    const result = await runBenchmark(baseInput(path.join(root, "result"), PANEL_SWITCH_SCENARIO));
    assert.equal(result.observations.length, 12);
    assert.equal(result.derivation.summary["closed-within-workspace-cold"].durationMs.average, 18);
    assert.equal(result.derivation.summary["closed-within-workspace-cold"].milestones.inputToSessionReadyMs.average, 10);
    assert.equal(result.derivation.summary["closed-within-workspace-cold"].milestones.inputToPanelReadyMs.average, 14);
    assert.equal(result.derivation.summary["files-minus-closed-within-workspace-cold"].durationMs.average, 6);
    assert.equal(result.derivation.summary["diff-minus-closed-across-workspaces-warm"].durationMs.average, 12);
    assert.equal(result.resources, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session-navigation runner derives user-facing history and panel-load trends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-navigation-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark(baseInput(output, NAVIGATION_SCENARIO));
    assert.equal(result.observations.length, 5);
    assert.equal(result.derivation.summary.historySizeTrend[0].firstVisit.average, 12);
    assert.equal(result.derivation.summary.historySizeTrend[0].returnVisitedPanelClosed.average, 12);
    assert.deepEqual(result.derivation.summary.panelLoadTrend.map((point) => point.loadProfile), ["light", "moderate", "heavy"]);
    assert.equal(result.derivation.summary.panelLoadTrend[2].returnVisitedPanelOpen.durationMs.average, 30);
    assert.ok(result.observations.every((item) => item.timingEvidence?.trustedInputAt === item.clock.start && item.timingEvidence.trustedInputEvent === "pointerdown"));
    assert.ok(result.observations.filter((item) => item.case.trend === "panel-load").every((item) => item.rendererTrace));
    assert.match(await readFile(path.join(output, "report.md"), "utf8"), /Session navigation by history size/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace-panel V2 runner derives one interaction trend per explicit load", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-runner-panel-v2-"));
  try {
    const output = path.join(root, "result");
    const result = await runBenchmark(baseInput(output, PANEL_V2_SCENARIO));
    assert.equal(result.observations.length, 24);
    assert.ok(result.observations.every((item) => item.timingEvidence?.trustedInputAt === item.clock.start && item.timingEvidence.trustedInputEvent === "pointerdown"));
    assert.deepEqual(result.derivation.summary.loadTrend.map((point) => point.loadProfile), ["light", "moderate", "heavy"]);
    assert.equal(result.derivation.summary.loadTrend[0].interactions["open-panel"].milestones.inputToShellMs.average, 3);
    assert.equal(result.derivation.summary.loadTrend[2].interactions["switch-file-tab"].durationMs.average, 16);
    const report = await readFile(path.join(output, "report.md"), "utf8");
    assert.match(report, /Workspace panel interactions by seeded load/);
    assert.doesNotMatch(report, /double-toggle|mid-animation/u);
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
