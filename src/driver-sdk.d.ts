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
  /** Only for typing-while-streaming: the framework's replay server, which the driver routes the app's agent to through an OpenCode-engine custom provider. */
  readonly replay?: ReplayServer;
}

export interface ReplayServer {
  /** `http://127.0.0.1:<port>/v1`, an OpenAI-compatible chat-completions endpoint. */
  readonly baseUrl: string;
  readonly npm: "@ai-sdk/openai-compatible";
  readonly providerId: "replay";
  readonly modelId: "stream";
  /** Any value; the server ignores it. */
  readonly apiKey: string;
  /** What the driver types, untimed, before each trusted Enter. */
  readonly prompt: string;
  /** The reply's opening characters, the text `firstWordExpression` waits to see painted. */
  readonly replyOpening: string;
  readonly deltaCount: number;
  readonly deltaChars: number;
  readonly intervalMs: number;
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
  /** "empty" for a new thread: its latest turn and first fold count as painted when no transcript row is mounted. */
  readonly destination?: "transcript" | "empty";
}): string;

export interface ScrollFacts {
  /** The transcript scroller the wheel events land on. */
  transcript(): HTMLElement | null;
}

export interface FirstWordFacts {
  /** The new thread's transcript. */
  transcript(): HTMLElement | null;
}

export interface TypingFacts {
  /** The new thread's composer, empty when the recorder is armed. */
  composer(): HTMLElement | null;
}

export interface ScrollRecording {
  readonly kind: "scroll";
  readonly startAt: number;
  readonly endAt: number;
  readonly wheels: readonly { readonly at: number; readonly deltaY: number }[];
  readonly frames: readonly number[];
  readonly scrollTop: { readonly start: number; readonly end: number };
}

export interface FirstWordRecording {
  readonly kind: "first-word";
  readonly startAt: number;
  readonly frames: readonly { readonly at: number; readonly painted: boolean }[];
}

export interface TypingRecording {
  readonly kind: "typing";
  readonly endAt: number;
  readonly keydowns: readonly { readonly key: string; readonly at: number }[];
  readonly frames: readonly { readonly at: number; readonly typed: number }[];
}

export type Recording = ScrollRecording | FirstWordRecording | TypingRecording;

/** Arm before the first trusted wheel event; resolves `tailMs` after the `wheelCount`-th. */
export function scrollExpression<Target>(input: { readonly facts: (target: Target) => ScrollFacts; readonly target: Target; readonly wheelCount: number; readonly tailMs: number; readonly timeoutMs: number }): string;

/** Arm before the trusted Enter keydown; resolves at the first frame that paints `text`. */
export function firstWordExpression<Target>(input: { readonly facts: (target: Target) => FirstWordFacts; readonly target: Target; readonly text: string; readonly timeoutMs: number }): string;

/** Arm before the first trusted keydown; resolves when every key is painted or `missAfterMs` after the last keydown. */
export function typingExpression<Target>(input: { readonly facts: (target: Target) => TypingFacts; readonly target: Target; readonly keys: string; readonly missAfterMs: number; readonly timeoutMs: number }): string;

/** The `durationMs`, `clock` and `frameLog` an `execute` response carries for a resolved recording. */
export function recordingObservation(recording: Recording, options?: { readonly clock?: string; readonly offsetMs?: number }): {
  readonly durationMs: number;
  readonly clock: { readonly kind: "single-monotonic-clock"; readonly clock: string; readonly start: number; readonly end: number };
  readonly frameLog: Recording & { readonly offsetMs: number };
};

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
