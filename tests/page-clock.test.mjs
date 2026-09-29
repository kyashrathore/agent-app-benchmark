import assert from "node:assert/strict";
import test from "node:test";
import { deriveSettle, frameLogMismatch, SETTLE_RUN_FRAMES } from "../src/clock-rule.mjs";
import { frameLogOf, settleExpression } from "../src/page-clock.mjs";

function element({ top = 0, height = 20, text = "", key = "", editable = false } = {}) {
  return {
    style: {},
    key,
    top,
    height,
    innerText: text,
    isContentEditable: editable,
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 400,
    children: [],
    append(child) {
      this.children.push(child);
    },
    remove() {},
    contains(other) {
      return other === this || this.children.includes(other);
    },
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { top: this.top, bottom: this.top + this.height, width: 100, height: this.height };
    },
  };
}

/** A renderer stand-in: frames advance only when the test steps them. */
function fakeRenderer() {
  const saved = new Map();
  const replace = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let now = 1_000;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  let animationFrames = [];
  let resizeObservers = [];
  let pendingMutations = [];
  const listeners = new Set();
  const transcript = element({ height: 400 });
  const rows = [element({ top: 10, text: "question", key: "user" }), element({ top: 40, text: "answer", key: "assistant" })];
  for (const row of rows) transcript.append(row);
  const fixture = { displayed: false, transcript, rows, composer: element({ editable: true }), placeholder: false };
  replace("__fixture", fixture);
  replace("document", {
    visibilityState: "visible",
    hasFocus: () => true,
    createElement: () => element(),
    documentElement: element(),
  });
  replace("window", {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  });
  replace("getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
  replace("requestAnimationFrame", (callback) => animationFrames.push(callback));
  replace("ResizeObserver", class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      resizeObservers.push(this);
    }
    disconnect() {}
  });
  replace("MutationObserver", class {
    observe() {}
    takeRecords() {
      return pendingMutations.splice(0);
    }
    disconnect() {}
  });
  replace("HTMLTextAreaElement", class {});
  replace("HTMLInputElement", class {});
  replace("Element", Object);
  return {
    fixture,
    frame() {
      now += 8;
      const callbacks = animationFrames;
      animationFrames = [];
      for (const callback of callbacks) callback(now);
      const observers = resizeObservers;
      resizeObservers = [];
      now += 0.5;
      for (const observer of observers) observer.callback();
    },
    pointerdown() {
      now += 1;
      for (const listener of listeners) listener({ isTrusted: true });
    },
    mutate() {
      pendingMutations.push({ target: fixture.rows[1] });
    },
    restore() {
      delete performance.now;
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

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
