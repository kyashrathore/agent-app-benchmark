# T3 Code: session-navigation-v1

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v2` (schema `f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac`)
- Materialization: **translated** (driver-attested)
- Scenario digest: `ea698c53da6488acfad3248885fc173faad0b565843f5a758df2e57b3cd96fea`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Run profile: `publication`
- Configured repetitions: `5`

## Session navigation by history size

| History size | First visit p50 (ms) | First visit p95 (ms) | Return to visited session p50 (ms) | Return p95 (ms) | Valid first / return |
|---:|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 217.5 | 242.9 | 232.2 | 233.2 | 5 / 5 / 5 / 5 |
| 8 MiB (8388608 bytes) | 415.1 | 496.9 | 249.4 | 261.6 | 5 / 5 / 5 / 5 |
| 32 MiB (33554432 bytes) | 683.0 | 764.3 | 297.2 | 298.4 | 5 / 5 / 5 / 5 |
| 128 MiB (134217728 bytes) | 1149.9 | 1205.6 | 398.9 | 432.2 | 5 / 5 / 5 / 5 |

The workspace panel is closed. Every row times only the trusted session activation. First visit means the destination has not previously been displayed in that process; return means that same destination was displayed once and revisited after returning to control.

## Return to a visited session with the workspace panel already open

| Seeded panel load | Duration p50 (ms) | Duration p95 (ms) | Session ready avg (ms) | Panel ready avg (ms) | Worst frame max (ms) | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| light | 302.1 | 308.6 | 278.2 | 184.9 | 150.0 | 163.2 | 20.1 | 22.8 | 5 / 5 |
| moderate | 308.5 | 318.6 | 284.3 | 191.9 | 183.1 | 173.9 | 20.5 | 23.9 | 5 / 5 |
| heavy | 298.0 | 315.9 | 279.1 | 186.9 | 166.6 | 166.6 | 21.2 | 22.3 | 5 / 5 |

The panel load is established before timing. Session and panel readiness are observed concurrently; the endpoint is the later complete painted and input-ready state. Review readiness preserves all 24 canonical files and exact logical expansion state; only currently materialized viewport bodies must be painted because offscreen content may remain virtualized.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
