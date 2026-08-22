import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandCases } from "./cases.mjs";
import { writeCorpus } from "./corpus.mjs";
import { DriverProcess } from "./driver-process.mjs";
import { renderReport } from "./report.mjs";
import { ResourceMonitor } from "./resource-monitor.mjs";
import { summarizeCases, summarizeResources } from "./summarize.mjs";

export async function runBenchmark(input, dependencies = {}) {
  const output = path.resolve(input.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const corpusPath = path.join(output, "corpus.json");
  const corpus = await writeCorpus(input.corpus.value, corpusPath);
  const driver = await (dependencies.spawnDriver ?? DriverProcess.spawn)(path.resolve(input.driver));
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startMonitor = dependencies.startMonitor ?? ResourceMonitor.start;
  let hello;
  const completedCases = [];
  const resourceSamples = [];
  const resourceWindows = { baseline: [], active: [], ending: [], cases: [] };
  try {
    hello = await driver.request("hello", { frameworkVersion: 1 });
    assertHello(hello, input.scenario.value.id);
    const cases = expandCases(input.scenario.value, input.runProfile);
    if (input.scenario.value.kind === "app-start") {
      for (const benchmarkCase of cases) {
        const runDirectory = path.join(output, benchmarkCase.caseId);
        await driver.request("prepare", prepareParams(input, corpusPath, corpus, runDirectory, benchmarkCase.repetition));
        const measured = validateCaseResult(await driver.request("run-case", { scenarioId: input.scenario.value.id, case: benchmarkCase }), benchmarkCase);
        completedCases.push(measured);
        assertNoSurvivors(await driver.request("shutdown", { reason: "case-complete" }));
      }
    } else {
      if (!input.resourceMonitor) throw new Error("session-switch-v1 requires --resource-monitor.");
      for (let repetition = 0; repetition < input.scenario.value.runProfiles[input.runProfile]; repetition += 1) {
        const repetitionCases = cases.filter((item) => item.repetition === repetition);
        const runDirectory = path.join(output, `repetition-${repetition}`);
        await driver.request("prepare", prepareParams(input, corpusPath, corpus, runDirectory, repetition));
        const launched = await driver.request("launch", { scenarioId: input.scenario.value.id, initialSessionId: "workspace-a-source" });
        const root = validateLaunch(launched);
        const resource = input.scenario.value.resourceMeasurement;
        const monitor = await startMonitor(path.resolve(input.resourceMonitor), root, resource.idleSampleIntervalMs);
        await delay(resource.settleBeforeIdleMs);
        const baseline = { startMs: Date.now(), endMs: 0 };
        await delay(resource.idleWindowMs);
        baseline.endMs = Date.now();
        resourceWindows.baseline.push(baseline);
        monitor.setSampleInterval(resource.activeSampleIntervalMs);
        const active = { startMs: Date.now(), endMs: 0 };
        for (const benchmarkCase of repetitionCases) {
          const startMs = Date.now();
          const measured = validateCaseResult(await driver.request("run-case", { scenarioId: input.scenario.value.id, case: benchmarkCase }), benchmarkCase);
          const endMs = Date.now();
          completedCases.push(measured);
          resourceWindows.cases.push({ caseId: benchmarkCase.caseId, transcriptBytes: benchmarkCase.transcriptBytes, switchSequence: resourceWindows.cases.length + 1, startMs, endMs });
        }
        active.endMs = Date.now();
        resourceWindows.active.push(active);
        monitor.setSampleInterval(resource.idleSampleIntervalMs);
        await delay(resource.settleBeforeIdleMs);
        const ending = { startMs: Date.now(), endMs: 0 };
        await delay(resource.idleWindowMs);
        ending.endMs = Date.now();
        resourceWindows.ending.push(ending);
        resourceSamples.push(...monitor.samples);
        assertNoSurvivors(await driver.request("shutdown", { reason: "repetition-complete" }));
        await monitor.stop();
      }
    }
    const resources = input.scenario.value.kind === "session-switch" ? summarizeResources(resourceSamples, resourceWindows) : null;
    const result = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      app: hello.application,
      driver: hello.driver,
      scenario: { id: input.scenario.value.id, kind: input.scenario.value.kind, digestSha256: input.scenario.digest, status: input.scenario.status },
      corpus: { id: input.corpus.value.id, definitionDigestSha256: input.corpus.digest, digestSha256: corpus.digestSha256, status: input.corpus.status },
      runProfile: input.runProfile,
      cases: completedCases,
      summary: summarizeCases(input.scenario.value, completedCases),
      resources,
    };
    await writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(output, "report.md"), renderReport(result), { mode: 0o600 });
    if (resourceSamples.length > 0) await writeFile(path.join(output, "resources.ndjson"), `${resourceSamples.map((sample) => JSON.stringify(sample)).join("\n")}\n`, { mode: 0o600 });
    return result;
  } finally {
    await driver.close();
  }
}

function prepareParams(input, corpusPath, corpus, runDirectory, repetition) {
  return {
    scenario: input.scenario.value,
    scenarioDigestSha256: input.scenario.digest,
    corpusPath,
    corpusDigestSha256: corpus.digestSha256,
    runDirectory,
    repetition,
  };
}

function assertHello(hello, scenarioId) {
  if (!hello || hello.protocolVersion !== 1) throw new Error("Driver hello is invalid.");
  if (!hello.application?.name || !hello.application?.version || !hello.driver?.name || !hello.driver?.version || !hello.driver?.digestSha256) throw new Error("Driver identities are incomplete.");
  if (!hello.scenarios?.includes(scenarioId)) throw new Error(`Driver does not support ${scenarioId}.`);
}

function validateLaunch(launch) {
  const roots = launch?.processes?.filter((process) => process.owner === "application") ?? [];
  if (!launch?.ready || roots.length === 0) throw new Error("Driver launch did not return a ready application process root.");
  return roots[0];
}

function validateCaseResult(result, benchmarkCase) {
  if (!result || result.caseId !== benchmarkCase.caseId || !Number.isFinite(result.durationMs) || result.durationMs < 0) throw new Error(`Driver returned an invalid result for ${benchmarkCase.caseId}.`);
  if (result.validity?.status !== "valid" || !Array.isArray(result.validity.evidence) || result.validity.evidence.some((item) => item.passed !== true)) throw new Error(`Driver failed validity for ${benchmarkCase.caseId}.`);
  if (!Array.isArray(result.clock) || result.clock.length === 0 || result.clock.some((item) => item.endTimestamp < item.startTimestamp)) throw new Error(`Driver returned invalid clock evidence for ${benchmarkCase.caseId}.`);
  return { case: benchmarkCase, durationMs: result.durationMs, validity: result.validity, clock: result.clock };
}

function assertNoSurvivors(shutdown) {
  if (!shutdown || !Array.isArray(shutdown.survivors) || shutdown.survivors.length > 0) throw new Error("Driver shutdown left surviving processes.");
}
