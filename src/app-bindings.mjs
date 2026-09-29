import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPOSITORY_ROOT } from "./paths.mjs";

const execute = promisify(execFile);

/** Where each configured target's driver lives, and how its packaged app and runtime are found. */
export const APP_BINDINGS = Object.freeze({
  claxedo: Object.freeze({
    id: "claxedo",
    rootEnv: "CLAXEDO_ROOT",
    driverRelative: "packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts",
    executableEnv: "CLAXEDO_BENCHMARK_EXECUTABLE",
    runtimeEnv: "CLAXEDO_BENCHMARK_RUNTIME",
    runtimes: Object.freeze(["bun"]),
    // The T3 and OpenCode drivers always give their apps an isolated HOME;
    // Claxedo's does only when asked, and otherwise the app reads the
    // operator's real home and plugins.
    env: Object.freeze({ CLAXEDO_BENCH_ISOLATE_AMBIENT: "1" }),
  }),
  opencode: Object.freeze({
    id: "opencode",
    rootEnv: "OPENCODE_ROOT",
    driverRelative: "packages/desktop/benchmark/agent-app-driver.ts",
    executableEnv: "OPENCODE_BENCHMARK_EXECUTABLE",
    runtimeEnv: "OPENCODE_BENCHMARK_RUNTIME",
    runtimes: Object.freeze(["bun"]),
  }),
  t3: Object.freeze({
    id: "t3",
    rootEnv: "T3_ROOT",
    driverRelative: "scripts/lib/agent-app-benchmark/drivers/t3.ts",
    executableEnv: "T3_BENCHMARK_EXECUTABLE",
    runtimeEnv: "T3_BENCHMARK_RUNTIME",
    runtimes: Object.freeze(["node"]),
  }),
});

export function supportedAppIds() {
  return Object.keys(APP_BINDINGS);
}

/**
 * The driver command for one target: `<runtime> <root>/<driver>` in `<root>`,
 * with the packaged app's executable passed in its environment. Options win
 * over the environment variables.
 */
export async function resolveAppBinding(appId, options = {}) {
  const spec = APP_BINDINGS[appId];
  if (!spec) throw new Error(`Unsupported --app "${appId}". Supported: ${supportedAppIds().join(", ")}.`);
  const root = required(options.root ?? process.env[spec.rootEnv], `${spec.rootEnv} or --root`);
  const executable = required(options.executable ?? process.env[spec.executableEnv], `${spec.executableEnv} or --executable`);
  const runtime = path.resolve(options.runtime ?? process.env[spec.runtimeEnv] ?? (await whichFirst(spec.runtimes)));
  const driverPath = path.join(root, spec.driverRelative);
  await accessOrThrow(driverPath, `${appId} driver not found at ${driverPath}. Set ${spec.rootEnv} or --root to the checkout of its driver branch.`);
  await accessOrThrow(executable, `${appId} executable not found at ${executable}. Set ${spec.executableEnv} or --executable.`);
  return {
    driver: runtime,
    args: [driverPath],
    cwd: root,
    env: { ...spec.env, [spec.executableEnv]: executable },
  };
}

export async function resolveResourceMonitor(candidate) {
  const monitor = path.resolve(candidate
    ?? process.env.AGENT_APP_BENCHMARK_RESOURCE_MONITOR
    ?? path.join(REPOSITORY_ROOT, "native/resource-monitor/target/release/agent-app-resource-monitor"));
  await accessOrThrow(monitor, `resource monitor not found at ${monitor}. Build it with: cargo build --release --manifest-path native/resource-monitor/Cargo.toml`);
  return monitor;
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  return path.resolve(value);
}

async function whichFirst(names) {
  for (const name of names) {
    try {
      const { stdout } = await execute("which", [name]);
      if (stdout.trim()) return stdout.trim();
    } catch {
      continue;
    }
  }
  throw new Error(`None of these runtimes were found on PATH: ${names.join(", ")}`);
}

async function accessOrThrow(absolute, message) {
  try {
    await access(absolute);
  } catch {
    throw new Error(message);
  }
}
