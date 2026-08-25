import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadComparison } from "../comparison.mjs";
import { buildSiteModel } from "./model.mjs";
import { p95EqualsSampledMaximum } from "../statistics.mjs";
import { PROCESS_FAMILY_CPU_DEFINITION } from "../summarize.mjs";
import { chart, disclosures, escapeHtml, format, page } from "./html.mjs";

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
  const appStart = startStatus.status === "valid"
    ? renderAppStartP95(model.apps.filter((app) => app.appStart))
    : comparisonUnavailable("Application start", startStatus, model.apps, "appStart");
  const memory = switchStatus.status === "valid"
    ? renderMemoryP95(model.apps.filter((app) => app.sessionSwitch))
    : comparisonUnavailable("Memory", switchStatus, model.apps, "sessionSwitch");
  const navigationComparison = pairedScenarioSection(model, "sessionNavigation", "Session navigation", renderSessionNavigationComparison);
  const workspacePanelComparison = pairedScenarioSection(model, "workspacePanel", "Workspace panel", renderWorkspacePanelComparison);
  const hasSystemScenarios = model.apps.some((app) => app.appStart || app.sessionSwitch);
  const environment = model.apps[0]?.environment;
  const validScenarios = Object.values(model.compatibility).filter((item) => item.status === "valid").length;
  const totalScenarios = Object.keys(model.compatibility).length;
  const scheduleOrder = model.schedule.map((step) => `${step.ordinal}. ${step.appId} / ${step.scenarioId}`).join(" → ");
  const revisions = model.frameworkRevisions.map((revision) => `<code>${escapeHtml(shortRevision(revision))}</code>`).join(", ");
  const repetitionLabel = `${model.repetitions ?? "—"} ${model.repetitions === 1 ? "repetition" : "repetitions"}`;
  const statisticExplanation = model.p95Disclosure?.note
    ?? `Nearest-rank p95 is the primary statistic for every distributional comparison at ${repetitionLabel}.`;
  const systemNavigation = hasSystemScenarios ? `<a href="#application-start">App start</a><a href="#memory">Memory &amp; CPU</a>` : "";
  const body = `<section class="hero" id="overview"><p class="eyebrow">Controlled desktop comparison · lower is better</p><h1>${escapeHtml(model.title)}</h1><p>${escapeHtml(model.description ?? "Same-machine comparison of completed-session GUI performance.")}</p><div class="run-stamp"><span><b>${model.repetitions ?? "—"}</b> ${model.repetitions === 1 ? "repetition" : "repetitions"}</span><span><b>${escapeHtml(model.primaryStatistic)}</b> primary</span><span><b>${validScenarios}/${totalScenarios}</b> paired scenarios</span><span><b>${escapeHtml(model.runProfile ?? "—")}</b> profile</span></div></section><nav class="section-nav" aria-label="Report sections"><a href="#overview">Overview</a>${systemNavigation}<a href="#session-navigation">Session navigation</a><a href="#workspace-panel">Workspace panel</a><a href="#method">Method</a></nav><section class="fairness" aria-labelledby="fairness-title"><div><p class="kicker">Fairness ledger</p><h2 id="fairness-title">Same work, same machine, mirrored order.</h2><p>${escapeHtml(statisticExplanation)}</p></div><dl><div><dt>Host</dt><dd>${escapeHtml(environment ? `${environment.cpuModel} · ${environment.logicalCpuCount} logical CPUs · ${formatMemory(environment.totalMemoryBytes)} RAM · ${environment.platform}/${environment.architecture}` : "Not supplied")}</dd></div><div><dt>Order control</dt><dd>Balanced mirrored schedule across every paired scenario.</dd></div><div><dt>Corpus and cases</dt><dd>Compatibility validation requires identical framework revision, scenario, corpus, profile, repetition count, and host identity.</dd></div><div><dt>Materialization</dt><dd>Each app uses its registered production path. Native and translated mappings are disclosed; unsupported product contracts are not scored as zero.</dd></div></dl></section><nav class="app-grid" aria-label="Application identity and individual reports">${cards}</nav>${hasSystemScenarios ? `<section class="benchmark-section system-performance"><div class="flow-heading"><p class="kicker">System envelope</p><h2>Launch, memory, and CPU</h2><p>Cold and initialized process launch are measured separately. Memory and CPU are summed across each declared application process family across a baseline idle window, the progressive historical-session workload, and an ending idle window.</p></div>${appStart}${memory}</section>` : ""}${navigationComparison}${workspacePanelComparison}<section class="method" id="method"><div class="flow-heading"><p class="kicker">Method and provenance</p><h2>What makes the comparison comparable</h2></div><div class="method-grid"><section><h3>Run identity</h3><dl class="compact-list"><div><dt>Provenance</dt><dd>${escapeHtml(model.provenance)}</dd></div><div><dt>Framework revision</dt><dd>${revisions || "—"}</dd></div><div><dt>Run profile</dt><dd>${escapeHtml(model.runProfile ?? "—")}</dd></div><div><dt>Primary statistic</dt><dd>${escapeHtml(model.primaryStatistic)}</dd></div></dl></section><section><h3>Execution order</h3><p class="schedule">${escapeHtml(scheduleOrder || "No paired schedule supplied.")}</p></section></div><div class="notice"><strong>Scope.</strong> This report measures packaged GUI flows over pinned completed-session data. It does not measure Web Vitals, model or harness speed, live streaming output, live tool execution, or terminal coding agents.</div></section>`;
  return page({ title: model.title, current: "index", body });
}

function renderApp(model, app) {
  const sections = [disclosures(app)];
  if (app.appStart) sections.push(renderAppStartP95([app]));
  if (app.sessionSwitch) sections.push(renderMemoryP95([app]));
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

function renderAppStartP95(apps) {
  const rows = [
    navigationMatrixRow(
      "Cold app start",
      "new application state",
      apps,
      (app) => app.appStart.derivation.summary["new-application-state"],
      "p95",
    ),
    navigationMatrixRow(
      "Initialized app start",
      "existing application state",
      apps,
      (app) => app.appStart.derivation.summary["initialized-application-state"],
      "p95",
    ),
  ].join("");
  return `<section class="matrix" id="application-start"><div class="matrix-heading"><h3>Application start</h3><p>Process spawn → painted, input-ready application</p></div><div class="table-scroll"><table><caption>Application-start p95 latency in milliseconds</caption><thead><tr><th scope="col">State</th><th scope="col">Starting condition</th>${comparisonHeaders(apps, "P95")}<th scope="col">Relative result</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderMemoryP95(apps) {
  const window = (app, id, metric) => app.resourceWindows?.windows?.[id]?.[metric];
  const inventoryRows = [
    resourceMatrixRow("Baseline idle p95 RSS", "1 MiB control session ready · idle window", apps, (app) => window(app, "baseline", "rssP95MiB"), "p95", "MiB"),
    resourceMatrixRow("Active workload p95 RSS", "progressive 1 → 128 MiB historical-session switches", apps, (app) => window(app, "active", "rssP95MiB"), "p95", "MiB"),
    resourceMatrixRow("Active sampled maximum RSS", "diagnostic · largest observed sample, not an operating-system true peak", apps, (app) => window(app, "active", "rssMaximumMiB"), "maximum", "MiB"),
    resourceMatrixRow("Ending idle p95 RSS", "returned to the same 1 MiB control session · idle window", apps, (app) => window(app, "ending", "rssP95MiB"), "p95", "MiB"),
    retainedGrowthRow(apps),
    resourceMatrixRow("Baseline idle p95 CPU", "process-family CPU across the baseline idle window", apps, (app) => window(app, "baseline", "cpuP95Percent"), "p95", "%"),
    resourceMatrixRow("Active workload p95 CPU", "process-family CPU across the active workload window", apps, (app) => window(app, "active", "cpuP95Percent"), "p95", "%"),
    resourceMatrixRow("Ending idle p95 CPU", "process-family CPU across the ending idle window", apps, (app) => window(app, "ending", "cpuP95Percent"), "p95", "%"),
  ].join("");
  const steps = [...new Set(apps.flatMap((app) => (app.resourceStepTrend ?? []).map((point) => point.transcriptBytes)))].toSorted((left, right) => left - right);
  const stepMetric = (app, bytes, key) => (app.resourceStepTrend ?? []).find((point) => point.transcriptBytes === bytes)?.[key];
  const rssStepRows = steps.map((bytes) => resourceMatrixRow("p95 summed RSS after step", formatBytes(bytes), apps, (app) => stepMetric(app, bytes, "rssMiB"), "p95", "MiB")).join("");
  const cpuStepRows = steps.map((bytes) => resourceMatrixRow("p95 process-family CPU during step", formatBytes(bytes), apps, (app) => stepMetric(app, bytes, "cpuPercent"), "p95", "%")).join("");
  const stepSeries = (key) => apps.map((app, colorIndex) => ({
    label: app.name,
    colorIndex,
    points: (app.resourceStepTrend ?? []).map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point[key], "p95") })),
  }));
  const invalid = apps.flatMap((app) => {
    const reasons = new Set();
    if (app.sessionSwitch?.resources?.status !== "valid") reasons.add(app.sessionSwitch?.resources?.reason ?? "the resource monitor did not produce a valid result");
    if (app.resourceWindows?.status !== "valid") reasons.add(app.resourceWindows?.reason ?? "the raw resource trace could not be summarized");
    return [...reasons].map((reason) => `${app.name}: ${reason}`);
  });
  const headers = comparisonHeaders(apps, "P95");
  return `<section class="matrix" id="memory"><div class="matrix-heading"><h3>Memory and CPU under historical-session load</h3><p>Summed application process family · lower is better</p></div>${invalid.length > 0 ? `<p class="status invalid">${escapeHtml(invalid.join("; "))}</p>` : ""}<div class="result-note"><strong>Idle means ready, not empty.</strong> Both idle windows hold the same fixed 1 MiB control session, fully loaded and visible, with no benchmark input. Sampled maximum is the largest observed framework sample and is diagnostic only; it is not an operating-system true peak. A window that lost the declared process family or recorded no sample stays Invalid with its reason and is never scored as zero.</div><div class="table-scroll"><table><caption>Process-family memory and CPU by measurement window</caption><thead><tr><th scope="col">Metric</th><th scope="col">Measurement window</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${inventoryRows}</tbody></table></div><div class="table-scroll"><table><caption>p95 summed process-family RSS after each historical-session step</caption><thead><tr><th scope="col">Metric</th><th scope="col">History step</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${rssStepRows}</tbody></table></div>${chart("p95 summed RSS by historical-session size", stepSeries("rssMiB"), "History size (MiB)", "p95 RSS (MiB)")}<div class="table-scroll"><table><caption>p95 process-family CPU during each historical-session step</caption><thead><tr><th scope="col">Metric</th><th scope="col">History step</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${cpuStepRows}</tbody></table></div>${chart("p95 process-family CPU by historical-session size", stepSeries("cpuPercent"), "History size (MiB)", "p95 CPU (%)")}${resourceDisclosureTable(apps)}</section>`;
}

function resourceMatrixRow(flow, context, apps, metricForApp, statistic, unit) {
  const metrics = apps.map(metricForApp);
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td class="context">${escapeHtml(context)}</td>${metrics.map((metric) => metricCell(metric, statistic, unit)).join("")}<td class="verdict">${relativeResult(apps, metrics, statistic, "magnitude")}</td></tr>`;
}

function retainedGrowthRow(apps) {
  const metrics = apps.map((app) => app.resourceWindows?.retainedRssGrowthMiB);
  const values = metrics.map((metric) => metricValue(metric, "p95"));
  const verdict = values.every(Number.isFinite) ? signedRelativeResult(apps, values, "MiB") : `<span class="status invalid">Not comparable</span>`;
  return `<tr><th scope="row">Retained RSS growth</th><td class="context">ending-idle p95 − baseline-idle p95 · negative values stay visible</td>${metrics.map((metric) => metricCell(metric, "p95", "MiB")).join("")}<td class="verdict">${verdict}</td></tr>`;
}

function resourceDisclosureTable(apps) {
  const row = (label, render) => `<tr><th scope="row">${escapeHtml(label)}</th>${apps.map((app) => `<td>${escapeHtml(render(app))}</td>`).join("")}</tr>`;
  const windows = (app) => app.resourceWindows?.windows;
  const duration = (value) => Number.isFinite(value) ? `${format(value)} ms` : "not recorded";
  const evidence = (app) => app.resourceWindows?.processFamily;
  const environment = (app) => app.environment ?? {};
  const rows = [
    row("Observed sample cadence (median)", (app) => windows(app)
      ? `baseline ${duration(windows(app).baseline.observedSampleIntervalMs)} · active ${duration(windows(app).active.observedSampleIntervalMs)} · ending ${duration(windows(app).ending.observedSampleIntervalMs)}`
      : "no raw trace"),
    row("Observed window duration", (app) => windows(app)
      ? `baseline idle ${duration(windows(app).baseline.observedWindowDurationMs)} · active ${duration(windows(app).active.observedWindowDurationMs)} · ending idle ${duration(windows(app).ending.observedWindowDurationMs)}`
      : "no raw trace"),
    row("Raw samples", (app) => app.resourceWindows
      ? `${app.resourceWindows.rawSampleCount} across ${app.resourceWindows.runCount} monitored run${app.resourceWindows.runCount === 1 ? "" : "s"}`
      : "no raw trace"),
    row("Samples in each window", (app) => windows(app)
      ? `baseline ${windows(app).baseline.sampleCount} · active ${windows(app).active.sampleCount} · ending ${windows(app).ending.sampleCount}`
      : "no raw trace"),
    row("Process family", (app) => evidence(app)
      ? `${evidence(app).definition} Up to ${evidence(app).maximumObservedProcessCount} processes observed${evidence(app).observedProcessNames.length > 0 ? `: ${evidence(app).observedProcessNames.join(", ")}` : ""}.`
      : "no raw trace"),
    row("Missing-process evidence", (app) => evidence(app)
      ? `${evidence(app).samplesMissingRootProcess} samples lost the root process · ${evidence(app).samplesWithInaccessibleProcesses} had inaccessible processes · ${evidence(app).samplesMissingExternalProcesses} missed a declared external process · ${evidence(app).monitorErrorCount} monitor errors`
      : "no raw trace"),
    row("CPU definition", (app) => `${PROCESS_FAMILY_CPU_DEFINITION}. This host reports ${environment(app).logicalCpuCount ?? "an unrecorded number of"} logical CPUs, so a fully saturated host reads ${Number.isFinite(environment(app).logicalCpuCount) ? `${environment(app).logicalCpuCount * 100}%` : "logical CPU count × 100%"}.`),
    row("Host memory pressure", (app) => Number.isFinite(environment(app).memoryPressureLevel)
      ? `level ${environment(app).memoryPressureLevel}`
      : "not recorded by this run"),
    row("Host power state", (app) => `${environment(app).powerSource ?? "not recorded"}${environment(app).lowPowerMode === null || environment(app).lowPowerMode === undefined ? "" : ` · low-power mode ${environment(app).lowPowerMode ? "on" : "off"}`}`),
    row("Host free memory / load at run start", (app) => `${Number.isFinite(environment(app).freeMemoryBytes) ? `${format(environment(app).freeMemoryBytes / 1073741824)} GiB free` : "free memory not recorded"} · ${Number.isFinite(environment(app).loadAverage1mPerCpu) ? `${format(environment(app).loadAverage1mPerCpu)} load per CPU` : "load not recorded"}`),
  ].join("");
  return `<details class="technical"><summary>Resource measurement disclosures</summary><div class="table-scroll"><table><caption>Sampling, process-family, and host disclosures for the resource measurement</caption><thead><tr><th scope="col">Disclosure</th>${apps.map((app) => `<th scope="col">${escapeHtml(app.name)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function renderSessionNavigationComparison(apps, model = {}) {
  const statistic = model.primaryStatistic ?? "p95";
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
  return `<section class="benchmark-section" id="session-navigation"><div class="flow-heading"><p class="kicker">Flow 01</p><h2>Session navigation</h2><p>First visit means a session surface has not been mounted before. Return means revisiting a previously rendered session with the workspace panel closed. Panel-open returns are isolated as a separate seeded-load trend.</p></div><div class="result-note"><strong>${statisticLabel} shown.</strong> Nearest-rank p95 is reported at every repetition count, with valid / attempted counts attached to each value. Where a value has fewer than 20 valid observations its nearest-rank p95 is the sampled maximum of those observations and says so; p50, average, and maximum stay in the diagnostic drill-down.</div><section class="matrix"><div class="matrix-heading"><h3>History-size trend</h3><p>Solid lines are first visit; dashed lines are return.</p></div><div class="table-scroll"><table><caption>Session navigation ${statisticLabel} latency in milliseconds by history size</caption><thead><tr><th scope="col">Visit state</th><th scope="col">History</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${historyRows}</tbody></table></div></section>${chart(`First visit and return by history size — ${statistic}`, historySeries, "History size (MiB)", `${statistic} latency (ms)`)}<section class="matrix"><div class="matrix-heading"><h3>Return with workspace panel open</h3><p>The panel begins open with light, moderate, or heavy seeded content.</p></div><div class="table-scroll"><table><caption>Panel-open session return ${statisticLabel} latency in milliseconds</caption><thead><tr><th scope="col">Visit state</th><th scope="col">Seeded load</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${panelRows}</tbody></table></div></section>${chart(`Return with workspace panel open by seeded load — ${statistic}`, panelSeries, "Load profile (1 light, 2 moderate, 3 heavy)", `${statistic} latency (ms)`)}${unsupportedReasons(apps, "sessionNavigation")}<details class="technical"><summary>Renderer work for panel-open returns</summary><p>Durations use ${statisticLabel}; renderer counters and worst frames show their declared aggregate from the same observations.</p><div class="table-scroll"><table><caption>Panel-open renderer work</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">Duration</th><th scope="col">JavaScript</th><th scope="col">Style</th><th scope="col">Layout</th><th scope="col">Worst frame</th></tr></thead><tbody>${rendererRows}</tbody></table></div></details></section>`;
}

function renderWorkspacePanelComparison(apps, model = {}) {
  const statistic = model.primaryStatistic ?? "p95";
  const statisticLabel = statistic.toUpperCase();
  const frameStatistic = "p95";
  const actions = apps[0]?.workspacePanel?.derivation.summary.loadTrend[0]?.interactions
    ? Object.keys(apps[0].workspacePanel.derivation.summary.loadTrend[0].interactions)
    : [];
  const loadTrend = apps[0]?.workspacePanel?.derivation.summary.loadTrend ?? [];
  const rows = loadTrend.flatMap((point, loadIndex) =>
    actions.map((action) => workspaceInteractionRow(apps, loadIndex, action, point.loadProfile, statistic, frameStatistic)),
  ).join("");
  const appHeaders = apps.map((app) => `<th scope="colgroup" colspan="3"><span class="app-key app-tone-${apps.indexOf(app)}"><i aria-hidden="true"></i>${escapeHtml(app.name)}</span></th>`).join("");
  const metricHeaders = apps.map(() => `<th scope="col">Response / complete<small>${statisticLabel}</small></th><th scope="col">Frame interval<small>P95</small></th><th scope="col">Frames &gt; 16.67 ms<small>P95</small></th>`).join("");
  const matrix = `<section class="matrix"><div class="matrix-heading"><h3>All workspace interactions</h3><p>One table · latency and 60 Hz health</p></div><div class="table-scroll"><table><caption>Workspace interaction responsiveness and frame health across retained load</caption><thead><tr><th scope="col" rowspan="2">Action</th><th scope="col" rowspan="2">Load / presentation</th>${appHeaders}<th scope="col" rowspan="2">Result</th></tr><tr>${metricHeaders}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
  const shellActions = actions.filter((action) => action === "open-panel" || action === "close-panel");
  const shellSeries = apps.flatMap((app, colorIndex) => shellActions.map((action) => ({
    label: `${app.name} — ${workspaceActionLabel(action)}`,
    colorIndex,
    variant: action === "close-panel" ? "return" : undefined,
    points: app.workspacePanel.derivation.summary.loadTrend.map((point, index) => ({
      x: index + 1,
      y: metricValue(point.interactions[action]?.frames?.p95IntervalMs, frameStatistic),
    })),
  })));
  const hasFrameTrend = shellSeries.some((series) => series.points.some((point) => Number.isFinite(point.y)));
  const frameTrend = hasFrameTrend
    ? chart("Open and close frame health by retained load — p95", shellSeries, "Load profile (1 light, 2 moderate, 3 heavy)", "p95 frame interval (ms; 16.67 budget)")
    : `<section class="panel"><h3>Open and close frame health by retained load — p95</h3><p class="status invalid">No valid frame-health observation was recorded for any plotted point.</p></section>`;
  const rendererRows = apps.flatMap((app) => app.workspacePanel.derivation.summary.loadTrend.flatMap((point) => Object.entries(point.interactions).map(([action, metric]) => rendererWorkRow(
    app,
    `${workspaceActionLabel(action)} · ${point.loadProfile}`,
    metric,
    statistic,
  )))).join("");
  return `<section class="benchmark-section" id="workspace-panel"><div class="flow-heading"><p class="kicker">Flow 02</p><h2>Workspace panel</h2><p>Every interaction answers two user-facing questions: how quickly did the requested surface respond or become usable, and did rendering remain inside the 16.67 ms frame budget? Light, moderate, and heavy vary retained directory and file-tab state while keeping the same complete 24-file Review model.</p></div><div class="result-note"><strong>Animation is presentation, not speed.</strong> Open and close keep each product's production behavior. Their intentional animation duration is not used to name a latency winner; only trusted-input response and p95 frame health are scored. Other actions compare interactive completion and the same 60 Hz evidence. Setup does not scroll Review.</div><div class="result-note"><strong>Data-warm, surface-cold file opening.</strong> Each load profile owns a distinct canonical target whose bytes are warm but whose tab and preview have never mounted. The measured input owns first surface creation and paint.</div>${matrix}${frameTrend}${unsupportedReasons(apps, "workspacePanel")}<details class="technical"><summary>Renderer work and frame measurements</summary><p>Durations and renderer work use ${statisticLabel}; frame columns use P95 from the same observations. Total open/close duration remains available here as diagnostic context only.</p><div class="table-scroll"><table><caption>Workspace-panel renderer work</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">Duration</th><th scope="col">JavaScript</th><th scope="col">Style</th><th scope="col">Layout</th><th scope="col">Frame interval</th></tr></thead><tbody>${rendererRows}</tbody></table></div></details></section>`;
}

function workspaceInteractionRow(apps, loadIndex, action, loadProfile, statistic, frameStatistic) {
  const interactions = apps.map((app) => app.workspacePanel.derivation.summary.loadTrend[loadIndex]?.interactions[action]);
  const cells = interactions.map((interaction) => workspaceInteractionCells(interaction, action, statistic, frameStatistic)).join("");
  return `<tr><th scope="row">${escapeHtml(workspaceActionLabel(action))}</th><td class="context">${escapeHtml(workspacePresentationContext(apps, loadIndex, action, loadProfile))}</td>${cells}<td class="verdict">${workspaceInteractionResult(apps, interactions, action, statistic, frameStatistic)}</td></tr>`;
}

function workspaceInteractionCells(interaction, action, statistic, frameStatistic) {
  const response = action === "open-panel"
    ? interaction?.milestones?.inputToShellMs
    : action === "close-panel"
      ? interaction?.milestones?.inputToActionPaintMs
      : interaction?.durationMs;
  const responseLabel = action === "open-panel" ? "input → shell" : action === "close-panel" ? "input → closed paint · not ranked" : "interactive completion";
  return `${workspaceMetricCell(response, statistic, "ms", responseLabel)}${workspaceMetricCell(interaction?.frames?.p95IntervalMs, frameStatistic, "ms", "frame pacing")}${workspaceMetricCell(interaction?.frames?.overBudgetIntervalCount, frameStatistic, "", "over-budget frames")}`;
}

function workspaceMetricCell(metric, statistic, unit, label) {
  const value = metricValue(metric, statistic);
  if (!Number.isFinite(value)) return `<td class="metric status invalid"><strong>Withheld</strong><small>${metric?.valid ?? 0} / ${metric?.attempted ?? 0} · ${escapeHtml(label)}</small></td>`;
  return `<td class="metric"><strong>${formatWithUnit(value, unit)}</strong><small>${metric.valid} / ${metric.attempted} · ${escapeHtml(label)}${escapeHtml(sampledMaximumNote(metric, statistic))}</small></td>`;
}

function workspaceInteractionResult(apps, interactions, action, statistic, frameStatistic) {
  const frameValues = interactions.map((interaction) => metricValue(interaction?.frames?.p95IntervalMs, frameStatistic));
  const overBudgetValues = interactions.map((interaction) => metricValue(interaction?.frames?.overBudgetIntervalCount, frameStatistic));
  if (![...frameValues, ...overBudgetValues].every(Number.isFinite)) return `<span class="status invalid">Not comparable</span>`;
  const held = frameValues.map((value, index) => value <= 16.667 && overBudgetValues[index] === 0);
  const frameResult = held.every(Boolean)
    ? "Both held 60 Hz"
    : held.some(Boolean)
      ? `${apps[held.findIndex(Boolean)].name} held 60 Hz`
      : "Both exceeded 60 Hz budget";
  if (action === "open-panel" || action === "close-panel") return `<strong>${escapeHtml(frameResult)}</strong><small>animation length not scored</small>`;
  const durations = interactions.map((interaction) => interaction?.durationMs);
  const latency = relativeResult(apps, durations, statistic);
  return `${latency}<small>${escapeHtml(frameResult)}</small>`;
}

function workspacePresentationContext(apps, loadIndex, action, loadProfile) {
  if (action !== "open-panel" && action !== "close-panel") return loadProfile;
  const modes = apps.map((app) => {
    const transitionModes = app.workspacePanel.derivation.summary.loadTrend[loadIndex]?.interactions[action]?.transitionModes;
    const animated = transitionModes?.animated ?? 0;
    const none = transitionModes?.none ?? 0;
    const mode = animated === none ? "mixed" : animated > none ? "animated" : "no animation";
    return `${app.name}: ${mode}`;
  });
  return `${loadProfile} · ${modes.join("; ")}`;
}

function comparisonHeaders(apps, statisticLabel) {
  return apps.map((app) => `<th scope="col"><span class="app-key app-tone-${apps.indexOf(app)}"><i aria-hidden="true"></i>${escapeHtml(app.name)}</span><small>${escapeHtml(statisticLabel)} · valid / attempted</small></th>`).join("");
}

function navigationMatrixRow(flow, context, apps, metricForApp, statistic, unit = "ms") {
  const metrics = apps.map(metricForApp);
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td class="context">${escapeHtml(context)}</td>${metrics.map((metric) => metricCell(metric, statistic, unit)).join("")}<td class="verdict">${relativeResult(apps, metrics, statistic)}</td></tr>`;
}

function metricCell(metric, statistic, unit = "ms") {
  const value = metricValue(metric, statistic);
  if (!Number.isFinite(value)) {
    const label = metric?.status === "invalid" ? "Invalid" : "Withheld";
    const reason = metric?.reason ? ` · ${metric.reason}` : "";
    return `<td class="metric status invalid"><strong>${label}</strong><small>${metric?.valid ?? 0} / ${metric?.attempted ?? 0}${escapeHtml(reason)}</small></td>`;
  }
  return `<td class="metric"><strong>${formatWithUnit(value, unit)}</strong><small>${metric.valid} / ${metric.attempted}${escapeHtml(sampledMaximumNote(metric, statistic))}</small></td>`;
}

function formatWithUnit(value, unit) {
  if (!unit) return format(value);
  return unit === "%" ? `${format(value)}%` : `${format(value)} ${escapeHtml(unit)}`;
}

function metricValue(metric, statistic) {
  if (!metric || metric.status !== "valid") return null;
  return Number.isFinite(metric[statistic]) ? metric[statistic] : null;
}

// Nearest-rank p95 is reported at any n. Below the threshold the selected rank is the last one, so
// the value is disclosed as the sampled maximum instead of being withheld or renamed.
function sampledMaximumNote(metric, statistic) {
  return statistic === "p95" && metric?.status === "valid" && p95EqualsSampledMaximum(metric.valid) ? " · p95 = sampled max" : "";
}

function relativeResult(apps, metrics, statistic, comparison = "latency") {
  if (apps.length !== 2) return "—";
  const values = metrics.map((metric) => metricValue(metric, statistic));
  if (!values.every(Number.isFinite)) return `<span class="status invalid">Not comparable</span>`;
  const [left, right] = values;
  if (left === right) return "Tie";
  if (left <= 0 || right <= 0) return signedRelativeResult(apps, values, "");
  const winnerIndex = left < right ? 0 : 1;
  const ratio = Math.max(left, right) / Math.min(left, right);
  const percent = Math.round((1 - Math.min(left, right) / Math.max(left, right)) * 1000) / 10;
  const word = comparison === "latency" ? "faster" : "lower";
  return `<strong>${escapeHtml(apps[winnerIndex].name)}</strong><small>${formatRatio(ratio)}× ${word} · ${format(percent)}% ${word} · ${escapeHtml(apps[0].name)} ÷ ${escapeHtml(apps[1].name)} = ${formatRatio(left / right)}</small>`;
}

function signedRelativeResult(apps, values, unit) {
  if (apps.length !== 2 || !values.every(Number.isFinite)) return `<span class="status invalid">Not comparable</span>`;
  const [left, right] = values;
  if (left === right) return "Tie";
  const winnerIndex = left < right ? 0 : 1;
  return `<strong>${escapeHtml(apps[winnerIndex].name)}</strong><small>${formatWithUnit(Math.abs(left - right), unit)} lower</small>`;
}

function rendererWorkRow(app, flow, metric, statistic) {
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td>${escapeHtml(app.name)}</td>${technicalMetricCell(metric?.durationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.scriptDurationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.styleRecalcDurationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.layoutDurationMs, statistic)}${technicalMetricCell(metric?.frames?.worstIntervalMs, statistic)}</tr>`;
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

function formatRatio(value) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function shortRevision(revision) {
  return revision?.length > 12 ? revision.slice(0, 12) : revision;
}

function formatMemory(bytes) {
  return Number.isFinite(bytes) ? `${format(bytes / 1073741824)} GiB` : "unknown";
}

function workspaceActionLabel(action) {
  return action.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function comparisonUnavailable(title, compatibility, apps, property) {
  const rows = apps.map((app) => `<tr><th scope="row"><a href="apps/${escapeHtml(app.id)}/index.html">${escapeHtml(app.name)}</a></th><td>${app[property] ? "Available as an individual result" : "No result supplied"}</td></tr>`).join("");
  return `<section class="panel"><h2>${escapeHtml(title)}</h2><p class="status invalid"><strong>${escapeHtml(compatibility.status)}:</strong> ${escapeHtml(compatibility.reason)}</p><div class="table-scroll"><table><caption>Individual result availability</caption><thead><tr><th scope="col">Application</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function formatBytes(bytes) {
  return Number.isFinite(bytes) && bytes % 1048576 === 0 ? `${bytes / 1048576} MiB (${bytes} bytes)` : `${bytes} bytes`;
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
