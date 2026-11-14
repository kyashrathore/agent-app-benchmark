# Driver protocol

An application driver is a trusted stateful NDJSON subprocess. It reads requests from stdin, writes only responses to stdout, and sends logs to stderr. Every message contains `protocolVersion`, `correlationId`, and `method`; a response must match exactly one outstanding request.

```text
hello → prepare → launch/execute/shutdown → … → shutdown
```

## `hello`

Returns immutable application/build and driver/source identities, supported scenarios, supported source-event formats, materialization modes, and protocol version. It does not advertise prose capabilities such as `readinessDetection`, `paintDetection`, or `requiredPreparation`.

A driver lists every scenario it runs in `scenarios`. Where its app cannot do a scenario the same way as the others (no new-thread control in the session view, no way to route its agent to the replay server), it declares that scenario in `unsupportedScenarios: { "<scenario id>": "<one-line reason>" }` instead; the framework then records every case of it as invalid with `Unsupported: <reason>`, launches nothing, and the verdict leaves that app's cells empty with the reason. A scenario in neither is refused.

A driver that implements the benchmark's clock rule declares it as `clockRule: "settle-31-frames"`. The framework refuses a driver that declares a rule it does not check, and records the declaration (or its absence) in every result; the verdict refuses to compare runs whose declarations differ.

## `prepare`

Receives the scenario digest, corpus/event-schema digests, the built corpus directory and manifest, and a private run directory. `run` also sets the driver environment variable `AGENT_APP_BENCHMARK_STATE_CACHE` to one directory shared by that app's scenarios for the life of the run.

For `typing-while-streaming` only, `prepare` also carries the framework's replay server, which serves until the scenario's last `shutdown`:

```json
{
  "replay": {
    "baseUrl": "http://127.0.0.1:50123/v1",
    "npm": "@ai-sdk/openai-compatible",
    "providerId": "replay",
    "modelId": "stream",
    "apiKey": "agent-app-benchmark-replay",
    "prompt": "Write the replay benchmark reply.",
    "replyOpening": "Streamed",
    "deltaCount": 1800,
    "deltaChars": 8,
    "intervalMs": 50
  }
}
```

The driver writes into the sealed state an OpenCode-engine custom provider `replay` (package `npm`, base URL `baseUrl`, any API key) with model `stream`, and makes `replay/stream` the model new threads use. The port changes every run, so state cached across scenarios must take the provider from this `prepare`. A driver may materialize there once and give the second scenario copies of the same state; every launch must still start from its own copy, and `P0` must never have been launched. The driver materializes every logical session through the app's ordinary production history path and returns:

- `native-opencode` or `translated` materialization mode;
- the exact corpus and event-schema digests received;
- a digest of the canonical-to-native mapping;
- opaque `P0` and `P1` state handles.

`P0` has never been launched by the application. `P1` completed exactly one unmeasured launch to the common readiness endpoint and then a complete clean shutdown. Handles may identify sealed driver-owned snapshots; public results never serialize their values.

For `opencode-event`, `message.part.updated.1` can carry `text` (optionally `synthetic`), `reasoning`, `tool` (state `completed`, or `error` with an `error` string), `step-start`, `step-finish` (any 2.x finish reason), `patch` (files relative to the workspace) and `compaction` parts; text and reasoning parts may carry provider `metadata`. The corpus is converted from an OpenCode 2.3 export in the shape OpenCode 2's own V1 migration reads back: each 2.x assistant message is one step (`step-start`, its content in order, a `patch` for the files its snapshot changed, `step-finish`), tool names stay the 2.x names (`shell`, `read`, `edit`, `write`, `grep`, `glob`, `websearch`), and 2.x idle, system and switch markers have no event. A native OpenCode driver stores those parts unchanged through its production database path. A translated driver uses its ordinary production history model. If that model has no structured tool/reasoning representation, it serializes the byte-accounted payload into the production message representation rather than dropping it. The manifest's `transcriptBytes` is the exact sum of completed text bytes, reasoning bytes, serialized tool-input bytes, and tool-output bytes, where a failed tool's output is its error text. IDs, envelopes, and patch metadata are outside that byte total but remain part of the source object-count load. Preparation must reread authoritative storage and match the manifest's total message count and transcript bytes.

## `launch`

Starts a new app process from the supplied state handle, opens the control session, reaches the common readiness endpoint, and returns every app-owned process root as `{pid,startTimeMs,owner,category,role}`; `role` is one of `main`, `renderer`, `gpu`, `utility`, or `external-helper`. The framework follows descendants of the main root and monitors any separately declared external roots.

The readiness receipt endpoint is exactly `correct-content-painted-and-input-ready`, with these four checks in order:

1. correct canonical content identity;
2. no blank or skeleton-only first fold;
3. stability across two native presentation opportunities;
4. trusted input acceptance.

## `execute`

Performs exactly one manifest-defined action and returns one raw observation. For app start, process spawn occurs inside this method because spawn is the start timestamp. For session switching, the app is already launched.

The response contains the exact case ID, duration, a single-monotonic-clock interval, the readiness receipt and the frame log below. The framework requires `durationMs` to equal `clock.end - clock.start` within 0.5 ms. A list-walk step activates only its destination: the source is the session on screen, and the driver fails the step unless the destination is the next row down in the app's own list (or, for OpenCode, the next tab right), and unless a first visit is to a session not yet shown in the process and a return is to one that was. The measured boundary is the trusted `pointerdown`, never `click`, `mousedown`, or a post-handler mark. Drivers never return average, maximum, p95, or report HTML.

### Frame logs

A driver that implements `settle-31-frames` measures with the SDK's page clock: it evaluates `settleExpression({ facts, target, timeoutMs, start })` in the renderer before its trusted click, where `facts` is a function of `target` evaluated in the page that answers `displayed()`, `latestTurnRows()`, `composer()`, `placeholder()`, `transcript()`, `rows()` and `rowKey(row)` for its app. The expression resolves to the frames the clock sampled and its settle; the driver returns them as `frameLog` (`frameLogOf(settle, { startAt, offsetMs })`), and the framework re-derives the clock from them:

```json
{
  "startAt": 1234.5,
  "offsetMs": 0,
  "frames": [
    {
      "at": 1242.8,
      "gates": {
        "displayedDestination": true,
        "latestTurnPainted": true,
        "noPlaceholder": true,
        "firstFoldComplete": true,
        "composerEditable": true,
        "windowVisibleFocused": true
      },
      "signature": "…",
      "mutated": false
    }
  ]
}
```

- `startAt` is the clock's start (the trusted pointerdown for a switch, the process spawn for app start) and, like every `at`, is in the page's clock; `offsetMs` maps them onto the observation's clock (zero for a switch; for app start, the renderer's time origin minus the driver clock's).
- `frames` holds every animation frame sampled after `startAt`, in order (two frames may share a timestamp: `performance.now()` is coarsened), up to and including the frame that completed the settle run. A frame is ready only when all six gates are true; `signature` is the frame's transcript signature (any string, compared only for equality) and may be `null` on an unready frame; `mutated` reports a transcript mutation since the previous frame.
- The framework requires `startAt + offsetMs` to equal `clock.start` and the re-derived settle (the first frame of the first run of 31 consecutive ready frames with one signature and no mutation, plus `offsetMs`) to equal `clock.end`, each within 0.5 ms. Otherwise the observation is invalid and its reason gives the re-derived and reported durations.

### New thread, long thread and typing

Each launched process starts on the control session (`initialSessionId: "control"`). Cases by `workload`:

| `workload` | Case fields | The driver | Measured with |
|---|---|---|---|
| `new-thread` | `sourceSessionId` | shows the source session untimed if it is not on screen, then a trusted `pointerdown` on the app's own new-thread control; after the observation, discards the new thread untimed | `settleExpression({ …, start: "trusted-pointerdown", destination: "empty" })` |
| `long-thread-open` | `sourceSessionId`, `destinationSessionId`, `sessionState` | shows the source (the control session) untimed if it is not on screen, then a trusted `pointerdown` on the destination, the next row down | `settleExpression` as for a list-walk step |
| `long-thread-scroll` | `destinationSessionId`, `scroll: { wheelCount, deltaY, intervalMs, tailMs }` | `wheelCount` trusted wheel events (CDP `Input.dispatchMouseEvent` type `mouseWheel`, `deltaY` CSS px, `intervalMs` apart) over the transcript's centre | `scrollExpression` |
| `stream-first-word` | `sample`, `startIntervalMs` | a new thread untimed, the replay `prompt` typed untimed, then a trusted Enter keydown no earlier than `startIntervalMs` after the previous sample's | `firstWordExpression({ …, text: replay.replyOpening })` |
| `typing` | `keys: [{ key, delayMs }]`, `missAfterMs` | a new thread untimed, its composer focused, then each key as a trusted CDP `Input.dispatchKeyEvent`, `delayMs` after the previous one | `typingExpression({ …, keys: keys.map(k => k.key).join("") })` |

A `typing` request yields one observation per key, so its result has one `typing-key` case per key. The other workloads yield one observation each.

The recorders come from the driver SDK. Each is a renderer expression armed before the first trusted input; `facts` is serialized into the page with `target` as its argument and supplies only facts about the app:

- `settleExpression` facts: `displayed()`, `latestTurnRows()`, `composer()`, `placeholder()`, `transcript()`, `rows()`, `rowKey(row)`. With `destination: "empty"`, `displayed()` is the new-thread view with none of the source session's rows mounted, and `rows()` the new thread's mounted rows (none, once it is shown); `transcript()` may be null.
- `scrollExpression({ facts, target, wheelCount, tailMs, timeoutMs })`, facts `transcript()`: the scroller.
- `firstWordExpression({ facts, target, text, timeoutMs })`, facts `transcript()`: the new thread's transcript.
- `typingExpression({ facts, target, keys, missAfterMs, timeoutMs })`, facts `composer()`: the new thread's composer, empty when armed.

A driver returns a resolved recording as `{ durationMs, clock, frameLog } = recordingObservation(recording, { offsetMs })`, unchanged. Recordings and their re-derivation:

- **Scroll** `{ kind: "scroll", startAt, endAt, wheels: [{ at, deltaY }], frames: [rAF timestamp], scrollTop: { start, end } }`: every animation frame from the first trusted wheel event to `tailMs` after the last. The framework requires `wheelCount` wheel events toward older content, an end at least `tailMs` after the last, the transcript scrolled up, and the clock to span `startAt` to `endAt`; it derives the count of frame intervals over the scenario's `longFrameMs` (33.4) and the nearest-rank p95 interval.
- **First word** `{ kind: "first-word", startAt, frames: [{ at, painted }] }`: from the trusted Enter; a frame is painted when the transcript's text holds `text`. The clock ends at the first painted frame. Sends closer than `startIntervalMs` invalidate the later sample.
- **Typing** `{ kind: "typing", endAt, keydowns: [{ key, at }], frames: [{ at, typed }] }`: every trusted keydown, and per frame how many of `keys`, in order, the composer text holds. Each key's lag runs from its keydown to the first frame at or after it that holds it; a key not held within `missAfterMs` is a miss, timed at `missAfterMs`. The keydowns must be exactly the case's keys in order.

## `shutdown`

Cleanly closes only captured app-owned processes and returns terminated identities plus survivors. Any survivor invalidates cleanup. The driver subprocess itself remains available for later isolated attempts until stdin closes.

## Trust and enforcement

The driver is authoritative for native storage translation, UI activation, and what each frame shows. The framework validates response shape and sequence and re-derives each clock from the frames the driver reports; it cannot see the app itself, so a driver that misreports a frame is caught only by review of its code.

The framework independently owns canonical input digests, repetition and ordering, timeouts, externally observed process-family CPU/RSS, raw-observation preservation, the clock-rule re-derivation from frame logs, aggregation, compatibility, and report generation. Structurally valid raw readiness and clock evidence remain in an invalid observation when semantic validation fails, so a bad endpoint cannot erase diagnostic evidence. One walk repetition is one process walking the list twice, and the memory run is one further process. Nearest-rank p95 is reported at any valid observation count; below 20 valid observations it equals the sampled maximum of those observations and the report discloses that equality. Registered profiles provide a default repetition count, and a run may override it with an integer from 1 through 100. Each app runs separately; a verdict compares runs of the same scenario, corpus, clock rule, and framework revision. Public CI validates submitted source-independent artifacts; it does not run arbitrary contributor executables.

The portable envelope is defined in `schemas/driver-message.schema.json`. Semantic result checks live in `src/protocol.mjs` and `src/observations.mjs`, and `examples/mock-driver/` is a non-Electron reference implementation of every scenario.
