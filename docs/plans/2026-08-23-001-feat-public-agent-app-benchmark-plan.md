# Public Multi-Harness Coding-Agent GUI Benchmark V1

**Status:** Active implementation  
**Date:** 2026-08-23  
**Target repository:** `kyashrathore/agent-app-benchmark`  
**Initial applications:** T3 and Claxedo  
**Scope:** Multi-harness coding-agent GUI apps; app start, session switching, and whole-app CPU/RSS during the session-switch workload

## 1. Outcome

Create a small, GUI-toolkit-neutral public benchmark repository for coding-agent applications that can host one or more agent harnesses. V1 measures only the GUI's handling of completed historical sessions; it does not run, time, or compare the coding-agent harness itself.

V1:

1. Defines exactly two public scenarios: `app-start-v1` and `session-switch-v1`.
2. Runs the same deterministic OpenCode-event-format historical-session corpus against T3 and Claxedo through app-owned drivers.
3. Produces the requested app-start tables, four session-switch tables, latency/CPU/memory charts, and one overall memory table.
4. Generates a small locally runnable static website with one comparison home page and one individual page for every available app.
5. Lets anyone run a custom scenario locally, while requiring a pull request before a scenario, corpus, or result is eligible for public comparison.
6. Preserves raw observations and derives all summaries in the framework so published results can be independently recomputed.

The new repository owns benchmark policy and measurement. T3 and Claxedo continue to own product-specific storage preparation, application launching, selectors, and semantic readiness checks.

## 2. Explicit non-goals for V1

- No streaming benchmark.
- No embedded terminal/PTY coding-agent benchmark in V1. Terminal coding agents running inside an app may be supported later through separately versioned `terminal-agent` scenarios and corpora.
- No live model or agent execution.
- No Web Vitals or browser-page quality score, including LCP, INP, CLS, FCP, or TTFB. A driver may use browser timing APIs only as clocks for the benchmark's own scenario endpoints.
- No `profile` abstraction.
- No small/medium/large transcript buckets.
- No session list in the human-readable report.
- No composite score, overall winner, or cross-machine leaderboard.
- No generic UI-action DSL for arbitrary applications.
- No hidden benchmark-only rendering or storage path inside either application.
- No npm publication requirement in the first slice; the repository and its pinned CLI entrypoint are sufficient initially.

## 3. Ownership model

```text
public scenario + corpus definition
              │
              ▼
standalone benchmark runner ─────► native process-family monitor
              │                                │
              ▼                                │
      app-owned NDJSON driver                  │
              │                                │
              ▼                                │
        packaged application                   │
              │                                │
              └──── raw validity/latency ◄─────┘
                              │
                              ▼
                 raw result bundle + shared report model
                              │
                              ▼
                  local static website
```

### 3.1 Standalone repository owns

- Scenario, corpus, driver-message, raw-result, and comparison schemas.
- Immutable public scenario and corpus registries.
- Deterministic exact-size corpus generation and verification.
- Driver process orchestration and conformance tests.
- Repetition order, clocks, timeouts, invalid-sample handling, and cleanup policy.
- Whole-process-family resource observation.
- Average, maximum, nearest-rank p95, and chart derivation.
- Same-machine T3/Claxedo comparison orchestration.
- Publication validation, shared report derivation, and local static-site generation.

### 3.2 Application repositories own

T3 owns its canonical-corpus-to-native-event materializer, packaged-app launcher, process-root declaration, UI activation, and semantic paint/input receipt. Claxedo owns the equivalent canonical-corpus-to-OpenCode/Claxedo-storage mapping and browser/CDP integration.

Drivers return raw observations and structured validity evidence. They do not decide repetitions, aggregate p95, generate reports, or redefine public scenario semantics.

### 3.3 Corpus and driver trust boundary

The benchmark repository owns and generates one versioned OpenCode event corpus named `opencode-completed-transcripts-v1`. The framework remains independent of any GUI toolkit, but this first public workload intentionally uses OpenCode as its harness/event source format.

The pinned event envelope follows OpenCode `EventV2.SerializedEvent`—`id`, `type`, `seq`, `aggregateID`, and `data`—plus the pinned durable-event manifest needed to validate event payloads. The extraction baseline is OpenCode revision `a9f7081d4015b0cc22ed67156e042b482a8d064a`, `packages/core/src/event.ts`, and `packages/schema/src/durable-event-manifest.ts`; the standalone repository commits its own immutable V1 schema/digest so later OpenCode changes cannot mutate old benchmark input.

Benchmark metadata assigns workspace/session roles and final transcript-byte targets around the ordered event streams. The corpus contains completed user/assistant text events only in V1. `transcriptBytes` counts final completed UTF-8 text payloads, not event envelopes, IDs, sequences, timestamps, metadata, database rows, or storage encoding.

Each driver is a trusted adapter for its own application:

- An app with a shipped OpenCode harness should replay/import the corpus through its ordinary production OpenCode history path. The result records `materializationMode: native-opencode`.
- An app without a production OpenCode harness may use a reviewed driver translation from the canonical OpenCode event stream into its ordinary native session history. The result records `materializationMode: translated`.
- If an OpenCode-capable app uses translation instead of its normal OpenCode path, the driver PR must explain why; the website discloses the mode.
- T3 may translate one OpenCode event stream into several persisted T3 events and projections.
- Claxedo may replay the same stream into OpenCode message/part storage plus Claxedo workspace/session metadata.
- Native IDs, timestamps, event counts, row counts, and schemas may differ and are not fairness metrics.
- The driver attests that it materialized the supplied canonical corpus digest and that its scenario actions/readiness receipts follow the public definition.

The framework does not claim that DOM inspection or driver-supplied read-back can prove a driver is honest; the same driver controls those observations. Conformance tests and required app-owned native-store integration tests for public adapters catch accidental integration mistakes, not malicious reporting. Public comparison therefore pins and displays the driver source location, exact commit/build digest, app version, and maintainer attestation. Pull-request review decides whether a driver is accepted for the public comparison corpus.

The framework enforces only what it can own independently: the exact OpenCode source-event schema and ordered-corpus digests handed to every driver, app and scenario identity, schedule, repetitions/order, framework-side aggregation, externally observed process-family resources, environment compatibility, raw-result preservation, and report derivation.

### 3.4 Canonical implementation boundary

Generic framework code is extracted from the current T3 local series `2c4158f87..b0d3528d3`, principally framework commit `e5c549416`, into the standalone repository and then removed from T3 after its adapter passes the new conformance suite. App-specific T3 code stays in T3. App-specific Claxedo code stays in Claxedo. Duplicated Claxedo contracts, aggregators, and agent-benchmark runner paths are removed only after the new public entrypoint passes.

## 4. Public scenario model

A public scenario package contains:

- A permanent versioned ID.
- Exact cases and lifecycle steps.
- Exact corpus identity and transcript byte definition.
- Raw observations required from the driver and resource monitor.
- Validity and timeout rules.
- Framework-owned aggregation and report definitions.
- A content digest covering all comparable semantics.

Merged public definitions are immutable. Any semantic change creates a new version such as `session-switch-v2`; it does not mutate V1.

A custom local manifest can use the same schema, but the result is always marked `custom/non-comparable` unless its exact digest is present in the merged public registry.

## 5. Scenario A: `app-start-v1`

Avoid the ambiguous labels “cold start” and “warm start.” V1 uses these two cases:

| Case | Exact meaning | Start | End | Reported values |
|---|---|---|---|---|
| First launch — new application state | A new app process uses a prepared application-state snapshot that the application has never launched with. | Immediately before OS process spawn. | The fixed 1 MiB anchor transcript is correct and fully painted, stable across two consecutive native presentation opportunities, and the composer accepts trusted input. | Average, maximum, p95, valid/attempted samples. |
| Repeat launch — initialized application state | A new app process uses a clone of an application-state snapshot that completed exactly one earlier unmeasured launch to the same endpoint and then shut down cleanly. | Immediately before OS process spawn. | The identical endpoint used for first launch. | Average, maximum, p95, valid/attempted samples. |

Repeat launch is not revealing a hidden window, focusing a background process, or resuming an existing process. It is a new process launch. OS caches are not artificially flushed, so the report must disclose machine state and execution order instead of claiming a hardware “cold” start.

### 5.1 Reproducible application-state preparation

- `P0` is the prepared application-state snapshot before the application has ever used it.
- Each first-launch attempt gets a fresh clone of `P0`.
- `P1` is created once from a clone of `P0` by completing one unmeasured launch and clean shutdown.
- Each repeat-launch attempt gets a fresh clone of `P1`.
- A failed preparation, readiness check, shutdown, or survivor check invalidates the attempt; it is not silently retried as the same sample.

### 5.2 Publication defaults

- Smoke: 3 measured attempts per case.
- Local quick run: 5 measured attempts per case.
- Public app start: 20 measured attempts per app-start case.
- Public session switching: 20 observations per `(lane, transcript size)`. One fresh app process runs all six counterbalanced sizes for one lane repetition, yielding 80 session-switch processes and 480 raw switch observations per app rather than one process per observation.
- Conformance checks and required warmup/P1 preparation are separate lifecycle steps, not discarded “harness samples.”
- T3 and Claxedo attempts are interleaved using a recorded balanced seed to reduce thermal and time-order bias.

## 6. Scenario B: `session-switch-v1`

### 6.1 Four independent report lanes

| Lane | Workspace relationship | Cache state |
|---|---|---|
| Within workspace — cold | Origin and destination are in the same active workspace. | Destination has never become active in the current app process. |
| Within workspace — warm | Origin and destination are in the same active workspace. | Destination was activated once to the full valid endpoint, the driver navigated back to the fixed origin, then the measured revisit occurs. |
| Across workspaces — cold | Origin and destination are in different workspaces. | Destination has never become active in the current app process. |
| Across workspaces — warm | Origin and destination are in different workspaces. | Destination was activated once to the full valid endpoint, the driver navigated back to the fixed origin, then the measured revisit occurs. |

Each lane receives its own result table containing only average, maximum, p95, and valid/attempted sample count. The report does not print session IDs or a session list. Raw artifacts retain pseudonymous corpus session IDs for auditability.

### 6.2 Transcript size

Public V1 pins exact target sizes:

`1, 2, 4, 8, 16, 32 MiB`, where `1 MiB = 1,048,576` canonical UTF-8 content bytes.

V1 uses only completed user/assistant text messages. This keeps the initial size benchmark portable across apps whose tool, diff, reasoning, and rich-part event structures differ. Rich-content corpora can be proposed later as separately versioned public corpora.

The generator produces the same immutable OpenCode-event corpus directory for every app from the same seed. It contains a small benchmark manifest plus streamed per-session OpenCode event NDJSON files, avoiding a roughly 253 MiB in-memory JSON object. For each target size it creates four distinct destination sessions—within-cold, within-warm, across-cold, and across-warm—plus one fixed 1 MiB control/origin session. The V1 topology is therefore 25 logical sessions: one control plus four targets across six sizes. The benchmark manifest, not the driver, assigns these roles.

Canonical transcript bytes are the UTF-8 bytes of final ordered completed text payloads. They exclude app-native database encoding, indexes, IDs, timestamps, OpenCode event envelopes, parts metadata, and storage overhead. The framework verifies exact byte counts, event ordering, event-schema digest, and whole-corpus digest. The driver records a materialization attestation containing the received event/corpus digests, materialization mode, driver revision, and canonical-to-native session mapping; native read-back validation remains an app-owned test rather than a claimed independent proof.

### 6.3 Switch timing endpoint

- Start: the trusted driver observes activation of the destination through the real application UI on the same monotonic clock it uses for the end point.
- End: the destination's canonical content identity is correct, its first fold has no blank virtualization gap or skeleton-only state, the rendered state is stable across two consecutive native presentation opportunities, and trusted input is accepted. Electron/web drivers may use consecutive `requestAnimationFrame` callbacks; other GUI toolkits use audited compositor, frame-present, or equivalent callbacks.
- Wrong content, timeout, reload, crash, incomplete paint, or unusable input invalidates the sample even when a timestamp exists.
- The driver component that can observe both activation and readiness owns the raw latency clock. For a browser-rendered switch this is normally the renderer performance clock; for app start it is the driver clock immediately around spawn through readiness. The framework never subtracts timestamps from different clocks. Runner request/response timestamps remain an outer diagnostic envelope.

### 6.4 Isolated latency schedule

Latency samples are isolated from the continuous resource workload:

- Cold attempts start from a fresh initialized application-state snapshot and new application process so “cold” is not exhausted after the first activation.
- Warm attempts perform exactly one unmeasured valid activation, navigate to the fixed 1 MiB origin, and then perform one measured revisit.
- Transcript sizes use a recorded seeded counterbalanced order rather than always ascending, preventing size from being conflated with accumulated cache, thermal state, or sequence.
- The framework records one raw action observation per switch. Average, maximum, and p95 are calculated later from those raw observations.

The latency chart uses actual transcript bytes on the X axis and switch duration on the Y axis, with four lane series. It does not introduce size buckets.

## 7. CPU and memory workload

CPU and memory are one app-level session-switch result. They are not split into app-start, within-workspace, or across-workspace memory tables.

### 7.1 Exact lifecycle

```text
launch a new initialized process
→ render the fixed 1 MiB control transcript
→ settle for 15 seconds
→ observe baseline idle for 60 seconds
→ execute the deterministic session-switch workload from 1 to 32 MiB
→ return to the same 1 MiB control transcript
→ settle for 15 seconds
→ observe ending idle for 60 seconds
→ clean shutdown and survivor check
```

Transcript sizes run strictly in ascending order from 1 to 32 MiB. Within each size, the four lanes use the pinned seeded order. There is no agent run, model call, live stream, terminal, or synthetic background task.

Each lane/size has a distinct destination assigned by the corpus manifest. A cold lane activates its never-opened destination once. A warm lane activates its separate destination to readiness, returns to the fixed control session, and then performs the measured revisit. Warmup activation and the return switch are part of the active resource workload and remain visible in its raw sequence even though only the revisit contributes to the warm latency table.

### 7.2 Exact terms

- **Baseline idle:** The visible app has fully loaded the fixed 1 MiB control transcript. During the 60-second window there is no driver input, session switch, live agent, stream, or terminal activity. Normal product timers, garbage collection, and background services remain included.
- **Active:** Only the intervals from each trusted session activation through its valid painted and input-ready endpoint during the deterministic `session-switch-v1` progression.
- **Ending idle:** The same 1 MiB control transcript and same no-input conditions as baseline, after the full workload. Returning to the same surface avoids mistaking the currently displayed 32 MiB page for retained growth.

### 7.3 Process and sampling rules

- Measure the full attributable application process family, identified by `(pid, processStartTimeMs)` and descendant ownership.
- Exclude the runner, driver, automation controller, and native monitor.
- The trusted driver declares every app-owned process root. The framework validates those roots, tracks their descendants by PID/start-time identity, displays the declaration, and invalidates observed unclassified processes within that declared family. It does not claim host-wide discovery of undeclared unrelated processes.
- RSS is the sum across the app process family and is labeled as such because shared pages can be counted in multiple multi-process GUI helpers.
- CPU percentage is sampled cumulative CPU-time delta for every descendant observed inside the boundary, divided by elapsed wall time. New descendants count from process birth; exiting descendants count through their final sample, and unobserved later work is not estimated. PID/start-time identity prevents reuse from being treated as continuity. 100% means one fully occupied logical core and multicore totals may exceed 100%.
- Continuous active samples use the existing native 250 ms cadence; idle uses 1000 ms.
- Each switch also has resource snapshots immediately before activation and after the semantic endpoint. Per-switch CPU derives from cumulative CPU-time deltas, so a switch faster than 250 ms is not assigned a fabricated zero or missing interior sample.
- Missing telemetry, identity reuse, excessive cadence gaps, or monitor failure invalidates the resource portion while preserving independently valid latency observations.

### 7.4 Memory result

| Result | Definition |
|---|---|
| Baseline idle average RSS | Arithmetic average of whole-process-family RSS during baseline idle. |
| Active average RSS | Arithmetic average of 250 ms whole-process-family RSS samples during the complete valid active workload. |
| Active maximum RSS | Largest whole-process-family RSS sample during the complete valid active workload. |
| Active p95 RSS | Nearest-rank p95 of whole-process-family RSS samples during the complete valid active workload. |
| Ending idle average RSS | Arithmetic average during ending idle on the same 1 MiB control transcript. |
| Retained RSS growth | Ending idle average RSS minus baseline idle average RSS. Negative values remain visible. |

### 7.5 Charts

- **CPU growth chart:** X is cumulative switch sequence, annotated with lane and exact transcript bytes. Y is per-switch whole-process-family CPU percentage from bracketing cumulative CPU-time snapshots. A light rolling trend may be derived, but raw points remain available.
- **Memory growth chart:** X is the same switch sequence. Y is post-ready whole-process-family RSS, with the active peak available in the underlying point metadata.
- **Retained-memory marker:** Baseline idle average versus ending idle average on the same control transcript.

## 8. Driver protocol V1

Use a trusted executable NDJSON protocol so T3 can launch with Node, Claxedo can launch with Bun, and future drivers can be compiled binaries. The user supplies an explicit executable and arguments; the framework does not infer a runtime from a filename.

| Message | Owner | Purpose |
|---|---|---|
| `hello` | Driver | Returns immutable app/driver identity, supported source-event formats/materialization modes, protocol version, and supported public scenario IDs. |
| `prepare` | Framework → driver | Supplies the exact canonical corpus, scenario/corpus digests, case, application-state/run paths, and expected logical manifest. Driver materializes native state and returns a materialization attestation and canonical-to-native session mapping that are recorded in the result. |
| `launch` | Framework → driver | Starts the packaged app from the supplied isolated application-state snapshot and returns exact owned process roots plus launch/readiness evidence. |
| `execute` | Framework → driver | Performs one manifest-defined activation and returns one raw driver-timed duration plus its validity/readiness receipt. The framework records an outer request envelope and external resource snapshots but does not replace the driver's app-aware clock. |
| `shutdown` | Framework → driver | Cleanly closes the exact owned process family and reports any survivors. |

The protocol deliberately removes `profiles`, `readinessDetection`, `paintDetection`, and `requiredPreparation`. Those were prose capabilities that could be declared without being exercised. V1 requires and validates the presence, structure, identity, and sequencing of driver-attested receipts; it independently enforces only framework-owned scheduling, aggregation, declared process-family observation, compatibility, preservation, and reporting rules.

Drivers are trusted local executables and authoritative for their app-specific preparation, action timing, and readiness semantics. The framework still owns repetition scheduling and aggregation, so a driver returns individual raw observations rather than a precomputed average or p95. Public pull-request CI validates schemas and submitted artifacts but does not execute an arbitrary contributor driver on a privileged hosted runner. The report must say “driver-attested” rather than implying independent verification of app-native state.

T3 and Claxedo are the initial Electron implementations, but Electron is not an eligibility requirement. Drivers may use Playwright Electron, CDP, WebDriver, native accessibility APIs, compositor callbacks, or other app-appropriate automation. A non-Electron mock GUI driver must pass protocol and resource conformance before V1 publication.

## 9. Result and report shape

### 9.1 Raw result bundle

The append-only raw bundle contains:

- Framework, schema, scenario, corpus, app, and driver immutable identities/digests.
- OpenCode source-event format/schema digest and the driver's disclosed materialization mode (`native-opencode` or `translated`).
- Host environment, display, power, packaged-app flags, run seed, and comparison provenance.
- Every launch and switch observation, including invalid and failed attempts.
- Semantic receipts, process identities, raw monitor ticks, boundary snapshots, cadence checks, and cleanup outcomes.
- Derivation version and hashes of large external artifacts.

Local diagnostics and shareable public artifacts use separate schemas. The public bundle is constructed from a closed allowlist and excludes corpus text, raw stderr, environment-variable values, command lines, screenshots, absolute paths, credentials, and unbounded error bodies. Allowed environment and process fields are normalized and the final serialized bytes are scanned before publication.

Failed samples and outliers are never deleted or replaced. A summary can state why a sample was invalid, but the raw record remains.

If any action in the continuous publication resource workload is invalid, the resource workload as a whole is non-comparable and produces no headline CPU/RSS summary. All attempted telemetry remains available as diagnostic evidence; the framework never computes a favorable resource headline from only the surviving intervals.

### 9.2 Shared report model

One framework-owned report model is derived from validated raw result bundles. The V1 static HTML site is the human report; raw/result JSON remains the recomputation source. The report model contains:

1. First-launch and repeat-launch table.
2. Within-workspace cold switch table.
3. Within-workspace warm switch table.
4. Across-workspaces cold switch table.
5. Across-workspaces warm switch table.
6. Latency versus exact transcript-size chart with four series.
7. One overall memory table.
8. One CPU growth chart.
9. One memory growth chart and retained-memory marker.
10. Validity, environment, immutable identity, and provenance disclosures.
11. Concise scenario-sourced definitions and units for both app-start cases, all four switch lanes, baseline/ending idle, active, CPU percentage, summed RSS, retained growth, average, maximum, and p95.
12. Metric origin labels: latency/readiness are driver-attested; CPU/RSS are framework-observed over the driver-declared process family; summaries/charts are framework-derived.

No session list, size bucket table, or composite rank appears.

### 9.3 Local comparison website

The CLI generates a dependency-free static site from one explicit immutable comparison manifest. It does not scan a directory for “latest” results.

```text
comparison manifest + referenced result bundles
                    │
                    ▼
          validate compatibility
                    │
                    ▼
       derive shared report model
                    │
                    ▼
site/index.html
site/apps/t3/index.html
site/apps/claxedo/index.html
site/assets/site.css
```

The comparison manifest explicitly lists one result bundle and digest for every available app and public scenario, so each app normally references separate `app-start-v1` and `session-switch-v1` bundles. Side-by-side values require matching comparison-run, framework, scenario, corpus, run-profile, and environment identities.

The site uses one status vocabulary everywhere: `valid`, `invalid`, `incompatible`, and `unpaired` for metric eligibility; `driver-attested`, `framework-observed`, and `framework-derived` for metric origin; and `maintainer-observed` or `community-self-attested` for run provenance. Status and its plain-language reason appear beside the affected values rather than only in a footer.

Validity and compatibility are tracked separately for app-start latency, session-switch latency, CPU, and RSS. A page shows every independently valid section. Only the invalid or incompatible metric family is replaced with its plain-language reason and valid/attempted count; it is never rendered as zero or paired. A whole app page is unavailable only when it has no usable result section.

The comparison home page shows:

- A title that identifies V1 as an OpenCode-event, completed plain-text, GUI-session benchmark and explicitly excludes Web Vitals, tool/diff/reasoning workloads, streaming, embedded terminal agents, and live-agent performance.
- Comparison identity, environment, app identity, OpenCode source-event schema/materialization mode, corpus/scenario identities, and metric-level trust disclosure.
- One card and link for every app listed in the comparison manifest.
- Side-by-side app-start results.
- The four side-by-side session-switch tables.
- Shared latency, CPU, and memory charts.

Each `/apps/<stable-app-id>/` page shows that app's identity, source-event schema provenance, materialization mode, driver provenance, per-metric validity, two app-start rows, four switch tables, latency-size chart, memory table, CPU/memory trends, limitations, concise metric definitions, and a link back to the comparison.

The output uses escaped server-generated HTML, local CSS, and deterministic inline SVG charts. Stable app IDs are validated short ASCII slugs; text, attributes, URLs, and SVG contexts are escaped separately; provenance links allow only HTTPS; and a restrictive no-script content policy is embedded. It contains no CDN, remote font, browser-side metric computation, runtime fetch, or server command, so users open `index.html` directly from disk.

Semantic landmarks, heading order, table captions/scoped headers, visible keyboard focus, sufficient contrast, accessible SVG titles/descriptions, and non-color series markers are required. Every chart has an adjacent compact data table so the same result is available without SVG or color perception. On narrow screens or at 200% zoom, comparison values stack by app while preserving metric labels; wide tables use clearly signaled horizontal overflow rather than clipped values.

Site generation writes and validates a temporary sibling directory. The target must either not exist or carry the benchmark-generated marker and be explicitly replaced; recoverable two-phase replacement prevents partial output and stale app pages without claiming that replacing a non-empty directory is a single atomic filesystem operation.

## 10. Public contribution and comparison workflow

### 10.1 Add a scenario or corpus

1. Contributor adds a versioned scenario package and/or corpus generator definition in a pull request.
2. CI validates schemas, immutable IDs, exact deterministic regeneration, digests, semantic completeness, aggregation rules, privacy, and mock-driver contract tests.
3. Review confirms the endpoint is meaningful across applications and does not encode one product's internals.
4. Merge makes that exact digest public. Changed semantics require a new ID/version.

A scenario definition alone cannot automate a new app. The app must also provide a driver that advertises and conforms to that scenario.

### 10.2 Add or update a trusted app driver

A driver-registry pull request records the stable app ID, app version, public source repository, immutable source commit, driver executable SHA-256, packaged-app SHA-256, supported scenarios/corpora, maintainer identity, and an attestation that the adapter uses the app's ordinary production historical-session storage/rendering path rather than a benchmark-only shortcut.

Eligibility review checks protocol conformance, app-owned native-store integration tests, raw-observation behavior, declared process roots, and the maintainer attestation. The trust is explicit rather than cryptographic proof of correctness. A later-discovered mapping, readiness, or build-identity bug marks affected results invalid/superseded and requires a new driver revision and result run; accepted results are never silently rewritten.

The initial public entries happen to be Electron apps. Contributors are explicitly welcome to add coding-agent GUI apps built with native toolkits, Tauri, Flutter, Qt, browsers, or other frameworks, provided their driver satisfies the same public scenario, resource, provenance, and result contracts.

### 10.3 Propose another metric

A contributor may propose another performance metric through a pull request. Metrics live directly inside a scenario definition rather than a separate profile or metric-set abstraction. Every proposed metric defines its stable ID, description, unit, better direction, clock/observer owner, required raw inputs, validity rules, aggregation, and report placement.

Adding or changing a public metric creates a new immutable scenario version and requires new public comparison runs for that scenario. Local custom metrics remain `custom/non-comparable` until their exact scenario definition is merged. A result that does not implement the new scenario stays available under the older scenario; it is never filled with zero or silently compared to the newer result.

### 10.4 Submit a result

1. Contributor runs a pinned released framework/scenario/corpus against immutable app and driver revisions.
2. The result PR includes the compact raw/result index, environment, provenance, and compressed raw observations needed for V1 recomputation.
3. CI recomputes all tables and charts from raw observations and rejects hand-edited aggregates, mismatched digests, omitted failures, or non-public scenario identities.
4. V1 keeps bounded compressed traces in Git. A separate large-artifact intake/release workflow is deferred until measured artifacts exceed repository limits.

Community-run and maintainer-observed submissions are both allowed but clearly labeled. Only apps measured as part of the same paired comparison run on the same machine/environment are placed side by side.

Every accepted paired run retains its own immutable comparison manifest and generated-site identity. V1 does not select a silent “best” or “latest” run: the initial home page names the exact initial maintainer-observed comparison, while other accepted runs remain separately addressable by comparison ID.

### 10.5 Initial T3 versus Claxedo comparison

- Initial supported platform is macOS arm64.
- Use packaged production-equivalent builds and ordinary product configuration to disable network-dependent model execution, sync, and updates.
- Fix and verify window size, display scale, color scheme, reduced motion, power source, and relevant launch flags.
- Interleave application order with a recorded balanced seed.
- Compare only matched valid app runs. Independently valid app results remain visible when their counterpart is invalid, but are not presented as a paired comparison.
- An app with a shipped production OpenCode history path should use it and publish `materializationMode: native-opencode`. Otherwise it may use a reviewed translation and publish `materializationMode: translated`. The Claxedo and T3 adapter work must verify which path is actually used rather than infer it from product architecture; the result/site always discloses the mode.

## 11. Target repository layout

```text
bin/
  agent-app-benchmark.mjs
docs/
  driver-protocol.md
  plans/
native/
  resource-monitor/
registry/
  apps/
    t3.json
    claxedo.json
  corpora/
    opencode-completed-transcripts-v1.json
  scenarios/
    app-start-v1.json
    session-switch-v1.json
schemas/
results/
  comparisons/<comparison-id>/comparison.json
src/
  report/
artifacts/
  sites/<comparison-id>/
tests/
```

The current uncommitted local skeleton predates this proposed plan. During implementation it must be reviewed against this layout and either reshaped or replaced file by file; it must not be treated as an already-approved implementation. `artifacts/` is generated and ignored; `results/comparisons/<comparison-id>/comparison.json` is the explicit tracked source for a local site build.

## 12. Implementation plan

### Unit 1 — Establish the clean public repository and minimal contracts

**Standalone files:** `README.md`, `CONTRIBUTING.md`, `LICENSE`, `package.json`, `schemas/scenario-v1.schema.json`, `schemas/corpus-v1.schema.json`, `schemas/opencode-event-v1.schema.json`, `schemas/driver-message-v1.schema.json`, `schemas/result-v1.schema.json`, `schemas/comparison-v1.schema.json`, `src/contracts.mjs`, `src/json-schema.mjs`, `tests/contracts/*`.

**Work:**

- Create a clean repository history rather than publishing the entire T3 commit, which contains app-specific and unrelated changes.
- Define versioned, strict schemas for the two scenarios, raw actions, resource windows, app/source-event/materialization identities, custom/public status, and comparison provenance.
- Make protocol and JSON Schema parity one canonical implementation.
- Use JSON Schema Draft 2020-12 as the language-neutral authority and pinned Ajv 8 for Node runtime validation; keep cross-record/digest/process invariants as focused JavaScript checks.
- Document trusted-driver security and public CI boundaries.
- Bound manifest, corpus, and trace sizes; canonicalize all paths beneath a runner-owned directory; reject symlink escapes; stream large trace parsing; enforce per-stage timeouts; and verify hashes before parsing external bytes.
- Add fixtures proving unknown fields, unsupported versions, missing digests, and pre-aggregated driver metrics are rejected.

**Acceptance:** T3 and Claxedo can both parse the same protocol fixtures without importing each other's code; no capability-profile/prose-detection/streaming/terminal fields remain; malicious paths, symlinks, oversized inputs, and decompression/parser exhaustion fixtures fail safely.

### Unit 2 — Build the immutable public registry and exact canonical corpus

**Standalone files:** `registry/scenarios/app-start-v1.json`, `registry/scenarios/session-switch-v1.json`, `registry/corpora/opencode-completed-transcripts-v1.json`, `registry/apps/t3.json`, `registry/apps/claxedo.json`, `src/registry.mjs`, `src/corpus.mjs`, `tests/registry/*`, `tests/corpus/*`.

**Work:**

- Add the exact lifecycle and report definitions from Sections 5–7.
- Replace the old graded turn/weight corpus with deterministic streamed OpenCode `EventV2.SerializedEvent` NDJSON containing one 1 MiB control session and four distinct lane targets at every 1/2/4/8/16/32 MiB size.
- Pin the allowed durable OpenCode event types/versions, deterministic IDs/sequences/timestamps, workspace/session binding, completed assistant state, and event-schema digest.
- Verify exact final text byte counts, event ordering/types, stable event/corpus digests, the 25-session topology, and privacy inside the framework.
- Define the driver materialization attestation and canonical-to-native session mapping without presenting either as independent proof of app-native correctness.
- Label unregistered local manifests `custom/non-comparable` regardless of reused IDs.

**Acceptance:** Repeated streaming OpenCode-event generation is byte-for-byte deterministic with bounded peak memory; every lane target at all six sizes equals its declared final-text byte count; all event/logical IDs are globally unique; unknown event versions/types or invalid sequence/order fail; changing one semantic input changes the digest; a custom file cannot impersonate a merged public scenario; structurally different T3 and Claxedo native mappings may attest to the same event/corpus digests.

### Unit 3 — Extract the driver runtime and conformance suite

**Standalone files:** `src/driver-process.mjs`, `src/conformance.mjs`, `bin/agent-app-benchmark.mjs`, `docs/driver-protocol.md`, `examples/mock-driver/*`, `tests/driver/*`, `tests/conformance/*`.

**Work:**

- Extract the useful NDJSON lifecycle from T3 and simplify it to `hello`, `prepare`, `launch`, `execute`, and `shutdown`.
- Support an explicit executable plus argument vector for Node, Bun, or compiled drivers.
- Pass the pinned source-event format/schema and materialization mode through `hello`, `prepare`, raw results, compatibility checks, and conformance; reject mismatched source-event schemas.
- Make application-state snapshots driver-owned: `prepare` creates/seals opaque P0/P1 handles and declares state roots; each attempt asks the driver to clone/restore a handle into its run directory; failed initialization invalidates and cleans that handle.
- Distribute the CLI/protocol/schema bundle as a checksummed GitHub release archive pinned by both app repositories; npm publication remains optional.
- Enforce request IDs, sequencing, timeouts, one response per request, stderr capture, protocol violations, crash handling, and exact cleanup.
- Spawn drivers/apps with an explicit environment allowlist, runner-owned working directories, and opt-in app-specific variables; do not inherit or serialize unrelated credentials.
- Make the mock driver exercise success, wrong content, timeout, crash, survivor, and malformed receipt paths.

**Acceptance:** The runner never accepts a duration without its required semantic receipt, never synthesizes missing lifecycle events, and always preserves failed attempts. An out-of-registry example scenario runs end to end through the public CLI and mock driver, generates a report labeled `custom/non-comparable`, and cannot enter the public comparison registry without an exact merged digest.

### Unit 4 — Extract and strengthen whole-process resource measurement

**Standalone files:** `native/resource-monitor/Cargo.toml`, `native/resource-monitor/src/*`, `src/process-metrics.mjs`, `tests/process-metrics/*`.

**Source baseline:** T3 `native/resource-monitor` and `scripts/lib/agent-app-benchmark/process-metrics.ts`, plus the resource telemetry contract currently under T3 `packages/contracts`.

**Work:**

- Move the monitor protocol into the standalone repository so the sidecar has no T3 contract dependency.
- Preserve PID/start-time identity, descendants, cumulative CPU time, RSS, cadence, and process classification.
- Add framework-owned pre/post action snapshots and exact idle/active window tagging for driver-declared app-owned roots and their descendants.
- Validate cadence completeness and surface partial telemetry without corrupting valid latency results.

**Acceptance:** Tests cover PID reuse, declared child appearance/exit, observed unclassified processes inside the declared family, monitor death, cadence gaps, sub-250 ms actions, resource-only invalidation, and survivor detection.

### Unit 5 — Implement execution, statistics, comparisons, and the local website

**Standalone files:** `src/runner.*`, `src/schedule.*`, `src/statistics.*`, `src/report/model.*`, `src/report/html.*`, `src/report/site.*`, `src/comparison.*`, `bin/agent-app-benchmark.*`, `tests/runner/*`, `tests/statistics/*`, `tests/report/*`, `tests/comparison/*`, `tests/report-site/*`.

**Work:**

- Execute individual raw launch/switch attempts rather than one driver-supplied aggregate.
- Implement P0/P1 app-start cloning and isolated cold/warm switch preparation.
- Implement recorded seeded counterbalancing for isolated latency and fixed progressive ordering for the resource workload.
- Derive arithmetic average, maximum, and nearest-rank p95 in one shared statistics path.
- Generate the exact static HTML tables/charts in Section 9 from one shared report model derived from raw bundles only.
- Add a paired multi-app command that interleaves T3 and Claxedo on the same machine.
- Add `site build` from `results/comparisons/<comparison-id>/comparison.json`, with stable per-app routes, per-metric validity, accessible table/chart equivalents, escaped HTML/SVG/URLs, local CSS, deterministic inline SVG, recoverable generated-directory replacement, and no external runtime dependency.
- Group and compare by app identity; display source-event schema and materialization provenance and never hide whether an app used its native OpenCode history path or a translation.

**Acceptance:** Recomputing a report model from the same raw bundle is deterministic; edited aggregate values are ignored/rejected. Golden site fixtures produce a byte-stable index and exactly one stable page per listed app; every link resolves; direct app pages work; metric definitions/origins and section-level validity are visible; incompatible results are unpaired only for the affected family; malicious IDs/text/links/SVG labels are safe; keyboard, screen-reader, narrow-screen, and 200%-zoom fixtures remain understandable; regeneration leaves no stale pages; and generated HTML has no external URL or browser-side statistics implementation.

### Unit 6 — Migrate the T3 adapter

**T3 files retained/adapted:** `scripts/lib/agent-app-benchmark/drivers/t3.ts`, `scripts/lib/agent-app-benchmark/drivers/t3-materializer.ts`, `scripts/lib/projection-fixture.ts`, their focused tests, and the T3 package script/README entrypoint.

**T3 generic files removed after passing migration:** old framework contracts, corpus, runner, statistics, report, privacy, JSON-schema, process-metrics, CLI, duplicated public schemas/examples/corpus, and native monitor copies.

**Work:**

- Consume the public driver protocol package or pinned source release.
- Implement the trusted canonical-corpus-to-T3-native-events mapping, materialization attestation, canonical-to-native session map, and the two scenario lifecycles.
- Consume the pinned OpenCode event stream. Use T3's production OpenCode history-ingestion path if implementation proves one exists; otherwise retain an app-owned reviewed translation and publish `materializationMode: translated`.
- Strengthen app-start readiness from “row/input exists” to the same canonical anchor-content paint and trusted-input endpoint used by Claxedo.
- Return raw switch receipts and owned process identities, never aggregate p95.
- Point T3's benchmark command at the standalone runner.

**Acceptance:** The packaged T3 app passes public conformance and app-owned native-store integration tests for the canonical digest/session mapping, smoke runs both scenarios through the public CLI, and repository search proves no second generic benchmark implementation remains. These tests validate the adapter but are not described as independent proof against a dishonest driver.

### Unit 7 — Migrate the Claxedo adapter

**Claxedo files retained/adapted:** `packages/claxedo-app/perf-harness/src/agent-claxedo-driver.ts`, `agent-claxedo-launcher.ts`, `agent-corpus-materializer.ts`, `agent-browser-observer.ts`, `agent-driver-runtime.ts`, and their focused tests.

**Claxedo paths removed after passing migration:** duplicated public agent-driver contract, generic runner/statistics/report/corpus policy, and obsolete capability-profile mapping. Streaming, terminal, fake-engine, and other product-local performance harness paths remain intact but stay outside the public V1 registry.

**Work:**

- Consume the same public protocol and advertise only the two supported public V1 scenarios.
- Convert the current warm-switch pre-aggregated p95 into one raw observation per switch.
- Implement the trusted canonical-corpus-to-Claxedo/OpenCode-storage mapping, materialization attestation, canonical-to-native session map, P0/P1 launch semantics, isolated cold/warm preparation, and process ownership receipts.
- Verify whether Claxedo exposes an ordinary shipped production OpenCode-backed history boundary. Use it and publish `materializationMode: native-opencode` when it does; otherwise use a reviewed app-owned translation and publish `materializationMode: translated`. Benchmark-only direct projection shortcuts do not qualify.
- Point Claxedo's benchmark entrypoint at the standalone runner while retaining Bun as the explicit driver executable.

**Acceptance:** The packaged Claxedo app passes the same conformance fixtures, app-owned native-store integration tests for the canonical digest/session mapping, and smoke scenarios as T3; no duplicated public contract can drift inside Claxedo. These tests validate the adapter but are not described as independent proof against a dishonest driver.

### Unit 8 — Public validation, publication, and first comparison

**Standalone files:** `.github/workflows/validate.yml`, `.github/workflows/result-pr.yml`, contribution templates, `results/README.md`, initial release/index files.

**Work:**

- Validate definitions, deterministic corpus generation, schemas, mock-driver conformance, raw-result integrity, report recomputation, digests, provenance, and privacy in pull requests.
- Validate proposed metric definitions/versioning and reject incompatible app/source-event-schema/scenario comparisons.
- Do not execute contributor-supplied drivers in public CI.
- Run fork pull-request validation with read-only contents permission, no secrets or release credentials, no `pull_request_target`, and third-party actions pinned by full commit SHA. Protect registry, schemas, workflows, and result indexes with required owner review.
- Create the public `kyashrathore/agent-app-benchmark` repository only after this plan is approved and the local tree is reviewed.
- Run full conformance and smoke checks for both packaged apps.
- Perform the first same-machine macOS arm64 comparison using the pinned environment and interleaved schedule.
- Publish compact result metadata and bounded compressed V1 raw traces in Git; defer release-asset infrastructure until real artifact size requires it.

**Acceptance:** A clean checkout can validate the public registry and recompute the initial report; the first comparison identifies exact framework/scenario/corpus/app/driver revisions and contains no unpaired cross-machine ranking.

## 13. Verification matrix

| Area | Positive verification | Negative/recovery verification |
|---|---|---|
| Schemas | All canonical fixtures round-trip and JSON Schema agrees with runtime validation. | Unknown versions/fields, missing digests, aggregate-only driver values, and illegal scenario IDs fail. |
| Corpus | Exact canonical sizes, 25-session topology, stable digest, and globally unique logical IDs. | One-byte generator drift, missing logical session, wrong benchmark role, or duplicate ID fails before a driver starts. App-native fidelity remains driver-attested and app-tested. |
| Driver | Correct lifecycle, receipts, process roots, clean shutdown. | Out-of-order response, timeout, crash, wrong content, untrusted input, and survivor remain visible and invalid. |
| App start | Fresh P0 and initialized P1 clone per attempt reach the identical endpoint. | Reused mutable application state, existing process, incomplete anchor paint, or failed shutdown invalidates. |
| Session switch | All four lanes and six exact sizes emit raw actions. | Previously activated “cold” destination or warm destination without exactly one warmup invalidates. |
| Resources | Driver-declared roots and descendants, baseline/active/ending windows, boundary CPU snapshots. | PID reuse, observed unclassified family process, monitor gap/death, or missing bracket invalidates only affected resource results. |
| Statistics | Average, maximum, nearest-rank p95 match fixed fixtures. | Empty/insufficient valid sample sets do not produce a headline metric. |
| Reports | Exact tables/charts regenerate deterministically from raw input. | Hand-edited summaries, omitted failures, or mismatched raw hash fail CI. |
| Comparison | Same-host interleaved paired samples and disclosed environment. | Cross-host or incompatible digest results remain standalone and are never paired. |
| Migration | T3 and Claxedo pass the public entrypoint. | Repository searches catch leftover duplicate generic framework paths. |

## 14. Requirements traceability

| Requirement | Plan coverage |
|---|---|
| Start with only app start and session switching | Sections 2, 5, 6; Units 1–2. |
| Make app-start meanings exact | Section 5; Units 2, 5–7. |
| Four separate switch tables | Sections 6 and 9; Unit 5. |
| No size buckets/session list | Sections 2, 6, 9; report golden tests. |
| CPU and memory growth charts | Section 7; Units 4–5. |
| Memory “active” is the progressing historical-chat switch workload | Section 7.2; scenario manifest and window tests. |
| Memory not split by start/workspace | Sections 7 and 9; report golden tests. |
| User can add scenarios | Sections 4 and 10.1; Units 1–2, 8. |
| Public definitions/results require PR | Section 10; Unit 8. |
| T3 and Claxedo are the base apps | Sections 3 and 10.5; Units 6–8. |
| One public framework, app-owned drivers | Section 3; migration acceptance checks. |
| Local comparison website and one page per app | Section 9.3; Unit 5 site fixtures and navigation checks. |
| Same seed across different app event structures | Sections 3.3 and 6.2; Unit 2 canonical corpus and driver-attestation contract. |
| Multi-harness coding-agent GUI target | Sections 1, 2, 3.3, and 8; V1 explicitly measures completed-session GUI performance rather than harness execution. |
| OpenCode event-format V1 corpus | Sections 3.3 and 6.2; Units 1–3 and adapter integration tests. |
| GUI-toolkit neutrality beyond Electron | Sections 8 and 10.2; non-Electron mock driver conformance. |
| Additional metrics proposed by PR | Section 10.3; scenario metric-definition/versioning fixtures. |

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| T3 and Claxedo claim different readiness endpoints. | Public endpoint receipts, canonical anchor identity, shared conformance fixtures, and app-specific integration tests. |
| “Cold” or “warm” state drifts across repetitions. | Immutable P0/P1 snapshots, fresh processes for isolated samples, and exactly one warmup activation. |
| Ascending sizes conflate size with cache/thermal order. | Counterbalanced isolated latency schedule; ascending order is reserved for the explicitly cumulative resource trend. |
| Fast switches have no 250 ms interior tick. | Pre/post cumulative CPU snapshots and post-ready RSS; continuous ticks remain for workload-level distributions. |
| Transcript size differs by storage encoding. | The benchmark compares canonical logical UTF-8 bytes, never native row/event bytes; the driver publicly attests to its mapping. |
| A driver implements an unfair mapping or readiness endpoint. | Treat the driver as an explicit trusted boundary, pin its public source/commit/build and maintainer attestation, review it before public eligibility, and never claim DOM/read-back as independent proof. |
| Application helper processes are omitted or double-counted. | PID/start-time family ownership, declared-root/unclassified-helper invalidation, and explicit summed-RSS disclosure independent of GUI toolkit. |
| Public registry accepts a local look-alike scenario. | Eligibility is based on exact merged digest, not claimed ID. |
| Community drivers execute unsafe code in CI. | Public CI never runs arbitrary contributor executables; it validates definitions and artifacts only. |
| Framework remains duplicated after migration. | Remove old generic paths only after each adapter passes; repository search is an acceptance criterion. |
| Existing dirty worktrees or the uncommitted skeleton are overwritten. | Use clean isolated worktrees/branches, preserve unrelated user changes, and review every extraction against the proposed plan after approval. |

## 16. Decisions fixed by this plan

- “Publish to the corpus” becomes two explicit PR flows: public scenario/corpus definitions and public result submissions.
- Public comparisons accept community and maintainer results with provenance labels, but pair only same-run/same-machine artifacts.
- Initial comparison support is macOS arm64; schemas remain portable without implying cross-platform equivalence.
- Publication uses 20 app-start observations per case and 20 session-switch observations per `(lane, transcript size)`; quick uses 5 and smoke uses 3 on the same dimensions.
- Latency size trends come from isolated counterbalanced runs; the ascending 1–32 MiB pass is the resource accumulation workload.
- App adapters stay in their application repositories.
- Public result summaries use arithmetic average, maximum, and nearest-rank p95.
- The benchmark has no composite score.
- V1 uses pinned OpenCode durable-event input; the benchmark owns event/corpus identity and policy, while app drivers own and attest to native harness/storage materialization.
- Each result identifies one GUI app, the pinned OpenCode source-event schema, and the disclosed native-or-translated materialization mode. V1 does not benchmark harness execution; later scenario versions may add terminal-agent surfaces.
- T3 and Claxedo are initial Electron subjects, not a framework restriction.
- Additional public metrics enter through pull requests that create a new immutable scenario version.
- The local website is generated from one explicit comparison manifest and shared report model, with a comparison index plus one stable page per listed app.

## 17. Completion criteria

V1 is complete only when:

1. The standalone public repository contains one canonical framework and the two immutable scenarios.
2. Exact corpus generation and all framework/conformance tests pass from a clean checkout.
3. Packaged T3 and Claxedo both pass the same public driver conformance suite.
4. Both apps complete smoke runs through the public CLI using real app storage and UI endpoints.
5. The generated report has the exact requested tables/charts and recomputes from raw data.
6. A locally generated static website shows the compatible comparison on its home page and produces one directly navigable page for every listed app, with all values derived from the same report model.
7. Old generic benchmark implementations are removed from T3 and Claxedo without removing unrelated product performance tooling.
8. Public PR checks reject non-reproducible definitions and hand-edited or digest-mismatched results.
9. The first same-machine paired T3/Claxedo result is published with complete environment, validity, provenance, canonical corpus digest, and exact trusted-driver identities.
10. A third-party-style custom manifest completes an end-to-end local mock-driver run, is labeled `custom/non-comparable`, and is rejected from public comparison until its exact definition digest is merged.
11. A non-Electron mock GUI driver passes the same protocol/resource conformance, proving the framework contract does not require Electron.
12. The public site identifies each app/source-event-schema/materialization combination and states that V1 excludes Web Vitals and embedded terminal/live-agent workloads.
