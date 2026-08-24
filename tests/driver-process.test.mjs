import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeCorpus } from "../src/corpus.mjs";
import { DriverProcess } from "../src/driver-process.mjs";
import { assertHello, assertPrepared, assertShutdown, normalizeExecution } from "../src/protocol.mjs";

const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");
const SMALL = {
  schemaVersion: 1,
  id: "test-corpus-v1",
  generator: "opencode-completed-sessions-v2",
  seed: "driver-test",
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
  description: "driver test",
};

test("mock non-Electron driver completes the public lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-driver-"));
  const generated = await writeCorpus(SMALL, path.join(root, "corpus"));
  const driver = await DriverProcess.spawn({ executable: process.execPath, args: [DRIVER], cwd: root });
  try {
    assertHello(await driver.request("hello", { frameworkVersion: 1 }), { appId: "mock-native", scenarioId: "session-switch-v1", sourceEventFormatId: "opencode-event-v1" });
    const prepared = assertPrepared(await driver.request("prepare", {
      corpusDirectory: generated.path,
      corpusManifestPath: path.join(generated.path, "manifest.json"),
      corpusDigestSha256: generated.digestSha256,
      corpusDefinitionDigestSha256: generated.manifest.definitionDigestSha256,
      eventSchemaDigestSha256: generated.manifest.sourceEventFormat.schemaDigestSha256,
      scenarioId: "session-switch-v1",
      scenarioDigestSha256: "1".repeat(64),
      runDirectory: root,
    }), { corpusDigestSha256: generated.digestSha256, eventSchemaDigestSha256: generated.manifest.sourceEventFormat.schemaDigestSha256, materializationModes: ["translated"] });
    assert.equal(prepared.materializationMode, "translated");
    const launched = await driver.request("launch", { scenarioId: "session-switch-v1", stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: "driver-test" });
    assert.equal(launched.ready, true);
    const benchmarkCase = { caseId: "case-1", workload: "isolated-latency", transcriptBytes: 16, workspaceRelation: "within-workspace", sessionState: "cold" };
    const observation = normalizeExecution(await driver.request("execute", { scenarioId: "session-switch-v1", case: benchmarkCase }), benchmarkCase);
    assert.equal(observation.status, "valid");
    assertShutdown(await driver.request("shutdown", { reason: "test" }));
  } finally {
    await driver.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare rejects a materialization mode the driver did not advertise", () => {
  assert.throws(() => assertPrepared({
    materializationMode: "translated",
    corpusDigestSha256: "a".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    mappingDigestSha256: "c".repeat(64),
    stateHandles: { P0: "p0", P1: "p1" },
  }, {
    corpusDigestSha256: "a".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    materializationModes: ["native-opencode"],
  }), /unadvertised materialization mode/);
});

test("prepare rejects a workspace fixture digest the driver did not attest", () => {
  assert.throws(() => assertPrepared({
    materializationMode: "translated",
    corpusDigestSha256: "a".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    mappingDigestSha256: "c".repeat(64),
    workspaceFixtureDigestSha256: "d".repeat(64),
    stateHandles: { P0: "p0", P1: "p1" },
  }, {
    corpusDigestSha256: "a".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    workspaceFixtureDigestSha256: "e".repeat(64),
    materializationModes: ["translated"],
  }), /wrong workspace fixture digest/u);
});

for (const mode of ["malformed", "crash", "duplicate"]) {
  test(`driver process rejects ${mode} protocol behavior`, async () => {
    const driver = await DriverProcess.spawn({ executable: process.execPath, args: [DRIVER], env: { BENCHMARK_MOCK_MODE: mode } });
    try {
      if (mode === "duplicate") {
        await driver.request("hello", { frameworkVersion: 1 });
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(driver.request("hello", { frameworkVersion: 1 }), /unsolicited|running/);
      } else {
        await assert.rejects(driver.request("hello", { frameworkVersion: 1 }), /invalid NDJSON|exited/);
      }
    } finally {
      await driver.close();
    }
  });
}

test("wrong-content readiness remains a preserved invalid observation", async () => {
  const driver = await DriverProcess.spawn({ executable: process.execPath, args: [DRIVER], env: { BENCHMARK_MOCK_MODE: "wrong-content" } });
  try {
    const benchmarkCase = { caseId: "case-invalid", startMode: "new-application-state" };
    const observation = normalizeExecution({
      caseId: benchmarkCase.caseId,
      durationMs: 1,
      clock: { kind: "single-monotonic-clock", start: 1, end: 2 },
      readiness: {
        endpoint: "correct-content-painted-and-input-ready",
        checks: [
          { id: "content-identity", passed: false },
          { id: "first-fold-painted", passed: true },
          { id: "two-presentations", passed: true },
          { id: "trusted-input", passed: true },
        ],
      },
    }, benchmarkCase);
    assert.equal(observation.status, "invalid");
    assert.match(observation.reason, /readiness checks/);
  } finally {
    await driver.close();
  }
});

test("panel toggle semantics accept animated reversal and non-animated immediate double-toggle", () => {
  const benchmarkCase = { caseId: "toggle", workload: "workspace-panel-action", action: "toggle-open-close" };
  for (const transitionMode of ["animated", "none"]) {
    const result = panelExecution(benchmarkCase, transitionMode);
    assert.equal(normalizeExecution(result, benchmarkCase, { requireTimingEvidence: true, requireRendererTrace: true }).status, "valid");
  }
});

test("invalid semantic renderer evidence remains preserved for diagnosis", () => {
  const benchmarkCase = { caseId: "toggle", workload: "workspace-panel-action", action: "toggle-open-close" };
  const result = panelExecution(benchmarkCase, "animated");
  result.rendererTrace.counterInterval = { start: 90, end: 120 };
  const observation = normalizeExecution(result, benchmarkCase, { requireTimingEvidence: true, requireRendererTrace: true });
  assert.equal(observation.status, "invalid");
  assert.match(observation.reason, /exact action interval/u);
  assert.deepEqual(observation.rendererTrace, result.rendererTrace);
  assert.deepEqual(observation.clock, result.clock);
  assert.deepEqual(observation.readiness, result.readiness);
});

function panelExecution(benchmarkCase, transitionMode) {
  return {
    caseId: benchmarkCase.caseId,
    durationMs: 20,
    clock: { kind: "single-monotonic-clock", clock: "test-clock", start: 100, end: 120 },
    readiness: {
      endpoint: "correct-content-painted-and-input-ready",
      checks: [
        { id: "content-identity", passed: true, observedAt: 120 },
        { id: "first-fold-painted", passed: true, observedAt: 120 },
        { id: "two-presentations", passed: true, observedAt: 120 },
        { id: "trusted-input", passed: true, observedAt: 120 },
      ],
    },
    rendererTrace: {
      clock: "test-clock",
      transitionMode,
      milestones: [
        { id: "trusted-input", at: 100 },
        { id: "second-toggle-input", at: 104 },
        { id: "final-state-presented", at: 110 },
        { id: "animation-settled", at: transitionMode === "animated" ? 118 : 110 },
        { id: "interactive", at: 120 },
      ],
      frameTimestampsMs: [100, 110, 120],
      longAnimationFrames: [],
      counterInterval: { start: 100, end: 120 },
      counters: { scriptDurationMs: 4, styleRecalcDurationMs: 2, layoutDurationMs: 1, taskDurationMs: 8 },
    },
  };
}
