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
