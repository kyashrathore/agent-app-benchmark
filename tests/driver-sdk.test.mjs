import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { serveDriver } from "../src/driver-sdk.mjs";

test("driver SDK dispatches one strict response per NDJSON request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let bytes = "";
  output.on("data", (chunk) => { bytes += chunk; });
  const handlers = Object.fromEntries(["hello", "prepare", "launch", "execute", "shutdown"].map((method) => [method, async (params) => ({ method, params })]));
  const serving = serveDriver(handlers, { input, output });
  input.end(`${JSON.stringify({ protocolVersion: 1, kind: "request", correlationId: "request-0", method: "hello", params: { value: 1 } })}\n`);
  await serving;
  const response = JSON.parse(bytes);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { method: "hello", params: { value: 1 } });
});

test("driver SDK converts handler failures to bounded protocol errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let bytes = "";
  output.on("data", (chunk) => { bytes += chunk; });
  const handlers = Object.fromEntries(["hello", "prepare", "launch", "execute", "shutdown"].map((method) => [method, async () => { throw new Error("failure"); }]));
  const serving = serveDriver(handlers, { input, output });
  input.end(`${JSON.stringify({ protocolVersion: 1, kind: "request", correlationId: "request-0", method: "prepare", params: {} })}\n`);
  await serving;
  const response = JSON.parse(bytes);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "driver-handler-error");
  assert.equal(response.error.message, "failure");
});
