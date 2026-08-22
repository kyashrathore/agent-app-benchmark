# T3 driver

T3's original benchmark driver is at `scripts/lib/agent-app-benchmark/drivers/t3.ts` in the T3 repository, introduced by local commit `e52bf0f3a`. It is the first reference implementation for corpus materialization, Electron automation, semantic paint, trusted-input readiness, and process ownership.

Before publishing a result under this simplified registry, the T3 driver must implement `app-start-v1` fresh/repeat profile cases and the four explicit `session-switch-v1` lanes from [the protocol](../../docs/driver-protocol.md). The framework intentionally does not copy T3 storage or UI selectors here; the app repository remains their authoritative owner.
