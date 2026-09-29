import type { Readable, Writable } from "node:stream";

export type DriverMethod = "hello" | "prepare" | "launch" | "execute" | "shutdown";

export interface PrepareParams {
  readonly scenarioId: string;
  readonly scenarioDigestSha256: string;
  readonly scenarioDefinition?: Record<string, unknown>;
  readonly corpusDirectory: string;
  readonly corpusManifestPath: string;
  readonly corpusDigestSha256: string;
  readonly corpusDefinitionDigestSha256: string;
  readonly eventSchemaDigestSha256: string;
  readonly runDirectory: string;
}

/** What a driver knows about its app, evaluated in the renderer for the session being opened. */
export interface AppFacts {
  /** The destination is the session the app displays. */
  displayed(): boolean;
  /** Rows of the destination's latest turn, identified by id. */
  latestTurnRows(): HTMLElement[];
  composer(): HTMLElement | null;
  /** A skeleton or loading placeholder is showing. */
  placeholder(): boolean;
  /** The destination's transcript scroller. */
  transcript(): HTMLElement | null;
  /** Every mounted transcript row. */
  rows(): HTMLElement[];
  rowKey(row: HTMLElement): string;
}

export interface ReadyGates {
  readonly displayedDestination: boolean;
  readonly latestTurnPainted: boolean;
  readonly noPlaceholder: boolean;
  readonly firstFoldComplete: boolean;
  readonly composerEditable: boolean;
  readonly windowVisibleFocused: boolean;
}

export interface ClockFrame {
  readonly at: number;
  readonly gates: ReadyGates;
  readonly signature: string | null;
  readonly mutated: boolean;
}

export interface PageSettle {
  readonly startAt: number;
  readonly settledAt: number;
  readonly timeOrigin: number;
  readonly frames: readonly ClockFrame[];
}

export interface FrameLog {
  readonly startAt: number;
  readonly offsetMs: number;
  readonly frames: readonly ClockFrame[];
}

/**
 * A renderer expression that arms the settle-31-frames clock and resolves to a
 * `PageSettle`. `facts` is serialized into the page with `target` as its
 * argument, so it may use nothing but browser globals and that argument.
 */
export function settleExpression<Target>(input: {
  readonly facts: (target: Target) => AppFacts;
  readonly target: Target;
  readonly timeoutMs: number;
  readonly start: "trusted-pointerdown" | "now";
}): string;

export function frameLogOf(settle: PageSettle, options?: { readonly startAt?: number; readonly offsetMs?: number }): FrameLog;

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
