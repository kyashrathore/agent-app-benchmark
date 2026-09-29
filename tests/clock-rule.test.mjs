import assert from "node:assert/strict";
import test from "node:test";
import { READY_GATES, SETTLE_RUN_FRAMES, deriveSettle, frameLogMismatch } from "../src/clock-rule.mjs";

const allGates = Object.fromEntries(READY_GATES.map((gate) => [gate, true]));

/** One character per frame: "." not ready, a letter a ready frame with that signature, "!" a mutation with signature "a". */
function frames(spec, { startAt = 100, stepMs = 8, gates = allGates } = {}) {
  return [...spec].map((code, index) => ({
    at: startAt + index * stepMs,
    gates: code === "." ? { ...gates, latestTurnPainted: false } : gates,
    signature: code === "." ? null : code === "!" ? "a" : code,
    mutated: code === "!",
  }));
}

test("settles at the first frame of the first 31-frame unchanged ready run", () => {
  const settle = deriveSettle(frames(`..${"a".repeat(SETTLE_RUN_FRAMES)}`));
  assert.deepEqual(settle, { settleIndex: 2, settledAt: 116, confirmedIndex: 32 });
});

test("a signature change or a transcript mutation restarts the run", () => {
  assert.equal(deriveSettle(frames(`${"a".repeat(20)}b${"a".repeat(20)}`)), undefined);
  assert.equal(deriveSettle(frames(`${"a".repeat(20)}!${"a".repeat(29)}`)), undefined);
  assert.equal(deriveSettle(frames(`${"a".repeat(20)}!${"a".repeat(30)}`)).settleIndex, 20);
});

test("a frame is not ready unless every gate holds", () => {
  const unfocused = { ...allGates, windowVisibleFocused: false };
  assert.equal(deriveSettle(frames("a".repeat(40), { gates: unfocused })), undefined);
});

test("a frame log that re-derives the reported clock passes", () => {
  const log = { startAt: 90, frames: frames(`..${"a".repeat(31)}`) };
  assert.equal(frameLogMismatch(log, { start: 90, end: 116 }), null);
});

test("app start maps the renderer log onto the spawn clock by its offset", () => {
  const log = { startAt: 90, offsetMs: 1_000, frames: frames(`.${"a".repeat(31)}`) };
  assert.equal(frameLogMismatch(log, { start: 1_090, end: 1_108 }), null);
});

test("a driver that stops the clock before the settle is rejected with both durations", () => {
  const log = { startAt: 90, frames: frames(`..${"a".repeat(31)}`) };
  assert.equal(frameLogMismatch(log, { start: 90, end: 100 }), "the settle re-derives to 26 ms, the driver reported 10 ms");
});

test("two frames read at one coarsened timestamp keep the log valid", () => {
  const sameTime = frames(`..${"a".repeat(31)}`);
  sameTime[5].at = sameTime[4].at;
  assert.equal(frameLogMismatch({ startAt: 90, frames: sameTime }, { start: 90, end: 116 }), null);
});

test("a log without a complete run, a gate, or ordered frames is rejected", () => {
  assert.equal(frameLogMismatch({ startAt: 90, frames: frames("a".repeat(30)) }, { start: 90, end: 100 }), "no run of 31 unchanged ready frames");
  const missingGate = frames("a".repeat(31)).map(({ gates, ...frame }) => ({ ...frame, gates: { ...gates, composerEditable: undefined } }));
  assert.equal(frameLogMismatch({ startAt: 90, frames: missingGate }, { start: 90, end: 100 }), "frame 0 does not report every ready gate");
  const unordered = frames("aa");
  unordered[1].at = unordered[0].at - 1;
  assert.equal(frameLogMismatch({ startAt: 90, frames: unordered }, { start: 90, end: 100 }), "frame 1 is earlier than the one before it");
  assert.equal(frameLogMismatch({ startAt: 95, frames: frames("a".repeat(31)) }, { start: 90, end: 100 }), "the clock does not start where the frame log does");
});
