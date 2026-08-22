import assert from "node:assert/strict";
import test from "node:test";
import { deriveBoundaryPoint, normalizeSnapshot, validateCadence } from "../src/resource-monitor.mjs";

const raw = (atMs, cpuTimeMs, residentBytes = 100) => ({
  sampledAtUnixMs: atMs,
  collectionDurationMicros: 50,
  processes: [{ pid: 10, startTimeMs: 1000, cpuTimeMs, residentBytes, name: "app" }],
});

test("boundary CPU uses cumulative CPU delta so sub-250ms actions remain measurable", () => {
  const point = deriveBoundaryPoint(normalizeSnapshot(raw(1000, 20)), normalizeSnapshot(raw(1100, 70, 150)), {
    caseId: "switch-1",
    workspaceRelation: "within-workspace",
    sessionState: "cold",
    transcriptBytes: 1048576,
  }, 1);
  assert.equal(point.cpuPercent, 50);
  assert.equal(point.rssBytes, 150);
});

test("boundary rejects PID reuse or process-family changes", () => {
  const before = normalizeSnapshot(raw(1000, 20));
  const changed = normalizeSnapshot({ ...raw(1100, 70), processes: [{ ...raw(1100, 70).processes[0], startTimeMs: 2000 }] });
  assert.throws(() => deriveBoundaryPoint(before, changed, { caseId: "switch" }, 1), /membership changed/);
});

test("cadence validation reports missing and excessive gaps", () => {
  const samples = [normalizeSnapshot(raw(1000, 0)), normalizeSnapshot(raw(1250, 5)), normalizeSnapshot(raw(2000, 10))];
  assert.deepEqual(validateCadence(samples, [{ startMs: 1000, endMs: 1300 }], 250), { valid: true });
  assert.equal(validateCadence(samples, [{ startMs: 1000, endMs: 2100 }], 250).valid, false);
  assert.equal(validateCadence([], [{ startMs: 1000, endMs: 1100 }], 250).valid, false);
});
