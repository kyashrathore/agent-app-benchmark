import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPOSITORY_ROOT } from "./paths.mjs";

const execute = promisify(execFile);

export const PROFILE_REPETITIONS = Object.freeze({
  smoke: 1,
  quick: 2,
  publication: 5,
});

export const APP_BINDINGS = Object.freeze({
  claxedo: Object.freeze({
    id: "claxedo",
    rootEnv: "CLAXEDO_ROOT",
    defaultRootRelative: "../opencode",
    driverRelative: "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts",
    executableEnv: "CLAXEDO_BENCHMARK_EXECUTABLE",
    driverEnv: "CLAXEDO_BENCHMARK_DRIVER",
    runtimeEnv: "CLAXEDO_BENCHMARK_RUNTIME",
    runtimes: Object.freeze(["bun", "node"]),
  }),
  opencode: Object.freeze({
    id: "opencode",
    rootEnv: "OPENCODE_ROOT",
    defaultRootRelative: "../opencode-upstream",
    driverRelative: "packages/desktop/benchmark/agent-app-driver.ts",
    executableEnv: "OPENCODE_BENCHMARK_EXECUTABLE",
    driverEnv: "OPENCODE_BENCHMARK_DRIVER",
    runtimeEnv: "OPENCODE_BENCHMARK_RUNTIME",
    runtimes: Object.freeze(["bun"]),
  }),
  t3: Object.freeze({
    id: "t3",
    rootEnv: "T3_ROOT",
    defaultRootRelative: "../t3code",
    driverRelative: "scripts/lib/agent-app-benchmark/drivers/t3.ts",
    executableEnv: "T3_BENCHMARK_EXECUTABLE",
    driverEnv: "T3_BENCHMARK_DRIVER",
    runtimeEnv: "T3_BENCHMARK_RUNTIME",
    runtimes: Object.freeze(["node"]),
  }),
});

export function supportedAppIds() {
  return Object.keys(APP_BINDINGS);
}

export async function resolveAppBinding(appId, options = {}) {
  const spec = APP_BINDINGS[appId];
  if (!spec) {
    throw new Error(`Unsupported --app "${appId}". Supported: ${supportedAppIds().join(", ")}.`);
  }

  const root = path.resolve(
    options.root
      ?? options[`${appId}Root`]
      ?? process.env[spec.rootEnv]
      ?? path.join(REPOSITORY_ROOT, spec.defaultRootRelative),
  );
  const executable = requiredPath(
    options.executable ?? options[`${appId}Executable`] ?? process.env[spec.executableEnv],
    `${spec.executableEnv} or --executable`,
  );
  const driverPath = path.resolve(
    options.driverPath
      ?? options[`${appId}Driver`]
      ?? process.env[spec.driverEnv]
      ?? path.join(root, spec.driverRelative),
  );
  const runtime = path.resolve(
    options.runtime
      ?? options[`${appId}Runtime`]
      ?? process.env[spec.runtimeEnv]
      ?? (await whichFirst([...spec.runtimes])),
  );

  await accessOrThrow(driverPath, `${appId} driver not found at ${driverPath}. Set ${spec.rootEnv}, ${spec.driverEnv}, or --${appId}-driver.`);
  await accessOrThrow(executable, `${appId} executable not found at ${executable}. Set ${spec.executableEnv} or --executable.`);

  return {
    id: appId,
    root,
    executable,
    driverPath,
    runtime,
    driver: runtime,
    args: [driverPath],
    cwd: root,
    env: { [spec.executableEnv]: executable },
  };
}

export function resolveRunProfile(runProfile, repetitions) {
  const profile = runProfile ?? "smoke";
  if (!PROFILE_REPETITIONS[profile]) {
    throw new Error(`Unsupported --run-profile ${profile}. Available: ${Object.keys(PROFILE_REPETITIONS).join(", ")}.`);
  }
  return {
    runProfile: profile,
    repetitions: repetitions ?? PROFILE_REPETITIONS[profile],
  };
}

export async function resolveResourceMonitor(candidate) {
  return resolveExisting(
    candidate
      ?? process.env.AGENT_APP_BENCHMARK_RESOURCE_MONITOR
      ?? path.join(REPOSITORY_ROOT, "native/resource-monitor/target/release/agent-app-resource-monitor"),
    "resource monitor",
  );
}

export async function resolveOptionalCorpusDirectory(candidate) {
  return resolveOptionalExisting(
    candidate
      ?? process.env.AGENT_APP_BENCHMARK_CORPUS
      ?? path.join(REPOSITORY_ROOT, "artifacts/corpora/opencode-completed-sessions-v3"),
  );
}

export async function gitHead(cwd = REPOSITORY_ROOT) {
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

export function defaultStamp(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}-r1`;
}

export async function detectHostLabel(override) {
  if (override) return { id: slug(override), label: override };
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return { id: "macos-arm64-headed", label: "macOS arm64 headed" };
  if (platform === "darwin") return { id: `macos-${arch}`, label: `macOS ${arch}` };
  if (platform === "linux") return { id: `linux-${arch}`, label: `linux ${arch}` };
  return { id: slug(`${platform}-${arch}`), label: `${platform} ${arch}` };
}

export function requiredPath(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  return path.resolve(value);
}

export async function resolveExisting(candidate, label) {
  const absolute = path.resolve(candidate);
  try {
    await access(absolute);
  } catch {
    throw new Error(`${label} not found at ${absolute}. Build it with: cargo build --release --manifest-path native/resource-monitor/Cargo.toml`);
  }
  return absolute;
}

export async function resolveOptionalExisting(candidate) {
  if (!candidate) return undefined;
  const absolute = path.resolve(candidate);
  try {
    await access(absolute);
    return absolute;
  } catch {
    return undefined;
  }
}

export async function whichFirst(names) {
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

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function accessOrThrow(absolute, message) {
  try {
    await access(absolute);
  } catch {
    throw new Error(message);
  }
}
