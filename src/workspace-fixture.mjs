import { createHash } from "node:crypto";
import { digest, digestBytes } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";

export const WORKSPACE_FIXTURE_GENERATOR = "agent-app-workspace-v1";
const LINE_BYTES = 64;

export function buildWorkspaceFixtureManifest(load, seed) {
  assertWorkspaceLoad(load);
  if (typeof seed !== "string" || seed.length === 0) throw new Error("Workspace fixture seed is required.");
  const directories = Array.from({ length: load.directoryCount }, (_, index) => `src/section-${String(index).padStart(3, "0")}`);
  const identities = Array.from({ length: load.sourceFileCount }, (_, index) => ({
    index,
    score: createHash("sha256").update(`${seed}|changed|${index}`).digest("hex"),
  })).toSorted((left, right) => left.score.localeCompare(right.score));
  const changed = new Set(identities.slice(0, load.changedFileCount).map((item) => item.index));
  const files = Array.from({ length: load.sourceFileCount }, (_, index) => {
    const directory = directories[index % directories.length];
    const path = `${directory}/file-${String(index).padStart(5, "0")}.ts`;
    const hunks = changed.has(index) ? fixtureHunks(load) : [];
    const identity = { path, byteLength: load.sourceFileBytes, changed: changed.has(index), hunks };
    return {
      ...identity,
      initialDigestSha256: digestBytes(generateWorkspaceFileBytes(seed, identity, "initial")),
      currentDigestSha256: digestBytes(generateWorkspaceFileBytes(seed, identity, "current")),
    };
  });
  const changedFilePaths = files.filter((file) => file.changed).map((file) => file.path);
  const manifestCore = {
    schemaVersion: 1,
    generator: WORKSPACE_FIXTURE_GENERATOR,
    seed,
    load: { ...load },
    directories,
    files,
    changedFilePaths,
    openFilePaths: changedFilePaths.slice(0, load.openFileTabCount),
  };
  const manifest = { ...manifestCore, manifestDigestSha256: digest(manifestCore) };
  assertContract("workspaceFixture", manifest, "workspace fixture manifest");
  return manifest;
}

export function verifyWorkspaceFixtureManifest(manifest) {
  assertContract("workspaceFixture", manifest, "workspace fixture manifest");
  const { manifestDigestSha256, ...manifestCore } = manifest;
  if (digest(manifestCore) !== manifestDigestSha256) throw new Error("Workspace fixture manifest digest mismatch.");
  const expected = buildWorkspaceFixtureManifest(manifest.load, manifest.seed);
  if (digest(expected) !== digest(manifest)) throw new Error("Workspace fixture manifest is not canonical.");
  return manifest;
}

export async function attestWorkspaceFixture(manifest, readRevision) {
  verifyWorkspaceFixtureManifest(manifest);
  if (typeof readRevision !== "function") throw new Error("Workspace fixture attestation requires a revision reader.");
  for (const file of manifest.files) {
    for (const revision of ["initial", "current"]) {
      const bytes = await readRevision(file.path, revision);
      if (!(bytes instanceof Uint8Array)) throw new Error(`Workspace fixture reader did not return bytes for ${revision}:${file.path}.`);
      const expected = revision === "initial" ? file.initialDigestSha256 : file.currentDigestSha256;
      if (digestBytes(bytes) !== expected) throw new Error(`Workspace fixture ${revision} content mismatch for ${file.path}.`);
    }
  }
  return manifest.manifestDigestSha256;
}

export function generateWorkspaceFileBytes(seed, file, revision) {
  if (!["initial", "current"].includes(revision)) throw new Error(`Unknown workspace fixture revision ${revision}.`);
  const changedLines = new Set(file.changed && revision === "current"
    ? file.hunks.flatMap((hunk) => Array.from({ length: hunk.lineCount }, (_, offset) => hunk.startLine + offset))
    : []);
  const lineCount = Math.ceil(file.byteLength / LINE_BYTES);
  const chunks = [];
  for (let line = 0; line < lineCount; line += 1) {
    const phase = changedLines.has(line) ? "current" : "initial";
    const prefix = `// ${String(line).padStart(6, "0")} `;
    const hash = createHash("sha256").update(`${seed}|${file.path}|${line}|${phase}`).digest("hex");
    chunks.push(`${prefix}${hash.repeat(2).slice(0, LINE_BYTES - prefix.length - 1)}\n`);
  }
  return Buffer.from(chunks.join(""), "utf8").subarray(0, file.byteLength);
}

function fixtureHunks(load) {
  const lineCount = Math.floor(load.sourceFileBytes / LINE_BYTES);
  const stride = Math.floor(lineCount / (load.diffHunksPerFile + 1));
  return Array.from({ length: load.diffHunksPerFile }, (_, index) => ({
    startLine: ((index + 1) * stride) - Math.floor(load.diffLinesPerHunk / 2),
    lineCount: load.diffLinesPerHunk,
  }));
}

function assertWorkspaceLoad(load) {
  const fields = ["directoryCount", "sourceFileCount", "sourceFileBytes", "changedFileCount", "diffHunksPerFile", "diffLinesPerHunk", "openFileTabCount"];
  if (!load || fields.some((field) => !Number.isSafeInteger(load[field]) || load[field] <= 0)) throw new Error("Workspace load fields must be positive safe integers.");
  if (load.changedFileCount > load.sourceFileCount || load.openFileTabCount > load.changedFileCount) throw new Error("Workspace load file counts are inconsistent.");
  const lineCount = Math.floor(load.sourceFileBytes / LINE_BYTES);
  const stride = Math.floor(lineCount / (load.diffHunksPerFile + 1));
  if (stride < load.diffLinesPerHunk + 6) throw new Error("Workspace source files are too small for separated canonical diff hunks.");
}
