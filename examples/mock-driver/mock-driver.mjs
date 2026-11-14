#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { recordingObservation } from "../../src/driver-sdk.mjs";

const SHA = "0".repeat(64);
const COMMIT = "0".repeat(40);
let prepared;
let application;
let lastEnterAt;

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
      scenarios: ["test-app-start", "test-session-switch", "test-new-thread", "test-long-thread", "test-typing", "app-start", "session-switch-walk", "new-thread", "long-thread", "typing-while-streaming"],
      ...(process.env.BENCHMARK_MOCK_UNSUPPORTED ? { unsupportedScenarios: Object.fromEntries([process.env.BENCHMARK_MOCK_UNSUPPORTED.split("=")]) } : {}),
      sourceEventFormats: ["opencode-event"],
      materializationModes: [process.env.BENCHMARK_MOCK_MATERIALIZATION ?? "translated"],
      guiFramework: "mock-native",
      ...(process.env.BENCHMARK_MOCK_FRAME_LOG ? { clockRule: "settle-31-frames" } : {}),
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
      materializationMode: process.env.BENCHMARK_MOCK_MATERIALIZATION ?? "translated",
      corpusDigestSha256: params.corpusDigestSha256,
      eventSchemaDigestSha256: params.eventSchemaDigestSha256,
      mappingDigestSha256: createHash("sha256").update(JSON.stringify(mapping)).digest("hex"),
      stateHandles: { P0: "mock-p0", P1: "mock-p1" },
      sessionMapping: mapping,
    };
  }
  if (method === "launch") {
    requirePrepared();
    if (process.env.BENCHMARK_MOCK_LAUNCH_LOG) await appendFile(process.env.BENCHMARK_MOCK_LAUNCH_LOG, `${params.groupId}\n`);
    await startApplication();
    return { ready: true, processes: [application.identity], readiness: receipt() };
  }
  if (method === "execute") {
    requirePrepared();
    if (process.env.BENCHMARK_MOCK_MODE === "sensitive-error") throw new Error("failed at /Users/example/private/session.json token=super-secret-value");
    if (params.case.startMode) await startApplication();
    if (!application) throw new Error("Mock application is not running.");
    if (params.case.workload === "long-thread-scroll") return { caseId: params.case.caseId, readiness: receipt(true), ...recordingObservation(scrollRecording(params.case.scroll)) };
    if (params.case.workload === "stream-first-word") return { caseId: params.case.caseId, readiness: receipt(true), ...recordingObservation(await firstWord(params.case)) };
    if (params.case.workload === "typing") return { caseId: params.case.caseId, readiness: receipt(true), ...recordingObservation(typingRecording(params.case)) };
    const durationMs = params.case.nominalBytes ? 4 + Math.log2(params.case.nominalBytes / 1048576 + 1)
      : params.case.workload === "new-thread" ? 30
        : params.case.workload === "long-thread-open" ? 60
          : params.case.startMode === "new-application-state" ? 40 : 25;
    return {
      caseId: params.case.caseId,
      durationMs,
      clock: { kind: "single-monotonic-clock", clock: "mock-performance", start: 100, end: 100 + durationMs },
      readiness: receipt(process.env.BENCHMARK_MOCK_MODE !== "wrong-content", 100 + durationMs),
      ...(process.env.BENCHMARK_MOCK_FRAME_LOG ? { frameLog: mockFrameLog(100 + durationMs, process.env.BENCHMARK_MOCK_FRAME_LOG === "late" ? 8 : 0) } : {}),
    };
  }
  if (method === "shutdown") {
    const terminated = application ? [application.identity] : [];
    await stopApplication();
    return { terminated, survivors: process.env.BENCHMARK_MOCK_MODE === "survivor" ? terminated : [] };
  }
  throw new Error(`Unsupported method ${method}.`);
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

/** One unready frame, then 31 unchanged ready frames starting `lateMs` after the reported clock end. */
function mockFrameLog(end, lateMs) {
  const gates = { displayedDestination: true, latestTurnPainted: true, noPlaceholder: true, firstFoldComplete: true, composerEditable: true, windowVisibleFocused: true };
  return {
    startAt: 100,
    frames: [
      { at: 100 + (end - 100) / 2, gates: { ...gates, latestTurnPainted: false }, signature: null, mutated: false },
      ...Array.from({ length: 31 }, (_, index) => ({ at: end + lateMs + index * 8, gates, signature: "settled", mutated: false })),
    ],
  };
}

/** 120 Hz frames across the scroll window, with one 50 ms frame after the fortieth. */
function scrollRecording(scroll) {
  const startAt = 100;
  const wheels = Array.from({ length: scroll.wheelCount }, (_, index) => ({ at: startAt + index * scroll.intervalMs, deltaY: scroll.deltaY }));
  const tailMs = process.env.BENCHMARK_MOCK_RECORDING === "short" ? scroll.tailMs / 2 : scroll.tailMs;
  const endAt = wheels.at(-1).at + tailMs;
  const frames = [];
  for (let at = startAt + 2; at <= endAt; at += frames.length === 40 ? 50 : 8.3) frames.push(Math.round(at * 10) / 10);
  return { kind: "scroll", startAt, endAt, wheels, frames, scrollTop: { start: 90_000, end: 90_000 + scroll.wheelCount * scroll.deltaY } };
}


/** Sends the prompt to the replay server the framework passed in prepare and paints the first delta 5 ms after it arrives. */
async function firstWord(benchmarkCase) {
  const replay = prepared.params.replay;
  if (!replay) throw new Error("Mock driver was prepared without a replay server.");
  const sendAt = lastEnterAt === undefined ? 0 : lastEnterAt + benchmarkCase.startIntervalMs;
  while (performance.now() < sendAt) await new Promise((resolve) => setTimeout(resolve, sendAt - performance.now() + 1));
  const startAt = performance.now();
  lastEnterAt = startAt;
  const controller = new AbortController();
  const response = await fetch(`${replay.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${replay.apiKey}` },
    body: JSON.stringify({ model: replay.modelId, stream: true, messages: [{ role: "user", content: replay.prompt }] }),
    signal: controller.signal,
  });
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(JSON.stringify(replay.replyOpening).slice(1, -1))) break;
  }
  const arrivedAt = performance.now();
  controller.abort();
  return { kind: "first-word", startAt, frames: [{ at: startAt + 1, painted: false }, { at: arrivedAt + 5, painted: true }] };
}

/** Each key paints 12 ms after its keydown, on 8 ms frames; with BENCHMARK_MOCK_RECORDING=miss-last the last key never paints. */
function typingRecording(benchmarkCase) {
  let at = 1000;
  const keydowns = benchmarkCase.keys.map(({ key, delayMs }) => ({ key, at: (at += delayMs) }));
  const missLast = process.env.BENCHMARK_MOCK_RECORDING === "miss-last";
  const paintedAt = keydowns.map((keydown, index) => (missLast && index === keydowns.length - 1 ? Infinity : keydown.at + 12));
  const endAt = missLast ? keydowns.at(-1).at + benchmarkCase.missAfterMs + 8 : paintedAt.at(-1) + 8;
  const frames = [];
  for (let frame = keydowns[0].at + 4; frame <= endAt; frame += 8) frames.push({ at: frame, typed: paintedAt.filter((painted) => painted <= frame).length });
  return { kind: "typing", endAt: frames.at(-1).at, keydowns, frames };
}
