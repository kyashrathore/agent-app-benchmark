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
  const cards = model.apps.map((app) => `<a class="app-card" href="apps/${app.id}/index.html"><span>${escapeHtml(app.name)}</span><small>${escapeHtml(app.version)} · ${escapeHtml(app.guiFramework)} · ${escapeHtml(app.materializationModes.join(", "))}</small></a>`).join("");
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
  const body = `<section class="hero"><p class="eyebrow">Public comparison · ${escapeHtml(model.provenance)}</p><h1>${escapeHtml(model.title)}</h1><p>${escapeHtml(model.description ?? "Same-machine comparison of completed-session GUI performance.")}</p><div class="notice">This corpus uses pinned OpenCode events. Apps with production OpenCode history support should use it; translations are allowed and disclosed. The current entries are Electron apps, but other GUI frameworks are welcome.</div></section><nav class="app-grid" aria-label="Application reports">${cards}</nav>${appStart}${sessionComparison}${navigationComparison}${workspacePanelComparison}<section class="panel"><h2>What this benchmark does not measure</h2><p>It does not measure Web Vitals, model or harness speed, live streaming output, live tool execution, or terminal coding agents. Those require separately reviewed scenarios.</p><p>Have another useful metric? Propose its definition and scenario version in a pull request.</p></section>`;
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
  return compatibility.status === "valid" ? render(apps) : comparisonUnavailable(title, compatibility, model.apps, property);
}

function renderSessionNavigationComparison(apps) {
  const historySeries = apps.flatMap((app) => {
    const trend = app.sessionNavigation.derivation.summary.historySizeTrend;
    return [
      { label: `${app.name} — first visit`, points: trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: point.firstVisit.p95 })) },
      { label: `${app.name} — return to visited session`, points: trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: point.returnVisitedPanelClosed.p95 })) },
    ];
  });
  const panelSeries = apps.map((app) => ({
    label: app.name,
    points: app.sessionNavigation.derivation.summary.panelLoadTrend.map((point, index) => ({
      x: index + 1,
      y: point.returnVisitedPanelOpen.durationMs.p95,
    })),
  }));
  const historyRows = apps.flatMap((app) => app.sessionNavigation.derivation.summary.historySizeTrend.flatMap((point) => [
    { app: app.name, flow: `First visit · ${formatBytes(point.transcriptBytes)}`, metric: point.firstVisit },
    { app: app.name, flow: `Return · ${formatBytes(point.transcriptBytes)}`, metric: point.returnVisitedPanelClosed },
  ]));
  const panelRows = apps.flatMap((app) => app.sessionNavigation.derivation.summary.panelLoadTrend.map((point) => ({
    app: app.name,
    flow: `Return with panel open · ${point.loadProfile}`,
    metric: point.returnVisitedPanelOpen.durationMs,
  })));
  return `<section class="flow-heading"><h2>Session navigation</h2><p>Only session activation is timed. Workspace setup is excluded. Review readiness keeps complete non-truncated 24-file data and exact logical expansion state while allowing offscreen body virtualization.</p></section>${p50P95Table("Session-navigation values", [...historyRows, ...panelRows])}${chart("First visit and return by history size — p95", historySeries, "History size (MiB)", "p95 latency (ms)")}${chart("Return with workspace panel open by seeded load — p95", panelSeries, "Load profile (1 light, 2 moderate, 3 heavy)", "p95 latency (ms)")}`;
}

function renderWorkspacePanelComparison(apps) {
  const actions = apps[0]?.workspacePanel?.derivation.summary.loadTrend[0]?.interactions
    ? Object.keys(apps[0].workspacePanel.derivation.summary.loadTrend[0].interactions)
    : [];
  const charts = actions.map((action) => chart(
    `${workspaceActionLabel(action)} by seeded load — p95`,
    apps.map((app) => ({
      label: app.name,
      points: app.workspacePanel.derivation.summary.loadTrend.map((point, index) => ({
        x: index + 1,
        y: point.interactions[action].durationMs.p95,
      })),
    })),
    "Load profile (1 light, 2 moderate, 3 heavy)",
    "p95 latency (ms)",
  )).join("");
  const rows = apps.flatMap((app) => app.workspacePanel.derivation.summary.loadTrend.flatMap((point) => Object.entries(point.interactions).map(([action, metric]) => ({
    app: app.name,
    flow: `${workspaceActionLabel(action)} · ${point.loadProfile}`,
    metric: metric.durationMs,
  }))));
  return `<section class="flow-heading"><h2>Workspace panel</h2><p>Each chart is one ordinary user action; setup is seeded before timing. Review endpoints require complete non-truncated data, exact logical expansion counts, and painted interactive bodies for the current viewport—not concurrent offscreen DOM. Open-file starts with production target bytes warm but its tab and preview never mounted, so the measured input owns first surface creation and paint.</p></section>${p50P95Table("Workspace-panel values", rows)}${charts}`;
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

const SITE_CSS = `:root{--bg:#f4f2ed;--ink:#191816;--muted:#67635d;--panel:#fffefa;--line:#d9d4ca;--accent:#5a45ea;--bad:#a22934;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0;line-height:1.55}.shell{width:min(1180px,calc(100% - 32px));margin-inline:auto}.masthead{display:flex;justify-content:space-between;align-items:center;padding:22px 0}.brand{font-weight:800;color:inherit;text-decoration:none}.version,.eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.hero{padding:70px 0 36px}.hero.compact{padding-top:42px}.hero h1{font-size:clamp(2.4rem,7vw,5.6rem);line-height:.95;max-width:980px;margin:.25em 0}.hero p{max-width:760px;font-size:1.08rem}.notice{max-width:900px;border-left:4px solid var(--accent);padding:14px 18px;background:color-mix(in srgb,var(--panel) 85%,var(--accent));border-radius:0 10px 10px 0}.app-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:20px 0 36px}.app-card{display:flex;flex-direction:column;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:inherit;text-decoration:none}.app-card:hover,.app-card:focus-visible{border-color:var(--accent);outline:3px solid color-mix(in srgb,var(--accent) 25%,transparent)}.app-card span{font-size:1.35rem;font-weight:750}.app-card small{color:var(--muted)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:clamp(16px,3vw,28px);margin:18px 0}.panel h2,.panel h3{margin-top:0}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}caption{text-align:left;font-weight:650;padding:0 0 10px}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}.status.invalid{color:var(--bad)}.chart svg{width:100%;height:auto;overflow:visible}.axis{stroke:var(--muted);stroke-width:1}.chart text{fill:var(--muted);font-size:12px;text-anchor:middle}.series polyline{fill:none;stroke-width:3;stroke-linejoin:round}.series circle{fill:var(--panel);stroke-width:3}.series-0 polyline,.series-0 circle{stroke:#6f5cff}.series-1 polyline,.series-1 circle{stroke:#00a884}.series-2 polyline,.series-2 circle{stroke:#e36b34}.series-3 polyline,.series-3 circle{stroke:#b142c7}.series-4 polyline,.series-4 circle{stroke:#2878d0}.series-5 polyline,.series-5 circle{stroke:#b38b00}.series-6 polyline,.series-6 circle{stroke:#d3495f}.series-7 polyline,.series-7 circle{stroke:#087e8b}.legend{display:flex;gap:16px;flex-wrap:wrap;list-style:none;padding:0}.swatch{display:inline-block;width:18px;height:4px;vertical-align:middle;margin-right:7px}.swatch.series-0{background:#6f5cff}.swatch.series-1{background:#00a884}.swatch.series-2{background:#e36b34}.swatch.series-3{background:#b142c7}.swatch.series-4{background:#2878d0}.swatch.series-5{background:#b38b00}.swatch.series-6{background:#d3495f}.swatch.series-7{background:#087e8b}.disclosures{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.disclosures div{padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:12px}.disclosures dt{color:var(--muted);font-size:.8rem;text-transform:uppercase}.disclosures dd{margin:4px 0 0;font-weight:650;overflow-wrap:anywhere}footer{padding:42px 0;color:var(--muted)}a{color:var(--accent)}.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--panel);padding:10px;z-index:5}@media(max-width:700px){.hero{padding-top:40px}.panel{border-radius:10px}.shell{width:min(100% - 20px,1180px)}}@media(prefers-reduced-motion:no-preference){.app-card{transition:border-color .15s ease,transform .15s ease}.app-card:hover{transform:translateY(-2px)}}@media(prefers-color-scheme:dark){:root{--bg:#141311;--ink:#f4f0e8;--muted:#aaa49a;--panel:#1c1a17;--line:#38342e;--accent:#9c8dff;--bad:#ff8491}}`;
