import { average, maximum, percentile, summary } from "./statistics.mjs";

export function summarizeCases(scenario, cases) {
  if (scenario.kind === "app-start") {
    return Object.fromEntries(scenario.cases.startModes.map((startMode) => [
      startMode,
      summary(cases.filter((item) => item.case.startMode === startMode).map((item) => item.durationMs)),
    ]));
  }
  const lanes = {};
  for (const workspaceRelation of scenario.cases.workspaceRelations) {
    for (const sessionState of scenario.cases.sessionStates) {
      const key = `${sessionState}-${workspaceRelation}`;
      const lane = cases.filter((item) => item.case.workspaceRelation === workspaceRelation && item.case.sessionState === sessionState);
      lanes[key] = {
        ...summary(lane.map((item) => item.durationMs)),
        trend: scenario.cases.transcriptBytes.map((transcriptBytes) => ({
          transcriptBytes,
          ...summary(lane.filter((item) => item.case.transcriptBytes === transcriptBytes).map((item) => item.durationMs)),
        })),
      };
    }
  }
  return lanes;
}

export function summarizeResources(samples, windows) {
  const baseline = withinAny(samples, windows.baseline);
  const active = withinAny(samples, windows.active);
  const ending = withinAny(samples, windows.ending);
  const baselineIdleAverage = average(baseline.map((sample) => sample.rssBytes)) / MIB;
  const endingIdleAverage = average(ending.map((sample) => sample.rssBytes)) / MIB;
  return {
    baselineIdleAverageRssMiB: round(baselineIdleAverage),
    activeAverageRssMiB: round(average(active.map((sample) => sample.rssBytes)) / MIB),
    activeMaximumRssMiB: round(maximum(active.map((sample) => sample.rssBytes)) / MIB),
    activeP95RssMiB: round(percentile(active.map((sample) => sample.rssBytes), 95) / MIB),
    endingIdleAverageRssMiB: round(endingIdleAverage),
    retainedRssGrowthMiB: round(endingIdleAverage - baselineIdleAverage),
    trend: windows.cases.map(({ caseId, transcriptBytes, startMs, endMs, switchSequence }) => {
      const values = within(samples, { startMs, endMs });
      return {
        caseId,
        switchSequence,
        transcriptBytes,
        averageRssMiB: round(average(values.map((sample) => sample.rssBytes)) / MIB),
        maximumRssMiB: round(maximum(values.map((sample) => sample.rssBytes)) / MIB),
        p95RssMiB: round(percentile(values.map((sample) => sample.rssBytes), 95) / MIB),
        averageCpuPercent: round(average(values.map((sample) => sample.cpuPercent))),
        maximumCpuPercent: round(maximum(values.map((sample) => sample.cpuPercent)), 95),
        p95CpuPercent: round(percentile(values.map((sample) => sample.cpuPercent), 95)),
      };
    }),
  };
}

const MIB = 1024 * 1024;
const within = (samples, window) => samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
const withinAny = (samples, windows) => samples.filter((sample) => windows.some((window) => sample.atMs >= window.startMs && sample.atMs <= window.endMs));
const round = (value) => Math.round(value * 1000) / 1000;
