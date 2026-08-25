export function buildSiteModel(comparison) {
  const apps = [];
  const byApp = Map.groupBy(comparison.results, (item) => item.result.app.id);
  for (const [id, entries] of [...byApp.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    const first = entries[0].result;
    const appDefinition = entries[0].appDefinition;
    apps.push({
      id,
      name: first.app.name,
      version: first.app.version,
      buildDigestSha256: first.app.buildDigestSha256,
      guiFramework: appDefinition.guiFramework,
      driver: first.driver,
      sourceEventFormat: first.sourceEventFormat,
      materializationModes: [...new Set(entries.map((entry) => entry.result.materialization.mode))],
      environment: first.environment,
      scenarioProvenance: entries.map(({ result }) => ({
        scenarioId: result.scenario.id,
        driver: result.driver,
        frameworkRevision: result.provenance.frameworkRevision,
        scheduleOrdinal: result.provenance.scheduleOrdinal,
        materializationMode: result.materialization.mode,
      })).toSorted((left, right) => left.scenarioId.localeCompare(right.scenarioId)),
      appStart: entries.find((entry) => entry.result.scenario.kind === "app-start")?.result,
      sessionSwitch: entries.find((entry) => entry.result.scenario.kind === "session-switch")?.result,
      sessionNavigation: entries.find((entry) => entry.result.scenario.kind === "session-navigation")?.result,
      workspacePanel: entries.find((entry) => entry.result.scenario.id === "workspace-panel-v2")?.result,
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
