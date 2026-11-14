#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildCorpus, eventSchemaDigest, measureEvents, recordingTurns, serializeEvents } from "../src/corpus.mjs";
import { convertOpenCodeExport, REDACTED_USER } from "../src/opencode-export.mjs";
import { REPOSITORY_ROOT } from "../src/paths.mjs";
import { readRegistered, recordingFileOf } from "../src/registry.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    corpus: { type: "string", default: "opencode-recorded-sessions" },
    home: { type: "string", default: os.homedir() },
    user: { type: "string", default: os.userInfo().username },
    replace: { type: "string", multiple: true, default: [] },
  },
});
if (!values.input) throw new Error("Usage: import-opencode-export.mjs --input <opencode session export JSON> [--corpus <id>] [--replace <from>=<to>]...");

const corpus = await readRegistered("corpus", values.corpus);
const replacements = [...gitIdentity(), ...values.replace.map((pair) => {
  const separator = pair.indexOf("=");
  if (separator < 1) throw new Error("--replace must use <from>=<to>.");
  return [pair.slice(0, separator), pair.slice(separator + 1)];
})];
const exported = JSON.parse(await readFile(path.resolve(values.input), "utf8"));
const { events, dropped } = convertOpenCodeExport(exported, { version: corpus.value.recording.version, home: values.home, username: values.user, replacements });

const recordingFile = recordingFileOf(corpus.value.id);
await mkdir(path.dirname(recordingFile), { recursive: true });
await writeFile(recordingFile, serializeEvents(events));

const corpusDirectory = path.join(REPOSITORY_ROOT, "artifacts/corpora", corpus.value.id);
const staged = `${corpusDirectory}.importing`;
await rm(staged, { recursive: true, force: true });
const built = await buildCorpus(corpus.value, recordingFile, staged);
await rm(corpusDirectory, { recursive: true, force: true });
await rename(staged, corpusDirectory);

const artifact = {
  schemaVersion: 1,
  id: corpus.value.id,
  corpusId: corpus.value.id,
  definitionDigestSha256: corpus.digest,
  eventSchemaDigestSha256: eventSchemaDigest(corpus.value.sourceEventFormat.id),
  recordingDigestSha256: built.manifest.recording.digestSha256,
  corpusDigestSha256: built.digestSha256,
};
await writeFile(path.join(REPOSITORY_ROOT, "registry/corpus-artifacts", `${corpus.value.id}.json`), `${JSON.stringify(artifact, null, 2)}\n`);

const measured = measureEvents(events);
process.stdout.write(`${JSON.stringify({
  recording: path.relative(REPOSITORY_ROOT, recordingFile),
  turns: recordingTurns(events).length,
  messages: measured.messageCount,
  transcriptBytes: measured.transcriptBytes,
  droppedMessages: dropped,
  corpusDigestSha256: built.digestSha256,
  sessions: built.manifest.sessions.map((session) => ({ id: session.logicalSessionId, turns: session.turns, copies: session.copies, messages: session.messageCount, transcriptBytes: session.transcriptBytes })),
}, null, 2)}\n`);

/** The git author name and email on this machine are the user's too; commits the agent made carry them. */
function gitIdentity() {
  return [["user.name", "Benchmark User"], ["user.email", `${REDACTED_USER}@example.invalid`]].flatMap(([key, replacement]) => {
    try {
      const value = execFileSync("git", ["config", "--global", key], { encoding: "utf8" }).trim();
      return value ? [[value, replacement]] : [];
    } catch {
      return [];
    }
  });
}
