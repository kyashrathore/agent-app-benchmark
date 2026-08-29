import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPOSITORY_ROOT } from "./paths.mjs";
import { validateComparisonConfig } from "./comparison-run.mjs";

const execute = promisify(execFile);

export const COMPARE_PRESETS = Object.freeze({
  "claxedo-vs-t3": Object.freeze({
    idPrefix: "claxedo-vs-t3-p95-user-flows",
    title: (hostLabel) => `Claxedo vs T3 Code — user-flow p95 (${hostLabel})`,
    description: (hostLabel, profile) =>
      `Paired Claxedo vs T3 Code comparison on ${hostLabel} using the public user-flow suite `
      + `(app-start-v3, session-switch-v3, session-navigation-v1, workspace-panel-v2) `
      + `at run profile ${profile}.`,
    scenarioIds: Object.freeze([
      "app-start-v3",
      "session-switch-v3",
      "session-navigation-v1",
      "workspace-panel-v2",
    ]),
    defaultRunProfile: "smoke",
    apps: Object.freeze(["t3", "claxedo"]),
  }),
});

const PROFILE_REPETITIONS = Object.freeze({
  smoke: 1,
  quick: 2,
  publication: 5,
});

export async function buildComparePlan(options = {}) {
  const presetName = options.preset ?? "claxedo-vs-t3";
  const preset = COMPARE_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown compare preset "${presetName}". Available: ${Object.keys(COMPARE_PRESETS).join(", ")}.`);
  }

  const runProfile = options.runProfile ?? preset.defaultRunProfile;
  if (!PROFILE_REPETITIONS[runProfile]) throw new Error(`Unsupported --run-profile ${runProfile}.`);
  const repetitions = options.repetitions ?? PROFILE_REPETITIONS[runProfile];
  const host = await detectHostLabel(options.hostLabel);
  const stamp = options.stamp ?? defaultStamp();
  const id = options.id ?? `${preset.idPrefix}-${host.id}-${stamp}`;
  const frameworkRevision = options.frameworkRevision ?? await gitHead();
  const resourceMonitor = await resolveExisting(
    options.resourceMonitor
      ?? process.env.AGENT_APP_BENCHMARK_RESOURCE_MONITOR
      ?? path.join(REPOSITORY_ROOT, "native/resource-monitor/target/release/agent-app-resource-monitor"),
    "resource monitor",
  );
  const corpusDirectory = await resolveOptionalExisting(
    options.corpusDirectory
      ?? process.env.AGENT_APP_BENCHMARK_CORPUS
      ?? path.join(REPOSITORY_ROOT, "artifacts/corpora/opencode-completed-sessions-v3"),
  );
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

  const claxedoRoot = path.resolve(options.claxedoRoot ?? process.env.CLAXEDO_ROOT ?? path.join(REPOSITORY_ROOT, "../opencode"));
  const t3Root = path.resolve(options.t3Root ?? process.env.T3_ROOT ?? path.join(REPOSITORY_ROOT, "../t3code"));
  const claxedoExecutable = requiredPath(
    options.claxedoExecutable ?? process.env.CLAXEDO_BENCHMARK_EXECUTABLE,
    "CLAXEDO_BENCHMARK_EXECUTABLE or --claxedo-executable",
  );
  const t3Executable = requiredPath(
    options.t3Executable ?? process.env.T3_BENCHMARK_EXECUTABLE,
    "T3_BENCHMARK_EXECUTABLE or --t3-executable",
  );
  const claxedoDriver = path.resolve(
    options.claxedoDriver
      ?? process.env.CLAXEDO_BENCHMARK_DRIVER
      ?? path.join(claxedoRoot, "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts"),
  );
  const t3Driver = path.resolve(
    options.t3Driver
      ?? process.env.T3_BENCHMARK_DRIVER
      ?? path.join(t3Root, "scripts/lib/agent-app-benchmark/drivers/t3.ts"),
  );
  const claxedoRuntime = path.resolve(
    options.claxedoRuntime
      ?? process.env.CLAXEDO_BENCHMARK_RUNTIME
      ?? (await whichFirst(["bun", "node"])),
  );
  const t3Runtime = path.resolve(
    options.t3Runtime
      ?? process.env.T3_BENCHMARK_RUNTIME
      ?? (await whichFirst(["node"])),
  );

  await access(claxedoDriver);
  await access(t3Driver);
  await access(claxedoExecutable);
  await access(t3Executable);

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
        driver: t3Runtime,
        args: [t3Driver],
        cwd: t3Root,
        env: { T3_BENCHMARK_EXECUTABLE: t3Executable },
      },
      {
        id: "claxedo",
        driver: claxedoRuntime,
        args: [claxedoDriver],
        cwd: claxedoRoot,
        env: { CLAXEDO_BENCHMARK_EXECUTABLE: claxedoExecutable },
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

function requiredPath(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  return path.resolve(value);
}

async function resolveExisting(candidate, label) {
  const absolute = path.resolve(candidate);
  try {
    await access(absolute);
  } catch {
    throw new Error(`${label} not found at ${absolute}. Build it with: cargo build --release --manifest-path native/resource-monitor/Cargo.toml`);
  }
  return absolute;
}

async function resolveOptionalExisting(candidate) {
  if (!candidate) return undefined;
  const absolute = path.resolve(candidate);
  try {
    await access(absolute);
    return absolute;
  } catch {
    return undefined;
  }
}

async function gitHead() {
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT });
  return stdout.trim();
}

function defaultStamp() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}-r1`;
}

async function detectHostLabel(override) {
  if (override) return { id: slug(override), label: override };
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return { id: "macos-arm64-headed", label: "macOS arm64 headed" };
  if (platform === "darwin") return { id: `macos-${arch}`, label: `macOS ${arch}` };
  if (platform === "linux") return { id: `linux-${arch}`, label: `linux ${arch}` };
  return { id: slug(`${platform}-${arch}`), label: `${platform} ${arch}` };
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function whichFirst(names) {
  for (const name of names) {
    try {
      const { stdout } = await execute("which", [name]);
      const found = stdout.trim();
      if (found) return found;
    } catch {
      // try next
    }
  }
  throw new Error(`None of these runtimes were found on PATH: ${names.join(", ")}`);
}
