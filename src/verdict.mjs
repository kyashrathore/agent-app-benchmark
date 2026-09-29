import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { latencyRow } from "./rows.mjs";
import { p95EqualsSampledMaximum, percentile, round } from "./statistics.mjs";

const BOOTSTRAP_RESAMPLES = 4000;
const SIGNIFICANCE = 0.05;
const MINIMUM_SAMPLES = 4;
const PRACTICAL_RATIO = 1.05;

/**
 * Decide, per metric, whether one application is reliably faster than the
 * other. A latency winner needs both a two-sided Mann-Whitney p below 0.05 and
 * a bootstrap 95% interval of the median ratio that excludes 1. With four
 * samples a side the smallest attainable exact p is 0.029, so fewer samples can
 * never name a winner. RSS samples inside one idle window are autocorrelated
 * readings of one process family, so an RSS winner instead needs the two
 * sample ranges to be disjoint. The applications run one after the other, so
 * host drift can separate them by a few percent; gaps under 5% are reported as
 * within that margin rather than as wins.
 */
/**
 * A partial run passes `expected`: every scheduled latency row with each
 * application's scheduled attempts. A row short of them is reported as
 * incomplete with its counts instead of being scored or left out, and
 * `resourcesPending` does the same for the memory and CPU rows.
 */
export function buildVerdict(results, { appIds, expected, resourcesPending = false } = {}) {
  const [left, right] = appIds ?? [...Map.groupBy(results, (result) => result.app.id).keys()];
  if (!left || !right || left === right) throw new Error("A verdict compares exactly two applications.");
  const rows = [];
  for (const metric of latencyMetrics(results, expected)) {
    rows.push(withExpectedAttempts(compareRanked({ ...metric, unit: "ms" }, left, right), metric.expectedAttempts));
  }
  if (resourcesPending) {
    for (const metric of RESOURCE_METRICS) {
      rows.push({ id: metric.id, title: metric.title, unit: metric.unit, kind: "resource", apps: { [left]: { valid: 0, attempted: 0 }, [right]: { valid: 0, attempted: 0 } }, verdict: "incomplete", reason: "the memory workload has not completed for both applications" });
    }
  } else {
    for (const metric of resourceMetrics(results)) {
      rows.push(metric.test === "rank" ? compareRanked(metric, left, right) : compareResource(metric, left, right));
    }
  }
  return { apps: [left, right], rows };
}

function withExpectedAttempts(row, expectedAttempts) {
  if (!expectedAttempts) return row;
  const apps = Object.fromEntries(Object.entries(row.apps).map(([appId, summary]) => [appId, { ...summary, expected: expectedAttempts.get(appId) ?? 0 }]));
  const short = Object.entries(apps).filter(([, summary]) => summary.attempted < summary.expected);
  if (short.length === 0) return { ...row, apps };
  const { winner, leader, ratio, ratioInterval95, pValue, ...rest } = row;
  const invalid = Object.entries(apps).filter(([, summary]) => summary.valid < summary.attempted);
  return {
    ...rest,
    apps,
    verdict: "incomplete",
    reason: [
      ...short.map(([appId, summary]) => `${appId} n=${summary.attempted} of ${summary.expected}`),
      ...invalid.map(([appId, summary]) => `${appId} has ${summary.attempted - summary.valid} invalid`),
    ].join(", "),
  };
}

function latencyMetrics(results, expected) {
  const metrics = new Map();
  for (const row of expected?.values() ?? []) {
    metrics.set(row.id, { id: row.id, order: row.order, title: row.title, values: new Map(), attempted: new Map(), failures: new Map(), expectedAttempts: row.attempts });
  }
  for (const result of results) {
    for (const observation of result.observations) {
      const key = latencyRow(result.scenario.kind, observation.case);
      if (!key) continue;
      const metric = metrics.get(key.id) ?? { ...key, values: new Map(), attempted: new Map(), failures: new Map() };
      const appId = result.app.id;
      metric.attempted.set(appId, (metric.attempted.get(appId) ?? 0) + 1);
      if (observation.status === "valid") metric.values.set(appId, [...(metric.values.get(appId) ?? []), observation.durationMs]);
      metrics.set(key.id, metric);
    }
  }
  return [...metrics.values()].toSorted((a, b) => a.order - b.order);
}

function compareRanked(metric, left, right) {
  const leftValues = metric.values.get(left) ?? [];
  const rightValues = metric.values.get(right) ?? [];
  const row = {
    id: metric.id,
    title: metric.title,
    unit: metric.unit,
    kind: "ranked",
    apps: {
      [left]: describe(leftValues, metric.attempted.get(left) ?? 0),
      [right]: describe(rightValues, metric.attempted.get(right) ?? 0),
    },
  };
  const failed = [left, right].find((appId) => metric.failures.has(appId));
  if (failed) return { ...row, verdict: "withheld", reason: `${failed}: ${metric.failures.get(failed)}` };
  const incomplete = [left, right].find((appId) => row.apps[appId].valid !== row.apps[appId].attempted || row.apps[appId].valid === 0);
  if (incomplete) return { ...row, verdict: "withheld", reason: `${incomplete} has ${row.apps[incomplete].attempted - row.apps[incomplete].valid} invalid observations` };
  if (leftValues.length < MINIMUM_SAMPLES || rightValues.length < MINIMUM_SAMPLES) {
    return { ...row, verdict: "insufficient", reason: `needs at least ${MINIMUM_SAMPLES} samples per application` };
  }
  const faster = median(leftValues) <= median(rightValues) ? left : right;
  const fasterValues = faster === left ? leftValues : rightValues;
  const slowerValues = faster === left ? rightValues : leftValues;
  const ratio = median(slowerValues) / median(fasterValues);
  const interval = bootstrapMedianRatio(slowerValues, fasterValues, metric.id);
  const pValue = mannWhitneyTwoSided(fasterValues, slowerValues);
  const reliable = pValue < SIGNIFICANCE && interval.low > 1 && ratio >= PRACTICAL_RATIO;
  return {
    ...row,
    verdict: reliable ? "lower" : ratio < PRACTICAL_RATIO ? "within-practical-margin" : "no-reliable-difference",
    winner: reliable ? faster : null,
    leader: faster,
    ratio: round(ratio),
    ratioInterval95: { low: round(interval.low), high: round(interval.high) },
    pValue: round(pValue),
  };
}

function describe(values, attempted) {
  if (values.length === 0) return { valid: 0, attempted };
  return {
    valid: values.length,
    attempted,
    median: round(median(values)),
    p95: round(percentile(values, 95)),
    minimum: round(Math.min(...values)),
    maximum: round(Math.max(...values)),
  };
}

const RESOURCE_METRICS = [
  { id: "rss-after-launch", title: "Memory (RSS) idle after launch", unit: "MiB", windows: ["baseline"], read: rssSeries, test: "disjoint", independentOfWorkload: true },
  { id: "rss-after-workload", title: "Memory (RSS) idle after the switching workload", unit: "MiB", windows: ["ending"], read: rssSeries, test: "disjoint" },
  { id: "cpu-idle", title: "CPU while idle", unit: "%", windows: ["baseline", "ending"], read: cpuSeries, test: "rank" },
];

function resourceMetrics(results) {
  const metrics = RESOURCE_METRICS;
  const withTraces = results.filter((result) => result.resourceTrace);
  if (withTraces.length === 0) return [];
  return metrics.map((metric) => {
    const values = new Map();
    const failures = new Map();
    for (const result of withTraces) {
      if (result.resources?.status !== "valid" && !metric.independentOfWorkload) failures.set(result.app.id, result.resources?.reason ?? "resource run invalid");
      const runs = result.resourceTrace.runs ?? [result.resourceTrace];
      values.set(result.app.id, runs.flatMap((run) => metric.windows.flatMap((windowId) => metric.read(run, run.windows?.[windowId]))));
    }
    return { ...metric, values, attempted: new Map([...values].map(([appId, series]) => [appId, series.length])), failures };
  });
}

function samplesInside(run, window) {
  if (!window || !(window.endMs > window.startMs)) return [];
  return run.samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
}

function rssSeries(run, window) {
  return samplesInside(run, window).map((sample) => sample.rssBytes / (1024 * 1024));
}

function cpuSeries(run, window) {
  const samples = samplesInside(run, window);
  const values = [];
  for (let index = 1; index < samples.length; index += 1) {
    const wallMs = samples[index].atMs - samples[index - 1].atMs;
    if (wallMs <= 0) continue;
    values.push(Math.max(0, samples[index].cumulativeCpuTimeMs - samples[index - 1].cumulativeCpuTimeMs) / wallMs * 100);
  }
  return values;
}

function compareResource(metric, left, right) {
  const leftValues = metric.values.get(left) ?? [];
  const rightValues = metric.values.get(right) ?? [];
  const row = {
    id: metric.id,
    title: metric.title,
    unit: metric.unit,
    kind: "resource",
    apps: {
      [left]: describe(leftValues, leftValues.length),
      [right]: describe(rightValues, rightValues.length),
    },
  };
  const failed = [left, right].find((appId) => metric.failures.has(appId));
  if (failed) return { ...row, verdict: "withheld", reason: `${failed}: ${metric.failures.get(failed)}` };
  if (leftValues.length < MINIMUM_SAMPLES || rightValues.length < MINIMUM_SAMPLES) {
    return { ...row, verdict: "insufficient", reason: `needs at least ${MINIMUM_SAMPLES} samples per application` };
  }
  const lower = median(leftValues) <= median(rightValues) ? left : right;
  const lowerValues = lower === left ? leftValues : rightValues;
  const higherValues = lower === left ? rightValues : leftValues;
  const disjoint = Math.max(...lowerValues) < Math.min(...higherValues);
  const ratio = median(lowerValues) > 0 ? median(higherValues) / median(lowerValues) : null;
  const reliable = disjoint && ratio !== null && ratio >= PRACTICAL_RATIO;
  return {
    ...row,
    verdict: reliable ? "lower" : ratio !== null && ratio < PRACTICAL_RATIO ? "within-practical-margin" : "no-reliable-difference",
    winner: reliable ? lower : null,
    leader: lower,
    ratio: ratio === null ? null : round(ratio),
  };
}

export function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function bootstrapMedianRatio(numerator, denominator, seed) {
  const random = seededRandom(seed);
  const ratios = new Float64Array(BOOTSTRAP_RESAMPLES);
  const resample = (values) => median(Array.from(values, () => values[Math.floor(random() * values.length)]));
  for (let index = 0; index < BOOTSTRAP_RESAMPLES; index += 1) {
    const bottom = resample(denominator);
    ratios[index] = bottom > 0 ? resample(numerator) / bottom : Number.POSITIVE_INFINITY;
  }
  ratios.sort();
  return {
    low: ratios[Math.floor(0.025 * BOOTSTRAP_RESAMPLES)],
    high: ratios[Math.ceil(0.975 * BOOTSTRAP_RESAMPLES) - 1],
  };
}

/**
 * Exact two-sided p from the full permutation distribution of U. Ties take
 * half credit in U, which makes the exact distribution slightly conservative;
 * latency samples are sub-millisecond floats, so ties are rare.
 */
export function mannWhitneyTwoSided(first, second) {
  const m = first.length;
  const n = second.length;
  let u = 0;
  for (const a of first) for (const b of second) u += a < b ? 1 : a === b ? 0.5 : 0;
  const counts = uDistribution(m, n);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const extreme = Math.min(u, m * n - u);
  let tail = 0;
  for (let value = 0; value <= Math.floor(extreme); value += 1) tail += counts[value];
  return Math.min(1, (2 * tail) / total);
}

function uDistribution(m, n) {
  const memo = new Map();
  const frequencies = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (i === 0 || j === 0) {
      result = [1];
    } else {
      const withLargestInFirst = frequencies(i - 1, j).map((count, index) => [index + j, count]);
      const withLargestInSecond = frequencies(i, j - 1).map((count, index) => [index, count]);
      result = new Array(i * j + 1).fill(0);
      for (const [index, count] of [...withLargestInFirst, ...withLargestInSecond]) result[index] += count;
    }
    memo.set(key, result);
    return result;
  };
  return frequencies(m, n);
}

function seededRandom(seed) {
  let state = Number.parseInt(createHash("sha256").update(String(seed)).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderVerdict(verdict, names = {}) {
  const { header, rows } = verdictCells(verdict, names);
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [line(header), `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

/** The verdict table's header and rows as plain text cells, for any renderer. */
export function verdictCells(verdict, names = {}) {
  const [left, right] = verdict.apps;
  const label = (appId) => names[appId] ?? appId;
  const format = (summary, unit) => {
    const of = summary.expected !== undefined && summary.attempted < summary.expected ? ` of ${summary.expected}` : "";
    if (summary.attempted === 0) return `not measured${of ? ` (0${of})` : ""}`;
    if (summary.valid === 0) return `invalid (0/${summary.attempted}${of})`;
    if (unit !== "ms") return formatNumber(summary.median, unit);
    const spread = p95EqualsSampledMaximum(summary.valid)
      ? `max ${formatNumber(summary.maximum, unit)}`
      : `p95 ${formatNumber(summary.p95, unit)}`;
    return `${formatNumber(summary.median, unit)} (${spread}, n=${summary.valid}/${summary.attempted}${of})`;
  };
  const header = ["Metric", `${label(left)} median`, `${label(right)} median`, `${label(left)} ×`, "Verdict"];
  const rows = verdict.rows.map((row) => [
    row.title,
    format(row.apps[left], row.unit),
    format(row.apps[right], row.unit),
    timesText(row, left, right, label),
    verdictText(row, label),
  ]);
  return { header, rows };
}

/**
 * How many times the first app wins on medians alone: the other app's median
 * over the first app's, for time, memory and CPU alike. Display only; the
 * verdict column carries the statistics.
 */
function timesText(row, left, right, label) {
  const ours = row.apps[left];
  const theirs = row.apps[right];
  if (!ours?.valid || !theirs?.valid) return "—";
  if (ours.median === 0 || theirs.median === 0) {
    return `— (${label(left)} ${formatNumber(ours.median, row.unit)}, ${label(right)} ${formatNumber(theirs.median, row.unit)})`;
  }
  const times = theirs.median / ours.median;
  if (times >= 1) return `${times.toFixed(2)}×`;
  return `${times.toFixed(2)}× (${label(right)} ${(ours.median / theirs.median).toFixed(2)}× ${row.unit === "ms" ? "faster" : "lower"})`;
}

function verdictText(row, label) {
  if (["withheld", "insufficient", "incomplete"].includes(row.verdict)) return `${row.verdict}: ${row.reason}`;
  const better = row.unit === "ms" ? "faster" : "lower";
  const detail = row.kind === "ranked"
    ? `${row.ratio}x, 95% CI ${row.ratioInterval95.low}-${row.ratioInterval95.high}x, p${row.pValue < 0.001 ? "<0.001" : `=${row.pValue}`}`
    : `${row.ratio}x, sample ranges ${row.winner ? "disjoint" : "overlap"}`;
  if (row.winner) return `${label(row.winner)} ${better} (${detail})`;
  if (row.verdict === "within-practical-margin") return `tie: within 5% (${detail})`;
  return `no reliable difference (${label(row.leader)} ahead ${detail})`;
}

function formatNumber(value, unit) {
  if (unit === "ms") return value >= 1000 ? `${round(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
  if (unit === "MiB") return `${value.toFixed(0)} MiB`;
  return `${value.toFixed(1)}${unit}`;
}

export async function readComparisonResults(comparisonFile) {
  const manifest = JSON.parse(await readFile(comparisonFile, "utf8"));
  const root = path.dirname(comparisonFile);
  return Promise.all(manifest.results.map(async (entry) => JSON.parse(await readFile(path.resolve(root, entry.path), "utf8"))));
}
