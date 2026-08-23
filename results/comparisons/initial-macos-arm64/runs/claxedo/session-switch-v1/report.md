# Claxedo: session-switch-v1

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v1` (schema `40c0eefcafd0738fec89df06d8b6cf268e8accd5431f252ddf5b5d599293eb13`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `3a5d5414b61ca734784402b461b1e910651e220f244ebc4c380dc439d7a369d4`
- Corpus digest: `979d15dfeb87f2c539b39915c7324470a54f431a23c668f10ef484ab194b9e5e`
- Run profile: `smoke`

## Session switching

### Warm session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 30.5 | 31.8 | 31.8 | 3 / 3 |
| 2 MiB (2097152 bytes) | 30.2 | 30.4 | 30.4 | 3 / 3 |
| 4 MiB (4194304 bytes) | 36.4 | 43.2 | 43.2 | 3 / 3 |
| 8 MiB (8388608 bytes) | 41.1 | 43.8 | 43.8 | 3 / 3 |
| 16 MiB (16777216 bytes) | 45.9 | 46.5 | 46.5 | 3 / 3 |
| 32 MiB (33554432 bytes) | 62.4 | 63.3 | 63.3 | 3 / 3 |

### Cold session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 115.9 | 121.0 | 121.0 | 3 / 3 |
| 2 MiB (2097152 bytes) | 133.2 | 135.9 | 135.9 | 3 / 3 |
| 4 MiB (4194304 bytes) | 193.1 | 203.3 | 203.3 | 3 / 3 |
| 8 MiB (8388608 bytes) | 299.6 | 306.2 | 306.2 | 3 / 3 |
| 16 MiB (16777216 bytes) | 554.3 | 562.7 | 562.7 | 3 / 3 |
| 32 MiB (33554432 bytes) | 969.7 | 999.1 | 999.1 | 3 / 3 |

### Warm session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 29.6 | 30.2 | 30.2 | 3 / 3 |
| 2 MiB (2097152 bytes) | 30.3 | 32.1 | 32.1 | 3 / 3 |
| 4 MiB (4194304 bytes) | 38.1 | 43.2 | 43.2 | 3 / 3 |
| 8 MiB (8388608 bytes) | 43.8 | 46.6 | 46.6 | 3 / 3 |
| 16 MiB (16777216 bytes) | 49.2 | 55.2 | 55.2 | 3 / 3 |
| 32 MiB (33554432 bytes) | 63.0 | 65.1 | 65.1 | 3 / 3 |

### Cold session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 122.9 | 131.7 | 131.7 | 3 / 3 |
| 2 MiB (2097152 bytes) | 146.0 | 153.4 | 153.4 | 3 / 3 |
| 4 MiB (4194304 bytes) | 214.8 | 219.3 | 219.3 | 3 / 3 |
| 8 MiB (8388608 bytes) | 309.5 | 325.3 | 325.3 | 3 / 3 |
| 16 MiB (16777216 bytes) | 539.7 | 597.3 | 597.3 | 3 / 3 |
| 32 MiB (33554432 bytes) | 996.5 | 1029.6 | 1029.6 | 3 / 3 |

Cold means the destination has never been active in the measured app process. Warm means exactly one valid activation occurred before the measured revisit. Transcript size is final completed UTF-8 text payload bytes, not database or event-envelope bytes.

## Memory consumption

Active means the progressive session-switch workload in which completed chat transcripts move from exactly 1 MiB through 32 MiB. No session stream or live agent is running.

| Metric | Summed process-family RSS (MiB) | Description |
|---|---:|---|
| Baseline idle average | 818.4 | Average during 60 seconds on the fixed 1 MiB control transcript before switching. |
| Active average | 1408.5 | Average of 250 ms samples during the full progressive switch workload. |
| Active maximum | 2221.3 | Largest sample during the active workload. |
| Active p95 | 2107.5 | Nearest-rank p95 across active samples. |
| Ending idle average | 1856.8 | Average during 60 seconds after returning to the same 1 MiB control transcript. |
| Retained RSS growth | 1038.4 | Ending idle average minus baseline idle average; negative values remain visible. |

CPU growth and memory growth use the preserved per-switch boundary points in `result.json`.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
