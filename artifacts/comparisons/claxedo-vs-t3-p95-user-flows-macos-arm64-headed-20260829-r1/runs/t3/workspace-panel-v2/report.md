# T3 Code: workspace-panel-v2

- Eligibility: **public-comparable** / **public-comparable**
- Source events: `opencode-event-v2` (schema `f6e789de10d8b54fbe8b640ff885843cbc564ac1eb262611083a050de0435cac`)
- Materialization: **translated** (driver-attested)
- Scenario digest: `86946fd654dc15f3c5f13965bfb7c4b1f24af59d332185995e0750e352a44a85`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Run profile: `publication`
- Configured repetitions: `5`

## Workspace panel interactions by seeded load

| Load | Interaction | Duration p50 (ms) | Duration p95 (ms) | Shell avg (ms) | Data-ready to interactive avg (ms) | Worst frame max (ms) | >16.667 ms intervals avg | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| light | open-panel | 26.9 | 27.1 | 5.6 | 15.1 | 9.2 | 0.0 | 14.2 | 3.9 | 3.0 | 5 / 5 |
| light | close-panel | 16.9 | 17.6 | — | — | 8.4 | 0.0 | 5.1 | 1.4 | 1.2 | 5 / 5 |
| light | files-to-review | 43.4 | 56.9 | — | — | 32.5 | 0.8 | 26.4 | 2.6 | 3.2 | 5 / 5 |
| light | review-to-files | 15.9 | 20.3 | — | — | 8.4 | 0.0 | 11.2 | 2.5 | 1.7 | 5 / 5 |
| light | open-file | 46.0 | 53.3 | — | — | 34.1 | 1.0 | 34.6 | 9.3 | 6.7 | 5 / 5 |
| light | switch-file-tab | 25.9 | 31.4 | — | — | 24.8 | 0.2 | 19.4 | 6.6 | 4.0 | 5 / 5 |
| light | expand-all | 24.4 | 24.8 | — | — | 9.0 | 0.0 | 12.3 | 1.7 | 2.7 | 5 / 5 |
| light | collapse-all | 36.5 | 44.0 | — | — | 9.3 | 0.0 | 12.7 | 2.2 | 0.8 | 5 / 5 |
| moderate | open-panel | 27.2 | 27.7 | 5.4 | 15.7 | 9.2 | 0.0 | 13.9 | 3.9 | 2.9 | 5 / 5 |
| moderate | close-panel | 17.0 | 17.2 | — | — | 9.2 | 0.0 | 5.2 | 1.3 | 1.2 | 5 / 5 |
| moderate | files-to-review | 44.0 | 58.7 | — | — | 33.3 | 0.8 | 25.2 | 2.7 | 3.8 | 5 / 5 |
| moderate | review-to-files | 15.8 | 16.1 | — | — | 8.7 | 0.0 | 10.5 | 2.4 | 1.7 | 5 / 5 |
| moderate | open-file | 47.7 | 56.8 | — | — | 33.4 | 1.0 | 36.3 | 9.4 | 7.5 | 5 / 5 |
| moderate | switch-file-tab | 34.1 | 34.8 | — | — | 25.0 | 0.8 | 22.2 | 7.3 | 5.6 | 5 / 5 |
| moderate | expand-all | 25.4 | 26.6 | — | — | 9.0 | 0.0 | 12.5 | 1.8 | 2.8 | 5 / 5 |
| moderate | collapse-all | 35.0 | 36.6 | — | — | 9.0 | 0.0 | 11.6 | 2.2 | 0.8 | 5 / 5 |
| heavy | open-panel | 27.0 | 28.3 | 5.8 | 15.6 | 9.1 | 0.0 | 14.2 | 3.9 | 2.9 | 5 / 5 |
| heavy | close-panel | 17.1 | 17.3 | — | — | 9.0 | 0.0 | 5.2 | 1.4 | 1.1 | 5 / 5 |
| heavy | files-to-review | 41.2 | 58.1 | — | — | 33.9 | 0.4 | 23.4 | 2.5 | 3.1 | 5 / 5 |
| heavy | review-to-files | 15.7 | 18.7 | — | — | 9.2 | 0.0 | 10.9 | 2.4 | 1.7 | 5 / 5 |
| heavy | open-file | 43.7 | 48.7 | — | — | 33.3 | 1.0 | 33.6 | 9.3 | 6.7 | 5 / 5 |
| heavy | switch-file-tab | 32.6 | 35.7 | — | — | 25.8 | 0.6 | 22.7 | 6.9 | 5.8 | 5 / 5 |
| heavy | expand-all | 24.2 | 25.0 | — | — | 8.6 | 0.0 | 11.6 | 1.7 | 2.7 | 5 / 5 |
| heavy | collapse-all | 31.3 | 43.9 | — | — | 15.8 | 0.0 | 12.0 | 2.3 | 0.8 | 5 / 5 |

Each row is one ordinary user action. The declared logical panel state is seeded before timing; setup is excluded. Review requires complete non-truncated 24-file data and exact logical expansion counts, while production-virtualized offscreen bodies need not be mounted. Open-file begins with authoritative target bytes warm through the production data path, but with its target tab and preview never mounted; the measured input owns first surface creation and paint. The current viewport must be painted and interactive. Opening reports shell, animation, data, paint, and interactive milestones.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
