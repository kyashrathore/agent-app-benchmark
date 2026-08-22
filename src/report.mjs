const format = (value) => Number(value).toFixed(1);

export function renderReport(result) {
  const lines = [
    `# ${result.app.name}: ${result.scenario.id}`,
    "",
    `- Comparability: **${result.scenario.status}**`,
    `- Scenario digest: \`${result.scenario.digestSha256}\``,
    `- Corpus digest: \`${result.corpus.digestSha256}\``,
    `- Run profile: \`${result.runProfile}\``,
    "",
  ];
  if (result.scenario.kind === "app-start") renderAppStart(lines, result.summary);
  if (result.scenario.kind === "session-switch") renderSessionSwitch(lines, result.summary, result.resources);
  return `${lines.join("\n")}\n`;
}

function renderAppStart(lines, summary) {
  lines.push(
    "## Application start",
    "",
    "| Start state | Average (ms) | Maximum (ms) | p95 (ms) | Samples |",
    "|---|---:|---:|---:|---:|",
    row("Fresh profile", summary["fresh-profile"]),
    row("Repeat profile", summary["repeat-profile"]),
    "",
    "Fresh profile means the app has never opened the prepared profile. Repeat profile means exactly one unmeasured successful launch and complete shutdown preceded the measured new-process launch.",
    "",
  );
}

function renderSessionSwitch(lines, summary, resources) {
  const sections = [
    ["Warm switch — within same workspace", "warm-within-workspace"],
    ["Cold switch — within same workspace", "cold-within-workspace"],
    ["Warm switch — across workspaces", "warm-across-workspaces"],
    ["Cold switch — across workspaces", "cold-across-workspaces"],
  ];
  lines.push("## Session switching", "");
  for (const [title, key] of sections) {
    lines.push(`### ${title}`, "", "| Average (ms) | Maximum (ms) | p95 (ms) | Samples |", "|---:|---:|---:|---:|", metricRow(summary[key]), "");
  }
  lines.push("### Latency growth with transcript size", "", trendTable(summary), "");
  if (resources) {
    lines.push(
      "## Memory",
      "",
      "Active means the complete session-switch action sequence over completed historical transcripts from 1 MiB through 32 MiB. No live agent or stream is running.",
      "",
      "| Metric | MiB |",
      "|---|---:|",
      `| Baseline idle average RSS | ${format(resources.baselineIdleAverageRssMiB)} |`,
      `| Active average RSS | ${format(resources.activeAverageRssMiB)} |`,
      `| Active maximum RSS | ${format(resources.activeMaximumRssMiB)} |`,
      `| Active p95 RSS | ${format(resources.activeP95RssMiB)} |`,
      `| Ending idle average RSS | ${format(resources.endingIdleAverageRssMiB)} |`,
      `| Retained RSS growth | ${format(resources.retainedRssGrowthMiB)} |`,
      "",
      chart("CPU growth with session switching", resources.trend.map((item) => item.switchSequence), resources.trend.map((item) => item.p95CpuPercent), "CPU percent"),
      "",
      chart("Memory growth with session switching", resources.trend.map((item) => item.switchSequence), resources.trend.map((item) => item.p95RssMiB), "RSS MiB"),
      "",
    );
  }
}

function row(label, value) {
  return `| ${label} | ${format(value.average)} | ${format(value.maximum)} | ${format(value.p95)} | ${value.samples} |`;
}

function metricRow(value) {
  return `| ${format(value.average)} | ${format(value.maximum)} | ${format(value.p95)} | ${value.samples} |`;
}

function trendTable(summary) {
  const keys = ["warm-within-workspace", "cold-within-workspace", "warm-across-workspaces", "cold-across-workspaces"];
  const labels = ["Warm within", "Cold within", "Warm across", "Cold across"];
  const sizes = summary[keys[0]].trend.map((item) => item.transcriptBytes);
  return [
    `| Transcript bytes | ${labels.join(" p95 (ms) | ")} p95 (ms) |`,
    `|---:|${labels.map(() => "---:").join("|")}|`,
    ...sizes.map((size, index) => `| ${size} | ${keys.map((key) => format(summary[key].trend[index].p95)).join(" | ")} |`),
  ].join("\n");
}

function chart(title, xValues, yValues, yLabel) {
  const maximum = Math.max(1, ...yValues.map((value) => Math.ceil(value)));
  return [
    `### ${title}`,
    "",
    "```mermaid",
    "xychart-beta",
    `  title "${title}"`,
    `  x-axis "Switch sequence" [${xValues.join(", ")}]`,
    `  y-axis "${yLabel}" 0 --> ${maximum}`,
    `  line [${yValues.map((value) => Number(value).toFixed(3)).join(", ")}]`,
    "```",
  ].join("\n");
}
