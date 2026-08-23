import assert from "node:assert/strict";
import test from "node:test";
import { ResourceMonitor, deriveBoundaryPoint, normalizeSnapshot, validateCadence } from "../src/resource-monitor.mjs";

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

test("boundary rejects replacement of every stable process identity", () => {
  const before = normalizeSnapshot(raw(1000, 20));
  const changed = normalizeSnapshot({ ...raw(1100, 70), processes: [{ ...raw(1100, 70).processes[0], startTimeMs: 2000 }] });
  assert.throws(() => deriveBoundaryPoint(before, changed, { caseId: "switch" }, 1), /no stable identity/);
});

test("boundary includes newly spawned descendants and tolerates exited helpers", () => {
  const before = normalizeSnapshot({
    ...raw(1000, 20),
    processes: [
      raw(1000, 20).processes[0],
      { pid: 11, startTimeMs: 500, cpuTimeMs: 5, residentBytes: 40, name: "old-helper" },
    ],
  });
  const after = normalizeSnapshot({
    ...raw(1100, 70),
    processes: [
      raw(1100, 70, 150).processes[0],
      { pid: 12, startTimeMs: 1000, cpuTimeMs: 20, residentBytes: 60, name: "new-helper" },
    ],
  });
  const intermediate = normalizeSnapshot({
    ...raw(1050, 45),
    processes: [
      raw(1050, 45, 140).processes[0],
      { pid: 11, startTimeMs: 500, cpuTimeMs: 15, residentBytes: 40, name: "old-helper" },
      { pid: 12, startTimeMs: 1000, cpuTimeMs: 8, residentBytes: 50, name: "new-helper" },
    ],
  });
  const point = deriveBoundaryPoint(before, after, {
    caseId: "switch-2",
    workspaceRelation: "across-workspaces",
    sessionState: "warm",
    transcriptBytes: 2097152,
  }, 2, [before, intermediate, after]);
  assert.equal(point.cpuDeltaMs, 80);
  assert.equal(point.cpuPercent, 80);
  assert.equal(point.rssBytes, 210);
});

test("boundary does not charge lifetime CPU from a previously running late-discovered descendant", () => {
  const before = normalizeSnapshot(raw(10_000, 20));
  const after = normalizeSnapshot({
    ...raw(10_100, 70),
    processes: [
      raw(10_100, 70, 150).processes[0],
      { pid: 12, startTimeMs: 1_000, cpuTimeMs: 500, residentBytes: 60, name: "late-discovered" },
    ],
  });
  const point = deriveBoundaryPoint(before, after, { caseId: "switch-3" }, 3);
  assert.equal(point.cpuDeltaMs, 50);
});

test("cadence validation reports missing and excessive gaps", () => {
  const samples = [normalizeSnapshot(raw(1000, 0)), normalizeSnapshot(raw(1250, 5)), normalizeSnapshot(raw(2000, 10))];
  assert.deepEqual(validateCadence(samples, [{ startMs: 1000, endMs: 1300 }], 250), { valid: true });
  assert.equal(validateCadence(samples, [{ startMs: 1000, endMs: 2100 }], 250).valid, false);
  assert.equal(validateCadence([], [{ startMs: 1000, endMs: 1100 }], 250).valid, false);
});

test("malformed snapshots are recorded and reject pending samples without throwing", async () => {
  const monitor = Object.create(ResourceMonitor.prototype);
  monitor.samples = [];
  monitor.errors = [];
  monitor.pendingSnapshots = new Map();
  let rejectSnapshot;
  const snapshot = new Promise((_, reject) => { rejectSnapshot = reject; });
  const rejected = assert.rejects(snapshot, /malformed snapshot/);
  monitor.pendingSnapshots.set("sample-1", { resolve: () => {}, reject: rejectSnapshot, timer: setTimeout(() => {}, 60_000) });
  assert.doesNotThrow(() => monitor.onLine(JSON.stringify({ type: "snapshot", requestId: "sample-1", sampledAtUnixMs: 1, collectionDurationMicros: 1, processes: null })));
  await rejected;
  assert.deepEqual(monitor.samples, []);
  assert.deepEqual(monitor.errors, [{ code: "invalid-snapshot", message: "Resource monitor returned a malformed snapshot." }]);
  assert.equal(monitor.pendingSnapshots.size, 0);
});

test("snapshot normalization rejects non-finite process measurements", () => {
  assert.throws(() => normalizeSnapshot({ ...raw(1000, 20), processes: [{ ...raw(1000, 20).processes[0], residentBytes: "100" }] }), /residentBytes/);
});

test("snapshot normalization preserves process-family completeness evidence", () => {
  const snapshot = normalizeSnapshot({
    ...raw(1000, 20),
    inaccessibleProcessCount: 1,
    externalProcesses: [],
  }, { rootPid: 10, expectedExternalProcessCount: 1 });
  assert.equal(snapshot.rootProcessFound, true);
  assert.equal(snapshot.inaccessibleProcessCount, 1);
  assert.equal(snapshot.missingExternalProcessCount, 1);
});
