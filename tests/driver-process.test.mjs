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
  generator: "opencode-completed-transcripts-v1",
  seed: "driver-test",
  sourceEventFormat: { id: "opencode-event-v1", sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a", envelope: "EventV2.SerializedEvent", eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"] },
  workspaceIds: ["workspace-a", "workspace-b"],
  transcriptBytes: [16],
  messageChunkBytes: 8,
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
      eventSchemaDigestSha256: generated.manifest.sourceEventFormat.schemaDigestSha256,
      scenarioId: "session-switch-v1",
      scenarioDigestSha256: "1".repeat(64),
      runDirectory: root,
    }), { corpusDigestSha256: generated.digestSha256, eventSchemaDigestSha256: generated.manifest.sourceEventFormat.schemaDigestSha256 });
    assert.equal(prepared.materializationMode, "translated");
    const launched = await driver.request("launch", { scenarioId: "session-switch-v1", stateHandle: prepared.stateHandles.P1, initialSessionId: "control" });
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
      readiness: { endpoint: "ready", checks: [{ id: "content-identity", passed: false }] },
    }, benchmarkCase);
    assert.equal(observation.status, "invalid");
    assert.match(observation.reason, /readiness checks/);
  } finally {
    await driver.close();
  }
});
