# T3 driver

T3's application-owned benchmark driver is at `scripts/lib/agent-app-benchmark/drivers/t3.ts`. It owns OpenCode-event translation into T3's ordinary event/projection storage, Electron launch, semantic paint and trusted-input readiness, and process ownership.

The public adapter implements the exact new/initialized application-state cases and four explicit `session-switch-v1` lanes from [the protocol](../../docs/driver-protocol.md). It reports `materializationMode: translated` unless a shipped production OpenCode history-ingestion path is verified. This repository intentionally does not copy T3 storage or UI selectors.
