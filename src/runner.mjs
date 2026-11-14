import { appendFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { digest } from "./canonical-json.mjs";
import { buildGroups, buildResourceSequence, expandCases, profileOf, repetitionsFor } from "./cases.mjs";
import { assertContract } from "./contracts.mjs";
import { verifyCorpus } from "./corpus.mjs";
import { DriverProcess } from "./driver-process.mjs";
import { checkStreamSpacing, invalidObservation, observeExecution, publicError } from "./observations.mjs";
import { assertHello, assertLaunch, assertPrepared, assertShutdown, unsupportedReason } from "./protocol.mjs";
import { CLOCK_RULE_ID } from "./clock-rule.mjs";
import { REPLAY_MODEL_ID, REPLAY_PROVIDER_ID, replyOpening } from "./replay-reply.mjs";
import { startReplayServer } from "./replay-server.mjs";
import { renderReport } from "./report.mjs";
import { deriveBoundaryPoint, ResourceMonitor, validateCadence } from "./resource-monitor.mjs";
import { summarizeObservations, summarizeResources } from "./summarize.mjs";
import { UNSUPPORTED_PREFIX, verdictRows } from "./rows.mjs";

const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const RESOURCE_CONTROL_CASE = Object.freeze({ caseId: "progressive-resource-return-control", repetition: 0, workload: "resource-control", destinationSessionId: "control" });

export async function runBenchmark(input, dependencies = {}) {
  const scenario = input.scenario.value;
  const repetitions = repetitionsFor(scenario, input.runProfile, input.repetitions);
  const environment = input.environment ?? collectEnvironment();
  const output = path.resolve(input.output);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  const privateRunDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-run-"));
  const spawnDriver = dependencies.spawnDriver ?? DriverProcess.spawn;
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const startMonitor = dependencies.startMonitor ?? ResourceMonitor.start;
  const observations = [];
  const frameLogs = { checked: 0, failed: 0, missing: 0 };
  let hello;
  let prepared;
  let corpus;
  let driver;
  let replay;
  let resources = null;
  let resourceTrace = null;
  try {
    corpus = await verifyCorpus(input.corpusDirectory);
    assertCorpusIdentity(corpus, input.corpus);
    if (input.corpus.status === "public-comparable") await assertPublicCorpusArtifact(corpus, input.corpus.value.id);
    if (scenario.kind === "typing-while-streaming") replay = await startReplay(scenario, input.runProfile, path.join(output, "replay-requests.jsonl"));
    driver = await spawnDriver({ ...input.driver, cwd: input.driver.cwd ?? privateRunDirectory });
    hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), {
      appId: input.app.id,
      scenarioId: scenario.id,
      sourceEventFormatId: input.corpus.value.sourceEventFormat.id,
    });
    prepared = assertPrepared(await driver.request("prepare", {
      scenarioId: scenario.id,
      scenarioDigestSha256: input.scenario.digest,
      corpusDirectory: corpus.path,
      corpusManifestPath: path.join(corpus.path, "manifest.json"),
      corpusDigestSha256: corpus.digestSha256,
      corpusDefinitionDigestSha256: input.corpus.digest,
      eventSchemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
      runDirectory: privateRunDirectory,
      ...(replay ? { replay: replay.params } : {}),
    }, 10 * 60_000), {
      corpusDigestSha256: corpus.digestSha256,
      eventSchemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
      materializationModes: hello.materializationModes,
    });
    if (!input.app.materializationModes.includes(prepared.materializationMode)) throw new Error(`${input.app.id} is not registered for ${prepared.materializationMode} materialization.`);
    const unsupported = unsupportedReason(hello, scenario.id);
    const run = { driver, scenario, runProfile: input.runProfile, repetitions, prepared, observations, frameLogs };
    if (unsupported !== null) {
      recordUnsupported(run, unsupported);
    } else if (scenario.kind === "app-start") {
      await runAppStart(run);
    } else {
      await runGroups(run);
      if (scenario.kind === "session-switch") {
        const resourceRun = await runResourceWorkload({ ...run, resourceMonitor: input.resourceMonitor, startMonitor, delay, now });
        resources = resourceRun.resources;
        resourceTrace = resourceRun.trace;
      }
    }
  } finally {
    if (driver) await driver.close();
    if (replay) await replay.close();
    await rm(privateRunDirectory, { recursive: true, force: true });
  }
  const summary = summarizeObservations(scenario, observations);
  const result = {
    schemaVersion: 1,
    runId: input.runId ?? `${input.app.id}-${scenario.id}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    provenance: {
      kind: input.provenance ?? "community-self-attested",
      frameworkRevision: input.frameworkRevision ?? "working-tree",
    },
    environment,
    app: hello.application,
    driver: hello.driver,
    clockRule: { id: CLOCK_RULE_ID, declared: hello.clockRule ?? null, frameLogs },
    sourceEventFormat: {
      id: input.corpus.value.sourceEventFormat.id,
      sourceRevision: input.corpus.value.sourceEventFormat.sourceRevision,
      schemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
    },
    materialization: {
      mode: prepared.materializationMode,
      corpusDigestSha256: prepared.corpusDigestSha256,
      mappingDigestSha256: prepared.mappingDigestSha256,
    },
    scenario: { id: scenario.id, kind: scenario.kind, digestSha256: input.scenario.digest, status: input.scenario.status },
    corpus: { id: input.corpus.value.id, definitionDigestSha256: input.corpus.digest, digestSha256: corpus.digestSha256, status: input.corpus.status },
    runProfile: input.runProfile,
    repetitions,
    observations: [...observations],
    resources,
    resourceTrace,
    derivation: { version: 1, summaryDigestSha256: digest(summary), summary },
  };
  assertContract("result", result, "result bundle");
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  assertShareable(serialized);
  await atomicWrite(path.join(output, "result.json"), serialized);
  await atomicWrite(path.join(output, "report.md"), renderReport(result));
  return result;
}

/**
 * The replay server for the scenario's run profile. Its `params` go to the
 * driver in `prepare`; every request it serves is appended to `logFile`.
 */
async function startReplay(scenario, runProfile, logFile) {
  const { deltaCount } = profileOf(scenario, runProfile);
  const server = await startReplayServer({
    deltaCount,
    deltaChars: scenario.cases.replay.deltaChars,
    intervalMs: scenario.cases.replay.intervalMs,
    prompt: scenario.cases.prompt,
    onRequest: (entry) => appendFile(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch(() => {}),
  });
  return {
    close: () => server.close(),
    params: {
      baseUrl: server.baseUrl,
      npm: "@ai-sdk/openai-compatible",
      providerId: REPLAY_PROVIDER_ID,
      modelId: REPLAY_MODEL_ID,
      apiKey: "agent-app-benchmark-replay",
      prompt: scenario.cases.prompt,
      replyOpening: replyOpening(scenario.cases.firstWordChars),
      deltaCount,
      deltaChars: scenario.cases.replay.deltaChars,
      intervalMs: scenario.cases.replay.intervalMs,
    },
  };
}

function recordUnsupported({ scenario, runProfile, repetitions, observations }, reason) {
  const cases = expandCases(scenario, runProfile, repetitions);
  if (scenario.kind === "session-switch") cases.push(...resourceCases(scenario));
  for (const benchmarkCase of cases) observations.push(invalidObservation(benchmarkCase, `${UNSUPPORTED_PREFIX}${reason}`));
}

function assertCorpusIdentity(generated, definition) {
  if (generated.manifest.corpusId !== definition.value.id
    || generated.manifest.definitionDigestSha256 !== definition.digest
    || generated.manifest.sourceEventFormat.id !== definition.value.sourceEventFormat.id
    || generated.manifest.sourceEventFormat.sourceRevision !== definition.value.sourceEventFormat.sourceRevision) {
    throw new Error("Prepared corpus does not match the selected corpus definition.");
  }
}

async function assertPublicCorpusArtifact(built, corpusId) {
  const { readRegistered } = await import("./registry.mjs");
  const artifact = await readRegistered("corpusArtifact", corpusId);
  if (artifact.value.corpusDigestSha256 !== built.digestSha256
    || artifact.value.definitionDigestSha256 !== built.manifest.definitionDigestSha256
    || artifact.value.recordingDigestSha256 !== built.manifest.recording.digestSha256
    || artifact.value.eventSchemaDigestSha256 !== built.manifest.sourceEventFormat.schemaDigestSha256) {
    throw new Error("Built public corpus does not match its registered canonical artifact identity.");
  }
}

async function runAppStart({ driver, scenario, runProfile, repetitions, prepared, observations, frameLogs }) {
  for (const benchmarkCase of expandCases(scenario, runProfile, repetitions)) {
    const withheld = withheldRowReason(scenario.kind, observations, benchmarkCase);
    if (withheld) {
      observations.push(invalidObservation(benchmarkCase, withheld));
      continue;
    }
    const action = { request: benchmarkCase, cases: [benchmarkCase] };
    const index = observations.push(...await executeSafely(driver, scenario, action, { frameLogs, stateHandle: prepared.stateHandles[benchmarkCase.stateHandle] })) - 1;
    const cleanup = await shutdownSafely(driver, benchmarkCase.caseId);
    if (!cleanup.valid) observations[index] = invalidateForCleanup(observations[index], cleanup.reason);
  }
}

/** One launched process per group, each action one `execute`, in order; a failure invalidates the rest of the group. */
async function runGroups({ driver, scenario, runProfile, repetitions, prepared, observations, frameLogs }) {
  for (const group of buildGroups(scenario, runProfile, repetitions)) {
    if (skipWithheldGroup(scenario.kind, observations, group)) continue;
    let launchAttempted = false;
    const firstObservation = observations.length;
    try {
      launchAttempted = true;
      assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: group.groupId }, 5 * 60_000), { requireProcessRoles: true });
      for (const action of group.actions) {
        const withheld = action.cases.map((benchmarkCase) => withheldRowReason(scenario.kind, observations, benchmarkCase));
        if (withheld.every(Boolean)) {
          action.cases.forEach((benchmarkCase, index) => observations.push(invalidObservation(benchmarkCase, withheld[index])));
          continue;
        }
        observations.push(...await executeSafely(driver, scenario, action, { frameLogs }));
      }
    } catch (error) {
      for (const benchmarkCase of group.cases.slice(observations.length - firstObservation)) observations.push(invalidObservation(benchmarkCase, error));
    } finally {
      if (launchAttempted) {
        const cleanup = await shutdownSafely(driver, group.groupId);
        if (!cleanup.valid) {
          for (let index = firstObservation; index < observations.length; index += 1) observations[index] = invalidateForCleanup(observations[index], cleanup.reason);
        }
      }
    }
    if (scenario.kind === "typing-while-streaming") observations.splice(firstObservation, Infinity, ...checkStreamSpacing(observations.slice(firstObservation), scenario));
  }
}

async function runResourceWorkload(input) {
  return runResourceWorkloadOnce({ ...input, group: { groupId: "progressive-resource", repetition: 0, cases: buildResourceSequence(input.scenario) } });
}

/** The memory run's steps: the progressive sequence, then the return to the control session. */
function resourceCases(scenario) {
  return [...buildResourceSequence(scenario), RESOURCE_CONTROL_CASE];
}

async function runResourceWorkloadOnce({ driver, scenario, prepared, observations, frameLogs, resourceMonitor, startMonitor, delay, now, group }) {
  const resource = scenario.resourceMeasurement;
  const sequence = group.cases;
  let monitor;
  let launchAttempted = false;
  let failure = resourceMonitor ? null : "No framework resource monitor executable was supplied.";
  const windows = { baseline: null, active: null, ending: null };
  const boundaries = [];
  const firstObservation = observations.length;
  try {
    if (!resourceMonitor) throw new Error(failure);
    launchAttempted = true;
    const launch = assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: group.groupId }, 5 * 60_000), { requireProcessRoles: true });
    monitor = await startMonitor(path.resolve(resourceMonitor), launch.processes, resource.idleSampleIntervalMs);
    await delay(resource.settleBeforeIdleMs);
    windows.baseline = { startMs: now(), endMs: 0 };
    await delay(resource.idleWindowMs);
    windows.baseline.endMs = now();
    monitor.setSampleInterval(resource.activeSampleIntervalMs);
    windows.active = { startMs: now(), endMs: 0 };
    for (const benchmarkCase of sequence) {
      const before = await monitor.sampleNow("before-switch");
      observations.push(...await executeSafely(driver, scenario, { request: benchmarkCase, cases: [benchmarkCase] }, { frameLogs }));
      const after = await monitor.sampleNow("after-switch");
      boundaries.push({
        case: benchmarkCase,
        switchSequence: boundaries.length + 1,
        beforeSampleIndex: monitor.samples.indexOf(before),
        afterSampleIndex: monitor.samples.indexOf(after),
      });
    }
    observations.push(...await executeSafely(driver, scenario, { request: RESOURCE_CONTROL_CASE, cases: [RESOURCE_CONTROL_CASE] }, { frameLogs }));
    windows.active.endMs = now();
    monitor.setSampleInterval(resource.idleSampleIntervalMs);
    await delay(resource.settleBeforeIdleMs);
    windows.ending = { startMs: now(), endMs: 0 };
    await delay(resource.idleWindowMs);
    windows.ending.endMs = now();
  } catch (error) {
    failure = publicError(error);
  } finally {
    if (monitor) {
      try {
        await monitor.stop();
      } catch (error) {
        failure = `Resource monitor cleanup failed: ${publicError(error)}`;
      }
    }
    if (launchAttempted) {
      const cleanup = await shutdownSafely(driver, group.groupId);
      if (!cleanup.valid) {
        failure = `Application cleanup failed: ${cleanup.reason}`;
        for (let index = firstObservation; index < observations.length; index += 1) observations[index] = invalidateForCleanup(observations[index], cleanup.reason);
      }
    }
  }
  const trace = {
    version: 1,
    samples: monitor?.samples ?? [],
    windows,
    boundaries,
    monitorErrors: (monitor?.errors ?? []).map((error) => ({ code: String(error.code ?? "monitor-error").slice(0, 80), message: publicError(error.message ?? error) })),
    failure,
  };
  return { trace, resources: deriveResourcesFromTrace(trace, scenario, observations) };
}

export function deriveResourcesFromTrace(trace, scenario, observations) {
  if (!trace || trace.version !== 1) return { status: "invalid", reason: "Raw resource trace is missing.", rawSampleCount: 0, trend: [] };
  const boundaryPoints = [];
  let reason = trace.failure;
  if (!reason) {
    for (const boundary of trace.boundaries) {
      try {
        const before = trace.samples[boundary.beforeSampleIndex];
        const after = trace.samples[boundary.afterSampleIndex];
        if (!before || !after) throw new Error("A resource boundary references a missing sample.");
        boundaryPoints.push(deriveBoundaryPoint(before, after, boundary.case, boundary.switchSequence, trace.samples));
      } catch (error) {
        reason = publicError(error);
        break;
      }
    }
  }
  const progressive = observations.filter((observation) => observation.case?.workload === "progressive-resource");
  const control = observations.find((observation) => observation.case?.workload === "resource-control");
  if (!reason && progressive.some((observation) => observation.status !== "valid")) reason = "One or more progressive resource actions were invalid.";
  if (!reason && control?.status !== "valid") reason = "The workload could not return to the control transcript.";
  if (!reason && (!trace.windows.baseline || !trace.windows.active || !trace.windows.ending)) reason = "A required resource window is missing.";
  if (!reason) {
    const resource = scenario.resourceMeasurement;
    const cadence = [
      validateCadence(trace.samples, [trace.windows.baseline], resource.idleSampleIntervalMs),
      validateCadence(trace.samples, [trace.windows.active], resource.activeSampleIntervalMs),
      validateCadence(trace.samples, [trace.windows.ending], resource.idleSampleIntervalMs),
    ].find((item) => !item.valid);
    if (cadence) reason = cadence.reason;
  }
  if (!reason && trace.monitorErrors.length > 0) reason = "The resource monitor reported an error.";
  if (!reason && trace.samples.some((sample) => sample.inaccessibleProcessCount > 0 || !sample.rootProcessFound || sample.missingExternalProcessCount > 0)) {
    reason = "The resource monitor could not observe the complete declared application process family.";
  }
  const windows = { ...trace.windows, valid: !reason, ...(reason ? { reason } : {}) };
  return summarizeResources(trace.samples, windows, boundaryPoints);
}

/**
 * Any invalid observation withholds every verdict row it belongs to, so a
 * later attempt at that row cannot change what is reported; it only costs the
 * driver's failure timeout again. The skipped case stays in the result as invalid.
 */
function withheldRowReason(kind, observations, benchmarkCase) {
  for (const row of verdictRows(kind, benchmarkCase)) {
    const earlier = observations.find((observation) => observation.status !== "valid" && verdictRows(kind, observation.case).some((other) => other.id === row.id));
    if (earlier) return `Not attempted: ${row.title} already has an invalid observation (${earlier.case.caseId}), so the row is withheld.`;
  }
  return null;
}

function skipWithheldGroup(kind, observations, group) {
  const reasons = group.cases.map((benchmarkCase) => withheldRowReason(kind, observations, benchmarkCase));
  if (reasons.some((reason) => reason === null)) return false;
  group.cases.forEach((benchmarkCase, index) => observations.push(invalidObservation(benchmarkCase, reasons[index])));
  return true;
}

async function executeSafely(driver, scenario, action, extra) {
  try {
    const { frameLogs, ...requestExtra } = extra;
    const result = await driver.request("execute", { scenarioId: scenario.id, case: action.request, ...requestExtra }, 5 * 60_000);
    return observeExecution(frameLogs, scenario, action, result);
  } catch (error) {
    return action.cases.map((benchmarkCase) => invalidObservation(benchmarkCase, error));
  }
}

async function shutdownSafely(driver, context) {
  try {
    assertShutdown(await driver.request("shutdown", { reason: context }, 120_000));
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: publicError(error) };
  }
}

function invalidateForCleanup(observation, reason) {
  return { ...observation, status: "invalid", reason: `Application cleanup failed: ${reason}` };
}

function collectEnvironment() {
  const cpus = os.cpus();
  const power = collectPowerState();
  return {
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    logicalCpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverage1mPerCpu: Math.round((os.loadavg()[0] / Math.max(1, cpus.length)) * 1000) / 1000,
    ...power,
    nodeVersion: process.version,
  };
}

function collectPowerState() {
  if (process.platform !== "darwin") return { powerSource: "unknown", lowPowerMode: null, memoryPressureLevel: null };
  const battery = safeCommand("pmset", ["-g", "batt"]);
  const settings = safeCommand("pmset", ["-g", "custom"]);
  const pressure = Number(safeCommand("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]));
  return {
    powerSource: /AC Power/u.test(battery) ? "ac" : /Battery Power/u.test(battery) ? "battery" : "unknown",
    lowPowerMode: /\blowpowermode\s+1\b/u.test(settings) ? true : /\blowpowermode\s+0\b/u.test(settings) ? false : null,
    memoryPressureLevel: Number.isFinite(pressure) && pressure >= 0 ? pressure : null,
  };
}

function safeCommand(executable, args) {
  try {
    return execFileSync(executable, args, { encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 }).trim();
  } catch {
    return "";
  }
}

function assertShareable(serialized) {
  const value = JSON.parse(serialized);
  visitStrings(value, "", (text, key) => {
    if (hasAbsolutePath(text)) throw new Error("Public result contains an absolute path.");
    if ((/(?:token|secret|password|authorization|api[-_]?key)/i.test(key) && text.length >= 8)
      || /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/i.test(text)
      || /\b(?:token|secret|password|authorization|api[-_]?key)\s*[=:]\s*[^\s,;}]{8,}/i.test(text)) {
      throw new Error("Public result contains a credential-like value.");
    }
  });
}

function hasAbsolutePath(value) {
  return /\b[A-Za-z]:[\\/][^\s"'`]+/.test(value)
    || /(^|[\s("'`=:])\/(?:[^\s/"'`]+\/)*[^\s,"'`;)]*/m.test(value);
}

function visitStrings(value, key, visit) {
  if (typeof value === "string") {
    visit(value, key);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, key, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) visitStrings(child, childKey, visit);
  }
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

export async function validateResultFile(file) {
  const resultStat = await lstat(file);
  if (!resultStat.isFile() || resultStat.isSymbolicLink()) throw new Error("Result must be a regular file.");
  if (resultStat.size > MAX_RESULT_BYTES) throw new Error("Result exceeds the public size limit.");
  const bytes = await readFile(file);
  const serialized = bytes.toString("utf8");
  const result = JSON.parse(serialized);
  assertContract("result", result, file);
  assertShareable(serialized);
  const context = await registeredContextFromResult(result);
  validateObservationSchedule(context.scenario.value, result.runProfile, result.repetitions, result.observations);
  const summary = summarizeObservations(context.scenario.value, result.observations);
  if (digest(summary) !== result.derivation.summaryDigestSha256) throw new Error("Result summary digest does not match raw observations.");
  if (digest(summary) !== digest(result.derivation.summary)) throw new Error("Stored result summary does not match raw observations.");
  const resources = context.scenario.value.kind === "session-switch"
    ? deriveResourcesFromTrace(result.resourceTrace, context.scenario.value, result.observations)
    : null;
  if (digest(resources) !== digest(result.resources)) throw new Error("Stored resource summary does not match the raw resource trace.");
  if (path.basename(file) === "result.json") await validateAdjacentReport(file, result);
  return result;
}

async function validateAdjacentReport(resultFile, result) {
  const reportFile = path.join(path.dirname(resultFile), "report.md");
  let reportStat;
  try {
    reportStat = await lstat(reportFile);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!reportStat.isFile() || reportStat.isSymbolicLink()) throw new Error("Adjacent report must be a regular file.");
  if (await readFile(reportFile, "utf8") !== renderReport(result)) throw new Error("Adjacent report.md does not match deterministic regeneration.");
}

async function registeredContextFromResult(result) {
  const { readRegistered } = await import("./registry.mjs");
  const scenario = await readRegistered("scenario", result.scenario.id);
  if (scenario.digest !== result.scenario.digestSha256) throw new Error("Result scenario digest is not registered.");
  if (result.scenario.status !== scenario.status) throw new Error("Result scenario status is not registered.");
  const corpus = await readRegistered("corpus", result.corpus.id);
  if (scenario.value.corpusId !== corpus.value.id || corpus.digest !== result.corpus.definitionDigestSha256) throw new Error("Result corpus definition is not registered for its scenario.");
  if (result.corpus.status !== corpus.status) throw new Error("Result corpus status is not registered.");
  if (result.sourceEventFormat.id !== corpus.value.sourceEventFormat.id
    || result.sourceEventFormat.sourceRevision !== corpus.value.sourceEventFormat.sourceRevision) throw new Error("Result source-event identity is not registered.");
  const { eventSchemaDigest } = await import("./corpus.mjs");
  if (result.sourceEventFormat.schemaDigestSha256 !== eventSchemaDigest(corpus.value.sourceEventFormat.id)) throw new Error("Result source-event schema digest is not registered.");
  const artifact = await readRegistered("corpusArtifact", result.corpus.id);
  if (artifact.value.definitionDigestSha256 !== result.corpus.definitionDigestSha256
    || artifact.value.eventSchemaDigestSha256 !== result.sourceEventFormat.schemaDigestSha256
    || artifact.value.corpusDigestSha256 !== result.corpus.digestSha256
    || artifact.value.corpusDigestSha256 !== result.materialization.corpusDigestSha256) {
    throw new Error("Result corpus artifact identity is not canonical.");
  }
  const app = await readRegistered("app", result.app.id);
  if (!app.value.scenarios.includes(scenario.value.id)
    || !app.value.sourceEventFormats.includes(result.sourceEventFormat.id)
    || !app.value.materializationModes.includes(result.materialization.mode)) throw new Error("Result app identity is not registered for this scenario and materialization.");
  return { scenario, corpus, app };
}

function validateObservationSchedule(scenario, runProfile, repetitions, observations) {
  const expected = expandCases(scenario, runProfile, repetitions);
  if (scenario.kind === "session-switch") expected.push(...resourceCases(scenario));
  if (observations.length !== expected.length) throw new Error(`Result contains ${observations.length} observations; ${expected.length} are required.`);
  for (let index = 0; index < expected.length; index += 1) {
    if (digest(observations[index]?.case) !== digest(expected[index])) throw new Error(`Result observation ${index} does not match the required schedule.`);
  }
}
