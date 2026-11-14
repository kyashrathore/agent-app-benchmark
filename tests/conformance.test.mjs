import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildTestCorpus, WALK_CORPUS } from "./support/recorded-corpus.mjs";

const execute = promisify(execFile);
const CLI = path.resolve("bin/agent-app-benchmark.mjs");
const DRIVER = path.resolve("examples/mock-driver/mock-driver.mjs");

async function conformance(root, corpus, frameLog) {
  return execute(process.execPath, [
    CLI, "conformance",
    "--driver", process.execPath, "--driver-arg", DRIVER,
    "--driver-env", "BENCHMARK_MOCK_APP_ID=t3",
    ...(frameLog ? ["--driver-env", `BENCHMARK_MOCK_FRAME_LOG=${frameLog}`] : []),
    "--app", "t3", "--scenario", "session-switch-walk",
    "--corpus-directory", corpus.path, "--run-directory", path.join(root, "run"),
  ]);
}

test("CLI conformance passes a driver whose frame log re-derives its clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-conformance-"));
  try {
    const corpus = await buildTestCorpus(root, WALK_CORPUS);
    const { stdout } = await conformance(root, corpus, "settled");
    assert.equal(stdout.trim(), "t3\ttranslated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI conformance rejects a driver without a frame log or whose settle differs from its clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-conformance-"));
  try {
    const corpus = await buildTestCorpus(root, WALK_CORPUS);
    await assert.rejects(conformance(root, corpus), /returned no frame log/u);
    await assert.rejects(conformance(root, corpus, "late"), /Driver conformance execution failed: Clock rule settle-31-frames: the settle re-derives to/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conformance checks the new thread's empty-destination settle and refuses typing while streaming", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-conformance-"));
  try {
    const corpus = await buildTestCorpus(root, WALK_CORPUS);
    const run = (scenario) => execute(process.execPath, [
      CLI, "conformance", "--driver", process.execPath, "--driver-arg", DRIVER, "--driver-env", "BENCHMARK_MOCK_APP_ID=t3", "--driver-env", "BENCHMARK_MOCK_FRAME_LOG=settled",
      "--app", "t3", "--scenario", scenario, "--corpus-directory", corpus.path, "--run-directory", path.join(root, "run"),
    ]);
    assert.equal((await run("new-thread")).stdout.trim(), "t3\ttranslated");
    await assert.rejects(run("typing-while-streaming"), /does not cover typing-while-streaming/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
