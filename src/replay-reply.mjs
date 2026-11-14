export const REPLAY_PROVIDER_ID = "replay";
export const REPLAY_MODEL_ID = "stream";
export const AUXILIARY_REPLY = "Replay thread";

const BLOCKS = [
  (section) => `Streamed reply, section ${section}. The replay server sends this text in fixed deltas at a fixed pace, so every app renders the same bytes at the same moments.\n\n`,
  (section) => `- Item ${section}.1: a steady cadence\n- Item ${section}.2: fixed positions\n- Item ${section}.3: deterministic bytes\n\n`,
  (section) => `\`\`\`ts\nexport const replay${section} = { deltaChars: 8, intervalMs: 50 };\n\`\`\`\n\n`,
];

/**
 * The reply every benchmark prompt streams: markdown paragraphs, lists and
 * fenced code cycling in that order, cut to `deltaCount` deltas of
 * `deltaChars` ASCII characters each. A shorter reply is a prefix of a longer
 * one, so every block keeps its position.
 */
export function replyDeltas(deltaCount, deltaChars) {
  const length = deltaCount * deltaChars;
  let text = "";
  for (let block = 0; text.length < length; block += 1) text += BLOCKS[block % BLOCKS.length](Math.floor(block / BLOCKS.length) + 1);
  return Array.from({ length: deltaCount }, (_, index) => text.slice(index * deltaChars, (index + 1) * deltaChars));
}

/** The reply's first `chars` characters: what the first-word clock waits to see painted. */
export function replyOpening(chars) {
  return replyDeltas(Math.ceil(chars / 8), 8).join("").slice(0, chars);
}
