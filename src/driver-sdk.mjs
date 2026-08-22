import { createInterface } from "node:readline";
import { assertContract } from "./contracts.mjs";

const METHODS = ["hello", "prepare", "launch", "execute", "shutdown"];

export async function serveDriver(handlers, streams = {}) {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  for (const method of METHODS) {
    if (typeof handlers[method] !== "function") throw new Error(`Driver handler ${method} is required.`);
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let request;
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Driver request exceeds the 1 MiB line limit.");
      request = JSON.parse(line);
      assertContract("driverMessage", request, "driver request");
      if (request.kind !== "request") throw new Error("Driver stdin accepts requests only.");
      const result = await handlers[request.method](request.params);
      writeResponse(output, request, { ok: true, result });
    } catch (error) {
      if (!request?.correlationId || !METHODS.includes(request.method)) throw error;
      writeResponse(output, request, {
        ok: false,
        error: {
          code: error?.code && /^[a-z][a-z0-9-]*$/.test(error.code) ? error.code : "driver-handler-error",
          message: String(error instanceof Error ? error.message : error).slice(0, 1024),
        },
      });
    }
  }
}

function writeResponse(output, request, body) {
  const response = { protocolVersion: 1, kind: "response", correlationId: request.correlationId, method: request.method, ...body };
  assertContract("driverMessage", response, "driver response");
  output.write(`${JSON.stringify(response)}\n`);
}
