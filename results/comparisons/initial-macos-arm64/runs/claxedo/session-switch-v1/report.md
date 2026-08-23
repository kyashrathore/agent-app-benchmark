# Claxedo: session-switch-v1

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v1` (schema `40c0eefcafd0738fec89df06d8b6cf268e8accd5431f252ddf5b5d599293eb13`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `0dec6160e946b6f37faf009c2211ce39666a7806de2a6039003bba2bfabd030f`
- Corpus digest: `979d15dfeb87f2c539b39915c7324470a54f431a23c668f10ef484ab194b9e5e`
- Run profile: `publication`
- Repetitions per case: `2`

## Session switching

### Warm session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 30.4 | 30.4 | 30.4 | 2 / 2 |

### Cold session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 105.8 | 106.2 | 106.2 | 2 / 2 |

### Warm session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 29.9 | 30.2 | 30.2 | 2 / 2 |

### Cold session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 193.6 | 197.2 | 197.2 | 2 / 2 |

Cold means the destination has never been active in the measured app process. Warm means exactly one valid activation occurred before the measured revisit. Transcript size is final completed UTF-8 text payload bytes, not database or event-envelope bytes.

## Memory consumption

Active means the progressive session-switch workload in which completed chat transcripts move from exactly 1 MiB through 32 MiB. No session stream or live agent is running.

| Metric | Summed process-family RSS (MiB) | Description |
|---|---:|---|
| Baseline idle average | 875.0 | Average during 5 seconds on the fixed 1 MiB control transcript before switching. |
| Active average | 1074.7 | Average of 250 ms samples during the full progressive switch workload. |
| Active maximum | 1330.1 | Largest sample during the active workload. |
| Active p95 | 1330.1 | Nearest-rank p95 across active samples. |
| Ending idle average | 1354.1 | Average during 5 seconds after returning to the same 1 MiB control transcript. |
| Retained RSS growth | 479.1 | Ending idle average minus baseline idle average; negative values remain visible. |

CPU growth and memory growth use the preserved per-switch boundary points in `result.json`.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
