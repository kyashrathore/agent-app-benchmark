import { assertContract } from "./contracts.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_READINESS_CHECKS = ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"];

export function assertHello(result, expected) {
  if (!result || result.protocolVersion !== 1) throw new Error("Driver hello has an unsupported protocol version.");
  assertIdentity(result.application, ["id", "name", "version", "buildDigestSha256"], "application");
  assertIdentity(result.driver, ["name", "version", "sourceCommit", "digestSha256"], "driver");
  if (result.application.id !== expected.appId) throw new Error(`Driver application id ${result.application.id} does not match ${expected.appId}.`);
  if (!Array.isArray(result.scenarios) || !result.scenarios.includes(expected.scenarioId)) throw new Error(`Driver does not support ${expected.scenarioId}.`);
  if (!Array.isArray(result.sourceEventFormats) || !result.sourceEventFormats.includes(expected.sourceEventFormatId)) throw new Error(`Driver does not support ${expected.sourceEventFormatId}.`);
  if (!Array.isArray(result.materializationModes) || result.materializationModes.some((mode) => !["native-opencode", "translated"].includes(mode))) throw new Error("Driver materialization modes are invalid.");
  return result;
}

export function assertPrepared(result, expected) {
  if (!result || !["native-opencode", "translated"].includes(result.materializationMode)) throw new Error("Driver prepare result has no valid materialization mode.");
  if (!expected.materializationModes?.includes(result.materializationMode)) throw new Error(`Driver prepare result uses unadvertised materialization mode ${result.materializationMode}.`);
  if (result.corpusDigestSha256 !== expected.corpusDigestSha256) throw new Error("Driver attested to the wrong corpus digest.");
  if (result.eventSchemaDigestSha256 !== expected.eventSchemaDigestSha256) throw new Error("Driver attested to the wrong event schema digest.");
  if (!SHA256.test(result.mappingDigestSha256 ?? "")) throw new Error("Driver prepare result has no mapping digest.");
  if (expected.workspaceFixtureDigestSha256 && result.workspaceFixtureDigestSha256 !== expected.workspaceFixtureDigestSha256) throw new Error("Driver attested to the wrong workspace fixture digest.");
  if (!result.stateHandles || typeof result.stateHandles.P0 !== "string" || typeof result.stateHandles.P1 !== "string") throw new Error("Driver did not prepare P0 and P1 state handles.");
  return result;
}

export function assertLaunch(result, options = {}) {
  if (!result?.ready || !Array.isArray(result.processes) || result.processes.length === 0) throw new Error("Driver launch did not reach readiness with process roots.");
  for (const process of result.processes) {
    if (!Number.isInteger(process.pid) || process.pid < 1 || !Number.isFinite(process.startTimeMs) || process.startTimeMs < 0 || process.owner !== "application") {
      throw new Error("Driver launch returned an invalid application process identity.");
    }
    if (options.requireProcessRoles && !["main", "renderer", "gpu", "utility", "external-helper"].includes(process.role)) {
      throw new Error("Driver launch must classify every declared process root by role.");
    }
  }
  assertReceipt(result.readiness, "launch readiness");
  return result;
}

export function normalizeExecution(result, benchmarkCase, options = {}) {
  const base = { case: benchmarkCase, receivedAt: new Date().toISOString() };
  if (!result || result.caseId !== benchmarkCase.caseId) return { ...base, status: "invalid", reason: "Driver returned the wrong case id." };
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) return { ...base, status: "invalid", reason: "Driver returned an invalid duration." };
  try {
    assertReceipt(result.readiness, "execution readiness", options);
    if (result.readiness.checks.some((check) => check.passed !== true)) return invalidExecution(base, result, "One or more readiness checks failed.");
    if (!result.clock || result.clock.kind !== "single-monotonic-clock" || !Number.isFinite(result.clock.start) || !Number.isFinite(result.clock.end) || result.clock.end < result.clock.start) {
      return invalidExecution(base, result, "Driver returned invalid one-clock timing evidence.");
    }
    if (Math.abs((result.clock.end - result.clock.start) - result.durationMs) > 0.5) {
      return invalidExecution(base, result, "Driver duration does not match its monotonic clock interval.");
    }
    if (options.requireTimingEvidence) {
      for (const check of result.readiness.checks) {
        if (!Number.isFinite(check.observedAt) || check.observedAt < result.clock.start || check.observedAt > result.clock.end + 0.5) {
          return invalidExecution(base, result, "Driver readiness evidence is missing or outside the timed interval.");
        }
      }
      const evidence = Object.fromEntries(result.readiness.checks.map((check) => [check.id, check.observedAt]));
      if (evidence["two-presentations"] < evidence["first-fold-painted"]
        || Math.abs(Math.max(...Object.values(evidence)) - result.clock.end) > 0.5) {
        return invalidExecution(base, result, "Driver readiness milestones do not support the reported endpoint.");
      }
    }
    if (options.requireRendererTrace) assertRendererTrace(result.rendererTrace, result.clock, benchmarkCase);
  } catch (error) {
    return invalidExecution(base, result, error.message);
  }
  return {
    ...base,
    status: "valid",
    durationMs: result.durationMs,
    readiness: result.readiness,
    clock: result.clock,
    ...(result.rendererTrace === undefined ? {} : { rendererTrace: result.rendererTrace }),
  };
}

function invalidExecution(base, result, reason) {
  const invalid = { ...base, status: "invalid", durationMs: result.durationMs, reason };
  try {
    assertReceipt(result.readiness, "preserved execution readiness");
    if (result.readiness.checks.every((check) => check.observedAt === undefined || (Number.isFinite(check.observedAt) && check.observedAt >= 0))) invalid.readiness = result.readiness;
  } catch {}
  if (result.clock?.kind === "single-monotonic-clock" && typeof result.clock.clock === "string"
    && Number.isFinite(result.clock.start) && Number.isFinite(result.clock.end) && result.clock.end >= result.clock.start) invalid.clock = result.clock;
  try {
    assertContract("rendererTrace", result.rendererTrace, "preserved renderer trace");
    invalid.rendererTrace = result.rendererTrace;
  } catch {}
  return invalid;
}

export function assertShutdown(result) {
  if (!result || !Array.isArray(result.terminated) || !Array.isArray(result.survivors)) throw new Error("Driver shutdown result is invalid.");
  if (result.survivors.length > 0) throw new Error(`Driver shutdown left ${result.survivors.length} surviving process(es).`);
  return result;
}

function assertIdentity(value, fields, label) {
  if (!value || typeof value !== "object") throw new Error(`Driver ${label} identity is missing.`);
  for (const field of fields) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`Driver ${label}.${field} is missing.`);
  }
  for (const field of ["buildDigestSha256", "digestSha256"]) {
    if (value[field] !== undefined && !SHA256.test(value[field])) throw new Error(`Driver ${label}.${field} is not SHA-256.`);
  }
}

function assertReceipt(receipt, label, options = {}) {
  if (!receipt || receipt.endpoint !== "correct-content-painted-and-input-ready" || !Array.isArray(receipt.checks)) throw new Error(`Driver ${label} receipt is missing.`);
  if (receipt.checks.length !== REQUIRED_READINESS_CHECKS.length || receipt.checks.some((check, index) => check?.id !== REQUIRED_READINESS_CHECKS[index])) {
    throw new Error(`Driver ${label} receipt does not contain the exact required checks.`);
  }
  for (const check of receipt.checks) {
    if (typeof check.id !== "string" || typeof check.passed !== "boolean") throw new Error(`Driver ${label} check is invalid.`);
    if (options.requireTimingEvidence && !Number.isFinite(check.observedAt)) throw new Error(`Driver ${label} check has no monotonic observation time.`);
  }
}

function assertRendererTrace(trace, clock, benchmarkCase) {
  if (!trace || trace.clock !== clock.clock || !["none", "animated"].includes(trace.transitionMode)) throw new Error("Driver renderer trace is missing or uses a different clock.");
  if (!Array.isArray(trace.milestones) || !Array.isArray(trace.frameTimestampsMs) || !Array.isArray(trace.longAnimationFrames) || !trace.counterInterval || !trace.counters) throw new Error("Driver renderer trace is incomplete.");
  if (!Number.isFinite(trace.counterInterval.start) || !Number.isFinite(trace.counterInterval.end)
    || Math.abs(trace.counterInterval.start - clock.start) > 0.5
    || Math.abs(trace.counterInterval.end - clock.end) > 0.5) throw new Error("Driver renderer counters do not cover the exact action interval.");
  assertOrderedTimes(trace.milestones.map((item) => item.at), clock, "renderer milestones");
  assertOrderedTimes(trace.frameTimestampsMs, clock, "renderer frames");
  const milestoneIds = trace.milestones.map((item) => item.id);
  if (new Set(milestoneIds).size !== milestoneIds.length) throw new Error("Driver renderer milestones are not unique.");
  const milestones = Object.fromEntries(trace.milestones.map((item) => [item.id, item.at]));
  const required = requiredMilestones(benchmarkCase);
  if (required.some((id) => !Number.isFinite(milestones[id]))) throw new Error(`Driver renderer trace is missing required milestones: ${required.filter((id) => !Number.isFinite(milestones[id])).join(", ")}.`);
  if (Math.abs(milestones.interactive - clock.end) > 0.5) throw new Error("Driver renderer interactive milestone does not match the action endpoint.");
  if (benchmarkCase.workload === "workspace-panel-action") assertPanelMilestoneOrder(benchmarkCase.action, milestones, trace.transitionMode);
  if (benchmarkCase.workload === "panel-session-switch" && (milestones["session-ready"] < milestones["trusted-input"]
    || milestones["panel-ready"] < milestones["trusted-input"]
    || milestones["above-fold-painted"] < milestones["content-identity"]
    || milestones.interactive < Math.max(milestones["session-ready"], milestones["panel-ready"], milestones["above-fold-painted"]))) {
    throw new Error("Driver panel-switch milestones are out of order.");
  }
  for (const entry of trace.longAnimationFrames) {
    if (!Number.isFinite(entry.start) || !Number.isFinite(entry.duration) || entry.start < clock.start || entry.start + entry.duration > clock.end + 0.5) throw new Error("Driver long-animation-frame evidence is outside the action interval.");
    if (!Array.isArray(entry.scripts) || entry.scripts.some((script) => !Number.isFinite(script.duration) || !Number.isFinite(script.forcedStyleAndLayoutDuration))) throw new Error("Driver long-animation-frame script attribution is invalid.");
  }
  for (const value of Object.values(trace.counters)) if (!Number.isFinite(value) || value < 0) throw new Error("Driver renderer counters are invalid.");
}

function requiredMilestones(benchmarkCase) {
  if (benchmarkCase.workload === "panel-session-switch") return ["trusted-input", "session-ready", "panel-ready", "content-identity", "above-fold-painted", "interactive"];
  if (["open-cold", "open-warm-data"].includes(benchmarkCase.action)) return ["trusted-input", "shell-visible", "animation-settled", "data-ready", "above-fold-painted", "interactive"];
  if (["toggle-open-close", "toggle-close-open"].includes(benchmarkCase.action)) return ["trusted-input", "second-toggle-input", "final-state-presented", "animation-settled", "interactive"];
  return ["trusted-input", "action-painted", "interactive"];
}

function assertPanelMilestoneOrder(action, milestones, transitionMode) {
  if (["open-cold", "open-warm-data"].includes(action)) {
    if (milestones["shell-visible"] < milestones["trusted-input"]
      || milestones["animation-settled"] < milestones["shell-visible"]
      || milestones["above-fold-painted"] < milestones["data-ready"]
      || milestones.interactive < Math.max(milestones["animation-settled"], milestones["above-fold-painted"])) throw new Error("Driver panel-open milestones are out of order.");
    if (transitionMode === "none" && milestones["animation-settled"] !== milestones["shell-visible"]) throw new Error("A non-animated panel open must settle when its shell becomes visible.");
    return;
  }
  if (["toggle-open-close", "toggle-close-open"].includes(action)) {
    if (milestones["second-toggle-input"] < milestones["trusted-input"]
      || milestones["final-state-presented"] < milestones["second-toggle-input"]
      || milestones["animation-settled"] < milestones["final-state-presented"]
      || milestones.interactive < milestones["animation-settled"]) throw new Error("Driver panel-toggle milestones are out of order.");
    return;
  }
  if (milestones["action-painted"] < milestones["trusted-input"] || milestones.interactive < milestones["action-painted"]) throw new Error("Driver settled panel-interaction milestones are out of order.");
}

function assertOrderedTimes(values, clock, label) {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value < clock.start || value > clock.end + 0.5)) throw new Error(`Driver ${label} are missing or outside the action interval.`);
  if (values.some((value, index) => index > 0 && value < values[index - 1])) throw new Error(`Driver ${label} are not monotonic.`);
}
