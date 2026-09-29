import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export const HOST_CONDITIONS_FILE = "host-conditions.jsonl";
const SAMPLE_INTERVAL_MS = 10_000;
const TOP_PROCESS_COUNT = 5;

/**
 * Records host load, power source, and the busiest processes beside one app's
 * run. It never gates or aborts a run: shared hosts are the expected condition,
 * and apps run separately, so a verdict shows each run's load instead.
 */
export async function startHostConditions(outputRoot, dependencies = {}) {
  const file = path.join(outputRoot, HOST_CONDITIONS_FILE);
  const sample = dependencies.sample ?? (() => sampleHost(dependencies.applicationPaths ?? []));
  const now = dependencies.now ?? (() => new Date());
  let pending = Promise.resolve();
  const write = (record) => {
    pending = pending.then(() => appendFile(file, `${JSON.stringify({ at: now().toISOString(), ...record })}\n`, { mode: 0o600 }));
    return pending;
  };
  const takeSample = () => sample().then(
    (values) => write({ event: "sample", ...values }),
    (error) => write({ event: "sample-failed", reason: String(error?.message ?? error).slice(0, 200) }),
  );
  const record = (event, fields = {}) => write({ event, ...fields }).then(takeSample);
  await record("run-start");
  const timer = setInterval(takeSample, dependencies.intervalMs ?? SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    file,
    step: (fields) => record("step-start", fields),
    stop: async (fields = {}) => {
      clearInterval(timer);
      await record("run-end", fields);
      await pending;
    },
  };
}

/**
 * `applicationPaths` are the executables the comparison launches. Electron and
 * other GUI apps may reparent their helpers away from the driver, so a process
 * running from inside an application's bundle counts as the benchmark's own
 * even when it has left this process tree.
 */
export async function sampleHost(applicationPaths = []) {
  const [power, processes] = await Promise.all([powerSource(), busiestProcesses(applicationPaths.map(bundleRoot))]);
  return { loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100), power, topProcesses: processes };
}

async function powerSource() {
  if (process.platform !== "darwin") return { source: "unknown" };
  try {
    const { stdout } = await execute("pmset", ["-g", "batt"], { encoding: "utf8" });
    const source = stdout.includes("'AC Power'") ? "ac" : stdout.includes("'Battery Power'") ? "battery" : "unknown";
    const percent = stdout.match(/(\d+)%/u)?.[1];
    return { source, ...(percent ? { batteryPercent: Number(percent) } : {}) };
  } catch {
    return { source: "unknown" };
  }
}

export function bundleRoot(executable) {
  const bundle = executable.match(/^(.*?\.app)\//u)?.[1];
  return `${bundle ?? path.dirname(executable)}/`;
}

async function busiestProcesses(applicationRoots) {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,%cpu=,comm="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return rankProcesses(stdout, applicationRoots, process.pid);
}

export function rankProcesses(psOutput, applicationRoots, benchmarkPid) {
  const rows = psOutput.trim().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/u);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), executable: match[4] }] : [];
  });
  const owned = new Set([benchmarkPid, ...rows.filter((row) => applicationRoots.some((root) => row.executable.startsWith(root))).map((row) => row.pid)]);
  for (let grown = true; grown;) {
    grown = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        grown = true;
      }
    }
  }
  return rows
    .toSorted((left, right) => right.cpu - left.cpu)
    .slice(0, TOP_PROCESS_COUNT)
    .map(({ pid, cpu, executable }) => ({ command: path.basename(executable), cpu, benchmark: owned.has(pid) }));
}

export async function readHostConditions(runDirectory) {
  let text;
  try {
    text = await readFile(path.join(runDirectory, HOST_CONDITIONS_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function summarizeHostConditions(records) {
  const samples = records.filter((record) => record.event === "sample");
  const load = samples.map((sample) => sample.loadAverage[0]).toSorted((left, right) => left - right);
  const external = new Map();
  for (const sample of samples) {
    for (const entry of sample.topProcesses.filter((item) => !item.benchmark)) {
      external.set(entry.command, Math.max(external.get(entry.command) ?? 0, entry.cpu));
    }
  }
  const start = records.find((record) => record.event === "run-start");
  const end = records.find((record) => record.event === "run-end");
  const last = end ?? records.at(-1);
  const boundaries = records.filter((record) => record.event === "step-start" || record.event === "run-end");
  const steps = boundaries.flatMap((step, index) => step.event === "step-start"
    ? [{ scenarioId: step.scenarioId, wallClockMs: Date.parse((boundaries[index + 1] ?? last).at) - Date.parse(step.at), completed: Boolean(boundaries[index + 1]) }]
    : []);
  return {
    wallClockMs: start ? Date.parse(last.at) - Date.parse(start.at) : null,
    completed: Boolean(end),
    steps,
    samples: samples.length,
    loadAverage1m: load.length === 0 ? null : { min: load[0], median: load[Math.floor(load.length / 2)], max: load.at(-1) },
    power: [...new Set(samples.map((sample) => sample.power.source))],
    busiestExternalProcesses: [...external].toSorted((left, right) => right[1] - left[1]).slice(0, TOP_PROCESS_COUNT).map(([command, cpu]) => ({ command, peakCpu: cpu })),
  };
}

export function renderHostConditions(summary) {
  const seconds = summary.wallClockMs === null ? null : Math.round(summary.wallClockMs / 1000);
  const minutes = seconds === null ? "unknown" : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const load = summary.loadAverage1m ? `${summary.loadAverage1m.min}–${summary.loadAverage1m.max} (median ${summary.loadAverage1m.median})` : "unknown";
  const busiest = summary.busiestExternalProcesses.map((entry) => `${entry.command} ${entry.peakCpu}%`).join(", ") || "none sampled";
  return [
    `wall clock ${minutes}${summary.completed ? "" : " (interrupted)"}; ${summary.samples} samples`,
    `1-minute load average ${load}`,
    `power ${summary.power.join(", ") || "unknown"}`,
    `busiest processes outside the benchmark (peak CPU) ${busiest}`,
    ...summary.steps.map((step) => `${step.scenarioId}: ${Math.round(step.wallClockMs / 1000)} s${step.completed ? "" : " (interrupted)"}`),
  ].join("\n");
}
