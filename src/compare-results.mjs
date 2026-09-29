import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readHostConditions, renderHostConditions, summarizeHostConditions } from "./host-conditions.mjs";
import { buildVerdict, renderVerdict } from "./verdict.mjs";

/** A path is a result.json, or a run directory whose scenario folders each hold one. */
export async function readResultFiles(paths) {
  const files = [];
  for (const input of paths) {
    const absolute = path.resolve(input);
    if (!(await stat(absolute)).isDirectory()) {
      files.push(absolute);
      continue;
    }
    const found = [];
    for (const entry of (await readdir(absolute, { withFileTypes: true })).filter((item) => item.isDirectory()).toSorted((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(absolute, entry.name, "result.json");
      if (await stat(candidate).then(() => true, () => false)) found.push(candidate);
    }
    if (found.length === 0) throw new Error(`${input} holds no result.json.`);
    files.push(...found);
  }
  return Promise.all(files.map(async (file) => ({ file, result: JSON.parse(await readFile(file, "utf8")) })));
}

/**
 * Runs are separate processes at separate times, so a verdict only pairs runs
 * on one host of the same scenario, corpus, clock rule and framework, none of
 * which rejected an observation against its frame log. Load is shown, never gated.
 */
export function comparabilityProblems(entries) {
  const problems = [];
  const hosts = new Set(entries.map(({ result }) => hostOf(result)));
  if (hosts.size > 1) problems.push(`runs come from different hosts (${[...hosts].join(" vs ")})`);
  for (const [scenarioId, group] of Map.groupBy(entries, ({ result }) => result.scenario.id)) {
    for (const [label, read] of [
      ["scenario digest", (result) => result.scenario.digestSha256],
      ["corpus digest", (result) => result.corpus.digestSha256],
      ["corpus definition digest", (result) => result.corpus.definitionDigestSha256],
      ["clock rule", clockRuleOf],
      ["framework revision", (result) => result.provenance.frameworkRevision],
    ]) {
      const values = new Set(group.map(({ result }) => read(result)));
      if (values.size === 1) continue;
      problems.push(`${scenarioId}: runs differ in ${label} (${[...values].join(" vs ")})`);
    }
  }
  for (const { file, result } of entries) {
    const failed = result.clockRule?.frameLogs.failed ?? 0;
    if (failed > 0) problems.push(`${file}: ${failed} observation(s) failed the clock-rule conformance check`);
  }
  return problems;
}

export async function renderComparison(entries) {
  const { runs, hostConditions } = await describeRuns(entries);
  const lines = [
    "Runs (apps run separately; load is shown, not gated):",
    ...runs.map((run) => `- ${run.app} ${run.scenario}: ${run.createdAt}, driver ${run.driverDigest}, clock rule ${run.clockRule}, conformance ${run.conformance}, 1-minute load ${run.load}`),
    ...hostConditions.flatMap(({ runDirectory, text }) => ["", `Host conditions for ${runDirectory}:`, text]),
  ];
  const tables = comparisonTables(entries).map(({ title, verdict, names }) => `### ${title}\n\n${renderVerdict(verdict, names)}`);
  return [lines.join("\n"), ...tables].join("\n\n");
}

/** The reference (first) app against every other app, one verdict per pair; refuses runs that are not comparable. */
export function comparisonTables(entries) {
  const problems = comparabilityProblems(entries);
  if (problems.length > 0) throw new Error(`These runs are not comparable:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  const appIds = [...new Set(entries.map(({ result }) => result.app.id))];
  if (appIds.length < 2) throw new Error("A verdict needs runs of at least two apps.");
  const names = Object.fromEntries(entries.map(({ result }) => [result.app.id, result.app.name ?? result.app.id]));
  const [reference, ...others] = appIds;
  return others.map((other) => ({
    title: `${names[reference]} vs ${names[other]}`,
    verdict: buildVerdict(entries.map(({ result }) => result).filter((result) => [reference, other].includes(result.app.id)), { appIds: [reference, other] }),
    names,
  }));
}

/** Each run as the verdict and the site list it, and the host conditions logged beside each run directory. */
export async function describeRuns(entries) {
  const hostByDirectory = new Map();
  const runs = [];
  for (const { file, result } of entries) {
    const runDirectory = path.dirname(path.dirname(file));
    if (!hostByDirectory.has(runDirectory)) hostByDirectory.set(runDirectory, await readHostConditions(runDirectory));
    const records = hostByDirectory.get(runDirectory);
    const load = records ? summarizeHostConditions(records).loadAverage1m : null;
    runs.push({
      appId: result.app.id,
      app: result.app.name ?? result.app.id,
      scenario: result.scenario.id,
      createdAt: result.createdAt,
      driverDigest: result.driver.digestSha256.slice(0, 12),
      clockRule: clockRuleOf(result),
      conformance: conformanceOf(result),
      load: load ? `${load.min}–${load.max}` : `${result.environment.loadAverage1mPerCpu} per CPU at start`,
    });
  }
  const hostConditions = [...hostByDirectory].filter(([, records]) => records)
    .map(([runDirectory, records]) => ({ runDirectory, text: renderHostConditions(summarizeHostConditions(records)) }));
  return { runs, hostConditions };
}

function hostOf({ environment }) {
  return `${environment.platform} ${environment.architecture} ${environment.cpuModel}, ${environment.logicalCpuCount} CPUs, ${Math.round(environment.totalMemoryBytes / 2 ** 30)} GiB`;
}

function clockRuleOf(result) {
  return result.clockRule?.declared ?? "not declared";
}

function conformanceOf(result) {
  const frameLogs = result.clockRule?.frameLogs;
  if (!frameLogs) return "not recorded";
  if (frameLogs.checked === 0) return "not checked (the driver returns no frame logs)";
  return `${frameLogs.checked} checked, ${frameLogs.failed} failed${frameLogs.missing > 0 ? `, ${frameLogs.missing} without a frame log` : ""}`;
}
