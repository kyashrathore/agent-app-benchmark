import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digest } from "./canonical-json.mjs";
import { buildLatencyGroups, buildResourceSequence, expandCases } from "./cases.mjs";
import { assertContract } from "./contracts.mjs";
import { verifyCorpus, writeCorpus } from "./corpus.mjs";
import { DriverProcess } from "./driver-process.mjs";
import { assertHello, assertLaunch, assertPrepared, assertShutdown, normalizeExecution } from "./protocol.mjs";
import { renderReport } from "./report.mjs";
import { deriveBoundaryPoint, ResourceMonitor, validateCadence } from "./resource-monitor.mjs";
import { summarizeObservations, summarizeResources } from "./summarize.mjs";

export async function runBenchmark(input, dependencies = {}) {
  const output = path.resolve(input.output);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, ".agent-app-benchmark-run"), "v1\n", { mode: 0o600 });
  const corpus = await writeCorpus(input.corpus.value, path.join(output, "corpus"));
  await verifyCorpus(corpus.path);
  const spawnDriver = dependencies.spawnDriver ?? DriverProcess.spawn;
  const driver = await spawnDriver({ ...input.driver, cwd: input.driver.cwd ?? output });
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const startMonitor = dependencies.startMonitor ?? ResourceMonitor.start;
  const observations = [];
  let hello;
  let prepared;
  let resources = null;
  try {
    hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), {
      appId: input.app.id,
      scenarioId: input.scenario.value.id,
      sourceEventFormatId: input.corpus.value.sourceEventFormat.id,
    });
    prepared = assertPrepared(await driver.request("prepare", {
      scenarioId: input.scenario.value.id,
      scenarioDigestSha256: input.scenario.digest,
      corpusDirectory: corpus.path,
      corpusManifestPath: path.join(corpus.path, "manifest.json"),
      corpusDigestSha256: corpus.digestSha256,
      corpusDefinitionDigestSha256: input.corpus.digest,
      eventSchemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
      runDirectory: output,
    }, 10 * 60_000), {
      corpusDigestSha256: corpus.digestSha256,
      eventSchemaDigestSha256: corpus.manifest.sourceEventFormat.schemaDigestSha256,
    });
    if (!input.app.materializationModes.includes(prepared.materializationMode)) throw new Error(`${input.app.id} is not registered for ${prepared.materializationMode} materialization.`);
    if (input.scenario.value.kind === "app-start") {
      await runAppStart({ driver, scenario: input.scenario.value, runProfile: input.runProfile, prepared, observations });
    } else {
      await runSessionLatency({ driver, scenario: input.scenario.value, runProfile: input.runProfile, prepared, observations, seed: input.corpus.value.seed });
      resources = await runResourceWorkload({
        driver,
        scenario: input.scenario.value,
        prepared,
        observations,
        seed: input.corpus.value.seed,
        resourceMonitor: input.resourceMonitor,
        startMonitor,
        delay,
        now,
      });
    }
  } finally {
    await driver.close();
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
    },
    environment: input.environment ?? collectEnvironment(),
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
    },
    scenario: { id: input.scenario.value.id, kind: input.scenario.value.kind, digestSha256: input.scenario.digest, status: input.scenario.status },
    corpus: { id: input.corpus.value.id, definitionDigestSha256: input.corpus.digest, digestSha256: corpus.digestSha256, status: input.corpus.status },
    runProfile: input.runProfile,
    observations,
    resources,
    derivation: { version: 1, summaryDigestSha256: digest(summary), summary },
  };
  assertContract("result", result, "result bundle");
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  assertShareable(serialized);
  await atomicWrite(path.join(output, "result.json"), serialized);
  await atomicWrite(path.join(output, "report.md"), renderReport(result));
  return result;
}

async function runAppStart({ driver, scenario, runProfile, prepared, observations }) {
  for (const benchmarkCase of expandCases(scenario, runProfile)) {
    observations.push(await executeSafely(driver, scenario.id, benchmarkCase, { stateHandle: prepared.stateHandles[benchmarkCase.stateHandle] }));
    await shutdownSafely(driver, observations, benchmarkCase.caseId);
  }
}

async function runSessionLatency({ driver, scenario, runProfile, prepared, observations, seed }) {
  for (const group of buildLatencyGroups(scenario, runProfile, seed)) {
    let launched = false;
    let completed = 0;
    try {
      assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: group.groupId }, 5 * 60_000));
      launched = true;
      for (const benchmarkCase of group.cases) {
        observations.push(await executeSafely(driver, scenario.id, benchmarkCase));
        completed += 1;
      }
    } catch (error) {
      for (const benchmarkCase of group.cases.slice(completed)) {
        observations.push(invalidObservation(benchmarkCase, error));
      }
    } finally {
      if (launched) await shutdownSafely(driver, observations, group.groupId);
    }
  }
}

async function runResourceWorkload({ driver, scenario, prepared, observations, seed, resourceMonitor, startMonitor, delay, now }) {
  if (!resourceMonitor) return { status: "invalid", reason: "No framework resource monitor executable was supplied.", rawSampleCount: 0, trend: [] };
  const resource = scenario.resourceMeasurement;
  const sequence = buildResourceSequence(scenario, seed);
  let monitor;
  let launched = false;
  const windows = { baseline: undefined, active: undefined, ending: undefined, valid: true };
  const boundaryPoints = [];
  try {
    const launch = assertLaunch(await driver.request("launch", { scenarioId: scenario.id, stateHandle: prepared.stateHandles.P1, initialSessionId: "control", groupId: "progressive-resource" }, 5 * 60_000));
    launched = true;
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
      try {
        boundaryPoints.push(deriveBoundaryPoint(before, after, benchmarkCase, boundaryPoints.length + 1, monitor.samples));
      } catch (error) {
        windows.valid = false;
        windows.reason = error.message;
      }
      if (observation.status !== "valid") {
        windows.valid = false;
        windows.reason = "One or more progressive resource actions were invalid.";
      }
    }
    const controlCase = { caseId: "progressive-resource-return-control", workload: "resource-control", destinationSessionId: "control" };
    const controlObservation = await executeSafely(driver, scenario.id, controlCase);
    observations.push(controlObservation);
    if (controlObservation.status !== "valid") {
      windows.valid = false;
      windows.reason = "The workload could not return to the control transcript.";
    }
    windows.active.endMs = now();
    monitor.setSampleInterval(resource.idleSampleIntervalMs);
    await delay(resource.settleBeforeIdleMs);
    windows.ending = { startMs: now(), endMs: 0 };
    await delay(resource.idleWindowMs);
    windows.ending.endMs = now();
    const baselineCadence = validateCadence(monitor.samples, [windows.baseline], resource.idleSampleIntervalMs);
    const activeCadence = validateCadence(monitor.samples, [windows.active], resource.activeSampleIntervalMs);
    const endingCadence = validateCadence(monitor.samples, [windows.ending], resource.idleSampleIntervalMs);
    const cadence = [baselineCadence, activeCadence, endingCadence].find((item) => !item.valid);
    if (cadence) {
      windows.valid = false;
      windows.reason = cadence.reason;
    }
    if (monitor.errors.length > 0) {
      windows.valid = false;
      windows.reason = "The resource monitor reported an error.";
    }
    return summarizeResources(monitor.samples, windows, boundaryPoints);
  } catch (error) {
    return { status: "invalid", reason: error.message, rawSampleCount: monitor?.samples.length ?? 0, trend: boundaryPoints };
  } finally {
    if (monitor) await monitor.stop();
    if (launched) await shutdownSafely(driver, observations, "progressive-resource");
  }
}

async function executeSafely(driver, scenarioId, benchmarkCase, extra = {}) {
  try {
    const result = await driver.request("execute", { scenarioId, case: benchmarkCase, ...extra }, 5 * 60_000);
    return normalizeExecution(result, benchmarkCase);
  } catch (error) {
    return invalidObservation(benchmarkCase, error);
  }
}

async function shutdownSafely(driver, observations, context) {
  try {
    assertShutdown(await driver.request("shutdown", { reason: context }, 120_000));
  } catch (error) {
    observations.push({ case: { caseId: `shutdown-${context}`, workload: "cleanup" }, status: "invalid", reason: error.message, receivedAt: new Date().toISOString() });
  }
}

function invalidObservation(benchmarkCase, error) {
  return { case: benchmarkCase, status: "invalid", reason: error instanceof Error ? error.message : String(error), receivedAt: new Date().toISOString() };
}

function collectEnvironment() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    logicalCpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  };
}

function assertShareable(serialized) {
  const forbidden = [process.env.HOME, process.env.USERPROFILE].filter((value) => typeof value === "string" && value.length > 3);
  for (const value of forbidden) {
    if (serialized.includes(value)) throw new Error("Public result contains an absolute user path.");
  }
  if (/(?:token|secret|password|authorization)["'=:\s]+[^,}\s]{8,}/i.test(serialized)) throw new Error("Public result contains a credential-like value.");
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

export async function validateResultFile(file) {
  const bytes = await readFile(file);
  const result = JSON.parse(bytes.toString("utf8"));
  assertContract("result", result, file);
  const summary = summarizeObservations(await scenarioFromResult(result), result.observations);
  if (digest(summary) !== result.derivation.summaryDigestSha256) throw new Error("Result summary digest does not match raw observations.");
  return result;
}

async function scenarioFromResult(result) {
  const { readRegistered } = await import("./registry.mjs");
  const scenario = await readRegistered("scenario", result.scenario.id);
  if (scenario.digest !== result.scenario.digestSha256) throw new Error("Result scenario digest is not registered.");
  return scenario.value;
}
