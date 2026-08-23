# T3 Code: app-start-v1

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v1` (schema `40c0eefcafd0738fec89df06d8b6cf268e8accd5431f252ddf5b5d599293eb13`)
- Materialization: **translated** (driver-attested)
- Scenario digest: `09928dfb8ca4182c947c70d70bd9cf07454d2da670b1de5e265db256da26f4d0`
- Corpus digest: `979d15dfeb87f2c539b39915c7324470a54f431a23c668f10ef484ab194b9e5e`
- Run profile: `smoke`

## Application start

| Application state | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |
|---|---:|---:|---:|---:|
| First launch — new application state | 3385.8 | 3753.5 | 3753.5 | 3 / 3 |
| Repeat launch — initialized application state | 2923.2 | 3589.2 | 3589.2 | 3 / 3 |

Both rows launch a new process and end at the same endpoint: the 1 MiB anchor transcript is correct and painted across two presentation opportunities, and the composer accepts trusted input. The repeat row uses a cloned state snapshot that completed exactly one earlier unmeasured launch and clean shutdown.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
