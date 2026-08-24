import assert from "node:assert/strict";
import test from "node:test";
import { attestWorkspaceFixture, buildWorkspaceFixtureManifest, generateWorkspaceFileBytes, verifyWorkspaceFixtureManifest } from "../src/workspace-fixture.mjs";

const LOAD = {
  generator: "agent-app-workspace-v1",
  directoryCount: 3,
  sourceFileCount: 9,
  sourceFileBytes: 4096,
  changedFileCount: 3,
  diffHunksPerFile: 2,
  diffLinesPerHunk: 8,
  openFileTabCount: 2,
};

test("workspace fixture manifest deterministically owns exact files, diffs, and open tabs", () => {
  const first = buildWorkspaceFixtureManifest(LOAD, "fixture-seed");
  const second = buildWorkspaceFixtureManifest(LOAD, "fixture-seed");
  assert.deepEqual(first, second);
  assert.equal(first.directories.length, LOAD.directoryCount);
  assert.equal(first.files.length, LOAD.sourceFileCount);
  assert.equal(first.changedFilePaths.length, LOAD.changedFileCount);
  assert.deepEqual(first.openFilePaths, first.changedFilePaths.slice(0, LOAD.openFileTabCount));
  assert.ok(first.files.filter((file) => file.changed).every((file) => file.hunks.length === LOAD.diffHunksPerFile && file.initialDigestSha256 !== file.currentDigestSha256));
  assert.ok(first.files.filter((file) => !file.changed).every((file) => file.initialDigestSha256 === file.currentDigestSha256));
  assert.equal(verifyWorkspaceFixtureManifest(first), first);
});

test("workspace fixture attestation verifies actual initial and current bytes", async () => {
  const manifest = buildWorkspaceFixtureManifest(LOAD, "fixture-seed");
  const digest = await attestWorkspaceFixture(manifest, (path, revision) => {
    const file = manifest.files.find((candidate) => candidate.path === path);
    return generateWorkspaceFileBytes(manifest.seed, file, revision);
  });
  assert.equal(digest, manifest.manifestDigestSha256);
  await assert.rejects(attestWorkspaceFixture(manifest, (path, revision) => {
    const file = manifest.files.find((candidate) => candidate.path === path);
    const bytes = generateWorkspaceFileBytes(manifest.seed, file, revision);
    return path === manifest.files[0].path && revision === "current" ? Uint8Array.of(...bytes.subarray(0, -1), 0) : bytes;
  }), /content mismatch/u);
});

test("workspace fixture verification rejects a recomputed but noncanonical manifest", () => {
  const manifest = buildWorkspaceFixtureManifest(LOAD, "fixture-seed");
  const edited = structuredClone(manifest);
  edited.changedFilePaths.reverse();
  assert.throws(() => verifyWorkspaceFixtureManifest(edited), /digest mismatch/u);
});
