import assert from "node:assert/strict";
import test from "node:test";
import { summarizeResourceTrendP95, summarizeResourceWindows } from "../src/summarize.mjs";

const MIB = 1048576;

function sample(atMs, rssMiB, cpuTimeMs, overrides = {}) {
  const rssBytes = rssMiB * MIB;
  return {
    atMs,
    collectionDurationMicros: 100,
    rssBytes,
    cumulativeCpuTimeMs: cpuTimeMs,
    inaccessibleProcessCount: 0,
    rootProcessFound: true,
    missingExternalProcessCount: 0,
    processes: [{ pid: 10, startTimeMs: 0, cpuTimeMs, rssBytes, name: "fixture-root" }],
    ...overrides,
  };
}

function traceFixture(overrides = {}) {
  const baseline = Array.from({ length: 5 }, (_, index) => sample(index * 250, 100 + index, index * 25));
  const active = Array.from({ length: 21 }, (_, index) => sample(2000 + index * 250, 200 + index, 100 + index * 50));
  const ending = Array.from({ length: 5 }, (_, index) => sample(8000 + index * 250, 150 + index, 1200 + index * 10));
  return {
    version: 1,
    samples: [...baseline, ...active, ...ending],
    windows: { baseline: { startMs: 0, endMs: 1000 }, active: { startMs: 2000, endMs: 7000 }, ending: { startMs: 8000, endMs: 9000 } },
    boundaries: [],
    monitorErrors: [],
    failure: null,
    ...overrides,
  };
}

const validResources = { status: "valid" };

test("resource windows report nearest-rank p95 RSS and CPU for baseline, active, and ending idle", () => {
  const inventory = summarizeResourceWindows(traceFixture(), validResources);
  assert.equal(inventory.status, "valid");
  assert.equal(inventory.runCount, 1);
  assert.equal(inventory.rawSampleCount, 31);

  assert.deepEqual(inventory.windows.baseline.rssP95MiB, { status: "valid", p95: 104, valid: 5, attempted: 5 });
  assert.deepEqual(inventory.windows.ending.rssP95MiB, { status: "valid", p95: 154, valid: 5, attempted: 5 });

  // With 21 active samples the nearest-rank 95th value is genuinely below the sampled maximum, so
  // the diagnostic maximum stays a separate, separately labelled row.
  assert.deepEqual(inventory.windows.active.rssP95MiB, { status: "valid", p95: 219, valid: 21, attempted: 21 });
  assert.deepEqual(inventory.windows.active.rssMaximumMiB, { status: "valid", maximum: 220, valid: 21, attempted: 21 });

  assert.deepEqual(inventory.windows.baseline.cpuP95Percent, { status: "valid", p95: 10, valid: 4, attempted: 4 });
  assert.deepEqual(inventory.windows.active.cpuP95Percent, { status: "valid", p95: 20, valid: 20, attempted: 20 });
  assert.deepEqual(inventory.windows.ending.cpuP95Percent, { status: "valid", p95: 4, valid: 4, attempted: 4 });

  assert.deepEqual(inventory.retainedRssGrowthMiB, { status: "valid", signed: true, p95: 50, valid: 5, attempted: 5 });

  assert.equal(inventory.windows.baseline.observedSampleIntervalMs, 250);
  assert.equal(inventory.windows.baseline.observedWindowDurationMs, 1000);
  assert.equal(inventory.windows.active.observedWindowDurationMs, 5000);
  assert.deepEqual(inventory.processFamily.observedProcessNames, ["fixture-root"]);
  assert.equal(inventory.processFamily.maximumObservedProcessCount, 1);
  assert.equal(inventory.processFamily.samplesMissingRootProcess, 0);
});

test("retained RSS growth is the signed difference of the two idle p95 values", () => {
  const trace = traceFixture();
  for (const item of trace.samples.filter((entry) => entry.atMs >= 8000)) {
    item.rssBytes = 10 * MIB;
    item.processes[0].rssBytes = 10 * MIB;
  }
  const inventory = summarizeResourceWindows(trace, validResources);
  assert.equal(inventory.windows.ending.rssP95MiB.p95, 10);
  assert.equal(inventory.retainedRssGrowthMiB.p95, -94);
});

test("resource windows inherit every validity gate the runner already applied", () => {
  const inventory = summarizeResourceWindows(traceFixture(), { status: "invalid", reason: "Resource sample cadence gap exceeded tolerance." });
  assert.equal(inventory.status, "invalid");
  assert.equal(inventory.reason, "Resource sample cadence gap exceeded tolerance.");
  for (const id of ["baseline", "active", "ending"]) {
    for (const metric of ["rssP95MiB", "rssMaximumMiB", "cpuP95Percent"]) {
      assert.equal(inventory.windows[id][metric].status, "invalid", `${id}.${metric}`);
      assert.equal(inventory.windows[id][metric].reason, "Resource sample cadence gap exceeded tolerance.");
    }
  }
  // Invalid keeps its evidence counts rather than collapsing to a zero measurement.
  assert.equal(inventory.windows.active.rssP95MiB.attempted, 21);
  assert.equal(inventory.retainedRssGrowthMiB.status, "invalid");
});

test("a window that lost the root process stays invalid with its reason and never scores zero", () => {
  const trace = traceFixture();
  trace.samples.at(-1).rootProcessFound = false;
  const inventory = summarizeResourceWindows(trace, validResources);
  assert.equal(inventory.windows.baseline.rssP95MiB.status, "valid");
  assert.equal(inventory.windows.ending.rssP95MiB.status, "invalid");
  assert.match(inventory.windows.ending.rssP95MiB.reason, /lost part of the declared application process family during the ending window/);
  assert.deepEqual([inventory.windows.ending.rssP95MiB.valid, inventory.windows.ending.rssP95MiB.attempted], [4, 5]);
  assert.equal(inventory.retainedRssGrowthMiB.status, "invalid");
  assert.equal(inventory.processFamily.samplesMissingRootProcess, 1);
});

test("a required window with no samples is invalid rather than empty", () => {
  const trace = traceFixture();
  trace.samples = trace.samples.filter((entry) => entry.atMs < 8000);
  const inventory = summarizeResourceWindows(trace, validResources);
  assert.equal(inventory.windows.ending.rssP95MiB.status, "invalid");
  assert.match(inventory.windows.ending.rssP95MiB.reason, /contains no samples/);
  assert.equal(inventory.windows.ending.sampleCount, 0);
});

test("a missing raw trace is reported as missing evidence", () => {
  const inventory = summarizeResourceWindows(null, null);
  assert.equal(inventory.status, "invalid");
  assert.equal(inventory.reason, "Raw resource trace is missing.");
  assert.equal(inventory.windows.baseline.rssP95MiB.status, "invalid");
  assert.equal(inventory.runCount, 0);
});

test("repeated resource runs pool their windows without pooling unlike states", () => {
  const trace = { version: 2, runs: [traceFixture({ repetition: 0 }), traceFixture({ repetition: 1 })] };
  const inventory = summarizeResourceWindows(trace, validResources);
  assert.equal(inventory.runCount, 2);
  assert.equal(inventory.rawSampleCount, 62);
  assert.deepEqual(inventory.windows.baseline.rssP95MiB, { status: "valid", p95: 104, valid: 10, attempted: 10 });
  // Consecutive pairs are formed inside each run, never across the boundary between two runs.
  assert.equal(inventory.windows.baseline.cpuP95Percent.attempted, 8);
});

test("step trend reports nearest-rank p95 RSS and CPU per transcript size with counts", () => {
  const trend = summarizeResourceTrendP95([
    { transcriptBytes: 1048576, rssMiB: 100, cpuPercent: 10 },
    { transcriptBytes: 1048576, rssMiB: 140, cpuPercent: 30 },
    { transcriptBytes: 8388608, rssMiB: 200, cpuPercent: 50 },
    { transcriptBytes: 8388608, rssMiB: null, cpuPercent: 60 },
  ]);
  assert.deepEqual(trend.map((point) => point.transcriptBytes), [1048576, 8388608]);
  assert.deepEqual(trend[0].rssMiB, { status: "valid", p95: 140, valid: 2, attempted: 2 });
  assert.deepEqual(trend[0].cpuPercent, { status: "valid", p95: 30, valid: 2, attempted: 2 });
  assert.deepEqual(trend[1].rssMiB, { status: "valid", p95: 200, valid: 1, attempted: 2 });
  assert.deepEqual(trend[1].cpuPercent, { status: "valid", p95: 60, valid: 2, attempted: 2 });
});
