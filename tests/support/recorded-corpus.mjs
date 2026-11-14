import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCorpus, serializeEvents } from "../../src/corpus.mjs";
import { convertOpenCodeExport } from "../../src/opencode-export.mjs";

export const HOME = "/Users/alice";
export const WORKSPACE = `${HOME}/work/ledger`;

export const SOURCE_EVENT_FORMAT = {
  id: "opencode-event",
  sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a",
  envelope: "EventV2.SerializedEvent",
  eventTypes: ["session.created.1", "message.updated.1", "message.part.updated.1"],
};

/**
 * An `opencode session export` in the OpenCode 2.3 shape: `turns` turns, each
 * a user prompt and two assistant steps (reasoning, a read, a shell call that
 * fails, an edit with a snapshot, a closing text), then an idle marker.
 */
export function fixtureExport({ turns = 3, payload = 600 } = {}) {
  const messages = [];
  let at = 1_794_691_957_000;
  const time = (step = 1_000) => (at += step);
  const model = { id: "big-pickle", providerID: "opencode", variant: "default" };
  for (let turn = 0; turn < turns; turn += 1) {
    const id = (kind, index) => `msg_${String(turn).padStart(4, "0")}${kind}${index}fixture`;
    messages.push({ id: id("u", 0), type: "user", text: `Turn ${turn}: read ${WORKSPACE}/src/dates.ts and fix it, alice.`, files: [], time: { created: time() } });
    const created = time();
    messages.push({
      id: id("a", 0),
      type: "assistant",
      agent: "build",
      model,
      time: { created, firstToken: created + 100, streamed: created + 900, completed: created + 1_000 },
      content: [
        { type: "reasoning", text: `Thinking about turn ${turn}. ${"r".repeat(payload)}`, native: { reasoningField: "reasoning_content" }, time: { created: created + 100, completed: created + 400 } },
        { type: "tool", id: `call_read_${turn}`, name: "read", executed: false, state: { status: "completed", input: { path: `${WORKSPACE}/src/dates.ts` }, content: [{ type: "text", text: `Read file ${WORKSPACE}/src/dates.ts\n${"x".repeat(payload)}` }], metadata: { truncated: false } }, time: { created: created + 400, ran: created + 500, completed: created + 600 } },
        { type: "tool", id: `call_shell_${turn}`, name: "shell", state: { status: "error", input: { command: "npm test" }, error: { type: "tool.execution", message: `exit 1, log in ${HOME}/.npm/_logs` }, content: [{ type: "text", text: "FAIL" }] }, time: { created: created + 600, completed: created + 700 } },
      ],
      snapshot: { start: "a".repeat(40), end: "b".repeat(40), files: ["src/dates.ts"] },
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
    });
    const second = time();
    messages.push({
      id: id("a", 1),
      type: "assistant",
      agent: "build",
      model,
      time: { created: second, firstToken: second + 50, streamed: second + 300, completed: second + 320 },
      content: [{ type: "text", text: `Fixed turn ${turn}. ${"t".repeat(payload)}` }],
      finish: "stop",
      cost: 0,
      tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 50, write: 0 } },
    });
    messages.push({ id: id("i", 0), type: "idle", outcome: "succeeded", time: { created: time(10) } });
  }
  return {
    info: { id: "ses_fixtureSessionIdAbc", projectID: "0".repeat(40), model, title: "Bugs in dates.ts", location: { directory: WORKSPACE }, time: { created: messages[0].time.created - 10, updated: at } },
    messages,
  };
}

export function convertFixture(options) {
  return convertOpenCodeExport(fixtureExport(options), { version: "2.3.0", home: HOME, username: "alice" });
}

export function corpusDefinition(id, sessions) {
  return {
    schemaVersion: 1,
    id,
    sourceEventFormat: SOURCE_EVENT_FORMAT,
    workspaceIds: ["workspace-a", "workspace-b"],
    recording: { application: "OpenCode", version: "2.3.0", model: "opencode/big-pickle", project: "Fixture", repository: "https://example.invalid/fixture", revision: "0000000", license: "MIT" },
    sessions,
    derivation: { method: "redacted recorded agent session", sourceFamilies: ["opencode"], privateContentCopied: false },
    description: "Test corpus built from the fixture export.",
  };
}

/** Builds `definition` from the fixture recording into `root/corpus`; the recording stays at `root/recording.ndjson`. */
export async function buildTestCorpus(root, definition, options) {
  const recording = path.join(root, "recording.ndjson");
  await writeFile(recording, serializeEvents(convertFixture(options).events));
  return buildCorpus(definition, recording, path.join(root, "corpus"));
}

/** A walkable corpus: control, two 4 KiB sessions (one per workspace), and a long thread of at least 20 messages. */
export const WALK_CORPUS = corpusDefinition("test-corpus", [
  { logicalSessionId: "long-thread-20", workspaceId: "workspace-a", role: "long-thread", cut: { messages: 20 } },
  { logicalSessionId: "control", workspaceId: "workspace-a", role: "control", cut: { turns: 1 } },
  { logicalSessionId: "walk-a", workspaceId: "workspace-a", role: "size-latency", cut: { transcriptBytes: 4096 } },
  { logicalSessionId: "progressive-resource-4096", workspaceId: "workspace-a", role: "progressive-resource", cut: { transcriptBytes: 4096 } },
  { logicalSessionId: "walk-b", workspaceId: "workspace-b", role: "across-workspaces-cold", cut: { transcriptBytes: 4096 } },
]);
