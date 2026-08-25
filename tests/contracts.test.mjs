import assert from "node:assert/strict";
import test from "node:test";
import { assertContract, contractSchemas } from "../src/contracts.mjs";
import { readRegistered, validateDefinition, validateRegistry } from "../src/registry.mjs";

test("all public registry entries satisfy strict schemas and cross references", async () => {
  assert.deepEqual(contractSchemas(), ["app", "comparison", "corpus", "corpusArtifact", "corpusManifest", "driverMessage", "opencodeEvent", "opencodeEventV2", "rendererTrace", "result", "scenario", "workspaceFixture"]);
  const entries = await validateRegistry();
  assert.deepEqual(entries.map(({ kind, id }) => `${kind}:${id}`), [
    "scenario:app-start-v1",
    "scenario:app-start-v2",
    "scenario:app-start-v3",
    "scenario:session-navigation-v1",
    "scenario:session-switch-v1",
    "scenario:session-switch-v2",
    "scenario:session-switch-v3",
    "scenario:session-switch-workspace-panel-v1",
    "scenario:workspace-panel-v1",
    "scenario:workspace-panel-v2",
    "corpus:opencode-completed-sessions-v2",
    "corpus:opencode-completed-sessions-v3",
    "corpus:opencode-completed-transcripts-v1",
    "corpusArtifact:opencode-completed-sessions-v2",
    "corpusArtifact:opencode-completed-sessions-v3",
    "corpusArtifact:opencode-completed-transcripts-v1",
    "app:claxedo-solid1-web",
    "app:claxedo-solid2-web",
    "app:claxedo",
    "app:t3",
  ]);
  assert.ok(entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.digest)));
});

test("registered scenario bytes are public-comparable", async () => {
  const scenario = await readRegistered("scenario", "session-switch-v1");
  assert.equal(scenario.status, "public-comparable");
  assert.equal(scenario.value.corpusId, "opencode-completed-transcripts-v1");
});

test("V2 scenarios define virtualized Review readiness without weakening authoritative state", async () => {
  for (const scenarioId of ["session-navigation-v1", "workspace-panel-v2"]) {
    const scenario = (await readRegistered("scenario", scenarioId)).value;
    assert.match(scenario.description, /complete non-truncated 24-file authoritative model/u);
    assert.match(scenario.description, /exact logical expansion state/u);
    assert.match(scenario.description, /currently materialized viewport/u);
  }
  const panel = (await readRegistered("scenario", "workspace-panel-v2")).value;
  assert.match(panel.metrics[0].description, /all 24 canonical files without truncation/u);
  assert.match(panel.metrics[0].description, /offscreen virtualized bodies need not exist concurrently/u);
  assert.match(panel.description, /Open-file is data-warm and surface-cold/u);
  assert.match(panel.description, /tab and preview never mount during setup/u);
  assert.match(panel.metrics[0].description, /target bytes warm but its tab and preview surface never previously mounted/u);
});

test("desktop apps advertise the same canonical workspace-panel scenarios", async () => {
  const panelScenarios = ["workspace-panel-v1", "session-switch-workspace-panel-v1", "session-navigation-v1", "workspace-panel-v2"];
  for (const appId of ["claxedo", "t3"]) {
    const app = await readRegistered("app", appId);
    assert.deepEqual(
      app.value.scenarios.filter((scenarioId) => panelScenarios.includes(scenarioId)),
      panelScenarios,
    );
  }
});

test("schema validation rejects unknown definition fields", () => {
  assert.throws(() => validateDefinition("app", {
    schemaVersion: 1,
    id: "example",
    name: "Example",
    repository: "https://example.com/example",
    driverOwnership: "application-repository",
    guiFramework: "native",
    sourceEventFormats: ["opencode-event-v1"],
    materializationModes: ["translated"],
    scenarios: ["app-start-v1"],
    surprise: true,
  }), /additional properties/);
});

test("driver response must contain exactly one result or error", () => {
  assert.throws(() => assertContract("driverMessage", {
    protocolVersion: 1,
    kind: "response",
    correlationId: "request-0",
    method: "hello",
    ok: true,
    result: {},
    error: { code: "bad", message: "bad" },
  }), /schema validation/);
});

test("prepare keeps the legacy request shape compatible and accepts panel fixture identity", () => {
  const request = {
    protocolVersion: 1,
    kind: "request",
    correlationId: "request-0",
    method: "prepare",
    params: {
      scenarioId: "workspace-panel-v1",
      scenarioDigestSha256: "a".repeat(64),
      scenarioDefinition: { id: "workspace-panel-v1" },
      fixtureSeed: "canonical-seed",
      workspaceFixtureManifest: { schemaVersion: 1 },
      workspaceFixtureDigestSha256: "e".repeat(64),
      corpusDirectory: "/private/corpus",
      corpusManifestPath: "/private/corpus/manifest.json",
      corpusDigestSha256: "b".repeat(64),
      corpusDefinitionDigestSha256: "c".repeat(64),
      eventSchemaDigestSha256: "d".repeat(64),
      runDirectory: "/private/run",
    },
  };
  assertContract("driverMessage", request);
  const incompletePanel = structuredClone(request);
  delete incompletePanel.params.fixtureSeed;
  assert.throws(() => assertContract("driverMessage", incompletePanel), /fixtureSeed/u);
  const legacy = structuredClone(request);
  legacy.params.scenarioId = "session-switch-v1";
  delete legacy.params.scenarioDefinition;
  delete legacy.params.fixtureSeed;
  delete legacy.params.workspaceFixtureManifest;
  delete legacy.params.workspaceFixtureDigestSha256;
  assertContract("driverMessage", legacy);
});
