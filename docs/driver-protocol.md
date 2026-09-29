# Driver protocol

An application driver is a trusted stateful NDJSON subprocess. It reads requests from stdin, writes only responses to stdout, and sends logs to stderr. Every message contains `protocolVersion`, `correlationId`, and `method`; a response must match exactly one outstanding request.

```text
hello → prepare → launch/execute/shutdown → … → shutdown
```

## `hello`

Returns immutable application/build and driver/source identities, supported scenarios, supported source-event formats, materialization modes, and protocol version. It does not advertise prose capabilities such as `readinessDetection`, `paintDetection`, or `requiredPreparation`.

A driver that implements the benchmark's clock rule declares it as `clockRule: "settle-31-frames"`. The framework refuses a driver that declares a rule it does not check, and records the declaration (or its absence) in every result; the verdict refuses to compare runs whose declarations differ.

## `prepare`

Receives the scenario digest, corpus/event-schema digests, the generated corpus directory and manifest, and a private run directory. `run` also sets the driver environment variable `AGENT_APP_BENCHMARK_STATE_CACHE` to one directory shared by that app's two scenarios for the life of the run. A driver may materialize there once and give the second scenario copies of the same state; every launch must still start from its own copy, and `P0` must never have been launched. The driver materializes every logical session through the app's ordinary production history path and returns:

- `native-opencode` or `translated` materialization mode;
- the exact corpus and event-schema digests received;
- a digest of the canonical-to-native mapping;
- opaque `P0` and `P1` state handles.

`P0` has never been launched by the application. `P1` completed exactly one unmeasured launch to the common readiness endpoint and then a complete clean shutdown. Handles may identify sealed driver-owned snapshots; public results never serialize their values.

For `opencode-event`, `message.part.updated.1` can carry completed `text`, `reasoning`, `tool`, `step-start`, `step-finish`, and `patch` parts. A native OpenCode driver stores those parts unchanged through its production database path. A translated driver uses its ordinary production history model. If that model has no structured tool/reasoning representation, it serializes the byte-accounted payload into the production message representation rather than dropping it. The manifest's `transcriptBytes` is the exact sum of completed text bytes, reasoning bytes, serialized tool-input bytes, and tool-output bytes. IDs, envelopes, and patch metadata are outside that byte total but remain part of the source object-count load. Preparation must reread authoritative storage and match the manifest's total message count and transcript bytes.

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

## `shutdown`

Cleanly closes only captured app-owned processes and returns terminated identities plus survivors. Any survivor invalidates cleanup. The driver subprocess itself remains available for later isolated attempts until stdin closes.

## Trust and enforcement

The driver is authoritative for native storage translation, UI activation, and what each frame shows. The framework validates response shape and sequence and re-derives each clock from the frames the driver reports; it cannot see the app itself, so a driver that misreports a frame is caught only by review of its code.

The framework independently owns canonical input digests, repetition and ordering, timeouts, externally observed process-family CPU/RSS, raw-observation preservation, the clock-rule re-derivation from frame logs, aggregation, compatibility, and report generation. Structurally valid raw readiness and clock evidence remain in an invalid observation when semantic validation fails, so a bad endpoint cannot erase diagnostic evidence. One walk repetition is one process walking the list twice, and the memory run is one further process. Nearest-rank p95 is reported at any valid observation count; below 20 valid observations it equals the sampled maximum of those observations and the report discloses that equality. Registered profiles provide a default repetition count, and a run may override it with an integer from 1 through 100. Each app runs separately; a verdict compares runs of the same scenario, corpus, clock rule, and framework revision. Public CI validates submitted source-independent artifacts; it does not run arbitrary contributor executables.

The portable envelope is defined in `schemas/driver-message.schema.json`. Semantic result checks live in `src/protocol.mjs`, and `examples/mock-driver/` is a non-Electron reference implementation.
