#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { digestBytes } from "../src/canonical-json.mjs";
import { runDriverConformance } from "../src/conformance.mjs";
import { verifyCorpus, writeCorpus } from "../src/corpus.mjs";
import { readDefinition, readRegistered, validateRegistry } from "../src/registry.mjs";
import { runBenchmark, validateResultFile } from "../src/runner.mjs";
import { buildSite } from "../src/report/site.mjs";

const argv = process.argv.slice(2);
const command = argv.shift();
const subcommand = ["corpus", "result", "site"].includes(command) ? argv.shift() : undefined;
const options = parseOptions(argv);

try {
  if (command === "validate") {
    const entries = await validateRegistry();
    for (const entry of entries) process.stdout.write(`${entry.kind}\t${entry.id}\t${entry.digest}\n`);
  } else if (command === "corpus" && subcommand === "generate") {
    const corpus = await readDefinition("corpus", required(options, "corpus"));
    const generated = await writeCorpus(corpus.value, path.resolve(required(options, "output")));
    process.stdout.write(`${generated.digestSha256}\n`);
  } else if (command === "corpus" && subcommand === "verify") {
    const verified = await verifyCorpus(path.resolve(required(options, "input")));
    process.stdout.write(`${verified.digestSha256}\n`);
  } else if (command === "run") {
    const scenario = await readDefinition("scenario", required(options, "scenario"));
    const corpus = await readDefinition("corpus", options.first("corpus") ?? scenario.value.corpusId);
    const app = await readRegistered("app", required(options, "app"));
    if (scenario.value.corpusId !== corpus.value.id) throw new Error(`${scenario.value.id} requires corpus ${scenario.value.corpusId}.`);
    if (!app.value.scenarios.includes(scenario.value.id)) throw new Error(`${app.value.name} is not registered for ${scenario.value.id}.`);
    if (scenario.value.kind === "session-switch" && !options.first("resourceMonitor")) throw new Error("session-switch-v1 requires --resource-monitor.");
    const output = path.resolve(required(options, "output"));
    await runBenchmark({
      driver: driverOptions(options),
      app: app.value,
      scenario,
      corpus,
      runProfile: options.first("runProfile") ?? "smoke",
      resourceMonitor: options.first("resourceMonitor"),
      output,
      runId: options.first("runId"),
      comparisonRunId: options.first("comparisonRunId"),
      frameworkRevision: options.first("frameworkRevision"),
      provenance: options.first("provenance"),
    });
    process.stdout.write(`${path.join(output, "result.json")}\n`);
  } else if (command === "conformance") {
    const app = await readRegistered("app", required(options, "app"));
    const scenario = await readRegistered("scenario", required(options, "scenario"));
    const verified = await verifyCorpus(path.resolve(required(options, "corpusDirectory")));
    const result = await runDriverConformance({
      driver: driverOptions(options),
      expected: { appId: app.value.id, scenarioId: scenario.value.id, sourceEventFormatId: verified.manifest.sourceEventFormat.id },
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

function parseOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid option near ${key ?? "end of input"}.`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    values.set(name, [...(values.get(name) ?? []), value]);
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

function driverOptions(options) {
  const environment = Object.fromEntries(options.all("driverEnv").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("--driver-env must use NAME=value.");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  return { executable: path.resolve(required(options, "driver")), args: options.all("driverArg"), env: environment };
}

function usage() {
  return "Usage: agent-app-benchmark <validate|corpus generate|corpus verify|run|conformance|result validate|site build> [options]";
}
