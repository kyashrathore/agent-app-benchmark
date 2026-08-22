import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest } from "./canonical-json.mjs";

export function generateCorpus(definition) {
  const sessions = [];
  for (const workspaceId of definition.workspaceIds) {
    sessions.push(generateSession({ workspaceId, transcriptBytes: definition.transcriptBytes[0], chunkBytes: definition.messageChunkBytes, seed: `${definition.seed}|source`, id: `${workspaceId}-source` }));
    for (const transcriptBytes of definition.transcriptBytes) {
      sessions.push(generateSession({ workspaceId, transcriptBytes, chunkBytes: definition.messageChunkBytes, seed: definition.seed, id: `${workspaceId}-session-${transcriptBytes}` }));
    }
  }
  const corpus = {
    schemaVersion: 1,
    kind: "agent-app-corpus",
    corpusId: definition.id,
    generator: definition.generator,
    seed: definition.seed,
    sessions,
    manifest: {
      workspaceCount: definition.workspaceIds.length,
      sessionCount: sessions.length,
      transcriptBytes: sessions.reduce((total, session) => total + session.transcriptBytes, 0),
    },
  };
  return { ...corpus, digestSha256: digest(corpus) };
}

export async function writeCorpus(definition, outputPath) {
  const corpus = generateCorpus(definition);
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, JSON.stringify(corpus), { encoding: "utf8", mode: 0o600 });
  return corpus;
}

function generateSession({ workspaceId, transcriptBytes, chunkBytes, seed, id }) {
  const messages = [];
  let remaining = transcriptBytes;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    const prefix = `${seed}|${workspaceId}|${transcriptBytes}|${index}|`;
    const content = repeatToBytes(prefix, size);
    messages.push({ id: `message-${index}`, role: index % 2 === 0 ? "user" : "assistant", content });
    remaining -= Buffer.byteLength(content);
    index += 1;
  }
  return {
    id,
    workspaceId,
    transcriptBytes,
    messages,
  };
}

function repeatToBytes(pattern, byteLength) {
  const source = Buffer.from(pattern, "utf8");
  const output = Buffer.allocUnsafe(byteLength);
  for (let offset = 0; offset < byteLength; offset += source.length) {
    source.copy(output, offset, 0, Math.min(source.length, byteLength - offset));
  }
  return output.toString("utf8");
}
