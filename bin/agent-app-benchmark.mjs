#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { digestBytes } from "../src/canonical-json.mjs";
import { runDriverConformance } from "../src/conformance.mjs";
import { verifyCorpus, writeCorpus } from "../src/corpus.mjs";
import { readDefinition, readRegistered, validateRegistry } from "../src/registry.mjs";
import { planAppRun, runApp } from "../src/run-app.mjs";
import { validateResultFile } from "../src/runner.mjs";
import { buildSite } from "../src/site.mjs";
import { readResultFiles, renderComparison } from "../src/compare-results.mjs";
import { validateAppendOnly } from "../src/publication.mjs";

const argv = process.argv.slice(2);
const command = argv.shift();
const subcommand = ["corpus", "publication", "result", "site"].includes(command) ? argv.shift() : undefined;
const options = parseOptions(argv, ["dryRun"]);

try {
  if (command === "validate") {
    const entries = await validateRegistry();
    for (const entry of entries) process.stdout.write(`${entry.kind}\t${entry.id}\t${entry.digest}\n`);
  } else if (command === "verdict") {
    const paths = [...options.all("result"), ...options.all("results").flatMap((value) => value.split(","))];
    if (paths.length < 2) throw new Error("verdict needs --result for at least two runs.");
    process.stdout.write(`${await renderComparison(await readResultFiles(paths))}\n`);
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
    const plan = await planAppRun({
      app: required(options, "app"),
      output: options.first("output"),
      runProfile: options.first("runProfile"),
      repetitions: integerOption(options, "repetitions"),
      corpusDefinition: options.first("corpusDefinition"),
      corpusDirectory: options.first("corpusDirectory"),
      resourceMonitor: options.first("resourceMonitor"),
      root: options.first("root"),
      executable: options.first("executable"),
      runtime: options.first("runtime"),
      driver: options.first("driver"),
      driverArgs: options.all("driverArg"),
      driverEnv: driverEnvironment(options),
    });
    if (options.first("dryRun") === "true") {
      process.stdout.write(`${JSON.stringify({ app: plan.app.id, scenarios: plan.scenarios.map((scenario) => scenario.value.id), corpus: plan.corpus.value.id, corpusDirectory: plan.corpusDirectory, driver: plan.driver, outputRoot: plan.outputRoot, frameworkRevision: plan.frameworkRevision }, null, 2)}\n`);
    } else {
      for (const file of await runApp(plan)) process.stdout.write(`${file}\n`);
    }
  } else if (command === "conformance") {
    const app = await readRegistered("app", required(options, "app"));
    const scenario = await readRegistered("scenario", required(options, "scenario"));
    const verified = await verifyCorpus(path.resolve(required(options, "corpusDirectory")));
    const result = await runDriverConformance({
      driver: { executable: path.resolve(required(options, "driver")), args: options.all("driverArg"), env: driverEnvironment(options) },
      expected: { appId: app.value.id, scenarioId: scenario.value.id, sourceEventFormatId: verified.manifest.sourceEventFormat.id },
      scenario: scenario.value,
      prepare: {
        scenarioId: scenario.value.id,
        scenarioDigestSha256: scenario.digest,
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
    const paths = [...options.all("result"), ...options.all("results").flatMap((value) => value.split(","))];
    if (paths.length < 2) throw new Error("site build needs --result for at least two runs.");
    const built = await buildSite(paths, path.resolve(required(options, "output")), { title: options.first("title") });
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

function driverEnvironment(options) {
  return Object.fromEntries(options.all("driverEnv").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("--driver-env must use NAME=value.");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function usage() {
  return [
    "Usage: agent-app-benchmark <run|verdict|site build|conformance|validate|corpus generate|corpus verify|result validate|publication validate-append-only> [options]",
    "",
    "Run the benchmark for one app (app start, then the list walk and its idle windows):",
    "  agent-app-benchmark run --app claxedo|t3|opencode [--output <dir>]",
    "Compare two or more runs:",
    "  agent-app-benchmark verdict --result <run-dir-or-result.json> --result <run-dir-or-result.json> [...]",
    "Publish them as a static site:",
    "  agent-app-benchmark site build --result <run-dir> --result <run-dir> [...] --output <dir> [--title <title>]",
  ].join("\n");
}
