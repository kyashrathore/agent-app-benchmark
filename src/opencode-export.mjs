import path from "node:path";
import { assertPublicValue, assertSessionEvents, mapStrings, openCodeId } from "./corpus.mjs";

export const RECORDED_WORKSPACE_DIRECTORY = "/benchmark/workspace-a";
export const REDACTED_USER = "user";

const SNAPSHOT = /^[0-9a-f]{40}$/;
const FINISH_REASONS = new Set(["stop", "length", "tool-calls", "content-filter", "error", "unknown"]);
const DROPPED_TYPES = new Set(["idle", "system", "agent-switched", "model-switched", "location-switched"]);
const V1_ERROR_NAMES = {
  aborted: "MessageAbortedError",
  "provider.auth": "ProviderAuthError",
  "provider.content-filter": "ContentFilterError",
  "provider.invalid-request": "ContextOverflowError",
  "provider.invalid-output": "MessageOutputLengthError",
  "provider.error": "APIError",
};

/**
 * Rewrites every string of an export, keys included: the session directory
 * (absolute or `~/`-relative), and then the home directory, become the
 * benchmark workspace, each extra pair is replaced, and the user name is
 * replaced anywhere, in any case.
 */
export function redactor({ directory, home, username, replacements = [] }) {
  const pairs = [[directory, RECORDED_WORKSPACE_DIRECTORY]];
  const relative = path.relative(home, directory);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) pairs.push([`~/${relative}`, RECORDED_WORKSPACE_DIRECTORY]);
  pairs.push([home, RECORDED_WORKSPACE_DIRECTORY], ...replacements.filter(([from]) => from.length > 0));
  const user = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return (text) => pairs.reduce((value, [from, to]) => value.replaceAll(from, to), text).replace(user, REDACTED_USER);
}

/**
 * Converts `opencode session export` output from OpenCode 2.3 into one
 * session's corpus events (session.created.1, message.updated.1,
 * message.part.updated.1), the shape OpenCode 2's own V1 migration reads back.
 * Returns the events and the count of 2.x messages that have no 1.x event, by
 * type. Throws on any secret-looking string left after redaction.
 */
export function convertOpenCodeExport(exported, { version, home, username, replacements = [] }) {
  if (!exported?.info || !Array.isArray(exported.messages)) throw new Error("The export has no session info and messages.");
  if (exported.messages.some((message) => message.info !== undefined && message.type === undefined)) {
    throw new Error("This is an OpenCode 1.x export; the converter reads OpenCode 2.3 `opencode session export` output.");
  }
  const directory = exported.info.location?.directory;
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("The export has no session directory.");
  const redact = redactor({ directory, home, username, replacements });
  const session = mapStrings(exported, redact);
  const events = [];
  const dropped = {};
  const sessionId = openCodeId("ses", BigInt(session.info.time.created) * 4096n + 1n, `recording:${session.info.id}`);
  const emit = (type, data) => events.push({ id: `evt_${String(events.length).padStart(12, "0")}`, type, seq: events.length, aggregateID: sessionId, data: { sessionID: sessionId, ...data } });
  const emitPart = (messageId, index, at, part) => emit("message.part.updated.1", {
    part: { id: `prt_${messageId.slice(4)}${String(index).padStart(5, "0")}`, sessionID: sessionId, messageID: messageId, ...part },
    time: at,
  });
  let agent = session.messages.find((message) => message.type === "assistant")?.agent ?? "build";
  let model = session.info.model;
  let lastUserId;

  emit("session.created.1", {
    info: {
      id: sessionId,
      slug: "recording",
      projectID: "pro_benchmark_workspace-a",
      workspaceID: "workspace-a",
      directory: RECORDED_WORKSPACE_DIRECTORY,
      title: session.info.title,
      version,
      time: { created: session.info.time.created, updated: session.info.time.updated },
    },
  });

  const emitUser = (id, created, parts) => {
    lastUserId = id;
    emit("message.updated.1", { info: { id, sessionID: sessionId, role: "user", time: { created }, agent, model: { providerID: model.providerID, modelID: model.id } } });
    parts.forEach((part, index) => emitPart(id, index, created, part));
  };

  for (const message of session.messages) {
    if (DROPPED_TYPES.has(message.type)) {
      if (message.type === "agent-switched") agent = message.agent;
      if (message.type === "model-switched") model = message.model;
      dropped[message.type] = (dropped[message.type] ?? 0) + 1;
      continue;
    }
    const created = message.time.created;
    if (message.type === "user") {
      for (const field of ["files", "agents", "skills"]) {
        if ((message[field] ?? []).length > 0) throw new Error(`User message ${message.id} carries ${field}, which the corpus event format does not hold.`);
      }
      emitUser(message.id, created, [{ type: "text", text: message.text, time: { start: created, end: created } }]);
    } else if (message.type === "synthetic") {
      emitUser(message.id, created, [{ type: "text", text: message.text, synthetic: true, time: { start: created, end: created } }]);
    } else if (message.type === "compaction") {
      if (message.status !== "completed") {
        dropped[`compaction-${message.status}`] = (dropped[`compaction-${message.status}`] ?? 0) + 1;
        continue;
      }
      emitUser(message.id, created, [{ type: "compaction", auto: message.reason === "auto" }]);
      const summaryId = `${message.id}s`;
      emit("message.updated.1", { info: { ...assistantInfo({ ...message, agent: "compaction", time: { created, completed: created }, finish: "stop", model: message.model ?? model }, summaryId, sessionId, lastUserId), summary: true } });
      emitPart(summaryId, 0, created, { type: "text", text: message.summary, time: { start: created, end: created } });
    } else if (message.type === "assistant") {
      agent = message.agent;
      model = message.model;
      emit("message.updated.1", { info: assistantInfo(message, message.id, sessionId, lastUserId) });
      for (const [index, part] of assistantParts(message).entries()) emitPart(message.id, index, part.at, part.part);
    } else {
      throw new Error(`Message ${message.id} has type ${message.type}, which the converter does not map.`);
    }
  }
  const last = events.at(-1);
  events[0].data.info.time.updated = Math.max(session.info.time.updated, last.type === "message.part.updated.1" ? last.data.time : last.data.info.time.created);
  assertSessionEvents(events, "converted export");
  const forbidden = [home, username, directory].map((value) => value.toLowerCase());
  for (const event of events) {
    assertPublicValue(event, `converted event ${event.seq}`);
    const lower = JSON.stringify(event).toLowerCase();
    if (forbidden.some((value) => lower.includes(value))) throw new Error(`converted event ${event.seq} still names the home directory or user.`);
  }
  return { events, dropped };
}

function tokensOf(message) {
  const tokens = message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  return { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: { read: tokens.cache.read, write: tokens.cache.write } };
}

function assistantInfo(message, id, sessionId, parentId) {
  return {
    id,
    sessionID: sessionId,
    role: "assistant",
    time: { created: message.time.created, ...(message.time.completed === undefined ? {} : { completed: message.time.completed }) },
    ...(parentId === undefined ? {} : { parentID: parentId }),
    modelID: message.model.id,
    providerID: message.model.providerID,
    ...(message.model.variant ? { variant: message.model.variant } : {}),
    mode: message.agent,
    agent: message.agent,
    path: { cwd: RECORDED_WORKSPACE_DIRECTORY, root: RECORDED_WORKSPACE_DIRECTORY },
    cost: message.cost ?? 0,
    tokens: tokensOf(message),
    ...(message.finish ? { finish: message.finish } : {}),
    ...(message.error ? { error: { name: V1_ERROR_NAMES[message.error.type] ?? "UnknownError", data: { message: message.error.message } } } : {}),
  };
}

/** One 2.x assistant message is one step: step-start, its content in order, a patch for the files its snapshot changed, step-finish. */
function assistantParts(message) {
  const created = message.time.created;
  const textStart = message.time.firstToken ?? created;
  const textEnd = message.time.streamed ?? message.time.completed ?? textStart;
  const parts = [{ at: created, part: { type: "step-start", ...(message.snapshot?.start ? { snapshot: message.snapshot.start } : {}) } }];
  for (const item of message.content) {
    if (item.type === "text") {
      parts.push({ at: textEnd, part: { type: "text", text: item.text, time: { start: textStart, end: textEnd }, ...(item.native ? { metadata: item.native } : {}) } });
    } else if (item.type === "reasoning") {
      const start = item.time?.created ?? created;
      const end = item.time?.completed ?? start;
      parts.push({ at: end, part: { type: "reasoning", text: item.text, time: { start, end }, ...(item.native ? { metadata: item.native } : {}) } });
    } else if (item.type === "tool") {
      const start = item.time.created;
      const end = item.time.completed ?? item.time.ran ?? start;
      parts.push({ at: end, part: { type: "tool", callID: item.id, tool: item.name, ...(item.native ? { metadata: item.native } : {}), state: toolState(item, { start, end }) } });
    } else {
      throw new Error(`Assistant message ${message.id} has content of type ${item.type}, which the converter does not map.`);
    }
  }
  const snapshot = message.snapshot?.end ?? message.snapshot?.start;
  if ((message.snapshot?.files ?? []).length > 0 && SNAPSHOT.test(snapshot ?? "")) {
    parts.push({ at: message.time.completed ?? textEnd, part: { type: "patch", hash: snapshot, files: message.snapshot.files } });
  }
  parts.push({
    at: message.time.completed ?? textEnd,
    part: {
      type: "step-finish",
      reason: FINISH_REASONS.has(message.finish) ? message.finish : "unknown",
      ...(message.snapshot?.end ? { snapshot: message.snapshot.end } : {}),
      cost: message.cost ?? 0,
      tokens: tokensOf(message),
    },
  });
  return parts;
}

function toolState(tool, time) {
  const state = tool.state;
  const text = (state.content ?? []).map((item) => {
    if (item.type !== "text") throw new Error(`Tool call ${tool.id} returned ${item.type} content, which the corpus event format does not hold.`);
    return item.text;
  }).join("\n");
  if (state.status === "completed") return { status: "completed", input: state.input, output: text, title: "", metadata: state.metadata ?? {}, time };
  if (state.status === "error") {
    const metadata = { ...(state.metadata ?? {}), ...(state.content ? { output: text } : {}) };
    return { status: "error", input: state.input, error: state.error.message, ...(Object.keys(metadata).length ? { metadata } : {}), time };
  }
  return { status: "error", input: typeof state.input === "object" && state.input !== null ? state.input : {}, error: "Tool execution was interrupted", time };
}
