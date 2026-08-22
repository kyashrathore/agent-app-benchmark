const SHA256 = /^[0-9a-f]{64}$/;

export function assertHello(result, expected) {
  if (!result || result.protocolVersion !== 1) throw new Error("Driver hello has an unsupported protocol version.");
  assertIdentity(result.application, ["id", "name", "version", "buildDigestSha256"], "application");
  assertIdentity(result.driver, ["name", "version", "sourceCommit", "digestSha256"], "driver");
  if (result.application.id !== expected.appId) throw new Error(`Driver application id ${result.application.id} does not match ${expected.appId}.`);
  if (!Array.isArray(result.scenarios) || !result.scenarios.includes(expected.scenarioId)) throw new Error(`Driver does not support ${expected.scenarioId}.`);
  if (!Array.isArray(result.sourceEventFormats) || !result.sourceEventFormats.includes(expected.sourceEventFormatId)) throw new Error(`Driver does not support ${expected.sourceEventFormatId}.`);
  if (!Array.isArray(result.materializationModes) || result.materializationModes.some((mode) => !["native-opencode", "translated"].includes(mode))) throw new Error("Driver materialization modes are invalid.");
  return result;
}

export function assertPrepared(result, expected) {
  if (!result || !["native-opencode", "translated"].includes(result.materializationMode)) throw new Error("Driver prepare result has no valid materialization mode.");
  if (result.corpusDigestSha256 !== expected.corpusDigestSha256) throw new Error("Driver attested to the wrong corpus digest.");
  if (result.eventSchemaDigestSha256 !== expected.eventSchemaDigestSha256) throw new Error("Driver attested to the wrong event schema digest.");
  if (!SHA256.test(result.mappingDigestSha256 ?? "")) throw new Error("Driver prepare result has no mapping digest.");
  if (!result.stateHandles || typeof result.stateHandles.P0 !== "string" || typeof result.stateHandles.P1 !== "string") throw new Error("Driver did not prepare P0 and P1 state handles.");
  return result;
}

export function assertLaunch(result) {
  if (!result?.ready || !Array.isArray(result.processes) || result.processes.length === 0) throw new Error("Driver launch did not reach readiness with process roots.");
  for (const process of result.processes) {
    if (!Number.isInteger(process.pid) || process.pid < 1 || !Number.isFinite(process.startTimeMs) || process.startTimeMs < 0 || process.owner !== "application") {
      throw new Error("Driver launch returned an invalid application process identity.");
    }
  }
  assertReceipt(result.readiness, "launch readiness");
  return result;
}

export function normalizeExecution(result, benchmarkCase) {
  const base = { case: benchmarkCase, receivedAt: new Date().toISOString() };
  if (!result || result.caseId !== benchmarkCase.caseId) return { ...base, status: "invalid", reason: "Driver returned the wrong case id." };
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) return { ...base, status: "invalid", reason: "Driver returned an invalid duration." };
  try {
    assertReceipt(result.readiness, "execution readiness");
    if (result.readiness.checks.some((check) => check.passed !== true)) return { ...base, status: "invalid", durationMs: result.durationMs, reason: "One or more readiness checks failed.", readiness: result.readiness };
    if (!result.clock || result.clock.kind !== "single-monotonic-clock" || !Number.isFinite(result.clock.start) || !Number.isFinite(result.clock.end) || result.clock.end < result.clock.start) {
      return { ...base, status: "invalid", durationMs: result.durationMs, reason: "Driver returned invalid one-clock timing evidence.", readiness: result.readiness };
    }
  } catch (error) {
    return { ...base, status: "invalid", durationMs: result.durationMs, reason: error.message };
  }
  return { ...base, status: "valid", durationMs: result.durationMs, readiness: result.readiness, clock: result.clock };
}

export function assertShutdown(result) {
  if (!result || !Array.isArray(result.terminated) || !Array.isArray(result.survivors)) throw new Error("Driver shutdown result is invalid.");
  if (result.survivors.length > 0) throw new Error(`Driver shutdown left ${result.survivors.length} surviving process(es).`);
  return result;
}

function assertIdentity(value, fields, label) {
  if (!value || typeof value !== "object") throw new Error(`Driver ${label} identity is missing.`);
  for (const field of fields) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`Driver ${label}.${field} is missing.`);
  }
  for (const field of ["buildDigestSha256", "digestSha256"]) {
    if (value[field] !== undefined && !SHA256.test(value[field])) throw new Error(`Driver ${label}.${field} is not SHA-256.`);
  }
}

function assertReceipt(receipt, label) {
  if (!receipt || typeof receipt.endpoint !== "string" || !Array.isArray(receipt.checks) || receipt.checks.length === 0) throw new Error(`Driver ${label} receipt is missing.`);
  for (const check of receipt.checks) {
    if (typeof check.id !== "string" || typeof check.passed !== "boolean") throw new Error(`Driver ${label} check is invalid.`);
  }
}
