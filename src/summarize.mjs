import { SESSION_LANES } from "./cases.mjs";
import { average, maximum, percentile, round, summaryOrUnavailable } from "./statistics.mjs";

export function summarizeObservations(scenario, observations) {
  if (scenario.kind === "app-start") {
    const honestP95 = scenario.id.endsWith("-v3") ? { minimumP95Samples: 20 } : {};
    return Object.fromEntries(scenario.cases.startModes.map((startMode) => {
      const attempted = observations.filter((item) => item.case?.startMode === startMode);
      const valid = attempted.filter(isValid).map((item) => item.durationMs);
      return [startMode, summaryOrUnavailable(valid, attempted.length, "No valid observations.", honestP95)];
    }));
  }
  if (scenario.kind === "session-navigation") return summarizeSessionNavigation(scenario, observations);
  if (scenario.kind === "workspace-panel" && scenario.cases.panelLoads) return {
    loadTrend: scenario.cases.panelLoads.map(({ id: loadProfile }) => ({
      loadProfile,
      interactions: Object.fromEntries(scenario.cases.actions.map((action) => {
        const attempted = observations.filter((item) => item.case?.loadProfile === loadProfile && item.case?.action === action);
        return [action, summarizeRendererGroup(attempted, { includeP50: true, minimumP95Samples: 20 })];
      })),
    })),
  };
  if (scenario.kind === "workspace-panel") return Object.fromEntries(scenario.cases.actions.map((action) => {
    const attempted = observations.filter((item) => item.case?.action === action);
    return [action, summarizeRendererGroup(attempted)];
  }));
  if (scenario.kind === "session-switch-workspace-panel") return summarizePanelSwitches(observations);
  const lanes = {};
  const honestP95 = scenario.cases.latencySamplesPerProcess ? { minimumP95Samples: 20 } : {};
  for (const lane of SESSION_LANES) {
    const attempted = observations.filter((item) => item.case?.workspaceRelation === lane.workspaceRelation && item.case?.sessionState === lane.sessionState && item.case?.workload === "isolated-latency");
    const valid = attempted.filter(isValid).map((item) => item.durationMs);
    lanes[lane.id] = {
      ...summaryOrUnavailable(valid, attempted.length, "No valid observations.", honestP95),
      transcriptBytes: scenario.cases.standardTranscriptBytes ?? scenario.cases.transcriptBytes[0],
    };
  }
  const progression = observations.filter((item) => item.case?.workload === (scenario.cases.sizeSamplesPerProcess ? "transcript-size-latency" : "progressive-resource"));
  lanes.transcriptSizeTrend = scenario.cases.transcriptBytes.map((transcriptBytes) => {
    const attempted = progression.filter((item) => item.case.transcriptBytes === transcriptBytes);
    return {
      transcriptBytes,
      ...summaryOrUnavailable(attempted.filter(isValid).map((item) => item.durationMs), attempted.length, "No valid observations.", honestP95),
    };
  });
  return lanes;
}

function summarizeSessionNavigation(scenario, observations) {
  const honestP95 = { minimumP95Samples: 20 };
  const summarizeLatency = (attempted) => summaryOrUnavailable(
    attempted.filter(isValid).map((item) => item.durationMs),
    attempted.length,
    "No valid navigation observations.",
    { ...honestP95, includeP50: true },
  );
  return {
    historySizeTrend: scenario.cases.transcriptBytes.map((transcriptBytes) => ({
      transcriptBytes,
      firstVisit: summarizeLatency(observations.filter((item) => item.case?.trend === "history-size"
        && item.case?.navigationType === "first-visit" && item.case?.transcriptBytes === transcriptBytes)),
      returnVisitedPanelClosed: summarizeLatency(observations.filter((item) => item.case?.trend === "history-size"
        && item.case?.navigationType === "return-visited-panel-closed" && item.case?.transcriptBytes === transcriptBytes)),
    })),
    panelLoadTrend: scenario.cases.panelLoads.map(({ id: loadProfile }) => ({
      loadProfile,
      returnVisitedPanelOpen: summarizeRendererGroup(observations.filter((item) => item.case?.trend === "panel-load"
        && item.case?.navigationType === "return-visited-panel-open" && item.case?.loadProfile === loadProfile), { includeP50: true, minimumP95Samples: 20 }),
    })),
  };
}

function summarizePanelSwitches(observations) {
  const result = {};
  for (const panelProfile of ["closed", "files", "diff"]) {
    for (const lane of SESSION_LANES) {
      const key = `${panelProfile}-${lane.id}`;
      const attempted = observations.filter((item) => item.case?.panelProfile === panelProfile
        && item.case?.workspaceRelation === lane.workspaceRelation
        && item.case?.sessionState === lane.sessionState);
      result[key] = summarizeRendererGroup(attempted);
    }
  }
  for (const panelProfile of ["files", "diff"]) {
    for (const lane of SESSION_LANES) {
      const key = `${panelProfile}-minus-closed-${lane.id}`;
      result[key] = summarizePanelPenalty(observations, panelProfile, lane);
    }
  }
  return result;
}

function summarizeRendererGroup(attempted, summaryOptions = {}) {
  const valid = attempted.filter((item) => item.status === "valid" && item.rendererTrace);
  const deltas = (start, end) => valid.flatMap((item) => {
    const milestones = Object.fromEntries(item.rendererTrace.milestones.map((milestone) => [milestone.id, milestone.at]));
    return Number.isFinite(milestones[start]) && Number.isFinite(milestones[end]) ? [milestones[end] - milestones[start]] : [];
  });
  const intervals = valid.map((item) => frameIntervals(item.clock, item.rendererTrace.frameTimestampsMs));
  const milestoneDefinitions = {
    inputToShellMs: ["trusted-input", "shell-visible"],
    animationMs: ["trusted-input", "animation-settled"],
    dataReadyToPaintMs: ["data-ready", "above-fold-painted"],
    dataReadyToInteractiveMs: ["data-ready", "interactive"],
    paintToInteractiveMs: ["above-fold-painted", "interactive"],
    secondToggleResponseMs: ["second-toggle-input", "final-state-presented"],
    inputToActionPaintMs: ["trusted-input", "action-painted"],
    inputToContentMs: ["trusted-input", "content-identity"],
    inputToSessionReadyMs: ["trusted-input", "session-ready"],
    inputToPanelReadyMs: ["trusted-input", "panel-ready"],
    inputToInteractiveMs: ["trusted-input", "interactive"],
  };
  const milestones = Object.fromEntries(Object.entries(milestoneDefinitions).flatMap(([id, [start, end]]) => {
    const values = deltas(start, end);
    return values.length === 0 ? [] : [[id, summaryOrUnavailable(values, attempted.length, `No ${id} evidence.`)]];
  }));
  return {
    durationMs: summaryOrUnavailable(valid.map((item) => item.durationMs), attempted.length, "No valid observations.", summaryOptions),
    transitionModes: {
      animated: valid.filter((item) => item.rendererTrace.transitionMode === "animated").length,
      none: valid.filter((item) => item.rendererTrace.transitionMode === "none").length,
    },
    milestones,
    frames: {
      worstIntervalMs: summaryOrUnavailable(intervals.map((values) => maximum(values)), attempted.length, "No frame evidence."),
      p95IntervalMs: summaryOrUnavailable(intervals.map((values) => percentile(values, 95)), attempted.length, "No frame evidence."),
      overBudgetIntervalCount: summaryOrUnavailable(intervals.map((values) => values.filter((value) => value > 16.667).length), attempted.length, "No frame evidence."),
    },
    longAnimationFrames: {
      count: summaryOrUnavailable(valid.map((item) => item.rendererTrace.longAnimationFrames.length), attempted.length, "No long-animation-frame evidence."),
      worstDurationMs: summaryOrUnavailable(valid.map((item) => maximum([0, ...item.rendererTrace.longAnimationFrames.map((entry) => entry.duration)])), attempted.length, "No long-animation-frame evidence."),
      worstBlockingDurationMs: summaryOrUnavailable(valid.map((item) => maximum([0, ...item.rendererTrace.longAnimationFrames.map((entry) => entry.blockingDuration)])), attempted.length, "No long-animation-frame evidence."),
    },
    rendererWork: Object.fromEntries(["scriptDurationMs", "styleRecalcDurationMs", "layoutDurationMs", "taskDurationMs"].map((id) => [
      id,
      summaryOrUnavailable(valid.map((item) => item.rendererTrace.counters[id]), attempted.length, `No ${id} evidence.`),
    ])),
  };
}

function summarizePanelPenalty(observations, panelProfile, lane) {
  const repetitions = new Set(observations.map((item) => item.case?.repetition).filter(Number.isInteger));
  const metric = (item, id) => id === "durationMs" ? item.durationMs : item.rendererTrace.counters[id];
  const summaries = {};
  for (const id of ["durationMs", "scriptDurationMs", "styleRecalcDurationMs", "layoutDurationMs", "taskDurationMs"]) {
    const values = [];
    for (const repetition of repetitions) {
      const matches = (profile) => observations.find((item) => item.case?.repetition === repetition
        && item.case?.panelProfile === profile
        && item.case?.workspaceRelation === lane.workspaceRelation
        && item.case?.sessionState === lane.sessionState
        && item.status === "valid" && item.rendererTrace);
      const closed = matches("closed");
      const open = matches(panelProfile);
      if (closed && open) values.push(metric(open, id) - metric(closed, id));
    }
    summaries[id] = signedSummary(values, repetitions.size);
  }
  return summaries;
}

function signedSummary(values, attempted) {
  if (values.length !== attempted || values.length === 0) return { status: "invalid", valid: values.length, attempted, reason: `Only ${values.length} of ${attempted} required pairs were valid.` };
  const sorted = values.toSorted((left, right) => left - right);
  return {
    status: "valid",
    average: round(values.reduce((total, value) => total + value, 0) / values.length),
    maximum: round(Math.max(...values)),
    p95: round(sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]),
    valid: values.length,
    attempted,
  };
}

function frameIntervals(clock, timestamps) {
  const boundaries = [clock.start, ...timestamps.filter((timestamp) => timestamp > clock.start && timestamp < clock.end), clock.end];
  return boundaries.slice(1).map((timestamp, index) => timestamp - boundaries[index]);
}

export function summarizeResources(samples, windows, boundaryPoints) {
  if (!windows.valid) return { status: "invalid", reason: windows.reason, rawSampleCount: samples.length, trend: boundaryPoints };
  const baseline = within(samples, windows.baseline);
  const active = within(samples, windows.active);
  const ending = within(samples, windows.ending);
  if (baseline.length === 0 || active.length === 0 || ending.length === 0) {
    return { status: "invalid", reason: "A required resource window contains no samples.", rawSampleCount: samples.length, trend: boundaryPoints };
  }
  const baselineIdleAverage = average(baseline.map((sample) => sample.rssBytes)) / MIB;
  const endingIdleAverage = average(ending.map((sample) => sample.rssBytes)) / MIB;
  return {
    status: "valid",
    scope: "summed application process-family RSS",
    cpuDefinition: "sampled cumulative CPU delta for descendants observed inside each boundary, divided by wall time; newborn descendants count from birth and exited descendants through their final sample; 100% equals one logical core",
    baselineIdleAverageRssMiB: round(baselineIdleAverage),
    activeAverageRssMiB: round(average(active.map((sample) => sample.rssBytes)) / MIB),
    activeMaximumRssMiB: round(maximum(active.map((sample) => sample.rssBytes)) / MIB),
    activeP95RssMiB: round(percentile(active.map((sample) => sample.rssBytes), 95) / MIB),
    endingIdleAverageRssMiB: round(endingIdleAverage),
    retainedRssGrowthMiB: round(endingIdleAverage - baselineIdleAverage),
    rawSampleCount: samples.length,
    trend: boundaryPoints.map((point) => ({
      ...point,
      rssMiB: round(point.rssBytes / MIB),
      cpuPercent: round(point.cpuPercent),
    })),
  };
}

export function summarizeResourceRuns(runs) {
  const baseline = runs.flatMap((run) => within(run.samples, run.windows.baseline));
  const active = runs.flatMap((run) => within(run.samples, run.windows.active));
  const ending = runs.flatMap((run) => within(run.samples, run.windows.ending));
  if (baseline.length === 0 || active.length === 0 || ending.length === 0) {
    return { status: "invalid", reason: "A repeated resource window contains no samples.", rawSampleCount: runs.reduce((total, run) => total + run.samples.length, 0), trend: [] };
  }
  const baselineIdleAverage = average(baseline.map((sample) => sample.rssBytes)) / MIB;
  const endingIdleAverage = average(ending.map((sample) => sample.rssBytes)) / MIB;
  return {
    status: "valid",
    scope: "summed application process-family RSS",
    cpuDefinition: "sampled cumulative CPU delta for descendants observed inside each boundary, divided by wall time; newborn descendants count from birth and exited descendants through their final sample; 100% equals one logical core",
    baselineIdleAverageRssMiB: round(baselineIdleAverage),
    activeAverageRssMiB: round(average(active.map((sample) => sample.rssBytes)) / MIB),
    activeMaximumRssMiB: round(maximum(active.map((sample) => sample.rssBytes)) / MIB),
    activeP95RssMiB: round(percentile(active.map((sample) => sample.rssBytes), 95) / MIB),
    endingIdleAverageRssMiB: round(endingIdleAverage),
    retainedRssGrowthMiB: round(endingIdleAverage - baselineIdleAverage),
    rawSampleCount: runs.reduce((total, run) => total + run.samples.length, 0),
    trend: runs.flatMap((run) => run.boundaryPoints.map((point) => ({
      ...point,
      repetition: run.repetition,
      rssMiB: round(point.rssBytes / MIB),
      cpuPercent: round(point.cpuPercent),
    }))),
  };
}

const MIB = 1024 * 1024;
const isValid = (observation) => observation.status === "valid" && Number.isFinite(observation.durationMs) && observation.durationMs >= 0;
const within = (samples, window) => samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
