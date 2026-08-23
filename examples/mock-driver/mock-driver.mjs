#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

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
      scenarios: ["app-start-v1", "session-switch-v1", ...(process.env.BENCHMARK_MOCK_SCENARIO_ID ? [process.env.BENCHMARK_MOCK_SCENARIO_ID] : [])],
      sourceEventFormats: ["opencode-event-v1"],
      materializationModes: ["translated"],
      guiFramework: "mock-native",
    };
  }
  if (method === "prepare") {
    if (!/^[0-9a-f]{64}$/.test(params.corpusDefinitionDigestSha256 ?? "")) {
      throw new Error("Mock driver requires corpusDefinitionDigestSha256.");
    }
    const manifest = JSON.parse(await readFile(params.corpusManifestPath, "utf8"));
    prepared = { params, manifest };
    const mapping = Object.fromEntries(manifest.sessions.map((session) => [session.logicalSessionId, `mock-${session.nativeSessionId}`]));
    return {
      materializationMode: "translated",
      corpusDigestSha256: params.corpusDigestSha256,
      eventSchemaDigestSha256: params.eventSchemaDigestSha256,
      mappingDigestSha256: createHash("sha256").update(JSON.stringify(mapping)).digest("hex"),
      stateHandles: { P0: "mock-p0", P1: "mock-p1" },
      sessionMapping: mapping,
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
    const durationMs = params.case.transcriptBytes ? 4 + Math.log2(params.case.transcriptBytes / 1048576 + 1) : params.case.startMode === "new-application-state" ? 40 : 25;
    return {
      caseId: params.case.caseId,
      durationMs,
      clock: { kind: "single-monotonic-clock", clock: "mock-performance", start: 100, end: 100 + durationMs },
      readiness: receipt(process.env.BENCHMARK_MOCK_MODE !== "wrong-content"),
    };
  }
  if (method === "shutdown") {
    const terminated = application ? [application.identity] : [];
    await stopApplication();
    return { terminated, survivors: process.env.BENCHMARK_MOCK_MODE === "survivor" ? terminated : [] };
  }
  throw new Error(`Unsupported method ${method}.`);
}

function receipt(contentPassed = true) {
  return {
    endpoint: "correct-content-painted-and-input-ready",
    checks: [
      { id: "content-identity", passed: contentPassed },
      { id: "first-fold-painted", passed: true },
      { id: "two-presentations", passed: true },
      { id: "trusted-input", passed: true },
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
  application = { child, identity: { pid: child.pid, startTimeMs: Date.now(), owner: "application", category: "mock-native-gui" } };
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
