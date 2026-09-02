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
const EVENT_SCHEMAS = {
  "opencode-event-v1": JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "schemas", "opencode-event-v1.schema.json"), "utf8")),
  "opencode-event-v2": JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "schemas", "opencode-event-v2.schema.json"), "utf8")),
};
const TRANSCRIPT_BYTE_DEFINITION = "UTF-8 bytes of completed text, reasoning, serialized tool input, and tool output payloads";
const TOOL_NAMES = ["read", "search", "list", "shell", "apply_patch"];
const PRIVATE_PATTERN = /(?:\/(?:Users|home)\/|[a-z]:\\users\\|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:sk|ghp|github_pat|AKIA)[-_A-Z0-9]{12,}\b)/i;

export const OPENCODE_EVENT_SCHEMA_DIGEST = digest(EVENT_SCHEMAS["opencode-event-v1"]);
export const OPENCODE_EVENT_V2_SCHEMA_DIGEST = digest(EVENT_SCHEMAS["opencode-event-v2"]);

export function eventSchemaDigest(sourceEventFormatId) {
  const schema = EVENT_SCHEMAS[sourceEventFormatId];
  if (!schema) throw new Error(`Unknown source event format ${sourceEventFormatId}.`);
  return digest(schema);
}

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
      sourceEventFormat: { ...definition.sourceEventFormat, schemaDigestSha256: eventSchemaDigest(definition.sourceEventFormat.id) },
      seed: definition.seed,
      transcriptByteDefinition: TRANSCRIPT_BYTE_DEFINITION,
      derivation: definition.derivation,
      topology: {
        workspaceCount: 2,
        sessionCount: sessions.length,
        controlSessionId: sessions[0].logicalSessionId,
        transcriptBytes: definition.transcriptBytes,
        ...(definition.benchmarkTopology ? { benchmarkTopology: definition.benchmarkTopology } : {}),
      },
      sessions,
    };
    const corpusDigestSha256 = digest(manifestCore);
    const manifest = { ...manifestCore, corpusDigestSha256 };
    assertContract("corpusManifest", manifest, "generated corpus manifest");
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
  const manifestFile = path.join(root, "manifest.json");
  const manifestStat = await lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Corpus manifest must be a regular file.");
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("Corpus manifest exceeds the public size limit.");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assertContract("corpusManifest", manifest, "corpus manifest");
  const expectedSessionCount = expectedTopologySessionCount(manifest.topology);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sessions) || manifest.sessions.length !== expectedSessionCount) {
    throw new Error("Corpus manifest topology is invalid.");
  }
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
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error(`${session.file} contains an oversized event.`);
      assertSyntheticPrivacy(line, session.file);
      const event = JSON.parse(line);
      assertContract("opencodeEventV2", event, `${session.file} event ${measured.eventCount}`);
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

export function buildSessionDefinitions(definition) {
  const [primaryWorkspace, secondaryWorkspace] = definition.workspaceIds;
  const profileBySize = new Map(definition.sessionProfiles.map((profile) => [profile.transcriptBytes, profile]));
  const sessions = [{
    logicalSessionId: "control",
    workspaceId: primaryWorkspace,
    role: "control",
    transcriptBytes: definition.transcriptBytes[0],
    profile: profileBySize.get(definition.transcriptBytes[0]),
  }];
  if (definition.benchmarkTopology) {
    const standardBytes = definition.benchmarkTopology.standardTranscriptBytes;
    for (const role of ["within-workspace-cold", "within-workspace-warm", "across-workspaces-cold", "across-workspaces-warm"]) {
      const workspaceId = role.startsWith("across-") ? secondaryWorkspace : primaryWorkspace;
      for (let sample = 0; sample < definition.benchmarkTopology.latencySamplesPerProcess; sample += 1) {
        sessions.push({
          logicalSessionId: `latency-${role}-${sample}-${standardBytes}`,
          workspaceId,
          role,
          transcriptBytes: standardBytes,
          profile: profileBySize.get(standardBytes),
        });
      }
    }
    for (let sample = 0; sample < definition.benchmarkTopology.sizeSamplesPerProcess; sample += 1) {
      for (const transcriptBytes of definition.transcriptBytes) {
        sessions.push({
          logicalSessionId: `size-latency-${sample}-${transcriptBytes}`,
          workspaceId: primaryWorkspace,
          role: "size-latency",
          transcriptBytes,
          profile: profileBySize.get(transcriptBytes),
        });
      }
    }
    // Long-row sessions carry the same bytes in a handful of very large text
    // parts, so a virtualized transcript cannot hide the cost of one row.
    const longRowProfiles = new Map((definition.longRowProfiles ?? []).map((profile) => [profile.transcriptBytes, profile]));
    for (let sample = 0; sample < definition.benchmarkTopology.sizeSamplesPerProcess; sample += 1) {
      for (const transcriptBytes of definition.benchmarkTopology.longRowTranscriptBytes ?? []) {
        sessions.push({
          logicalSessionId: `size-latency-long-${sample}-${transcriptBytes}`,
          workspaceId: primaryWorkspace,
          role: "size-latency-long",
          transcriptBytes,
          profile: longRowProfiles.get(transcriptBytes),
        });
      }
    }
    for (const transcriptBytes of definition.transcriptBytes) {
      sessions.push({
        logicalSessionId: `progressive-resource-${transcriptBytes}`,
        workspaceId: primaryWorkspace,
        role: "progressive-resource",
        transcriptBytes,
        profile: profileBySize.get(transcriptBytes),
      });
    }
    return sessions.map((session, index) => ({
      ...session,
      nativeSessionId: sortableOpenCodeId("ses", sessionBaseTime(index), session.logicalSessionId),
    }));
  }
  for (const transcriptBytes of definition.transcriptBytes) {
    for (const [role, workspaceId] of [
      ["within-workspace-cold", primaryWorkspace],
      ["within-workspace-warm", primaryWorkspace],
      ["across-workspaces-cold", secondaryWorkspace],
      ["across-workspaces-warm", secondaryWorkspace],
    ]) {
      sessions.push({ logicalSessionId: `${role}-${transcriptBytes}`, workspaceId, role, transcriptBytes, profile: profileBySize.get(transcriptBytes) });
    }
  }
  return sessions.map((session, index) => ({
    ...session,
    nativeSessionId: sortableOpenCodeId("ses", sessionBaseTime(index), session.logicalSessionId),
  }));
}

function expectedTopologySessionCount(topology) {
  if (!topology?.benchmarkTopology) return 1 + 4 * (topology?.transcriptBytes?.length ?? 0);
  return 1
    + 4 * topology.benchmarkTopology.latencySamplesPerProcess
    + topology.benchmarkTopology.sizeSamplesPerProcess * topology.transcriptBytes.length
    + topology.benchmarkTopology.sizeSamplesPerProcess * (topology.benchmarkTopology.longRowTranscriptBytes ?? []).length
    + topology.transcriptBytes.length;
}

async function writeSession(definition, session, sessionIndex, root) {
  const relativeFile = `sessions/${session.logicalSessionId}.ndjson`;
  const file = resolveInside(root, relativeFile);
  const stream = createWriteStream(file, { encoding: "utf8", mode: 0o600 });
  const hash = createHash("sha256");
  const measured = emptyMeasurements();
  let sequence = 0;
  let partIndex = 0;
  const baseTime = sessionBaseTime(sessionIndex);
  const writeEvent = async (type, data) => {
    const event = {
      id: sortableOpenCodeId("evt", baseTime + sequence, `${session.logicalSessionId}:${sequence}`),
      type,
      seq: sequence,
      aggregateID: session.nativeSessionId,
      data,
    };
    assertContract("opencodeEventV2", event, `${session.logicalSessionId} event ${sequence}`);
    const line = `${JSON.stringify(event)}\n`;
    assertSyntheticPrivacy(line, session.logicalSessionId);
    hash.update(line);
    if (!stream.write(line)) await new Promise((resolve) => stream.once("drain", resolve));
    measureEvent(measured, event);
    sequence += 1;
  };
  const writePart = async (messageId, part) => {
    const at = baseTime + sequence;
    await writeEvent("message.part.updated.1", {
      sessionID: session.nativeSessionId,
      part: {
        id: sortableOpenCodeId("prt", at, `${session.logicalSessionId}:${partIndex}`),
        sessionID: session.nativeSessionId,
        messageID: messageId,
        ...part,
      },
      time: at,
    });
    partIndex += 1;
  };

  await writeEvent("session.created.1", {
    sessionID: session.nativeSessionId,
    info: {
      id: session.nativeSessionId,
      slug: session.logicalSessionId,
      projectID: `pro_benchmark_${session.workspaceId}`,
      workspaceID: session.workspaceId,
      directory: `/benchmark/${session.workspaceId}`,
      // Serial prefix keeps sidebar/page titles visually distinct when many
      // roles share the "Synthetic benchmark …" stem (truncated rail labels).
      title: `${sessionIndex + 1}. Synthetic benchmark ${session.logicalSessionId}`,
      version: "benchmark-v1",
      // updated > created by a per-session stride so updated_desc list order is
      // stable top→bottom instead of a wall of identical relative times.
      time: { created: baseTime, updated: baseTime + (sessionIndex + 1) * 60_000 },
    },
  });

  const profile = session.profile;
  const allocation = allocatePayload(profile.transcriptBytes, profile.payloadPermille);
  const realisticDistribution = definition.generator === "opencode-completed-sessions-v1";
  // Long-row sessions split their bytes evenly: the point is a row of a known,
  // uniform size, and a weighted split would push single rows past the event cap.
  const evenRows = session.role === "size-latency-long";
  const split = realisticDistribution && !evenRows
    ? (total, count, kind) => splitWeightedBytes(total, count, `${definition.seed}:${session.logicalSessionId}:${kind}`)
    : (total, count) => splitBytes(total, count);
  const payload = realisticDistribution
    ? (pattern, bytes, salt) => diverseSyntheticBytes(pattern, bytes, `${definition.seed}:${session.logicalSessionId}:${salt}`)
    : (pattern, bytes) => syntheticBytes(pattern, bytes);
  const textChunks = split(allocation.text, profile.userMessages + profile.assistantMessages, "text");
  const reasoningChunks = split(allocation.reasoning, profile.assistantMessages, "reasoning");
  const toolInputs = buildToolInputs(allocation.toolInput, profile.toolCalls, realisticDistribution ? `${definition.seed}:${session.logicalSessionId}:tool-input` : undefined);
  const toolOutputChunks = split(allocation.toolOutput, profile.toolCalls, "tool-output");
  let textIndex = 0;
  let reasoningIndex = 0;
  let toolIndex = 0;
  let patchIndex = 0;
  let assistantIndex = 0;
  let messageIndex = 0;

  for (let userIndex = 0; userIndex < profile.userMessages; userIndex += 1) {
    const userAt = baseTime + sequence;
    const userMessageId = sortableOpenCodeId("msg", userAt, `${session.logicalSessionId}:message:${messageIndex}`);
    await writeEvent("message.updated.1", {
      sessionID: session.nativeSessionId,
      info: {
        id: userMessageId,
        sessionID: session.nativeSessionId,
        role: "user",
        time: { created: userAt },
        agent: "build",
        model: { providerID: "benchmark", modelID: "synthetic" },
      },
    });
    await writePart(userMessageId, {
      type: "text",
      text: payload("Review the synthetic fixture and implement the next deterministic improvement. ", textChunks[textIndex], `user:${textIndex}`),
      time: { start: userAt, end: userAt + 1 },
    });
    textIndex += 1;
    messageIndex += 1;

    const assistantForTurn = distributedCount(profile.assistantMessages, profile.userMessages, userIndex);
    for (let localAssistant = 0; localAssistant < assistantForTurn; localAssistant += 1) {
      const assistantAt = baseTime + sequence;
      const messageId = sortableOpenCodeId("msg", assistantAt, `${session.logicalSessionId}:message:${messageIndex}`);
      await writeEvent("message.updated.1", {
        sessionID: session.nativeSessionId,
        info: {
          id: messageId,
          sessionID: session.nativeSessionId,
          role: "assistant",
          time: { created: assistantAt, completed: assistantAt + 1 },
          parentID: userMessageId,
          modelID: "synthetic",
          providerID: "benchmark",
          mode: "build",
          agent: "build",
          path: { cwd: `/benchmark/${session.workspaceId}`, root: `/benchmark/${session.workspaceId}` },
          cost: 0,
          tokens: { input: 512, output: 256, reasoning: 128, cache: { read: 64, write: 0 } },
          finish: "stop",
        },
      });
      await writePart(messageId, { type: "step-start" });
      if ((reasoningChunks[reasoningIndex] ?? 0) > 0) {
        await writePart(messageId, {
          type: "reasoning",
          text: payload("Inspecting dependencies, checking edge cases, and selecting a minimal implementation path. ", reasoningChunks[reasoningIndex], `reasoning:${reasoningIndex}`),
          time: { start: assistantAt, end: assistantAt + 1 },
        });
        reasoningIndex += 1;
      }
      const toolsForMessage = distributedCount(profile.toolCalls, profile.assistantMessages, assistantIndex);
      for (let localTool = 0; localTool < toolsForMessage; localTool += 1) {
        const tool = TOOL_NAMES[toolIndex % TOOL_NAMES.length];
        await writePart(messageId, {
          type: "tool",
          callID: `call_benchmark_${sessionIndex}_${toolIndex}`,
          tool,
          state: {
            status: "completed",
            input: toolInputs[toolIndex],
            output: payload(toolOutputPattern(tool), toolOutputChunks[toolIndex], `tool-output:${toolIndex}`),
            title: syntheticToolTitle(tool),
            metadata: {},
            time: { start: assistantAt, end: assistantAt + 1 },
          },
        });
        toolIndex += 1;
      }
      const patchesForMessage = distributedCount(profile.patches, profile.assistantMessages, assistantIndex);
      for (let localPatch = 0; localPatch < patchesForMessage; localPatch += 1) {
        const fileNumber = patchIndex % 1000;
        await writePart(messageId, {
          type: "patch",
          hash: createHash("sha1").update(`${definition.seed}:${session.logicalSessionId}:patch:${patchIndex}`).digest("hex"),
          files: [`src/fixture-${fileNumber}.ts`],
        });
        patchIndex += 1;
      }
      await writePart(messageId, {
        type: "text",
        text: payload("Implemented the fixture update and verified the deterministic checks. ", textChunks[textIndex], `assistant:${textIndex}`),
        time: { start: assistantAt, end: assistantAt + 1 },
      });
      textIndex += 1;
      await writePart(messageId, {
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 512, output: 256, reasoning: 128, cache: { read: 64, write: 0 } },
      });
      assistantIndex += 1;
      messageIndex += 1;
    }
  }

  stream.end();
  await finished(stream);
  if (measured.transcriptBytes !== profile.transcriptBytes) throw new Error(`${session.logicalSessionId} generated the wrong payload size.`);
  return {
    logicalSessionId: session.logicalSessionId,
    nativeSessionId: session.nativeSessionId,
    workspaceId: session.workspaceId,
    role: session.role,
    ...measured,
    file: relativeFile,
    fileDigestSha256: hash.digest("hex"),
  };
}

function allocatePayload(total, weights) {
  const keys = ["text", "reasoning", "toolInput", "toolOutput"];
  const allocation = {};
  let assigned = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    allocation[key] = index === keys.length - 1 ? total - assigned : Math.floor((total * weights[key]) / 1000);
    assigned += allocation[key];
  }
  return allocation;
}

function splitBytes(total, count) {
  if (count === 0) {
    if (total !== 0) throw new Error("A non-zero payload budget requires at least one part.");
    return [];
  }
  if (total === 0) return Array.from({ length: count }, () => 0);
  if (total < count) throw new Error("Payload budget is too small for its part count.");
  return Array.from({ length: count }, (_, index) => distributedCount(total, count, index));
}

function splitWeightedBytes(total, count, seed) {
  if (count === 0) {
    if (total !== 0) throw new Error("A non-zero payload budget requires at least one part.");
    return [];
  }
  if (total === 0) return Array.from({ length: count }, () => 0);
  if (total < count) throw new Error("Payload budget is too small for its part count.");
  const weights = Array.from({ length: count }, (_, index) => {
    const value = Number.parseInt(createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
    return 0.15 + Math.pow(value, 3) * 12;
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const output = weights.map((weight) => 1 + Math.floor(((total - count) * weight) / weightTotal));
  let assigned = output.reduce((sum, value) => sum + value, 0);
  for (let index = 0; assigned < total; index = (index + 1) % output.length) {
    output[index] += 1;
    assigned += 1;
  }
  return output;
}

function buildToolInputs(total, count, distributionSeed) {
  if (count === 0) {
    if (total !== 0) throw new Error("Tool input bytes require tool calls.");
    return [];
  }
  const inputs = Array.from({ length: count }, (_, index) => ({
    path: `src/fixture-${index % 1000}.ts`,
    operation: TOOL_NAMES[index % TOOL_NAMES.length],
    context: "",
  }));
  const baseBytes = inputs.map((input) => Buffer.byteLength(JSON.stringify(input), "utf8"));
  const baseTotal = baseBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (total < baseTotal) throw new Error(`Tool input budget ${total} is below its structural minimum ${baseTotal}.`);
  const extra = total - baseTotal;
  const chunks = distributionSeed ? splitWeightedBytes(extra, count, distributionSeed) : null;
  for (let index = 0; index < inputs.length; index += 1) {
    const bytes = chunks?.[index] ?? distributedCount(extra, count, index);
    inputs[index].context = syntheticBytes(
      distributionSeed ? `synthetic tool input context ${index} ` : "synthetic tool input context ",
      bytes,
    );
  }
  return inputs;
}

function distributedCount(total, buckets, index) {
  return Math.floor(((index + 1) * total) / buckets) - Math.floor((index * total) / buckets);
}

function syntheticBytes(pattern, byteLength) {
  if (byteLength === 0) return "";
  const source = Buffer.from(pattern, "utf8");
  const output = Buffer.allocUnsafe(byteLength);
  for (let offset = 0; offset < byteLength; offset += source.length) {
    source.copy(output, offset, 0, Math.min(source.length, byteLength - offset));
  }
  return output.toString("utf8");
}

function diverseSyntheticBytes(pattern, byteLength, seed) {
  if (byteLength === 0) return "";
  const variants = Array.from({ length: 48 }, (_, index) => {
    const token = createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 20);
    return `${pattern}fixture_${index} ${token} status=${index % 5} count=${index * 17}\n`;
  }).join("");
  return syntheticBytes(variants, byteLength);
}

function toolOutputPattern(tool) {
  if (tool === "read") return "export function fixtureValue(input) { return input + 1; }\n";
  if (tool === "search") return "src/fixture-1.ts:12: deterministic benchmark fixture\n";
  if (tool === "list") return "src/fixture-1.ts\nsrc/fixture-2.ts\ntests/fixture.test.ts\n";
  if (tool === "shell") return "PASS synthetic fixture test\nTests 12 passed, 0 failed\n";
  return "Applied synthetic patch to src/fixture-1.ts\n";
}

function syntheticToolTitle(tool) {
  return {
    read: "Read synthetic fixture",
    search: "Search synthetic fixture",
    list: "List synthetic files",
    shell: "Run synthetic checks",
    apply_patch: "Apply synthetic patch",
  }[tool];
}

function emptyMeasurements() {
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

function measureEvent(measured, event) {
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
    measured.toolOutputBytes += Buffer.byteLength(part.state.output, "utf8");
  }
  if (part.type === "patch") measured.patchCount += 1;
  measured.transcriptBytes = measured.textBytes + measured.reasoningBytes + measured.toolInputBytes + measured.toolOutputBytes;
}

function assertSyntheticPrivacy(serialized, label) {
  if (PRIVATE_PATTERN.test(serialized)) throw new Error(`${label} contains a disallowed private-data pattern.`);
}

function sessionBaseTime(sessionIndex) {
  // One hour between sessions so relative labels and updated_desc order stay
  // visually distinct in long sidebar lists.
  return 1_700_000_000_000 + sessionIndex * 3_600_000;
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
  if (event.type === "message.part.updated.1") {
    if (event.data.part.sessionID !== session.nativeSessionId) throw new Error(`${session.file} has a part for another session.`);
  }
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
