import assert from "node:assert/strict";
import test from "node:test";
import { average, maximum, percentile, summary } from "../src/statistics.mjs";

test("statistics use arithmetic average, maximum, and nearest-rank p95", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(average(values), 10.5);
  assert.equal(maximum(values), 20);
  assert.equal(percentile(values, 95), 19);
  assert.deepEqual(summary(values, 21), { average: 10.5, maximum: 20, p95: 19, valid: 20, attempted: 21 });
});

test("statistics reject missing and invalid observations", () => {
  assert.throws(() => summary([]), /at least one/);
  assert.throws(() => summary([1, Number.NaN]), /at least one/);
  assert.throws(() => summary([1], 0), /Attempted/);
});

test("p95 is explicitly unavailable below the V3 minimum sample count", () => {
  assert.deepEqual(summary([1, 2], 2, { minimumP95Samples: 20 }), {
    average: 1.5,
    maximum: 2,
    p95: null,
    p95Status: "requires-20-valid-observations",
    valid: 2,
    attempted: 2,
  });
});

test("p50 is opt-in for user-facing trend summaries", () => {
  assert.deepEqual(summary([1, 2, 3, 4], 4, { includeP50: true }), {
    average: 2.5,
    maximum: 4,
    p50: 2,
    p95: 4,
    valid: 4,
    attempted: 4,
  });
});
