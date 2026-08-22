# Claxedo driver

Claxedo's application-owned driver is at `packages/claxedo-app/perf-harness/src/agent-claxedo-driver.ts`. It owns OpenCode/Claxedo history materialization, packaged-app launch, semantic paint/input readiness, exact process cleanup, and the NDJSON lifecycle.

The public adapter implements the exact new/initialized application-state cases and four explicit `session-switch-v1` lanes from [the protocol](../../docs/driver-protocol.md). It reports `native-opencode` only when it uses the shipped production OpenCode-backed history boundary; otherwise it discloses `translated`. Claxedo-specific storage and UI automation remain in the Claxedo repository.
