import assert from "node:assert/strict";
import test from "node:test";
import { deriveSettle, frameLogMismatch, SETTLE_RUN_FRAMES } from "../src/clock-rule.mjs";
import { frameLogOf, settleExpression } from "../src/page-clock.mjs";
import { fakeRenderer } from "./support/fake-renderer.mjs";

const facts = () => ({
  displayed: () => globalThis.__fixture.displayed,
  latestTurnRows: () => [globalThis.__fixture.rows[1]],
  composer: () => globalThis.__fixture.composer,
  placeholder: () => globalThis.__fixture.placeholder,
  transcript: () => globalThis.__fixture.transcript,
  rows: () => globalThis.__fixture.rows,
  rowKey: (row) => row.key,
});

test("the page clock starts at the trusted pointerdown and settles where the framework re-derives it", async () => {
  const renderer = fakeRenderer();
  try {
    const settling = (0, eval)(settleExpression({ facts, target: { sessionId: "s" }, timeoutMs: 60_000, start: "trusted-pointerdown" }));
    renderer.frame();
    renderer.frame();
    renderer.pointerdown();
    for (let index = 0; index < 3; index += 1) renderer.frame();
    renderer.fixture.displayed = true;
    for (let index = 0; index < 5; index += 1) renderer.frame();
    renderer.mutate();
    renderer.frame();
    for (let index = 0; index < SETTLE_RUN_FRAMES; index += 1) renderer.frame();
    const settle = await settling;
    assert.equal(settle.frames.length, 3 + 5 + 1 + SETTLE_RUN_FRAMES - 1);
    assert.equal(settle.frames[0].gates.displayedDestination, false);
    assert.equal(settle.frames[0].signature, null);
    assert.equal(settle.settledAt, settle.frames[8].at);
    assert.equal(settle.settledAt, deriveSettle(settle.frames).settledAt);
    assert.equal(frameLogMismatch(frameLogOf(settle), { start: settle.startAt, end: settle.settledAt }), null);
  } finally {
    renderer.restore();
  }
});

test("a fact that throws rejects the settle instead of leaving it pending", async () => {
  const renderer = fakeRenderer();
  try {
    const throwing = () => ({
      displayed: () => {
        throw new Error("no session root");
      },
      latestTurnRows: () => [],
      composer: () => null,
      placeholder: () => false,
      transcript: () => null,
      rows: () => [],
      rowKey: () => "",
    });
    const settling = (0, eval)(settleExpression({ facts: throwing, target: {}, timeoutMs: 60_000, start: "now" }));
    renderer.frame();
    await assert.rejects(settling, /no session root/u);
  } finally {
    renderer.restore();
  }
});

test("a settle without frames fails at its timeout and names the gates it last saw", async () => {
  const renderer = fakeRenderer();
  try {
    await assert.rejects((0, eval)(settleExpression({ facts, target: {}, timeoutMs: 20, start: "now" })), /No settle within 20 ms \(document visible, 0 frames\)/u);
  } finally {
    renderer.restore();
  }
});

test("a frame log keeps only frames after its start and carries the offset", () => {
  const frame = (at) => ({ at, gates: {}, signature: null, mutated: false });
  assert.deepEqual(frameLogOf({ startAt: 5, frames: [frame(4), frame(6)] }, { offsetMs: 3 }), { startAt: 5, offsetMs: 3, frames: [frame(6)] });
  assert.deepEqual(frameLogOf({ startAt: 5, frames: [frame(4), frame(6)] }, { startAt: 3 }).frames, [frame(4), frame(6)]);
});

test("an expression needs a facts function and a known start", () => {
  assert.throws(() => settleExpression({ facts: {}, target: {}, timeoutMs: 1, start: "now" }), /facts function/u);
  assert.throws(() => settleExpression({ facts, target: {}, timeoutMs: 1, start: "click" }), /Unknown settle start/u);
});

test("an empty destination settles once the new thread is shown with no transcript row mounted", async () => {
  const renderer = fakeRenderer();
  try {
    const settling = (0, eval)(settleExpression({ facts, target: {}, timeoutMs: 60_000, start: "trusted-pointerdown", destination: "empty" }));
    renderer.pointerdown();
    renderer.fixture.displayed = true;
    for (let index = 0; index < 3; index += 1) renderer.frame();
    renderer.fixture.rows = [];
    for (let index = 0; index < SETTLE_RUN_FRAMES; index += 1) renderer.frame();
    const settle = await settling;
    assert.deepEqual(settle.frames.slice(0, 3).map((frame) => frame.gates.latestTurnPainted), [false, false, false]);
    assert.equal(settle.settledAt, settle.frames[3].at);
    assert.equal(frameLogMismatch(frameLogOf(settle), { start: settle.startAt, end: settle.settledAt }), null);
    assert.throws(() => settleExpression({ facts, target: {}, timeoutMs: 1, start: "now", destination: "list" }), /Unknown settle destination/u);
  } finally {
    renderer.restore();
  }
});
