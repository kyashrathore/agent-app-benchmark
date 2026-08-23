export function average(values) {
  requireValues(values);
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function maximum(values) {
  requireValues(values);
  return Math.max(...values);
}

export function percentile(values, percentileRank) {
  requireValues(values);
  if (!Number.isFinite(percentileRank) || percentileRank < 0 || percentileRank > 100) throw new Error("Percentile rank must be between 0 and 100.");
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

export function summary(values, attempted = values.length, options = {}) {
  requireValues(values);
  if (!Number.isInteger(attempted) || attempted < values.length) throw new Error("Attempted count cannot be smaller than valid values.");
  const result = {
    average: round(average(values)),
    maximum: round(maximum(values)),
    valid: values.length,
    attempted,
  };
  if (options.minimumP95Samples && values.length < options.minimumP95Samples) {
    return { ...result, p95: null, p95Status: `requires-${options.minimumP95Samples}-valid-observations` };
  }
  return { ...result, p95: round(percentile(values, 95)) };
}

export function summaryOrUnavailable(values, attempted, reason = "No valid observations.", options = {}) {
  if (values.length !== attempted) {
    return {
      status: "invalid",
      valid: values.length,
      attempted,
      reason: values.length === 0 ? reason : `Only ${values.length} of ${attempted} required observations were valid.`,
    };
  }
  return { status: "valid", ...summary(values, attempted, options) };
}

function requireValues(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Statistics require at least one finite, non-negative value.");
  }
}

export const round = (value) => Math.round(value * 1000) / 1000;
