export function page({ title, current, body, root }) {
  root = root ?? (current === "index" ? "" : "../../");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${root}assets/site.css">
</head>
<body>
  <a class="skip" href="#main">Skip to results</a>
  <header class="shell masthead"><a class="brand" href="${root}index.html"><span class="brand-mark" aria-hidden="true"></span>Agent App Benchmark</a><nav class="masthead-nav"><a href="${root}methodology.html">Methodology</a><span class="version">GUI V1</span></nav></header>
  <main class="shell" id="main">${body}</main>
  <footer class="shell">OpenCode-format completed sessions · GUI performance only · No Web Vitals · No live or terminal agent workload</footer>
</body>
</html>`;
}

export function metricTable(title, rows, caption = title) {
  return `<section class="panel"><h3>${escapeHtml(title)}</h3><div class="table-scroll"><table><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col">Application</th><th scope="col">Average</th><th scope="col">Maximum</th><th scope="col">p95</th><th scope="col">Valid / attempted</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th>${metricCells(row.metric)}</tr>`).join("")}</tbody></table></div></section>`;
}

/* ---------------------------------------------------------------------------
 * Chart
 *
 * Rendered as plain SVG with no client script: the report's own CSP is
 * `default-src 'none'` with no script-src, so a runtime charting library could
 * not execute on these pages at all. Geometry is therefore computed at build
 * time and every colour arrives through a CSS class, never an inline style.
 *
 * The x axis auto-selects a log2 scale, because every trend in this benchmark
 * steps transcript size by doubling (1 → 8 → 32 → 128 MiB). On a linear axis
 * those points collapse against the left edge and the shape of the trend is
 * unreadable.
 * ------------------------------------------------------------------------- */

const CHART = { width: 760, height: 300, top: 18, right: 86, bottom: 46, left: 62 };

export function chart(title, series, xLabel, yLabel) {
  const visibleSeries = series.filter((item) => item.points.some((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  const points = visibleSeries.flatMap((item) => item.points).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length === 0) return `<section class="panel chart"><h3>${escapeHtml(title)}</h3><p class="status invalid">No valid chart points.</p></section>`;

  const id = slug(title);
  const xValues = [...new Set(points.map((point) => point.x))].toSorted((left, right) => left - right);
  const logarithmic = xValues.length > 2 && xValues.every((value) => value > 0) && xValues.at(-1) / xValues[0] >= 8;
  const project = logarithmic ? Math.log2 : (value) => value;
  const xMin = project(xValues[0]);
  const xMax = project(xValues.at(-1));
  const plotRight = CHART.width - CHART.right;
  const plotBottom = CHART.height - CHART.bottom;
  const x = (value) => CHART.left + (xMax === xMin ? 0.5 : (project(value) - xMin) / (xMax - xMin)) * (plotRight - CHART.left);

  const yScale = niceScale(Math.max(...points.map((point) => point.y)));
  const y = (value) => plotBottom - (value / yScale.max) * (plotBottom - CHART.top);

  const gridlines = yScale.ticks.map((tick) => `<line class="grid" x1="${CHART.left}" y1="${y(tick).toFixed(1)}" x2="${plotRight}" y2="${y(tick).toFixed(1)}"/><text class="tick tick-y" x="${CHART.left - 12}" y="${(y(tick) + 4).toFixed(1)}">${escapeHtml(tickLabel(tick, yScale.step))}</text>`).join("");
  const xTicks = (logarithmic ? xValues : niceScale(xValues.at(-1)).ticks.filter((tick) => tick >= xValues[0]))
    .map((value) => `<text class="tick tick-x" x="${x(value).toFixed(1)}" y="${plotBottom + 22}">${escapeHtml(tickLabel(value, 1))}</text>`)
    .join("");

  // End-of-line value labels replace hunting between a legend and the plot.
  // Collided labels are nudged apart so both stay readable.
  const endLabels = [];
  const plots = visibleSeries.map((item, index) => {
    const colorIndex = (item.colorIndex ?? index) % 8;
    const variant = item.variant === "return" ? " series-return" : "";
    const valid = item.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (valid.length === 0) return "";
    const coordinates = valid.map((point) => `${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`);
    const area = valid.length > 1
      ? `<path class="area" d="M${coordinates[0]} L${coordinates.join(" L")} L${x(valid.at(-1).x).toFixed(1)},${plotBottom} L${x(valid[0].x).toFixed(1)},${plotBottom} Z" fill="url(#${id}-fill-${index})"/>`
      : "";
    const dots = valid.map((point) => `<circle cx="${x(point.x).toFixed(1)}" cy="${y(point.y).toFixed(1)}" r="3.2"><title>${escapeHtml(item.label)}: ${format(point.x)} ${escapeHtml(xLabel)}, ${format(point.y)} ${escapeHtml(yLabel)}</title></circle>`).join("");
    const last = valid.at(-1);
    endLabels.push({ colorIndex, variant, y: y(last.y), text: format(last.y) });
    const gradient = `<linearGradient id="${id}-fill-${index}" x1="0" y1="0" x2="0" y2="1"><stop class="stop-top" offset="0"/><stop class="stop-bottom" offset="1"/></linearGradient>`;
    return `<g class="series series-${colorIndex}${variant}">${gradient}${area}<polyline points="${coordinates.join(" ")}"/>${dots}</g>`;
  }).join("");

  endLabels.sort((left, right) => left.y - right.y);
  for (let index = 1; index < endLabels.length; index += 1) {
    const gap = endLabels[index].y - endLabels[index - 1].y;
    if (gap < 14) endLabels[index].y = endLabels[index - 1].y + 14;
  }
  const labels = endLabels.map((label) => `<text class="end-label series-${label.colorIndex}${label.variant}" x="${plotRight + 12}" y="${(label.y + 4).toFixed(1)}">${escapeHtml(label.text)}</text>`).join("");

  const legend = visibleSeries.map((item, index) => `<li><span class="swatch series-${(item.colorIndex ?? index) % 8}${item.variant === "return" ? " series-return" : ""}"></span>${escapeHtml(item.label)}</li>`).join("");
  const dataRows = visibleSeries.flatMap((item) => item.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).map((point) => `<tr><th scope="row">${escapeHtml(item.label)}</th><td>${format(point.x)}</td><td>${format(point.y)}</td></tr>`)).join("");
  const scaleNote = logarithmic ? ` <span class="axis-note">log₂ scale</span>` : "";

  return `<section class="panel chart"><div class="chart-heading"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(yLabel)} against ${escapeHtml(xLabel)}${scaleNote ? " ·" : ""}</p>${scaleNote}</div><svg role="img" aria-labelledby="${id}-title ${id}-desc" viewBox="0 0 ${CHART.width} ${CHART.height}" preserveAspectRatio="xMidYMid meet"><title id="${id}-title">${escapeHtml(title)}</title><desc id="${id}-desc">Line chart. The adjacent data table contains every plotted value.</desc>${gridlines}<line class="axis" x1="${CHART.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}"/>${xTicks}<text class="axis-title" x="${((CHART.left + plotRight) / 2).toFixed(1)}" y="${CHART.height - 6}">${escapeHtml(xLabel)}</text><text class="axis-title" x="14" y="${((CHART.top + plotBottom) / 2).toFixed(1)}" transform="rotate(-90 14 ${((CHART.top + plotBottom) / 2).toFixed(1)})">${escapeHtml(yLabel)}</text>${plots}${labels}</svg><ul class="legend">${legend}</ul><details class="quiet"><summary>Chart data</summary><div class="table-scroll"><table><caption>${escapeHtml(title)} data</caption><thead><tr><th scope="col">Series</th><th scope="col">${escapeHtml(xLabel)}</th><th scope="col">${escapeHtml(yLabel)}</th></tr></thead><tbody>${dataRows}</tbody></table></div></details></section>`;
}

// Rounded axis bounds so ticks land on readable numbers instead of the raw maximum.
function niceScale(maximum, count = 4) {
  const safeMaximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 1;
  const magnitude = 10 ** Math.floor(Math.log10(safeMaximum / count));
  const normalized = safeMaximum / count / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const max = Math.ceil(safeMaximum / step) * step;
  const ticks = [];
  for (let value = 0; value <= max + step / 1000; value += step) ticks.push(Math.round(value * 1000) / 1000);
  return { step, max, ticks };
}

function tickLabel(value, step) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return `${Math.round(value / 100) / 10}k`;
  return step >= 1 && Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function disclosures(app) {
  const provenanceRows = app.scenarioProvenance.map((run) => `<tr><th scope="row">${escapeHtml(run.scenarioId)}</th><td>${escapeHtml(run.driver.name)} ${escapeHtml(run.driver.version)}</td><td>${escapeHtml(run.materializationMode)}</td><td>${escapeHtml(run.frameworkRevision)}</td><td>${run.scheduleOrdinal ?? "—"}</td></tr>`).join("");
  return `<dl class="disclosures"><div><dt>Application</dt><dd>${escapeHtml(app.name)} ${escapeHtml(app.version)}</dd></div><div><dt>Source events</dt><dd>${escapeHtml(app.sourceEventFormat.id)}</dd></div><div><dt>GUI framework</dt><dd>${escapeHtml(app.guiFramework)}</dd></div></dl><details class="quiet"><summary>Scenario provenance</summary><div class="table-scroll"><table><caption>Exact driver and framework revision for each scenario run</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Driver</th><th scope="col">Materialization</th><th scope="col">Framework revision</th><th scope="col">Schedule order</th></tr></thead><tbody>${provenanceRows}</tbody></table></div></details>`;
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
