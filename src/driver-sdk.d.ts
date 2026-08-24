import type { Readable, Writable } from "node:stream";

export type DriverMethod = "hello" | "prepare" | "launch" | "execute" | "shutdown";
export type WorkspacePanelAction = "open-cold" | "interrupt-open-close" | "interrupt-close-open" | "open-warm-data" | "switch-surface" | "open-file" | "switch-file-tab" | "toggle-diff-view" | "collapse-all" | "expand-all";
export type WorkspacePanelProfile = "closed" | "files" | "diff";

export interface WorkspaceLoad {
  readonly directoryCount: number;
  readonly sourceFileCount: number;
  readonly sourceFileBytes: number;
  readonly changedFileCount: number;
  readonly diffHunksPerFile: number;
  readonly diffLinesPerHunk: number;
  readonly openFileTabCount: number;
}

export interface RendererScriptAttribution {
  readonly functionName: string;
  readonly invokerType: string;
  readonly sourceURL: string;
  readonly duration: number;
  readonly forcedStyleAndLayoutDuration: number;
}

export interface RendererTrace {
  readonly clock: string;
  readonly transitionMode: "none" | "animated";
  readonly milestones: readonly { readonly id: string; readonly at: number }[];
  readonly frameTimestampsMs: readonly number[];
  readonly longAnimationFrames: readonly {
    readonly start: number;
    readonly duration: number;
    readonly blockingDuration: number;
    readonly renderStart: number;
    readonly styleAndLayoutStart: number;
    readonly scripts: readonly RendererScriptAttribution[];
  }[];
  readonly counters: {
    readonly scriptDurationMs: number;
    readonly styleRecalcDurationMs: number;
    readonly layoutDurationMs: number;
    readonly taskDurationMs: number;
  };
}

export interface PrepareParams {
  readonly scenarioId: string;
  readonly scenarioDigestSha256: string;
  readonly scenarioDefinition: Record<string, unknown>;
  readonly fixtureSeed: string;
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly corpusDigestSha256: string;
  readonly corpusDefinitionDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
  readonly runDirectory: string;
}

export interface DriverHandlers {
  hello(params: Record<string, unknown>): unknown | Promise<unknown>;
  prepare(params: PrepareParams): unknown | Promise<unknown>;
  launch(params: Record<string, unknown>): unknown | Promise<unknown>;
  execute(params: Record<string, unknown>): unknown | Promise<unknown>;
  shutdown(params: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface DriverStreams {
  readonly input?: Readable;
  readonly output?: Writable;
}

export function serveDriver(handlers: DriverHandlers, streams?: DriverStreams): Promise<void>;
