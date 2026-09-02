import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPOSITORY_ROOT } from "./paths.mjs";
import { validateComparisonConfig } from "./comparison-run.mjs";
import {
  defaultStamp,
  detectHostLabel,
  gitHead,
  resolveAppBinding,
  resolveOptionalCorpusDirectory,
  resolveResourceMonitor,
  resolveRunProfile,
} from "./app-bindings.mjs";

export const COMPARE_PRESETS = Object.freeze({
  "claxedo-vs-t3": Object.freeze({
    idPrefix: "claxedo-vs-t3-p95-user-flows",
    title: (hostLabel) => `Claxedo vs T3 Code — user-flow p95 (${hostLabel})`,
    description: (hostLabel, profile) =>
      `Paired Claxedo vs T3 Code comparison on ${hostLabel} using the public user-flow suite `
      + `(app-start-v4, session-switch-v4, session-navigation-v2, workspace-panel-v3) `
      + `at run profile ${profile}.`,
    scenarioIds: Object.freeze([
      "app-start-v4",
      "session-switch-v4",
      "session-navigation-v2",
      "workspace-panel-v3",
    ]),
    defaultRunProfile: "smoke",
    apps: Object.freeze(["t3", "claxedo"]),
  }),
});

export async function buildComparePlan(options = {}) {
  const presetName = options.preset ?? "claxedo-vs-t3";
  const preset = COMPARE_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown compare preset "${presetName}". Available: ${Object.keys(COMPARE_PRESETS).join(", ")}.`);
  }

  const { runProfile, repetitions } = resolveRunProfile(
    options.runProfile ?? preset.defaultRunProfile,
    options.repetitions,
  );
  const host = await detectHostLabel(options.hostLabel);
  const stamp = options.stamp ?? defaultStamp();
  const id = options.id ?? `${preset.idPrefix}-${host.id}-${stamp}`;
  const frameworkRevision = options.frameworkRevision ?? await gitHead();
  const resourceMonitor = await resolveResourceMonitor(options.resourceMonitor);
  const corpusDirectory = await resolveOptionalCorpusDirectory(options.corpusDirectory);
  const outputRoot = path.resolve(
    options.outputRoot
      ?? path.join(REPOSITORY_ROOT, "artifacts/comparisons", id),
  );
  const siteOutput = path.resolve(
    options.siteOutput
      ?? path.join(REPOSITORY_ROOT, "artifacts/site", id),
  );
  const configPath = path.resolve(
    options.configPath
      ?? path.join(REPOSITORY_ROOT, "artifacts/configs", `${id}.json`),
  );

  const t3 = await resolveAppBinding("t3", options);
  const claxedo = await resolveAppBinding("claxedo", options);

  const config = {
    id,
    title: preset.title(host.label),
    description: options.description ?? preset.description(host.label, runProfile),
    provenance: options.provenance ?? "community-self-attested",
    frameworkRevision,
    runProfile,
    repetitions,
    scenarioIds: [...preset.scenarioIds],
    resourceMonitor,
    ...(corpusDirectory ? { corpusDirectory } : {}),
    outputRoot,
    apps: [
      {
        id: "t3",
        driver: t3.driver,
        args: t3.args,
        cwd: t3.cwd,
        env: t3.env,
      },
      {
        id: "claxedo",
        driver: claxedo.driver,
        args: claxedo.args,
        cwd: claxedo.cwd,
        env: claxedo.env,
      },
    ],
  };
  validateComparisonConfig(config);
  return { preset: presetName, config, configPath, siteOutput, host };
}

export async function writeCompareConfig(plan) {
  await mkdir(path.dirname(plan.configPath), { recursive: true, mode: 0o755 });
  await writeFile(plan.configPath, `${JSON.stringify(plan.config, null, 2)}\n`, { mode: 0o644 });
  return plan.configPath;
}
