import type { WorkspaceFixtureManifest, WorkspaceLoad } from "agent-app-benchmark/driver-sdk";

export const WORKSPACE_FIXTURE_GENERATOR: "agent-app-workspace-v1";

export function buildWorkspaceFixtureManifest(load: WorkspaceLoad, seed: string): WorkspaceFixtureManifest;

export function verifyWorkspaceFixtureManifest(manifest: WorkspaceFixtureManifest): WorkspaceFixtureManifest;

export function generateWorkspaceFileBytes(
  seed: string,
  file: WorkspaceFixtureManifest["files"][number],
  revision: "initial" | "current",
): Uint8Array;

export function attestWorkspaceFixture(
  manifest: WorkspaceFixtureManifest,
  readRevision: (path: string, revision: "initial" | "current") => Uint8Array | Promise<Uint8Array>,
): Promise<string>;
