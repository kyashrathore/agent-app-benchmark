# Agent App Benchmark

Agent App Benchmark is a public, reproducible performance benchmark for multi-harness coding-agent GUI applications. V1 measures the GUI handling completed historical sessions; it does not run or compare the coding-agent harness itself.

The first registered applications are [T3 Code](https://github.com/pingdotgg/t3code) and [Claxedo](https://github.com/kyashrathore/Claxedo). Both happen to use Electron. Electron is not a requirement: native, Tauri, Flutter, Qt, browser-based, and other GUI applications are welcome.

## V1 scenarios

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

Cold means the destination has not become active in the measured app process. Warm means exactly one valid activation preceded the measured revisit. Every lane uses exact completed transcript sizes of 1, 2, 4, 8, 16, and 32 MiB and reports arithmetic average, maximum, nearest-rank p95, and valid/attempted observations.

### Memory and CPU

Memory is one app-level result—not split by app start or workspace relation.

- **Baseline idle:** 60 seconds with the ready 1 MiB control transcript visible and no benchmark input.
- **Active:** the deterministic session-switch workload progresses completed historical transcripts from 1 MiB through 32 MiB.
- **Ending idle:** 60 seconds after returning to the same ready 1 MiB control transcript.

The memory table contains baseline idle average, active average/maximum/p95, ending idle average, and retained RSS growth. CPU and memory growth charts use per-switch resource boundaries. RSS is summed across the driver-declared application process family. CPU percentage uses sampled cumulative CPU-time deltas for every descendant observed inside the boundary; new descendants count from process birth and exiting descendants count through their final sample. Unobserved work after that final sample is not estimated. 100% means one fully occupied logical core.

No live session stream, model call, agent run, or terminal activity occurs during these measurements.

## Canonical corpus

Every app receives the same deterministic `opencode-completed-transcripts-v1` directory. It streams one NDJSON file per logical session using the pinned OpenCode `EventV2.SerializedEvent` envelope and these durable event types:

- `session.created.1`
- `message.updated.1`
- `message.part.updated.1`

The source baseline is OpenCode revision `a9f7081d4015b0cc22ed67156e042b482a8d064a`. Transcript size counts only UTF-8 bytes in final completed text-part payloads—not IDs, event envelopes, metadata, indexes, database encoding, or storage overhead.

An application with a shipped production OpenCode history path should use it and report `native-opencode`. Other apps may translate the canonical event stream through their ordinary production history path and report `translated`. The website discloses the mode. Drivers are trusted adapters: app-owned tests and review catch mistakes, but the framework does not pretend DOM readback proves driver honesty.

## Non-goals

V1 does not measure Web Vitals (LCP, INP, CLS, FCP, or TTFB), streaming output, live agent or model execution, embedded terminal coding agents, tool/diff/reasoning rendering, or a composite score. Terminal-agent and rich-content work can be added later as separately reviewed scenario versions.

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
  --corpus opencode-completed-transcripts-v1 \
  --output artifacts/corpora/opencode-completed-transcripts-v1

node bin/agent-app-benchmark.mjs corpus verify \
  --input artifacts/corpora/opencode-completed-transcripts-v1
```

Run an app-owned driver:

```bash
node bin/agent-app-benchmark.mjs run \
  --driver /absolute/path/to/driver-executable \
  --driver-arg optional-driver-argument \
  --app t3 \
  --scenario session-switch-v1 \
  --run-profile smoke \
  --resource-monitor native/resource-monitor/target/release/agent-app-resource-monitor \
  --comparison-run-id my-same-machine-run \
  --output artifacts/runs/t3-session-switch
```

Pass `--corpus-directory` to reuse a previously verified corpus instead of regenerating roughly 253 MiB for every scenario.

For a fair same-machine comparison, use the framework-owned paired runner rather than invoking the four results independently. Copy `examples/comparison-run.example.json`, replace its absolute paths and framework commit, then run:

```bash
node bin/agent-app-benchmark.mjs comparison run \
  --config /absolute/path/to/comparison-run.json
```

It verifies or generates the corpus once, then uses the recorded mirrored order `T3 app-start → Claxedo app-start → Claxedo session-switch → T3 session-switch`. Every result contains the same schedule digest and its own ordinal.

The driver protocol is language-neutral NDJSON, so Node, Bun, native binaries, and other runtimes can implement it. See [docs/driver-protocol.md](docs/driver-protocol.md).

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
