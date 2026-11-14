import { DriverProcess } from "./driver-process.mjs";
import { buildGroups, expandCases } from "./cases.mjs";
import { CLOCK_RULE_ID } from "./clock-rule.mjs";
import { observeExecution } from "./observations.mjs";
import { assertHello, assertLaunch, assertPrepared, assertShutdown } from "./protocol.mjs";

/**
 * One pass of a driver through the whole protocol on the scenario's first
 * action: hello, prepare, launch, execute and shutdown. The execution must
 * carry a frame log the framework re-derives its clock from. Typing while
 * streaming needs the replay server, so it is checked only by `run`.
 */
export async function runDriverConformance(options) {
  if (options.scenario.kind === "typing-while-streaming") throw new Error("Conformance does not cover typing-while-streaming, which needs the replay server; run it with `run --run-profile smoke`.");
  const driver = await DriverProcess.spawn(options.driver);
  try {
    const hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), options.expected);
    const prepared = assertPrepared(await driver.request("prepare", options.prepare), {
      corpusDigestSha256: options.prepare.corpusDigestSha256,
      eventSchemaDigestSha256: options.prepare.eventSchemaDigestSha256,
      materializationModes: hello.materializationModes,
    });
    const appStart = options.scenario.kind === "app-start";
    const action = appStart
      ? { request: expandCases(options.scenario, "smoke")[0], cases: [expandCases(options.scenario, "smoke")[0]] }
      : buildGroups(options.scenario, "smoke", 1)[0].actions[0];
    let launch;
    if (!appStart) {
      launch = assertLaunch(await driver.request("launch", {
        scenarioId: options.scenario.id,
        stateHandle: prepared.stateHandles.P1,
        initialSessionId: "control",
        groupId: "conformance",
      }), { requireProcessRoles: true });
    }
    const response = await driver.request("execute", {
      scenarioId: options.scenario.id,
      case: action.request,
      ...(appStart ? { stateHandle: prepared.stateHandles[action.request.stateHandle] } : {}),
    });
    const frameLogs = { checked: 0, failed: 0, missing: 0 };
    const [execution] = observeExecution(frameLogs, options.scenario, action, response);
    if (frameLogs.missing > 0) throw new Error(`Driver returned no frame log, so its clock cannot be checked against ${CLOCK_RULE_ID}.`);
    if (execution.status !== "valid") throw new Error(`Driver conformance execution failed: ${execution.reason}`);
    const shutdown = assertShutdown(await driver.request("shutdown", { reason: "conformance-complete" }));
    return { hello, prepared, launch, execution, shutdown };
  } finally {
    await driver.close();
  }
}
