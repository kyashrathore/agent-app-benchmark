import assert from "node:assert/strict";
import test from "node:test";
import { deriveScroll, deriveTyping, firstWordMismatch } from "../src/frame-recordings.mjs";
import { firstWordExpression, recordingObservation, scrollExpression, typingExpression } from "../src/page-recorders.mjs";
import { fakeRenderer } from "./support/fake-renderer.mjs";

const transcriptFacts = () => ({ transcript: () => globalThis.__fixture.transcript });
const composerFacts = () => ({ composer: () => globalThis.__fixture.composer });

test("the scroll recorder logs every frame from the first trusted wheel event to the tail after the last, and the framework re-derives it", async () => {
  const renderer = fakeRenderer();
  try {
    const recording = (0, eval)(scrollExpression({ facts: transcriptFacts, target: {}, wheelCount: 2, tailMs: 40, timeoutMs: 60_000 }));
    renderer.frame();
    renderer.fixture.transcript.scrollTop = 900;
    renderer.dispatch("wheel", { isTrusted: false, deltaY: -480 });
    renderer.dispatch("wheel", { isTrusted: true, deltaY: -480 });
    renderer.fixture.transcript.scrollTop = 420;
    renderer.frame();
    renderer.dispatch("wheel", { isTrusted: true, deltaY: -480 });
    for (let index = 0; index < 8; index += 1) renderer.frame();
    const result = await recording;
    assert.equal(result.wheels.length, 2);
    assert.deepEqual(result.scrollTop, { start: 900, end: 420 });
    const observation = recordingObservation(result);
    const derived = deriveScroll(observation.frameLog, observation.clock, { wheelCount: 2, tailMs: 40, longFrameMs: 33.4 });
    assert.equal(derived.reason, undefined);
    assert.equal(derived.measures["long-thread.scroll_long_frames"], 0);
  } finally {
    renderer.restore();
  }
});

test("the first-word recorder starts at the trusted Enter and stops at the first frame painting the text", async () => {
  const renderer = fakeRenderer();
  try {
    const recording = (0, eval)(firstWordExpression({ facts: transcriptFacts, target: {}, text: "Streamed", timeoutMs: 60_000 }));
    renderer.frame();
    renderer.dispatch("keydown", { isTrusted: true, key: "a" });
    renderer.dispatch("keydown", { isTrusted: true, key: "Enter" });
    renderer.frame();
    renderer.fixture.transcript.innerText = "Write the reply.\nStreamed reply";
    renderer.frame();
    const result = await recording;
    assert.deepEqual(result.frames.map((frame) => frame.painted), [false, true]);
    const observation = recordingObservation(result);
    assert.equal(firstWordMismatch(observation.frameLog, observation.clock), null);
  } finally {
    renderer.restore();
  }
});

test("the typing recorder logs trusted keydowns and how much of the sequence each frame's composer holds, until every key is painted", async () => {
  const renderer = fakeRenderer();
  try {
    const recording = (0, eval)(typingExpression({ facts: composerFacts, target: {}, keys: "the", missAfterMs: 2_000, timeoutMs: 60_000 }));
    const composer = renderer.fixture.composer;
    renderer.frame();
    for (const key of "the") {
      renderer.dispatch("keydown", { isTrusted: true, key });
      renderer.frame();
      composer.innerText += key;
      renderer.frame();
    }
    const result = await recording;
    assert.deepEqual(result.keydowns.map((keydown) => keydown.key), ["t", "h", "e"]);
    assert.deepEqual(result.frames.map((frame) => frame.typed), [0, 1, 1, 2, 2, 3]);
    const derived = deriveTyping(result, { keys: [{ key: "t" }, { key: "h" }, { key: "e" }], missAfterMs: 2_000 });
    assert.ok(derived.keys.every((key) => !key.missed && key.lagMs > 0));
    assert.throws(() => typingExpression({ facts: composerFacts, target: {}, keys: "The", missAfterMs: 1, timeoutMs: 1 }), /lowercase letters/u);
  } finally {
    renderer.restore();
  }
});
