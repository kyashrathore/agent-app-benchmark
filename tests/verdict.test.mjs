import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapMedianRatio, buildVerdict, mannWhitneyTwoSided, median, renderVerdict } from "../src/verdict.mjs";

test("exact Mann-Whitney p matches the complete-separation table values", () => {
  assert.equal(mannWhitneyTwoSided([1, 2, 3], [4, 5, 6]), 0.1);
  assert.equal(mannWhitneyTwoSided([1, 2, 3, 4], [5, 6, 7, 8]), 4 / 140);
  assert.equal(mannWhitneyTwoSided([1, 3, 5, 7], [2, 4, 6, 8]), 96 / 140);
});

test("bootstrap interval of the median ratio brackets the observed ratio and is reproducible", () => {
  const slow = [200, 210, 220, 230, 240, 250];
  const fast = [40, 42, 44, 46, 48, 50];
  const interval = bootstrapMedianRatio(slow, fast, "lane");
  assert.ok(interval.low <= median(slow) / median(fast) && median(slow) / median(fast) <= interval.high);
  assert.deepEqual(bootstrapMedianRatio(slow, fast, "lane"), interval);
});

const switchCase = (sample) => ({ workload: "list-walk", sessionState: "cold", transcriptBytes: 1024 * 1024, sample });
const result = (appId, durations, invalidAt = -1) => ({
  app: { id: appId },
  scenario: { kind: "session-switch" },
  observations: durations.map((durationMs, index) => (index === invalidAt
    ? { case: switchCase(index), status: "invalid" }
    : { case: switchCase(index), status: "valid", durationMs })),
});

test("a winner needs significance, an interval above one, and a gap of at least 5%", () => {
  const separated = buildVerdict([result("a", [40, 41, 42, 43, 44, 45]), result("b", [200, 201, 202, 203, 204, 205])]).rows[0];
  assert.equal(separated.verdict, "lower");
  assert.equal(separated.winner, "a");

  const close = buildVerdict([result("a", [100, 100.5, 101, 101.5, 102, 102.5]), result("b", [103, 103.5, 104, 104.5, 105, 105.5])]).rows[0];
  assert.equal(close.verdict, "within-practical-margin");
  assert.equal(close.winner, null);

  const overlapping = buildVerdict([result("a", [40, 90, 60, 120, 50, 100]), result("b", [70, 110, 45, 95, 130, 55])]).rows[0];
  assert.equal(overlapping.verdict, "no-reliable-difference");
});

test("any invalid observation withholds the lane verdict", () => {
  const row = buildVerdict([result("a", [40, 41, 42, 43, 44, 45], 2), result("b", [200, 201, 202, 203, 204, 205])]).rows[0];
  assert.equal(row.verdict, "withheld");
  assert.equal(row.winner, undefined);
});

test("fewer than four samples a side never names a winner", () => {
  const row = buildVerdict([result("a", [40, 41, 42]), result("b", [200, 201, 202])]).rows[0];
  assert.equal(row.verdict, "insufficient");
});

test("first visits and returns at each size and row shape get their own rows, and memory-run steps are not scored", () => {
  const MIB = 1024 * 1024;
  const observations = (cases, durations) => cases.flatMap((benchmarkCase) =>
    durations.map((durationMs, sample) => ({ case: { ...benchmarkCase, sample }, status: "valid", durationMs })));
  const walk = (appId, durations) => ({
    app: { id: appId },
    scenario: { kind: "session-switch" },
    observations: observations([
      { workload: "list-walk", sessionState: "cold", transcriptBytes: MIB, rowShape: "long" },
      { workload: "list-walk", sessionState: "warm", transcriptBytes: 8 * MIB },
      { workload: "list-walk", sessionState: "cold", transcriptBytes: MIB },
      { workload: "progressive-resource", sessionState: "cold", transcriptBytes: 8 * MIB },
    ], durations),
  });
  const verdict = buildVerdict([walk("a", [40, 41, 42, 43]), walk("b", [200, 201, 202, 203])]);
  assert.deepEqual(verdict.rows.map((row) => row.id), ["walk-cold-1", "walk-cold-long-1", "walk-warm-8"]);
  assert.deepEqual(verdict.rows.map((row) => row.title), [
    "Next session down the list, first visit: 1 MiB session",
    "Next session down the list, first visit: 1 MiB of long text rows",
    "Next session down the list, return: 8 MiB session",
  ]);
  assert.ok(verdict.rows.every((row) => row.winner === "a"));
});

test("the rendered table counts every attempted observation beside the valid ones", () => {
  const result = (appId, statuses) => ({
    app: { id: appId },
    scenario: { kind: "app-start" },
    observations: statuses.map((status, sample) => ({ case: { startMode: "new-application-state", sample }, status, durationMs: 1000 + sample })),
  });
  const verdict = buildVerdict([result("a", ["valid", "valid", "invalid", "valid"]), result("b", ["valid", "valid", "valid", "valid"])]);
  const table = renderVerdict(verdict);
  assert.match(table, /n=3\/4\)/u);
  assert.match(table, /n=4\/4\)/u);
  assert.match(table, /withheld: a has 1 invalid observations/u);
});

test("the times column divides the other app's median by the first app's", () => {
  const latency = (appId, values) => ({
    app: { id: appId },
    scenario: { kind: "app-start" },
    observations: values.map((durationMs, sample) => ({ case: { startMode: "new-application-state", sample }, status: "valid", durationMs })),
  });
  const cell = (verdict) => renderVerdict(verdict, { a: "Claxedo", b: "OpenCode" }).split("\n")[2].split("|")[4].trim();
  assert.equal(cell(buildVerdict([latency("a", [100, 100, 100, 100]), latency("b", [253, 253, 253, 253])])), "2.53×");
  assert.equal(
    cell(buildVerdict([latency("a", [239, 239, 239, 239]), latency("b", [100, 100, 100, 100])])),
    "0.42× (OpenCode 2.39× faster)",
  );
  const zero = {
    apps: ["a", "b"],
    rows: [{ title: "CPU while idle", unit: "%", kind: "ranked", verdict: "different", winner: "a", ratio: Infinity, ratioInterval95: { low: 1, high: Infinity }, pValue: 0.01,
      apps: { a: { valid: 10, attempted: 10, median: 0 }, b: { valid: 10, attempted: 10, median: 20.4 } } }],
  };
  assert.equal(cell(zero), "— (Claxedo 0.0%, OpenCode 20.4%)");
});

test("below twenty valid samples a row names its maximum, not a p95 that is only the maximum", () => {
  const latency = (appId, values) => ({
    app: { id: appId },
    scenario: { kind: "app-start" },
    observations: values.map((durationMs, sample) => ({ case: { startMode: "new-application-state", sample }, status: "valid", durationMs })),
  });
  const cells = (verdict) => renderVerdict(verdict, { a: "Claxedo", b: "OpenCode" }).split("\n")[2].split("|").map((cell) => cell.trim());
  const small = cells(buildVerdict([latency("a", [1008, 1039, 1113, 6639]), latency("b", [2907, 2922, 2964, 3042])]));
  assert.equal(small[2], "1.08 s (max 6.64 s, n=4/4)");
  assert.equal(small[3], "2.94 s (max 3.04 s, n=4/4)");
  const twenty = Array.from({ length: 20 }, (_, index) => 100 + index);
  const large = cells(buildVerdict([latency("a", twenty), latency("b", twenty.map((value) => value * 2))]));
  assert.equal(large[2], "109.5 ms (p95 118.0 ms, n=20/20)");
});
