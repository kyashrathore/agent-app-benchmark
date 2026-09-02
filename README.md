# Agent App Benchmark

Agent App Benchmark is a public, reproducible performance benchmark for multi-harness coding-agent GUI applications. The current V3 scenarios measure GUI handling of completed historical coding sessions; they do not run or compare the coding-agent harness itself.

The first registered applications are [T3 Code](https://github.com/pingdotgg/t3code) and [Claxedo](https://github.com/kyashrathore/Claxedo). Both happen to use Electron. Electron is not a requirement: native, Tauri, Flutter, Qt, browser-based, and other GUI applications are welcome.

## Current scenarios

### Application start

- **First launch — new application state:** a new app process uses a cloned prepared state that the application has never launched with.
- **Repeat launch — initialized application state:** a new app process uses a cloned state that completed exactly one earlier unmeasured launch to the same endpoint and then shut down cleanly.
- Both begin immediately before process spawn and end when the fixed 1 MiB anchor transcript is correct and painted across two presentation opportunities and the composer accepts trusted input.

Repeat launch is not an existing hidden process, a background-window focus, or a renderer-only reload.

### Session switching

Four lanes are reported independently:

- cold destination within the same workspace;
- warm destination within the same workspace;
- cold destination across workspaces;
- warm destination across workspaces.

Cold means the unique destination has never become active in that measured app process. Warm means that destination is activated once to readiness, the driver returns to control, and the revisit is measured. Each configured repetition starts one stabilized process and measures 10 unique 1 MiB destinations per lane, so the default two repetitions provide 20 observations per lane without 40 application launches. Nearest-rank p95 is reported for every distributional comparison at any valid observation count, always beside its valid / attempted counts. Below 20 valid observations the nearest-rank 95th value is the sampled maximum of those observations; the report says so on the value instead of withholding it or relabelling it as p50. Average, sampled maximum, and p50 remain available as diagnostic drill-down. A separate within-workspace/cold size sweep measures 1, 8, 32, and 128 MiB in a counterbalanced order; it is not derived from the ascending memory workload.

### Memory and CPU

Memory is one app-level result—not split by app start or workspace relation.

- **Baseline idle:** the configured idle window with the ready 1 MiB control session visible and no benchmark input.
- **Active:** the deterministic session-switch workload progresses completed historical sessions from 1 MiB through 128 MiB.
- **Ending idle:** the configured idle window after returning to the same ready 1 MiB control session.

The complete memory workload runs once in a fresh process per configured repetition. The persisted `result.resources` contract records baseline idle average, active average/sampled-maximum/p95, ending idle average, and retained RSS growth. The generated comparison report presents the full nearest-rank p95 inventory derived from the same preserved raw trace: baseline-idle p95 RSS, active-workload p95 RSS, active sampled-maximum RSS as an explicit diagnostic, ending-idle p95 RSS, retained RSS growth as ending-idle p95 minus baseline-idle p95, p95 RSS and p95 process-family CPU after each 1/8/32/128 MiB step, and baseline/active/ending p95 process-family CPU. It discloses observed sample cadence, observed window durations, raw sample counts, per-window sample counts, the process-family definition and observed members, missing-process evidence, the CPU definition, and host memory-pressure and power metadata. A window that lost the declared root process or recorded no sample stays Invalid with its reason and is never scored as zero. “Maximum” is the largest observed 250 ms RSS sample, not an operating-system true peak. CPU and memory growth charts average matching boundaries across resource runs. RSS is summed across the driver-declared application process family. CPU percentage uses sampled cumulative CPU-time deltas for every descendant observed inside the boundary; new descendants count from process birth and exiting descendants count through their final sample. Unobserved work after that final sample is not estimated. 100% means one fully occupied logical core.

No live session stream, model call, agent run, or terminal activity occurs during these measurements.

### Workspace panel

`session-navigation-v1` is the primary user-facing navigation scenario. It reports two trends and times only a session-row activation:

- **History-size trend:** first visit and return to that previously visited session with the panel closed, at 1, 8, 32, and 128 MiB. The destination is displayed exactly once by the measured first visit; only navigation back to control is untimed before the paired return.
- **Already-open-panel trend:** return to a previously visited fixed 1 MiB session with the panel left open in explicit light, moderate, and heavy seeded UI states.

The already-open-panel endpoint is the later of session readiness and panel readiness. Panel setup is outside the clock. Reports use nearest-rank p95 as the primary value, keep p50 in the diagnostic drill-down, and contain no cold/warm matrix.

All `session-navigation-v1` and `workspace-panel-v2` action clocks begin at the trusted `pointerdown` timestamp. Drivers attest both the timestamp and event type; `click` or a later application mark is invalid.

`workspace-panel-v2` independently measures ordinary user actions: open, close, Files → Review, Review → Files, open file, switch file tab, expand all, and collapse all. Every action is plotted across the same explicit panel loads:

| Load | Expanded directories | Retained file tabs | Expanded Review files |
|---|---:|---:|---:|
| Light | 2 | 2 | 1 |
| Moderate | 8 | 3 | 6 |
| Heavy | 16 | 4 | 24 |

Review always owns all 24 canonical changed files and their complete, non-truncated authoritative data; the load varies retained logical UI state, not data completeness. Production virtualization is allowed: exact logical expansion counts are required, while only Review bodies currently materialized in the canonical viewport must be painted and interactive. Untimed setup may scan or scroll the real surface to attest all identities and restore the required start position. For `open-file`, setup loads the exact target bytes through the application's production file-data path without ever mounting that target's tab or preview; the measured pointerdown owns first surface creation and paint. Opening records shell visibility and animation separately from data readiness, above-fold paint, and interactive readiness. There are no interrupted or double-toggle cases.

The following V1 scenarios remain immutable for already-published results but are superseded for new comparisons:

`workspace-panel-v1` measures one trusted action at a time against a deterministic substantial workspace: cold-surface opening, both directions of a toggle pair, warm-data/cold-surface reopening, surface navigation, opening a file, switching an already open file tab, diff view mode, and collapse/expand all. A toggle pair is an interrupted reversal for an animated panel and an immediate double-toggle for a non-animated inline panel. Opening reports shell animation separately from data-ready-to-paint and data-ready-to-interactive. All content interactions begin after loaded state has settled.

`session-switch-workspace-panel-v1` repeats the four cold/warm and within/across session-switch lanes with the panel closed, with Files open, and with Diff open. Within each lane the three profiles stay adjacent and rotate through every schedule position across repetitions. Files-minus-closed and Diff-minus-closed penalties are derived from matched valid observations. Both scenarios preserve raw per-action renderer milestones, frame timestamps, long-animation-frame script attribution, exact-interval counter timestamps, and task/script/style/layout work; the framework, not the driver, derives every summary and report row. The public workspace manifest fixes every path, file revision, diff hunk, and initial open tab and is driver-attested after materialization.

## Canonical corpus

Every app receives the same deterministic `opencode-completed-sessions-v3` directory. It contains one NDJSON file per logical session using the pinned OpenCode `EventV2.SerializedEvent` envelope and these durable event types:

- `session.created.1`
- `message.updated.1`
- `message.part.updated.1`

The source baseline is OpenCode revision `a9f7081d4015b0cc22ed67156e042b482a8d064a`. Payload size counts UTF-8 bytes in completed text, reasoning, serialized tool input, and tool output. It excludes IDs, event envelopes, indexes, database encoding, and storage overhead.

V3 uses rounded structural distributions derived from local OpenCode, Claude Code, and Codex histories, including the long-session tail. Only counts and byte-length distributions were used. The committed shape is rounded, and every emitted prompt, response, reasoning block, tool input, tool output, path, patch, title, timestamp, and identifier is synthetic. No original session text, code, command, repository name, path, URL, or identifier is copied into the corpus. Generation and verification also reject common home-path, email, and secret patterns. Payload parts use deterministic heavy-tailed sizes and varied code/log/JSON-like content rather than equal uniform chunks.

The 53-session corpus has separate destinations for the four latency pools, the counterbalanced size sweep, and the progressive memory workload. It contains 574,619,648 measured payload bytes and 219,073 durable events. The largest individual histories are 128 MiB with 4,400 messages, 12,000 completed tool calls, and 1,000 patch records.

An application with a shipped production OpenCode history path should use it and report `native-opencode`. Other apps may translate the canonical event stream through their ordinary production history path and report `translated`. The website discloses the mode. Drivers are trusted adapters: app-owned tests and review catch mistakes, but the framework does not pretend DOM readback proves driver honesty.

## Non-goals

V3 does not measure Web Vitals (LCP, INP, CLS, FCP, or TTFB), streaming output, live agent or model execution, embedded terminal coding agents, or a composite score. It does include completed historical text, reasoning, tool, and patch records because those are ordinary session-GUI load.

## Install and validate

Requirements: Node.js 22 or newer and Rust 1.88 or newer.

```bash
npm ci
npm test
npm run lint
npm run validate
cargo test --manifest-path native/resource-monitor/Cargo.toml
cargo build --release --manifest-path native/resource-monitor/Cargo.toml
```

Generate and verify the public corpus:

```bash
node bin/agent-app-benchmark.mjs corpus generate \
  --corpus opencode-completed-sessions-v3 \
  --output artifacts/corpora/opencode-completed-sessions-v3

node bin/agent-app-benchmark.mjs corpus verify \
  --input artifacts/corpora/opencode-completed-sessions-v3
```

Run an app-owned driver after it advertises V3 support:

```bash
node bin/agent-app-benchmark.mjs run \
  --driver /absolute/path/to/driver-executable \
  --driver-arg optional-driver-argument \
  --app t3 \
  --scenario session-switch-v3 \
  --run-profile smoke \
  --repetitions 2 \
  --resource-monitor native/resource-monitor/target/release/agent-app-resource-monitor \
  --comparison-run-id my-same-machine-run \
  --output artifacts/runs/t3-session-switch
```

### One-liner single-app / CI run (no JSON config)

For Claxedo or T3 without writing a comparison config, use the friendly `run` entry. It resolves the app-owned driver from `CLAXEDO_ROOT` / `T3_ROOT` (defaults `../opencode` and `../t3code`), picks up `CLAXEDO_BENCHMARK_EXECUTABLE` / `T3_BENCHMARK_EXECUTABLE`, and writes `result.json` + `report.md` under `--out`:

```bash
export CLAXEDO_BENCHMARK_EXECUTABLE="/absolute/path/to/Claxedo Dev.app/Contents/MacOS/Claxedo Dev"

# CI / local smoke for one scenario:
npx agentappbench run --app claxedo --scenario session-switch-v3 --run-profile smoke

# Multiple scenarios (comma-separated or repeatable --scenario):
npx agentappbench run --app t3 --scenarios app-start-v3,session-switch-v3 --run-profile quick --out artifacts/runs/t3-quick

# Print the resolved binding without launching apps:
npx agentappbench run --app claxedo --scenario session-switch-v3 --dry-run
```

Omit `--scenario` / `--scenarios` to run the same user-flow suite as `compare` (`app-start-v3`, `session-switch-v3`, `session-navigation-v1`, `workspace-panel-v2`). `--run-profile smoke|quick|publication` maps to repetition overrides `1|2|5` like compare. Pass `--executable` to override the env binary. Direct `--driver ...` runs keep the low-level path unchanged. Single-app mode does not invent a comparison site; use `compare --site` for paired HTML.

Pass `--corpus-directory` to reuse a previously verified corpus instead of regenerating its roughly 691 MiB NDJSON representation for every scenario.

Maintainers can recompute a private numeric profile without emitting session content:

```bash
node scripts/derive-private-session-profile.mjs \
  --open-code-db /absolute/path/to/opencode.db \
  --claude-root /absolute/path/to/claude/projects \
  --codex-root /absolute/path/to/codex/sessions \
  --samples 48 \
  --output artifacts/private-profile/structural-profile.json
```

The output stays under the ignored `artifacts/` directory. It contains aggregate numbers only and is not part of the public corpus.

The registered profiles provide defaults (`smoke` uses 1; `quick` and `publication` use 2). Pass `--repetitions N` to override the selected profile for a direct run. For session switching, one repetition means one latency process with 10 unique destinations per lane, one counterbalanced size sweep in that process, and one independent memory process. For a paired comparison, set the top-level `"repetitions": N`; the framework applies the same count to every app and records it in every result. The allowed range is 1–100.

For a fair same-machine comparison, use the framework-owned paired runner rather than invoking the four results independently. Copy `examples/comparison-run.example.json`, replace its absolute paths and framework commit, then run with `"scenarioIds": ["app-start-v3", "session-switch-v3"]`.

```bash
node bin/agent-app-benchmark.mjs comparison run \
  --config /absolute/path/to/comparison-run.json
```

### One-liner Claxedo vs T3 compare (macOS headed)

After `npm ci`, building the resource monitor, and generating/verifying the corpus once, the shortest path for the full user-flow suite is the `compare` preset. It writes a comparison config, runs the mirrored schedule, and can build the static site:

```bash
export CLAXEDO_BENCHMARK_EXECUTABLE="/absolute/path/to/Claxedo Dev.app/Contents/MacOS/Claxedo Dev"
export T3_BENCHMARK_EXECUTABLE="/absolute/path/to/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"
export CLAXEDO_ROOT="/absolute/path/to/opencode"   # optional; default ../opencode
export T3_ROOT="/absolute/path/to/t3code"          # optional; default ../t3code

# From a clone of this repo (or later: npx agent-app-benchmark / npx agentappbench):
node bin/agent-app-benchmark.mjs compare \
  --preset claxedo-vs-t3 \
  --run-profile smoke \
  --site
```

Auto-detected when present: `native/resource-monitor/target/release/agent-app-resource-monitor`, `artifacts/corpora/opencode-completed-sessions-v3`, git `HEAD` as `frameworkRevision`, and host label (`macos-arm64-headed` on Apple Silicon). Still required: packaged app binaries plus app-owned drivers under `CLAXEDO_ROOT` / `T3_ROOT`. Use `--dry-run` to write only the config. Use `--run-profile publication` (5 reps) for a publishable run. The low-level `comparison run` / `site build` commands remain unchanged.

It verifies or generates the corpus once, then uses the recorded mirrored order `T3 app-start → Claxedo app-start → Claxedo session-switch → T3 session-switch`. Every result contains the same schedule digest and its own ordinal.

The driver protocol is language-neutral NDJSON, so Node, Bun, native binaries, and other runtimes can implement it. See [docs/driver-protocol.md](docs/driver-protocol.md).

### Assemble a comparison from independent runs

A scheduled `comparison run` seals one interleaved order and cannot take a single application's rerun. When applications come and go, run each one on its own and assemble the comparison afterwards. Each result keeps its own run provenance; pairing requires the same framework revision, scenario, corpus, profile, repetition count, and host identity, and the site discloses that order was not counterbalanced and lists each leg's start time.

```bash
node bin/agent-app-benchmark.mjs run --app opencode --scenarios app-start-v3,session-switch-v3 --run-profile publication --out artifacts/runs/opencode-pub

node bin/agent-app-benchmark.mjs comparison assemble \
  --id claxedo-vs-t3-vs-opencode-macos-arm64-20260902 \
  --title "Claxedo vs T3 Code vs OpenCode" \
  --result artifacts/runs/opencode-pub/app-start-v3/result.json \
  --result artifacts/runs/opencode-pub/session-switch-v3/result.json \
  --result artifacts/comparisons/earlier-run/runs/claxedo/app-start-v3/result.json \
  --result artifacts/comparisons/earlier-run/runs/claxedo/session-switch-v3/result.json \
  --output artifacts/comparisons/claxedo-vs-t3-vs-opencode-macos-arm64-20260902
```

## Local comparison website

The website is generated entirely from an explicit immutable comparison manifest:

```bash
node bin/agent-app-benchmark.mjs site build \
  --comparison results/comparisons/initial-macos-arm64/comparison.json \
  --output artifacts/sites/initial-macos-arm64
```

Result paths are relative to the comparison manifest. A manifest under `results/comparisons/<id>/` may reference sibling content under `results/runs/`, but the loader rejects paths that escape `results/`.

Open `artifacts/sites/initial-macos-arm64/index.html` directly. It has no server, CDN, remote font, runtime fetch, or browser-side metric calculation. The home page compares every listed app and each `/apps/<app-id>/` path contains an individual report.

## Public contribution rule

Custom scenario files run locally but remain `custom/non-comparable`. Publishing a scenario, corpus, application driver registration, result, or new metric requires a pull request. A metric addition creates a new immutable scenario version so older results are never silently recomputed or filled with zero. See [CONTRIBUTING.md](CONTRIBUTING.md).

Public registry, schema, and result paths are append-only in pull requests. Corrections therefore use a new version or run path; CI rejects silent edits and deletions of already published artifacts.
