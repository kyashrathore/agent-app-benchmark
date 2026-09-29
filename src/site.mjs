import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { comparisonTables, describeRuns, readResultFiles } from "./compare-results.mjs";
import { REPOSITORY_ROOT } from "./paths.mjs";
import { validateResultFile } from "./runner.mjs";
import { p95EqualsSampledMaximum } from "./statistics.mjs";
import { verdictCells } from "./verdict.mjs";

const MARKER = ".agent-app-benchmark-site";

/**
 * A static site of separate per-app runs: every run with its load and
 * clock-rule conformance, the verdict of the first app against each other
 * app, and one page per app.
 */
export async function buildSite(paths, outputDirectory, { title = "Agent App Benchmark" } = {}) {
  const entries = await readResultFiles(paths);
  for (const { file } of entries) await validateResultFile(file);
  const tables = comparisonTables(entries);
  const { runs, hostConditions } = await describeRuns(entries);
  const apps = [...Map.groupBy(entries, ({ result }) => result.app.id)].map(([id, members]) => ({ id, results: members.map(({ result }) => result) }));
  const logos = await copyableLogos(apps.map((app) => app.id));
  const output = path.resolve(outputDirectory);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomBytes(5).toString("hex")}`);
  await mkdir(path.join(temporary, "assets"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(temporary, "index.html"), page(title, "", renderIndex({ title, runs, hostConditions, tables, apps, logos })), { mode: 0o600 });
    await writeFile(path.join(temporary, "methodology.html"), page(`Methodology · ${title}`, "", METHODOLOGY), { mode: 0o600 });
    for (const app of apps) {
      await mkdir(path.join(temporary, "apps", app.id), { recursive: true, mode: 0o700 });
      await writeFile(path.join(temporary, "apps", app.id, "index.html"), page(`${app.results[0].app.name} · ${title}`, "../../", renderApp(app, logos)), { mode: 0o600 });
    }
    await writeFile(path.join(temporary, "assets", "site.css"), STYLESHEET, { mode: 0o600 });
    for (const [appId, file] of logos) await copyFile(path.join(REPOSITORY_ROOT, "registry", "logos", file), path.join(temporary, "assets", `${appId}${path.extname(file)}`));
    await writeFile(path.join(temporary, MARKER), `${title}\n`, { mode: 0o600 });
    await replaceGeneratedDirectory(output, temporary);
    return { output, runs, tables };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function renderIndex({ title, runs, hostConditions, tables, apps, logos }) {
  const runRows = runs.map((run) => `<tr><td>${appLabel(run.appId, run.app, logos, "")}</td><td>${escapeHtml(run.scenario)}</td><td>${escapeHtml(run.createdAt)}</td><td><code>${escapeHtml(run.driverDigest)}</code></td><td>${escapeHtml(run.clockRule)}</td><td>${escapeHtml(run.conformance)}</td><td>${escapeHtml(run.load)}</td></tr>`).join("");
  const verdicts = tables.map(({ title: pair, verdict, names }) => {
    const { header, rows } = verdictCells(verdict, names);
    return `<section><h2>${escapeHtml(pair)}</h2><div class="scroll"><table><thead><tr>${header.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row[0])}</th>${row.slice(1).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
  }).join("");
  const hosts = hostConditions.map(({ runDirectory, text }) => `<details><summary>Host conditions for ${escapeHtml(path.basename(runDirectory))}</summary><pre>${escapeHtml(text)}</pre></details>`).join("");
  const appLinks = apps.map((app) => `<li>${appLabel(app.id, app.results[0].app.name, logos, "")} <a href="apps/${encodeURIComponent(app.id)}/index.html">run details</a></li>`).join("");
  return `<header><h1>${escapeHtml(title)}</h1><p>Each app was measured in its own run, one after another. Lower is better. <a href="methodology.html">How it is measured</a>.</p></header>
<section><h2>Runs</h2><p>Load is recorded with each run and shown here; it never gates a run.</p><div class="scroll"><table><thead><tr><th scope="col">App</th><th scope="col">Scenario</th><th scope="col">Finished</th><th scope="col">Driver</th><th scope="col">Clock rule</th><th scope="col">Conformance</th><th scope="col">1-minute load</th></tr></thead><tbody>${runRows}</tbody></table></div>${hosts}</section>
${verdicts}
<section><h2>Apps</h2><ul>${appLinks}</ul></section>`;
}

function renderApp(app, logos) {
  const [first] = app.results;
  const identity = [
    ["Version", first.app.version],
    ["Build digest", first.app.buildDigestSha256],
    ["Driver", `${first.driver.name} ${first.driver.version} at ${first.driver.sourceCommit}`],
    ["Driver digest", first.driver.digestSha256],
    ["Materialization", first.materialization.mode],
    ["Host", `${first.environment.cpuModel}, ${first.environment.logicalCpuCount} CPUs, ${first.environment.platform} ${first.environment.osRelease}`],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  const scenarios = app.results.map((result) => {
    const summaryRows = Object.entries(result.derivation.summary).map(([key, metric]) => `<tr><th scope="row">${escapeHtml(key)}</th><td>${escapeHtml(metric.status === "valid" ? `${metric.average} ms` : "—")}</td><td>${escapeHtml(metric.status !== "valid" ? "—" : p95EqualsSampledMaximum(metric.valid) ? `max ${metric.maximum} ms` : `${metric.p95} ms`)}</td><td>${metric.valid} / ${metric.attempted}</td><td>${escapeHtml(metric.reason ?? "")}</td></tr>`).join("");
    const resources = result.resources
      ? result.resources.status === "valid"
        ? `<p>RSS idle after launch ${result.resources.baselineIdleAverageRssMiB} MiB, while switching p95 ${result.resources.activeP95RssMiB} MiB, idle after the workload ${result.resources.endingIdleAverageRssMiB} MiB (${result.resources.retainedRssGrowthMiB} MiB retained).</p>`
        : `<p>Memory run invalid: ${escapeHtml(result.resources.reason)}</p>`
      : "";
    const invalid = [...new Set(result.observations.filter((observation) => observation.status !== "valid").map((observation) => observation.reason))];
    return `<section><h2>${escapeHtml(result.scenario.id)}</h2><p>${escapeHtml(result.createdAt)} · ${escapeHtml(result.runProfile)} · ${result.repetitions} repetitions · ${escapeHtml(result.scenario.status)}</p><div class="scroll"><table><thead><tr><th scope="col">Row</th><th scope="col">Average</th><th scope="col">p95 (max below 20 samples)</th><th scope="col">Valid / attempted</th><th scope="col">Reason</th></tr></thead><tbody>${summaryRows}</tbody></table></div>${resources}${invalid.length > 0 ? `<h3>Invalid observations</h3><ul>${invalid.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}</section>`;
  }).join("");
  return `<header><p><a href="../../index.html">← All runs</a></p><h1>${appLabel(app.id, first.app.name, logos, "../../")}</h1><dl>${identity}</dl></header>${scenarios}`;
}

function appLabel(appId, name, logos, prefix) {
  const logo = logos.get(appId);
  return `${logo ? `<img src="${prefix}assets/${escapeHtml(appId)}${escapeHtml(path.extname(logo))}" alt="" width="18" height="18"> ` : ""}${escapeHtml(name)}`;
}

async function copyableLogos(appIds) {
  const files = await readdir(path.join(REPOSITORY_ROOT, "registry", "logos")).catch(() => []);
  return new Map(appIds.flatMap((appId) => {
    const file = files.find((name) => path.parse(name).name === appId);
    return file ? [[appId, file]] : [];
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

function page(title, root, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${root}assets/site.css"></head>
<body><main>${body}</main></body>
</html>
`;
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const METHODOLOGY = `<header><p><a href="index.html">← All runs</a></p><h1>How it is measured</h1></header>
<section><h2>What runs</h2><p>At the default repetitions, one run of one app starts it four times from a fresh profile and four times from an existing one, then walks the session list: two processes each open the next session down the list for every session (first visit), then walk the list again (return), at 1 MiB, 8 MiB and 1 MiB of long text rows. One further process switches through a 1 and 8 MiB workload while the framework samples the app's memory and CPU, idle before and after.</p></section>
<section><h2>The clock</h2><p>Every driver implements the clock rule <code>settle-31-frames</code>. The clock starts at the trusted <code>pointerdown</code> on the destination (app start: at process spawn). From the next animation frame, every frame is sampled: it is ready when the destination is the displayed session, a row of its latest turn is painted with text, no placeholder shows, the first fold is complete, the composer is editable and the window is visible and focused. The clock stops at the observation time of the first frame of the first run of 31 consecutive ready frames with one transcript signature and no transcript mutation.</p><p>Drivers return each observation's frames, and the framework re-derives the settle from them; an observation whose frames do not reproduce its reported clock is invalid.</p></section>
<section><h2>Separate runs</h2><p>Each app is measured in its own run, one after another. That keeps a run short and lets one app be rerun on its own; the cost is that apps are measured minutes apart, so a change in the host's load lands on one app and not the others. Each run records its load, shown beside the verdict.</p></section>
<section><h2>Verdicts</h2><p>A latency row names a winner only when an exact two-sided Mann-Whitney test gives p &lt; 0.05, the bootstrap 95% interval of the median ratio excludes 1, and the gap is at least 5%; an RSS row needs disjoint sample ranges. A row with any invalid observation is withheld. Runs are compared only when they come from one host and share the scenario, corpus, clock rule and framework revision.</p></section>`;

const STYLESHEET = `:root{--bg:#fff;--text:#1c1c1e;--muted:#6b6b70;--line:#e2e2e6;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#141416;--text:#ececef;--muted:#9a9aa2;--line:#2c2c31}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.15rem;margin-top:2em}
a{color:inherit}p,dd,li,summary{color:var(--muted)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.86rem}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{font-weight:600;white-space:nowrap}
img{vertical-align:middle}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}
pre{white-space:pre-wrap;font-size:.82rem}
`;
