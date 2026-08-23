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
    "",
  ];
  if (result.scenario.kind === "app-start") renderAppStart(lines, result.derivation.summary);
  else renderSessionSwitch(lines, result.derivation.summary, result.resources);
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

function renderSessionSwitch(lines, summary, resources) {
  const sections = [
    ["Warm session switch — within the same workspace", "within-workspace-warm"],
    ["Cold session switch — within the same workspace", "within-workspace-cold"],
    ["Warm session switch — across workspaces", "across-workspaces-warm"],
    ["Cold session switch — across workspaces", "across-workspaces-cold"],
  ];
  lines.push("## Session switching", "");
  for (const [title, key] of sections) {
    lines.push(
      `### ${title}`,
      "",
      "| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |",
      "|---:|---:|---:|---:|---:|",
      ...summary[key].trend.map((metric) => metricRow(formatBytes(metric.transcriptBytes), metric)),
      "",
    );
  }
  lines.push(
    "Cold means the destination has never been active in the measured app process. Warm means exactly one valid activation occurred before the measured revisit. Transcript size is final completed UTF-8 text payload bytes, not database or event-envelope bytes.",
    "",
  );
  renderResources(lines, resources);
}

function renderResources(lines, resources) {
  lines.push("## Memory consumption", "");
  if (!resources || resources.status !== "valid") {
    lines.push(`Resource result unavailable: ${resources?.reason ?? "not measured"}`, "");
    return;
  }
  lines.push(
    "Active means the progressive session-switch workload in which completed chat transcripts move from exactly 1 MiB through 32 MiB. No session stream or live agent is running.",
    "",
    "| Metric | Summed process-family RSS (MiB) | Description |",
    "|---|---:|---|",
    `| Baseline idle average | ${number(resources.baselineIdleAverageRssMiB)} | Average during 60 seconds on the fixed 1 MiB control transcript before switching. |`,
    `| Active average | ${number(resources.activeAverageRssMiB)} | Average of 250 ms samples during the full progressive switch workload. |`,
    `| Active maximum | ${number(resources.activeMaximumRssMiB)} | Largest sample during the active workload. |`,
    `| Active p95 | ${number(resources.activeP95RssMiB)} | Nearest-rank p95 across active samples. |`,
    `| Ending idle average | ${number(resources.endingIdleAverageRssMiB)} | Average during 60 seconds after returning to the same 1 MiB control transcript. |`,
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
