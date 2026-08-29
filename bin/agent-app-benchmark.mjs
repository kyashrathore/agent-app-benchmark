#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { digestBytes } from "../src/canonical-json.mjs";
import { runDriverConformance } from "../src/conformance.mjs";
import { runComparison } from "../src/comparison-run.mjs";
import { buildComparePlan, writeCompareConfig } from "../src/compare-preset.mjs";
import { verifyCorpus, writeCorpus } from "../src/corpus.mjs";
import { readDefinition, readRegistered, validateRegistry } from "../src/registry.mjs";
import { buildRunPlan, executeRunPlan, serializeRunPlan } from "../src/run-plan.mjs";
import { runBenchmark, validateResultFile } from "../src/runner.mjs";
import { buildSite } from "../src/report/site.mjs";
import { validateAppendOnly } from "../src/publication.mjs";
import { buildWorkspaceFixtureManifest } from "../src/workspace-fixture.mjs";

const argv = process.argv.slice(2);
const command = argv.shift();
const subcommand = ["comparison", "corpus", "publication", "result", "site"].includes(command) ? argv.shift() : undefined;
const options = parseOptions(argv, ["site", "dryRun"]);

try {
  if (command === "validate") {
    const entries = await validateRegistry();
    for (const entry of entries) process.stdout.write(`${entry.kind}\t${entry.id}\t${entry.digest}\n`);
  } else if (command === "compare") {
    const plan = await buildComparePlan({
      preset: options.first("preset") ?? "claxedo-vs-t3",
      runProfile: options.first("runProfile"),
      repetitions: integerOption(options, "repetitions"),
      id: options.first("id"),
      stamp: options.first("stamp"),
      hostLabel: options.first("hostLabel"),
      description: options.first("description"),
      provenance: options.first("provenance"),
      frameworkRevision: options.first("frameworkRevision"),
      resourceMonitor: options.first("resourceMonitor"),
      corpusDirectory: options.first("corpusDirectory"),
      outputRoot: options.first("outputRoot"),
      siteOutput: options.first("siteOutput"),
      configPath: options.first("config"),
      claxedoRoot: options.first("claxedoRoot"),
      t3Root: options.first("t3Root"),
      claxedoExecutable: options.first("claxedoExecutable"),
      t3Executable: options.first("t3Executable"),
      claxedoDriver: options.first("claxedoDriver"),
      t3Driver: options.first("t3Driver"),
      claxedoRuntime: options.first("claxedoRuntime"),
      t3Runtime: options.first("t3Runtime"),
    });
    const configPath = await writeCompareConfig(plan);
    process.stdout.write(`${configPath}\n`);
    if (options.first("dryRun") === "true") {
      process.stdout.write(`${JSON.stringify({ id: plan.config.id, outputRoot: plan.config.outputRoot, siteOutput: plan.siteOutput }, null, 2)}\n`);
    } else {
      const comparison = await runComparison(configPath);
      const comparisonFile = path.join(comparison.outputRoot, "comparison.json");
      process.stdout.write(`${comparisonFile}\n`);
      if (options.first("site") === "true") {
        const built = await buildSite(comparisonFile, plan.siteOutput);
        process.stdout.write(`${path.join(built.output, "index.html")}\n`);
      }
    }
  } else if (command === "comparison" && subcommand === "run") {
    const comparison = await runComparison(required(options, "config"));
    process.stdout.write(`${path.join(comparison.outputRoot, "comparison.json")}\n`);
  } else if (command === "corpus" && subcommand === "generate") {
    const corpus = await readDefinition("corpus", required(options, "corpus"));
    const generated = await writeCorpus(corpus.value, path.resolve(required(options, "output")));
    process.stdout.write(`${generated.digestSha256}\n`);
  } else if (command === "corpus" && subcommand === "verify") {
    const verified = await verifyCorpus(path.resolve(required(options, "input")));
    try {
      const artifact = await readRegistered("corpusArtifact", verified.manifest.corpusId);
      if (artifact.value.corpusDigestSha256 !== verified.digestSha256
        || artifact.value.definitionDigestSha256 !== verified.manifest.definitionDigestSha256
        || artifact.value.eventSchemaDigestSha256 !== verified.manifest.sourceEventFormat.schemaDigestSha256) throw new Error("Corpus does not match its registered canonical artifact identity.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    process.stdout.write(`${verified.digestSha256}\n`);
  } else if (command === "run") {
    if (options.first("driver")) {
      const scenario = await readDefinition("scenario", required(options, "scenario"));
      const corpus = await readDefinition("corpus", options.first("corpus") ?? scenario.value.corpusId);
      const app = await readRegistered("app", required(options, "app"));
      if (scenario.value.corpusId !== corpus.value.id) throw new Error(`${scenario.value.id} requires corpus ${scenario.value.corpusId}.`);
      if (scenario.status === "public-comparable" && !app.value.scenarios.includes(scenario.value.id)) throw new Error(`${app.value.name} is not registered for ${scenario.value.id}.`);
      if (scenario.value.kind === "session-switch" && !options.first("resourceMonitor")) throw new Error("session-switch-v1 requires --resource-monitor.");
      const output = path.resolve(required(options, "output"));
      await runBenchmark({
        driver: driverOptions(options),
        app: app.value,
        scenario,
        corpus,
        runProfile: options.first("runProfile") ?? "smoke",
        repetitions: integerOption(options, "repetitions"),
        resourceMonitor: options.first("resourceMonitor"),
        corpusDirectory: options.first("corpusDirectory") ? path.resolve(options.first("corpusDirectory")) : undefined,
        output,
        runId: options.first("runId"),
        comparisonRunId: options.first("comparisonRunId"),
        frameworkRevision: options.first("frameworkRevision"),
        provenance: options.first("provenance"),
      });
      process.stdout.write(`${path.join(output, "result.json")}\n`);
    } else {
      const plan = await buildRunPlan({
        app: required(options, "app"),
        scenarioIds: [...options.all("scenario"), ...options.all("scenarios")],
        runProfile: options.first("runProfile"),
        repetitions: integerOption(options, "repetitions"),
        id: options.first("id"),
        stamp: options.first("stamp"),
        hostLabel: options.first("hostLabel"),
        provenance: options.first("provenance"),
        frameworkRevision: options.first("frameworkRevision"),
        resourceMonitor: options.first("resourceMonitor"),
        corpusDirectory: options.first("corpusDirectory"),
        outputRoot: options.first("out") ?? options.first("output"),
        executable: options.first("executable"),
        root: options.first("root"),
        driverPath: options.first("driverPath") ?? options.first("driverScript"),
        runtime: options.first("runtime"),
        claxedoRoot: options.first("claxedoRoot"),
        t3Root: options.first("t3Root"),
        claxedoExecutable: options.first("claxedoExecutable"),
        t3Executable: options.first("t3Executable"),
        claxedoDriver: options.first("claxedoDriver"),
        t3Driver: options.first("t3Driver"),
        claxedoRuntime: options.first("claxedoRuntime"),
        t3Runtime: options.first("t3Runtime"),
      });
      if (options.first("dryRun") === "true") {
        process.stdout.write(`${JSON.stringify(serializeRunPlan(plan), null, 2)}\n`);
      } else {
        const results = await executeRunPlan(plan);
        for (const result of results) process.stdout.write(`${result.resultFile}\n`);
      }
    }
  } else if (command === "conformance") {
    const app = await readRegistered("app", required(options, "app"));
    const scenario = await readRegistered("scenario", required(options, "scenario"));
    const verified = await verifyCorpus(path.resolve(required(options, "corpusDirectory")));
    const panelScenario = ["workspace-panel", "session-switch-workspace-panel"].includes(scenario.value.kind);
    const workspaceFixture = panelScenario ? buildWorkspaceFixtureManifest(scenario.value.cases.workspaceLoad, verified.manifest.seed) : null;
    const result = await runDriverConformance({
      driver: driverOptions(options),
      expected: { appId: app.value.id, scenarioId: scenario.value.id, sourceEventFormatId: verified.manifest.sourceEventFormat.id },
      scenario: scenario.value,
      seed: verified.manifest.seed,
      prepare: {
        scenarioId: scenario.value.id,
        scenarioDigestSha256: scenario.digest,
        ...(workspaceFixture ? {
          scenarioDefinition: scenario.value,
          fixtureSeed: verified.manifest.seed,
          workspaceFixtureManifest: workspaceFixture,
          workspaceFixtureDigestSha256: workspaceFixture.manifestDigestSha256,
        } : {}),
        corpusDirectory: verified.path,
        corpusManifestPath: path.join(verified.path, "manifest.json"),
        corpusDigestSha256: verified.digestSha256,
        corpusDefinitionDigestSha256: verified.manifest.definitionDigestSha256,
        eventSchemaDigestSha256: verified.manifest.sourceEventFormat.schemaDigestSha256,
        runDirectory: path.resolve(required(options, "runDirectory")),
      },
    });
    process.stdout.write(`${result.hello.application.id}\t${result.prepared.materializationMode}\n`);
  } else if (command === "result" && subcommand === "validate") {
    const file = path.resolve(required(options, "input"));
    await validateResultFile(file);
    process.stdout.write(`${digestBytes(await import("node:fs/promises").then(({ readFile }) => readFile(file)))}\n`);
  } else if (command === "publication" && subcommand === "validate-append-only") {
    const entries = await validateAppendOnly(required(options, "base"));
    process.stdout.write(`${entries.length} changed path entr${entries.length === 1 ? "y" : "ies"} validated.\n`);
  } else if (command === "site" && subcommand === "build") {
    const built = await buildSite(path.resolve(required(options, "comparison")), path.resolve(required(options, "output")));
    process.stdout.write(`${path.join(built.output, "index.html")}\n`);
  } else {
    throw new Error(usage());
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseOptions(args, booleanFlags = []) {
  const booleans = new Set(booleanFlags);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) throw new Error(`Invalid option near ${key ?? "end of input"}.`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (booleans.has(name)) {
      values.set(name, [...(values.get(name) ?? []), "true"]);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Invalid option near ${key}.`);
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  return {
    first: (name) => values.get(name)?.[0],
    all: (name) => values.get(name) ?? [],
  };
}

function required(options, name) {
  const value = options.first(name);
  if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  return value;
}

function integerOption(options, name) {
  const value = options.first(name);
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`--${name} must be a positive integer.`);
  return Number(value);
}

function driverOptions(options) {
  const environment = Object.fromEntries(options.all("driverEnv").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("--driver-env must use NAME=value.");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  return { executable: path.resolve(required(options, "driver")), args: options.all("driverArg"), env: environment };
}

function usage() {
  return [
    "Usage: agent-app-benchmark <validate|compare|comparison run|corpus generate|corpus verify|run|conformance|publication validate-append-only|result validate|site build> [options]",
    "",
    "Friendly single-app run (resolves claxedo/t3 drivers by convention):",
    "  agentappbench run --app claxedo|t3 --scenario session-switch-v3 --run-profile smoke",
    "  agentappbench run --app claxedo --scenarios app-start-v3,session-switch-v3 --out artifacts/runs/claxedo-smoke --dry-run",
    "",
    "Direct driver run (unchanged):",
    "  agent-app-benchmark run --driver ... --driver-arg ... --app ... --scenario ... --output ...",
  ].join("\n");
}
