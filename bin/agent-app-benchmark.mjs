#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { readDefinition, readRegistered, validateRegistry } from "../src/registry.mjs";
import { writeCorpus } from "../src/corpus.mjs";
import { runBenchmark } from "../src/runner.mjs";

const [command, ...argv] = process.argv.slice(2);

try {
  if (command === "validate") {
    const entries = await validateRegistry();
    for (const entry of entries) process.stdout.write(`${entry.kind}\t${entry.id}\t${entry.digest}\n`);
  } else if (command === "generate-corpus") {
    const options = parseOptions(argv);
    const corpus = await readDefinition("corpus", required(options, "corpus"));
    const generated = await writeCorpus(corpus.value, path.resolve(required(options, "output")));
    process.stdout.write(`${generated.digestSha256}\n`);
  } else if (command === "run") {
    const options = parseOptions(argv);
    const scenario = await readDefinition("scenario", required(options, "scenario"));
    const corpus = await readDefinition("corpus", required(options, "corpus"));
    const app = await readRegistered("app", required(options, "app"));
    if (!app.value.scenarios.includes(scenario.value.id)) throw new Error(`${app.value.name} is not registered for ${scenario.value.id}.`);
    const result = await runBenchmark({
      driver: required(options, "driver"),
      app: app.value,
      scenario,
      corpus,
      runProfile: options.runProfile ?? "smoke",
      resourceMonitor: options.resourceMonitor,
      output: required(options, "output"),
    });
    process.stdout.write(`${path.resolve(required(options, "output"), "report.md")}\n`);
    if (result.scenario.status !== "public-comparable" || result.corpus.status !== "public-comparable") process.exitCode = 2;
  } else {
    throw new Error("Usage: agent-app-benchmark <validate|generate-corpus|run> [options]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid option near ${key ?? "end of input"}.`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  return value;
}
