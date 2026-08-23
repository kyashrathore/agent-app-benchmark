#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execute = promisify(execFile);
const METRICS = [
  "messages",
  "userMessages",
  "assistantMessages",
  "textBytes",
  "reasoningBytes",
  "toolCalls",
  "toolInputBytes",
  "toolOutputBytes",
  "patches",
  "renderedBytes",
];
const QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

const options = parseArguments(process.argv.slice(2));
const [openCode, claude, codex] = await Promise.all([
  readOpenCode(options.openCodeDb),
  readJsonlSource("claude", options.claudeRoot, readClaudeSession, options.samples),
  readJsonlSource("codex", options.codexRoot, readCodexSession, options.samples),
]);

const equalSourceSample = [openCode.sample, claude.sample, codex.sample].flat();
const profile = {
  schemaVersion: 1,
  privacyModel: "numeric-structure-only; no source text, identifiers, paths, commands, URLs, or timestamps",
  sampling: {
    strategy: "equal source weighting; deterministic rank sampling through the maximum stored session size",
    requestedSessionsPerSource: options.samples,
  },
  sources: {
    opencode: summarizeSource(openCode),
    claude: summarizeSource(claude),
    codex: summarizeSource(codex),
  },
  combined: summarizeRows(equalSourceSample),
};

const serialized = `${JSON.stringify(profile, null, 2)}\n`;
if (options.output) await writeFile(options.output, serialized, { mode: 0o600 });
else process.stdout.write(serialized);

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${flag ?? "end of command"}.`);
    values[flag.slice(2)] = value;
  }
  for (const required of ["open-code-db", "claude-root", "codex-root"]) {
    if (!values[required]) throw new Error(`Missing --${required}.`);
  }
  const samples = Number(values.samples ?? 48);
  if (!Number.isSafeInteger(samples) || samples < 8 || samples > 256) throw new Error("--samples must be an integer from 8 through 256.");
  return {
    openCodeDb: path.resolve(values["open-code-db"]),
    claudeRoot: path.resolve(values["claude-root"]),
    codexRoot: path.resolve(values["codex-root"]),
    output: values.output ? path.resolve(values.output) : undefined,
    samples,
  };
}

async function readOpenCode(database) {
  const sql = `
WITH message_stats AS (
  SELECT session_id,
    count(*) AS messages,
    sum(json_extract(data, '$.role') = 'user') AS user_messages,
    sum(json_extract(data, '$.role') = 'assistant') AS assistant_messages
  FROM message GROUP BY session_id
), part_stats AS (
  SELECT session_id,
    sum(CASE WHEN json_extract(data, '$.type') = 'text' THEN length(CAST(json_extract(data, '$.text') AS BLOB)) ELSE 0 END) AS text_bytes,
    sum(CASE WHEN json_extract(data, '$.type') = 'reasoning' THEN length(CAST(json_extract(data, '$.text') AS BLOB)) ELSE 0 END) AS reasoning_bytes,
    sum(json_extract(data, '$.type') = 'tool') AS tool_calls,
    sum(CASE WHEN json_extract(data, '$.type') = 'tool' THEN length(CAST(json_extract(data, '$.state.input') AS BLOB)) ELSE 0 END) AS tool_input_bytes,
    sum(CASE WHEN json_extract(data, '$.type') = 'tool' THEN length(CAST(json_extract(data, '$.state.output') AS BLOB)) ELSE 0 END) AS tool_output_bytes,
    sum(json_extract(data, '$.type') = 'patch') AS patches
  FROM part GROUP BY session_id
)
SELECT
  coalesce(m.messages, 0), coalesce(m.user_messages, 0), coalesce(m.assistant_messages, 0),
  coalesce(p.text_bytes, 0), coalesce(p.reasoning_bytes, 0), coalesce(p.tool_calls, 0),
  coalesce(p.tool_input_bytes, 0), coalesce(p.tool_output_bytes, 0), coalesce(p.patches, 0)
FROM session s
LEFT JOIN message_stats m ON m.session_id = s.id
LEFT JOIN part_stats p ON p.session_id = s.id
WHERE coalesce(m.messages, 0) > 0;
`;
  const { stdout } = await execute("sqlite3", ["-json", database, sql], { maxBuffer: 32 * 1024 * 1024 });
  const rows = JSON.parse(stdout || "[]").map((row) => numericRow({
    messages: row["coalesce(m.messages, 0)"],
    userMessages: row["coalesce(m.user_messages, 0)"],
    assistantMessages: row["coalesce(m.assistant_messages, 0)"],
    textBytes: row["coalesce(p.text_bytes, 0)"],
    reasoningBytes: row["coalesce(p.reasoning_bytes, 0)"],
    toolCalls: row["coalesce(p.tool_calls, 0)"],
    toolInputBytes: row["coalesce(p.tool_input_bytes, 0)"],
    toolOutputBytes: row["coalesce(p.tool_output_bytes, 0)"],
    patches: row["coalesce(p.patches, 0)"],
  }));
  return { available: rows.length, sample: rankSample(rows, options.samples, (row) => row.renderedBytes) };
}

async function readJsonlSource(name, root, reader, sampleCount) {
  const files = await listJsonl(root);
  const selected = rankSample(files, sampleCount, (file) => file.bytes);
  const rows = [];
  for (const file of selected) rows.push(await reader(file.path));
  return { available: files.length, candidateFileBytes: files.map((file) => file.bytes), sample: rows, name };
}

async function listJsonl(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(location);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await stat(location);
        if (info.size >= 1024) result.push({ path: location, bytes: info.size });
      }
    }
  }
  await visit(root);
  return result;
}

async function readClaudeSession(file) {
  const messages = new Map();
  const anonymous = [];
  await eachJsonLine(file, (event) => {
    if (event?.type !== "user" && event?.type !== "assistant") return;
    const summary = emptyRow();
    const role = event.type;
    const blocks = normalizeBlocks(event.message?.content);
    const hasConversationText = blocks.some((block) => block?.type === "text") || typeof event.message?.content === "string";
    if (hasConversationText) {
      summary.messages = 1;
      summary[role === "user" ? "userMessages" : "assistantMessages"] = 1;
    }
    for (const block of blocks) {
      if (block?.type === "text") summary.textBytes += utf8Length(block.text);
      else if (block?.type === "thinking") summary.reasoningBytes += utf8Length(block.thinking);
      else if (block?.type === "tool_use") {
        summary.toolCalls += 1;
        summary.toolInputBytes += jsonLength(block.input);
      } else if (block?.type === "tool_result") {
        summary.toolOutputBytes += contentLength(block.content);
      }
    }
    const key = typeof event.uuid === "string" ? event.uuid : typeof event.message?.id === "string" ? event.message.id : undefined;
    if (key) messages.set(key, maxRow(messages.get(key), summary));
    else anonymous.push(summary);
  });
  return sumRows([...messages.values(), ...anonymous]);
}

async function readCodexSession(file) {
  const result = emptyRow();
  await eachJsonLine(file, (event) => {
    if (event?.type !== "response_item") return;
    const item = event.payload;
    if (item?.type === "message" && (item.role === "user" || item.role === "assistant")) {
      const blocks = normalizeBlocks(item.content);
      const bytes = blocks.reduce((total, block) => total + utf8Length(block?.text), 0);
      if (bytes > 0) {
        result.messages += 1;
        result[item.role === "user" ? "userMessages" : "assistantMessages"] += 1;
        result.textBytes += bytes;
      }
    } else if (item?.type === "reasoning") {
      result.reasoningBytes += contentLength(item.summary) + contentLength(item.content);
    } else if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      result.toolCalls += 1;
      result.toolInputBytes += utf8Length(item.arguments) + utf8Length(item.input);
      if (typeof item.name === "string" && item.name.toLowerCase().includes("patch")) result.patches += 1;
    } else if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      result.toolOutputBytes += contentLength(item.output);
    }
  });
  return numericRow(result);
}

async function eachJsonLine(file, callback) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      callback(JSON.parse(line));
    } catch {
      // Incomplete final records in an active history are ignored.
    }
  }
}

function normalizeBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function contentLength(content) {
  if (typeof content === "string") return utf8Length(content);
  if (Array.isArray(content)) return content.reduce((total, item) => total + contentLength(item?.text ?? item?.content ?? item), 0);
  return 0;
}

function jsonLength(value) {
  if (value === undefined) return 0;
  try {
    return utf8Length(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function utf8Length(value) {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function emptyRow() {
  return Object.fromEntries(METRICS.map((metric) => [metric, 0]));
}

function numericRow(row) {
  const result = emptyRow();
  for (const metric of METRICS) result[metric] = Number(row[metric] ?? 0) || 0;
  result.renderedBytes = result.textBytes + result.reasoningBytes + result.toolInputBytes + result.toolOutputBytes;
  return result;
}

function sumRows(rows) {
  const result = emptyRow();
  for (const row of rows) for (const metric of METRICS) result[metric] += row[metric] ?? 0;
  result.renderedBytes = result.textBytes + result.reasoningBytes + result.toolInputBytes + result.toolOutputBytes;
  return result;
}

function maxRow(previous, next) {
  if (!previous) return next;
  return Object.fromEntries(METRICS.map((metric) => [metric, Math.max(previous[metric] ?? 0, next[metric] ?? 0)]));
}

function rankSample(items, count, selector) {
  if (items.length <= count) return [...items];
  const sorted = [...items].sort((left, right) => selector(left) - selector(right));
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const rank = Math.round((0.01 + (0.99 * index) / (count - 1)) * (sorted.length - 1));
    if (!seen.has(rank)) {
      seen.add(rank);
      selected.push(sorted[rank]);
    }
  }
  return selected;
}

function summarizeSource(source) {
  return {
    availableSessions: source.available,
    sampledSessions: source.sample.length,
    ...(source.candidateFileBytes ? { storedFileBytes: summarizeValues(source.candidateFileBytes) } : {}),
    metrics: summarizeRows(source.sample),
  };
}

function summarizeRows(rows) {
  return Object.fromEntries(METRICS.map((metric) => [metric, summarizeValues(rows.map((row) => row[metric]))]));
}

function summarizeValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const summary = Object.fromEntries(QUANTILES.map((quantile) => [
    `p${Math.round(quantile * 100)}`,
    sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) * quantile)],
  ]));
  summary.max = sorted.at(-1) ?? 0;
  return summary;
}
