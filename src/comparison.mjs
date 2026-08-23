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
    if (result.provenance.comparisonRunId !== manifest.id) throw new Error(`${entry.path} comparison run id does not match the comparison manifest.`);
    const appDefinition = (await readRegistered("app", result.app.id)).value;
    results.push({ entry, result, file: resultFile, appDefinition });
  }
  validatePairedSchedule(results);
  return { manifest, file, results, compatibility: compatibilityByScenario(results) };
}

function validatePairedSchedule(results) {
  const scenarioCounts = Map.groupBy(results, (item) => item.result.scenario.id);
  if (["app-start-v1", "session-switch-v1"].some((id) => (scenarioCounts.get(id)?.length ?? 0) < 2)) return;
  const ordered = [...results].toSorted((left, right) => left.result.provenance.scheduleOrdinal - right.result.provenance.scheduleOrdinal);
  const steps = ordered.map((item, index) => ({ ordinal: index + 1, appId: item.result.app.id, scenarioId: item.result.scenario.id }));
  if (ordered.some((item, index) => item.result.provenance.scheduleOrdinal !== index + 1)) throw new Error("Comparison schedule ordinals must be unique and contiguous.");
  const apps = [...new Set(steps.filter((step) => step.scenarioId === "app-start-v1").map((step) => step.appId))];
  const expected = [
    ...apps.map((appId, index) => ({ ordinal: index + 1, appId, scenarioId: "app-start-v1" })),
    ...[...apps].reverse().map((appId, index) => ({ ordinal: apps.length + index + 1, appId, scenarioId: "session-switch-v1" })),
  ];
  if (digest(steps) !== digest(expected)) throw new Error("Comparison does not follow the balanced mirrored V1 schedule.");
  const schedule = { version: 1, policy: "balanced-mirrored-v1", steps };
  const scheduleDigest = digest(schedule);
  if (ordered.some((item) => item.result.provenance.comparisonScheduleDigestSha256 !== scheduleDigest)) throw new Error("Comparison schedule digest does not match its results.");
}

export function compatibilityByScenario(results) {
  const output = {};
  for (const scenarioId of new Set(results.map((item) => item.result.scenario.id))) {
    const members = results.filter((item) => item.result.scenario.id === scenarioId);
    if (members.length < 2) {
      output[scenarioId] = { status: "unpaired", reason: "At least two results are required for a side-by-side comparison." };
      continue;
    }
    const keys = members.map((item) => compatibilityKey(item.result));
    const compatible = new Set(keys).size === 1 && members.every((item) => item.result.scenario.status === "public-comparable" && item.result.corpus.status === "public-comparable");
    output[scenarioId] = {
      status: compatible ? "valid" : "incompatible",
      reason: compatible ? undefined : "Results do not share the same comparison run, framework, scenario, corpus, run profile, and environment identities.",
    };
  }
  return output;
}

function compatibilityKey(result) {
  return digest({
    comparisonRunId: result.provenance.comparisonRunId,
    comparisonScheduleDigestSha256: result.provenance.comparisonScheduleDigestSha256,
    frameworkRevision: result.provenance.frameworkRevision,
    scenario: result.scenario.digestSha256,
    corpus: result.corpus.digestSha256,
    sourceEventSchema: result.sourceEventFormat.schemaDigestSha256,
    runProfile: result.runProfile,
    environment: result.environment,
  });
}
