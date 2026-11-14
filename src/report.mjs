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
  renderRows(lines, result.derivation.summary);
  if (result.scenario.kind === "session-switch") renderResources(lines, result.resources);
  lines.push("## Scope", "", SCOPE[result.scenario.kind], "", "Latency and readiness are driver-attested and re-derived by the framework from the frames the driver's in-page clock recorded. CPU and RSS are observed by the framework over driver-declared application processes. All summaries are framework-derived from preserved raw observations.", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

const SCOPE = {
  "app-start": "Both start modes launch a new process and end at the same endpoint: the control session is correct and painted across two presentation opportunities, and the composer accepts trusted input. An existing profile is a cloned state snapshot that completed exactly one earlier unmeasured launch and clean shutdown.",
  "session-switch": "Each step switches from a session to the one directly below it in the app's list; the first pass opens every session for the first time and the second returns to each in the same order. Sessions are completed history; no model or agent runs.",
  "new-thread": "Each sample creates a new thread through the app's own control, from the control session, and is discarded untimed. No model or agent runs.",
  "long-thread": "The long thread is completed history: the recorded session's turns repeated to at least 2,000 messages. No model or agent runs.",
  "typing-while-streaming": "The app's agent streams the framework's replay reply, the same bytes at the same pace for every app; no model runs. Typing happens while every stream is still running.",
};

function renderRows(lines, summary) {
  lines.push(
    "## Results",
    "",
    "| Row | Median | p95 | Maximum | Valid / attempted |",
    "|---|---:|---:|---:|---:|",
    ...Object.values(summary).map((row) => `| ${row.title} | ${rowCells(row)} |`),
    "",
  );
}

function rowCells(row) {
  if (row.status === "unsupported") return `— | — | — | not run: ${row.reason}`;
  if (row.status !== "valid") return `— | — | — | ${row.valid} / ${row.attempted}`;
  if (row.missed !== undefined) return `${row.missed} missed | — | — | ${row.valid} / ${row.attempted}`;
  const unit = row.unit === "ms" ? " ms" : ` ${row.unit}`;
  return `${number(row.p50)}${unit} | ${number(row.p95)}${unit} | ${number(row.maximum)}${unit} | ${row.valid} / ${row.attempted}`;
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
