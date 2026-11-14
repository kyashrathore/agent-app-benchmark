import assert from "node:assert/strict";
import test from "node:test";
import { assertContract, contractSchemas } from "../src/contracts.mjs";
import { readRegistered, validateDefinition, validateRegistry } from "../src/registry.mjs";

test("the registry holds only the benchmark's scenarios, corpus and configured targets", async () => {
  assert.deepEqual(contractSchemas(), ["app", "corpus", "corpusArtifact", "corpusManifest", "driverMessage", "opencodeEvent", "result", "scenario"]);
  const entries = await validateRegistry();
  assert.deepEqual(entries.map(({ kind, id }) => `${kind}:${id}`), [
    "scenario:app-start",
    "scenario:long-thread",
    "scenario:new-thread",
    "scenario:session-switch-walk",
    "scenario:typing-while-streaming",
    "corpus:opencode-recorded-sessions",
    "corpusArtifact:opencode-recorded-sessions",
    "app:claxedo",
    "app:opencode",
    "app:t3",
  ]);
  assert.ok(entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.digest)));
  for (const appId of ["claxedo", "opencode", "t3"]) {
    assert.deepEqual((await readRegistered("app", appId)).value.scenarios, ["app-start", "session-switch-walk", "new-thread", "long-thread", "typing-while-streaming"]);
  }
});

test("registered scenario bytes are public-comparable", async () => {
  const scenario = await readRegistered("scenario", "session-switch-walk");
  assert.equal(scenario.status, "public-comparable");
  assert.equal(scenario.value.corpusId, "opencode-recorded-sessions");
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

test("prepare carries the replay server only in its exact shape", () => {
  const replay = { baseUrl: "http://127.0.0.1:50123/v1", npm: "@ai-sdk/openai-compatible", providerId: "replay", modelId: "stream", apiKey: "x", prompt: "p", replyOpening: "Streamed", deltaCount: 1800, deltaChars: 8, intervalMs: 50 };
  const request = (params) => ({ protocolVersion: 1, kind: "request", correlationId: "request-0", method: "prepare", params: { scenarioId: "typing-while-streaming", scenarioDigestSha256: "a".repeat(64), corpusDirectory: "/c", corpusManifestPath: "/c/m", corpusDigestSha256: "b".repeat(64), corpusDefinitionDigestSha256: "c".repeat(64), eventSchemaDigestSha256: "d".repeat(64), runDirectory: "/r", ...params } });
  assertContract("driverMessage", request({ replay }));
  assert.throws(() => assertContract("driverMessage", request({ replay: { ...replay, baseUrl: "http://example.com/v1" } })), /schema validation/u);
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
