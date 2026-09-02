import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestBytes } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { loadComparison } from "./comparison.mjs";
import { validateResultFile } from "./runner.mjs";

/**
 * Assembles a comparison from independently sealed per-application runs. Each
 * result file is validated, copied under the comparison root as
 * `runs/<app>/<scenario>/result.json`, and recorded with its digest, so the
 * manifest is immutable and self-contained exactly like a scheduled run. The
 * `independent-runs` policy tells loaders and the site that ordering was not
 * counterbalanced and that each result's own run provenance applies.
 */
export async function assembleComparison(input) {
  if (!Array.isArray(input.results) || input.results.length < 2) throw new Error("An assembled comparison requires at least two result files.");
  const outputRoot = path.resolve(input.outputRoot);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const entries = [];
  const identities = new Set();
  for (const file of input.results) {
    const source = path.resolve(file);
    const result = await validateResultFile(source);
    const identity = `${result.app.id}:${result.scenario.id}`;
    if (identities.has(identity)) throw new Error(`Assembled comparison received ${identity} twice.`);
    identities.add(identity);
    if (result.provenance.kind !== input.provenance) throw new Error(`${file} provenance ${result.provenance.kind} does not match the comparison provenance ${input.provenance}.`);
    const target = path.join(outputRoot, "runs", result.app.id, result.scenario.id, "result.json");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await cp(source, target, { errorOnExist: true, force: false });
    entries.push({
      appId: result.app.id,
      scenarioId: result.scenario.id,
      path: path.relative(outputRoot, target),
      digestSha256: digestBytes(await readFile(target)),
    });
  }
  const manifest = {
    schemaVersion: 1,
    id: input.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    provenance: input.provenance,
    policy: "independent-runs",
    results: entries,
  };
  assertContract("comparison", manifest, "assembled comparison manifest");
  const manifestFile = path.join(outputRoot, "comparison.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  // Load it back through the public path so an unpairable assembly fails here.
  const loaded = await loadComparison(manifestFile);
  return { outputRoot, manifestFile, manifest, compatibility: loaded.compatibility };
}
