import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class DriverProcess {
  static async spawn(executable) {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "inherit"], shell: false });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return new DriverProcess(child);
  }

  constructor(child) {
    this.child = child;
    this.sequence = 0;
    this.pending = new Map();
    this.exited = false;
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.once("exit", (code, signal) => {
      this.exited = true;
      for (const pending of this.pending.values()) pending.reject(new Error(`Driver exited (code=${code}, signal=${signal}).`));
      this.pending.clear();
    });
  }

  request(method, params, timeoutMs = 600_000) {
    if (this.exited) return Promise.reject(new Error("Driver is not running."));
    const correlationId = `request-${this.sequence++}`;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Driver request ${method} timed out.`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(correlationId, { method, resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify({ protocolVersion: 1, kind: "request", correlationId, method, params })}\n`);
    return response;
  }

  async close() {
    if (this.exited) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this.failAll(new Error("Driver wrote non-JSON content to stdout.", { cause }));
      return;
    }
    const pending = this.pending.get(message.correlationId);
    if (!pending || message.protocolVersion !== 1 || message.kind !== "response" || message.method !== pending.method) {
      this.failAll(new Error("Driver returned an unsolicited or mismatched response."));
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.correlationId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(`${message.error?.code ?? "driver-error"}: ${message.error?.message ?? "Unknown driver error"}`));
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
