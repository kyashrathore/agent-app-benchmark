import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./canonical-json.mjs";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function readRegistered(kind, id) {
  const directory = kind === "scenario" ? "scenarios" : kind === "corpus" ? "corpora" : "apps";
  const value = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "registry", directory, `${id}.json`), "utf8"));
  validateDefinition(kind, value);
  return { value, digest: digest(value), status: "public-comparable" };
}

export async function readDefinition(kind, input) {
  if (!input.includes("/") && !input.endsWith(".json")) return readRegistered(kind, input);
  const value = JSON.parse(await readFile(path.resolve(input), "utf8"));
  validateDefinition(kind, value);
  try {
    const registered = await readRegistered(kind, value.id);
    if (registered.digest === digest(value)) return registered;
  } catch {}
  return { value, digest: digest(value), status: "custom" };
}

export function validateDefinition(kind, value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error(`${kind} must use schemaVersion 1.`);
  const idPattern = kind === "app" ? /^[a-z][a-z0-9-]*$/ : /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/;
  if (typeof value.id !== "string" || !idPattern.test(value.id)) throw new Error(`${kind} has an invalid id.`);
  if (kind === "scenario") {
    if (!new Set(["app-start", "session-switch", "custom"]).has(value.kind)) throw new Error("Scenario kind is invalid.");
    if (!Array.isArray(value.metrics) || value.metrics.length === 0) throw new Error("Scenario must declare metrics.");
    if (!value.runProfiles || !Number.isInteger(value.runProfiles.smoke) || !Number.isInteger(value.runProfiles.publication)) throw new Error("Scenario run profiles are invalid.");
  }
  if (kind === "corpus") {
    if (value.generator !== "deterministic-transcript-v1") throw new Error("Corpus generator is invalid.");
    if (!Array.isArray(value.transcriptBytes) || value.transcriptBytes.some((bytes) => !Number.isInteger(bytes) || bytes <= 0)) throw new Error("Corpus transcript bytes are invalid.");
  }
  return value;
}

export async function validateRegistry() {
  const result = [];
  for (const [kind, directory] of [["scenario", "scenarios"], ["corpus", "corpora"], ["app", "apps"]]) {
    const files = (await readdir(path.join(REPOSITORY_ROOT, "registry", directory))).filter((file) => file.endsWith(".json")).toSorted();
    for (const file of files) {
      const id = file.slice(0, -5);
      const registered = await readRegistered(kind, id);
      if (registered.value.id !== id) throw new Error(`${file} id does not match its filename.`);
      result.push({ kind, id, digest: registered.digest });
    }
  }
  return result;
}
