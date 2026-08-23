import { readFile, writeFile, mkdir, lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest, digestBytes } from "./canonical-json.mjs";
import { verifyCorpus, writeCorpus } from "./corpus.mjs";
import { readRegistered } from "./registry.mjs";
import { runBenchmark } from "./runner.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";

const execute = promisify(execFile);

export function buildComparisonSchedule(appIds, scenarioIds = ["app-start-v1", "session-switch-v1"]) {
  if (!Array.isArray(appIds) || appIds.length < 2 || new Set(appIds).size !== appIds.length) throw new Error("A comparison requires at least two distinct applications.");
  if (scenarioIds.length !== 2) throw new Error("V1 comparison scheduling requires exactly two scenarios.");
  const ordered = [appIds, [...appIds].reverse()];
  const steps = scenarioIds.flatMap((scenarioId, scenarioIndex) => ordered[scenarioIndex].map((appId) => ({ appId, scenarioId })));
  return { version: 1, policy: "balanced-mirrored-v1", steps: steps.map((step, index) => ({ ordinal: index + 1, ...step })) };
}

export async function runComparison(configFile) {
  const config = JSON.parse(await readFile(path.resolve(configFile), "utf8"));
  validateComparisonConfig(config);
  const { stdout: revision } = await execute("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT });
  if (revision.trim() !== config.frameworkRevision) throw new Error("Comparison frameworkRevision does not match the checked-out framework commit.");
  const outputRoot = path.resolve(config.outputRoot);
  await assertMissing(outputRoot);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const temporaryCorpusRoot = config.corpusDirectory ? null : await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-comparison-"));
  try {
    return await runScheduledComparison(config, outputRoot, config.corpusDirectory ? path.resolve(config.corpusDirectory) : path.join(temporaryCorpusRoot, "corpus"));
  } finally {
    if (temporaryCorpusRoot) await rm(temporaryCorpusRoot, { recursive: true, force: true });
  }
}

async function runScheduledComparison(config, outputRoot, corpusDirectory) {
  const corpus = await readRegistered("corpus", "opencode-completed-transcripts-v1");
  const preparedCorpus = config.corpusDirectory
    ? await verifyCorpus(corpusDirectory)
    : await writeCorpus(corpus.value, corpusDirectory);
  if (preparedCorpus.manifest.definitionDigestSha256 !== corpus.digest) throw new Error("Comparison corpus does not match the public definition.");

  const apps = new Map();
  for (const appConfig of config.apps) apps.set(appConfig.id, { config: appConfig, registered: await readRegistered("app", appConfig.id) });
  const schedule = buildComparisonSchedule(config.apps.map((app) => app.id));
  const scheduleDigestSha256 = digest(schedule);
  const resultEntries = [];
  for (const step of schedule.steps) {
    const scenario = await readRegistered("scenario", step.scenarioId);
    const app = apps.get(step.appId);
    const output = path.join(outputRoot, "runs", step.appId, step.scenarioId);
    await runBenchmark({
      driver: {
        executable: path.resolve(app.config.driver),
        args: app.config.args ?? [],
        env: app.config.env ?? {},
        cwd: app.config.cwd ? path.resolve(app.config.cwd) : undefined,
      },
      app: app.registered.value,
      scenario,
      corpus,
      corpusDirectory: preparedCorpus.path,
      runProfile: config.runProfile,
      repetitions: config.repetitions,
      resourceMonitor: step.scenarioId === "session-switch-v1" ? path.resolve(config.resourceMonitor) : undefined,
      output,
      runId: `${config.id}-${step.ordinal}-${step.appId}-${step.scenarioId}`,
      comparisonRunId: config.id,
      comparisonScheduleDigestSha256: scheduleDigestSha256,
      scheduleOrdinal: step.ordinal,
      frameworkRevision: config.frameworkRevision,
      provenance: config.provenance,
    });
    const resultFile = path.join(output, "result.json");
    resultEntries.push({
      appId: step.appId,
      scenarioId: step.scenarioId,
      path: path.relative(outputRoot, resultFile),
      digestSha256: digestBytes(await readFile(resultFile)),
    });
  }
  const manifest = {
    schemaVersion: 1,
    id: config.id,
    title: config.title,
    description: config.description,
    provenance: config.provenance,
    results: resultEntries,
  };
  await writeFile(path.join(outputRoot, "schedule.json"), `${JSON.stringify({ ...schedule, digestSha256: scheduleDigestSha256 }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(outputRoot, "comparison.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { outputRoot, manifest, schedule, scheduleDigestSha256 };
}

export function validateComparisonConfig(config) {
  const allowed = new Set(["id", "title", "description", "provenance", "frameworkRevision", "runProfile", "repetitions", "resourceMonitor", "corpusDirectory", "outputRoot", "apps"]);
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !allowed.has(key))) throw new Error("Comparison run config contains unsupported fields.");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.id ?? "")) throw new Error("Comparison run id is invalid.");
  if (typeof config.title !== "string" || config.title.length === 0 || config.title.length > 200) throw new Error("Comparison title is invalid.");
  if (typeof config.description !== "string" || config.description.length > 2000) throw new Error("Comparison description is invalid.");
  if (!["maintainer-observed", "community-self-attested"].includes(config.provenance)) throw new Error("Comparison provenance is invalid.");
  if (!/^[0-9a-f]{40}$/.test(config.frameworkRevision ?? "")) throw new Error("Comparison frameworkRevision must be an exact commit.");
  if (!["smoke", "quick", "publication"].includes(config.runProfile)) throw new Error("Comparison run profile is invalid.");
  if (config.repetitions !== undefined && (!Number.isInteger(config.repetitions) || config.repetitions < 1 || config.repetitions > 100)) throw new Error("Comparison repetitions must be an integer from 1 through 100.");
  if (typeof config.resourceMonitor !== "string" || typeof config.outputRoot !== "string") throw new Error("Comparison resourceMonitor and outputRoot are required.");
  if (!Array.isArray(config.apps)) throw new Error("Comparison apps are required.");
  buildComparisonSchedule(config.apps.map((app) => app?.id));
  for (const app of config.apps) {
    const keys = Object.keys(app ?? {});
    if (keys.some((key) => !["id", "driver", "args", "env", "cwd"].includes(key)) || typeof app.driver !== "string") throw new Error("Comparison app driver config is invalid.");
    if (app.args !== undefined && (!Array.isArray(app.args) || app.args.some((value) => typeof value !== "string"))) throw new Error("Comparison driver args are invalid.");
    if (app.env !== undefined && (typeof app.env !== "object" || Array.isArray(app.env) || Object.values(app.env).some((value) => typeof value !== "string"))) throw new Error("Comparison driver env is invalid.");
  }
}

async function assertMissing(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Comparison output already exists: ${target}.`);
}
