import assert from "node:assert/strict";
import test from "node:test";
import { assertContract, contractSchemas } from "../src/contracts.mjs";
import { readRegistered, validateDefinition, validateRegistry } from "../src/registry.mjs";

test("the registry holds only the benchmark's scenarios, corpus and configured targets", async () => {
  assert.deepEqual(contractSchemas(), ["app", "corpus", "corpusArtifact", "corpusManifest", "driverMessage", "opencodeEvent", "result", "scenario"]);
  const entries = await validateRegistry();
  assert.deepEqual(entries.map(({ kind, id }) => `${kind}:${id}`), [
    "scenario:app-start",
    "scenario:session-switch-walk",
    "corpus:opencode-completed-sessions",
    "corpusArtifact:opencode-completed-sessions",
    "app:claxedo",
    "app:opencode",
    "app:t3",
  ]);
  assert.ok(entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.digest)));
  for (const appId of ["claxedo", "opencode", "t3"]) {
    assert.deepEqual((await readRegistered("app", appId)).value.scenarios, ["app-start", "session-switch-walk"]);
  }
});

test("registered scenario bytes are public-comparable", async () => {
  const scenario = await readRegistered("scenario", "session-switch-walk");
  assert.equal(scenario.status, "public-comparable");
  assert.equal(scenario.value.corpusId, "opencode-completed-sessions");
});

test("schema validation rejects unknown definition fields", () => {
  assert.throws(() => validateDefinition("app", {
    schemaVersion: 1,
    id: "example",
    name: "Example",
    repository: "https://example.com/example",
    driverOwnership: "application-repository",
    guiFramework: "native",
    sourceEventFormats: ["opencode-event"],
    materializationModes: ["translated"],
    scenarios: ["test-app-start"],
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

test("prepare carries exactly the corpus identity and run directory", () => {
  const request = {
    protocolVersion: 1,
    kind: "request",
    correlationId: "request-0",
    method: "prepare",
    params: {
      scenarioId: "session-switch-walk",
      scenarioDigestSha256: "a".repeat(64),
      corpusDirectory: "/private/corpus",
      corpusManifestPath: "/private/corpus/manifest.json",
      corpusDigestSha256: "b".repeat(64),
      corpusDefinitionDigestSha256: "c".repeat(64),
      eventSchemaDigestSha256: "d".repeat(64),
      runDirectory: "/private/run",
    },
  };
  assertContract("driverMessage", request);
  const withUnknownField = structuredClone(request);
  withUnknownField.params.fixtureSeed = "seed";
  assert.throws(() => assertContract("driverMessage", withUnknownField), /additional properties/u);
});
