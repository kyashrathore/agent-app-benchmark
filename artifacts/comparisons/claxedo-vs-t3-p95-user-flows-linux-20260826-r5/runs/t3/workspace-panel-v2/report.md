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
| light | open-panel | 98.8 | 102.2 | 7.5 | 60.1 | 50.0 | 2.8 | 44.5 | 11.5 | 9.9 | 5 / 5 |
| light | close-panel | 46.6 | 48.3 | — | — | 16.8 | 1.0 | 17.2 | 3.0 | 3.6 | 5 / 5 |
| light | files-to-review | 106.3 | 132.1 | — | — | 83.3 | 2.2 | 65.8 | 6.7 | 9.7 | 5 / 5 |
| light | review-to-files | — | — | — | — | — | — | — | — | — | 4 / 5 |
| light | open-file | 141.4 | 155.2 | — | — | 100.0 | 2.0 | 104.0 | 27.6 | 25.3 | 5 / 5 |
| light | switch-file-tab | 87.3 | 97.9 | — | — | 66.7 | 1.6 | 62.2 | 21.8 | 14.0 | 5 / 5 |
| light | expand-all | 68.0 | 86.1 | — | — | 34.5 | 2.2 | 36.6 | 4.5 | 10.3 | 5 / 5 |
| light | collapse-all | 72.0 | 81.3 | — | — | 33.4 | 2.0 | 39.7 | 7.8 | 2.7 | 5 / 5 |
| moderate | open-panel | 97.5 | 108.6 | 7.3 | 60.3 | 49.9 | 2.6 | 44.7 | 11.6 | 9.8 | 5 / 5 |
| moderate | close-panel | 47.2 | 62.1 | — | — | 16.7 | 1.6 | 18.6 | 3.0 | 3.5 | 5 / 5 |
| moderate | files-to-review | 130.2 | 147.3 | — | — | 83.4 | 2.2 | 76.9 | 6.8 | 9.7 | 5 / 5 |
| moderate | review-to-files | 55.3 | 63.2 | — | — | 33.4 | 1.4 | 33.6 | 8.0 | 5.7 | 5 / 5 |
| moderate | open-file | 161.0 | 240.2 | — | — | 116.7 | 2.8 | 109.3 | 28.4 | 25.2 | 5 / 5 |
| moderate | switch-file-tab | 83.0 | 90.9 | — | — | 66.6 | 1.4 | 59.7 | 21.4 | 12.9 | 5 / 5 |
| moderate | expand-all | 62.2 | 75.2 | — | — | 34.4 | 2.0 | 36.4 | 4.8 | 10.0 | 5 / 5 |
| moderate | collapse-all | 64.8 | 79.2 | — | — | 50.0 | 1.6 | 40.3 | 7.3 | 2.4 | 5 / 5 |
| heavy | open-panel | 103.4 | 104.9 | 8.0 | 63.9 | 50.1 | 2.4 | 48.1 | 12.3 | 10.3 | 5 / 5 |
| heavy | close-panel | 38.9 | 46.1 | — | — | 16.8 | 0.8 | 16.6 | 3.1 | 3.5 | 5 / 5 |
| heavy | files-to-review | 97.0 | 129.0 | — | — | 83.3 | 2.0 | 66.3 | 6.6 | 9.5 | 5 / 5 |
| heavy | review-to-files | 55.8 | 62.9 | — | — | 33.4 | 1.4 | 36.0 | 8.5 | 6.0 | 5 / 5 |
| heavy | open-file | 166.6 | 204.3 | — | — | 133.3 | 3.0 | 117.0 | 31.2 | 27.8 | 5 / 5 |
| heavy | switch-file-tab | 106.5 | 136.8 | — | — | 83.4 | 2.2 | 70.6 | 24.0 | 18.6 | 5 / 5 |
| heavy | expand-all | 64.3 | 89.0 | — | — | 39.3 | 1.8 | 35.2 | 4.7 | 10.0 | 5 / 5 |
| heavy | collapse-all | — | — | — | — | — | — | — | — | — | 4 / 5 |

Each row is one ordinary user action. The declared logical panel state is seeded before timing; setup is excluded. Review requires complete non-truncated 24-file data and exact logical expansion counts, while production-virtualized offscreen bodies need not be mounted. Open-file begins with authoritative target bytes warm through the production data path, but with its target tab and preview never mounted; the measured input owns first surface creation and paint. The current viewport must be painted and interactive. Opening reports shell, animation, data, paint, and interactive milestones.

## Scope

This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.

Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.
