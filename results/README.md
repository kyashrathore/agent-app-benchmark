# Public results

Each accepted run of one app is a directory under `results/runs/<run-id>/` holding one bounded shareable `result.json` per scenario, whose summaries recompute from preserved raw observations, and the run's `host-conditions.jsonl`. `verdict` and `site build` take run directories explicitly; nothing scans for a silent latest result.

Public pull-request CI validates the schema, registered scenario and corpus digests, recomputed summaries and privacy of every result a pull request adds. It never executes contributor-supplied drivers.
