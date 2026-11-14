import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveAppBinding, resolveResourceMonitor } from "./app-bindings.mjs";
import { startHostConditions } from "./host-conditions.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";
import { buildCorpus } from "./corpus.mjs";
import { readDefinition, readRegistered, recordingFileOf } from "./registry.mjs";
import { runBenchmark } from "./runner.mjs";

const execute = promisify(execFile);

/** The benchmark, in run order, on the public corpus. */
export const BENCHMARK_SCENARIO_IDS = Object.freeze(["app-start", "session-switch-walk", "new-thread", "long-thread", "typing-while-streaming"]);
const KIND_ORDER = ["app-start", "session-switch", "new-thread", "long-thread", "typing-while-streaming"];

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
 * AGENT_APP_BENCHMARK_STATE_CACHE and reuse it for the later scenarios.
 */
export async function runApp(plan) {
  if (plan.corpus.status === "public-comparable") await buildRegisteredCorpusOnce(plan.corpus, plan.corpusDirectory);
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

/** The registered corpus is built from its committed recording the first time a run needs it; the runner verifies it against the registered digests. */
async function buildRegisteredCorpusOnce(corpus, directory) {
  if (await stat(path.join(directory, "manifest.json")).then(() => true, () => false)) return;
  await buildCorpus(corpus.value, recordingFileOf(corpus.value.id), directory);
}

/** A private corpus keeps its scenario files, at most one of each kind, beside its definition. */
async function privateCorpusScenarios(folder, corpusId) {
  const scenarios = [];
  for (const file of (await readdir(folder)).filter((name) => name.endsWith(".json")).toSorted()) {
    const value = JSON.parse(await readFile(path.join(folder, file), "utf8"));
    if (value.corpusId === corpusId && value.kind) scenarios.push(await readDefinition("scenario", path.join(folder, file)));
  }
  const kinds = scenarios.map((scenario) => scenario.value.kind);
  if (scenarios.length === 0 || new Set(kinds).size !== kinds.length) {
    throw new Error(`Corpus ${corpusId} needs at most one scenario of each kind, and at least one, beside its definition in ${folder}; found ${scenarios.map((scenario) => scenario.value.id).join(", ") || "none"}.`);
  }
  return scenarios.toSorted((left, right) => KIND_ORDER.indexOf(left.value.kind) - KIND_ORDER.indexOf(right.value.kind));
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
