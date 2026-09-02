import path from "node:path";
import { readDefinition, readRegistered } from "./registry.mjs";
import { runBenchmark } from "./runner.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";
import {
  defaultStamp,
  detectHostLabel,
  gitHead,
  resolveAppBinding,
  resolveOptionalCorpusDirectory,
  resolveResourceMonitor,
  resolveRunProfile,
  supportedAppIds,
} from "./app-bindings.mjs";

const DEFAULT_SCENARIO_IDS = Object.freeze([
  "app-start-v4",
  "session-switch-v4",
  "session-navigation-v2",
  "workspace-panel-v3",
]);

export function normalizeScenarioIds(values = []) {
  const ids = [];
  for (const value of values) {
    if (value == null) continue;
    for (const part of String(value).split(",")) {
      const trimmed = part.trim();
      if (trimmed) ids.push(trimmed);
    }
  }
  return [...new Set(ids)];
}

export async function buildRunPlan(options = {}) {
  const appId = options.app;
  if (!appId) throw new Error("--app is required.");
  if (!supportedAppIds().includes(appId)) {
    throw new Error(`Unsupported --app "${appId}". Supported: ${supportedAppIds().join(", ")}.`);
  }

  const scenarioIds = normalizeScenarioIds(options.scenarioIds ?? []);
  const resolvedScenarios = scenarioIds.length > 0 ? scenarioIds : [...DEFAULT_SCENARIO_IDS];
  const { runProfile, repetitions } = resolveRunProfile(options.runProfile, options.repetitions);
  const host = await detectHostLabel(options.hostLabel);
  const stamp = options.stamp ?? defaultStamp();
  const scenarioLabel = resolvedScenarios.length === 1 ? resolvedScenarios[0] : "multi";
  const id = options.id ?? `${appId}-${scenarioLabel}-${host.id}-${stamp}`;
  const frameworkRevision = options.frameworkRevision ?? await gitHead();
  const scenarioDefs = [];
  for (const scenarioId of resolvedScenarios) {
    scenarioDefs.push(await readDefinition("scenario", scenarioId));
  }
  const needsResourceMonitor = scenarioDefs.some((scenario) => scenario.value.kind === "session-switch");
  const resourceMonitor = needsResourceMonitor || options.resourceMonitor
    ? await resolveResourceMonitor(options.resourceMonitor)
    : undefined;
  const corpusDirectory = await resolveOptionalCorpusDirectory(options.corpusDirectory);
  const outputRoot = path.resolve(
    options.outputRoot
      ?? path.join(REPOSITORY_ROOT, "artifacts/runs", id),
  );
  const binding = await resolveAppBinding(appId, options);

  return {
    id,
    appId,
    scenarioIds: resolvedScenarios,
    runProfile,
    repetitions,
    binding,
    resourceMonitor,
    corpusDirectory,
    outputRoot,
    frameworkRevision,
    provenance: options.provenance ?? "community-self-attested",
    host,
    defaultedScenarios: scenarioIds.length === 0,
  };
}

export function serializeRunPlan(plan) {
  return {
    id: plan.id,
    app: plan.appId,
    scenarioIds: plan.scenarioIds,
    runProfile: plan.runProfile,
    repetitions: plan.repetitions,
    outputRoot: plan.outputRoot,
    frameworkRevision: plan.frameworkRevision,
    provenance: plan.provenance,
    host: plan.host,
    resourceMonitor: plan.resourceMonitor ?? null,
    corpusDirectory: plan.corpusDirectory ?? null,
    defaultedScenarios: plan.defaultedScenarios,
    binding: {
      id: plan.binding.id,
      root: plan.binding.root,
      runtime: plan.binding.runtime,
      driverPath: plan.binding.driverPath,
      executable: plan.binding.executable,
      cwd: plan.binding.cwd,
      env: plan.binding.env,
    },
  };
}

export async function executeRunPlan(plan) {
  const app = await readRegistered("app", plan.appId);
  const results = [];
  for (const scenarioId of plan.scenarioIds) {
    const scenario = await readDefinition("scenario", scenarioId);
    const corpus = await readDefinition("corpus", scenario.value.corpusId);
    if (scenario.value.corpusId !== corpus.value.id) {
      throw new Error(`${scenario.value.id} requires corpus ${scenario.value.corpusId}.`);
    }
    if (scenario.status === "public-comparable" && !app.value.scenarios.includes(scenario.value.id)) {
      throw new Error(`${app.value.name} is not registered for ${scenario.value.id}.`);
    }
    const output = plan.scenarioIds.length === 1
      ? plan.outputRoot
      : path.join(plan.outputRoot, scenarioId);
    await runBenchmark({
      driver: {
        executable: plan.binding.driver,
        args: plan.binding.args,
        env: plan.binding.env,
        cwd: plan.binding.cwd,
      },
      app: app.value,
      scenario,
      corpus,
      runProfile: plan.runProfile,
      repetitions: plan.repetitions,
      resourceMonitor: scenario.value.kind === "session-switch" ? plan.resourceMonitor : undefined,
      corpusDirectory: plan.corpusDirectory,
      output,
      runId: `${plan.id}-${scenarioId}`,
      frameworkRevision: plan.frameworkRevision,
      provenance: plan.provenance,
    });
    results.push({
      scenarioId,
      output,
      resultFile: path.join(output, "result.json"),
      reportFile: path.join(output, "report.md"),
    });
  }
  return results;
}
