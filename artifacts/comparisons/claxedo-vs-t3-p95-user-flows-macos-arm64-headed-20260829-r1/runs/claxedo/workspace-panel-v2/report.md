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
| light | open-panel | 133.7 | 136.4 | 5.6 | 102.6 | 16.8 | 0.4 | 26.9 | 9.7 | 7.1 | 5 / 5 |
| light | close-panel | 146.6 | 154.8 | — | — | 13.3 | 0.0 | 27.6 | 17.7 | 4.5 | 5 / 5 |
| light | files-to-review | 11.6 | 12.0 | — | — | 8.4 | 0.0 | 3.0 | 0.9 | 0.3 | 5 / 5 |
| light | review-to-files | 13.1 | 13.4 | — | — | 9.1 | 0.0 | 5.1 | 1.5 | 0.2 | 5 / 5 |
| light | open-file | 20.9 | 21.1 | — | — | 9.1 | 0.0 | 12.6 | 8.5 | 1.1 | 5 / 5 |
| light | switch-file-tab | 21.3 | 24.7 | — | — | 9.1 | 0.0 | 6.1 | 4.3 | 1.1 | 5 / 5 |
| light | expand-all | 38.0 | 39.2 | — | — | 9.2 | 0.0 | 11.8 | 11.7 | 2.8 | 5 / 5 |
| light | collapse-all | 12.8 | 14.0 | — | — | 9.0 | 0.0 | 5.6 | 1.5 | 0.4 | 5 / 5 |
| moderate | open-panel | — | — | — | — | — | — | — | — | — | 4 / 5 |
| moderate | close-panel | 153.8 | 154.5 | — | — | 16.6 | 0.0 | 29.7 | 18.6 | 4.7 | 5 / 5 |
| moderate | files-to-review | 10.6 | 11.8 | — | — | 8.9 | 0.0 | 3.9 | 0.9 | 0.3 | 5 / 5 |
| moderate | review-to-files | 12.0 | 12.5 | — | — | 12.0 | 0.0 | 10.4 | 3.3 | 0.7 | 5 / 5 |
| moderate | open-file | 28.5 | 29.7 | — | — | 16.7 | 0.2 | 15.3 | 10.2 | 1.2 | 5 / 5 |
| moderate | switch-file-tab | 20.4 | 25.4 | — | — | 8.4 | 0.0 | 8.5 | 5.1 | 1.3 | 5 / 5 |
| moderate | expand-all | 38.2 | 46.2 | — | — | 17.5 | 0.2 | 11.6 | 11.7 | 3.0 | 5 / 5 |
| moderate | collapse-all | 13.2 | 13.9 | — | — | 8.8 | 0.0 | 5.5 | 1.5 | 0.4 | 5 / 5 |
| heavy | open-panel | 133.5 | 134.1 | 5.7 | 102.3 | 16.8 | 0.8 | 26.2 | 9.6 | 6.9 | 5 / 5 |
| heavy | close-panel | 153.9 | 154.4 | — | — | 28.3 | 0.2 | 33.4 | 20.3 | 5.4 | 5 / 5 |
| heavy | files-to-review | 10.5 | 11.9 | — | — | 8.9 | 0.0 | 5.3 | 0.9 | 0.3 | 5 / 5 |
| heavy | review-to-files | 20.4 | 20.8 | — | — | 12.5 | 0.0 | 17.4 | 5.4 | 1.1 | 5 / 5 |
| heavy | open-file | 29.6 | 37.3 | — | — | 16.7 | 0.2 | 18.8 | 12.1 | 1.2 | 5 / 5 |
| heavy | switch-file-tab | 20.9 | 21.1 | — | — | 9.1 | 0.0 | 8.5 | 5.4 | 1.2 | 5 / 5 |
| heavy | expand-all | 38.8 | 47.0 | — | — | 16.6 | 0.0 | 12.3 | 12.2 | 2.9 | 5 / 5 |
| heavy | collapse-all | 13.1 | 13.4 | — | — | 8.4 | 0.0 | 5.6 | 1.5 | 0.4 | 5 / 5 |

Each row is one ordinary user action. The declared logical panel state is seeded before timing; setup is excluded. Review requires complete non-truncated 24-file data and exact logical expansion counts, while production-virtualized offscreen bodies need not be mounted. Open-file begins with authoritative target bytes warm through the production data path, but with its target tab and preview never mounted; the measured input owns first surface creation and paint. The current viewport must be painted and interactive. Opening reports shell, animation, data, paint, and interactive milestones.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
