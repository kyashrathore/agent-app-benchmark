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
    await monitor.waitForHello();
    const [root, ...external] = rootProcesses;
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
    this.write({ type: "shutdown", version: 2 });
    this.child.stdin.end();
    return this.exit;
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
      const snapshot = normalizeSnapshot(event);
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
}

export function normalizeSnapshot(snapshot) {
  const processes = snapshot.processes.map((process) => ({
    pid: process.pid,
    startTimeMs: process.startTimeMs,
    cpuTimeMs: process.cpuTimeMs,
    rssBytes: process.residentBytes,
    name: process.name,
  }));
  return {
    atMs: snapshot.sampledAtUnixMs,
    collectionDurationMicros: snapshot.collectionDurationMicros,
    rssBytes: processes.reduce((total, process) => total + process.rssBytes, 0),
    cumulativeCpuTimeMs: processes.reduce((total, process) => total + process.cpuTimeMs, 0),
    processes,
  };
}

export function deriveBoundaryPoint(before, after, benchmarkCase, switchSequence) {
  if (after.atMs <= before.atMs) throw new Error("Resource boundary timestamps are not increasing.");
  const beforeByIdentity = new Map(before.processes.map((process) => [identity(process), process]));
  const afterByIdentity = new Map(after.processes.map((process) => [identity(process), process]));
  if (beforeByIdentity.size !== afterByIdentity.size || [...beforeByIdentity.keys()].some((key) => !afterByIdentity.has(key))) {
    throw new Error("Application process-family membership changed across a resource boundary.");
  }
  let cpuDeltaMs = 0;
  for (const [key, prior] of beforeByIdentity) {
    const next = afterByIdentity.get(key);
    if (next.cpuTimeMs < prior.cpuTimeMs) throw new Error("Application cumulative CPU time moved backwards.");
    cpuDeltaMs += next.cpuTimeMs - prior.cpuTimeMs;
  }
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

export function validateCadence(samples, windows, intervalMs, tolerance = 2.5) {
  for (const window of windows) {
    const inWindow = samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs).toSorted((a, b) => a.atMs - b.atMs);
    if (inWindow.length === 0) return { valid: false, reason: "A resource window contains no samples." };
    for (let index = 1; index < inWindow.length; index += 1) {
      if (inWindow[index].atMs - inWindow[index - 1].atMs > intervalMs * tolerance) return { valid: false, reason: "Resource sample cadence gap exceeded tolerance." };
    }
  }
  return { valid: true };
}

const identity = (process) => `${process.pid}:${process.startTimeMs}`;
