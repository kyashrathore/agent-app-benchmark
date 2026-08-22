export function buildSiteModel(comparison) {
  const apps = [];
  const byApp = Map.groupBy(comparison.results, (item) => item.result.app.id);
  for (const [id, entries] of [...byApp.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    const first = entries[0].result;
    apps.push({
      id,
      name: first.app.name,
      version: first.app.version,
      buildDigestSha256: first.app.buildDigestSha256,
      driver: first.driver,
      sourceEventFormat: first.sourceEventFormat,
      materializationModes: [...new Set(entries.map((entry) => entry.result.materialization.mode))],
      environment: first.environment,
      appStart: entries.find((entry) => entry.result.scenario.kind === "app-start")?.result,
      sessionSwitch: entries.find((entry) => entry.result.scenario.kind === "session-switch")?.result,
    });
  }
  return {
    id: comparison.manifest.id,
    title: comparison.manifest.title,
    description: comparison.manifest.description,
    provenance: comparison.manifest.provenance,
    compatibility: comparison.compatibility,
    apps,
  };
}
