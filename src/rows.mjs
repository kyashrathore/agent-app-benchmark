const MIB = 1024 * 1024;

/** The reason prefix of every observation of a scenario the driver declared it cannot run the same way as other apps. */
export const UNSUPPORTED_PREFIX = "Unsupported: ";

const duration = (observation) => observation.durationMs;
const measure = (id) => (observation) => observation.measures?.[id];

/**
 * The verdict rows an observation of this case belongs to, each with the
 * value it contributes. Workload steps that are validity checks rather than
 * scored measurements belong to none. `test` is how the verdict compares two
 * apps on the row: `rank` for distributions, `fisher` for per-sample misses.
 */
export function verdictRows(kind, benchmarkCase) {
  if (kind === "app-start") {
    return [benchmarkCase.startMode === "new-application-state"
      ? row("start-new", 0, "App start, fresh profile")
      : row("start-initialized", 1, "App start, existing profile")];
  }
  if (kind === "session-switch" && benchmarkCase.workload === "list-walk") {
    const mib = benchmarkCase.nominalBytes / MIB;
    const cold = benchmarkCase.sessionState === "cold";
    return [row(
      `walk-${benchmarkCase.sessionState}-${mib}`,
      20 + (cold ? 0 : 10) + mib / 1024,
      `Next session down the list, ${cold ? "first visit" : "return"}: ${mib} MiB session`,
    )];
  }
  if (kind === "new-thread") return [row("new-thread", 40, "New thread")];
  if (kind === "long-thread" && benchmarkCase.workload === "long-thread-open") return [row("long-thread-open", 50, "Open the 2,000-message thread")];
  if (kind === "long-thread" && benchmarkCase.workload === "long-thread-scroll") {
    return [
      row("long-thread-scroll-long-frames", 51, "Scroll the 2,000-message thread: frames over 33.4 ms", { unit: "frames", read: measure("long-thread.scroll_long_frames") }),
      row("long-thread-scroll-p95-frame", 52, "Scroll the 2,000-message thread: p95 frame interval", { read: measure("long-thread.scroll_p95_frame_ms") }),
    ];
  }
  if (kind === "typing-while-streaming" && benchmarkCase.workload === "stream-first-word") return [row("stream-first-word", 60, "Streaming reply: first word painted")];
  if (kind === "typing-while-streaming" && benchmarkCase.workload === "typing-key") {
    return [
      row("typing-lag", 61, "Typing while replies stream: key to paint"),
      row("typing-missed", 62, "Typing while replies stream: keys not painted within 2 s", { unit: "keys", test: "fisher", read: measure("typing.missed") }),
    ];
  }
  return [];
}

function row(id, order, title, { unit = "ms", test = "rank", read = duration } = {}) {
  return { id, order, title, unit, test, read };
}
