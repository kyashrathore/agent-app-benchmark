import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { digest } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";

const REGISTRY_DIRECTORIES = { app: "apps", corpus: "corpora", scenario: "scenarios" };
const CONTRACT_KINDS = { app: "app", corpus: "corpus", scenario: "scenario" };

export async function readRegistered(kind, id) {
  validateId(kind, id);
  const directory = REGISTRY_DIRECTORIES[kind];
  if (!directory) throw new Error(`Unknown registry kind: ${kind}.`);
  const file = path.join(REPOSITORY_ROOT, "registry", directory, `${id}.json`);
  const value = await readJsonFile(file, `registered ${kind} ${id}`);
  validateDefinition(kind, value);
  if (value.id !== id) throw new Error(`${kind} filename and id do not match.`);
  return { value, digest: digest(value), status: "public-comparable", file };
}

export async function readDefinition(kind, input) {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${kind} input is required.`);
  if (!input.includes(path.sep) && !input.endsWith(".json")) return readRegistered(kind, input);
  const file = path.resolve(input);
  const value = await readJsonFile(file, `custom ${kind}`);
  validateDefinition(kind, value);
  const valueDigest = digest(value);
  try {
    const registered = await readRegistered(kind, value.id);
    if (registered.digest === valueDigest) return registered;
  } catch (error) {
    if (!isMissingRegistryEntry(error)) throw error;
  }
  return { value, digest: valueDigest, status: "custom/non-comparable", file };
}

export function validateDefinition(kind, value) {
  const contractKind = CONTRACT_KINDS[kind];
  if (!contractKind) throw new Error(`Unknown definition kind: ${kind}.`);
  assertContract(contractKind, value, kind);
  if (kind === "scenario") validateScenario(value);
  if (kind === "corpus") validateCorpus(value);
  return value;
}

export async function validateRegistry() {
  const entries = [];
  const identities = new Set();
  for (const kind of ["scenario", "corpus", "app"]) {
    const directory = path.join(REPOSITORY_ROOT, "registry", REGISTRY_DIRECTORIES[kind]);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).toSorted();
    for (const file of files) {
      const filePath = path.join(directory, file);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filePath} must be a regular file.`);
      const id = file.slice(0, -5);
      const registered = await readRegistered(kind, id);
      const identity = `${kind}:${id}`;
      if (identities.has(identity)) throw new Error(`Duplicate registry identity ${identity}.`);
      identities.add(identity);
      entries.push({ kind, id, digest: registered.digest });
    }
  }
  const corpora = new Set(entries.filter((entry) => entry.kind === "corpus").map((entry) => entry.id));
  const scenarios = new Set(entries.filter((entry) => entry.kind === "scenario").map((entry) => entry.id));
  for (const scenarioId of scenarios) {
    const scenario = await readRegistered("scenario", scenarioId);
    if (!corpora.has(scenario.value.corpusId)) throw new Error(`${scenarioId} references unknown corpus ${scenario.value.corpusId}.`);
  }
  for (const appId of entries.filter((entry) => entry.kind === "app").map((entry) => entry.id)) {
    const app = await readRegistered("app", appId);
    for (const scenarioId of app.value.scenarios) {
      if (!scenarios.has(scenarioId)) throw new Error(`${appId} references unknown scenario ${scenarioId}.`);
    }
  }
  return entries;
}

async function readJsonFile(file, label) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular JSON file.`);
  if (stat.size > 1024 * 1024) throw new Error(`${label} exceeds the 1 MiB definition limit.`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, { cause });
  }
}

function validateId(kind, id) {
  const pattern = kind === "app" ? /^[a-z][a-z0-9-]*$/ : /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/;
  if (!pattern.test(id)) throw new Error(`${kind} has an invalid id.`);
}

function validateScenario(value) {
  if (!(value.runProfiles.smoke <= value.runProfiles.quick && value.runProfiles.quick <= value.runProfiles.publication)) {
    throw new Error("Scenario run profiles must satisfy smoke <= quick <= publication.");
  }
  if (value.kind === "app-start") {
    const expected = ["new-application-state", "initialized-application-state"];
    if (JSON.stringify(value.cases.startModes) !== JSON.stringify(expected)) throw new Error("app-start-v1 start modes are not canonical.");
  }
  if (value.kind === "session-switch") {
    const expectedRelations = ["within-workspace", "across-workspaces"];
    const expectedStates = ["cold", "warm"];
    if (JSON.stringify(value.cases.workspaceRelations) !== JSON.stringify(expectedRelations)) throw new Error("Session workspace relations are not canonical.");
    if (JSON.stringify(value.cases.sessionStates) !== JSON.stringify(expectedStates)) throw new Error("Session cache states are not canonical.");
    assertAscendingIntegers(value.cases.transcriptBytes, "Scenario transcript sizes");
  }
}

function validateCorpus(value) {
  assertAscendingIntegers(value.transcriptBytes, "Corpus transcript sizes");
  if (value.workspaceIds.length !== 2) throw new Error("V1 corpus requires exactly two logical workspaces.");
  if (value.transcriptBytes.some((bytes) => bytes % value.messageChunkBytes !== 0)) {
    throw new Error("Every V1 transcript size must be divisible by messageChunkBytes.");
  }
}

function assertAscendingIntegers(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value, index) => !Number.isSafeInteger(value) || value <= 0 || (index > 0 && value <= values[index - 1]))) {
    throw new Error(`${label} must be strictly ascending positive safe integers.`);
  }
}

function isMissingRegistryEntry(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
