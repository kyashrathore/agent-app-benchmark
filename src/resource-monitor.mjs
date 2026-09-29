import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class ResourceMonitor {
  static async start(executable, rootProcesses, sampleIntervalMs) {
    if (!Array.isArray(rootProcesses) || rootProcesses.length === 0) throw new Error("At least one application process root is required.");
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const monitor = new ResourceMonitor(child);
    try {
      await monitor.waitForHello();
    } catch (error) {
      await monitor.terminate();
      throw error;
    }
    const [root, ...external] = rootProcesses;
    monitor.rootPid = root.pid;
    monitor.expectedExternalProcessCount = external.length;
    monitor.write({
      type: "configure",
      version: 2,
      rootPid: root.pid,
      sampleIntervalMs,
      externalProcesses: external.map((process) => ({ pid: process.pid, startTimeMs: process.startTimeMs })),
    });
    monitor.write({ type: "setStreaming", version: 2, enabled: true });
    return monitor;
  }

  constructor(child) {
    this.child = child;
    this.samples = [];
    this.errors = [];
    this.pendingSnapshots = new Map();
    this.hello = undefined;
    this.rootPid = undefined;
    this.expectedExternalProcessCount = 0;
    this.exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    this.helloPromise = new Promise((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.errors.push({ code: "sidecar-stderr", message: String(chunk).slice(0, 4096) }));
    child.once("exit", (code, signal) => {
      if (!this.hello) this.rejectHello(new Error(`Resource monitor exited before hello (code=${code}, signal=${signal}).`));
      for (const pending of this.pendingSnapshots.values()) pending.reject(new Error("Resource monitor exited before snapshot."));
      this.pendingSnapshots.clear();
    });
  }

  async waitForHello(timeoutMs = 10_000) {
    let timeout;
    try {
      return await Promise.race([
        this.helloPromise,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Resource monitor hello timed out.")), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  setSampleInterval(sampleIntervalMs) {
    this.write({ type: "setSampleInterval", version: 2, sampleIntervalMs });
  }

  sampleNow(label, timeoutMs = 10_000) {
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Snapshot label is invalid.");
    const requestId = `${label}-${this.pendingSnapshots.size}-${Date.now()}`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(requestId);
        reject(new Error(`Resource snapshot ${label} timed out.`));
      }, timeoutMs);
      this.pendingSnapshots.set(requestId, { resolve, reject, timer });
    });
    this.write({ type: "sampleNow", version: 2, requestId });
    return response;
  }

  async stop() {
    if (this.child.exitCode !== null) return this.exit;
    try {
      this.write({ type: "shutdown", version: 2 });
      this.child.stdin.end();
    } catch {
      // Escalation below owns cleanup when the graceful protocol is unavailable.
    }
    if (await this.waitForExit(5_000)) return this.exit;
    this.child.kill("SIGTERM");
    if (await this.waitForExit(5_000)) return this.exit;
    this.child.kill("SIGKILL");
    if (await this.waitForExit(5_000)) return this.exit;
    throw new Error("Resource monitor did not exit after forced termination.");
  }

  async terminate() {
    if (this.child.exitCode !== null) return this.exit;
    this.child.stdin.destroy();
    this.child.kill("SIGTERM");
    if (await this.waitForExit(2_000)) return this.exit;
    this.child.kill("SIGKILL");
    if (await this.waitForExit(2_000)) return this.exit;
    throw new Error("Resource monitor could not be terminated.");
  }

  async waitForExit(timeoutMs) {
    let timer;
    const completed = await Promise.race([
      this.exit.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return completed;
  }

  write(command) {
    if (this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error("Resource monitor is not running.");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.errors.push({ code: "invalid-json", message: line.slice(0, 1024) });
      return;
    }
    if (event.type === "hello") {
      this.hello = event;
      this.resolveHello(event);
      return;
    }
    if (event.type === "snapshot") {
      let snapshot;
      try {
        snapshot = normalizeSnapshot(event, { rootPid: this.rootPid, expectedExternalProcessCount: this.expectedExternalProcessCount });
      } catch {
        const error = new Error("Resource monitor returned a malformed snapshot.");
        this.errors.push({ code: "invalid-snapshot", message: error.message });
        this.rejectPendingSnapshots(error, event.requestId);
        return;
      }
      this.samples.push(snapshot);
      if (event.requestId) {
        const pending = this.pendingSnapshots.get(event.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingSnapshots.delete(event.requestId);
          pending.resolve(snapshot);
        }
      }
      return;
    }
    if (event.type === "error") this.errors.push(event);
  }

  rejectPendingSnapshots(error, requestId) {
    const entries = requestId && this.pendingSnapshots.has(requestId)
      ? [[requestId, this.pendingSnapshots.get(requestId)]]
      : [...this.pendingSnapshots.entries()];
    for (const [id, pending] of entries) {
      clearTimeout(pending.timer);
      this.pendingSnapshots.delete(id);
      pending.reject(error);
    }
  }
}

export function normalizeSnapshot(snapshot, expected) {
  if (!snapshot || !Array.isArray(snapshot.processes) || !isNonnegativeFinite(snapshot.sampledAtUnixMs) || !isNonnegativeFinite(snapshot.collectionDurationMicros)) {
    throw new Error("Snapshot envelope is invalid.");
  }
  const processes = snapshot.processes.map((process) => ({
    pid: assertPositiveInteger(process?.pid, "pid"),
    startTimeMs: assertNonnegativeFinite(process?.startTimeMs, "startTimeMs"),
    cpuTimeMs: assertNonnegativeFinite(process?.cpuTimeMs, "cpuTimeMs"),
    rssBytes: assertNonnegativeFinite(process?.residentBytes, "residentBytes"),
    name: typeof process?.name === "string" ? process.name.slice(0, 256) : "",
  }));
  let inaccessibleProcessCount = 0;
  let rootProcessFound = true;
  let missingExternalProcessCount = 0;
  if (expected) {
    inaccessibleProcessCount = assertNonnegativeInteger(snapshot.inaccessibleProcessCount, "inaccessibleProcessCount");
    rootProcessFound = processes.some((process) => process.pid === expected.rootPid);
    if (!Array.isArray(snapshot.externalProcesses)) throw new Error("Snapshot external process evidence is invalid.");
    missingExternalProcessCount = Math.max(0, expected.expectedExternalProcessCount - snapshot.externalProcesses.length);
  }
  return {
    atMs: snapshot.sampledAtUnixMs,
    collectionDurationMicros: snapshot.collectionDurationMicros,
    rssBytes: processes.reduce((total, process) => total + process.rssBytes, 0),
    cumulativeCpuTimeMs: processes.reduce((total, process) => total + process.cpuTimeMs, 0),
    inaccessibleProcessCount,
    rootProcessFound,
    missingExternalProcessCount,
    processes,
  };
}

function isNonnegativeFinite(value) {
  return Number.isFinite(value) && value >= 0;
}

function assertNonnegativeFinite(value, field) {
  if (!isNonnegativeFinite(value)) throw new Error(`Snapshot process ${field} is invalid.`);
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Snapshot process ${field} is invalid.`);
  return value;
}

function assertNonnegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Snapshot ${field} is invalid.`);
  return value;
}

export function deriveBoundaryPoint(before, after, benchmarkCase, switchSequence, samples = [before, after]) {
  const cpuDeltaMs = cpuDeltaMsBetween(before, after, samples);
  const wallMs = after.atMs - before.atMs;
  return {
    caseId: benchmarkCase.caseId,
    switchSequence,
    lane: `${benchmarkCase.workspaceRelation}-${benchmarkCase.sessionState}`,
    transcriptBytes: benchmarkCase.transcriptBytes,
    atMs: after.atMs,
    rssBytes: after.rssBytes,
    cpuPercent: (cpuDeltaMs / wallMs) * 100,
    wallMs,
    cpuDeltaMs,
  };
}

// Identity-aware cumulative CPU consumed by the declared process family between two snapshots.
// Newborn descendants count from birth and exited descendants through their final observed sample.
export function cpuDeltaMsBetween(before, after, samples = [before, after]) {
  if (after.atMs <= before.atMs) throw new Error("Resource boundary timestamps are not increasing.");
  const beforeByIdentity = new Map(before.processes.map((process) => [identity(process), process]));
  const afterByIdentity = new Map(after.processes.map((process) => [identity(process), process]));
  const stableIdentities = [...beforeByIdentity.keys()].filter((key) => afterByIdentity.has(key));
  if (stableIdentities.length === 0) throw new Error("Application process family has no stable identity across a resource boundary.");
  const observationsByIdentity = new Map();
  for (const snapshot of samples.filter((sample) => sample.atMs >= before.atMs && sample.atMs <= after.atMs).toSorted((a, b) => a.atMs - b.atMs)) {
    for (const process of snapshot.processes) {
      const key = identity(process);
      const observations = observationsByIdentity.get(key) ?? [];
      observations.push(process);
      observationsByIdentity.set(key, observations);
    }
  }
  let cpuDeltaMs = 0;
  for (const [key, observations] of observationsByIdentity) {
    const first = beforeByIdentity.get(key) ?? observations[0];
    const last = observations.at(-1);
    const baselineCpuMs = beforeByIdentity.has(key) || !startedWithinBoundary(first, before.atMs, after.atMs) ? first.cpuTimeMs : 0;
    if (last.cpuTimeMs < baselineCpuMs) throw new Error("Application cumulative CPU time moved backwards.");
    cpuDeltaMs += last.cpuTimeMs - baselineCpuMs;
  }
  return cpuDeltaMs;
}

function startedWithinBoundary(process, beforeMs, afterMs) {
  const precisionToleranceMs = 1_000;
  return process.startTimeMs >= beforeMs - precisionToleranceMs && process.startTimeMs <= afterMs + precisionToleranceMs;
}

export function validateCadence(samples, windows, intervalMs, tolerance = 2.5) {
  for (const window of windows) {
    const inWindow = samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs).toSorted((a, b) => a.atMs - b.atMs);
    if (inWindow.length === 0) return { valid: false, reason: "A resource window contains no samples." };
    const minimumSamples = Math.max(1, Math.floor((window.endMs - window.startMs) / intervalMs) - 2);
    if (inWindow.length < minimumSamples) return { valid: false, reason: "A resource window contains too few samples." };
    if (inWindow[0].atMs - window.startMs > intervalMs * tolerance || window.endMs - inWindow.at(-1).atMs > intervalMs * tolerance) {
      return { valid: false, reason: "Resource sample cadence does not cover a window boundary." };
    }
    for (let index = 1; index < inWindow.length; index += 1) {
      if (inWindow[index].atMs - inWindow[index - 1].atMs > intervalMs * tolerance) return { valid: false, reason: "Resource sample cadence gap exceeded tolerance." };
    }
  }
  return { valid: true };
}

const identity = (process) => `${process.pid}:${process.startTimeMs}`;
