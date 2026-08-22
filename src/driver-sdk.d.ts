import type { Readable, Writable } from "node:stream";

export type DriverMethod = "hello" | "prepare" | "launch" | "execute" | "shutdown";

export interface DriverHandlers {
  hello(params: Record<string, unknown>): unknown | Promise<unknown>;
  prepare(params: Record<string, unknown>): unknown | Promise<unknown>;
  launch(params: Record<string, unknown>): unknown | Promise<unknown>;
  execute(params: Record<string, unknown>): unknown | Promise<unknown>;
  shutdown(params: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface DriverStreams {
  readonly input?: Readable;
  readonly output?: Writable;
}

export function serveDriver(handlers: DriverHandlers, streams?: DriverStreams): Promise<void>;
