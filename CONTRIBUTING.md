# Contributing

Public comparisons are review-controlled. Fork this repository, create a branch, and open a pull request for every public definition, driver registration, or result.

## Add a scenario or corpus

1. Add an immutable versioned definition under `registry/scenarios/` or `registry/corpora/`.
2. Define the exact user action, start and completion endpoints, validity rules, units, repetitions, resource windows, and report placement.
3. Add happy-path, boundary, failure, and integration tests.
4. Run `npm test`, `npm run lint`, `npm run validate`, and the Rust monitor tests.

Merged bytes become the public identity. Changing comparable semantics requires a new version; a local file cannot impersonate a public scenario by reusing its ID.

Do not put app selectors, app storage tables, launch flags, or private budgets into a public scenario. Those belong in the application-owned driver.

## Propose another metric

Metrics live directly inside scenario definitions. A metric pull request must provide:

- a stable ID and plain-language description;
- unit and better direction;
- observer/clock owner;
- required raw inputs and validity rules;
- aggregation and report placement.

Adding or changing a public metric creates a new scenario version and requires new public result runs for that version. Do not add profiles, composite scores, or retroactive values synthesized from missing observations.

## Add or update an application driver

Drivers remain in the application repository. Add or update its registry entry here and provide:

- immutable application, build, driver, and source revisions;
- protocol conformance output;
- app-owned integration tests showing the canonical corpus is materialized through ordinary production history/rendering paths;
- declared process roots and clean-shutdown evidence;
- `native-opencode` or `translated` materialization attestation.

T3 and Claxedo happen to be Electron apps. Other GUI frameworks are explicitly welcome.

## Submit a result

1. Run a pinned framework revision, scenario, corpus, app build, and driver revision.
2. Preserve every valid, invalid, and failed raw observation.
3. Add the bounded shareable `result.json` and update an explicit comparison manifest.
4. Open a pull request. CI validates schemas, digests, privacy, and recomputes summaries; it never executes contributor-supplied drivers.

Only results from the same comparison run and machine/environment are displayed side by side. Community results are labeled `community-self-attested`; maintainer runs are labeled `maintainer-observed`. There is no silent “best” or “latest” selection.
