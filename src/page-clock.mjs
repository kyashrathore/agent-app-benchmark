import { deriveSettle, frameReady, READY_GATES, SETTLE_RUN_FRAMES } from "./clock-rule.mjs";

/**
 * The settle-31-frames clock as one in-page observer. A driver arms it before
 * its trusted click with `settleExpression`, evaluates the expression in the
 * renderer, and returns the resolved frames as the observation's frame log.
 * The driver supplies only facts about its app; the gates, the signature, the
 * mutation count and the settle are computed here, with the same `deriveSettle`
 * the framework re-derives every observation with.
 */
export function settleExpression({ facts, target, timeoutMs, start }) {
  if (typeof facts !== "function") throw new Error("settleExpression needs a facts function.");
  if (start !== "trusted-pointerdown" && start !== "now") throw new Error(`Unknown settle start ${start}.`);
  const rule = `const READY_GATES = ${JSON.stringify(READY_GATES)}; const SETTLE_RUN_FRAMES = ${SETTLE_RUN_FRAMES}; ${frameReady.toString()} ${deriveSettle.toString()}`;
  return `(() => { ${rule}; return (${observeSettle.toString()})((${facts.toString()})(${JSON.stringify(target)}), ${JSON.stringify({ timeoutMs, start })}, deriveSettle); })()`;
}

/** The frames a resolved settle was derived from, in the frame-log shape the framework re-checks. */
export function frameLogOf(settle, { startAt = settle.startAt, offsetMs = 0 } = {}) {
  return { startAt, offsetMs, frames: settle.frames.filter((frame) => frame.at > startAt) };
}

/**
 * Serialized into the renderer, so it references nothing outside itself but
 * its arguments and `deriveSettle`.
 *
 * Each frame is sampled in its own rendering step after style and layout,
 * where a ResizeObserver on a 1 px sentinel is delivered, so a sample reads
 * what that frame paints. The sentinel's observer is created in the frame's
 * requestAnimationFrame callback, so it runs after every app observer created
 * earlier. Chromium limits each further observer pass to elements deeper than
 * the shallowest one the previous pass delivered; the sentinel sits 256
 * elements deep so that it is never that element.
 */
function observeSettle(facts, options, settle) {
  return new Promise((resolve, reject) => {
    const sentinel = document.createElement("div");
    sentinel.style.cssText = "width:1px;height:1px";
    let sentinelRoot = sentinel;
    for (let depth = 1; depth < 256; depth += 1) {
      const parent = document.createElement("div");
      parent.append(sentinelRoot);
      sentinelRoot = parent;
    }
    sentinelRoot.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict";
    document.documentElement.append(sentinelRoot);

    let startAt = options.start === "now" ? performance.now() : undefined;
    const onPointerDown = (event) => {
      if (event.isTrusted && startAt === undefined) startAt = performance.now();
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });

    const hashText = (value) => {
      let hash = 2_166_136_261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619) >>> 0;
      }
      return hash;
    };
    const shown = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && bounds.width > 0 && bounds.height > 0;
    };
    const editable = (element) => {
      if (element.getAttribute("aria-disabled") === "true") return false;
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return !element.disabled && !element.readOnly;
      return element.isContentEditable;
    };

    let mutationCount = 0;
    const countMutations = (records) => {
      const transcript = facts.transcript();
      if (!transcript) return;
      for (const record of records) {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        if (element && transcript.contains(element)) mutationCount += 1;
      }
    };
    const mutations = new MutationObserver(countMutations);
    mutations.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    const takeMutations = () => {
      countMutations(mutations.takeRecords());
      const count = mutationCount;
      mutationCount = 0;
      return count;
    };

    let diagnostic = {};
    const sample = () => {
      const composer = facts.composer();
      const gates = {
        displayedDestination: facts.displayed() === true,
        latestTurnPainted: false,
        noPlaceholder: facts.placeholder() !== true,
        firstFoldComplete: false,
        composerEditable: !!composer && shown(composer) && editable(composer),
        windowVisibleFocused: document.visibilityState === "visible" && document.hasFocus(),
      };
      const transcript = facts.transcript();
      diagnostic = { ...gates, transcript: !!transcript };
      if (!transcript) return { gates, signature: null };
      const view = transcript.getBoundingClientRect();
      const visible = (element) => {
        const bounds = element.getBoundingClientRect();
        return shown(element) && bounds.bottom > view.top && bounds.top < view.bottom;
      };
      const mountedRows = facts.rows();
      const visibleRows = mountedRows.filter(visible).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
      const overflowPx = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
      const topGapPx = Math.max(0, (visibleRows[0]?.getBoundingClientRect().top ?? view.bottom) - view.top);
      gates.firstFoldComplete = overflowPx <= 100 || (visibleRows.length > 0 && topGapPx <= 96);
      const latest = facts.latestTurnRows().find((row) => transcript.contains(row) && visible(row) && row.innerText.trim().length > 0);
      gates.latestTurnPainted = !!latest;
      diagnostic = { ...gates, transcript: true, overflowPx, topGapPx, visibleRows: visibleRows.length };
      if (!Object.values(gates).every(Boolean)) return { gates, signature: null };
      const latestText = latest.innerText.trim();
      const signature = JSON.stringify({
        latestTextLength: latestText.length,
        latestTextHash: hashText(latestText),
        scrollTop: Math.round(transcript.scrollTop * 10) / 10,
        scrollHeight: transcript.scrollHeight,
        clientHeight: transcript.clientHeight,
        overflowPx,
        topGapPx,
        opacity: getComputedStyle(transcript).opacity,
        mountedRowCount: mountedRows.length,
        mountedKeysHash: hashText(mountedRows.map((row) => facts.rowKey(row)).join("\n")),
        rows: visibleRows.map((row) => {
          const bounds = row.getBoundingClientRect();
          const text = row.innerText.trim();
          return [facts.rowKey(row), text.length, hashText(text), Math.round(bounds.top * 10) / 10, Math.round(bounds.height * 10) / 10];
        }),
      });
      return { gates, signature };
    };

    const frames = [];
    let stopped = false;
    const finish = (error, value) => {
      stopped = true;
      clearTimeout(guard);
      mutations.disconnect();
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      sentinelRoot.remove();
      if (error) reject(error);
      else resolve(value);
    };
    // Frames stop while the window is hidden or occluded; fail on the wall
    // clock instead of waiting for a frame that never comes.
    const guard = setTimeout(() => {
      finish(new Error(`No settle within ${options.timeoutMs} ms (document ${document.visibilityState}, ${frames.length} frames): ${JSON.stringify(diagnostic)}`));
    }, options.timeoutMs);
    const onFrame = () => {
      if (stopped) return;
      requestAnimationFrame(onFrame);
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        if (stopped) return;
        if (startAt === undefined) {
          takeMutations();
          return;
        }
        let sampled;
        try {
          sampled = sample();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const at = performance.now();
        frames.push({ at, gates: sampled.gates, signature: sampled.signature, mutated: takeMutations() > 0 });
        const settled = settle(frames.slice(-SETTLE_RUN_FRAMES));
        if (settled) finish(undefined, { startAt, settledAt: settled.settledAt, timeOrigin: performance.timeOrigin, frames });
      });
      observer.observe(sentinel);
    };
    requestAnimationFrame(onFrame);
  });
}
