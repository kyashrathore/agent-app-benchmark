import { SESSION_LANES } from "./cases.mjs";
import { average, maximum, percentile, round, summaryOrUnavailable } from "./statistics.mjs";

export function summarizeObservations(scenario, observations) {
  if (scenario.kind === "app-start") {
    const honestP95 = scenario.id.endsWith("-v3") ? { minimumP95Samples: 20 } : {};
    return Object.fromEntries(scenario.cases.startModes.map((startMode) => {
      const attempted = observations.filter((item) => item.case?.startMode === startMode);
      const valid = attempted.filter(isValid).map((item) => item.durationMs);
      return [startMode, summaryOrUnavailable(valid, attempted.length, "No valid observations.", honestP95)];
    }));
  }
  const lanes = {};
  const honestP95 = scenario.cases.latencySamplesPerProcess ? { minimumP95Samples: 20 } : {};
  for (const lane of SESSION_LANES) {
    const attempted = observations.filter((item) => item.case?.workspaceRelation === lane.workspaceRelation && item.case?.sessionState === lane.sessionState && item.case?.workload === "isolated-latency");
    const valid = attempted.filter(isValid).map((item) => item.durationMs);
    lanes[lane.id] = {
      ...summaryOrUnavailable(valid, attempted.length, "No valid observations.", honestP95),
      transcriptBytes: scenario.cases.standardTranscriptBytes ?? scenario.cases.transcriptBytes[0],
    };
  }
  const progression = observations.filter((item) => item.case?.workload === (scenario.cases.sizeSamplesPerProcess ? "transcript-size-latency" : "progressive-resource"));
  lanes.transcriptSizeTrend = scenario.cases.transcriptBytes.map((transcriptBytes) => {
    const attempted = progression.filter((item) => item.case.transcriptBytes === transcriptBytes);
    return {
      transcriptBytes,
      ...summaryOrUnavailable(attempted.filter(isValid).map((item) => item.durationMs), attempted.length, "No valid observations.", honestP95),
    };
  });
  return lanes;
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
    cpuDefinition: "sampled cumulative CPU delta for descendants observed inside each boundary, divided by wall time; newborn descendants count from birth and exited descendants through their final sample; 100% equals one logical core",
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

export function summarizeResourceRuns(runs) {
  const baseline = runs.flatMap((run) => within(run.samples, run.windows.baseline));
  const active = runs.flatMap((run) => within(run.samples, run.windows.active));
  const ending = runs.flatMap((run) => within(run.samples, run.windows.ending));
  if (baseline.length === 0 || active.length === 0 || ending.length === 0) {
    return { status: "invalid", reason: "A repeated resource window contains no samples.", rawSampleCount: runs.reduce((total, run) => total + run.samples.length, 0), trend: [] };
  }
  const baselineIdleAverage = average(baseline.map((sample) => sample.rssBytes)) / MIB;
  const endingIdleAverage = average(ending.map((sample) => sample.rssBytes)) / MIB;
  return {
    status: "valid",
    scope: "summed application process-family RSS",
    cpuDefinition: "sampled cumulative CPU delta for descendants observed inside each boundary, divided by wall time; newborn descendants count from birth and exited descendants through their final sample; 100% equals one logical core",
    baselineIdleAverageRssMiB: round(baselineIdleAverage),
    activeAverageRssMiB: round(average(active.map((sample) => sample.rssBytes)) / MIB),
    activeMaximumRssMiB: round(maximum(active.map((sample) => sample.rssBytes)) / MIB),
    activeP95RssMiB: round(percentile(active.map((sample) => sample.rssBytes), 95) / MIB),
    endingIdleAverageRssMiB: round(endingIdleAverage),
    retainedRssGrowthMiB: round(endingIdleAverage - baselineIdleAverage),
    rawSampleCount: runs.reduce((total, run) => total + run.samples.length, 0),
    trend: runs.flatMap((run) => run.boundaryPoints.map((point) => ({
      ...point,
      repetition: run.repetition,
      rssMiB: round(point.rssBytes / MIB),
      cpuPercent: round(point.cpuPercent),
    }))),
  };
}

const MIB = 1024 * 1024;
const isValid = (observation) => observation.status === "valid" && Number.isFinite(observation.durationMs) && observation.durationMs >= 0;
const within = (samples, window) => samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
