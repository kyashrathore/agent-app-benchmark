## Summary

<!-- What benchmark definition, driver registration, or result changes? -->

## Verification

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run validate`
- [ ] `cargo test --locked --manifest-path native/resource-monitor/Cargo.toml`
- [ ] Submitted result summaries recompute from raw observations

## Trust and comparability

<!-- State source-event format, materialization mode, app/driver revisions, environment, and any driver-attested behavior. -->

## Post-Deploy Monitoring & Validation

No additional operational monitoring required: this repository publishes offline benchmark definitions, artifacts, and static HTML only. Validate the merged comparison by rebuilding its site from a clean checkout; revert the merge if registry/result digests or generated pages differ.
