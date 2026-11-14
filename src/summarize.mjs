import { UNSUPPORTED_PREFIX, verdictRows } from "./rows.mjs";
import { average, maximum, percentile, round, summaryOrUnavailable } from "./statistics.mjs";

/** One summary per verdict row, keyed by row id, in row order. */
export function summarizeObservations(scenario, observations) {
  const rows = new Map();
  for (const observation of observations) {
    for (const row of verdictRows(scenario.kind, observation.case)) {
      const entry = rows.get(row.id) ?? { row, attempted: [] };
      entry.attempted.push(observation);
      rows.set(row.id, entry);
    }
  }
  return Object.fromEntries([...rows.values()].toSorted((left, right) => left.row.order - right.row.order).map(({ row, attempted }) => [row.id, summarizeRow(row, attempted)]));
}

function summarizeRow(row, attempted) {
  const label = { title: row.title, unit: row.unit };
  if (attempted.every((observation) => observation.reason?.startsWith(UNSUPPORTED_PREFIX))) {
    return { ...label, status: "unsupported", valid: 0, attempted: attempted.length, reason: attempted[0].reason.slice(UNSUPPORTED_PREFIX.length) };
  }
  const values = attempted.filter((observation) => observation.status === "valid").map(row.read).filter((value) => Number.isFinite(value) && value >= 0);
  const summary = summaryOrUnavailable(values, attempted.length, "No valid observations.", { includeP50: true });
  if (row.test !== "fisher" || summary.status !== "valid") return { ...label, ...summary };
  return { ...label, ...summary, missed: values.reduce((total, value) => total + value, 0) };
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
const within = (samples, window) => samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
