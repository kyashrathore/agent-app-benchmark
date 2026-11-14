import assert from "node:assert/strict";
import test from "node:test";
import { deriveScroll, deriveTyping, firstWordMismatch } from "../src/frame-recordings.mjs";

const SCROLL = { wheelCount: 3, tailMs: 500, longFrameMs: 33.4 };

function scrollLog(frames, overrides = {}) {
  return {
    kind: "scroll",
    startAt: 100,
    endAt: 700,
    offsetMs: 0,
    wheels: [{ at: 100, deltaY: -480 }, { at: 150, deltaY: -480 }, { at: 200, deltaY: -480 }],
    frames,
    scrollTop: { start: 9_000, end: 7_560 },
    ...overrides,
  };
}

test("scroll metrics are re-derived from the frame timestamps: intervals over 33.4 ms and the nearest-rank p95 interval", () => {
  const frames = [100];
  for (let index = 1; index < 40; index += 1) frames.push(frames.at(-1) + (index === 10 || index === 20 ? 50 : 16));
  const derived = deriveScroll(scrollLog(frames), { start: 100, end: 700 }, SCROLL);
  assert.deepEqual(derived.measures, { "long-thread.scroll_long_frames": 2, "long-thread.scroll_p95_frame_ms": 50 });
  assert.equal(deriveScroll(scrollLog([100, 133.25, 166.5, 200.5]), { start: 100, end: 700 }, SCROLL).measures["long-thread.scroll_long_frames"], 1, "two 60 Hz frames are not long; 34 ms is");
});

test("a scroll recording that misses a wheel event, ends early, did not scroll, or disagrees with the clock is rejected", () => {
  const frames = [100, 116, 132];
  const clock = { start: 100, end: 700 };
  assert.match(deriveScroll(scrollLog(frames, { wheels: scrollLog([]).wheels.slice(1), startAt: 150 }), clock, SCROLL).reason, /2 trusted wheel events, not 3/u);
  assert.match(deriveScroll(scrollLog(frames, { endAt: 600 }), { start: 100, end: 600 }, SCROLL).reason, /ends before 500 ms after the last wheel event/u);
  assert.match(deriveScroll(scrollLog(frames, { scrollTop: { start: 9_000, end: 9_000 } }), clock, SCROLL).reason, /did not scroll toward older content/u);
  assert.match(deriveScroll(scrollLog(frames), { start: 100, end: 650 }, SCROLL).reason, /re-derives to 600 ms, the driver reported 550 ms/u);
  assert.match(deriveScroll(scrollLog([100, 90]), clock, SCROLL).reason, /out of order/u);
  assert.match(deriveScroll({ kind: "first-word" }, clock, SCROLL).reason, /not a scroll recording/u);
});

test("the first word stops at the first painted frame after the trusted Enter", () => {
  const log = { kind: "first-word", startAt: 1_000, offsetMs: 0, frames: [{ at: 1_008, painted: false }, { at: 1_350, painted: true }] };
  assert.equal(firstWordMismatch(log, { start: 1_000, end: 1_350 }), null);
  assert.equal(firstWordMismatch(log, { start: 1_000, end: 1_200 }), "the recording re-derives to 350 ms, the driver reported 200 ms");
  assert.equal(firstWordMismatch({ ...log, frames: [{ at: 1_008, painted: false }] }, { start: 1_000, end: 1_008 }), "no frame paints the reply's first word");
});

const KEYS = [{ key: "t" }, { key: "h" }, { key: "e" }];

test("each key's lag runs from its keydown to the first frame holding it; a key painted after 2 s is a miss counted at 2 s", () => {
  const log = {
    kind: "typing",
    offsetMs: 10,
    endAt: 3_000,
    keydowns: [{ key: "t", at: 100 }, { key: "h", at: 350 }, { key: "e", at: 600 }],
    frames: [{ at: 108, typed: 0 }, { at: 116, typed: 1 }, { at: 366, typed: 2 }, { at: 2_700, typed: 3 }, { at: 3_000, typed: 3 }],
  };
  const derived = deriveTyping(log, { keys: KEYS, missAfterMs: 2_000 });
  assert.deepEqual(derived.keys.map((key) => [key.lagMs, key.missed]), [[16, false], [16, false], [2_000, true]]);
  assert.deepEqual([derived.keys[0].start, derived.keys[0].end], [110, 126]);
});

test("a typing recording with a wrong or missing keydown, or one that ends before an unpainted key's deadline, is rejected", () => {
  const base = { kind: "typing", offsetMs: 0, endAt: 900, frames: [{ at: 120, typed: 1 }] };
  assert.match(deriveTyping({ ...base, keydowns: [{ key: "t", at: 100 }] }, { keys: KEYS, missAfterMs: 2_000 }).reason, /1 trusted keydowns, not 3/u);
  assert.match(deriveTyping({ ...base, keydowns: [{ key: "t", at: 100 }, { key: "x", at: 200 }, { key: "e", at: 300 }] }, { keys: KEYS, missAfterMs: 2_000 }).reason, /trusted keydown 1 is "x", not "h"/u);
  assert.match(deriveTyping({ ...base, keydowns: [{ key: "t", at: 100 }, { key: "h", at: 200 }, { key: "e", at: 300 }] }, { keys: KEYS, missAfterMs: 2_000 }).reason, /ends before key 1 was painted or missed/u);
});
