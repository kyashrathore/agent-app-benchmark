import { P95_EQUALS_SAMPLED_MAXIMUM_BELOW } from "../statistics.mjs";
import { summarizeResourceTrendP95, summarizeResourceWindows } from "../summarize.mjs";

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
  for (const app of apps) {
    app.resourceWindows = app.sessionSwitch ? summarizeResourceWindows(app.sessionSwitch.resourceTrace, app.sessionSwitch.resources) : null;
    app.resourceStepTrend = app.sessionSwitch?.resources?.status === "valid"
      ? summarizeResourceTrendP95(app.sessionSwitch.resources.trend)
      : [];
  }
  const repetitions = comparison.results[0]?.result.repetitions ?? null;
  const runProfile = comparison.results[0]?.result.runProfile ?? null;
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
    // Every distributional comparison is nearest-rank p95 at any repetition count. A short run is
    // disclosed, never silently downgraded to a different statistic.
    primaryStatistic: "p95",
    primaryStatisticMethod: "nearest-rank",
    p95Disclosure: p95Disclosure(repetitions),
    frameworkRevisions,
    schedule,
    apps,
  };
}

function p95Disclosure(repetitions) {
  const label = Number.isInteger(repetitions) ? `${repetitions} ${repetitions === 1 ? "repetition" : "repetitions"}` : "an unrecorded repetition count";
  return {
    statistic: "p95",
    method: "nearest-rank",
    repetitions,
    equalsSampledMaximumBelowValidCount: P95_EQUALS_SAMPLED_MAXIMUM_BELOW,
    note: `Every distributional comparison reports nearest-rank p95 with its valid / attempted counts. This run schedules ${label}. Nearest-rank p95 selects the ceil(0.95 × n)-th ordered valid observation, so wherever a value has fewer than ${P95_EQUALS_SAMPLED_MAXIMUM_BELOW} valid observations its p95 is exactly the sampled maximum of those observations. Such values are marked "p95 = sampled max"; they remain p95 and are never relabelled as p50. Average, maximum, and p50 stay available as diagnostic drill-down only.`,
  };
}
