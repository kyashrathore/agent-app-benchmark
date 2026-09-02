import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { digest } from "./canonical-json.mjs";
import { buildLatencyGroups, buildPanelSwitchGroups, buildResourceSequence, buildResourceSequences, buildSessionNavigationGroups, buildWorkspacePanelGroups, expandCases, repetitionsFor } from "./cases.mjs";
import { assertContract } from "./contracts.mjs";
import { verifyCorpus, writeCorpus } from "./corpus.mjs";
import { DriverProcess } from "./driver-process.mjs";
import { assertHello, assertLaunch, assertPrepared, assertShutdown, normalizeExecution } from "./protocol.mjs";
import { renderReport } from "./report.mjs";
import { deriveBoundaryPoint, ResourceMonitor, validateCadence } from "./resource-monitor.mjs";
import { summarizeObservations, summarizeResourceRuns, summarizeResources } from "./summarize.mjs";
import { buildWorkspaceFixtureManifest } from "./workspace-fixture.mjs";

const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_ERROR_LENGTH = 512;

export async function runBenchmark(input, dependencies = {}) {
  const repetitions = repetitionsFor(input.scenario.value, input.runProfile, input.repetitions);
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
  let hello;
  let prepared;
  let corpus;
  let driver;
  let resources = null;
  let resourceTrace = null;
  try {
    corpus = input.corpusDirectory
      ? await verifyCorpus(input.corpusDirectory)
      : await writeCorpus(input.corpus.value, path.join(privateRunDirectory, "corpus"));
    assertCorpusIdentity(corpus, input.corpus);
    if (input.corpus.status === "public-comparable") await assertPublicCorpusArtifact(corpus, input.corpus.value.id);
    driver = await spawnDriver({ ...input.driver, cwd: input.driver.cwd ?? privateRunDirectory });
    hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), {
      appId: input.app.id,
      scenarioId: input.scenario.value.id,
      sourceEventFormatId: input.corpus.value.sourceEventFormat.id,
    });
    const panelScenario = ["session-navigation", "workspace-panel", "session-switch-workspace-panel"].includes(input.scenario.value.kind);
    const workspaceFixture = panelScenario ? buildWorkspaceFixtureManifest(input.scenario.value.cases.workspaceLoad, input.corpus.value.seed) : null;
    prepared = assertPrepared(await driver.request("prepare", {
      scenarioId: input.scenario.value.id,
      scenarioDigestSha256: input.scenario.digest,
      ...(workspaceFixture ? {
        scenarioDefinition: input.scenario.value,
        fixtureSeed: input.corpus.value.seed,
        workspaceFixtureManifest: workspaceFixture,
        workspaceFixtureDigestSha256: workspaceFixture.manifestDigestSha256,
      } : {}),
      corpusDirectory: corpus.path,
      corpusManifestPath: path.join(corpus.path, "manifest.json"),
      corpusDigestSha256: corpus.digestSha256,
      corpusDefinitionDigestSha256: input.corpus.digest,
      eventSchemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
      runDirectory: privateRunDirectory,
    }, 10 * 60_000), {
      corpusDigestSha256: corpus.digestSha256,
      eventSchemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
      materializationModes: hello.materializationModes,
      ...(workspaceFixture ? { workspaceFixtureDigestSha256: workspaceFixture.manifestDigestSha256 } : {}),
    });
    if (!input.app.materializationModes.includes(prepared.materializationMode)) throw new Error(`${input.app.id} is not registered for ${prepared.materializationMode} materialization.`);
    if (input.scenario.value.kind === "app-start") {
      await runAppStart({ driver, scenario: input.scenario.value, runProfile: input.runProfile, repetitions, prepared, observations });
    } else if (input.scenario.value.kind === "session-switch") {
      await runSessionLatency({ driver, scenario: input.scenario.value, runProfile: input.runProfile, repetitions, prepared, observations, seed: input.corpus.value.seed });
      const resourceRun = await runResourceWorkloads({
        driver,
        scenario: input.scenario.value,
        prepared,
        observations,
        seed: input.corpus.value.seed,
        resourceMonitor: input.resourceMonitor,
        startMonitor,
        delay,
        now,
        repetitions,
      });
      resources = resourceRun.resources;
      resourceTrace = resourceRun.trace;
    } else if (input.scenario.value.kind === "workspace-panel") {
      await runInteractiveGroups({
        driver,
        scenario: input.scenario.value,
        prepared,
        observations,
        groups: buildWorkspacePanelGroups(input.scenario.value, input.runProfile, repetitions),
        requireTrustedPointerStart: Boolean(input.scenario.value.cases.panelLoads),
      });
    } else if (input.scenario.value.kind === "session-navigation") {
      await runInteractiveGroups({
        driver,
        scenario: input.scenario.value,
        prepared,
        observations,
        groups: buildSessionNavigationGroups(input.scenario.value, input.runProfile, repetitions),
        requireRendererTrace: (benchmarkCase) => benchmarkCase.navigationType === "return-visited-panel-open",
        requireTimingEvidence: true,
        requireTrustedPointerStart: true,
      });
    } else if (input.scenario.value.kind === "session-switch-workspace-panel") {
      await runInteractiveGroups({ driver, scenario: input.scenario.value, prepared, observations, groups: buildPanelSwitchGroups(input.scenario.value, input.runProfile, input.corpus.value.seed, repetitions) });
    } else {
      throw new Error(`Unsupported scenario kind ${input.scenario.value.kind}.`);
    }
  } finally {
    if (driver) await driver.close();
    await rm(privateRunDirectory, { recursive: true, force: true });
  }
  const summary = summarizeObservations(input.scenario.value, observations);
  const result = {
    schemaVersion: 1,
    runId: input.runId ?? `${input.app.id}-${input.scenario.value.id}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    provenance: {
      kind: input.provenance ?? "community-self-attested",
      comparisonRunId: input.comparisonRunId ?? null,
      frameworkRevision: input.frameworkRevision ?? "working-tree",
      comparisonScheduleDigestSha256: input.comparisonScheduleDigestSha256 ?? null,
      scheduleOrdinal: input.scheduleOrdinal ?? null,
    },
    environment,
    app: hello.application,
    driver: hello.driver,
    sourceEventFormat: {
      id: input.corpus.value.sourceEventFormat.id,
      sourceRevision: input.corpus.value.sourceEventFormat.sourceRevision,
      schemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
    },
    materialization: {
      mode: prepared.materializationMode,
      corpusDigestSha256: prepared.corpusDigestSha256,
      mappingDigestSha256: prepared.mappingDigestSha256,
      ...(prepared.workspaceFixtureDigestSha256 ? { workspaceFixtureDigestSha256: prepared.workspaceFixtureDigestSha256 } : {}),
    },
    scenario: { id: input.scenario.value.id, kind: input.scenario.value.kind, digestSha256: input.scenario.digest, status: input.scenario.status },
    corpus: { id: input.corpus.value.id, definitionDigestSha256: input.corpus.digest, digestSha256: corpus.digestSha256, status: input.corpus.status },
    runProfile: input.runProfile,
    repetitions,
    observations,
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

function assertCorpusIdentity(generated, definition) {
  if (generated.manifest.corpusId !== definition.value.id
    || generated.manifest.definitionDigestSha256 !== definition.digest
    || generated.manifest.sourceEventFormat.id !== definition.value.sourceEventFormat.id
    || generated.manifest.sourceEventFormat.sourceRevision !== definition.value.sourceEventFormat.sourceRevision) {
    throw new Error("Prepared corpus does not match the selected corpus definition.");
  }
}

async function assertPublicCorpusArtifact(generated, corpusId) {
  const { readRegistered } = await import("./registry.mjs");
  const artifact = await readRegistered("corpusArtifact", corpusId);
  if (artifact.value.corpusDigestSha256 !== generated.digestSha256
    || artifact.value.definitionDigestSha256 !== generated.manifest.definitionDigestSha256
    || artifact.value.eventSchemaDigestSha256 !== generated.manifest.sourceEventFormat.schemaDigestSha256) {
    throw new Error("Generated public corpus does not match its registered canonical artifact identity.");
  }
}

async function runAppStart({ driver, scenario, runProfile, repetitions, prepared, observations }) {
  for (const benchmarkCase of expandCases(scenario, runProfile, undefined, repetitions)) {
    const index = observations.push(await executeSafely(driver, scenario.id, benchmarkCase, { stateHandle: prepared.stateHandles[benchmarkCase.stateHandle] })) - 1;
    const cleanup = await shutdownSafely(driver, benchmarkCase.caseId);
    if (!cleanup.valid) observations[index] = invalidateForCleanup(observations[index], cleanup.reason);
  }
}

async function runSessionLatency({ driver, scenario, runProfile, repetitions, prepared, observations, seed }) {
  for (const group of buildLatencyGroups(scenario, runProfile, seed, repetitions)) {
    let launchAttempted = false;
    let completed = 0;
    const firstObservation = observations.length;
    try {
      launchAttempted = true;
      assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: group.groupId }, 5 * 60_000), { requireProcessRoles: scenario.id.endsWith("-v3") });
      for (const benchmarkCase of group.cases) {
        observations.push(await executeSafely(driver, scenario.id, benchmarkCase));
        completed += 1;
      }
    } catch (error) {
      for (const benchmarkCase of group.cases.slice(completed)) {
        observations.push(invalidObservation(benchmarkCase, error));
      }
    } finally {
      if (launchAttempted) {
        const cleanup = await shutdownSafely(driver, group.groupId);
        if (!cleanup.valid) {
          for (let index = firstObservation; index < observations.length; index += 1) observations[index] = invalidateForCleanup(observations[index], cleanup.reason);
        }
      }
    }
  }
}

async function runInteractiveGroups({ driver, scenario, prepared, observations, groups, requireRendererTrace = () => true, requireTimingEvidence = false, requireTrustedPointerStart = false }) {
  for (const group of groups) {
    let launchAttempted = false;
    let completed = 0;
    const firstObservation = observations.length;
    try {
      launchAttempted = true;
      assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: group.groupId }, 5 * 60_000), { requireProcessRoles: true });
      for (const benchmarkCase of group.cases) {
        observations.push(await executeSafely(driver, scenario.id, benchmarkCase, {
          requireRendererTrace: requireRendererTrace(benchmarkCase),
          requireTimingEvidence,
          requireTrustedPointerStart,
        }));
        completed += 1;
      }
    } catch (error) {
      for (const benchmarkCase of group.cases.slice(completed)) observations.push(invalidObservation(benchmarkCase, error));
    } finally {
      if (launchAttempted) {
        const cleanup = await shutdownSafely(driver, group.groupId);
        if (!cleanup.valid) {
          for (let index = firstObservation; index < observations.length; index += 1) observations[index] = invalidateForCleanup(observations[index], cleanup.reason);
        }
      }
    }
  }
}

async function runResourceWorkloads(input) {
  const groups = input.scenario.cases.latencySamplesPerProcess
    ? buildResourceSequences(input.scenario, input.repetitions)
    : [{ groupId: "progressive-resource", repetition: 0, cases: buildResourceSequence(input.scenario) }];
  if (groups.length === 1 && !input.scenario.cases.latencySamplesPerProcess) {
    return runResourceWorkloadOnce({ ...input, group: groups[0] });
  }
  const runs = [];
  for (const group of groups) runs.push((await runResourceWorkloadOnce({ ...input, group, deferDerivation: true })).trace);
  const trace = { version: 2, runs };
  return { trace, resources: deriveResourcesFromTrace(trace, input.scenario, input.observations) };
}

async function runResourceWorkloadOnce({ driver, scenario, prepared, observations, resourceMonitor, startMonitor, delay, now, group, deferDerivation = false }) {
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
    const launch = assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: group.groupId }, 5 * 60_000), { requireProcessRoles: scenario.id.endsWith("-v3") });
    monitor = await startMonitor(path.resolve(resourceMonitor), launch.processes, resource.idleSampleIntervalMs);
    await delay(resource.settleBeforeIdleMs);
    windows.baseline = { startMs: now(), endMs: 0 };
    await delay(resource.idleWindowMs);
    windows.baseline.endMs = now();
    monitor.setSampleInterval(resource.activeSampleIntervalMs);
    windows.active = { startMs: now(), endMs: 0 };
    for (const benchmarkCase of sequence) {
      const before = await monitor.sampleNow("before-switch");
      const observation = await executeSafely(driver, scenario.id, benchmarkCase);
      observations.push(observation);
      const after = await monitor.sampleNow("after-switch");
      boundaries.push({
        case: benchmarkCase,
        switchSequence: boundaries.length + 1,
        beforeSampleIndex: monitor.samples.indexOf(before),
        afterSampleIndex: monitor.samples.indexOf(after),
      });
    }
    const controlCase = {
      caseId: group.repetition === 0 && !scenario.cases.latencySamplesPerProcess
        ? "progressive-resource-return-control"
        : `progressive-resource-return-control-${group.repetition}`,
      repetition: group.repetition,
      workload: "resource-control",
      destinationSessionId: "control",
    };
    const controlObservation = await executeSafely(driver, scenario.id, controlCase);
    observations.push(controlObservation);
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
    ...(scenario.cases.latencySamplesPerProcess ? { repetition: group.repetition } : {}),
    samples: monitor?.samples ?? [],
    windows,
    boundaries,
    monitorErrors: (monitor?.errors ?? []).map((error) => ({ code: String(error.code ?? "monitor-error").slice(0, 80), message: publicError(error.message ?? error) })),
    failure,
  };
  return { trace, resources: deferDerivation ? null : deriveResourcesFromTrace(trace, scenario, observations) };
}

export function deriveResourcesFromTrace(trace, scenario, observations) {
  if (trace?.version === 2 && Array.isArray(trace.runs)) {
    const derivedRuns = trace.runs.map((run) => deriveSingleResourceRun(
      run,
      scenario,
      observations.filter((observation) => observation.case?.repetition === run.repetition),
    ));
    const invalid = derivedRuns.find((run) => run.resources.status !== "valid");
    if (invalid) return invalid.resources;
    return summarizeResourceRuns(derivedRuns.map((run) => ({
      samples: run.trace.samples,
      windows: run.trace.windows,
      boundaryPoints: run.boundaryPoints,
      repetition: run.trace.repetition,
    })));
  }
  return deriveSingleResourceRun(trace, scenario, observations).resources;
}

function deriveSingleResourceRun(trace, scenario, observations) {
  if (!trace || trace.version !== 1) return {
    trace: trace ?? { samples: [] },
    boundaryPoints: [],
    resources: { status: "invalid", reason: "Raw resource trace is missing.", rawSampleCount: 0, trend: [] },
  };
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
  return { trace, boundaryPoints, resources: summarizeResources(trace.samples, windows, boundaryPoints) };
}

async function executeSafely(driver, scenarioId, benchmarkCase, extra = {}) {
  try {
    const { requireRendererTrace = false, requireTimingEvidence = false, requireTrustedPointerStart = false, ...requestExtra } = extra;
    const result = await driver.request("execute", { scenarioId, case: benchmarkCase, ...requestExtra }, 5 * 60_000);
    return normalizeExecution(result, benchmarkCase, { requireTimingEvidence: requireTimingEvidence || requireRendererTrace, requireRendererTrace, requireTrustedPointerStart });
  } catch (error) {
    return invalidObservation(benchmarkCase, error);
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

function invalidObservation(benchmarkCase, error) {
  return { case: benchmarkCase, status: "invalid", reason: publicError(error), receivedAt: new Date().toISOString() };
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

function publicError(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/\s+stderr:[\s\S]*$/i, "");
  message = message.replace(/\b[A-Za-z]:[\\/][^\s"'`]+/g, "[path]");
  message = message.replace(/(^|[\s("'`=:])\/(?:[^\s/"'`]+\/)*[^\s,"'`;)]*/gm, "$1[path]");
  message = message.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [credential]");
  message = message.replace(/\b(token|secret|password|authorization|api[-_]?key)\s*[=:]\s*[^\s,;}]{8,}/gi, "[credential redacted]");
  return (message.trim() || "Driver operation failed.").slice(0, MAX_PUBLIC_ERROR_LENGTH);
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
  validateObservationSchedule(context.scenario.value, result.runProfile, result.repetitions, context.corpus.value.seed, result.observations);
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
  if (["session-navigation", "workspace-panel", "session-switch-workspace-panel"].includes(scenario.value.kind)) {
    const fixture = buildWorkspaceFixtureManifest(scenario.value.cases.workspaceLoad, corpus.value.seed);
    if (result.materialization.workspaceFixtureDigestSha256 !== fixture.manifestDigestSha256) {
      throw new Error("Result workspace fixture attestation is not canonical.");
    }
  } else if (result.materialization.workspaceFixtureDigestSha256 !== undefined) {
    throw new Error("Result has a workspace fixture attestation for a scenario without a workspace fixture.");
  }
  const app = await readRegistered("app", result.app.id);
  if (!app.value.scenarios.includes(scenario.value.id)
    || !app.value.sourceEventFormats.includes(result.sourceEventFormat.id)
    || !app.value.materializationModes.includes(result.materialization.mode)) throw new Error("Result app identity is not registered for this scenario and materialization.");
  return { scenario, corpus, app };
}

function validateObservationSchedule(scenario, runProfile, repetitions, seed, observations) {
  const expected = expandCases(scenario, runProfile, seed, repetitions);
  if (scenario.kind === "session-switch") {
    if (scenario.cases.latencySamplesPerProcess) {
      for (const group of buildResourceSequences(scenario, repetitions)) {
        expected.push(...group.cases);
        expected.push({ caseId: `progressive-resource-return-control-${group.repetition}`, repetition: group.repetition, workload: "resource-control", destinationSessionId: "control" });
      }
    } else {
      expected.push(...buildResourceSequence(scenario, seed));
      expected.push({ caseId: "progressive-resource-return-control", workload: "resource-control", destinationSessionId: "control" });
    }
  }
  if (observations.length !== expected.length) throw new Error(`Result contains ${observations.length} observations; ${expected.length} are required.`);
  for (let index = 0; index < expected.length; index += 1) {
    if (digest(observations[index]?.case) !== digest(expected[index])) throw new Error(`Result observation ${index} does not match the required schedule.`);
    if (["session-navigation", "workspace-panel", "session-switch-workspace-panel"].includes(scenario.kind) && observations[index].status === "valid") {
      const requireRendererTrace = scenario.kind !== "session-navigation" || expected[index].navigationType === "return-visited-panel-open";
      const normalized = normalizeExecution({
        caseId: observations[index].case.caseId,
        durationMs: observations[index].durationMs,
        readiness: observations[index].readiness,
        clock: observations[index].clock,
        timingEvidence: observations[index].timingEvidence,
        rendererTrace: observations[index].rendererTrace,
      }, expected[index], {
        requireTimingEvidence: true,
        requireRendererTrace,
        requireTrustedPointerStart: scenario.kind === "session-navigation" || Boolean(scenario.cases.panelLoads),
      });
      if (normalized.status !== "valid") throw new Error(`Result observation ${index} has invalid renderer evidence: ${normalized.reason}`);
    }
  }
}
