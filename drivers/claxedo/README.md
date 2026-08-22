# Claxedo driver

Claxedo's reference driver is at `packages/claxedo-app/perf-harness/src/agent-claxedo-driver.ts` on its performance branch. It already implements isolated corpus materialization, packaged-app launch, semantic paint/input readiness, exact process cleanup, and an NDJSON lifecycle.

Before publishing a result under this simplified registry, the Claxedo driver must implement `app-start-v1` fresh/repeat profile cases and the four explicit `session-switch-v1` lanes from [the protocol](../../docs/driver-protocol.md). Claxedo-specific storage and UI automation remain in the Claxedo repository.
