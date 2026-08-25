import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadComparison } from "../comparison.mjs";
import { buildSiteModel } from "./model.mjs";
import { chart, disclosures, escapeHtml, format, metricTable, page } from "./html.mjs";

const MARKER = ".agent-app-benchmark-site";

export async function buildSite(comparisonFile, outputDirectory) {
  const comparison = await loadComparison(comparisonFile);
  const model = buildSiteModel(comparison);
  const output = path.resolve(outputDirectory);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomBytes(5).toString("hex")}`);
  await mkdir(path.join(temporary, "assets"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(temporary, "apps"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(temporary, "index.html"), renderIndex(model), { mode: 0o600 });
    await writeFile(path.join(temporary, "assets", "site.css"), SITE_CSS, { mode: 0o600 });
    for (const app of model.apps) {
      const directory = path.join(temporary, "apps", app.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, "index.html"), renderApp(model, app), { mode: 0o600 });
    }
    await writeFile(path.join(temporary, MARKER), `${model.id}\n`, { mode: 0o600 });
    await replaceGeneratedDirectory(output, temporary);
    return { output, model };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function renderIndex(model) {
  const cards = model.apps.map((app, index) => `<a class="app-card app-tone-${index}" href="apps/${app.id}/index.html"><span><i aria-hidden="true"></i>${escapeHtml(app.name)}</span><small>${escapeHtml(app.version)} · ${escapeHtml(app.guiFramework)} · ${escapeHtml(app.materializationModes.join(", "))}</small></a>`).join("");
  const startScenarioId = model.apps.find((app) => app.appStart)?.appStart.scenario.id;
  const switchScenarioId = model.apps.find((app) => app.sessionSwitch)?.sessionSwitch.scenario.id;
  const startStatus = model.compatibility[startScenarioId] ?? { status: "unpaired", reason: "No app-start results were supplied." };
  const switchStatus = model.compatibility[switchScenarioId] ?? { status: "unpaired", reason: "No session-switch results were supplied." };
  const startRows = model.apps.flatMap((app) => app.appStart ? [
    { label: `${app.name} — first launch`, metric: app.appStart.derivation.summary["new-application-state"] },
    { label: `${app.name} — repeat launch`, metric: app.appStart.derivation.summary["initialized-application-state"] },
  ] : []);
  const appStart = startStatus.status === "valid"
    ? metricTable("Application start", startRows, "New-process application start results")
    : comparisonUnavailable("Application start", startStatus, model.apps, "appStart");
  const laneSections = [
    ["Warm session switch — within the same workspace", "within-workspace-warm"],
    ["Cold session switch — within the same workspace", "within-workspace-cold"],
    ["Warm session switch — across workspaces", "across-workspaces-warm"],
    ["Cold session switch — across workspaces", "across-workspaces-cold"],
  ].map(([title, key]) => switchTable(title, model.apps.filter((app) => app.sessionSwitch), key)).join("");
  const latencySeries = model.apps.flatMap((app) => app.sessionSwitch ? [{ label: app.name, points: app.sessionSwitch.derivation.summary.transcriptSizeTrend.map((point) => ({ x: point.transcriptBytes / 1048576, y: point.average })) }] : []);
  const cpuSeries = model.apps.filter((app) => app.sessionSwitch?.resources?.status === "valid").map((app) => ({ label: app.name, points: averageRepeatedPoints(app.sessionSwitch.resources.trend, "cpuPercent") }));
  const memorySeries = model.apps.filter((app) => app.sessionSwitch?.resources?.status === "valid").map((app) => ({ label: app.name, points: averageRepeatedPoints(app.sessionSwitch.resources.trend, "rssMiB") }));
  const sessionComparison = switchStatus.status === "valid"
    ? `${laneSections}${chart("Session-switch latency growth", latencySeries, "Transcript size (MiB)", "Average latency (ms)")}${resourceStatus(model.apps)}${chart("CPU growth with session switching", cpuSeries, "Switch sequence", "CPU (%)")}${chart("Memory growth with session switching", memorySeries, "Switch sequence", "RSS (MiB)")}`
    : comparisonUnavailable("Session switching", switchStatus, model.apps, "sessionSwitch");
  const navigationComparison = pairedScenarioSection(model, "sessionNavigation", "Session navigation", renderSessionNavigationComparison);
  const workspacePanelComparison = pairedScenarioSection(model, "workspacePanel", "Workspace panel", renderWorkspacePanelComparison);
  const hasLegacyScenarios = model.apps.some((app) => app.appStart || app.sessionSwitch);
  const environment = model.apps[0]?.environment;
  const validScenarios = Object.values(model.compatibility).filter((item) => item.status === "valid").length;
  const totalScenarios = Object.keys(model.compatibility).length;
  const scheduleOrder = model.schedule.map((step) => `${step.ordinal}. ${step.appId} / ${step.scenarioId}`).join(" → ");
  const revisions = model.frameworkRevisions.map((revision) => `<code>${escapeHtml(shortRevision(revision))}</code>`).join(", ");
  const repetitionLabel = `${model.repetitions ?? "—"} ${model.repetitions === 1 ? "repetition" : "repetitions"}`;
  const statisticExplanation = model.primaryStatistic === "p50"
    ? `p50 is the primary statistic because this run has ${repetitionLabel}. p95 is withheld until 20 valid observations.`
    : "p95 is the primary statistic because each case has at least 20 scheduled repetitions.";
  const body = `<section class="hero" id="overview"><p class="eyebrow">Controlled desktop comparison · lower is better</p><h1>${escapeHtml(model.title)}</h1><p>${escapeHtml(model.description ?? "Same-machine comparison of completed-session GUI performance.")}</p><div class="run-stamp"><span><b>${model.repetitions ?? "—"}</b> ${model.repetitions === 1 ? "repetition" : "repetitions"}</span><span><b>${escapeHtml(model.primaryStatistic)}</b> primary</span><span><b>${validScenarios}/${totalScenarios}</b> paired scenarios</span><span><b>${escapeHtml(model.runProfile ?? "—")}</b> profile</span></div></section><nav class="section-nav" aria-label="Report sections"><a href="#overview">Overview</a><a href="#session-navigation">Session navigation</a><a href="#workspace-panel">Workspace panel</a><a href="#method">Method</a></nav><section class="fairness" aria-labelledby="fairness-title"><div><p class="kicker">Fairness ledger</p><h2 id="fairness-title">Same work, same machine, mirrored order.</h2><p>${escapeHtml(statisticExplanation)}</p></div><dl><div><dt>Host</dt><dd>${escapeHtml(environment ? `${environment.cpuModel} · ${environment.logicalCpuCount} logical CPUs · ${formatMemory(environment.totalMemoryBytes)} RAM · ${environment.platform}/${environment.architecture}` : "Not supplied")}</dd></div><div><dt>Order control</dt><dd>Balanced mirrored schedule; each app runs first once across the two flows.</dd></div><div><dt>Corpus and cases</dt><dd>Compatibility validation requires identical framework revision, scenario, corpus, profile, repetition count, and host identity.</dd></div><div><dt>Materialization</dt><dd>Each app uses its registered production path. Native and translated mappings are disclosed; unsupported product contracts are not scored as zero.</dd></div></dl></section><nav class="app-grid" aria-label="Application identity and individual reports">${cards}</nav>${hasLegacyScenarios ? `<section class="legacy"><div class="flow-heading"><p class="kicker">Additional scenarios</p><h2>Process launch and legacy session switching</h2></div>${appStart}${sessionComparison}</section>` : ""}${navigationComparison}${workspacePanelComparison}<section class="method" id="method"><div class="flow-heading"><p class="kicker">Method and provenance</p><h2>What makes the comparison comparable</h2></div><div class="method-grid"><section><h3>Run identity</h3><dl class="compact-list"><div><dt>Provenance</dt><dd>${escapeHtml(model.provenance)}</dd></div><div><dt>Framework revision</dt><dd>${revisions || "—"}</dd></div><div><dt>Run profile</dt><dd>${escapeHtml(model.runProfile ?? "—")}</dd></div><div><dt>Primary statistic</dt><dd>${escapeHtml(model.primaryStatistic)}</dd></div></dl></section><section><h3>Execution order</h3><p class="schedule">${escapeHtml(scheduleOrder || "No paired schedule supplied.")}</p></section></div><div class="notice"><strong>Scope.</strong> This report measures packaged GUI flows over pinned completed-session data. It does not measure Web Vitals, model or harness speed, live streaming output, live tool execution, or terminal coding agents.</div></section>`;
  return page({ title: model.title, current: "index", body });
}

function renderApp(model, app) {
  const sections = [disclosures(app)];
  if (app.appStart) {
    sections.push(metricTable("Application start", [
      { label: "First launch — new application state", metric: app.appStart.derivation.summary["new-application-state"] },
      { label: "Repeat launch — initialized application state", metric: app.appStart.derivation.summary["initialized-application-state"] },
    ]));
  }
  if (app.sessionSwitch) {
    const summary = app.sessionSwitch.derivation.summary;
    for (const [title, key] of [["Warm within workspace", "within-workspace-warm"], ["Cold within workspace", "within-workspace-cold"], ["Warm across workspaces", "across-workspaces-warm"], ["Cold across workspaces", "across-workspaces-cold"]]) {
      sections.push(switchTable(title, [app], key));
    }
    sections.push(chart("Latency by transcript size", [{ label: "Within workspace — cold", points: summary.transcriptSizeTrend.map((point) => ({ x: point.transcriptBytes / 1048576, y: point.average })) }], "Transcript size (MiB)", "Average latency (ms)"));
    sections.push(memoryTable(app.sessionSwitch.resources));
    if (app.sessionSwitch.resources?.status === "valid") {
      sections.push(chart("CPU growth with session switching", [{ label: app.name, points: averageRepeatedPoints(app.sessionSwitch.resources.trend, "cpuPercent") }], "Switch sequence", "CPU (%)"));
      sections.push(chart("Memory growth with session switching", [{ label: app.name, points: averageRepeatedPoints(app.sessionSwitch.resources.trend, "rssMiB") }], "Switch sequence", "RSS (MiB)"));
    }
  }
  if (app.sessionNavigation) sections.push(renderSessionNavigationComparison([app]));
  if (app.workspacePanel) sections.push(renderWorkspacePanelComparison([app]));
  const maximumMiB = app.sessionSwitch?.derivation.summary.transcriptSizeTrend.at(-1)?.transcriptBytes / 1048576;
  const activeRange = Number.isFinite(maximumMiB) ? `1 MiB through ${format(maximumMiB)} MiB` : "the configured session sizes";
  const body = `<section class="hero compact"><p class="eyebrow"><a href="../../index.html">← All applications</a></p><h1>${escapeHtml(app.name)}</h1><p>Individual result page for ${escapeHtml(model.title)}.</p></section>${sections.join("")}<section class="panel"><h2>Definitions</h2><p><strong>Active memory</strong> is measured while completed historical sessions progress across ${activeRange}. <strong>Idle</strong> means the fixed 1 MiB control transcript is fully ready with no benchmark input for the scenario's configured idle window. No live session stream is running.</p></section>`;
  return page({ title: `${app.name} · ${model.title}`, current: app.id, body });
}

function pairedScenarioSection(model, property, title, render) {
  const apps = model.apps.filter((app) => app[property]);
  if (apps.length === 0) return "";
  const scenarioId = apps[0][property].scenario.id;
  const compatibility = model.compatibility[scenarioId] ?? { status: "unpaired", reason: `No paired ${title.toLowerCase()} results were supplied.` };
  return compatibility.status === "valid" ? render(apps, model) : comparisonUnavailable(title, compatibility, model.apps, property);
}

function renderSessionNavigationComparison(apps, model = {}) {
  const statistic = model.primaryStatistic ?? primaryStatisticFor(apps[0]?.sessionNavigation?.repetitions);
  const statisticLabel = statistic.toUpperCase();
  const historySeries = apps.flatMap((app) => {
    const trend = app.sessionNavigation.derivation.summary.historySizeTrend;
    const colorIndex = apps.indexOf(app);
    return [
      { label: `${app.name} — first visit`, colorIndex, points: trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point.firstVisit, statistic) })) },
      { label: `${app.name} — return to visited session`, colorIndex, variant: "return", points: trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point.returnVisitedPanelClosed, statistic) })) },
    ];
  });
  const panelSeries = apps.map((app, colorIndex) => ({
    label: app.name,
    colorIndex,
    points: app.sessionNavigation.derivation.summary.panelLoadTrend.map((point, index) => ({
      x: index + 1,
      y: metricValue(point.returnVisitedPanelOpen.durationMs, statistic),
    })),
  }));
  const historyTrend = apps[0]?.sessionNavigation.derivation.summary.historySizeTrend ?? [];
  const historyRows = historyTrend.flatMap((point, index) => [
    navigationMatrixRow(`First visit`, formatBytes(point.transcriptBytes), apps, (app) => app.sessionNavigation.derivation.summary.historySizeTrend[index]?.firstVisit, statistic),
    navigationMatrixRow(`Return`, formatBytes(point.transcriptBytes), apps, (app) => app.sessionNavigation.derivation.summary.historySizeTrend[index]?.returnVisitedPanelClosed, statistic),
  ]).join("");
  const panelTrend = apps[0]?.sessionNavigation.derivation.summary.panelLoadTrend ?? [];
  const panelRows = panelTrend.map((point, index) => navigationMatrixRow(
    "Return with panel open",
    point.loadProfile,
    apps,
    (app) => app.sessionNavigation.derivation.summary.panelLoadTrend[index]?.returnVisitedPanelOpen.durationMs,
    statistic,
  )).join("");
  const headers = comparisonHeaders(apps, statisticLabel);
  const rendererRows = apps.flatMap((app) => app.sessionNavigation.derivation.summary.panelLoadTrend.map((point) => rendererWorkRow(
    app,
    `Return with panel open · ${point.loadProfile}`,
    point.returnVisitedPanelOpen,
    statistic,
  ))).join("");
  return `<section class="benchmark-section" id="session-navigation"><div class="flow-heading"><p class="kicker">Flow 01</p><h2>Session navigation</h2><p>First visit means a session surface has not been mounted before. Return means revisiting a previously rendered session with the workspace panel closed. Panel-open returns are isolated as a separate seeded-load trend.</p></div><div class="result-note"><strong>${statisticLabel} shown.</strong> ${statistic === "p50" ? "The median is the honest comparison at this run depth; p95 remains withheld." : "Publication-depth tail latency is available."} Valid / attempted counts remain attached to every value.</div><section class="matrix"><div class="matrix-heading"><h3>History-size trend</h3><p>Solid lines are first visit; dashed lines are return.</p></div><div class="table-scroll"><table><caption>Session navigation ${statisticLabel} latency in milliseconds by history size</caption><thead><tr><th scope="col">Visit state</th><th scope="col">History</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${historyRows}</tbody></table></div></section>${chart(`First visit and return by history size — ${statistic}`, historySeries, "History size (MiB)", `${statistic} latency (ms)`)}<section class="matrix"><div class="matrix-heading"><h3>Return with workspace panel open</h3><p>The panel begins open with light, moderate, or heavy seeded content.</p></div><div class="table-scroll"><table><caption>Panel-open session return ${statisticLabel} latency in milliseconds</caption><thead><tr><th scope="col">Visit state</th><th scope="col">Seeded load</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${panelRows}</tbody></table></div></section>${chart(`Return with workspace panel open by seeded load — ${statistic}`, panelSeries, "Load profile (1 light, 2 moderate, 3 heavy)", `${statistic} latency (ms)`)}${unsupportedReasons(apps, "sessionNavigation")}<details class="technical"><summary>Renderer work for panel-open returns</summary><p>Durations use ${statisticLabel}; renderer counters and worst frames show their declared aggregate from the same observations.</p><div class="table-scroll"><table><caption>Panel-open renderer work</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">Duration</th><th scope="col">JavaScript</th><th scope="col">Style</th><th scope="col">Layout</th><th scope="col">Worst frame</th></tr></thead><tbody>${rendererRows}</tbody></table></div></details></section>`;
}

function renderWorkspacePanelComparison(apps, model = {}) {
  const statistic = model.primaryStatistic ?? primaryStatisticFor(apps[0]?.workspacePanel?.repetitions);
  const statisticLabel = statistic.toUpperCase();
  const actions = apps[0]?.workspacePanel?.derivation.summary.loadTrend[0]?.interactions
    ? Object.keys(apps[0].workspacePanel.derivation.summary.loadTrend[0].interactions)
    : [];
  const loadTrend = apps[0]?.workspacePanel?.derivation.summary.loadTrend ?? [];
  const matrices = loadTrend.map((point, loadIndex) => {
    const rows = actions.map((action) => navigationMatrixRow(
      workspaceActionLabel(action),
      point.loadProfile,
      apps,
      (app) => app.workspacePanel.derivation.summary.loadTrend[loadIndex]?.interactions[action]?.durationMs,
      statistic,
    )).join("");
    return `<section class="matrix"><div class="matrix-heading"><h3>${escapeHtml(workspaceLoadLabel(point.loadProfile))} load</h3><p>${escapeHtml(point.loadProfile)} fixture</p></div><div class="table-scroll"><table><caption>Workspace actions under ${escapeHtml(point.loadProfile)} load; ${statisticLabel} latency in milliseconds</caption><thead><tr><th scope="col">Action</th><th scope="col">Load</th>${comparisonHeaders(apps, statisticLabel)}<th scope="col">Relative result</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }).join("");
  const shellActions = actions.filter((action) => action === "open-panel" || action === "close-panel");
  const shellSeries = apps.flatMap((app, colorIndex) => shellActions.map((action) => ({
    label: `${app.name} — ${workspaceActionLabel(action)}`,
    colorIndex,
    variant: action === "close-panel" ? "return" : undefined,
    points: app.workspacePanel.derivation.summary.loadTrend.map((point, index) => ({
      x: index + 1,
      y: metricValue(point.interactions[action]?.durationMs, statistic),
    })),
  })));
  const rendererRows = apps.flatMap((app) => app.workspacePanel.derivation.summary.loadTrend.flatMap((point) => Object.entries(point.interactions).map(([action, metric]) => rendererWorkRow(
    app,
    `${workspaceActionLabel(action)} · ${point.loadProfile}`,
    metric,
    statistic,
  )))).join("");
  return `<section class="benchmark-section" id="workspace-panel"><div class="flow-heading"><p class="kicker">Flow 02</p><h2>Workspace panel</h2><p>The panel shell and each ordinary interaction are timed separately after their declared fixture is seeded. Review readiness requires complete non-truncated data, exact logical expansion state, and painted interactive bodies for the current viewport—not concurrent offscreen DOM.</p></div><div class="result-note"><strong>Data-warm, surface-cold.</strong> Open-file begins with production target bytes warm, but its tab and preview have never mounted. The measured input owns first surface creation and paint.</div>${matrices}${shellSeries.length > 0 ? chart(`Panel shell open and close by seeded load — ${statistic}`, shellSeries, "Load profile (1 light, 2 moderate, 3 heavy)", `${statistic} latency (ms)`) : ""}${unsupportedReasons(apps, "workspacePanel")}<details class="technical"><summary>All renderer work and frame measurements</summary><p>This audit table keeps CPU attribution available without making it the reading path for the user-facing latency result.</p><div class="table-scroll"><table><caption>Workspace-panel renderer work</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">Duration</th><th scope="col">JavaScript</th><th scope="col">Style</th><th scope="col">Layout</th><th scope="col">Worst frame</th></tr></thead><tbody>${rendererRows}</tbody></table></div></details></section>`;
}

function comparisonHeaders(apps, statisticLabel) {
  return apps.map((app) => `<th scope="col"><span class="app-key app-tone-${apps.indexOf(app)}"><i aria-hidden="true"></i>${escapeHtml(app.name)}</span><small>${escapeHtml(statisticLabel)} · valid / attempted</small></th>`).join("");
}

function navigationMatrixRow(flow, context, apps, metricForApp, statistic) {
  const metrics = apps.map(metricForApp);
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td class="context">${escapeHtml(context)}</td>${metrics.map((metric) => metricCell(metric, statistic)).join("")}<td class="verdict">${relativeResult(apps, metrics, statistic)}</td></tr>`;
}

function metricCell(metric, statistic) {
  const value = metricValue(metric, statistic);
  if (!Number.isFinite(value)) {
    const label = metric?.status === "invalid" ? "Unsupported" : statistic === "p95" ? "Withheld" : "Unavailable";
    return `<td class="metric status invalid"><strong>${label}</strong><small>${metric?.valid ?? 0} / ${metric?.attempted ?? 0}</small></td>`;
  }
  return `<td class="metric"><strong>${format(value)} ms</strong><small>${metric.valid} / ${metric.attempted}</small></td>`;
}

function metricValue(metric, statistic) {
  if (!metric || metric.status !== "valid") return null;
  return Number.isFinite(metric[statistic]) ? metric[statistic] : null;
}

function relativeResult(apps, metrics, statistic) {
  if (apps.length !== 2) return "—";
  const values = metrics.map((metric) => metricValue(metric, statistic));
  if (!values.every(Number.isFinite)) return `<span class="status invalid">Not comparable</span>`;
  const [left, right] = values;
  if (left === right) return "Tie";
  const winnerIndex = left < right ? 0 : 1;
  const ratio = Math.max(left, right) / Math.min(left, right);
  return `<strong>${escapeHtml(apps[winnerIndex].name)}</strong><small>${formatRatio(ratio)}× faster</small>`;
}

function rendererWorkRow(app, flow, metric, statistic) {
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td>${escapeHtml(app.name)}</td>${technicalMetricCell(metric?.durationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.scriptDurationMs, "average")}${technicalMetricCell(metric?.rendererWork?.styleRecalcDurationMs, "average")}${technicalMetricCell(metric?.rendererWork?.layoutDurationMs, "average")}${technicalMetricCell(metric?.frames?.worstIntervalMs, "maximum")}</tr>`;
}

function technicalMetricCell(metric, statistic) {
  const value = metricValue(metric, statistic);
  return `<td class="${Number.isFinite(value) ? "" : "status invalid"}">${Number.isFinite(value) ? `${format(value)} ms` : "—"}</td>`;
}

function unsupportedReasons(apps, property) {
  const rows = apps.flatMap((app) => {
    const scenarioId = app[property]?.scenario.id;
    return (app.invalidReasons?.[scenarioId] ?? []).map((reason) => `<li><strong>${escapeHtml(app.name)}</strong><code>${escapeHtml(reason)}</code></li>`);
  });
  if (rows.length === 0) return "";
  return `<aside class="unsupported" aria-labelledby="${escapeHtml(property)}-unsupported"><p class="kicker">Unsupported is not zero</p><h3 id="${escapeHtml(property)}-unsupported">Product-contract exclusions</h3><p>These observations are excluded from ratios and winner statements. The benchmark recorded the exact driver reason:</p><ul>${rows.join("")}</ul></aside>`;
}

function primaryStatisticFor(repetitions) {
  return Number.isInteger(repetitions) && repetitions >= 20 ? "p95" : "p50";
}

function workspaceLoadLabel(loadProfile) {
  return ({ light: "Light", moderate: "Moderate", heavy: "Heavy" })[loadProfile] ?? workspaceActionLabel(loadProfile);
}

function formatRatio(value) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function shortRevision(revision) {
  return revision?.length > 12 ? revision.slice(0, 12) : revision;
}

function formatMemory(bytes) {
  return Number.isFinite(bytes) ? `${format(bytes / 1073741824)} GiB` : "unknown";
}

function p50P95Table(title, rows) {
  const body = rows.map((row) => `<tr><th scope="row">${escapeHtml(row.flow)}</th><td>${escapeHtml(row.app)}</td><td>${format(row.metric?.p50)} ms</td><td>${format(row.metric?.p95)} ms</td><td>${row.metric?.valid ?? 0} / ${row.metric?.attempted ?? 0}</td></tr>`).join("");
  return `<section class="panel"><h3>${escapeHtml(title)}</h3><div class="table-scroll"><table><caption>${escapeHtml(title)}; p50 and p95 are primary</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">Valid / attempted</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function workspaceActionLabel(action) {
  return action.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function switchTable(title, apps, key) {
  const appHeaders = apps.map((app) => `<th scope="colgroup" colspan="4">${escapeHtml(app.name)}</th>`).join("");
  const metricHeaders = apps.map(() => "<th scope=\"col\">Average</th><th scope=\"col\">Maximum</th><th scope=\"col\">p95</th><th scope=\"col\">Valid / attempted</th>").join("");
  const size = apps[0]?.sessionSwitch.derivation.summary[key].transcriptBytes;
  const row = `<tr><th scope="row">${formatBytes(size)}</th>${apps.map((app) => switchMetricCells(app.sessionSwitch.derivation.summary[key])).join("")}</tr>`;
  return `<section class="panel"><h3>${escapeHtml(title)}</h3><div class="table-scroll"><table><caption>${escapeHtml(title)} at the fixed standard transcript</caption><thead><tr><th scope="col" rowspan="2">Transcript size</th>${appHeaders}</tr><tr>${metricHeaders}</tr></thead><tbody>${row}</tbody></table></div></section>`;
}

function switchMetricCells(metric) {
  if (!metric || metric.status !== "valid") return `<td colspan="3" class="status invalid">${escapeHtml(metric?.reason ?? "Unavailable")}</td><td>${metric?.valid ?? 0} / ${metric?.attempted ?? 0}</td>`;
  return `<td>${format(metric.average)} ms</td><td>${format(metric.maximum)} ms</td><td>${format(metric.p95)} ms</td><td>${metric.valid} / ${metric.attempted}</td>`;
}

function comparisonUnavailable(title, compatibility, apps, property) {
  const rows = apps.map((app) => `<tr><th scope="row"><a href="apps/${escapeHtml(app.id)}/index.html">${escapeHtml(app.name)}</a></th><td>${app[property] ? "Available as an individual result" : "No result supplied"}</td></tr>`).join("");
  return `<section class="panel"><h2>${escapeHtml(title)}</h2><p class="status invalid"><strong>${escapeHtml(compatibility.status)}:</strong> ${escapeHtml(compatibility.reason)}</p><div class="table-scroll"><table><caption>Individual result availability</caption><thead><tr><th scope="col">Application</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function resourceStatus(apps) {
  const rows = apps.map((app) => {
    const resources = app.sessionSwitch?.resources;
    const status = resources?.status === "valid" ? "Valid" : `Invalid: ${resources?.reason ?? "not measured"}`;
    return `<tr><th scope="row">${escapeHtml(app.name)}</th><td class="${resources?.status === "valid" ? "" : "status invalid"}">${escapeHtml(status)}</td></tr>`;
  }).join("");
  return `<section class="panel"><h3>CPU and memory measurement status</h3><div class="table-scroll"><table><caption>Resource result availability for every application</caption><thead><tr><th scope="col">Application</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function formatBytes(bytes) {
  return Number.isFinite(bytes) && bytes % 1048576 === 0 ? `${bytes / 1048576} MiB (${bytes} bytes)` : `${bytes} bytes`;
}

function memoryTable(resources) {
  if (!resources || resources.status !== "valid") return `<section class="panel"><h3>Memory consumption</h3><p class="status invalid">${escapeHtml(resources?.reason ?? "Unavailable")}</p></section>`;
  const rows = [
    ["Baseline idle average", resources.baselineIdleAverageRssMiB, "Configured idle window on the ready 1 MiB control transcript before switching"],
    ["Active average", resources.activeAverageRssMiB, "Average during the progressive session-switch workload"],
    ["Active sampled maximum", resources.activeMaximumRssMiB, "Largest observed active process-family RSS sample; not an operating-system true peak"],
    ["Active p95", resources.activeP95RssMiB, "Nearest-rank p95 of active samples"],
    ["Ending idle average", resources.endingIdleAverageRssMiB, "Configured idle window after returning to the same control transcript"],
    ["Retained RSS growth", resources.retainedRssGrowthMiB, "Ending idle average minus baseline idle average"],
  ];
  return `<section class="panel"><h3>Memory consumption</h3><div class="table-scroll"><table><caption>Whole-application memory result</caption><thead><tr><th scope="col">Metric</th><th scope="col">Summed RSS</th><th scope="col">Definition</th></tr></thead><tbody>${rows.map(([label, value, description]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${format(value)} MiB</td><td>${escapeHtml(description)}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function averageRepeatedPoints(points, valueKey) {
  const grouped = Map.groupBy(points, (point) => point.switchSequence);
  return [...grouped].toSorted(([left], [right]) => left - right).map(([x, values]) => ({
    x,
    y: values.reduce((total, point) => total + point[valueKey], 0) / values.length,
  }));
}

async function replaceGeneratedDirectory(output, temporary) {
  let exists = false;
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Site output must be a real directory.");
    exists = true;
    const marker = await lstat(path.join(output, MARKER));
    if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Refusing to replace a directory not generated by this benchmark.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    if (exists) throw new Error("Refusing to replace a directory not generated by this benchmark.");
  }
  if (!exists) {
    await rename(temporary, output);
    return;
  }
  const backup = `${output}.previous-${process.pid}`;
  await rename(output, backup);
  try {
    await rename(temporary, output);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rename(backup, output);
    throw error;
  }
}

const SITE_CSS = `:root{--paper:#f3f0e8;--surface:#fbfaf6;--ink:#171816;--muted:#676a63;--line:#cbc9bf;--line-strong:#96988f;--clax:#4258c9;--t3:#19856e;--accent:#4258c9;--bad:#9b3434;--soft-bad:#f6e8e5;font-family:"Avenir Next",Avenir,"Segoe UI",ui-sans-serif,system-ui,sans-serif;color:var(--ink);background:var(--paper);font-variant-numeric:tabular-nums}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:72px}body{margin:0;line-height:1.5;background:linear-gradient(180deg,#ebe7db 0,#f3f0e8 340px)}.shell{width:min(1220px,calc(100% - 40px));margin-inline:auto}.masthead{display:flex;justify-content:space-between;align-items:center;padding:20px 0;border-bottom:1px solid var(--line)}.brand{font-weight:750;letter-spacing:-.01em;color:inherit;text-decoration:none}.version,.eyebrow,.kicker{font-size:.72rem;font-weight:750;text-transform:uppercase;letter-spacing:.14em;color:var(--muted)}.hero{padding:68px 0 26px}.hero.compact{padding-top:42px}.hero h1,.flow-heading h2,.fairness h2{font-family:Iowan Old Style,Palatino Linotype,Book Antiqua,Palatino,ui-serif,serif;font-weight:600;letter-spacing:-.035em}.hero h1{font-size:clamp(2.65rem,7vw,6.4rem);line-height:.91;max-width:1080px;margin:.16em 0 .24em}.hero>p:not(.eyebrow){max-width:760px;font-size:1.08rem;color:var(--muted)}.run-stamp{display:flex;flex-wrap:wrap;border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line);margin-top:34px}.run-stamp span{padding:12px 22px 12px 0;margin-right:22px;color:var(--muted)}.run-stamp b{display:block;color:var(--ink);font-size:1.12rem}.section-nav{position:sticky;top:0;z-index:4;display:flex;gap:4px;overflow-x:auto;margin:0 -10px;padding:8px 10px;border-bottom:1px solid var(--line);background:rgba(243,240,232,.94);backdrop-filter:blur(12px)}.section-nav a{padding:8px 12px;color:var(--muted);font-size:.84rem;font-weight:700;text-decoration:none;white-space:nowrap}.section-nav a:hover,.section-nav a:focus-visible{color:var(--ink);background:var(--surface)}.fairness{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,1.6fr);gap:clamp(28px,6vw,86px);padding:56px 0 38px;border-bottom:1px solid var(--line-strong)}.fairness h2{font-size:clamp(2rem,4vw,3.7rem);line-height:1;margin:.25em 0}.fairness p{color:var(--muted)}.fairness dl,.compact-list{margin:0}.fairness dl div,.compact-list div{display:grid;grid-template-columns:150px 1fr;gap:18px;padding:12px 0;border-bottom:1px solid var(--line)}dt{color:var(--muted);font-size:.75rem;font-weight:750;text-transform:uppercase;letter-spacing:.08em}dd{margin:0;overflow-wrap:anywhere}.app-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0;margin:28px 0 72px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.app-card{display:flex;flex-direction:column;padding:16px 18px;color:inherit;text-decoration:none;border-right:1px solid var(--line)}.app-card:last-child{border-right:0}.app-card:hover,.app-card:focus-visible{background:var(--surface);outline:2px solid var(--accent);outline-offset:-2px}.app-card span{font-size:1.1rem;font-weight:750}.app-card small,.app-key small{color:var(--muted)}.app-card i,.app-key i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px;background:var(--accent)}.app-tone-0 i{background:var(--clax)}.app-tone-1 i{background:var(--t3)}.benchmark-section,.method,.legacy{padding:30px 0 72px;border-bottom:1px solid var(--line-strong)}.flow-heading{display:grid;grid-template-columns:120px minmax(260px,.75fr) minmax(300px,1fr);gap:22px;align-items:start;margin:34px 0}.flow-heading .kicker{margin-top:14px}.flow-heading h2{font-size:clamp(2.2rem,4.5vw,4.4rem);line-height:.95;margin:0}.flow-heading>p:last-child{margin:8px 0;color:var(--muted);max-width:620px}.result-note,.notice{border-left:3px solid var(--accent);padding:13px 18px;margin:20px 0 32px;background:var(--surface)}.matrix,.panel,.chart{margin:24px 0;padding:0;background:transparent;border:0;border-radius:0}.matrix-heading{display:flex;justify-content:space-between;align-items:baseline;gap:20px;padding-bottom:10px;border-bottom:1px solid var(--line-strong)}.matrix-heading h3,.panel h2,.panel h3,.chart h3{margin:0;font-size:1.12rem}.matrix-heading p{margin:0;color:var(--muted);font-size:.85rem}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px}caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}thead th{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);border-bottom:1px solid var(--line-strong)}th:first-child,td:first-child{text-align:left}tbody th{font-weight:700}.context{color:var(--muted);text-align:left}.metric strong,.verdict strong{display:block;white-space:nowrap}.metric small,.verdict small,th small{display:block;margin-top:2px;color:var(--muted);font-size:.72rem;font-weight:500;text-transform:none;letter-spacing:0}.app-key{white-space:nowrap}.status.invalid{color:var(--bad)}.unsupported{margin:32px 0;padding:22px 24px;background:var(--soft-bad);border-top:2px solid var(--bad)}.unsupported h3{margin:.2em 0}.unsupported>p:not(.kicker){color:#6d4742}.unsupported ul{padding-left:20px}.unsupported li+li{margin-top:14px}.unsupported code{display:block;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.74rem;color:var(--ink)}.technical{margin:24px 0;border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong);padding:14px 0}.technical summary{cursor:pointer;font-weight:750}.technical>p{color:var(--muted)}.chart{padding:18px 0 28px}.chart svg{width:100%;max-height:430px;overflow:visible}.axis{stroke:var(--line-strong);stroke-width:1}.chart text{fill:var(--muted);font-size:12px;text-anchor:middle}.series polyline{fill:none;stroke-width:3;stroke-linejoin:round}.series circle{fill:var(--surface);stroke-width:3}.series-return polyline{stroke-dasharray:8 6}.series-return circle{fill:var(--paper)}.series-0 polyline,.series-0 circle{stroke:var(--clax)}.series-1 polyline,.series-1 circle{stroke:var(--t3)}.series-2 polyline,.series-2 circle{stroke:#bd6b2f}.series-3 polyline,.series-3 circle{stroke:#9741a8}.series-4 polyline,.series-4 circle{stroke:#2678a8}.series-5 polyline,.series-5 circle{stroke:#9c7b17}.series-6 polyline,.series-6 circle{stroke:#b14a5e}.series-7 polyline,.series-7 circle{stroke:#596b2b}.legend{display:flex;gap:16px;flex-wrap:wrap;list-style:none;padding:0}.swatch{display:inline-block;width:20px;height:3px;vertical-align:middle;margin-right:7px;background:var(--line-strong)}.swatch.series-0{background:var(--clax)}.swatch.series-1{background:var(--t3)}.swatch.series-2{background:#bd6b2f}.swatch.series-3{background:#9741a8}.swatch.series-4{background:#2678a8}.swatch.series-5{background:#9c7b17}.swatch.series-6{background:#b14a5e}.swatch.series-7{background:#596b2b}.swatch.series-return{height:2px;background:repeating-linear-gradient(90deg,currentColor 0 7px,transparent 7px 11px)}.method-grid{display:grid;grid-template-columns:1fr 1fr;gap:36px}.method-grid section{border-top:1px solid var(--line-strong);padding-top:14px}.schedule,code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}.schedule{font-size:.8rem;line-height:1.8;overflow-wrap:anywhere}.disclosures{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:24px 0}.disclosures div{padding:14px;border-right:1px solid var(--line)}.disclosures dd{margin:4px 0 0;font-weight:650}.panel{padding:18px 0}.panel>p{color:var(--muted)}footer{padding:42px 0;color:var(--muted);font-size:.8rem}a{color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--surface);padding:10px;z-index:8}@media(max-width:800px){.shell{width:min(100% - 24px,1220px)}.hero{padding-top:42px}.fairness,.flow-heading,.method-grid{grid-template-columns:1fr}.flow-heading{gap:8px}.flow-heading .kicker{margin-bottom:0}.fairness dl div{grid-template-columns:110px 1fr}.app-grid{grid-template-columns:1fr}.app-card{border-right:0;border-bottom:1px solid var(--line)}.app-card:last-child{border-bottom:0}.section-nav{margin-inline:-12px}.matrix-heading{display:block}.matrix-heading p{margin-top:4px}}@media(prefers-reduced-motion:no-preference){.hero,.fairness,.app-grid{animation:reveal .35s ease both}.fairness{animation-delay:.05s}.app-grid{animation-delay:.1s}@keyframes reveal{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media(prefers-color-scheme:dark){:root{--paper:#151714;--surface:#1d201c;--ink:#f0eee6;--muted:#a8aaa1;--line:#343830;--line-strong:#686d62;--clax:#8da0ff;--t3:#63c8ae;--accent:#8da0ff;--bad:#ff9992;--soft-bad:#321f1d}body{background:linear-gradient(180deg,#10120f 0,#151714 340px)}.section-nav{background:rgba(21,23,20,.94)}.unsupported>p:not(.kicker){color:#d2aaa4}}`;
