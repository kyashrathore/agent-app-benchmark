import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundleRoot, HOST_CONDITIONS_FILE, rankProcesses, readHostConditions, renderHostConditions, sampleHost, startHostConditions, summarizeHostConditions } from "../src/host-conditions.mjs";

test("host conditions record each scenario and summarize load, power, and outside processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-host-"));
  try {
    const loads = [2, 9, 5, 4];
    let tick = 0;
    const monitor = await startHostConditions(root, {
      intervalMs: 60_000,
      now: () => new Date(Date.UTC(2026, 8, 26, 0, 0, tick++ * 30)),
      sample: async () => ({
        loadAverage: [loads.shift() ?? 1, 1, 1],
        power: { source: "ac" },
        topProcesses: [{ command: "Claxedo", cpu: 90, benchmark: true }, { command: "spindump", cpu: 40 + tick, benchmark: false }],
      }),
    });
    await monitor.step({ scenarioId: "app-start" });
    await monitor.step({ scenarioId: "session-switch-walk" });
    await monitor.stop();
    const records = await readHostConditions(root);
    assert.deepEqual(records.map((record) => record.event), ["run-start", "sample", "step-start", "sample", "step-start", "sample", "run-end", "sample"]);
    const summary = summarizeHostConditions(records);
    assert.equal(summary.wallClockMs, 180_000);
    assert.deepEqual(summary.steps.map((step) => [step.scenarioId, step.wallClockMs]), [["app-start", 60_000], ["session-switch-walk", 60_000]]);
    assert.deepEqual(summary.loadAverage1m, { min: 2, median: 5, max: 9 });
    assert.deepEqual(summary.power, ["ac"]);
    assert.deepEqual(summary.busiestExternalProcesses.map((entry) => entry.command), ["spindump"]);
    assert.match(renderHostConditions(summary), /^wall clock 3m 0s; 4 samples$/mu);
    assert.match(renderHostConditions(summary), /^session-switch-walk: 60 s$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run cut off before its end marks the last scenario interrupted", () => {
  const at = (seconds) => new Date(Date.UTC(2026, 8, 26, 0, 0, seconds)).toISOString();
  const summary = summarizeHostConditions([
    { at: at(0), event: "run-start" },
    { at: at(0), event: "step-start", scenarioId: "app-start" },
    { at: at(30), event: "step-start", scenarioId: "session-switch-walk" },
    { at: at(40), event: "sample", loadAverage: [3, 3, 3], power: { source: "ac" }, topProcesses: [] },
  ]);
  assert.equal(summary.wallClockMs, 40_000);
  assert.deepEqual(summary.steps.map((step) => [step.scenarioId, step.wallClockMs / 1000, step.completed]), [["app-start", 30, true], ["session-switch-walk", 10, false]]);
  assert.match(renderHostConditions(summary), /wall clock 0m 40s \(interrupted\)/u);
});

test("a failing host sample is recorded and never stops the run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-host-"));
  try {
    const monitor = await startHostConditions(root, { intervalMs: 60_000, sample: async () => { throw new Error("ps unavailable"); } });
    await monitor.stop();
    const text = await readFile(path.join(root, HOST_CONDITIONS_FILE), "utf8");
    assert.match(text, /"event":"sample-failed","reason":"ps unavailable"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live host sample names this process tree as the benchmark's own", async () => {
  const sample = await sampleHost();
  assert.equal(sample.loadAverage.length, 3);
  assert.ok(sample.topProcesses.length > 0 && sample.topProcesses.every((entry) => typeof entry.benchmark === "boolean" && !entry.command.includes("/")));
});

test("processes running from inside a launched application's bundle count as the benchmark's own", () => {
  const ps = [
    "100 1 5.0 /usr/local/bin/node",
    "200 100 90.0 /usr/local/bin/bun",
    "300 1 120.0 /Apps/Claxedo Dev.app/Contents/MacOS/Claxedo Dev",
    "301 300 60.0 /Apps/Claxedo Dev.app/Contents/Frameworks/Claxedo Dev Helper (Renderer).app/Contents/MacOS/Claxedo Dev Helper (Renderer)",
    "400 1 70.0 /Other/Claxedo Dev.app/Contents/MacOS/Claxedo Dev",
    "500 1 30.0 /usr/libexec/mds_stores",
  ].join("\n");
  const roots = [bundleRoot("/Apps/Claxedo Dev.app/Contents/MacOS/Claxedo Dev")];
  assert.deepEqual(roots, ["/Apps/Claxedo Dev.app/"]);
  assert.deepEqual(rankProcesses(ps, roots, 100), [
    { command: "Claxedo Dev", cpu: 120, benchmark: true },
    { command: "bun", cpu: 90, benchmark: true },
    { command: "Claxedo Dev", cpu: 70, benchmark: false },
    { command: "Claxedo Dev Helper (Renderer)", cpu: 60, benchmark: true },
    { command: "mds_stores", cpu: 30, benchmark: false },
  ]);
});
