import { DriverProcess } from "./driver-process.mjs";
import { assertHello, assertPrepared, assertShutdown } from "./protocol.mjs";

export async function runDriverConformance(options) {
  const driver = await DriverProcess.spawn(options.driver);
  try {
    const hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), options.expected);
    const prepared = assertPrepared(await driver.request("prepare", options.prepare), {
      corpusDigestSha256: options.prepare.corpusDigestSha256,
      eventSchemaDigestSha256: options.prepare.eventSchemaDigestSha256,
    });
    const shutdown = assertShutdown(await driver.request("shutdown", { reason: "conformance-complete" }));
    return { hello, prepared, shutdown };
  } finally {
    await driver.close();
  }
}
