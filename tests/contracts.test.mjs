import assert from "node:assert/strict";
import test from "node:test";
import { assertContract, contractSchemas } from "../src/contracts.mjs";
import { readRegistered, validateDefinition, validateRegistry } from "../src/registry.mjs";

test("all public registry entries satisfy strict schemas and cross references", async () => {
  assert.deepEqual(contractSchemas(), ["app", "comparison", "corpus", "corpusArtifact", "corpusManifest", "driverMessage", "opencodeEvent", "result", "scenario"]);
  const entries = await validateRegistry();
  assert.deepEqual(entries.map(({ kind, id }) => `${kind}:${id}`), [
    "scenario:app-start-v1",
    "scenario:session-switch-v1",
    "corpus:opencode-completed-transcripts-v1",
    "corpusArtifact:opencode-completed-transcripts-v1",
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
