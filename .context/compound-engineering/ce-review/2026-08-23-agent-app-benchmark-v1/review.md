# Agent App Benchmark V1 review

## Scope

Reviewed the standalone framework, public contracts, deterministic corpus, native resource sidecar, comparison/report pipeline, T3 driver, and Claxedo driver against the active V1 plan.

## Resolved findings

- Published summaries and resource values are recomputed from strict raw observations and `resourceTrace`; edited or partial summaries are rejected.
- Exact observation schedules, readiness receipt ordering, single-clock duration equality, cleanup, and timeout poisoning are enforced.
- The generated corpus manifest has a strict schema and the public corpus has a pinned generated-artifact digest.
- The native monitor records dynamic Electron process families, cumulative CPU boundaries, cadence, root/external-process completeness, and malformed-snapshot failures without blocking for a current-CPU sampling window.
- Driver conformance exercises `hello → prepare → launch/execute → shutdown` rather than stopping after preparation.
- The framework owns a balanced mirrored same-machine comparison schedule and records its digest/ordinal in every result.
- Custom scenario manifests run locally as `custom/non-comparable`; public comparisons reject them.
- Public artifacts are append-only and publication validation recomputes reports and results.
- The static site renders compatibility failures and invalid resource reasons explicitly, reports exact transcript sizes, and keeps per-scenario driver/framework provenance.
- Public path, privacy, definition-size, and process-monitor lifecycle bounds are enforced.

## Verification

- Node unit/integration suite
- Node syntax/lint and registry validation
- Rust unit suite
- Rust release sidecar ↔ JavaScript client integration
- Real T3 and Claxedo driver conformance and generated benchmark runs (performed after this framework review commit)

## Remaining acceptance check

- Manual browser QA of the generated static site requires the user-selected headed or headless test mode.
