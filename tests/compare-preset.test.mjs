import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COMPARE_PRESETS, buildComparePlan, writeCompareConfig } from "../src/compare-preset.mjs";
import { REPOSITORY_ROOT } from "../src/paths.mjs";

test("claxedo-vs-t3 preset covers the full user-flow suite", () => {
  assert.deepEqual(COMPARE_PRESETS["claxedo-vs-t3"].scenarioIds, [
    "app-start-v4",
    "session-switch-v4",
    "session-navigation-v2",
    "workspace-panel-v3",
  ]);
});

test("compare plan builds a valid headed macOS smoke config from explicit paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-benchmark-compare-"));
  try {
    const claxedoRoot = path.join(root, "opencode");
    const t3Root = path.join(root, "t3code");
    const claxedoDriver = path.join(claxedoRoot, "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts");
    const t3Driver = path.join(t3Root, "scripts/lib/agent-app-benchmark/drivers/t3.ts");
    const claxedoExecutable = path.join(root, "Claxedo");
    const t3Executable = path.join(root, "T3");
    const resourceMonitor = path.join(root, "resource-monitor");
    const runtime = path.join(root, "node-runtime");
    for (const file of [claxedoDriver, t3Driver, claxedoExecutable, t3Executable, resourceMonitor, runtime]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "ok\n");
    }

    const plan = await buildComparePlan({
      preset: "claxedo-vs-t3",
      runProfile: "smoke",
      id: "compare-fixture-run",
      hostLabel: "macOS arm64 headed",
      frameworkRevision: "a".repeat(40),
      resourceMonitor,
      claxedoRoot,
      t3Root,
      claxedoExecutable,
      t3Executable,
      claxedoRuntime: runtime,
      t3Runtime: runtime,
      outputRoot: path.join(root, "out"),
      siteOutput: path.join(root, "site"),
      configPath: path.join(root, "config.json"),
    });

    assert.equal(plan.config.id, "compare-fixture-run");
    assert.equal(plan.config.runProfile, "smoke");
    assert.equal(plan.config.repetitions, 1);
    assert.equal(plan.config.apps[0].env.T3_BENCHMARK_EXECUTABLE, t3Executable);
    assert.equal(plan.config.apps[1].env.CLAXEDO_BENCHMARK_EXECUTABLE, claxedoExecutable);
    assert.match(plan.config.title, /macOS arm64 headed/);
    assert.equal(plan.host.id, "macos-arm64-headed");

    const written = await writeCompareConfig(plan);
    await access(written);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compare plan rejects unknown presets", async () => {
  await assert.rejects(() => buildComparePlan({ preset: "nope", frameworkRevision: "a".repeat(40) }), /Unknown compare preset/);
});

test("repository root still resolves for compare helpers", () => {
  assert.ok(REPOSITORY_ROOT.endsWith("agent-app-benchmark") || REPOSITORY_ROOT.includes("agent-app-benchmark"));
});
