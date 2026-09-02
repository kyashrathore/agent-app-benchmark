import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_BINDINGS, PROFILE_REPETITIONS, resolveAppBinding, resolveRunProfile } from "../src/app-bindings.mjs";
import { buildRunPlan, normalizeScenarioIds, serializeRunPlan } from "../src/run-plan.mjs";

test("app bindings point at the compare-preset driver conventions", () => {
  assert.equal(
    APP_BINDINGS.claxedo.driverRelative,
    "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts",
  );
  assert.equal(
    APP_BINDINGS.t3.driverRelative,
    "scripts/lib/agent-app-benchmark/drivers/t3.ts",
  );
  assert.deepEqual(PROFILE_REPETITIONS, { smoke: 1, quick: 2, publication: 5 });
});

test("normalizeScenarioIds accepts comma-separated and repeated values", () => {
  assert.deepEqual(normalizeScenarioIds(["session-switch-v4", "app-start-v4,session-switch-v4"]), [
    "session-switch-v4",
    "app-start-v4",
  ]);
  assert.deepEqual(normalizeScenarioIds([]), []);
});

test("resolveRunProfile maps compare-style repetition overrides", () => {
  assert.deepEqual(resolveRunProfile("smoke"), { runProfile: "smoke", repetitions: 1 });
  assert.deepEqual(resolveRunProfile("publication", 3), { runProfile: "publication", repetitions: 3 });
  assert.throws(() => resolveRunProfile("turbo"), /Unsupported --run-profile/);
});

test("resolveAppBinding finds claxedo driver under CLAXEDO_ROOT convention", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-bind-"));
  try {
    const claxedoRoot = path.join(root, "opencode");
    const driverPath = path.join(claxedoRoot, APP_BINDINGS.claxedo.driverRelative);
    const executable = path.join(root, "Claxedo");
    const runtime = path.join(root, "bun");
    for (const file of [driverPath, executable, runtime]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "ok\n");
    }

    const binding = await resolveAppBinding("claxedo", {
      root: claxedoRoot,
      executable,
      runtime,
    });
    assert.equal(binding.id, "claxedo");
    assert.equal(binding.driverPath, driverPath);
    assert.equal(binding.env.CLAXEDO_BENCHMARK_EXECUTABLE, executable);
    assert.equal(binding.cwd, claxedoRoot);
    assert.deepEqual(binding.args, [driverPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveAppBinding errors clearly when the driver is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-bind-miss-"));
  try {
    const executable = path.join(root, "Claxedo");
    await writeFile(executable, "ok\n");
    await assert.rejects(
      () => resolveAppBinding("claxedo", { root: path.join(root, "missing"), executable, runtime: executable }),
      /claxedo driver not found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run plan resolves a smoke single-scenario layout for claxedo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-run-plan-"));
  try {
    const claxedoRoot = path.join(root, "opencode");
    const driverPath = path.join(claxedoRoot, APP_BINDINGS.claxedo.driverRelative);
    const executable = path.join(root, "Claxedo");
    const resourceMonitor = path.join(root, "resource-monitor");
    const runtime = path.join(root, "node-runtime");
    for (const file of [driverPath, executable, resourceMonitor, runtime]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "ok\n");
    }

    const plan = await buildRunPlan({
      app: "claxedo",
      scenarioIds: ["session-switch-v4"],
      runProfile: "smoke",
      id: "claxedo-smoke-fixture",
      hostLabel: "macOS arm64 headed",
      frameworkRevision: "a".repeat(40),
      resourceMonitor,
      root: claxedoRoot,
      executable,
      runtime,
      outputRoot: path.join(root, "out"),
    });

    assert.equal(plan.appId, "claxedo");
    assert.deepEqual(plan.scenarioIds, ["session-switch-v4"]);
    assert.equal(plan.runProfile, "smoke");
    assert.equal(plan.repetitions, 1);
    assert.equal(plan.binding.driverPath, driverPath);
    assert.equal(plan.outputRoot, path.join(root, "out"));
    assert.equal(plan.defaultedScenarios, false);

    const serialized = serializeRunPlan(plan);
    assert.equal(serialized.binding.executable, executable);
    assert.equal(serialized.resourceMonitor, resourceMonitor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run plan defaults to the user-flow scenario suite when none are given", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-run-default-"));
  try {
    const claxedoRoot = path.join(root, "opencode");
    const driverPath = path.join(claxedoRoot, APP_BINDINGS.claxedo.driverRelative);
    const executable = path.join(root, "Claxedo");
    const resourceMonitor = path.join(root, "resource-monitor");
    const runtime = path.join(root, "node-runtime");
    for (const file of [driverPath, executable, resourceMonitor, runtime]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "ok\n");
    }

    const plan = await buildRunPlan({
      app: "claxedo",
      runProfile: "quick",
      frameworkRevision: "b".repeat(40),
      resourceMonitor,
      root: claxedoRoot,
      executable,
      runtime,
      outputRoot: path.join(root, "out"),
    });

    assert.equal(plan.defaultedScenarios, true);
    assert.deepEqual(plan.scenarioIds, [
      "app-start-v4",
      "session-switch-v4",
      "session-navigation-v2",
      "workspace-panel-v3",
    ]);
    assert.equal(plan.repetitions, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run plan rejects unsupported apps", async () => {
  await assert.rejects(
    () => buildRunPlan({ app: "custom", frameworkRevision: "c".repeat(40) }),
    /Unsupported --app/,
  );
});
