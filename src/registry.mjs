import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { digest } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";

const REGISTRY_DIRECTORIES = { app: "apps", corpus: "corpora", corpusArtifact: "corpus-artifacts", scenario: "scenarios" };
const CONTRACT_KINDS = { app: "app", corpus: "corpus", corpusArtifact: "corpusArtifact", scenario: "scenario" };

export async function readRegistered(kind, id) {
  validateId(kind, id);
  const directory = REGISTRY_DIRECTORIES[kind];
  if (!directory) throw new Error(`Unknown registry kind: ${kind}.`);
  const file = path.join(REPOSITORY_ROOT, "registry", directory, `${id}.json`);
  const value = await readJsonFile(file, `registered ${kind} ${id}`);
  validateDefinition(kind, value);
  if (value.id !== id) throw new Error(`${kind} filename and id do not match.`);
  if (kind === "corpus" && copiesPrivateContent(value)) throw new Error(`${id} copies private session content and cannot be registered.`);
  return { value, digest: digest(value), status: "public-comparable", file };
}

export async function readDefinition(kind, input) {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${kind} input is required.`);
  if (!input.includes(path.sep) && !input.endsWith(".json")) return readRegistered(kind, input);
  const file = path.resolve(input);
  const value = await readJsonFile(file, `custom ${kind}`);
  validateDefinition(kind, value);
  const valueDigest = digest(value);
  if (kind === "corpus" && copiesPrivateContent(value)) return { value, digest: valueDigest, status: "custom/non-comparable", file };
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
  for (const kind of ["scenario", "corpus", "corpusArtifact", "app"]) {
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
  for (const artifactId of entries.filter((entry) => entry.kind === "corpusArtifact").map((entry) => entry.id)) {
    const artifact = await readRegistered("corpusArtifact", artifactId);
    const corpus = await readRegistered("corpus", artifact.value.corpusId);
    const { eventSchemaDigest } = await import("./corpus.mjs");
    if (artifact.value.definitionDigestSha256 !== corpus.digest) throw new Error(`${artifactId} has a stale corpus definition digest.`);
    if (artifact.value.eventSchemaDigestSha256 !== eventSchemaDigest(corpus.value.sourceEventFormat.id)) throw new Error(`${artifactId} has a stale event schema digest.`);
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

// A real-session corpus is always private: it runs only as a custom definition
// and never becomes a registered, publishable identity.
export function copiesPrivateContent(corpus) {
  return corpus.derivation?.privateContentCopied === true;
}

function validateId(kind, id) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`${kind} has an invalid id.`);
}

function validateScenario(value) {
  if (!(value.runProfiles.smoke <= value.runProfiles.quick && value.runProfiles.quick <= value.runProfiles.publication)) {
    throw new Error("Scenario run profiles must satisfy smoke <= quick <= publication.");
  }
  if (value.kind === "app-start") {
    const expected = ["new-application-state", "initialized-application-state"];
    if (JSON.stringify(value.cases.startModes) !== JSON.stringify(expected)) throw new Error("App-start modes are not canonical.");
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
  if (value.workspaceIds.length !== 2) throw new Error("A corpus requires exactly two logical workspaces.");
  const canonicalBytes = value.transcriptBytes.reduce((total, bytes) => total + bytes * 4, value.transcriptBytes[0]);
  if (canonicalBytes > 1024 * 1024 * 1024) throw new Error("Corpus definition exceeds the byte budget.");
  const longRowSizes = value.benchmarkTopology?.longRowTranscriptBytes ?? [];
  if (longRowSizes.length > 0) assertAscendingIntegers(longRowSizes, "Corpus long-row transcript sizes");
  if (copiesPrivateContent(value)) return;
  if (JSON.stringify(value.sessionProfiles.map((profile) => profile.transcriptBytes)) !== JSON.stringify(value.transcriptBytes)) {
    throw new Error("Corpus session profiles must match transcriptBytes in order.");
  }
  if (JSON.stringify((value.longRowProfiles ?? []).map((profile) => profile.transcriptBytes)) !== JSON.stringify(longRowSizes)) {
    throw new Error("Corpus long-row profiles must match benchmarkTopology.longRowTranscriptBytes in order.");
  }
  for (const profile of [...value.sessionProfiles, ...(value.longRowProfiles ?? [])]) {
    const weight = Object.values(profile.payloadPermille).reduce((sum, value) => sum + value, 0);
    if (weight !== 1000) throw new Error(`Corpus profile ${profile.transcriptBytes} payloadPermille must total 1000.`);
    if (profile.patches > profile.toolCalls) throw new Error(`Corpus profile ${profile.transcriptBytes} has more patches than tool calls.`);
    const estimatedEvents = 1 + profile.userMessages * 2 + profile.assistantMessages * 5 + profile.toolCalls + profile.patches;
    if (estimatedEvents > 250_000) throw new Error(`Corpus profile ${profile.transcriptBytes} exceeds the per-session event budget.`);
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
