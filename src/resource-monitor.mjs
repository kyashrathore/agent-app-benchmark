import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class ResourceMonitor {
  static async start(executable, rootProcess, sampleIntervalMs) {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"], shell: false });
    const monitor = new ResourceMonitor(child);
    await monitor.hello;
    monitor.write({ type: "configure", version: 2, rootPid: rootProcess.pid, sampleIntervalMs, externalProcesses: [] });
    monitor.write({ type: "setStreaming", version: 2, enabled: true });
    return monitor;
  }

  constructor(child) {
    this.child = child;
    this.samples = [];
    this.errors = [];
    this.hello = new Promise((resolve, reject) => {
      this.resolveHello = resolve;
      child.once("error", reject);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "hello") this.resolveHello(event);
      else if (event.type === "snapshot") this.samples.push(normalizeSnapshot(event));
      else if (event.type === "error") this.errors.push(event);
    });
  }

  setSampleInterval(sampleIntervalMs) {
    this.write({ type: "setSampleInterval", version: 2, sampleIntervalMs });
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.write({ type: "shutdown", version: 2 });
    this.child.stdin.end();
    await exited;
  }

  write(command) {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }
}

function normalizeSnapshot(snapshot) {
  return {
    atMs: snapshot.sampledAtUnixMs,
    rssBytes: snapshot.processes.reduce((total, process) => total + process.residentBytes, 0),
    cpuPercent: snapshot.processes.reduce((total, process) => total + process.cpuPercent, 0),
    processes: snapshot.processes,
  };
}
