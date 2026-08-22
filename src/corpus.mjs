import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { digest, digestBytes } from "./canonical-json.mjs";
import { assertContract } from "./contracts.mjs";
import { REPOSITORY_ROOT, resolveInside } from "./paths.mjs";

const MARKER = ".agent-app-benchmark-corpus";
const EVENT_SCHEMA = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "schemas", "opencode-event-v1.schema.json"), "utf8"));
export const OPENCODE_EVENT_SCHEMA_DIGEST = digest(EVENT_SCHEMA);

export async function writeCorpus(definition, outputDirectory) {
  const output = path.resolve(outputDirectory);
  await assertTargetDoesNotExist(output);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomBytes(6).toString("hex")}`);
  await mkdir(path.join(temporary, "sessions"), { recursive: true, mode: 0o700 });
  try {
    const sessionDefinitions = buildSessionDefinitions(definition);
    const sessions = [];
    for (let index = 0; index < sessionDefinitions.length; index += 1) {
      sessions.push(await writeSession(definition, sessionDefinitions[index], index, temporary));
    }
    const manifestCore = {
      schemaVersion: 1,
      corpusId: definition.id,
      definitionDigestSha256: digest(definition),
      sourceEventFormat: {
        ...definition.sourceEventFormat,
        schemaDigestSha256: OPENCODE_EVENT_SCHEMA_DIGEST,
      },
      seed: definition.seed,
      transcriptByteDefinition: "UTF-8 bytes of final completed text-part payloads only",
      topology: {
        workspaceCount: 2,
        sessionCount: sessions.length,
        controlSessionId: sessions[0].logicalSessionId,
        transcriptBytes: definition.transcriptBytes,
      },
      sessions,
    };
    const corpusDigestSha256 = digest(manifestCore);
    const manifest = { ...manifestCore, corpusDigestSha256 };
    await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(temporary, MARKER), `${corpusDigestSha256}\n`, { mode: 0o600 });
    await rename(temporary, output);
    return { path: output, manifest, digestSha256: corpusDigestSha256 };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyCorpus(corpusDirectory) {
  const root = path.resolve(corpusDirectory);
  const marker = await lstat(path.join(root, MARKER));
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Corpus marker is invalid.");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const expectedSessionCount = 1 + 4 * (manifest.topology?.transcriptBytes?.length ?? 0);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sessions) || manifest.sessions.length !== expectedSessionCount) {
    throw new Error("Corpus manifest topology is invalid.");
  }
  if (manifest.sourceEventFormat.schemaDigestSha256 !== OPENCODE_EVENT_SCHEMA_DIGEST) throw new Error("Corpus event schema digest is not canonical.");
  const seenEventIds = new Set();
  const seenSessionIds = new Set();
  for (const session of manifest.sessions) {
    if (seenSessionIds.has(session.logicalSessionId)) throw new Error(`Duplicate session ${session.logicalSessionId}.`);
    seenSessionIds.add(session.logicalSessionId);
    const file = resolveInside(root, session.file, "corpus session file");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${session.file} must be a regular file.`);
    const hash = createHash("sha256");
    let expectedSequence = 0;
    let transcriptBytes = 0;
    let eventCount = 0;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      hash.update(`${line}\n`);
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error(`${session.file} contains an oversized event.`);
      const event = JSON.parse(line);
      assertContract("opencodeEvent", event, `${session.file} event ${eventCount}`);
      validateEventIdentity(event, session, expectedSequence);
      if (seenEventIds.has(event.id)) throw new Error(`Duplicate event id ${event.id}.`);
      seenEventIds.add(event.id);
      if (event.type === "message.part.updated.1") transcriptBytes += Buffer.byteLength(event.data.part.text, "utf8");
      expectedSequence += 1;
      eventCount += 1;
    }
    if (hash.digest("hex") !== session.fileDigestSha256) throw new Error(`${session.file} digest mismatch.`);
    if (eventCount !== session.eventCount) throw new Error(`${session.file} event count mismatch.`);
    if (transcriptBytes !== session.transcriptBytes) throw new Error(`${session.file} transcript byte mismatch.`);
  }
  const { corpusDigestSha256, ...manifestCore } = manifest;
  if (digest(manifestCore) !== corpusDigestSha256) throw new Error("Corpus manifest digest mismatch.");
  const recorded = (await readFile(path.join(root, MARKER), "utf8")).trim();
  if (recorded !== corpusDigestSha256) throw new Error("Corpus marker digest mismatch.");
  return { path: root, manifest, digestSha256: corpusDigestSha256 };
}

export function buildSessionDefinitions(definition) {
  const [primaryWorkspace, secondaryWorkspace] = definition.workspaceIds;
  const sessions = [{
    logicalSessionId: "control",
    workspaceId: primaryWorkspace,
    role: "control",
    transcriptBytes: definition.transcriptBytes[0],
  }];
  for (const transcriptBytes of definition.transcriptBytes) {
    for (const lane of [
      ["within-workspace-cold", primaryWorkspace],
      ["within-workspace-warm", primaryWorkspace],
      ["across-workspaces-cold", secondaryWorkspace],
      ["across-workspaces-warm", secondaryWorkspace],
    ]) {
      const logicalSessionId = `${lane[0]}-${transcriptBytes}`;
      sessions.push({
        logicalSessionId,
        workspaceId: lane[1],
        role: lane[0],
        transcriptBytes,
      });
    }
  }
  return sessions.map((session, index) => ({
    ...session,
    nativeSessionId: sortableOpenCodeId("ses", sessionBaseTime(index), session.logicalSessionId),
  }));
}

async function writeSession(definition, session, sessionIndex, root) {
  const relativeFile = `sessions/${session.logicalSessionId}.ndjson`;
  const file = resolveInside(root, relativeFile);
  const stream = createWriteStream(file, { encoding: "utf8", mode: 0o600 });
  const hash = createHash("sha256");
  let sequence = 0;
  const writeEvent = async (type, data) => {
    const event = {
      id: sortableOpenCodeId("evt", sessionBaseTime(sessionIndex) + sequence, `${session.logicalSessionId}:${sequence}`),
      type,
      seq: sequence,
      aggregateID: session.nativeSessionId,
      data,
    };
    assertContract("opencodeEvent", event, `${session.logicalSessionId} event ${sequence}`);
    const line = `${JSON.stringify(event)}\n`;
    hash.update(line);
    if (!stream.write(line)) await new Promise((resolve) => stream.once("drain", resolve));
    sequence += 1;
  };
  const baseTime = sessionBaseTime(sessionIndex);
  await writeEvent("session.created.1", {
    sessionID: session.nativeSessionId,
    info: {
      id: session.nativeSessionId,
      slug: session.logicalSessionId,
      projectID: `pro_bench_${session.workspaceId.replaceAll("-", "_")}`,
      workspaceID: session.workspaceId,
      directory: `/benchmark/${session.workspaceId}`,
      title: `Benchmark ${session.logicalSessionId}`,
      version: "benchmark-v1",
      time: { created: baseTime, updated: baseTime },
    },
  });
  let remaining = session.transcriptBytes;
  let messageIndex = 0;
  let parentId;
  while (remaining > 0) {
    const contentBytes = Math.min(definition.messageChunkBytes, remaining);
    const text = repeatToBytes(`${definition.seed}|${session.logicalSessionId}|${messageIndex}|`, contentBytes);
    const at = baseTime + messageIndex * 10 + 1;
    const identitySeed = `${definition.seed}:${session.logicalSessionId}:${messageIndex}`;
    const messageId = sortableOpenCodeId("msg", at, identitySeed);
    const partId = sortableOpenCodeId("prt", at + 1, identitySeed);
    const role = messageIndex % 2 === 0 ? "user" : "assistant";
    const info = role === "user"
      ? {
          id: messageId,
          sessionID: session.nativeSessionId,
          role,
          time: { created: at },
          agent: "build",
          model: { providerID: "benchmark", modelID: "benchmark" },
        }
      : {
          id: messageId,
          sessionID: session.nativeSessionId,
          role,
          time: { created: at, completed: at + 1 },
          parentID: parentId,
          modelID: "benchmark",
          providerID: "benchmark",
          mode: "build",
          agent: "build",
          path: { cwd: `/benchmark/${session.workspaceId}`, root: `/benchmark/${session.workspaceId}` },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        };
    await writeEvent("message.updated.1", { sessionID: session.nativeSessionId, info });
    await writeEvent("message.part.updated.1", {
      sessionID: session.nativeSessionId,
      part: {
        id: partId,
        sessionID: session.nativeSessionId,
        messageID: messageId,
        type: "text",
        text,
        time: { start: at, end: at + 1 },
      },
      time: at + 1,
    });
    if (role === "user") parentId = messageId;
    remaining -= Buffer.byteLength(text, "utf8");
    messageIndex += 1;
  }
  stream.end();
  await finished(stream);
  return {
    logicalSessionId: session.logicalSessionId,
    nativeSessionId: session.nativeSessionId,
    workspaceId: session.workspaceId,
    role: session.role,
    transcriptBytes: session.transcriptBytes,
    eventCount: sequence,
    file: relativeFile,
    fileDigestSha256: hash.digest("hex"),
  };
}

function sessionBaseTime(sessionIndex) {
  return 1_700_000_000_000 + sessionIndex * 1_000_000;
}

function sortableOpenCodeId(prefix, timestamp, seed) {
  const encoded = (BigInt(timestamp) * 0x1000n + 1n) & ((1n << 48n) - 1n);
  const encodedTime = encoded.toString(16).padStart(12, "0");
  const deterministicTail = createHash("sha256").update(`${prefix}:${seed}`).digest("hex").slice(0, 14);
  return `${prefix}_${encodedTime}${deterministicTail}`;
}

function validateEventIdentity(event, session, expectedSequence) {
  if (event.seq !== expectedSequence) throw new Error(`${session.file} has invalid sequence ${event.seq}; expected ${expectedSequence}.`);
  if (event.aggregateID !== session.nativeSessionId) throw new Error(`${session.file} has an invalid aggregate id.`);
  if (event.data.sessionID !== session.nativeSessionId) throw new Error(`${session.file} has an invalid session id.`);
  if (event.type === "session.created.1" && expectedSequence !== 0) throw new Error(`${session.file} creates its session after sequence zero.`);
  if (event.type !== "session.created.1" && expectedSequence === 0) throw new Error(`${session.file} does not begin with session.created.1.`);
}

function repeatToBytes(pattern, byteLength) {
  const source = Buffer.from(pattern, "utf8");
  const output = Buffer.allocUnsafe(byteLength);
  for (let offset = 0; offset < byteLength; offset += source.length) {
    source.copy(output, offset, 0, Math.min(source.length, byteLength - offset));
  }
  return output.toString("utf8");
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

export function digestCorpusText(text) {
  return digestBytes(Buffer.from(text, "utf8"));
}
