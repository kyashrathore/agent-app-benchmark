const number = (value) => Number.isFinite(value) ? Number(value).toFixed(1) : "—";

export function renderReport(result) {
  const lines = [
    `# ${result.app.name}: ${result.scenario.id}`,
    "",
    `- Eligibility: **${result.scenario.status}** / **${result.corpus.status}**`,
    `- Source events: \`${result.sourceEventFormat.id}\` (schema \`${result.sourceEventFormat.schemaDigestSha256}\`)`,
    `- Materialization: **${result.materialization.mode}** (driver-attested)`,
    `- Scenario digest: \`${result.scenario.digestSha256}\``,
    `- Corpus digest: \`${result.corpus.digestSha256}\``,
    `- Run profile: \`${result.runProfile}\``,
    `- Configured repetitions: \`${result.repetitions}\``,
    "",
  ];
  if (result.scenario.kind === "app-start") renderAppStart(lines, result.derivation.summary);
  else renderListWalk(lines, result.derivation.summary, result.resources);
  lines.push(
    "## Scope",
    "",
    "This is a GUI benchmark for multi-harness coding-agent applications. It loads completed OpenCode-format historical sessions; no model, agent, stream, or embedded terminal workload runs. Web Vitals are not measured.",
    "",
    "Latency and readiness are driver-attested. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.",
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderAppStart(lines, summary) {
  lines.push(
    "## Application start",
    "",
    "| Application state | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |",
    "|---|---:|---:|---:|---:|",
    metricRow("First launch — new application state", summary["new-application-state"]),
    metricRow("Repeat launch — initialized application state", summary["initialized-application-state"]),
    "",
    "Both rows launch a new process and end at the same endpoint: the 1 MiB anchor transcript is correct and painted across two presentation opportunities, and the composer accepts trusted input. The repeat row uses a cloned state snapshot that completed exactly one earlier unmeasured launch and clean shutdown.",
    "",
  );
}

function renderResources(lines, resources) {
  lines.push("## Memory consumption", "");
  if (!resources || resources.status !== "valid") {
    lines.push(`Resource result unavailable: ${resources?.reason ?? "not measured"}`, "");
    return;
  }
  lines.push(
    "Active means the progressive session-switch workload in which completed historical sessions move through every configured size. No session stream or live agent is running.",
    "",
    "| Metric | Summed process-family RSS (MiB) | Description |",
    "|---|---:|---|",
    `| Baseline idle average | ${number(resources.baselineIdleAverageRssMiB)} | Average during the configured idle window on the fixed 1 MiB control transcript before switching. |`,
    `| Active average | ${number(resources.activeAverageRssMiB)} | Average of 250 ms samples during the full progressive switch workload. |`,
    `| Active sampled maximum | ${number(resources.activeMaximumRssMiB)} | Largest observed sample during the active workload; not an operating-system true peak. |`,
    `| Active p95 | ${number(resources.activeP95RssMiB)} | Nearest-rank p95 across active samples. |`,
    `| Ending idle average | ${number(resources.endingIdleAverageRssMiB)} | Average during the configured idle window after returning to the same 1 MiB control transcript. |`,
    `| Retained RSS growth | ${number(resources.retainedRssGrowthMiB)} | Ending idle average minus baseline idle average; negative values remain visible. |`,
    "",
    "CPU growth and memory growth use the preserved per-switch boundary points in `result.json`.",
    "",
  );
}

function metricRow(label, metric) {
  return `| ${label} | ${metricCells(metric)} |`;
}

function metricCells(metric) {
  if (!metric || metric.status !== "valid") return `— | — | — | ${metric?.valid ?? 0} / ${metric?.attempted ?? 0}`;
  return `${number(metric.average)} | ${number(metric.maximum)} | ${number(metric.p95)} | ${metric.valid} / ${metric.attempted}`;
}



function formatBytes(bytes) {
  return Number.isFinite(bytes) && bytes % 1048576 === 0 ? `${bytes / 1048576} MiB (${bytes} bytes)` : `${bytes} bytes`;
}

function renderListWalk(lines, summary, resources) {
  lines.push(
    "## Session switching, walking the list",
    "",
    "| Pass | Destination | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |",
    "|---|---|---:|---:|---:|---:|",
    ...Object.entries(summary).map(([key, point]) => {
      const pass = key.startsWith("cold-") ? "First visit" : "Return";
      const destination = `${formatBytes(point.transcriptBytes)}${point.rowShape === "long" ? " of long text rows" : ""}`;
      return metricRow(`${pass} | ${destination}`, point);
    }),
    "",
    "Each step switches from a session to the one directly below it in the app's list; the first pass opens every session for the first time and the second returns to each in the same order.",
    "",
  );
  renderResources(lines, resources);
}
