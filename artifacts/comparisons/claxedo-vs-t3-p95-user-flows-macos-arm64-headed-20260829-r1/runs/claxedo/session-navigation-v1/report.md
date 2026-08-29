# Claxedo: session-navigation-v1

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v2` (schema `f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `ea698c53da6488acfad3248885fc173faad0b565843f5a758df2e57b3cd96fea`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Run profile: `publication`
- Configured repetitions: `5`

## Session navigation by history size

| History size | First visit p50 (ms) | First visit p95 (ms) | Return to visited session p50 (ms) | Return p95 (ms) | Valid first / return |
|---:|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 72.9 | 113.2 | 31.1 | 32.7 | 5 / 5 / 5 / 5 |
| 8 MiB (8388608 bytes) | 72.3 | 73.1 | 31.1 | 33.1 | 5 / 5 / 5 / 5 |
| 32 MiB (33554432 bytes) | 73.3 | 73.6 | 31.2 | 32.4 | 5 / 5 / 5 / 5 |
| 128 MiB (134217728 bytes) | 74.3 | 80.1 | 31.6 | 33.5 | 5 / 5 / 5 / 5 |

The workspace panel is closed. Every row times only the trusted session activation. First visit means the destination has not previously been displayed in that process; return means that same destination was displayed once and revisited after returning to control.

## Return to a visited session with the workspace panel already open

| Seeded panel load | Duration p50 (ms) | Duration p95 (ms) | Session ready avg (ms) | Panel ready avg (ms) | Worst frame max (ms) | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| light | — | — | — | — | — | — | — | — | 0 / 5 |
| moderate | — | — | — | — | — | — | — | — | 0 / 5 |
| heavy | — | — | — | — | — | — | — | — | 0 / 5 |

The panel load is established before timing. Session and panel readiness are observed concurrently; the endpoint is the later complete painted and input-ready state. Review readiness preserves all 24 canonical files and exact logical expansion state; only currently materialized viewport bodies must be painted because offscreen content may remain virtualized.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
