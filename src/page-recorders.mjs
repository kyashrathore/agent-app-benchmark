import { afterLayoutEachFrame } from "./page-clock.mjs";

/**
 * Renderer expressions for the measurements that are not a settle. Each is
 * armed before the driver's first trusted input, resolves to a recording the
 * driver returns unchanged as the observation's `frameLog`, and is re-derived
 * by the framework. `facts` is serialized into the page with `target` as its
 * argument, so it may use nothing but browser globals and that argument.
 */

/**
 * Logs the timestamp of every animation frame from the first trusted wheel
 * event to `tailMs` after the `wheelCount`-th, with each wheel event and the
 * transcript's scrollTop before and after. Facts: `transcript()`, the
 * scroller the wheel events land on.
 */
export function scrollExpression({ facts, target, wheelCount, tailMs, timeoutMs }) {
  return serialize(recordScroll, facts, target, { wheelCount, tailMs, timeoutMs });
}

/**
 * Starts at the first trusted Enter keydown and samples each frame after
 * style and layout until one paints `text` in the transcript. Facts:
 * `transcript()`, the new thread's transcript.
 */
export function firstWordExpression({ facts, target, text, timeoutMs }) {
  return serialize(recordFirstWord, facts, target, { text, timeoutMs });
}

/**
 * Logs every trusted keydown and, each frame after style and layout, how
 * many of `keys` (in order) the composer text holds, until every key is
 * painted or `missAfterMs` has passed since the last keydown. Facts:
 * `composer()`, the new thread's composer, empty when armed.
 */
export function typingExpression({ facts, target, keys, missAfterMs, timeoutMs }) {
  if (!/^[a-z]+$/u.test(keys)) throw new Error("typingExpression needs a sequence of lowercase letters.");
  return serialize(recordTyping, facts, target, { keys, missAfterMs, timeoutMs });
}

function serialize(recorder, facts, target, options) {
  if (typeof facts !== "function") throw new Error(`${recorder.name} needs a facts function.`);
  return `(() => (${recorder.toString()})((${facts.toString()})(${JSON.stringify(target)}), ${JSON.stringify(options)}, ${afterLayoutEachFrame.toString()}))()`;
}

function recordScroll(facts, options) {
  return new Promise((resolve, reject) => {
    const wheels = [];
    const frames = [];
    let scrollTopStart;
    let stopped = false;
    const finish = (error, value) => {
      stopped = true;
      clearTimeout(guard);
      window.removeEventListener("wheel", onWheel, { capture: true });
      if (error) reject(error);
      else resolve(value);
    };
    const onWheel = (event) => {
      if (!event.isTrusted || wheels.length === options.wheelCount) return;
      if (wheels.length === 0) scrollTopStart = facts.transcript()?.scrollTop;
      wheels.push({ at: performance.now(), deltaY: event.deltaY });
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    const guard = setTimeout(() => finish(new Error(`No scroll recording within ${options.timeoutMs} ms (${wheels.length} trusted wheel events, ${frames.length} frames).`)), options.timeoutMs);
    const onFrame = (timestamp) => {
      if (stopped) return;
      requestAnimationFrame(onFrame);
      if (wheels.length === 0) return;
      frames.push(timestamp);
      const now = performance.now();
      if (wheels.length === options.wheelCount && now >= wheels.at(-1).at + options.tailMs) {
        finish(undefined, { kind: "scroll", startAt: wheels[0].at, endAt: now, wheels, frames, scrollTop: { start: scrollTopStart, end: facts.transcript()?.scrollTop } });
      }
    };
    requestAnimationFrame(onFrame);
  });
}

function recordFirstWord(facts, options, afterLayoutEachFrame) {
  return new Promise((resolve, reject) => {
    let startAt;
    const frames = [];
    let stopSampling = () => {};
    const onKeyDown = (event) => {
      if (event.isTrusted && event.key === "Enter" && startAt === undefined) startAt = performance.now();
    };
    const finish = (error, value) => {
      stopSampling();
      clearTimeout(guard);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      if (error) reject(error);
      else resolve(value);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    const guard = setTimeout(() => finish(new Error(`No first word within ${options.timeoutMs} ms (${startAt === undefined ? "no trusted Enter" : `${frames.length} frames`}).`)), options.timeoutMs);
    stopSampling = afterLayoutEachFrame(() => {
      if (startAt === undefined) return;
      let painted;
      try {
        painted = (facts.transcript()?.innerText ?? "").includes(options.text);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      frames.push({ at: performance.now(), painted });
      if (painted) finish(undefined, { kind: "first-word", startAt, frames });
    });
  });
}

function recordTyping(facts, options, afterLayoutEachFrame) {
  return new Promise((resolve, reject) => {
    const keydowns = [];
    const frames = [];
    let stopSampling = () => {};
    const onKeyDown = (event) => {
      if (event.isTrusted && keydowns.length < options.keys.length) keydowns.push({ key: event.key, at: performance.now() });
    };
    const finish = (error, value) => {
      stopSampling();
      clearTimeout(guard);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      if (error) reject(error);
      else resolve(value);
    };
    const text = (element) => (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.innerText);
    const typed = (value) => {
      let low = 0;
      let high = options.keys.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (value.includes(options.keys.slice(0, middle))) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    const guard = setTimeout(() => finish(new Error(`No typing recording within ${options.timeoutMs} ms (${keydowns.length} trusted keydowns, ${frames.length} frames).`)), options.timeoutMs);
    stopSampling = afterLayoutEachFrame(() => {
      if (keydowns.length === 0) return;
      let count;
      try {
        const composer = facts.composer();
        count = composer ? typed(text(composer)) : 0;
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const at = performance.now();
      frames.push({ at, typed: count });
      const done = keydowns.length === options.keys.length && (count === options.keys.length || at >= keydowns.at(-1).at + options.missAfterMs);
      if (done) finish(undefined, { kind: "typing", endAt: at, keydowns, frames });
    });
  });
}

/**
 * The clock, duration and frame log a driver returns for a resolved
 * recording: from the first trusted input to the recording's end (the last
 * frame for a first word). `offsetMs` maps the page clock onto the driver's.
 */
export function recordingObservation(recording, { clock = "renderer-performance", offsetMs = 0 } = {}) {
  const start = recording.kind === "typing" ? recording.keydowns[0].at : recording.startAt;
  const end = recording.kind === "first-word" ? recording.frames.at(-1).at : recording.endAt;
  return {
    durationMs: end - start,
    clock: { kind: "single-monotonic-clock", clock, start: start + offsetMs, end: end + offsetMs },
    frameLog: { ...recording, offsetMs },
  };
}
