import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveAppBinding, resolveResourceMonitor } from "./app-bindings.mjs";
import { startHostConditions } from "./host-conditions.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";
import { readDefinition, readRegistered } from "./registry.mjs";
import { runBenchmark } from "./runner.mjs";

const execute = promisify(execFile);

/** The benchmark: app start, then the list walk with its memory and idle windows, on the public corpus. */
export const BENCHMARK_SCENARIO_IDS = Object.freeze(["app-start", "session-switch-walk"]);

export async function planAppRun(options) {
  const appId = options.app;
  if (!appId) throw new Error("--app is required.");
  const app = await readRegistered("app", appId);
  if (Boolean(options.corpusDefinition) !== Boolean(options.corpusDirectory)) {
    throw new Error("A private corpus needs both --corpus-definition and --corpus-directory.");
  }
  const corpus = options.corpusDefinition
    ? await readDefinition("corpus", path.resolve(options.corpusDefinition))
    : await readRegistered("corpus", (await readRegistered("scenario", BENCHMARK_SCENARIO_IDS[0])).value.corpusId);
  const scenarios = options.corpusDefinition
    ? await privateCorpusScenarios(path.dirname(path.resolve(options.corpusDefinition)), corpus.value.id)
    : await Promise.all(BENCHMARK_SCENARIO_IDS.map((id) => readRegistered("scenario", id)));
  for (const scenario of scenarios) {
    if (scenario.status === "public-comparable" && !app.value.scenarios.includes(scenario.value.id)) {
      throw new Error(`${app.value.name} is not registered for ${scenario.value.id}.`);
    }
  }
  const driver = options.driver
    ? { executable: path.resolve(options.driver), args: options.driverArgs ?? [], env: options.driverEnv ?? {} }
    : spawnOptions(await resolveAppBinding(appId, options), options.driverEnv);
  const corpusDirectory = options.corpusDirectory
    ? path.resolve(options.corpusDirectory)
    : path.join(REPOSITORY_ROOT, "artifacts/corpora", corpus.value.id);
  return {
    app: app.value,
    scenarios,
    corpus,
    corpusDirectory,
    driver,
    runProfile: options.runProfile ?? "publication",
    repetitions: options.repetitions,
    resourceMonitor: await resolveResourceMonitor(options.resourceMonitor),
    outputRoot: path.resolve(options.output ?? path.join(REPOSITORY_ROOT, "artifacts/runs", `${appId}-${new Date().toISOString().replace(/[:.]/gu, "-")}`)),
    frameworkRevision: options.frameworkRevision ?? await frameworkRevision(),
  };
}

/**
 * Runs each scenario in order in its own sealed result directory, with host
 * conditions logged beside them. The driver may materialize the corpus once in
 * AGENT_APP_BENCHMARK_STATE_CACHE and reuse it for the second scenario.
 */
export async function runApp(plan) {
  await mkdir(plan.outputRoot, { recursive: true, mode: 0o700 });
  const host = await startHostConditions(plan.outputRoot, { applicationPaths: applicationPaths(plan.driver) });
  const stateCache = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-state-cache-"));
  const driver = { ...plan.driver, env: { ...plan.driver.env, AGENT_APP_BENCHMARK_STATE_CACHE: stateCache } };
  const results = [];
  try {
    for (const scenario of plan.scenarios) {
      await host.step({ scenarioId: scenario.value.id });
      const output = path.join(plan.outputRoot, scenario.value.id);
      await runBenchmark({
        driver,
        app: plan.app,
        scenario,
        corpus: plan.corpus,
        runProfile: plan.runProfile,
        repetitions: plan.repetitions,
        resourceMonitor: scenario.value.kind === "session-switch" ? plan.resourceMonitor : undefined,
        corpusDirectory: plan.corpusDirectory,
        output,
        runId: `${plan.app.id}-${scenario.value.id}-${Date.now()}`,
        frameworkRevision: plan.frameworkRevision,
      });
      results.push(path.join(output, "result.json"));
    }
  } finally {
    await host.stop();
    await rm(stateCache, { recursive: true, force: true });
  }
  return results;
}

/** A private corpus keeps its app-start and session-switch scenario files beside its definition. */
async function privateCorpusScenarios(folder, corpusId) {
  const scenarios = [];
  for (const file of (await readdir(folder)).filter((name) => name.endsWith(".json")).toSorted()) {
    const value = JSON.parse(await readFile(path.join(folder, file), "utf8"));
    if (value.corpusId === corpusId && value.kind) scenarios.push(await readDefinition("scenario", path.join(folder, file)));
  }
  const byKind = (kind) => scenarios.filter((scenario) => scenario.value.kind === kind);
  if (byKind("app-start").length !== 1 || byKind("session-switch").length !== 1) {
    throw new Error(`Corpus ${corpusId} needs exactly one app-start and one session-switch scenario beside its definition in ${folder}; found ${scenarios.map((scenario) => scenario.value.id).join(", ") || "none"}.`);
  }
  return [byKind("app-start")[0], byKind("session-switch")[0]];
}

function spawnOptions(binding, extraEnv = {}) {
  return { executable: binding.driver, args: binding.args, env: { ...binding.env, ...extraEnv }, cwd: binding.cwd };
}

function applicationPaths(driver) {
  return Object.entries(driver.env).filter(([name]) => name.endsWith("_BENCHMARK_EXECUTABLE")).map(([, value]) => value);
}

/** The framework commit, marked when the working tree differs from it, so the verdict can refuse runs from different code. */
async function frameworkRevision() {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT }),
    execute("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPOSITORY_ROOT }),
  ]);
  return `${head.trim()}${status.trim() ? "-modified" : ""}`;
}
