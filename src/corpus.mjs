import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { digest } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { REPOSITORY_ROOT, resolveInside, resolveRealFileInside } from "./paths.mjs";

const MARKER = ".agent-app-benchmark-corpus";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 196 * 1024 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const EVENT_SCHEMAS = {
  "opencode-event": JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "schemas", "opencode-event.schema.json"), "utf8")),
};
const TRANSCRIPT_BYTE_DEFINITION = "UTF-8 bytes of completed text, reasoning, serialized tool input, and tool output payloads";
const RECORDED_WORKSPACE_DIRECTORY = "/benchmark/workspace-a";
const FIRST_SESSION_AT = 1_700_000_000_000;
const HOUR_MS = 3_600_000;
const COPY_GAP_MS = 60_000;
const ID_KEY_MASK = (1n << 48n) - 1n;

const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const SECRET_PATTERNS = [
  ["an OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["a Stripe-style key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["a home-directory path", /(?:\/Users\/|\/home\/|[a-z]:\\users\\)[^\s/\\"'`]+/i],
];

export function eventSchemaDigest(sourceEventFormatId) {
  const schema = EVENT_SCHEMAS[sourceEventFormatId];
  if (!schema) throw new Error(`Unknown source event format ${sourceEventFormatId}.`);
  return digest(schema);
}

/** Throws when any string in the value, keys included, holds an email outside the reserved example domains, a credential, or a home-directory path. */
export function assertPublicValue(value, label) {
  mapStrings(value, (text) => {
    assertPublicText(text, label);
    return text;
  });
}

function assertPublicText(text, label) {
  for (const match of text.matchAll(EMAIL)) {
    if (!RESERVED_EMAIL_DOMAIN.test(match[1])) throw new Error(`${label} contains an email address.`);
  }
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${label} contains ${name}.`);
  }
}

/** An OpenCode-style id whose first 12 hex digits sort by `key` (milliseconds × 4096 plus a counter). */
export function openCodeId(prefix, key, seed) {
  const encoded = (BigInt(key) & ID_KEY_MASK).toString(16).padStart(12, "0");
  const tail = createHash("sha256").update(`${prefix}:${seed}`).digest("hex").slice(0, 14);
  return `${prefix}_${encoded}${tail}`;
}

export function emptyMeasurements() {
  return {
    transcriptBytes: 0,
    messageCount: 0,
    partCount: 0,
    textBytes: 0,
    reasoningBytes: 0,
    toolInputBytes: 0,
    toolOutputBytes: 0,
    toolCallCount: 0,
    patchCount: 0,
    eventCount: 0,
  };
}

/** A failed tool's error text counts as its output. */
export function measureEvent(measured, event) {
  measured.eventCount += 1;
  if (event.type === "message.updated.1") measured.messageCount += 1;
  if (event.type !== "message.part.updated.1") return;
  measured.partCount += 1;
  const part = event.data.part;
  if (part.type === "text") measured.textBytes += Buffer.byteLength(part.text, "utf8");
  if (part.type === "reasoning") measured.reasoningBytes += Buffer.byteLength(part.text, "utf8");
  if (part.type === "tool") {
    measured.toolCallCount += 1;
    measured.toolInputBytes += Buffer.byteLength(JSON.stringify(part.state.input), "utf8");
    measured.toolOutputBytes += Buffer.byteLength(part.state.status === "completed" ? part.state.output : part.state.error, "utf8");
  }
  if (part.type === "patch") measured.patchCount += 1;
  measured.transcriptBytes = measured.textBytes + measured.reasoningBytes + measured.toolInputBytes + measured.toolOutputBytes;
}

export function measureEvents(events) {
  const measured = emptyMeasurements();
  for (const event of events) measureEvent(measured, event);
  return measured;
}

/** Reads a recording: one session's events, in order, as the import wrote them. */
export async function readRecording(file) {
  const bytes = await readFile(file);
  const events = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.length === 0) continue;
    events.push(JSON.parse(line));
  }
  assertSessionEvents(events, "recording");
  return { events, digestSha256: createHash("sha256").update(bytes).digest("hex") };
}

export function serializeEvents(events) {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

export function assertSessionEvents(events, label) {
  const sessionId = events[0]?.aggregateID;
  if (events[0]?.type !== "session.created.1") throw new Error(`${label} does not begin with session.created.1.`);
  const seen = new Set();
  events.forEach((event, index) => {
    assertContract("opencodeEvent", event, `${label} event ${index}`);
    validateEventIdentity(event, { file: label, nativeSessionId: sessionId }, index);
    if (seen.has(event.id)) throw new Error(`${label} repeats event id ${event.id}.`);
    seen.add(event.id);
  });
}

/**
 * The recording's turns in order. A turn is a user message and every message
 * after it up to the next user message.
 */
export function recordingTurns(events) {
  const starts = [];
  events.forEach((event, index) => {
    if (event.type === "message.updated.1" && event.data.info.role === "user") starts.push(index);
  });
  if (starts.length === 0) throw new Error("The recording holds no user message.");
  if (starts[0] !== 1) throw new Error("The recording does not begin with a user message.");
  return starts.map((start, index) => {
    const turn = events.slice(start, starts[index + 1] ?? events.length);
    return { events: turn, measured: measureEvents(turn) };
  });
}

/**
 * How many turns a session keeps of the recording's turns repeated end to
 * end: exactly `turns`, or the fewest whose total reaches the cut's transcript
 * bytes or messages.
 */
export function turnsForCut(turns, cut) {
  if (cut.turns !== undefined) return cut.turns;
  const field = cut.transcriptBytes !== undefined ? "transcriptBytes" : "messageCount";
  const target = cut.transcriptBytes ?? cut.messages;
  let total = 0;
  let count = 0;
  while (total < target) {
    total += turns[count % turns.length].measured[field];
    count += 1;
  }
  return count;
}

/**
 * Builds every session of the definition from one recording. A session holds
 * the recording's turns in order, repeated until its cut is reached; each
 * repetition (copy) gets fresh ids and times one recording span plus a minute
 * after the copy before it. Session k starts `spacing` after session k - 1,
 * where `spacing` exceeds the longest session, so creation order, recency
 * order and the definition's order agree.
 */
export async function buildCorpus(definition, recordingFile, outputDirectory) {
  const recording = await readRecording(recordingFile);
  const output = path.resolve(outputDirectory);
  await assertTargetDoesNotExist(output);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomBytes(6).toString("hex")}`);
  await mkdir(path.join(temporary, "sessions"), { recursive: true, mode: 0o700 });
  try {
    const turns = recordingTurns(recording.events);
    const start = recording.events[0].data.info.time.created;
    const copyStrideMs = lastTime(recording.events) - start + COPY_GAP_MS;
    const counts = definition.sessions.map((slot) => turnsForCut(turns, slot.cut));
    const spacing = (Math.ceil((Math.max(...counts.map((count) => Math.ceil(count / turns.length))) * copyStrideMs) / HOUR_MS) + 1) * HOUR_MS;
    const sessions = [];
    for (const [index, slot] of definition.sessions.entries()) {
      const offsetMs = FIRST_SESSION_AT + index * spacing - start;
      const events = materializeSlot(recording.events[0], turns, counts[index], copyStrideMs, slot, index, offsetMs);
      sessions.push({ ...(await writeSession(slot, events, temporary)), turns: counts[index], copies: Math.ceil(counts[index] / turns.length) });
    }
    const manifestCore = {
      schemaVersion: 1,
      corpusId: definition.id,
      definitionDigestSha256: digest(definition),
      sourceEventFormat: { ...definition.sourceEventFormat, schemaDigestSha256: eventSchemaDigest(definition.sourceEventFormat.id) },
      recording: { ...definition.recording, digestSha256: recording.digestSha256, turns: turns.length, ...pick(measureEvents(recording.events), ["messageCount", "transcriptBytes"]) },
      transcriptByteDefinition: TRANSCRIPT_BYTE_DEFINITION,
      derivation: definition.derivation,
      topology: { workspaceCount: definition.workspaceIds.length, sessionCount: sessions.length, controlSessionId: "control" },
      sessions,
    };
    const corpusDigestSha256 = digest(manifestCore);
    const manifest = { ...manifestCore, corpusDigestSha256 };
    assertContract("corpusManifest", manifest, "built corpus manifest");
    await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(temporary, MARKER), `${corpusDigestSha256}\n`, { mode: 0o600 });
    await rename(temporary, output);
    return { path: output, manifest, digestSha256: corpusDigestSha256 };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function materializeSlot(createdEvent, turns, turnCount, copyStrideMs, slot, index, offsetMs) {
  const created = createdEvent.data.info.time.created + offsetMs;
  const sessionId = openCodeId("ses", BigInt(created) * 4096n + 1n, slot.logicalSessionId);
  const workspaceDirectory = `/benchmark/${slot.workspaceId}`;
  const relocate = slot.workspaceId === "workspace-a" ? (value) => value : (value) => mapStrings(value, (text) => text.replaceAll(RECORDED_WORKSPACE_DIRECTORY, workspaceDirectory));
  const nextKey = { message: 0n, part: 0n };
  const keyed = (kind, time) => {
    const key = BigInt(time) * 4096n > nextKey[kind] ? BigInt(time) * 4096n : nextKey[kind] + 1n;
    nextKey[kind] = key;
    return key;
  };
  const sequence = [{ event: createdEvent, copy: 0 }];
  for (let turn = 0; turn < turnCount; turn += 1) {
    for (const event of turns[turn % turns.length].events) sequence.push({ event, copy: Math.floor(turn / turns.length) });
  }
  const ids = new Map();
  let updated = created;
  const events = sequence.map(({ event, copy }, seq) => {
    const shift = offsetMs + copy * copyStrideMs;
    const at = (value) => (value === undefined ? undefined : value + shift);
    const data = relocate(structuredClone(event.data));
    data.sessionID = sessionId;
    if (event.type === "session.created.1") {
      data.info = {
        id: sessionId,
        slug: slot.logicalSessionId,
        projectID: `pro_benchmark_${slot.workspaceId}`,
        workspaceID: slot.workspaceId,
        directory: workspaceDirectory,
        title: `${index + 1}. ${data.info.title}`,
        version: data.info.version,
        time: { created, updated: created },
      };
    }
    if (event.type === "message.updated.1") {
      const info = data.info;
      const id = openCodeId("msg", keyed("message", at(info.time.created)), `${slot.logicalSessionId}:${copy}:${info.id}`);
      ids.set(info.id, id);
      info.id = id;
      info.sessionID = sessionId;
      if (info.parentID !== undefined) info.parentID = ids.get(info.parentID);
      info.time = Object.fromEntries(Object.entries(info.time).map(([key, value]) => [key, at(value)]));
      updated = Math.max(updated, ...Object.values(info.time));
    }
    if (event.type === "message.part.updated.1") {
      const part = data.part;
      part.id = openCodeId("prt", keyed("part", at(data.time)), `${slot.logicalSessionId}:${copy}:${part.id}`);
      part.sessionID = sessionId;
      part.messageID = ids.get(part.messageID);
      if (part.time) part.time = { start: at(part.time.start), end: at(part.time.end) };
      if (part.state?.time) part.state.time = { start: at(part.state.time.start), end: at(part.state.time.end) };
      data.time = at(data.time);
      updated = Math.max(updated, data.time);
    }
    return { id: openCodeId("evt", BigInt(created) * 4096n + BigInt(seq), `${slot.logicalSessionId}:${seq}`), type: event.type, seq, aggregateID: sessionId, data };
  });
  events[0].data.info.time.updated = updated;
  return events;
}

function lastTime(events) {
  let last = events[0].data.info.time.created;
  for (const event of events) {
    if (event.type === "message.updated.1") last = Math.max(last, ...Object.values(event.data.info.time));
    if (event.type === "message.part.updated.1") last = Math.max(last, event.data.time);
  }
  return last;
}

async function writeSession(slot, events, root) {
  const relativeFile = `sessions/${slot.logicalSessionId}.ndjson`;
  const stream = createWriteStream(resolveInside(root, relativeFile), { encoding: "utf8", mode: 0o600 });
  const hash = createHash("sha256");
  const measured = emptyMeasurements();
  assertSessionEvents(events, slot.logicalSessionId);
  assertAscendingIds(events, slot.logicalSessionId);
  for (const event of events) {
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error(`${slot.logicalSessionId} event ${event.seq} exceeds the event size limit.`);
    assertPublicValue(event, `${slot.logicalSessionId} event ${event.seq}`);
    hash.update(line);
    if (!stream.write(line)) await new Promise((resolve) => stream.once("drain", resolve));
    measureEvent(measured, event);
  }
  stream.end();
  await finished(stream);
  return {
    logicalSessionId: slot.logicalSessionId,
    nativeSessionId: events[0].aggregateID,
    workspaceId: slot.workspaceId,
    role: slot.role,
    cut: slot.cut,
    ...measured,
    file: relativeFile,
    fileDigestSha256: hash.digest("hex"),
  };
}

/** Apps order messages by id and parts by id within a message; a wrapped 48-bit key would break that order. */
function assertAscendingIds(events, label) {
  let lastMessage = "";
  const lastPart = new Map();
  for (const event of events) {
    if (event.type === "message.updated.1") {
      if (event.data.info.id <= lastMessage) throw new Error(`${label} message ids are not ascending.`);
      lastMessage = event.data.info.id;
    }
    if (event.type === "message.part.updated.1") {
      const { id, messageID } = event.data.part;
      if (id <= (lastPart.get(messageID) ?? "")) throw new Error(`${label} part ids are not ascending.`);
      lastPart.set(messageID, id);
    }
  }
}

export async function verifyCorpus(corpusDirectory) {
  const root = path.resolve(corpusDirectory);
  const marker = await lstat(path.join(root, MARKER)).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${root} holds no built corpus; build it with \`agent-app-benchmark corpus build\`.`);
    throw error;
  });
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Corpus marker is invalid.");
  const manifestFile = path.join(root, "manifest.json");
  const manifestStat = await lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Corpus manifest must be a regular file.");
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("Corpus manifest exceeds the public size limit.");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assertContract("corpusManifest", manifest, "corpus manifest");
  if (manifest.sessions.length !== manifest.topology.sessionCount) throw new Error("Corpus manifest topology is invalid.");
  if (!manifest.sessions.some((session) => session.logicalSessionId === manifest.topology.controlSessionId)) throw new Error("Corpus manifest has no control session.");
  if (manifest.sourceEventFormat.schemaDigestSha256 !== eventSchemaDigest(manifest.sourceEventFormat.id)) throw new Error("Corpus event schema digest is not canonical.");
  const seenEventIds = new Set();
  const seenSessionIds = new Set();
  for (const session of manifest.sessions) {
    if (seenSessionIds.has(session.logicalSessionId)) throw new Error(`Duplicate session ${session.logicalSessionId}.`);
    seenSessionIds.add(session.logicalSessionId);
    const file = await resolveRealFileInside(root, session.file, "corpus session file");
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`${session.file} must be a regular file.`);
    if (fileStat.size > MAX_SESSION_BYTES) throw new Error(`${session.file} exceeds the public corpus session size limit.`);
    const hash = createHash("sha256");
    const measured = emptyMeasurements();
    let expectedSequence = 0;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      hash.update(`${line}\n`);
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error(`${session.file} contains an oversized event.`);
      const event = JSON.parse(line);
      assertPublicValue(event, session.file);
      assertContract("opencodeEvent", event, `${session.file} event ${measured.eventCount}`);
      validateEventIdentity(event, session, expectedSequence);
      if (seenEventIds.has(event.id)) throw new Error(`Duplicate event id ${event.id}.`);
      seenEventIds.add(event.id);
      measureEvent(measured, event);
      expectedSequence += 1;
    }
    if (hash.digest("hex") !== session.fileDigestSha256) throw new Error(`${session.file} digest mismatch.`);
    for (const key of Object.keys(measured)) {
      if (measured[key] !== session[key]) throw new Error(`${session.file} ${key} mismatch: ${measured[key]} != ${session[key]}.`);
    }
  }
  const { corpusDigestSha256, ...manifestCore } = manifest;
  if (digest(manifestCore) !== corpusDigestSha256) throw new Error("Corpus manifest digest mismatch.");
  const recorded = (await readFile(path.join(root, MARKER), "utf8")).trim();
  if (recorded !== corpusDigestSha256) throw new Error("Corpus marker digest mismatch.");
  return { path: root, manifest, digestSha256: corpusDigestSha256 };
}

function validateEventIdentity(event, session, expectedSequence) {
  if (event.seq !== expectedSequence) throw new Error(`${session.file} has invalid sequence ${event.seq}; expected ${expectedSequence}.`);
  if (event.aggregateID !== session.nativeSessionId) throw new Error(`${session.file} has an invalid aggregate id.`);
  if (event.data.sessionID !== session.nativeSessionId) throw new Error(`${session.file} has an invalid session id.`);
  if (event.type === "session.created.1" && expectedSequence !== 0) throw new Error(`${session.file} creates its session after sequence zero.`);
  if (event.type !== "session.created.1" && expectedSequence === 0) throw new Error(`${session.file} does not begin with session.created.1.`);
  if (event.type === "message.part.updated.1" && event.data.part.sessionID !== session.nativeSessionId) throw new Error(`${session.file} has a part for another session.`);
}

export function mapStrings(value, map) {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [map(key), mapStrings(item, map)]));
  return value;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

async function assertTargetDoesNotExist(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Corpus output already exists: ${target}.`);
}
