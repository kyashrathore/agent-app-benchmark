# Agent App Benchmark

How fast coding-agent desktop apps start, open sessions and sit idle, measured the same way in every app.

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
- **First visit and return:** the app walks down its own session list, clicking the next row each time. A first visit opens a session for the first time in that process; a return opens it again later in the same process. The clock starts at the trusted click on the row and stops at the settle. Five processes each walk the list, so each row has 95, 15 or 10 samples.
- **Settle:** the same in-page clock runs in every app. Each frame is sampled after style and layout. The settle is the first frame of the first run of 31 frames in which the session is displayed, its latest turn is painted, nothing is loading, the first screen is filled, the composer is editable and the window is visible and focused, with nothing changing across the run. The benchmark re-derives every reported time from the frames the clock sampled.
- **Memory:** resident memory summed over the app's whole process family, sampled every 250 ms in an idle window after the switching workload.
- **Idle CPU:** CPU time used by the whole process family during that idle window, as a percentage of one core.
- **Significance:** a time row counts as a difference only when an exact two-sided Mann–Whitney test gives p < 0.05, the bootstrap 95% interval of the median ratio excludes 1, and the gap is at least 5%. A memory row needs the two apps' samples not to overlap.

Each app runs on its own, one after another, on the same machine.

## Run it yourself

See [RUNNING.md](RUNNING.md).
