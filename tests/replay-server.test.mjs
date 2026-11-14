import assert from "node:assert/strict";
import test from "node:test";
import { replayStreamEvents, startReplayServer } from "../src/replay-server.mjs";
import { AUXILIARY_REPLY, replyDeltas, replyOpening } from "../src/replay-reply.mjs";

const PROMPT = "Write the replay benchmark reply.";

test("the reply is fixed-width ASCII deltas of markdown paragraphs, lists and fenced code, and a shorter reply is a prefix of a longer one", () => {
  const deltas = replyDeltas(1_800, 8);
  assert.equal(deltas.length, 1_800);
  assert.ok(deltas.every((delta) => delta.length === 8 && Buffer.byteLength(delta) === 8));
  const text = deltas.join("");
  assert.equal(text.slice(0, 8), "Streamed");
  assert.equal(replyOpening(8), "Streamed");
  assert.ok(!PROMPT.includes(replyOpening(8)));
  assert.match(text, /\n\n- Item 1\.1: a steady cadence\n/u);
  assert.match(text, /\n```ts\nexport const replay1 = /u);
  assert.equal(text.indexOf("- Item 3.1"), replyDeltas(3_600, 8).join("").indexOf("- Item 3.1"));
  assert.deepEqual(replyDeltas(100, 8), deltas.slice(0, 100));
});

async function post(server, body) {
  const started = performance.now();
  const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const arrivals = [];
  let bytes = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    for (const event of text.split("\n\n").filter(Boolean)) if (event.includes('"content":"') && !event.includes('"content":""')) arrivals.push(performance.now() - started);
    bytes += text;
  }
  return { response, bytes, arrivals };
}

test("a benchmark prompt streams the reply byte for byte, one delta every interval without drift", async () => {
  const server = await startReplayServer({ deltaCount: 20, deltaChars: 8, intervalMs: 50, prompt: PROMPT });
  try {
    const { response, bytes, arrivals } = await post(server, { model: "stream", stream: true, stream_options: { include_usage: true }, tools: [{ type: "function" }], messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: [{ type: "text", text: PROMPT }] }] });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(bytes, replayStreamEvents(replyDeltas(20, 8), { includeUsage: true }).join(""));
    assert.equal(arrivals.length, 20);
    arrivals.forEach((at, index) => assert.ok(at >= index * 50 - 5 && at <= index * 50 + 40, `delta ${index} arrived at ${Math.round(at)} ms`));
    assert.deepEqual(server.requests.map(({ kind, tools, messages }) => ({ kind, tools, messages })), [{ kind: "reply", tools: 1, messages: 2 }]);
  } finally {
    await server.close();
  }
});

test("title generation and non-streaming requests get short deterministic answers, and every request is logged without its body", async () => {
  const logged = [];
  const server = await startReplayServer({ deltaCount: 1_800, deltaChars: 8, intervalMs: 50, prompt: PROMPT, onRequest: (entry) => logged.push(entry) });
  try {
    const title = await post(server, { model: "stream", stream: true, messages: [{ role: "user", content: `Here is the first message of the conversation:\n\n<message>\n${PROMPT}\n</message>\n\nReply with only the title.` }] });
    assert.equal(title.bytes, replayStreamEvents([AUXILIARY_REPLY]).join(""));
    const json = await (await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "stream", messages: [{ role: "user", content: "Summarize." }] }) })).json();
    assert.equal(json.choices[0].message.content, AUXILIARY_REPLY);
    const models = await (await fetch(`${server.baseUrl}/models`)).json();
    assert.deepEqual(models.data.map((model) => model.id), ["stream"]);
    assert.equal((await fetch(`${server.baseUrl}/embeddings`, { method: "POST", body: "{}" })).status, 404);
    assert.deepEqual(logged.map((entry) => entry.kind), ["auxiliary-stream", "auxiliary-json", "models", "unknown"]);
    assert.ok(logged.every((entry) => !JSON.stringify(entry).includes("Summarize")));
  } finally {
    await server.close();
  }
});

test("closing the server ends an unfinished stream", async () => {
  const server = await startReplayServer({ deltaCount: 1_800, deltaChars: 8, intervalMs: 50, prompt: PROMPT });
  const response = await fetch(`${server.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({ stream: true, messages: [{ role: "user", content: PROMPT }] }) });
  const reader = response.body.getReader();
  await reader.read();
  await server.close();
  await assert.rejects(async () => {
    for (;;) if ((await reader.read()).done) throw new Error("stream ended without an error");
  });
});
