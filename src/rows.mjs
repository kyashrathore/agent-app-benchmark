const MIB = 1024 * 1024;

/**
 * The verdict row a latency observation belongs to, or null for workload steps
 * that are validity checks rather than scored latencies.
 */
export function latencyRow(kind, benchmarkCase) {
  if (kind === "app-start") {
    return benchmarkCase.startMode === "new-application-state"
      ? { id: "start-new", order: 0, title: "App start, fresh profile" }
      : { id: "start-initialized", order: 1, title: "App start, existing profile" };
  }
  if (kind === "session-switch" && benchmarkCase.workload === "list-walk") {
    const mib = benchmarkCase.transcriptBytes / MIB;
    const long = benchmarkCase.rowShape === "long";
    const visit = benchmarkCase.sessionState === "cold" ? "first visit" : "return";
    return {
      id: `walk-${benchmarkCase.sessionState}-${long ? "long-" : ""}${mib}`,
      order: 20 + (benchmarkCase.sessionState === "cold" ? 0 : 10) + (long ? 5 : 0) + mib / 1024,
      title: `Next session down the list, ${visit}: ${long ? `${mib} MiB of long text rows` : `${mib} MiB session`}`,
    };
  }
  return null;
}
