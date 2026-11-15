# Running the benchmark

## Install

Requirements: Node.js 22 or newer and Rust 1.88 or newer.

```bash
npm ci
npm test
cargo build --release --manifest-path native/resource-monitor/Cargo.toml
npm run build:corpus
```

`build:corpus` builds the public corpus from its committed recording (`registry/recorded-sessions/opencode-recorded-sessions.ndjson`) into `artifacts/corpora/opencode-recorded-sessions`; `run` builds it on first use if it is missing. A run refuses a corpus whose digests differ from `registry/corpus-artifacts/opencode-recorded-sessions.json`.

## Run one app

```bash
node bin/agent-app-benchmark.mjs run --app <claxedo|t3|opencode> [--output <dir>]
```

`run` prepares the app's state from the corpus and runs app start, the list walk, new thread, long thread and typing while streaming, writing `<scenario>/result.json` for each, `typing-while-streaming/replay-requests.jsonl` (every request the replay server served, without bodies) and `host-conditions.jsonl` (load, power and the busiest processes every 10 s). One app's run must take at most 4 minutes; run the apps one after another.

Each app is found from its environment, or from `--root`, `--executable` and `--runtime`:

| App | Driver checkout | Packaged app | Runtime |
|---|---|---|---|
| `claxedo` | `CLAXEDO_ROOT` | `CLAXEDO_BENCHMARK_EXECUTABLE` | `CLAXEDO_BENCHMARK_RUNTIME`, else `bun` |
| `t3` | `T3_ROOT` | `T3_BENCHMARK_EXECUTABLE` | `T3_BENCHMARK_RUNTIME`, else `node` |
| `opencode` | `OPENCODE_ROOT` | `OPENCODE_BENCHMARK_EXECUTABLE` | `OPENCODE_BENCHMARK_RUNTIME`, else `bun` |

`--dry-run` prints the resolved plan. `--corpus-definition <file> --corpus-directory <dir>` runs your own corpus instead; its results are marked `custom/non-comparable`.

By default (`--run-profile publication`) each app starts 4 times per start mode, walks the list in two processes, takes 10 new threads in each of two processes, visits the long thread twice in each of two processes, and starts 5 streams and types 60 keys in one process. `--run-profile smoke` cuts the new-thread samples to 4, the streams to 2, the keys to 20 and the reply to 400 deltas (20 s); `--repetitions` sets the process count. If an app runs over 4 minutes, shorten the stream before cutting samples.

## Replay server and routing

For `typing-while-streaming`, `run` starts an OpenAI-compatible chat-completions server on 127.0.0.1 at a random port and passes it to the driver in `prepare` as `replay` (see [docs/driver-protocol.md](docs/driver-protocol.md)). A streamed request whose last user message holds the benchmark prompt gets the replay reply; any other streamed request (a title, a summary) gets a one-delta reply, and a request without `stream: true` a one-message JSON reply. No network or model is involved.

Each driver must route its app's agent to it through an OpenCode-engine custom provider (`@ai-sdk/openai-compatible`, model `replay/stream`) written into the sealed state: OpenCode by its config, T3 Code by its `opencode` provider pointed at the pinned OpenCode 2.3.0 CLI, Claxedo by its harness provider definition. A driver that cannot route its app's agent there, or has no new-thread control in the session view, declares the scenario in `unsupportedScenarios` with a one-line reason; its cells stay empty with that reason.

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
| `t3` | [kyashrathore/t3code](https://github.com/kyashrathore/t3code) `agent-app-benchmark` | tag `v0.1.7` | `scripts/lib/agent-app-benchmark/drivers/t3.ts` |
| `opencode` | [kyashrathore/opencode](https://github.com/kyashrathore/opencode) `agent-app-benchmark` | tag `v2.3.0` | `packages/desktop/benchmark/agent-app-driver.ts` |

- **T3:** `CI=true corepack pnpm install --frozen-lockfile`, then `corepack pnpm dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version <version>` (the resource monitor needs rustc 1.95). The driver accepts only a build of its own commit, or of an ancestor that differs from it only in the driver.
- **OpenCode:** clone this repository next to the OpenCode checkout as `agent-app-benchmark` (or set `AGENT_APP_BENCHMARK_ROOT`). With the bun the repository pins (1.4.4), `bun install`, then with `OPENCODE_CHANNEL=latest OPENCODE_VERSION=<version>` exported: `bun run build --single` in `packages/cli`, then `bun run build` and `bun run pack` in `packages/desktop`. The app is `packages/desktop/dist/mac-arm64/OpenCode.app`. The channel must be `latest`, as in a release: a CLI built for another channel registers its background service where the desktop app does not look, and the app never connects. Each launch pins the sealed app's background service to a free port through its service port setting, so an OpenCode service already on the default 127.0.0.1:49374 does not collide with it.
- **New upstream release:** rebase the branch onto the new tag, rebuild the app, run it once and check that every observation is valid before comparing.

A driver's in-page clock comes from the driver SDK (`settleExpression`); the driver supplies only facts about its app. See [docs/driver-protocol.md](docs/driver-protocol.md).

## Equal conditions

- Every launch starts from a sealed state with an isolated home, profile and data directory.
- The window is maximized (1512 × 875 viewport at 2×), in the dark theme, and must be visible and focused before every measurement.
- Notices are closed through the app's own close button, untimed.

## Differences between the apps

- OpenCode 2.3.0 lists every session in a sidebar only with Settings > General > Interface mode "Side" and the experimental Settings > Experimental > Sidebar organize "Customize"; its default layout is a tab strip. The driver's sealed profile carries those settings and the sidebar's ungrouped list, and walks the sidebar: a click previews a recent session in place, so first visits and returns both click the same row. The sidebar shows 10 recent sessions before "Show more", which the driver presses, untimed, before the step that needs it. The control is the oldest session, so app start opens it from the Home page the app starts on, and a fresh-profile app start includes going through Home.
- OpenCode 2.x reads the corpus's 1.x history only through its V1 migration: the driver writes it as a 1.x database and the app's own CLI migrates it. Because the recording's tools already carry 2.x names, the migration takes `read`, `edit` and `write` for 1.x tools and appends a notice that they "now take `path` instead of `filePath`" to the end of every session.
- OpenCode's new thread is the draft its sidebar's New session opens in the shown session's workspace; the driver discards it through the draft row's close button. Its long thread is the least recently updated session, so its sidebar row is the last recent row, behind two untimed "Show more" presses, not directly below the open control row.
- OpenCode's agent reaches the replay server through a custom provider in the sealed state's global config (`provider.replay`, `model` and `small_model` set to `replay/stream`, `enabled_providers: ["replay"]`); each reply starts with a trusted Enter in a new thread, and typing goes into a sixth new thread.
- T3 Code stores history translated from the OpenCode event stream, with tool calls and reasoning flattened into message text; Claxedo and OpenCode import the native parts.
- T3 Code 0.1 opens a new thread in the current project from a Shift+click on its sidebar's New thread button (a plain click opens a project picker when more than one project is open). It reopens a thread where it was left, so after each long-thread scroll the driver presses T3's own Scroll to end, untimed. Its agent reaches the replay server through T3's `opencode` provider running the OpenCode 2.3.0 CLI from `PATH`; T3's own thread titles stay on its default text-generation provider (Codex).

## Corpus

`opencode-recorded-sessions` is built from one real recorded OpenCode 2.3.0 session (model `opencode/big-pickle`, ademark's Ledger arena, Apache-2.0): 24 sessions in two workspaces, each the recording's turns repeated to a whole turn at or above its size, labeled by nominal size (1 MiB, 8 MiB), plus the control session (the first turn), a progressive memory run and a long thread of at least 2,000 messages listed below the control. The README credits the source.

To import a new recording, export it with OpenCode 2.3 (`opencode session export <id>`, run in the session's directory) and run:

```bash
node scripts/import-opencode-export.mjs --input session-export.json [--replace <from>=<to>]...
```

It converts the export into the corpus event format, redacts the session directory and home directory to `/benchmark/workspace-a` and the user name and git identity everywhere, fails on any email outside the reserved example domains, credential or home-directory path left over, writes the recording, builds the corpus and registers its digests. 2.x idle, system and switch markers have no history event and are dropped (the import prints their counts).

The benchmark does not measure Web Vitals, live models, terminals or a composite score. Contributions go through pull requests; see [CONTRIBUTING.md](CONTRIBUTING.md).
