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

export function summary(values, attempted = values.length) {
  requireValues(values);
  if (!Number.isInteger(attempted) || attempted < values.length) throw new Error("Attempted count cannot be smaller than valid values.");
  return {
    average: round(average(values)),
    maximum: round(maximum(values)),
    p95: round(percentile(values, 95)),
    valid: values.length,
    attempted,
  };
}

export function summaryOrUnavailable(values, attempted, reason = "No valid observations.") {
  return values.length > 0 ? { status: "valid", ...summary(values, attempted) } : { status: "invalid", valid: 0, attempted, reason };
}

function requireValues(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Statistics require at least one finite, non-negative value.");
  }
}

export const round = (value) => Math.round(value * 1000) / 1000;
