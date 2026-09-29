import { average, maximum, percentile, round, summaryOrUnavailable } from "./statistics.mjs";

export function summarizeObservations(scenario, observations) {
  if (scenario.kind === "app-start") {
    return Object.fromEntries(scenario.cases.startModes.map((startMode) => {
      const attempted = observations.filter((item) => item.case?.startMode === startMode);
      const valid = attempted.filter(isValid).map((item) => item.durationMs);
      return [startMode, summaryOrUnavailable(valid, attempted.length, "No valid observations.")];
    }));
  }
  return summarizeWalk(scenario, observations);
}

/** One summary per list-walk pass and destination shape, keyed like its verdict row. */
function summarizeWalk(scenario, observations) {
  const steps = observations.filter((item) => item.case?.workload === "list-walk");
  const shapes = [...new Map(scenario.cases.walk.sessions.map((session) => [
    `${session.rowShape === "long" ? "long-" : ""}${session.transcriptBytes}`,
    { transcriptBytes: session.transcriptBytes, rowShape: session.rowShape },
  ])).entries()];
  return Object.fromEntries(scenario.cases.walk.passes.flatMap((sessionState) => shapes.map(([key, shape]) => {
    const attempted = steps.filter((item) => item.case.sessionState === sessionState
      && item.case.transcriptBytes === shape.transcriptBytes && item.case.rowShape === shape.rowShape);
    return [`${sessionState}-${key}`, {
      transcriptBytes: shape.transcriptBytes,
      ...(shape.rowShape ? { rowShape: shape.rowShape } : {}),
      ...(attempted.length === 0
        ? { status: "invalid", valid: 0, attempted: 0, reason: "No steps were attempted." }
        : summaryOrUnavailable(attempted.filter(isValid).map((item) => item.durationMs), attempted.length, "No valid observations.")),
    }];
  })));
}

export function summarizeResources(samples, windows, boundaryPoints) {
  if (!windows.valid) return { status: "invalid", reason: windows.reason, rawSampleCount: samples.length, trend: boundaryPoints };
  const baseline = within(samples, windows.baseline);
  const active = within(samples, windows.active);
  const ending = within(samples, windows.ending);
  if (baseline.length === 0 || active.length === 0 || ending.length === 0) {
    return { status: "invalid", reason: "A required resource window contains no samples.", rawSampleCount: samples.length, trend: boundaryPoints };
  }
  const baselineIdleAverage = average(baseline.map((sample) => sample.rssBytes)) / MIB;
  const endingIdleAverage = average(ending.map((sample) => sample.rssBytes)) / MIB;
  return {
    status: "valid",
    scope: "summed application process-family RSS",
    cpuDefinition: PROCESS_FAMILY_CPU_DEFINITION,
    baselineIdleAverageRssMiB: round(baselineIdleAverage),
    activeAverageRssMiB: round(average(active.map((sample) => sample.rssBytes)) / MIB),
    activeMaximumRssMiB: round(maximum(active.map((sample) => sample.rssBytes)) / MIB),
    activeP95RssMiB: round(percentile(active.map((sample) => sample.rssBytes), 95) / MIB),
    endingIdleAverageRssMiB: round(endingIdleAverage),
    retainedRssGrowthMiB: round(endingIdleAverage - baselineIdleAverage),
    rawSampleCount: samples.length,
    trend: boundaryPoints.map((point) => ({
      ...point,
      rssMiB: round(point.rssBytes / MIB),
      cpuPercent: round(point.cpuPercent),
    })),
  };
}

export const PROCESS_FAMILY_CPU_DEFINITION = "sampled cumulative CPU delta for descendants observed inside each boundary, divided by wall time; newborn descendants count from birth and exited descendants through their final sample; 100% equals one logical core";

const MIB = 1024 * 1024;
const isValid = (observation) => observation.status === "valid" && Number.isFinite(observation.durationMs) && observation.durationMs >= 0;
const within = (samples, window) => samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
