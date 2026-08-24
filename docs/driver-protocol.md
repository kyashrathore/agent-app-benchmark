# Driver protocol v1

An application driver is a trusted stateful NDJSON subprocess. It reads requests from stdin, writes only responses to stdout, and sends logs to stderr. Every message contains `protocolVersion`, `correlationId`, and `method`; a response must match exactly one outstanding request.

```text
hello → prepare → launch/execute/shutdown → … → shutdown
```

## `hello`

Returns immutable application/build and driver/source identities, supported scenarios, supported source-event formats, materialization modes, and protocol version. It does not advertise prose capabilities such as `readinessDetection`, `paintDetection`, or `requiredPreparation`.

## `prepare`

Receives the scenario digest, corpus/event-schema digests, the generated corpus directory and manifest, and a private run directory. The two workspace-panel scenarios additionally receive the exact validated `scenarioDefinition`, corpus `fixtureSeed`, and canonical workspace fixture manifest and digest. Those panel-only fields are omitted for legacy scenarios so existing strict V1 drivers keep their original prepare request shape. The driver materializes every logical session through the app's ordinary production history path and returns:

- `native-opencode` or `translated` materialization mode;
- the exact corpus and event-schema digests received;
- a digest of the canonical-to-native mapping;
- opaque `P0` and `P1` state handles.
- for a workspace-panel scenario, the exact canonical workspace fixture digest after materialization attestation.

`P0` has never been launched by the application. `P1` completed exactly one unmeasured launch to the common readiness endpoint and then a complete clean shutdown. Handles may identify sealed driver-owned snapshots; public results never serialize their values.

For `opencode-event-v2`, `message.part.updated.1` can carry completed `text`, `reasoning`, `tool`, `step-start`, `step-finish`, and `patch` parts. A native OpenCode driver stores those parts unchanged through its production database path. A translated driver uses its ordinary production history model. If that model has no structured tool/reasoning representation, it serializes the byte-accounted payload into the production message representation rather than dropping it. The manifest's `transcriptBytes` is the exact sum of completed text bytes, reasoning bytes, serialized tool-input bytes, and tool-output bytes. IDs, envelopes, and patch metadata are outside that byte total but remain part of the source object-count load. Preparation must reread authoritative storage and match the manifest's total message count and transcript bytes.

`workspace-panel-v1` and `session-switch-workspace-panel-v1` use generator `agent-app-workspace-v1`. The framework expands `scenarioDefinition.cases.workspaceLoad` and `fixtureSeed` into `workspaceFixtureManifest`: exact relative directories and files, exact changed-file and open-tab identities, exact hunk locations, and initial/current SHA-256 for every file. The package export `agent-app-benchmark/workspace-fixture` provides the canonical manifest builder, byte generator, verifier, and `attestWorkspaceFixture(manifest, readRevision)` helper. A driver must attest the committed initial bytes and working-tree current bytes before returning `workspaceFixtureDigestSha256`; echoing an unverified request field is not conformance. It must not replace the public recipe with app-local hard-coded fixtures.

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

The two workspace-panel scenarios additionally return one `rendererTrace` per action. Its `clock` is the execution clock; absolute milestone, frame, and long-animation-frame timestamps remain inside that action's interval. `transitionMode` is `animated` or `none`. A non-animated open reports `shell-visible` and `animation-settled` at the same time. The neutral toggle-pair actions are animated reversals when a transition exists and immediate double-toggles when it does not; both report the second trusted input and final opposite state without describing an inline, non-animated panel as a reversal. Settled surface, file, tab, and diff interactions are never issued during the opening transition.

The trace preserves at most 600 frame timestamps and 100 long-animation frames. Each long-animation frame preserves at most 32 script attributions with function name, invoker type, sanitized package-asset identifier in `sourceURL`, duration, and forced style/layout duration. Drivers must not serialize URL schemes or local absolute paths in `sourceURL`; use a stable value such as `renderer-assets/panel.js`. Renderer task, script, style-recalculation, and layout counters are raw deltas over the exact execution interval, never cumulative across actions. `counterInterval.start` and `.end` use the trace clock and must equal `clock.start` and `.end` within 0.5 ms. The framework derives milestone intervals, frame-budget misses, transition counts, long-animation-frame counts/worst duration/worst blocking duration, renderer task/script/style/layout summaries, and reports.

`workspace-panel-v1` actions have these exact preconditions and one-click measured inputs:

| Action | Untimed precondition | Measured input and endpoint |
|---|---|---|
| `open-cold` | Panel surface has never mounted and workspace content has not been requested in the process; Files is the selected target. | Toggle open; measure shell visibility and transition independently, then Files data readiness, above-fold paint, and input readiness. |
| `toggle-open-close` | Panel is closed and Files data is warm. | Toggle open, then toggle again during the transition, or immediately when no transition exists; the final closed state must be shown on the next presentation. |
| `toggle-close-open` | Panel is open, settled, and Files data is warm. | Toggle closed, then toggle again during the transition, or immediately when no transition exists; the final open state must be shown on the next presentation. |
| `open-warm-data` | Files data is warm but the panel surface is unmounted/closed. | Toggle open through shell, above-fold paint, and input readiness. |
| `switch-surface` | Panel is settled on loaded Files. | Click the Diff surface tab through its above-fold painted and interactive state. |
| `open-file` | Panel is settled on loaded Files with no file-preview surface active. | Click the first canonical changed file through painted interactive preview. |
| `switch-file-tab` | The scenario's canonical open file tabs are settled and the first is active. | Click the second canonical file tab through painted interactive preview. |
| `toggle-diff-view` | Loaded Diff is settled in stacked mode. | Click split mode through painted interactive Diff. |
| `collapse-all` | Loaded Diff is settled with all file sections expanded. | Click Collapse all through painted interactive Diff. |
| `expand-all` | Loaded Diff is settled with all file sections collapsed. | Click Expand all through painted interactive Diff. |

No panel content input is sent before an opening/closing transition settles. Toggle pairs are the sole exception because interruptibility is the behavior being measured when an animation exists. A `none` transition is valid for an inline panel and means an immediate double-toggle, and remains explicit in raw evidence and framework summaries.

`session-switch-workspace-panel-v1` measures the four cold/warm and within/across lanes independently for `closed`, `files`, and `diff`. Each profile uses a distinct existing V3 latency-pool destination (`sample` 0, 1, or 2), preserving cold/warm semantics in one stabilized process. The three profiles remain adjacent within a lane block, while their order rotates by repetition and lane so each profile occupies every first/middle/last position. Its trace reports `session-ready` and `panel-ready` independently before the combined interactive endpoint, allowing the framework to distinguish transcript readiness from the open Files/Diff cost. The framework derives only matched, valid Files-minus-closed and Diff-minus-closed costs per lane.

## `shutdown`

Cleanly closes only captured app-owned processes and returns terminated identities plus survivors. Any survivor invalidates cleanup. The driver subprocess itself remains available for later isolated attempts until stdin closes.

## Trust and enforcement

The driver is authoritative for native storage translation, UI activation, app-aware timing, paint, and input readiness. The framework validates response shape and sequence but does not claim the driver can independently prove its own honesty.

The framework independently owns canonical input digests, repetition and ordering, timeouts, externally observed process-family CPU/RSS, raw-observation preservation, aggregation, compatibility, and report generation. Structurally valid raw readiness, clock, and renderer traces remain in an invalid observation when semantic validation fails, so a bad endpoint cannot erase diagnostic evidence. Submitted valid panel observations are semantically revalidated from raw evidence. In V3, one session-switch repetition is one stabilized latency process containing 10 unique destinations per lane plus a counterbalanced size sweep, followed by one fresh progressive-resource process. p95 is withheld below 20 valid latency observations. Registered profiles provide a default repetition count, and a run may override it with an integer from 1 through 100. Paired comparisons use one shared override for every app and record it in each result. Public CI validates submitted source-independent artifacts; it does not run arbitrary contributor executables.

The portable envelope is defined in `schemas/driver-message-v1.schema.json`. Semantic result checks live in `src/protocol.mjs`, and `examples/mock-driver/` is a non-Electron reference implementation.
