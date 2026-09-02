import { DriverProcess } from "./driver-process.mjs";
import { expandCases } from "./cases.mjs";
import { assertHello, assertLaunch, assertPrepared, assertShutdown, normalizeExecution } from "./protocol.mjs";

export async function runDriverConformance(options) {
  const driver = await DriverProcess.spawn(options.driver);
  try {
    const hello = assertHello(await driver.request("hello", { frameworkVersion: 1 }), options.expected);
    const prepared = assertPrepared(await driver.request("prepare", options.prepare), {
      corpusDigestSha256: options.prepare.corpusDigestSha256,
      eventSchemaDigestSha256: options.prepare.eventSchemaDigestSha256,
      materializationModes: hello.materializationModes,
      ...(options.prepare.workspaceFixtureDigestSha256 ? { workspaceFixtureDigestSha256: options.prepare.workspaceFixtureDigestSha256 } : {}),
    });
    const benchmarkCase = expandCases(options.scenario, "smoke", options.seed)[0];
    let launch;
    if (options.scenario.kind !== "app-start") {
      launch = assertLaunch(await driver.request("launch", {
        scenarioId: options.scenario.id,
        stateHandle: prepared.stateHandles.P1,
        initialSessionId: "control",
        groupId: "conformance",
      }), { requireProcessRoles: /-v(?:[3-9]|[1-9][0-9]+)$/u.test(options.scenario.id) });
    }
    const execution = normalizeExecution(await driver.request("execute", {
      scenarioId: options.scenario.id,
      case: benchmarkCase,
      ...(options.scenario.kind === "app-start" ? { stateHandle: prepared.stateHandles[benchmarkCase.stateHandle] } : {}),
    }), benchmarkCase, {
      requireTimingEvidence: /-v(?:[3-9]|[1-9][0-9]+)$/u.test(options.scenario.id) || ["workspace-panel", "session-switch-workspace-panel"].includes(options.scenario.kind),
      requireRendererTrace: ["workspace-panel", "session-switch-workspace-panel"].includes(options.scenario.kind),
    });
    if (execution.status !== "valid") throw new Error(`Driver conformance execution failed: ${execution.reason}`);
    const shutdown = assertShutdown(await driver.request("shutdown", { reason: "conformance-complete" }));
    return { hello, prepared, launch, execution, shutdown };
  } finally {
    await driver.close();
  }
}
