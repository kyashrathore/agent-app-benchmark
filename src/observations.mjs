import { CLOCK_RULE_ID, frameLogMismatch } from "./clock-rule.mjs";
import { deriveScroll, deriveTyping, firstWordMismatch } from "./frame-recordings.mjs";
import { normalizeExecution } from "./protocol.mjs";

const MAX_PUBLIC_ERROR_LENGTH = 512;
const RECORDING_REQUIRED = new Set(["long-thread-scroll", "stream-first-word", "typing"]);

/**
 * The observations one `execute` response yields, each re-derived from the
 * driver's frame log. A settle log may be missing (counted, the observation
 * stays as reported); a scroll, first-word or typing recording is the only
 * source of its values, so a missing one invalidates the observation.
 * `frameLogs` counts what was checked.
 */
export function observeExecution(frameLogs, scenario, action, result) {
  const request = action.request;
  if (request.workload === "typing") return observeTyping(frameLogs, scenario, action, result);
  const observation = normalizeExecution(result, request);
  if (result?.frameLog === undefined) {
    frameLogs.missing += 1;
    if (!RECORDING_REQUIRED.has(request.workload) || observation.status !== "valid") return [observation];
    return [{ ...observation, status: "invalid", reason: "The driver returned no recording, so the framework cannot derive this measurement." }];
  }
  frameLogs.checked += 1;
  if (observation.status !== "valid") return [observation];
  if (request.workload === "long-thread-scroll") {
    const scroll = deriveScroll(result.frameLog, observation.clock, scenario.cases.scroll);
    return [scroll.reason ? failed(frameLogs, observation, scroll.reason) : { ...observation, measures: scroll.measures }];
  }
  const mismatch = request.workload === "stream-first-word" ? firstWordMismatch(result.frameLog, observation.clock) : frameLogMismatch(result.frameLog, observation.clock);
  return [mismatch ? failed(frameLogs, observation, mismatch) : observation];
}

/** One observation per key, each timed from its keydown to its paint (or its miss deadline) on the page clock. */
function observeTyping(frameLogs, scenario, action, result) {
  const sequence = normalizeExecution(result, action.request);
  if (sequence.status !== "valid") return action.cases.map((benchmarkCase) => invalidObservation(benchmarkCase, sequence.reason));
  if (result.frameLog === undefined) {
    frameLogs.missing += 1;
    return action.cases.map((benchmarkCase) => invalidObservation(benchmarkCase, "The driver returned no typing recording."));
  }
  frameLogs.checked += 1;
  const typing = deriveTyping(result.frameLog, { keys: action.request.keys, missAfterMs: action.request.missAfterMs });
  if (typing.reason) {
    frameLogs.failed += 1;
    return action.cases.map((benchmarkCase) => invalidObservation(benchmarkCase, `Clock rule ${CLOCK_RULE_ID}: ${typing.reason}.`));
  }
  return action.cases.map((benchmarkCase, index) => {
    const key = typing.keys[index];
    return {
      case: benchmarkCase,
      receivedAt: sequence.receivedAt,
      status: "valid",
      durationMs: key.end - key.start,
      readiness: sequence.readiness,
      clock: { kind: "single-monotonic-clock", clock: sequence.clock.clock, start: key.start, end: key.end },
      measures: { "typing.missed": key.missed ? 1 : 0 },
    };
  });
}

/** Sends after the first must keep the scenario's spacing, on the page clock the observations share. */
export function checkStreamSpacing(observations, scenario) {
  const interval = scenario.cases.streams.startIntervalMs;
  let previous;
  return observations.map((observation) => {
    if (observation.case.workload !== "stream-first-word" || observation.status !== "valid") return observation;
    const gap = previous === undefined ? interval : observation.clock.start - previous;
    previous = observation.clock.start;
    if (gap + 0.5 >= interval) return observation;
    return { ...observation, status: "invalid", reason: `Stream ${observation.case.sample} was sent ${Math.round(gap)} ms after the one before; the scenario spaces sends ${interval} ms apart.` };
  });
}

function failed(frameLogs, observation, reason) {
  frameLogs.failed += 1;
  return { ...observation, status: "invalid", reason: `Clock rule ${CLOCK_RULE_ID}: ${reason}.` };
}

export function invalidObservation(benchmarkCase, error) {
  return { case: benchmarkCase, status: "invalid", reason: publicError(error), receivedAt: new Date().toISOString() };
}

export function publicError(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/\s+stderr:[\s\S]*$/i, "");
  message = message.replace(/\b[A-Za-z]:[\\/][^\s"'`]+/g, "[path]");
  message = message.replace(/(^|[\s("'`=:])\/(?:[^\s/"'`]+\/)*[^\s,"'`;)]*/gm, "$1[path]");
  message = message.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [credential]");
  message = message.replace(/\b(token|secret|password|authorization|api[-_]?key)\s*[=:]\s*[^\s,;}]{8,}/gi, "[credential redacted]");
  return (message.trim() || "Driver operation failed.").slice(0, MAX_PUBLIC_ERROR_LENGTH);
}
