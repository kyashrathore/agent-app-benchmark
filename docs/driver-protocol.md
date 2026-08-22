# Driver protocol v1

The driver is a stateful NDJSON subprocess. Every request and response contains `protocolVersion`, `correlationId`, and `method`. Responses repeat the request correlation and method.

## Methods

### `hello`

Returns application/driver identity and supported public scenario IDs. It does not return prose readiness or preparation claims.

### `prepare`

Receives the canonical scenario, generated corpus path/digest, and private run directory. It materializes the corpus through the application's authoritative storage/import path and returns corpus identity/readback evidence. For `app-start-v1`, it prepares immutable `P0` (never launched) and `P1` (exactly one successful unmeasured launch followed by complete shutdown) profile snapshots.

### `launch`

Used by `session-switch-v1` to start one process from the prepared profile, open the initial 1 MiB session, reach semantic paint/input readiness, and return application-owned process roots as `{pid,startTimeMs,category}`. The runner starts resource observation from these roots.

`app-start-v1` launches inside each `run-case` because process spawn is itself the measured action.

### `run-case`

Receives one runner-generated case. App-start cases contain `startMode`. Session-switch cases contain `workspaceRelation`, `sessionState`, `transcriptBytes`, and deterministic source/destination IDs. It returns the action duration, one-clock endpoint evidence, and machine-readable validity checks.

### `shutdown`

Terminates only captured driver/application handles and returns terminated identities plus survivors. Any survivor invalidates the attempt.

## Readiness

Both apps must use the same semantic endpoint: the requested benchmark surface/session is painted and trusted keyboard input is accepted. The driver proves that endpoint through validity receipts on every case; a text description in `hello` is intentionally not part of this protocol.

See `schemas/driver-message-v1.schema.json` for the portable boundary.
