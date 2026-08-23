# T3 Code: session-switch-v1

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v1` (schema `40c0eefcafd0738fec89df06d8b6cf268e8accd5431f252ddf5b5d599293eb13`)
- Materialization: **translated** (driver-attested)
- Scenario digest: `3a5d5414b61ca734784402b461b1e910651e220f244ebc4c380dc439d7a369d4`
- Corpus digest: `979d15dfeb87f2c539b39915c7324470a54f431a23c668f10ef484ab194b9e5e`
- Run profile: `smoke`

## Session switching

### Warm session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 79.3 | 112.3 | 112.3 | 3 / 3 |
| 2 MiB (2097152 bytes) | 76.9 | 87.5 | 87.5 | 3 / 3 |
| 4 MiB (4194304 bytes) | 70.6 | 70.8 | 70.8 | 3 / 3 |
| 8 MiB (8388608 bytes) | 70.4 | 71.3 | 71.3 | 3 / 3 |
| 16 MiB (16777216 bytes) | 70.6 | 77.3 | 77.3 | 3 / 3 |
| 32 MiB (33554432 bytes) | — | — | — | 0 / 3 |

### Cold session switch — within the same workspace

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 73.7 | 79.0 | 79.0 | 3 / 3 |
| 2 MiB (2097152 bytes) | 101.5 | 129.4 | 129.4 | 3 / 3 |
| 4 MiB (4194304 bytes) | 86.2 | 96.0 | 96.0 | 3 / 3 |
| 8 MiB (8388608 bytes) | — | — | — | 0 / 3 |
| 16 MiB (16777216 bytes) | 81.8 | 86.8 | 86.8 | 3 / 3 |
| 32 MiB (33554432 bytes) | 82.1 | 87.4 | 87.4 | 3 / 3 |

### Warm session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 89.9 | 139.3 | 139.3 | 3 / 3 |
| 2 MiB (2097152 bytes) | 78.3 | 94.2 | 94.2 | 3 / 3 |
| 4 MiB (4194304 bytes) | 68.4 | 70.8 | 70.8 | 3 / 3 |
| 8 MiB (8388608 bytes) | 70.8 | 71.0 | 71.0 | 3 / 3 |
| 16 MiB (16777216 bytes) | — | — | — | 0 / 3 |
| 32 MiB (33554432 bytes) | — | — | — | 0 / 3 |

### Cold session switch — across workspaces

| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---:|---:|---:|---:|---:|
| 1 MiB (1048576 bytes) | 84.2 | 94.6 | 94.6 | 3 / 3 |
| 2 MiB (2097152 bytes) | — | — | — | 1 / 3 |
| 4 MiB (4194304 bytes) | 79.2 | 80.3 | 80.3 | 3 / 3 |
| 8 MiB (8388608 bytes) | 108.3 | 119.3 | 119.3 | 3 / 3 |
| 16 MiB (16777216 bytes) | 81.5 | 86.9 | 86.9 | 3 / 3 |
| 32 MiB (33554432 bytes) | — | — | — | 0 / 3 |

Cold means the destination has never been active in the measured app process. Warm means exactly one valid activation occurred before the measured revisit. Transcript size is final completed UTF-8 text payload bytes, not database or event-envelope bytes.

## Memory consumption

Resource result unavailable: One or more progressive resource actions were invalid.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
