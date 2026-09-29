/** Every driver implements this rule; a result records the id its driver declared. */
export const CLOCK_RULE_ID = "settle-31-frames";

/** A frame is ready only when every gate holds on that frame. */
export const READY_GATES = Object.freeze([
  "displayedDestination",
  "latestTurnPainted",
  "noPlaceholder",
  "firstFoldComplete",
  "composerEditable",
  "windowVisibleFocused",
]);

/** The settle run is this many consecutive ready frames: the settle frame plus 30 confirming frames. */
export const SETTLE_RUN_FRAMES = 31;

const TOLERANCE_MS = 0.5;

/**
 * The first frame of the first run of SETTLE_RUN_FRAMES consecutive ready
 * frames with one signature and no transcript mutation. A mutation reported on
 * a frame restarts the run at that frame, even when the signature repeats.
 */
export function deriveSettle(frames) {
  let run;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frameReady(frame)) {
      run = undefined;
      continue;
    }
    if (!run || frame.mutated || frame.signature !== run.signature) run = { startIndex: index, signature: frame.signature };
    if (index - run.startIndex + 1 === SETTLE_RUN_FRAMES) return { settleIndex: run.startIndex, settledAt: frames[run.startIndex].at, confirmedIndex: index };
  }
  return undefined;
}

export function frameReady(frame) {
  return READY_GATES.every((gate) => frame.gates?.[gate] === true) && typeof frame.signature === "string";
}

/**
 * Re-derives an observation's clock from its driver's frame log. `startAt` is
 * the clock's start in the log's clock: the trusted pointerdown for a switch,
 * the process spawn for app start. `offsetMs` maps the log's clock onto the
 * observation's clock (zero when both are the renderer's).
 * Returns the reason the log does not support the reported clock, or null.
 */
export function frameLogMismatch(frameLog, clock) {
  if (!frameLog || !Array.isArray(frameLog.frames) || frameLog.frames.length === 0) return "the frame log is empty";
  const offset = frameLog.offsetMs ?? 0;
  if (!Number.isFinite(offset) || !Number.isFinite(frameLog.startAt)) return "the frame log has no start time or clock offset";
  // Two animation-frame callbacks can run back to back and read one coarsened
  // performance.now(), so frames need only keep their order, not differ.
  let previous = frameLog.startAt;
  for (const [index, frame] of frameLog.frames.entries()) {
    if (!Number.isFinite(frame.at) || frame.at < previous) return `frame ${index} is earlier than the one before it`;
    if (!frame.gates || READY_GATES.some((gate) => typeof frame.gates[gate] !== "boolean")) return `frame ${index} does not report every ready gate`;
    if (typeof frame.mutated !== "boolean") return `frame ${index} does not report transcript mutation`;
    previous = frame.at;
  }
  if (Math.abs(frameLog.startAt + offset - clock.start) > TOLERANCE_MS) return "the clock does not start where the frame log does";
  const settle = deriveSettle(frameLog.frames);
  if (!settle) return `no run of ${SETTLE_RUN_FRAMES} unchanged ready frames`;
  if (Math.abs(settle.settledAt + offset - clock.end) > TOLERANCE_MS) {
    return `the settle re-derives to ${round(settle.settledAt + offset - clock.start)} ms, the driver reported ${round(clock.end - clock.start)} ms`;
  }
  return null;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
