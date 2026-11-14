import { createServer } from "node:http";
import { AUXILIARY_REPLY, REPLAY_MODEL_ID, replyDeltas } from "./replay-reply.mjs";

const COMPLETION_ID = "chatcmpl-agent-app-benchmark-replay";
const CREATED = 1_700_000_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The SSE events of one streamed reply, in order: the role, one event per delta, the finish, an optional usage event and `[DONE]`. */
export function replayStreamEvents(deltas, { includeUsage = false } = {}) {
  const chunk = (choices, extra = {}) => `data: ${JSON.stringify({ id: COMPLETION_ID, object: "chat.completion.chunk", created: CREATED, model: REPLAY_MODEL_ID, choices, ...extra })}\n\n`;
  return [
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    ...deltas.map((content) => chunk([{ index: 0, delta: { content }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    ...(includeUsage ? [chunk([], { usage: usage(deltas.length) })] : []),
    "data: [DONE]\n\n",
  ];
}

/**
 * An OpenAI-compatible chat-completions server on 127.0.0.1 at a random port.
 * A streamed request whose last user message holds the benchmark prompt gets
 * the replay reply, one delta every `intervalMs`; any other streamed request (a title, a summary) gets a
 * one-delta reply, and a request without `stream: true` a one-message JSON
 * reply. Every request is logged without its body, which holds the app's own
 * prompts and paths.
 */
export async function startReplayServer({ deltaCount, deltaChars, intervalMs, prompt, onRequest = () => {} }) {
  const deltas = replyDeltas(deltaCount, deltaChars);
  const startedAt = Date.now();
  const requests = [];
  const open = new Set();
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const route = url.pathname.replace(/^\/v1(?=\/)/u, "");
    if (request.method === "GET" && route === "/models") {
      record({ method: "GET", path: url.pathname, kind: "models" });
      return json(response, { object: "list", data: [{ id: REPLAY_MODEL_ID, object: "model", created: CREATED, owned_by: "agent-app-benchmark" }] });
    }
    if (request.method !== "POST" || route !== "/chat/completions") {
      record({ method: request.method, path: url.pathname, kind: "unknown" });
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: { message: `No route ${request.method} ${url.pathname}.` } }));
    }
    const body = JSON.parse(await readBody(request));
    const kind = body.stream !== true ? "auxiliary-json" : isBenchmarkPrompt(body, prompt) ? "reply" : "auxiliary-stream";
    record({ method: "POST", path: url.pathname, kind, model: String(body.model ?? ""), messages: body.messages?.length ?? 0, tools: body.tools?.length ?? 0 });
    if (kind === "auxiliary-json") {
      return json(response, {
        id: COMPLETION_ID,
        object: "chat.completion",
        created: CREATED,
        model: REPLAY_MODEL_ID,
        choices: [{ index: 0, message: { role: "assistant", content: AUXILIARY_REPLY }, finish_reason: "stop" }],
        usage: usage(1),
      });
    }
    const sent = kind === "reply" ? deltas : [AUXILIARY_REPLY];
    await stream(request, response, replayStreamEvents(sent, { includeUsage: body.stream_options?.include_usage === true }), sent.length, kind === "reply" ? intervalMs : 0);
  }

  function record(entry) {
    const logged = { atMs: Date.now() - startedAt, ...entry };
    requests.push(logged);
    onRequest(logged);
  }

  /** Delta `i` goes out `i × pace` after delta 0, scheduled on the clock so waits do not drift; the role event precedes delta 0 and the closing events follow the last delta. */
  async function stream(request, response, events, deltaCount, pace) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.flushHeaders();
    const begin = performance.now();
    let closed = false;
    request.socket.once("close", () => { closed = true; });
    open.add(response);
    try {
      response.write(events[0]);
      for (let index = 0; index < deltaCount && !closed; index += 1) {
        const wait = begin + index * pace - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (!closed) response.write(events[index + 1]);
      }
      if (!closed) response.end(events.slice(deltaCount + 1).join(""));
    } finally {
      open.delete(response);
    }
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function isBenchmarkPrompt(body, prompt) {
  const lastUser = (body.messages ?? []).findLast((message) => message.role === "user");
  const text = typeof lastUser?.content === "string"
    ? lastUser.content
    : (lastUser?.content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  return text.includes(prompt) && !/reply with only the title/iu.test(text);
}

function usage(completionTokens) {
  return { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens };
}

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("The request body exceeds the replay server's limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
