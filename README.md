# Agent App Benchmark

How fast coding-agent desktop apps start, open sessions, open a new thread, scroll a long thread, show a streaming reply and keep up with typing, measured the same way in every app.

## Latest run

29 September 2026 on an Apple M4 Pro (24 GiB, macOS 26, on AC power): Claxedo at commit `81726a6ef3`, T3 Code 0.0.42 and OpenCode 1.18.32. The sessions are the maintainer's own coding sessions, redacted; they are not in this repository.

| Metric | Claxedo | T3 Code | OpenCode | × vs T3 Code | × vs OpenCode |
|---|---|---|---|---|---|
| App start, fresh profile | 1.05 s | 2.88 s | 2.10 s | 2.73× | 1.99× |
| App start, existing profile | 958 ms | 2.73 s | 2.03 s | 2.85× | 2.12× |
| First visit, 1 MiB session | 47.8 ms | 140.3 ms | 101.4 ms | 2.94× | 2.12× |
| First visit, 8 MiB session | 59.7 ms | 271.5 ms | 109.5 ms | 4.55× | 1.83× |
| First visit, 1 MiB of long text rows | 112.3 ms | 411.9 ms | 99.3 ms | 3.67×, not significant | 0.88×, not significant |
| Return, 1 MiB session | 32.8 ms | 67.2 ms | 48.2 ms | 2.05× | 1.47× |
| Return, 8 MiB session | 32.6 ms | 113.6 ms | 51.4 ms | 3.48× | 1.58× |
| Return, 1 MiB of long text rows | 56.7 ms | 113.8 ms | 90.3 ms | 2.01×, not significant | 1.59×, not significant |
| Memory idle after switching | 746 MiB | 1356 MiB | 1524 MiB | 1.82× | 2.04× |
| CPU while idle | 0.4% | 2.6% | 16.9% | 6.49× | 42.03× |

Each value is a median. × is the other app's median over Claxedo's: above 1, Claxedo is faster or uses less. Every row not marked "not significant" is a statistically significant difference.

## Methodology

- **App start:** from process spawn to the settle of the first session the app opens. A fresh profile has never been launched; an existing profile has been launched once and shut down. 12 starts of each. The very first launch of each build is unmeasured.
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
