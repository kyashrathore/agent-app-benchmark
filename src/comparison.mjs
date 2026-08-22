import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { digest, digestBytes } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { resolveInside } from "./paths.mjs";
import { validateResultFile } from "./runner.mjs";

export async function loadComparison(manifestFile) {
  const file = path.resolve(manifestFile);
  const manifest = JSON.parse(await readFile(file, "utf8"));
  assertContract("comparison", manifest, "comparison manifest");
  const root = path.dirname(file);
  const identities = new Set();
  const results = [];
  for (const entry of manifest.results) {
    const identity = `${entry.appId}:${entry.scenarioId}`;
    if (identities.has(identity)) throw new Error(`Comparison contains duplicate result ${identity}.`);
    identities.add(identity);
    const resultFile = resolveInside(root, entry.path, "comparison result path");
    const stat = await lstat(resultFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${entry.path} must be a regular result file.`);
    if (stat.size > 64 * 1024 * 1024) throw new Error(`${entry.path} exceeds the public result size limit.`);
    const bytes = await readFile(resultFile);
    if (digestBytes(bytes) !== entry.digestSha256) throw new Error(`${entry.path} digest does not match the comparison manifest.`);
    const result = await validateResultFile(resultFile);
    if (result.app.id !== entry.appId || result.scenario.id !== entry.scenarioId) throw new Error(`${entry.path} identity does not match its comparison entry.`);
    results.push({ entry, result, file: resultFile });
  }
  return { manifest, file, results, compatibility: compatibilityByScenario(results) };
}

export function compatibilityByScenario(results) {
  const output = {};
  for (const scenarioId of new Set(results.map((item) => item.result.scenario.id))) {
    const members = results.filter((item) => item.result.scenario.id === scenarioId);
    const keys = members.map((item) => compatibilityKey(item.result));
    const compatible = new Set(keys).size === 1 && members.every((item) => item.result.scenario.status === "public-comparable" && item.result.corpus.status === "public-comparable");
    output[scenarioId] = {
      status: compatible ? "valid" : "incompatible",
      reason: compatible ? undefined : "Results do not share the same comparison run, framework, scenario, corpus, run profile, and environment identities.",
    };
  }
  return output;
}

export function comparisonDigest(comparison) {
  return digest({ manifest: comparison.manifest, resultDigests: comparison.manifest.results.map((entry) => entry.digestSha256) });
}

function compatibilityKey(result) {
  return digest({
    comparisonRunId: result.provenance.comparisonRunId,
    frameworkRevision: result.provenance.frameworkRevision,
    scenario: result.scenario.digestSha256,
    corpus: result.corpus.digestSha256,
    sourceEventSchema: result.sourceEventFormat.schemaDigestSha256,
    runProfile: result.runProfile,
    environment: result.environment,
  });
}
