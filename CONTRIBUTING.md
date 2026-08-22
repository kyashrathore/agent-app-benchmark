# Contributing

## Adding a public scenario or corpus

Public comparison definitions are review-controlled. To publish a new definition:

1. Fork this repository and create a branch.
2. Add the scenario to `registry/scenarios/` and any procedural corpus definition to `registry/corpora/`.
3. State the exact user action, start endpoint, completion endpoint, validity conditions, units, repetitions, and resource window.
4. Add contract and report tests covering the definition.
5. Open a pull request explaining why the new work is broadly comparable across agent applications.

Merging the pull request registers the canonical bytes. Results produced from files with any other digest remain useful local experiments, but are labeled `custom` and are not public-comparable.

Do not add app-specific UI selectors, storage tables, launch flags, or budgets to a public scenario. Those belong in each application's driver. Do not add a composite score.

## Adding an application

Add a manifest to `registry/apps/`, implement the executable driver protocol in the application's own repository, and include evidence that the driver passes this repository's conformance suite. A public result must identify immutable application and driver revisions.
