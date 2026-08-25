const COLORS = ["#6f5cff", "#00a884", "#e36b34", "#b142c7", "#2878d0", "#b38b00", "#d3495f", "#087e8b"];

export function page({ title, current, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${current === "index" ? "assets/site.css" : "../../assets/site.css"}">
</head>
<body>
  <a class="skip" href="#main">Skip to results</a>
  <header class="shell masthead"><a class="brand" href="${current === "index" ? "index.html" : "../../index.html"}">Agent App Benchmark</a><span class="version">GUI V1</span></header>
  <main class="shell" id="main">${body}</main>
  <footer class="shell">OpenCode-format completed sessions · GUI performance only · No Web Vitals · No live or terminal agent workload</footer>
</body>
</html>`;
}

export function metricTable(title, rows, caption = title) {
  return `<section class="panel"><h3>${escapeHtml(title)}</h3><div class="table-scroll"><table><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col">Application</th><th scope="col">Average</th><th scope="col">Maximum</th><th scope="col">p95</th><th scope="col">Valid / attempted</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th>${metricCells(row.metric)}</tr>`).join("")}</tbody></table></div></section>`;
}

export function chart(title, series, xLabel, yLabel) {
  const visibleSeries = series.filter((item) => item.points.some((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  const points = visibleSeries.flatMap((item) => item.points).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length === 0) return `<section class="panel"><h3>${escapeHtml(title)}</h3><p class="status invalid">No valid chart points.</p></section>`;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(1, ...points.map((point) => point.y));
  const x = (value) => 64 + ((value - minX) / Math.max(1, maxX - minX)) * 520;
  const y = (value) => 220 - (value / maxY) * 180;
  const lines = visibleSeries.map((item, index) => {
    const colorIndex = (item.colorIndex ?? index) % COLORS.length;
    const variant = item.variant === "return" ? " series-return" : "";
    const coordinates = item.points.filter((point) => Number.isFinite(point.y)).map((point) => `${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`).join(" ");
    const dots = item.points.filter((point) => Number.isFinite(point.y)).map((point) => `<circle cx="${x(point.x).toFixed(1)}" cy="${y(point.y).toFixed(1)}" r="3.5"><title>${escapeHtml(item.label)}: ${point.x} ${escapeHtml(xLabel)}, ${format(point.y)} ${escapeHtml(yLabel)}</title></circle>`).join("");
    return `<g class="series series-${colorIndex}${variant}"><polyline points="${coordinates}"/>${dots}</g>`;
  }).join("");
  const legend = visibleSeries.map((item, index) => `<li><span class="swatch series-${(item.colorIndex ?? index) % COLORS.length}${item.variant === "return" ? " series-return" : ""}"></span>${escapeHtml(item.label)}</li>`).join("");
  const dataRows = visibleSeries.flatMap((item) => item.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).map((point) => `<tr><th scope="row">${escapeHtml(item.label)}</th><td>${format(point.x)}</td><td>${format(point.y)}</td></tr>`)).join("");
  return `<section class="panel chart"><h3>${escapeHtml(title)}</h3><svg role="img" aria-labelledby="${slug(title)}-title ${slug(title)}-desc" viewBox="0 0 640 260"><title id="${slug(title)}-title">${escapeHtml(title)}</title><desc id="${slug(title)}-desc">Line chart. The adjacent table contains every plotted value.</desc><line class="axis" x1="64" y1="220" x2="584" y2="220"/><line class="axis" x1="64" y1="40" x2="64" y2="220"/><text x="324" y="252">${escapeHtml(xLabel)}</text><text x="12" y="130" transform="rotate(-90 12 130)">${escapeHtml(yLabel)}</text>${lines}</svg><ul class="legend">${legend}</ul><details><summary>Chart data</summary><div class="table-scroll"><table><caption>${escapeHtml(title)} data</caption><thead><tr><th scope="col">Series</th><th scope="col">${escapeHtml(xLabel)}</th><th scope="col">${escapeHtml(yLabel)}</th></tr></thead><tbody>${dataRows}</tbody></table></div></details></section>`;
}

export function disclosures(app) {
  const provenanceRows = app.scenarioProvenance.map((run) => `<tr><th scope="row">${escapeHtml(run.scenarioId)}</th><td>${escapeHtml(run.driver.name)} ${escapeHtml(run.driver.version)}</td><td>${escapeHtml(run.materializationMode)}</td><td>${escapeHtml(run.frameworkRevision)}</td><td>${run.scheduleOrdinal ?? "—"}</td></tr>`).join("");
  return `<dl class="disclosures"><div><dt>Application</dt><dd>${escapeHtml(app.name)} ${escapeHtml(app.version)}</dd></div><div><dt>Source events</dt><dd>${escapeHtml(app.sourceEventFormat.id)}</dd></div><div><dt>GUI framework</dt><dd>${escapeHtml(app.guiFramework)}</dd></div></dl><section class="panel"><h2>Scenario provenance</h2><div class="table-scroll"><table><caption>Exact driver and framework revision for each scenario run</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Driver</th><th scope="col">Materialization</th><th scope="col">Framework revision</th><th scope="col">Schedule order</th></tr></thead><tbody>${provenanceRows}</tbody></table></div></section>`;
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function format(value) {
  return Number.isFinite(value) ? Number(value).toFixed(1) : "—";
}

function metricCells(metric) {
  if (!metric || metric.status !== "valid") return `<td colspan="3" class="status invalid">${escapeHtml(metric?.reason ?? "Unavailable")}</td><td>${metric?.valid ?? 0} / ${metric?.attempted ?? 0}</td>`;
  return `<td>${format(metric.average)} ms</td><td>${format(metric.maximum)} ms</td><td>${format(metric.p95)} ms</td><td>${metric.valid} / ${metric.attempted}</td>`;
}

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
