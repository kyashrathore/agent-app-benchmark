# Agent App Benchmark

A small public benchmark for desktop coding-agent applications. Version 1 deliberately measures only:

1. Application start: fresh-profile and repeat-profile process launches.
2. Session switching: cold/warm destinations within/across workspaces, using completed historical transcripts from 1 MiB through 32 MiB.
3. Whole-process-family CPU and resident memory while the session-switch benchmark runs, plus before/after idle memory.

There are no capability profiles, composite scores, streaming scenarios, terminal scenarios, or prose claims that the runner cannot enforce.

## Public comparison rule

A result is public-comparable only when its scenario and corpus digests match files in [`registry/`](registry/). Custom scenarios can be run locally, but are labeled `custom` and must not be presented as part of the public comparison.

Adding or changing a public scenario/corpus requires a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Canonical scenarios

### `app-start-v1`

- **Fresh-profile start:** launch a new process from a prepared profile that the app has never opened.
- **Repeat-profile start:** launch once without measuring, reach the same ready endpoint, shut down the entire process family, then measure a new process launch from that initialized profile.
- Timing begins immediately before process spawn and ends when the benchmark landing surface is painted and accepts trusted keyboard input.

### `session-switch-v1`

Four independently reported lanes:

- cold destination, within the same workspace;
- warm destination, within the same workspace;
- cold destination, across workspaces;
- warm destination, across workspaces.

The deterministic transcript sizes are 1, 2, 4, 8, 16, and 32 MiB. A cold destination has not been opened in the current app process. A warm destination was opened earlier in that same process and is revisited. Each lane reports average, maximum, and p95 latency. Raw points power the latency-versus-transcript-size chart.

## Memory and CPU

No live agent or stream runs during resource measurement. The active window is exactly the complete `session-switch-v1` action sequence while completed historical transcripts progress from 1 MiB to 32 MiB.

The complete memory flow is:

```text
launch → load initial 1 MiB session → settle 15 s → baseline idle 60 s
       → run all session switches → settle 15 s → ending idle 60 s → shutdown
```

The public report contains baseline idle RSS, active average/maximum/p95 RSS, ending idle RSS, and retained growth (`ending idle - baseline idle`). It also contains CPU and RSS trend data by switch sequence and transcript size. Resource values cover the declared application root and all attributable descendants; the benchmark driver and monitor are excluded.

## Driver boundary

An app driver is a trusted executable that reads NDJSON requests from stdin and writes only NDJSON responses to stdout. Logs go to stderr. It implements:

```text
hello → prepare → launch → run-case → shutdown
```

The runner owns the public registry, schedules, statistics, process observation, result validation, and report. The driver owns app-specific corpus materialization, launch, semantic paint/input readiness, switching actions, and exact child-process cleanup. See [docs/driver-protocol.md](docs/driver-protocol.md).

## Run locally

```bash
npm test
npm run validate
cargo build --release --manifest-path native/resource-monitor/Cargo.toml
node bin/agent-app-benchmark.mjs run \
  --driver /absolute/path/to/app-driver \
  --app t3 \
  --scenario session-switch-v1 \
  --corpus session-size-ramp-v1 \
  --resource-monitor native/resource-monitor/target/release/agent-app-resource-monitor \
  --run-profile smoke \
  --output artifacts/t3-session-switch
```

T3 and Claxedo are the first registered applications. Their production drivers remain app-owned so that each application materializes data and reaches readiness through its authoritative implementation; integration contracts are documented under [`drivers/`](drivers/).
