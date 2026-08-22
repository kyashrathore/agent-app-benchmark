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
  const cards = model.apps.map((app) => `<a class="app-card" href="apps/${app.id}/index.html"><span>${escapeHtml(app.name)}</span><small>${escapeHtml(app.version)} · ${escapeHtml(app.materializationModes.join(", "))}</small></a>`).join("");
  const startRows = model.apps.flatMap((app) => app.appStart ? [
    { label: `${app.name} — first launch`, metric: app.appStart.derivation.summary["new-application-state"] },
    { label: `${app.name} — repeat launch`, metric: app.appStart.derivation.summary["initialized-application-state"] },
  ] : []);
  const laneSections = [
    ["Warm session switch — within the same workspace", "within-workspace-warm"],
    ["Cold session switch — within the same workspace", "within-workspace-cold"],
    ["Warm session switch — across workspaces", "across-workspaces-warm"],
    ["Cold session switch — across workspaces", "across-workspaces-cold"],
  ].map(([title, key]) => metricTable(title, model.apps.filter((app) => app.sessionSwitch).map((app) => ({ label: app.name, metric: app.sessionSwitch.derivation.summary[key] })))).join("");
  const latencySeries = model.apps.flatMap((app) => app.sessionSwitch ? Object.entries(app.sessionSwitch.derivation.summary).map(([lane, metric]) => ({ label: `${app.name} · ${lane}`, points: metric.trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: point.p95 })) })) : []);
  const cpuSeries = model.apps.filter((app) => app.sessionSwitch?.resources?.status === "valid").map((app) => ({ label: app.name, points: app.sessionSwitch.resources.trend.map((point) => ({ x: point.switchSequence, y: point.cpuPercent })) }));
  const memorySeries = model.apps.filter((app) => app.sessionSwitch?.resources?.status === "valid").map((app) => ({ label: app.name, points: app.sessionSwitch.resources.trend.map((point) => ({ x: point.switchSequence, y: point.rssMiB })) }));
  const body = `<section class="hero"><p class="eyebrow">Public comparison · ${escapeHtml(model.provenance)}</p><h1>${escapeHtml(model.title)}</h1><p>${escapeHtml(model.description ?? "Same-machine comparison of completed-session GUI performance.")}</p><div class="notice">This corpus uses pinned OpenCode events. Apps with production OpenCode history support should use it; translations are allowed and disclosed. The current entries are Electron apps, but other GUI frameworks are welcome.</div></section><nav class="app-grid" aria-label="Application reports">${cards}</nav>${metricTable("Application start", startRows, "New-process application start results")}${laneSections}${chart("Session-switch latency growth", latencySeries, "Transcript size (MiB)", "p95 latency (ms)")}${chart("CPU growth with session switching", cpuSeries, "Switch sequence", "CPU (%)")}${chart("Memory growth with session switching", memorySeries, "Switch sequence", "RSS (MiB)")}<section class="panel"><h2>What this benchmark does not measure</h2><p>It does not measure Web Vitals, model or harness speed, streaming output, tool or diff rendering, or terminal coding agents. Those require separately reviewed scenarios.</p><p>Have another useful metric? Propose its definition and scenario version in a pull request.</p></section>`;
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
      sections.push(metricTable(title, [{ label: app.name, metric: summary[key] }]));
    }
    sections.push(chart("Latency by transcript size", Object.entries(summary).map(([lane, metric]) => ({ label: lane, points: metric.trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: point.p95 })) })), "Transcript size (MiB)", "p95 latency (ms)"));
    sections.push(memoryTable(app.sessionSwitch.resources));
    if (app.sessionSwitch.resources?.status === "valid") {
      sections.push(chart("CPU growth with session switching", [{ label: app.name, points: app.sessionSwitch.resources.trend.map((point) => ({ x: point.switchSequence, y: point.cpuPercent })) }], "Switch sequence", "CPU (%)"));
      sections.push(chart("Memory growth with session switching", [{ label: app.name, points: app.sessionSwitch.resources.trend.map((point) => ({ x: point.switchSequence, y: point.rssMiB })) }], "Switch sequence", "RSS (MiB)"));
    }
  }
  const body = `<section class="hero compact"><p class="eyebrow"><a href="../../index.html">← All applications</a></p><h1>${escapeHtml(app.name)}</h1><p>Individual result page for ${escapeHtml(model.title)}.</p></section>${sections.join("")}<section class="panel"><h2>Definitions</h2><p><strong>Active memory</strong> is measured while completed historical sessions progress from 1 MiB through 32 MiB. <strong>Idle</strong> means the fixed 1 MiB control transcript is fully ready with no benchmark input for 60 seconds. No live session stream is running.</p></section>`;
  return page({ title: `${app.name} · ${model.title}`, current: app.id, body });
}

function memoryTable(resources) {
  if (!resources || resources.status !== "valid") return `<section class="panel"><h3>Memory consumption</h3><p class="status invalid">${escapeHtml(resources?.reason ?? "Unavailable")}</p></section>`;
  const rows = [
    ["Baseline idle average", resources.baselineIdleAverageRssMiB, "60 seconds on the ready 1 MiB control transcript before switching"],
    ["Active average", resources.activeAverageRssMiB, "Average during the progressive 1–32 MiB switch workload"],
    ["Active maximum", resources.activeMaximumRssMiB, "Largest active process-family RSS sample"],
    ["Active p95", resources.activeP95RssMiB, "Nearest-rank p95 of active samples"],
    ["Ending idle average", resources.endingIdleAverageRssMiB, "60 seconds after returning to the same control transcript"],
    ["Retained RSS growth", resources.retainedRssGrowthMiB, "Ending idle average minus baseline idle average"],
  ];
  return `<section class="panel"><h3>Memory consumption</h3><div class="table-scroll"><table><caption>Whole-application memory result</caption><thead><tr><th scope="col">Metric</th><th scope="col">Summed RSS</th><th scope="col">Definition</th></tr></thead><tbody>${rows.map(([label, value, description]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${format(value)} MiB</td><td>${escapeHtml(description)}</td></tr>`).join("")}</tbody></table></div></section>`;
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

const SITE_CSS = `:root{--bg:#f4f2ed;--ink:#191816;--muted:#67635d;--panel:#fffefa;--line:#d9d4ca;--accent:#5a45ea;--bad:#a22934;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0;line-height:1.55}.shell{width:min(1180px,calc(100% - 32px));margin-inline:auto}.masthead{display:flex;justify-content:space-between;align-items:center;padding:22px 0}.brand{font-weight:800;color:inherit;text-decoration:none}.version,.eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.hero{padding:70px 0 36px}.hero.compact{padding-top:42px}.hero h1{font-size:clamp(2.4rem,7vw,5.6rem);line-height:.95;max-width:980px;margin:.25em 0}.hero p{max-width:760px;font-size:1.08rem}.notice{max-width:900px;border-left:4px solid var(--accent);padding:14px 18px;background:color-mix(in srgb,var(--panel) 85%,var(--accent));border-radius:0 10px 10px 0}.app-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:20px 0 36px}.app-card{display:flex;flex-direction:column;padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:inherit;text-decoration:none}.app-card:hover,.app-card:focus-visible{border-color:var(--accent);outline:3px solid color-mix(in srgb,var(--accent) 25%,transparent)}.app-card span{font-size:1.35rem;font-weight:750}.app-card small{color:var(--muted)}.panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:clamp(16px,3vw,28px);margin:18px 0}.panel h2,.panel h3{margin-top:0}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}caption{text-align:left;font-weight:650;padding:0 0 10px}th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}.status.invalid{color:var(--bad)}.chart svg{width:100%;height:auto;overflow:visible}.axis{stroke:var(--muted);stroke-width:1}.chart text{fill:var(--muted);font-size:12px;text-anchor:middle}.series polyline{fill:none;stroke:var(--series);stroke-width:3;stroke-linejoin:round}.series circle{fill:var(--panel);stroke:var(--series);stroke-width:3}.legend{display:flex;gap:16px;flex-wrap:wrap;list-style:none;padding:0}.swatch{display:inline-block;width:18px;height:4px;background:var(--series);vertical-align:middle;margin-right:7px}.disclosures{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.disclosures div{padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:12px}.disclosures dt{color:var(--muted);font-size:.8rem;text-transform:uppercase}.disclosures dd{margin:4px 0 0;font-weight:650;overflow-wrap:anywhere}footer{padding:42px 0;color:var(--muted)}a{color:var(--accent)}.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--panel);padding:10px;z-index:5}@media(max-width:700px){.hero{padding-top:40px}.panel{border-radius:10px}.shell{width:min(100% - 20px,1180px)}}@media(prefers-reduced-motion:no-preference){.app-card{transition:border-color .15s ease,transform .15s ease}.app-card:hover{transform:translateY(-2px)}}@media(prefers-color-scheme:dark){:root{--bg:#141311;--ink:#f4f0e8;--muted:#aaa49a;--panel:#1c1a17;--line:#38342e;--accent:#9c8dff;--bad:#ff8491}}`;
