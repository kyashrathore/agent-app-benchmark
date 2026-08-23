# Driver protocol v1

An application driver is a trusted stateful NDJSON subprocess. It reads requests from stdin, writes only responses to stdout, and sends logs to stderr. Every message contains `protocolVersion`, `correlationId`, and `method`; a response must match exactly one outstanding request.

```text
hello → prepare → launch/execute/shutdown → … → shutdown
```

## `hello`

Returns immutable application/build and driver/source identities, supported scenarios, supported source-event formats, materialization modes, and protocol version. It does not advertise prose capabilities such as `readinessDetection`, `paintDetection`, or `requiredPreparation`.

## `prepare`

Receives exact scenario/corpus/event-schema digests, the generated corpus directory and manifest, and a private run directory. The driver materializes every logical session through the app's ordinary production history path and returns:

- `native-opencode` or `translated` materialization mode;
- the exact corpus and event-schema digests received;
- a digest of the canonical-to-native mapping;
- opaque `P0` and `P1` state handles.

`P0` has never been launched by the application. `P1` completed exactly one unmeasured launch to the common readiness endpoint and then a complete clean shutdown. Handles may identify sealed driver-owned snapshots; public results never serialize their values.

For `opencode-event-v2`, `message.part.updated.1` can carry completed `text`, `reasoning`, `tool`, `step-start`, `step-finish`, and `patch` parts. A native OpenCode driver stores those parts unchanged through its production database path. A translated driver uses its ordinary production history model. If that model has no structured tool/reasoning representation, it serializes the byte-accounted payload into the production message representation rather than dropping it. The manifest's `transcriptBytes` is the exact sum of completed text bytes, reasoning bytes, serialized tool-input bytes, and tool-output bytes. IDs, envelopes, and patch metadata are outside that byte total but remain part of the source object-count load. Preparation must reread authoritative storage and match the manifest's total message count and transcript bytes.

## `launch`

Starts a new app process from the supplied state handle, opens the control session, reaches the common readiness endpoint, and returns every app-owned process root. V3 roots include `{pid,startTimeMs,owner,category,role}`; `role` is one of `main`, `renderer`, `gpu`, `utility`, or `external-helper`. The framework follows descendants of the main root and monitors any separately declared external roots.

The readiness receipt endpoint is exactly `correct-content-painted-and-input-ready`, with these four checks in order:

1. correct canonical content identity;
2. no blank or skeleton-only first fold;
3. stability across two native presentation opportunities;
4. trusted input acceptance.

## `execute`

Performs exactly one manifest-defined action and returns one raw observation. For app start, process spawn occurs inside this method because spawn is the start timestamp. For session switching, the app is already launched.

The response contains the exact case ID, duration, a single-monotonic-clock interval, and the readiness receipt. The framework requires `durationMs` to equal `clock.end - clock.start` within 0.5 ms. V3 also requires a same-clock `observedAt` timestamp for every readiness check; every milestone must lie inside the interval, first-fold paint must precede or equal the second presentation, and the reported end must equal the final readiness milestone. A warm switch includes exactly one unmeasured valid activation before its measured revisit. Drivers never return average, maximum, p95, or report HTML.

## `shutdown`

Cleanly closes only captured app-owned processes and returns terminated identities plus survivors. Any survivor invalidates cleanup. The driver subprocess itself remains available for later isolated attempts until stdin closes.

## Trust and enforcement

The driver is authoritative for native storage translation, UI activation, app-aware timing, paint, and input readiness. The framework validates response shape and sequence but does not claim the driver can independently prove its own honesty.

The framework independently owns canonical input digests, repetition and ordering, timeouts, externally observed process-family CPU/RSS, raw-observation preservation, aggregation, compatibility, and report generation. In V3, one session-switch repetition is one stabilized latency process containing 10 unique destinations per lane plus a counterbalanced size sweep, followed by one fresh progressive-resource process. p95 is withheld below 20 valid latency observations. Registered profiles provide a default repetition count, and a run may override it with an integer from 1 through 100. Paired comparisons use one shared override for every app and record it in each result. Public CI validates submitted source-independent artifacts; it does not run arbitrary contributor executables.

The portable envelope is defined in `schemas/driver-message-v1.schema.json`. Semantic result checks live in `src/protocol.mjs`, and `examples/mock-driver/` is a non-Electron reference implementation.
