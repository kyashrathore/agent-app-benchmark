import assert from "node:assert/strict";
import test from "node:test";
import { average, maximum, p95EqualsSampledMaximum, percentile, summary } from "../src/statistics.mjs";

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

test("nearest-rank p95 is reported at any valid count and equals the sampled maximum below twenty", () => {
  assert.deepEqual(summary([1, 2], 2), { average: 1.5, maximum: 2, p95: 2, valid: 2, attempted: 2 });
  const five = summary([9, 3, 7, 1, 5], 6);
  assert.equal(five.p95, 9);
  assert.equal(five.maximum, 9);
  assert.deepEqual([five.valid, five.attempted], [5, 6]);
  for (let count = 1; count < 20; count += 1) {
    const values = Array.from({ length: count }, (_, index) => index + 1);
    assert.equal(percentile(values, 95), maximum(values), `p95 must equal the sampled maximum at n=${count}`);
    assert.equal(p95EqualsSampledMaximum(count), true);
  }
  assert.equal(p95EqualsSampledMaximum(20), false);
  assert.notEqual(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95), 20);
  assert.equal(p95EqualsSampledMaximum(0), false);
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
