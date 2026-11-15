# Agent App Benchmark

How fast coding-agent desktop apps start, open sessions, open a new thread, scroll a long thread, show a streaming reply and keep up with typing, measured the same way in every app.

## Latest run

15 November 2026 on an Apple M4 Pro (24 GiB, macOS 26, on AC power), publication profile, each app run on its own one after another: Claxedo at commit `ee63f4d29d` built with `CLAXEDO_DESKTOP_NO_LOGIN=true` (local-only, no sign-in), T3 Code 0.1.7 and OpenCode 2.3.0. The corpus is `opencode-recorded-sessions` (see Corpus).

| Metric | Claxedo | T3 Code | OpenCode | × vs T3 Code | × vs OpenCode |
|---|---|---|---|---|---|
| App start, fresh profile | | 1.64 s | | | |
| App start, existing profile | | 1.49 s | | | |
| First visit, 1 MiB session | 39.7 ms | 122.0 ms | 259.8 ms | 3.07× | 6.54× |
| First visit, 8 MiB session | 83.8 ms | 104.5 ms | 74.8 ms | 1.25× | 0.89× |
| Return, 1 MiB session | 20.6 ms | 43.1 ms | 258.4 ms | 2.09× | 12.55× |
| Return, 8 MiB session | 19.7 ms | 44.3 ms | 57.0 ms | 2.25× | 2.90× |
| New thread | 15.3 ms | 32.2 ms | 20.8 ms | 2.11× | 1.36× |
| Open the 2,000-message thread | 82.3 ms | 87.4 ms | 150.9 ms | 1.06×, not significant | 1.84×, not significant |
| Scroll it: frames over 33.4 ms | 0 | 0 | 0 | tie | tie |
| Scroll it: p95 frame interval | 10.1 ms | 12.7 ms | 10.0 ms | 1.26×, not significant | tie |
| Streaming reply: first word painted | 267.9 ms | 1.17 s | 221.4 ms | 4.36× | 0.83× |
| Typing while 5 replies stream: key to paint | 4.0 ms | 6.5 ms | 6.8 ms | 1.61× | 1.69× |
| Typing while 5 replies stream: keys missed | 0 of 60 | 0 of 60 | 0 of 60 | — | — |
| Memory idle after switching | 762 MiB | 1288 MiB | 1154 MiB | 1.69× | 1.51× |
| CPU while idle | 0.4% | 3.6% | 2.7% | 9.05× | 6.94× |

Each value is a median. × is the other app's median over Claxedo's: above 1, Claxedo is faster or uses less. Every row not marked "not significant" or "tie" is a statistically significant difference.

Empty cells are steps an app does not run the same way as the others:

- Claxedo's app start: the no-login build skips the signed desktop pass check that a released Claxedo runs before its first window.
- OpenCode's app start: its control session is behind the sidebar's "Show more", so the start goes through its Home page.

Other differences in this run:

- T3 Code reaches the replay server through its `opencode` provider (the OpenCode 2.3.0 CLI). Its fourth stream reaches the server about 55 s after the first in every run, which is the 58 s maximum behind its first-word median; the cause is not identified. Its thread titles still go to its default Codex provider, which fails without an account.
- OpenCode's walk uses its sidebar with the experimental "Sidebar organize = Customize" setting; a click opens a session as a preview. Its 1 MiB switches settle at about 258 ms because the transcript changes again about 190 ms after first paint. Its migration appends a "tools now take `path`" notice to every session.

## Methodology

- **App start:** from process spawn to the settle of the first session the app opens. A fresh profile has never been launched; an existing profile has been launched once and shut down. 4 starts of each. The very first launch of each build is unmeasured.
- **First visit and return:** the app walks down its own session list, clicking the next row each time. A first visit opens a session for the first time in that process; a return opens it again later in the same process. The clock starts at the trusted click on the row and stops at the settle. Rows are labeled by each session's nominal size (1 MiB or 8 MiB); the manifest records its actual bytes.
- **New thread (`new-thread.duration_ms`):** from the trusted pointerdown on the app's own new-thread control, in the control session's workspace, to the settle of the empty thread: no row of the previous session mounted and the composer editable. 10 samples in each of 2 fresh processes; each new thread is discarded untimed.
- **Long thread (`long-thread.open_ms`, `long-thread.scroll_long_frames`, `long-thread.scroll_p95_frame_ms`):** a list-walk step from the control session to a thread of at least 2,000 messages, first visit and return in each of 2 processes. After each open settles, 20 trusted wheel events of −480 CSS px, 50 ms apart, scroll toward older content; an in-page recorder logs every animation frame from the first wheel event to 500 ms after the last. The benchmark re-derives the count of frame intervals over 33.4 ms (two missed 60 Hz frames) and the p95 frame interval from that log.
- **First word (`stream.first_word_ms`):** each app's agent is routed to the benchmark's replay server, which streams the same reply to every app: 1,800 deltas of 8 characters, one every 50 ms, with markdown paragraphs, lists and fenced code at fixed positions. In a new thread the prompt is typed untimed; the clock runs from the trusted Enter keydown to the first frame that paints the reply's first 8 characters. Five threads are started 2 s apart, so five replies stream at once.
- **Typing while streaming (`typing.lag_p50_ms`, `typing.lag_p95_ms`, `typing.missed`):** in a sixth new thread, while the five replies stream, 60 trusted key presses 250 ms apart (±20% from a fixed seed). Each key is timed from its trusted keydown to the first frame, read after style and layout, whose composer holds it. A key not painted within 2 s is a miss: it counts once in the missed row and at 2 s in the lag row.
- **Settle:** the same in-page clock runs in every app. Each frame is sampled after style and layout. The settle is the first frame of the first run of 31 frames in which the session is displayed, its latest turn is painted, nothing is loading, the first screen is filled, the composer is editable and the window is visible and focused, with nothing changing across the run. The benchmark re-derives every reported time from the frames the clock sampled.
- **Memory:** resident memory summed over the app's whole process family, sampled every 250 ms in an idle window after the switching workload.
- **Idle CPU:** CPU time used by the whole process family during that idle window, as a percentage of one core.
- **Significance:** a time or frame-count row counts as a difference only when an exact two-sided Mann–Whitney test gives p < 0.05, the bootstrap 95% interval of the median ratio excludes 1, and the gap is at least 5%. The missed-keys row needs an exact two-sided Fisher test on the two apps' missed and painted keys to give p < 0.05. A memory row needs the two apps' samples not to overlap. A row with any invalid observation is withheld, and a row an app cannot run the same way as the others shows an empty cell with the driver's one-line reason.

Each app runs on its own, one after another, on the same machine, in at most 4 minutes.

## Corpus

Every session is built from one real recorded session: OpenCode 2.3.0 with the model `opencode/big-pickle`, working through [ademark](https://github.com/zqkra/ademark)'s task prompts (B3, C1 W1–W4, C2 F1–F3) and one follow-on prompt on ademark's Ledger arena project (`arena/` at `31e2814`, Apache-2.0). Home-directory paths and the user name are redacted, and the import fails on any email outside the reserved example domains, credential or home-directory path left over. Its 7 turns (87 messages, 381 KB of transcript) are repeated end to end, each copy with fresh ids and later times, and cut at the first whole turn at or above each session's size: the control session is the first turn, a 1 MiB session 18 turns (3 copies), an 8 MiB session 155 turns (23 copies), and the long thread 161 turns (23 copies, 2,001 messages). The 7th turn ends where the recording was stopped. For comparison, ademark's own replay sessions (`bench/replay/build-sessions.ts`) are scripted stand-ins rather than a recorded agent session.

## Run it yourself

See [RUNNING.md](RUNNING.md).
