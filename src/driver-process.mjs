import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assertContract } from "./contracts.mjs";

const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export class DriverProcess {
  static async spawn(options) {
    if (!options || typeof options.executable !== "string" || options.executable.length === 0) throw new Error("Driver executable is required.");
    const child = spawn(options.executable, options.args ?? [], {
      cwd: options.cwd,
      env: buildEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
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
    this.protocolError = undefined;
    this.stderr = "";
    this.exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const remaining = MAX_STDERR_BYTES - Buffer.byteLength(this.stderr);
      if (remaining > 0) this.stderr += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
    });
    child.once("exit", (code, signal) => {
      this.exited = true;
      const suffix = this.stderr.length > 0 ? ` stderr: ${this.stderr}` : "";
      this.failAll(new Error(`Driver exited (code=${code}, signal=${signal}).${suffix}`));
    });
  }

  request(method, params, timeoutMs = 120_000) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (this.exited) return Promise.reject(new Error("Driver is not running."));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) throw new Error("Driver timeout is outside the allowed range.");
    const correlationId = `request-${this.sequence++}`;
    const message = { protocolVersion: 1, kind: "request", correlationId, method, params };
    assertContract("driverMessage", message, "driver request");
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.protocolFailure(`Driver request ${method} timed out after ${timeoutMs} ms.`);
      }, timeoutMs);
      timeout.unref();
      this.pending.set(correlationId, { method, resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return response;
  }

  async close() {
    if (this.exited) return this.exit;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    timer.unref();
    const result = await this.exit;
    clearTimeout(timer);
    return result;
  }

  onLine(line) {
    if (Buffer.byteLength(line) > MAX_STDOUT_LINE_BYTES) return this.protocolFailure("Driver wrote an oversized stdout line.");
    let message;
    try {
      message = JSON.parse(line);
      assertContract("driverMessage", message, "driver response");
    } catch (cause) {
      return this.protocolFailure("Driver wrote an invalid NDJSON response.", cause);
    }
    const pending = this.pending.get(message.correlationId);
    if (!pending || message.kind !== "response" || message.method !== pending.method) {
      return this.protocolFailure("Driver returned an unsolicited, duplicate, or mismatched response.");
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.correlationId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
  }

  protocolFailure(message, cause) {
    this.protocolError = new Error(message, cause ? { cause } : undefined);
    this.failAll(this.protocolError);
    this.child.kill("SIGTERM");
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function buildEnvironment(additions = {}) {
  const allowed = ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"];
  const environment = Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(additions)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string") throw new Error(`Driver environment entry ${key} is invalid.`);
    environment[key] = value;
  }
  return environment;
}
