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
  else if (result.scenario.kind === "session-switch") renderSessionSwitch(lines, result.derivation.summary, result.resources);
  else if (result.scenario.kind === "session-navigation") renderSessionNavigation(lines, result.derivation.summary);
  else if (result.scenario.kind === "workspace-panel") renderWorkspacePanel(lines, result.derivation.summary);
  else renderPanelSessionSwitch(lines, result.derivation.summary);
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

function renderWorkspacePanel(lines, summary) {
  if (summary.loadTrend) {
    renderWorkspacePanelTrend(lines, summary);
    return;
  }
  lines.push(
    "## Workspace panel actions",
    "",
    "| Action | Transition (animated / none) | Duration avg (ms) | Shell / action paint avg (ms) | Data-ready to interactive avg (ms) | Worst frame interval max (ms) | >16.667 ms intervals avg | LoAF count avg | Worst LoAF max (ms) | Worst blocking max (ms) | Task avg (ms) | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const [action, metric] of Object.entries(summary)) {
    const paint = metric.milestones.inputToShellMs ?? metric.milestones.secondToggleResponseMs ?? metric.milestones.inputToActionPaintMs;
    lines.push(`| ${panelActionLabel(action)} | ${metric.transitionModes.animated} / ${metric.transitionModes.none} | ${metricValue(metric.durationMs, "average")} | ${metricValue(paint, "average")} | ${metricValue(metric.milestones.dataReadyToInteractiveMs, "average")} | ${metricValue(metric.frames.worstIntervalMs, "maximum")} | ${metricValue(metric.frames.overBudgetIntervalCount, "average")} | ${metricValue(metric.longAnimationFrames.count, "average")} | ${metricValue(metric.longAnimationFrames.worstDurationMs, "maximum")} | ${metricValue(metric.longAnimationFrames.worstBlockingDurationMs, "maximum")} | ${metricValue(metric.rendererWork.taskDurationMs, "average")} | ${metricValue(metric.rendererWork.scriptDurationMs, "average")} | ${metricValue(metric.rendererWork.styleRecalcDurationMs, "average")} | ${metricValue(metric.rendererWork.layoutDurationMs, "average")} | ${validity(metric.durationMs)} |`);
  }
  lines.push(
    "",
    "Opening measures the shell transition independently from data-ready-to-paint and data-ready-to-interactive. Only the toggle is exercised during an in-progress transition; all surface, file, tab, and diff actions begin from settled loaded state and are reported separately.",
    "",
  );
}

function renderSessionNavigation(lines, summary) {
  lines.push(
    "## Session navigation by history size",
    "",
    "| History size | First visit p50 (ms) | First visit p95 (ms) | Return to visited session p50 (ms) | Return p95 (ms) | Valid first / return |",
    "|---:|---:|---:|---:|---:|---:|",
  );
  for (const point of summary.historySizeTrend) {
    lines.push(`| ${formatBytes(point.transcriptBytes)} | ${metricValue(point.firstVisit, "p50")} | ${metricValue(point.firstVisit, "p95")} | ${metricValue(point.returnVisitedPanelClosed, "p50")} | ${metricValue(point.returnVisitedPanelClosed, "p95")} | ${validity(point.firstVisit)} / ${validity(point.returnVisitedPanelClosed)} |`);
  }
  lines.push(
    "",
    "The workspace panel is closed. Every row times only the trusted session activation. First visit means the destination has not previously been displayed in that process; return means that same destination was displayed once and revisited after returning to control.",
    "",
    "## Return to a visited session with the workspace panel already open",
    "",
    "| Seeded panel load | Duration p50 (ms) | Duration p95 (ms) | Session ready avg (ms) | Panel ready avg (ms) | Worst frame max (ms) | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const point of summary.panelLoadTrend) {
    const metric = point.returnVisitedPanelOpen;
    lines.push(`| ${point.loadProfile} | ${metricValue(metric.durationMs, "p50")} | ${metricValue(metric.durationMs, "p95")} | ${metricValue(metric.milestones.inputToSessionReadyMs, "average")} | ${metricValue(metric.milestones.inputToPanelReadyMs, "average")} | ${metricValue(metric.frames.worstIntervalMs, "maximum")} | ${metricValue(metric.rendererWork.scriptDurationMs, "average")} | ${metricValue(metric.rendererWork.styleRecalcDurationMs, "average")} | ${metricValue(metric.rendererWork.layoutDurationMs, "average")} | ${validity(metric.durationMs)} |`);
  }
  lines.push("", "The panel load is established before timing. Session and panel readiness are observed concurrently; the endpoint is the later complete painted and input-ready state. Review readiness preserves all 24 canonical files and exact logical expansion state; only currently materialized viewport bodies must be painted because offscreen content may remain virtualized.", "");
}

function renderWorkspacePanelTrend(lines, summary) {
  lines.push(
    "## Workspace panel interactions by seeded load",
    "",
    "| Load | Interaction | Duration p50 (ms) | Duration p95 (ms) | Shell avg (ms) | Data-ready to interactive avg (ms) | Worst frame max (ms) | >16.667 ms intervals avg | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const point of summary.loadTrend) {
    for (const [action, metric] of Object.entries(point.interactions)) {
      lines.push(`| ${point.loadProfile} | ${panelActionLabel(action)} | ${metricValue(metric.durationMs, "p50")} | ${metricValue(metric.durationMs, "p95")} | ${metricValue(metric.milestones.inputToShellMs, "average")} | ${metricValue(metric.milestones.dataReadyToInteractiveMs, "average")} | ${metricValue(metric.frames.worstIntervalMs, "maximum")} | ${metricValue(metric.frames.overBudgetIntervalCount, "average")} | ${metricValue(metric.rendererWork.scriptDurationMs, "average")} | ${metricValue(metric.rendererWork.styleRecalcDurationMs, "average")} | ${metricValue(metric.rendererWork.layoutDurationMs, "average")} | ${validity(metric.durationMs)} |`);
    }
  }
  lines.push("", "Each row is one ordinary user action. The declared logical panel state is seeded before timing; setup is excluded. Review requires complete non-truncated 24-file data and exact logical expansion counts, while production-virtualized offscreen bodies need not be mounted. The current viewport must be painted and interactive. Opening reports shell, animation, data, paint, and interactive milestones.", "");
}

function renderPanelSessionSwitch(lines, summary) {
  lines.push(
    "## Session switching by workspace-panel profile",
    "",
    "| Panel profile / lane | Transition (animated / none) | Session ready avg (ms) | Panel ready avg (ms) | Combined duration avg (ms) | Duration max (ms) | Worst frame interval max (ms) | LoAF count avg | Worst LoAF max (ms) | Worst blocking max (ms) | Task avg (ms) | Script avg (ms) | Style avg (ms) | Layout avg (ms) | Valid / attempted |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const profile of ["closed", "files", "diff"]) {
    for (const lane of ["within-workspace-cold", "within-workspace-warm", "across-workspaces-cold", "across-workspaces-warm"]) {
      const metric = summary[`${profile}-${lane}`];
      lines.push(`| ${profile} / ${lane} | ${metric.transitionModes.animated} / ${metric.transitionModes.none} | ${metricValue(metric.milestones.inputToSessionReadyMs, "average")} | ${metricValue(metric.milestones.inputToPanelReadyMs, "average")} | ${metricValue(metric.durationMs, "average")} | ${metricValue(metric.durationMs, "maximum")} | ${metricValue(metric.frames.worstIntervalMs, "maximum")} | ${metricValue(metric.longAnimationFrames.count, "average")} | ${metricValue(metric.longAnimationFrames.worstDurationMs, "maximum")} | ${metricValue(metric.longAnimationFrames.worstBlockingDurationMs, "maximum")} | ${metricValue(metric.rendererWork.taskDurationMs, "average")} | ${metricValue(metric.rendererWork.scriptDurationMs, "average")} | ${metricValue(metric.rendererWork.styleRecalcDurationMs, "average")} | ${metricValue(metric.rendererWork.layoutDurationMs, "average")} | ${validity(metric.durationMs)} |`);
    }
  }
  lines.push(
    "",
    "## Open-panel penalty relative to closed",
    "",
    "| Panel profile / lane | Duration delta avg (ms) | Task delta avg (ms) | Script delta avg (ms) | Style delta avg (ms) | Layout delta avg (ms) | Valid pairs |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const profile of ["files", "diff"]) {
    for (const lane of ["within-workspace-cold", "within-workspace-warm", "across-workspaces-cold", "across-workspaces-warm"]) {
      const metric = summary[`${profile}-minus-closed-${lane}`];
      lines.push(`| ${profile} / ${lane} | ${metricValue(metric.durationMs, "average")} | ${metricValue(metric.taskDurationMs, "average")} | ${metricValue(metric.scriptDurationMs, "average")} | ${metricValue(metric.styleRecalcDurationMs, "average")} | ${metricValue(metric.layoutDurationMs, "average")} | ${validity(metric.durationMs)} |`);
    }
  }
  lines.push("", "Each profile uses a distinct canonical 1 MiB destination. Cold means that destination has not been activated in the measured process; warm means exactly one unmeasured valid activation before the measured revisit.", "");
}

function panelActionLabel(action) {
  if (action === "toggle-open-close") return "toggle-open-close (animated reversal / immediate double-toggle)";
  if (action === "toggle-close-open") return "toggle-close-open (animated reversal / immediate double-toggle)";
  return action;
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
      metricRow(formatBytes(summary[key].transcriptBytes), summary[key]),
      "",
    );
  }
  lines.push(
    "Cold means the unique destination has never been active in the measured app process. Warm means exactly one valid activation occurred before returning to control and measuring the revisit. Transcript bytes count completed text, reasoning, serialized tool input, and tool output—not database or event-envelope bytes.",
    "",
    "### Latency growth by transcript size",
    "",
    "| Transcript size | Average (ms) | Maximum (ms) | p95 (ms) | Valid / attempted |",
    "|---:|---:|---:|---:|---:|",
    ...summary.transcriptSizeTrend.map((point) => metricRow(formatBytes(point.transcriptBytes), point)),
    "",
    "The size sweep is within-workspace/cold and counterbalanced separately from the ascending resource-retention workload.",
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

function metricValue(metric, field) {
  return metric?.status === "valid" ? number(metric[field]) : "—";
}

function validity(metric) {
  return `${metric?.valid ?? 0} / ${metric?.attempted ?? 0}`;
}

function formatBytes(bytes) {
  return Number.isFinite(bytes) && bytes % 1048576 === 0 ? `${bytes / 1048576} MiB (${bytes} bytes)` : `${bytes} bytes`;
}
