# Claxedo: workspace-panel-v2

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v2` (schema `f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac`)
- Materialization: **native-opencode** (driver-attested)
- Scenario digest: `86946fd654dc15f3c5f13965bfb7c4b1f24af59d332185995e0750e352a44a85`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Run profile: `publication`
- Configured repetitions: `5`

## Workspace panel interactions by seeded load

| Load | Interaction | Duration p50 (ms) | Duration p95 (ms) | Shell avg (ms) | Data-ready to interactive avg (ms) | Worst frame max (ms) | >16.667 ms intervals avg | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| light | open-panel | 155.7 | 160.3 | 10.2 | 75.9 | 66.8 | 4.0 | 69.5 | 24.7 | 14.1 | 5 / 5 |
| light | close-panel | 173.1 | 174.2 | — | — | 24.1 | 6.2 | 42.3 | 23.0 | 6.6 | 5 / 5 |
| light | files-to-review | 20.0 | 32.0 | — | — | 16.7 | 0.4 | 8.0 | 2.4 | 0.8 | 5 / 5 |
| light | review-to-files | 20.9 | 34.1 | — | — | 16.7 | 0.6 | 12.1 | 3.8 | 0.8 | 5 / 5 |
| light | open-file | 54.0 | 82.3 | — | — | 50.1 | 1.8 | 29.7 | 16.3 | 3.5 | 5 / 5 |
| light | switch-file-tab | 39.9 | 54.0 | — | — | 33.3 | 1.4 | 19.6 | 10.2 | 3.1 | 5 / 5 |
| light | expand-all | 73.2 | 104.7 | — | — | 49.8 | 2.4 | 27.6 | 26.6 | 9.4 | 5 / 5 |
| light | collapse-all | 29.8 | 38.4 | — | — | 33.4 | 0.6 | 21.4 | 3.0 | 0.8 | 5 / 5 |
| moderate | open-panel | 158.4 | 162.2 | 9.0 | 86.9 | 66.7 | 3.6 | 75.6 | 26.0 | 13.9 | 5 / 5 |
| moderate | close-panel | 170.8 | 172.1 | — | — | 38.4 | 6.0 | 53.4 | 30.8 | 6.6 | 5 / 5 |
| moderate | files-to-review | 18.3 | 19.8 | — | — | 16.7 | 0.2 | 10.7 | 2.4 | 0.7 | 5 / 5 |
| moderate | review-to-files | 36.1 | 37.6 | — | — | 37.3 | 0.8 | 23.6 | 9.1 | 0.9 | 5 / 5 |
| moderate | open-file | 55.6 | 68.1 | — | — | 33.3 | 2.6 | 31.6 | 16.9 | 3.5 | 5 / 5 |
| moderate | switch-file-tab | 54.7 | 69.9 | — | — | 33.3 | 2.0 | 23.0 | 11.6 | 3.2 | 5 / 5 |
| moderate | expand-all | 72.3 | 74.1 | — | — | 33.3 | 2.2 | 25.6 | 24.8 | 8.1 | 5 / 5 |
| moderate | collapse-all | 23.1 | 27.4 | — | — | 26.6 | 0.6 | 17.9 | 2.8 | 0.7 | 5 / 5 |
| heavy | open-panel | 154.0 | 164.6 | 8.0 | 85.2 | 50.1 | 4.0 | 67.1 | 24.4 | 13.8 | 5 / 5 |
| heavy | close-panel | 172.0 | 181.5 | — | — | 66.6 | 5.8 | 64.0 | 34.3 | 6.2 | 5 / 5 |
| heavy | files-to-review | 18.9 | 20.5 | — | — | 16.6 | 0.0 | 10.8 | 1.0 | 0.3 | 5 / 5 |
| heavy | review-to-files | 55.8 | 71.2 | — | — | 54.5 | 1.6 | 32.4 | 15.7 | 3.4 | 5 / 5 |
| heavy | open-file | 59.6 | 71.1 | — | — | 33.4 | 2.2 | 32.7 | 18.6 | 3.3 | 5 / 5 |
| heavy | switch-file-tab | 51.9 | 55.9 | — | — | 33.4 | 2.2 | 21.5 | 11.8 | 3.0 | 5 / 5 |
| heavy | expand-all | 71.8 | 82.6 | — | — | 33.4 | 2.6 | 26.3 | 26.1 | 8.7 | 5 / 5 |
| heavy | collapse-all | 23.1 | 25.3 | — | — | 25.2 | 0.6 | 16.0 | 3.4 | 0.8 | 5 / 5 |

Each row is one ordinary user action. The declared logical panel state is seeded before timing; setup is excluded. Review requires complete non-truncated 24-file data and exact logical expansion counts, while production-virtualized offscreen bodies need not be mounted. Open-file begins with authoritative target bytes warm through the production data path, but with its target tab and preview never mounted; the measured input owns first surface creation and paint. The current viewport must be painted and interactive. Opening reports shell, animation, data, paint, and interactive milestones.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
