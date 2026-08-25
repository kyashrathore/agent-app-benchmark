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
      invalidReasons: Object.fromEntries(entries.map(({ result }) => [
        result.scenario.id,
        [...new Set(result.observations.filter((observation) => observation.status === "invalid").map((observation) => observation.reason))],
      ])),
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
  const repetitions = comparison.results[0]?.result.repetitions ?? null;
  const runProfile = comparison.results[0]?.result.runProfile ?? null;
  const primaryStatistic = Number.isInteger(repetitions) && repetitions >= 20 ? "p95" : "p50";
  const frameworkRevisions = [...new Set(comparison.results.map((item) => item.result.provenance.frameworkRevision))];
  const schedule = [...comparison.results]
    .toSorted((left, right) => left.result.provenance.scheduleOrdinal - right.result.provenance.scheduleOrdinal)
    .map((item) => ({
      ordinal: item.result.provenance.scheduleOrdinal,
      appId: item.result.app.id,
      scenarioId: item.result.scenario.id,
    }));
  return {
    id: comparison.manifest.id,
    title: comparison.manifest.title,
    description: comparison.manifest.description,
    provenance: comparison.manifest.provenance,
    compatibility: comparison.compatibility,
    repetitions,
    runProfile,
    primaryStatistic,
    frameworkRevisions,
    schedule,
    apps,
  };
}
