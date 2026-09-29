import { DriverProcess } from "./driver-process.mjs";
import { expandCases } from "./cases.mjs";
import { CLOCK_RULE_ID, frameLogMismatch } from "./clock-rule.mjs";
import { assertHello, assertLaunch, assertPrepared, assertShutdown, normalizeExecution } from "./protocol.mjs";

/**
 * One pass of a driver through the whole protocol on the scenario's first
 * case: hello, prepare, launch, execute and shutdown. The execution must carry
 * a frame log that re-derives its clock under the benchmark's clock rule.
 */
export async function runDriverConformance(options) {
  const driver = await DriverProcess.spawn(options.driver);
  try {
    const hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), options.expected);
    const prepared = assertPrepared(await driver.request("prepare", options.prepare), {
      corpusDigestSha256: options.prepare.corpusDigestSha256,
      eventSchemaDigestSha256: options.prepare.eventSchemaDigestSha256,
      materializationModes: hello.materializationModes,
    });
    const benchmarkCase = expandCases(options.scenario, "smoke")[0];
    let launch;
    if (options.scenario.kind !== "app-start") {
      launch = assertLaunch(await driver.request("launch", {
        scenarioId: options.scenario.id,
        stateHandle: prepared.stateHandles.P1,
        initialSessionId: "control",
        groupId: "conformance",
      }), { requireProcessRoles: true });
    }
    const response = await driver.request("execute", {
      scenarioId: options.scenario.id,
      case: benchmarkCase,
      ...(options.scenario.kind === "app-start" ? { stateHandle: prepared.stateHandles[benchmarkCase.stateHandle] } : {}),
    });
    const execution = normalizeExecution(response, benchmarkCase);
    if (execution.status !== "valid") throw new Error(`Driver conformance execution failed: ${execution.reason}`);
    if (response.frameLog === undefined) throw new Error(`Driver returned no frame log, so its clock cannot be checked against ${CLOCK_RULE_ID}.`);
    const mismatch = frameLogMismatch(response.frameLog, execution.clock);
    if (mismatch) throw new Error(`Driver clock does not follow ${CLOCK_RULE_ID}: ${mismatch}.`);
    const shutdown = assertShutdown(await driver.request("shutdown", { reason: "conformance-complete" }));
    return { hello, prepared, launch, execution, shutdown };
  } finally {
    await driver.close();
  }
}
