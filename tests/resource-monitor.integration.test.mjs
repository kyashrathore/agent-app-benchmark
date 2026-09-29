import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";

const executable = process.env.RESOURCE_MONITOR_BIN;

test("Rust sidecar and JavaScript client share the snapshot contract", { skip: !executable }, async () => {
  const rootPid = process.pid;
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const hello = JSON.parse((await iterator.next()).value);
  assert.equal(hello.type, "hello");
  child.stdin.write(`${JSON.stringify({ type: "configure", version: 2, rootPid, sampleIntervalMs: 0, externalProcesses: [] })}\n`);
  child.stdin.write(`${JSON.stringify({ type: "sampleNow", version: 2, requestId: "integration-1" })}\n`);
  const snapshot = JSON.parse((await iterator.next()).value);
  assert.equal(snapshot.type, "snapshot");
  assert.equal(snapshot.requestId, "integration-1");
  assert.ok(snapshot.processes.some((sampledProcess) => sampledProcess.pid === rootPid));
  assert.equal(snapshot.inaccessibleProcessCount, 0);
  child.stdin.write(`${JSON.stringify({ type: "shutdown", version: 2 })}\n`);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`sidecar exited ${code}`)));
    child.once("error", reject);
  });
});
