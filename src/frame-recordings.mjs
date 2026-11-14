import { percentile, round } from "./statistics.mjs";

const TOLERANCE_MS = 0.5;

/**
 * Re-derives a scroll's frame metrics from its in-page recording: the
 * animation-frame timestamps from the first trusted wheel event to `tailMs`
 * after the last. Returns `{ measures }`, or `{ reason }` when the recording
 * does not support the reported clock or the scroll did not happen.
 */
export function deriveScroll(log, clock, { wheelCount, tailMs, longFrameMs }) {
  if (log?.kind !== "scroll") return { reason: "the frame log is not a scroll recording" };
  const offset = log.offsetMs ?? 0;
  if (![log.startAt, log.endAt, offset].every(Number.isFinite)) return { reason: "the scroll recording has no start, end or clock offset" };
  if (!Array.isArray(log.wheels) || log.wheels.length !== wheelCount) return { reason: `the scroll recording holds ${log.wheels?.length ?? 0} trusted wheel events, not ${wheelCount}` };
  if (log.wheels.some((wheel, index) => !Number.isFinite(wheel.at) || !(wheel.deltaY < 0) || (index > 0 && wheel.at < log.wheels[index - 1].at))) {
    return { reason: "the wheel events are out of order or do not scroll toward older content" };
  }
  if (Math.abs(log.wheels[0].at - log.startAt) > TOLERANCE_MS) return { reason: "the recording does not start at the first wheel event" };
  if (log.endAt + TOLERANCE_MS < log.wheels.at(-1).at + tailMs) return { reason: `the recording ends before ${tailMs} ms after the last wheel event` };
  if (!Array.isArray(log.frames) || log.frames.length < 2) return { reason: "the scroll recording holds fewer than two frames" };
  if (log.frames.some((at, index) => !Number.isFinite(at) || (index > 0 && at < log.frames[index - 1]))) return { reason: "the scroll frames are out of order" };
  if (!(log.scrollTop?.end < log.scrollTop?.start)) return { reason: "the transcript did not scroll toward older content" };
  const clockMismatch = intervalMismatch(log.startAt + offset, log.endAt + offset, clock);
  if (clockMismatch) return { reason: clockMismatch };
  const intervals = log.frames.slice(1).map((at, index) => at - log.frames[index]);
  return {
    measures: {
      "long-thread.scroll_long_frames": intervals.filter((interval) => interval > longFrameMs).length,
      "long-thread.scroll_p95_frame_ms": round(percentile(intervals, 95)),
    },
  };
}

/** Re-derives the first-word clock: from the trusted Enter keydown to the first frame that paints the reply's opening characters. */
export function firstWordMismatch(log, clock) {
  if (log?.kind !== "first-word") return "the frame log is not a first-word recording";
  const offset = log.offsetMs ?? 0;
  if (!Number.isFinite(log.startAt) || !Number.isFinite(offset)) return "the first-word recording has no start time or clock offset";
  if (!Array.isArray(log.frames) || log.frames.length === 0) return "the first-word recording is empty";
  let previous = log.startAt;
  for (const [index, frame] of log.frames.entries()) {
    if (!Number.isFinite(frame.at) || frame.at < previous) return `frame ${index} is earlier than the one before it`;
    if (typeof frame.painted !== "boolean") return `frame ${index} does not report whether the reply is painted`;
    previous = frame.at;
  }
  const painted = log.frames.find((frame) => frame.painted);
  if (!painted) return "no frame paints the reply's first word";
  return intervalMismatch(log.startAt + offset, painted.at + offset, clock);
}

/**
 * Re-derives each key's lag from a typing recording: the trusted keydowns in
 * page time and, per frame, how many of the sequence's keys the composer text
 * holds. A key is painted at the first frame at or after its keydown that
 * holds it; one not painted within `missAfterMs` is a miss, counted at
 * `missAfterMs`. Returns `{ keys }` in sequence order, or `{ reason }`.
 */
export function deriveTyping(log, { keys, missAfterMs }) {
  if (log?.kind !== "typing") return { reason: "the frame log is not a typing recording" };
  const offset = log.offsetMs ?? 0;
  if (!Number.isFinite(offset) || !Number.isFinite(log.endAt)) return { reason: "the typing recording has no end or clock offset" };
  if (!Array.isArray(log.keydowns) || log.keydowns.length !== keys.length) return { reason: `the typing recording holds ${log.keydowns?.length ?? 0} trusted keydowns, not ${keys.length}` };
  for (const [index, keydown] of log.keydowns.entries()) {
    if (keydown.key !== keys[index].key) return { reason: `trusted keydown ${index} is "${keydown.key}", not "${keys[index].key}"` };
    if (!Number.isFinite(keydown.at) || (index > 0 && keydown.at < log.keydowns[index - 1].at)) return { reason: `trusted keydown ${index} is out of order` };
  }
  if (!Array.isArray(log.frames)) return { reason: "the typing recording has no frames" };
  for (const [index, frame] of log.frames.entries()) {
    if (!Number.isFinite(frame.at) || (index > 0 && frame.at < log.frames[index - 1].at)) return { reason: `frame ${index} is earlier than the one before it` };
    if (!Number.isInteger(frame.typed) || frame.typed < 0 || frame.typed > keys.length) return { reason: `frame ${index} does not report how many keys the composer holds` };
  }
  const derived = log.keydowns.map((keydown, index) => {
    const deadline = keydown.at + missAfterMs;
    const painted = log.frames.find((frame) => frame.at >= keydown.at && frame.typed > index);
    const missed = !painted || painted.at > deadline;
    return { start: keydown.at + offset, end: (missed ? deadline : painted.at) + offset, lagMs: missed ? missAfterMs : painted.at - keydown.at, missed };
  });
  const unresolved = derived.findIndex((key, index) => key.missed && log.endAt < log.keydowns[index].at + missAfterMs - TOLERANCE_MS);
  if (unresolved >= 0) return { reason: `the recording ends before key ${unresolved} was painted or missed` };
  return { keys: derived };
}

function intervalMismatch(start, end, clock) {
  if (Math.abs(start - clock.start) > TOLERANCE_MS) return "the clock does not start where the recording does";
  if (Math.abs(end - clock.end) > TOLERANCE_MS) return `the recording re-derives to ${round1(end - start)} ms, the driver reported ${round1(clock.end - clock.start)} ms`;
  return null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
