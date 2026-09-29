# Running the benchmark

## Install

Requirements: Node.js 22 or newer and Rust 1.88 or newer.

```bash
npm ci
npm test
cargo build --release --manifest-path native/resource-monitor/Cargo.toml
npm run generate:corpus
```

`generate:corpus` writes the public synthetic corpus to `artifacts/corpora/opencode-completed-sessions`.

## Run one app

```bash
node bin/agent-app-benchmark.mjs run --app <claxedo|t3|opencode> [--output <dir>]
```

`run` prepares the app's state from the corpus, runs app start and then the list walk, and writes `app-start/result.json`, `session-switch-walk/result.json` and `host-conditions.jsonl` (load, power and the busiest processes every 10 s). One app's run takes up to 4 minutes; run the apps one after another.

Each app is found from its environment, or from `--root`, `--executable` and `--runtime`:

| App | Driver checkout | Packaged app | Runtime |
|---|---|---|---|
| `claxedo` | `CLAXEDO_ROOT` | `CLAXEDO_BENCHMARK_EXECUTABLE` | `CLAXEDO_BENCHMARK_RUNTIME`, else `bun` |
| `t3` | `T3_ROOT` | `T3_BENCHMARK_EXECUTABLE` | `T3_BENCHMARK_RUNTIME`, else `node` |
| `opencode` | `OPENCODE_ROOT` | `OPENCODE_BENCHMARK_EXECUTABLE` | `OPENCODE_BENCHMARK_RUNTIME`, else `bun` |

`--dry-run` prints the resolved plan. `--corpus-definition <file> --corpus-directory <dir>` runs your own corpus instead; its results are marked `custom/non-comparable`.

By default each app starts 4 times per start mode and walks the list in two processes (38, 6 and 4 samples per switch row). The published run used 12 starts and five processes.

## Compare

```bash
node bin/agent-app-benchmark.mjs verdict --result <run-dir> --result <run-dir> [...]
```

The first app named is the reference. The verdict refuses runs from different machines, scenarios, corpora, clock rules or framework revisions, and runs where any observation failed the frame-log re-check. It shows each run's load beside the tables. `site build --result <run-dir> ... --output <dir>` renders the same tables as a static site.

## Drivers

Each driver lives with its app, on a branch that carries only the driver and a few inert hooks.

| App | Repository and branch | Base | Driver |
|---|---|---|---|
| `claxedo` | [kyashrathore/Claxedo](https://github.com/kyashrathore/Claxedo) | the build under test | `packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts` |
| `t3` | [kyashrathore/t3code](https://github.com/kyashrathore/t3code) `agent-app-benchmark` | tag `v0.0.42` | `scripts/lib/agent-app-benchmark/drivers/t3.ts` |
| `opencode` | [kyashrathore/opencode](https://github.com/kyashrathore/opencode) `agent-app-benchmark` | tag `v1.18.32` | `packages/desktop/benchmark/agent-app-driver.ts` |

- **T3:** `CI=true corepack pnpm install --frozen-lockfile`, then `corepack pnpm dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version <version>` (the resource monitor needs rustc 1.95). The driver accepts only a build of its own commit, or of an ancestor that differs from it only in the driver.
- **OpenCode:** clone this repository next to the OpenCode checkout as `agent-app-benchmark` (or set `AGENT_APP_BENCHMARK_ROOT`). `bun install`, then in `packages/desktop`, with `OPENCODE_CHANNEL=prod OPENCODE_VERSION=<version>` exported: `bun ./scripts/prepare.ts`, `bun run build`, `bun run package:mac -- --dir --publish never`.
- **New upstream release:** rebase the branch onto the new tag, rebuild the app, run it once and check that every observation is valid before comparing.

A driver's in-page clock comes from the driver SDK (`settleExpression`); the driver supplies only facts about its app. See [docs/driver-protocol.md](docs/driver-protocol.md).

## Equal conditions

- Every launch starts from a sealed state with an isolated home, profile and data directory.
- The window is maximized (1512 × 875 viewport at 2×), in the dark theme, and must be visible and focused before every measurement.
- Notices are closed through the app's own close button, untimed.

## Differences between the apps

- OpenCode 1.18.32 has no session sidebar: a first visit starts from its Home page and a return clicks the session's tab. Its fresh-profile app start includes going through Home.
- T3 Code stores history translated from the OpenCode event stream, with tool calls and reasoning flattened into message text; Claxedo and OpenCode import the native parts.

## Corpus

`opencode-completed-sessions` is deterministic and synthetic: 25 sessions in two workspaces, with 1 MiB and 8 MiB sessions, 1 MiB of long text rows and a progressive memory run. Every prompt, response, path, title and identifier in it is generated.

The benchmark does not measure Web Vitals, streaming output, live agents, terminals or a composite score. Contributions go through pull requests; see [CONTRIBUTING.md](CONTRIBUTING.md).
