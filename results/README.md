# Public results

Each accepted run stores a bounded shareable `result.json` whose summaries recompute from preserved raw observations. Comparison manifests under `results/comparisons/<comparison-id>/comparison.json` list exact result paths and SHA-256 digests; the site generator never scans for a silent latest result.

Public pull-request CI validates result schemas, registered scenario/corpus digests, recomputed summaries, comparison compatibility, and privacy. It never executes contributor-supplied drivers.
