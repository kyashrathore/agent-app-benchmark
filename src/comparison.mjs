import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { digest, digestBytes } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { resolveRealFileInside } from "./paths.mjs";
import { readRegistered } from "./registry.mjs";
import { validateResultFile } from "./runner.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_COMPARISON_ENTRIES = 64;
const MAX_COMPARISON_BYTES = 256 * 1024 * 1024;

export async function loadComparison(manifestFile) {
  const file = path.resolve(manifestFile);
  const manifestStat = await lstat(file);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Comparison manifest must be a regular file.");
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("Comparison manifest exceeds the public size limit.");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  assertContract("comparison", manifest, "comparison manifest");
  if (manifest.results.length > MAX_COMPARISON_ENTRIES) throw new Error(`Comparison contains more than ${MAX_COMPARISON_ENTRIES} results.`);
  const policy = manifest.policy ?? "balanced-mirrored";
  const root = path.dirname(file);
  const allowedRoot = path.basename(path.dirname(root)) === "comparisons" ? path.dirname(path.dirname(root)) : root;
  const identities = new Set();
  const results = [];
  let aggregateBytes = 0;
  for (const entry of manifest.results) {
    const identity = `${entry.appId}:${entry.scenarioId}`;
    if (identities.has(identity)) throw new Error(`Comparison contains duplicate result ${identity}.`);
    identities.add(identity);
    const resultFile = await resolveRealFileInside(allowedRoot, path.resolve(root, entry.path), "comparison result path");
    const stat = await lstat(resultFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${entry.path} must be a regular result file.`);
    if (stat.size > MAX_RESULT_BYTES) throw new Error(`${entry.path} exceeds the public result size limit.`);
    aggregateBytes += stat.size;
    if (aggregateBytes > MAX_COMPARISON_BYTES) throw new Error("Comparison results exceed the aggregate public size limit.");
    const bytes = await readFile(resultFile);
    if (digestBytes(bytes) !== entry.digestSha256) throw new Error(`${entry.path} digest does not match the comparison manifest.`);
    const result = await validateResultFile(resultFile);
    if (result.app.id !== entry.appId || result.scenario.id !== entry.scenarioId) throw new Error(`${entry.path} identity does not match its comparison entry.`);
    if (result.scenario.status !== "public-comparable" || result.corpus.status !== "public-comparable") throw new Error(`${entry.path} is custom/non-comparable and cannot be published in a comparison.`);
    if (result.provenance.kind !== manifest.provenance) throw new Error(`${entry.path} provenance does not match the comparison manifest.`);
    if (policy === "balanced-mirrored" && result.provenance.comparisonRunId !== manifest.id) throw new Error(`${entry.path} comparison run id does not match the comparison manifest.`);
    const appDefinition = (await readRegistered("app", result.app.id)).value;
    results.push({ entry, result, file: resultFile, appDefinition });
  }
  if (policy === "balanced-mirrored") validatePairedSchedule(results);
  else validateIndependentRuns(results);
  return { manifest, file, results, policy, compatibility: compatibilityByScenario(results, policy) };
}

/**
 * An assembled comparison pairs results from independently sealed runs: each
 * application ran its scenarios in its own process on the same host, and any
 * application can be added or rerun without touching the others. Ordering is
 * not counterbalanced, so the run timestamps are disclosed instead.
 */
export function validateIndependentRuns(results) {
  assertSharedComparisonRepetitions(results);
  const frameworkRevisions = new Set(results.map((item) => item.result.provenance.frameworkRevision));
  if (frameworkRevisions.size > 1) throw new Error("Assembled comparison results do not share one framework revision.");
  const runProfiles = new Set(results.map((item) => item.result.runProfile));
  if (runProfiles.size > 1) throw new Error("Assembled comparison results do not share one run profile.");
  const perApp = Map.groupBy(results, (item) => item.result.app.id);
  if (perApp.size < 2) throw new Error("An assembled comparison requires at least two applications.");
}

export function validatePairedSchedule(results) {
  assertSharedComparisonRepetitions(results);
  const scenarioCounts = Map.groupBy(results, (item) => item.result.scenario.id);
  if (scenarioCounts.size < 2 || [...scenarioCounts.values()].some((members) => members.length < 2)) return;
  if (scenarioCounts.size % 2 !== 0) throw new Error("A balanced mirrored comparison requires an even number of scenarios.");
  const kindIds = Map.groupBy(results, (item) => item.result.scenario.kind);
  if ([...kindIds.values()].some((members) => new Set(members.map((item) => item.result.scenario.id)).size > 1)) {
    throw new Error("Comparison cannot mix scenario versions for the same scenario kind.");
  }
  const ordered = [...results].toSorted((left, right) => left.result.provenance.scheduleOrdinal - right.result.provenance.scheduleOrdinal);
  const steps = ordered.map((item, index) => ({ ordinal: index + 1, appId: item.result.app.id, scenarioId: item.result.scenario.id }));
  if (ordered.some((item, index) => item.result.provenance.scheduleOrdinal !== index + 1)) throw new Error("Comparison schedule ordinals must be unique and contiguous.");
  const scenarioIds = [...new Set(steps.map((step) => step.scenarioId))];
  const [firstId] = scenarioIds;
  const firstSteps = steps.filter((step) => step.scenarioId === firstId);
  const apps = firstSteps.map((step) => step.appId);
  const invalidScenario = scenarioIds.some((scenarioId) => {
    const scenarioSteps = steps.filter((step) => step.scenarioId === scenarioId);
    return scenarioSteps.length !== apps.length
      || new Set(scenarioSteps.map((step) => step.appId)).size !== apps.length
      || scenarioSteps.some((step) => !apps.includes(step.appId));
  });
  if (new Set(apps).size !== apps.length || apps.length < 2 || invalidScenario) {
    throw new Error("Comparison scenarios must contain the same distinct applications exactly once.");
  }
  const expected = scenarioIds.flatMap((scenarioId, scenarioIndex) => {
    const orderedApps = scenarioIndex % 2 === 0 ? apps : [...apps].reverse();
    return orderedApps.map((appId) => ({ appId, scenarioId }));
  }).map((step, index) => ({ ordinal: index + 1, ...step }));
  if (digest(steps) !== digest(expected)) throw new Error("Comparison does not follow the balanced mirrored schedule.");
  const versions = scenarioIds.map((id) => Number(id.match(/-v(\d+)$/)?.[1] ?? 1));
  const version = new Set(versions).size === 1 ? versions[0] : 1;
  const schedule = { version, policy: `balanced-mirrored-v${version}`, steps };
  const scheduleDigest = digest(schedule);
  if (ordered.some((item) => item.result.provenance.comparisonScheduleDigestSha256 !== scheduleDigest)) throw new Error("Comparison schedule digest does not match its results.");
}

export function assertSharedComparisonRepetitions(results) {
  const repetitions = new Set(results.map((item) => item.result.repetitions));
  if (repetitions.size > 1) {
    throw new Error("Comparison results do not share one repetition count.");
  }
}

export function compatibilityByScenario(results, policy = "balanced-mirrored") {
  const output = {};
  for (const scenarioId of new Set(results.map((item) => item.result.scenario.id))) {
    const members = results.filter((item) => item.result.scenario.id === scenarioId);
    if (members.length < 2) {
      output[scenarioId] = { status: "unpaired", reason: "At least two results are required for a side-by-side comparison." };
      continue;
    }
    const keys = members.map((item) => compatibilityKey(item.result, policy));
    const compatible = new Set(keys).size === 1 && members.every((item) => item.result.scenario.status === "public-comparable" && item.result.corpus.status === "public-comparable");
    output[scenarioId] = {
      status: compatible ? "valid" : "incompatible",
      reason: compatible ? undefined : "Results do not share the same comparison run, framework, scenario, corpus, run profile, repetition count, and environment identities.",
    };
  }
  return output;
}

function compatibilityKey(result, policy) {
  return digest({
    // Independent runs are paired on framework, scenario, corpus, profile, and
    // host identity only; the sealed schedule identity is a mirrored-run concept.
    comparisonRunId: policy === "balanced-mirrored" ? result.provenance.comparisonRunId : null,
    comparisonScheduleDigestSha256: policy === "balanced-mirrored" ? result.provenance.comparisonScheduleDigestSha256 : null,
    frameworkRevision: result.provenance.frameworkRevision,
    scenario: result.scenario.digestSha256,
    corpus: result.corpus.digestSha256,
    sourceEventSchema: result.sourceEventFormat.schemaDigestSha256,
    runProfile: result.runProfile,
    repetitions: result.repetitions,
    environment: {
      platform: result.environment.platform,
      architecture: result.environment.architecture,
      osRelease: result.environment.osRelease,
      logicalCpuCount: result.environment.logicalCpuCount,
      cpuModel: result.environment.cpuModel,
      totalMemoryBytes: result.environment.totalMemoryBytes,
      nodeVersion: result.environment.nodeVersion,
      guiFramework: result.environment.guiFramework,
      powerSource: result.environment.powerSource,
      lowPowerMode: result.environment.lowPowerMode,
    },
  });
}
