# Plan: new thread, long-thread scroll, typing while streaming

Adds three scenarios to the one default benchmark, adapted from ademark.dev's A3, A4, A8 and A11, measured with this framework's in-page clock, trusted input and sealed state. Owner choice 2026-11-15.

## Scenarios

### `new-thread`

- **Action:** in the control session's workspace, a trusted pointerdown on the app's own new-thread control (the button a user clicks; no keyboard shortcut, because not every app has one).
- **Clock:** pointerdown to the settle of a new empty thread: settle-31-frames with facts for an empty destination. `displayed` is the app's new-thread view with none of the source session's rows mounted; `latestTurnPainted` is true for an empty transcript; `composerEditable` must hold.
- **Samples:** 10 per process, 2 processes, each from a fresh launch of `P1`. The new thread is discarded untimed (the app's own delete, or left as a draft when the app keeps none) before the next sample.
- **Metric:** `new-thread.duration_ms`.

### `long-thread`

- **Corpus:** `long-thread-2000` in workspace-a, built like every other session of `opencode-recorded-sessions`: the turns of one real OpenCode 2.3.0 session (model `opencode/big-pickle`, ademark's Ledger arena and prompts) repeated with fresh ids until the thread reaches 2,000 messages, cut at a whole turn.
- **Open:** a list-walk step to it (pointerdown to settle), reported as `long-thread.open_ms`, 2 processes × 2 visits (first visit and return).
- **Scroll:** after the open settles, 20 trusted wheel events (CDP `Input.dispatchMouseEvent` type `mouseWheel`, deltaY −480 CSS px, 50 ms apart) over the transcript's centre, toward older content. An in-page rAF recorder logs every frame from the first wheel to 500 ms after the last.
- **Metrics:** `long-thread.scroll_long_frames` (frame intervals over 33.4 ms, i.e. two missed 60 Hz frames) and `long-thread.scroll_p95_frame_ms`. The framework re-derives both from the recorded frame log, like the settle.

### `typing-while-streaming`

- **Replay server:** the framework starts an OpenAI-compatible chat-completions server on 127.0.0.1 (random port, passed to the driver in `prepare`). Every request streams the same deterministic reply: 1,800 text deltas of 8 characters, one every 50 ms (90 s), with markdown paragraphs, lists and fenced code at fixed positions. No network, no model.
- **Routing:** every app reaches it through an OpenCode-engine custom provider (`@ai-sdk/openai-compatible`, model `replay/stream`): OpenCode by its config, T3 Code by its `opencode` provider pointed at the pinned OpenCode 2.3.0 CLI, Claxedo by its harness provider definition. The driver writes this config into the sealed state.
- **First word:** in a new thread, the prompt is typed untimed, then a trusted Enter keydown starts the clock; it stops at the first frame in which the reply's first 8 characters are painted in the transcript. 5 samples (one per stream start below). Metric `stream.first_word_ms`.
- **Load:** 5 threads streaming, started 2 s apart (the 5 first-word samples above).
- **Typing:** in a sixth, new thread, 60 trusted key presses (CDP `Input.dispatchKeyEvent`, lowercase letters from a fixed sequence), 250 ms apart ± 20 % from a fixed seed. Per key: from the trusted `keydown` (page clock) to the first frame whose composer text includes the character, read after style and layout. A key not painted within 2 s is a miss.
- **Metrics:** `typing.lag_p50_ms`, `typing.lag_p95_ms` and `typing.missed`. One process; the 60 keys are the samples.

## Fairness

- Same corpus, same reply bytes, same cadence, same input path (trusted CDP events) and the same sealed-state rules in every app.
- Where an app cannot do a step the same way (no new-thread control in the session view, no way to route its agent to the replay server), its cell stays empty with a one-line reason, per the owner's rule.

## Budget

One app's whole run stays at or under 4 minutes (2026-09-28 owner rule). Estimated additions: new-thread about 30 s, long-thread about 30 s, typing about 2 min (the 90 s stream overlaps the typing). If an app runs over, the stream is shortened before samples are cut.

## Definition of done

1. Scenario JSONs, contracts and corpus generation for the three scenarios; `npm test` passes, including clock re-derivation tests for scroll frames and key-to-paint.
2. The replay server is in the framework with a unit test of its byte-exact stream.
3. Each of the three drivers implements all three scenarios on its branch (Claxedo in `packages/claxedo-app/perf-harness`, T3 on `agent-app-benchmark` at v0.1.7, OpenCode on `agent-app-benchmark` at v2.3.0) with its own unit tests.
4. One back-to-back run of all three apps, every observation valid, each app under 4 minutes; the verdict shows the new rows with empty cells only where the fairness rule says so.
5. README and RUNNING describe the new metrics and per-app differences.
