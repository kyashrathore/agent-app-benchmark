#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { attestWorkspaceFixture, generateWorkspaceFileBytes, verifyWorkspaceFixtureManifest } from "../../src/workspace-fixture.mjs";

const SHA = "0".repeat(64);
const COMMIT = "0".repeat(40);
let prepared;
let application;

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
    if (process.env.BENCHMARK_MOCK_MODE === "malformed") {
      process.stdout.write("not-json\n");
      continue;
    }
    if (process.env.BENCHMARK_MOCK_MODE === "crash") process.exit(17);
    if (process.env.BENCHMARK_MOCK_MODE === "timeout") continue;
    const result = await dispatch(request.method, request.params);
    respond(request, { ok: true, result });
    if (process.env.BENCHMARK_MOCK_MODE === "duplicate") respond(request, { ok: true, result });
  } catch (error) {
    if (request) respond(request, { ok: false, error: { code: "mock-driver-error", message: String(error instanceof Error ? error.message : error).slice(0, 1024) } });
  }
}
await stopApplication();

async function dispatch(method, params) {
  if (method === "hello") {
    return {
      protocolVersion: 1,
      application: { id: process.env.BENCHMARK_MOCK_APP_ID ?? "mock-native", name: "Mock Native GUI", version: "1.0.0", buildDigestSha256: SHA },
      driver: { name: "mock-native-driver", version: "1.0.0", sourceCommit: COMMIT, digestSha256: SHA },
      scenarios: ["app-start-v1", "session-switch-v1", "workspace-panel-v1", "session-switch-workspace-panel-v1", ...(process.env.BENCHMARK_MOCK_SCENARIO_ID ? [process.env.BENCHMARK_MOCK_SCENARIO_ID] : [])],
      sourceEventFormats: ["opencode-event-v1", "opencode-event-v2"],
      materializationModes: ["translated"],
      guiFramework: "mock-native",
    };
  }
  if (method === "prepare") {
    if (!/^[0-9a-f]{64}$/.test(params.corpusDefinitionDigestSha256 ?? "")) {
      throw new Error("Mock driver requires corpusDefinitionDigestSha256.");
    }
    const manifest = JSON.parse(await readFile(params.corpusManifestPath, "utf8"));
    const panelScenario = ["workspace-panel", "session-switch-workspace-panel"].includes(params.scenarioDefinition?.kind);
    let workspaceFixtureDigestSha256;
    if (panelScenario) {
      if (params.scenarioDefinition.id !== params.scenarioId || params.fixtureSeed !== manifest.seed) throw new Error("Mock driver requires the exact scenario definition and corpus fixture seed.");
      const fixture = verifyWorkspaceFixtureManifest(params.workspaceFixtureManifest);
      if (fixture.manifestDigestSha256 !== params.workspaceFixtureDigestSha256) throw new Error("Mock driver received the wrong workspace fixture digest.");
      workspaceFixtureDigestSha256 = await attestWorkspaceFixture(fixture, (filePath, revision) => {
        const file = fixture.files.find((candidate) => candidate.path === filePath);
        return generateWorkspaceFileBytes(fixture.seed, file, revision);
      });
    }
    prepared = { params, manifest };
    const mapping = Object.fromEntries(manifest.sessions.map((session) => [session.logicalSessionId, `mock-${session.nativeSessionId}`]));
    return {
      materializationMode: "translated",
      corpusDigestSha256: params.corpusDigestSha256,
      eventSchemaDigestSha256: params.eventSchemaDigestSha256,
      mappingDigestSha256: createHash("sha256").update(JSON.stringify(mapping)).digest("hex"),
      stateHandles: { P0: "mock-p0", P1: "mock-p1" },
      sessionMapping: mapping,
      ...(panelScenario ? { workspaceFixtureDigestSha256 } : {}),
    };
  }
  if (method === "launch") {
    requirePrepared();
    await startApplication();
    return { ready: true, processes: [application.identity], readiness: receipt() };
  }
  if (method === "execute") {
    requirePrepared();
    if (process.env.BENCHMARK_MOCK_MODE === "sensitive-error") throw new Error("failed at /Users/example/private/session.json token=super-secret-value");
    if (params.case.startMode) await startApplication();
    if (!application) throw new Error("Mock application is not running.");
    const panelScenario = ["workspace-panel", "session-switch-workspace-panel"].includes(prepared.params.scenarioDefinition?.kind);
    const durationMs = panelScenario ? panelDuration(params.case) : params.case.transcriptBytes ? 4 + Math.log2(params.case.transcriptBytes / 1048576 + 1) : params.case.startMode === "new-application-state" ? 40 : 25;
    const rendererTrace = panelScenario ? mockRendererTrace(params.case, 100, durationMs) : undefined;
    return {
      caseId: params.case.caseId,
      durationMs,
      clock: { kind: "single-monotonic-clock", clock: "mock-performance", start: 100, end: 100 + durationMs },
      readiness: receipt(
        process.env.BENCHMARK_MOCK_MODE !== "wrong-content",
        prepared.params.scenarioId.endsWith("-v3") || panelScenario ? 100 + durationMs : undefined,
      ),
      ...(rendererTrace ? { rendererTrace } : {}),
    };
  }
  if (method === "shutdown") {
    const terminated = application ? [application.identity] : [];
    await stopApplication();
    return { terminated, survivors: process.env.BENCHMARK_MOCK_MODE === "survivor" ? terminated : [] };
  }
  throw new Error(`Unsupported method ${method}.`);
}

function panelDuration(benchmarkCase) {
  if (["toggle-open-close", "toggle-close-open"].includes(benchmarkCase.action)) return 36;
  if (benchmarkCase.action?.startsWith("open-")) return 70;
  if (benchmarkCase.workload === "workspace-panel-action") return 16;
  return benchmarkCase.panelProfile === "diff" ? 30 : benchmarkCase.panelProfile === "files" ? 24 : 18;
}

function mockRendererTrace(benchmarkCase, start, duration) {
  const end = start + duration;
  let transitionMode = "none";
  let milestones;
  if (["open-cold", "open-warm-data"].includes(benchmarkCase.action)) {
    transitionMode = "animated";
    milestones = benchmarkCase.action === "open-warm-data"
      ? [point("data-ready", start), point("trusted-input", start + 1), point("shell-visible", start + 3), point("above-fold-painted", start + 12), point("animation-settled", end - 4), point("interactive", end)]
      : [point("trusted-input", start), point("shell-visible", start + 3), point("data-ready", start + 10), point("above-fold-painted", start + 20), point("animation-settled", end - 4), point("interactive", end)];
  } else if (["toggle-open-close", "toggle-close-open"].includes(benchmarkCase.action)) {
    transitionMode = "animated";
    milestones = [point("trusted-input", start), point("second-toggle-input", start + 10), point("final-state-presented", start + 16), point("animation-settled", end - 2), point("interactive", end)];
  } else if (benchmarkCase.workload === "workspace-panel-action") {
    milestones = [point("trusted-input", start), point("action-painted", end - 2), point("interactive", end)];
  } else {
    milestones = [point("trusted-input", start), point("content-identity", start + 8), point("session-ready", start + 10), point("panel-ready", end - 4), point("above-fold-painted", end - 2), point("interactive", end)];
  }
  const frameTimestampsMs = [];
  for (let at = start; at < end; at += 8) frameTimestampsMs.push(at);
  if (frameTimestampsMs.at(-1) !== end) frameTimestampsMs.push(end);
  const longAnimationFrames = benchmarkCase.action === "open-cold" ? [{
    start: start + 5,
    duration: 55,
    blockingDuration: 5,
    renderStart: start + 45,
    styleAndLayoutStart: start + 48,
    scripts: [{
      functionName: "renderWorkspacePanel",
      invokerType: "event-listener",
      sourceURL: "benchmark-assets/panel.js",
      duration: 40,
      forcedStyleAndLayoutDuration: 4,
    }],
  }] : [];
  return {
    clock: "mock-performance",
    transitionMode,
    milestones,
    frameTimestampsMs,
    longAnimationFrames,
    counterInterval: { start, end },
    counters: {
      scriptDurationMs: duration * 0.25,
      styleRecalcDurationMs: duration * 0.1,
      layoutDurationMs: duration * 0.05,
      taskDurationMs: duration * 0.5,
    },
  };
}

function point(id, at) {
  return { id, at };
}

function receipt(contentPassed = true, observedAt) {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: [
      { id: "content-identity", passed: contentPassed, ...(observedAt === undefined ? {} : { observedAt }) },
      { id: "first-fold-painted", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
      { id: "two-presentations", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
      { id: "trusted-input", passed: true, ...(observedAt === undefined ? {} : { observedAt }) },
    ],
  };
}

async function startApplication() {
  if (application) throw new Error("Mock application is already running.");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  application = { child, identity: { pid: child.pid, startTimeMs: Date.now(), owner: "application", category: "mock-native-gui", role: "main" } };
}

async function stopApplication() {
  if (!application) return;
  const current = application;
  application = undefined;
  if (current.child.exitCode === null) {
    const exited = new Promise((resolve) => current.child.once("exit", resolve));
    current.child.kill("SIGTERM");
    await exited;
  }
}

function requirePrepared() {
  if (!prepared) throw new Error("Mock driver has not prepared a corpus.");
}

function respond(request, body) {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, kind: "response", correlationId: request.correlationId, method: request.method, ...body })}\n`);
}
