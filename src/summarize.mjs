import { SESSION_LANES } from "./cases.mjs";
import { cpuDeltaMsBetween } from "./resource-monitor.mjs";
import { average, maximum, percentile, round, summaryOrUnavailable } from "./statistics.mjs";

export function summarizeObservations(scenario, observations) {
  if (scenario.kind === "app-start") {
    return Object.fromEntries(scenario.cases.startModes.map((startMode) => {
      const attempted = observations.filter((item) => item.case?.startMode === startMode);
      const valid = attempted.filter(isValid).map((item) => item.durationMs);
      return [startMode, summaryOrUnavailable(valid, attempted.length, "No valid observations.")];
    }));
  }
  if (scenario.kind === "session-navigation") return summarizeSessionNavigation(scenario, observations);
  if (scenario.kind === "workspace-panel" && scenario.cases.panelLoads) return {
    loadTrend: scenario.cases.panelLoads.map(({ id: loadProfile }) => ({
      loadProfile,
      interactions: Object.fromEntries(scenario.cases.actions.map((action) => {
        const attempted = observations.filter((item) => item.case?.loadProfile === loadProfile && item.case?.action === action);
        return [action, summarizeRendererGroup(attempted, { includeP50: true })];
      })),
    })),
  };
  if (scenario.kind === "workspace-panel") return Object.fromEntries(scenario.cases.actions.map((action) => {
    const attempted = observations.filter((item) => item.case?.action === action);
    return [action, summarizeRendererGroup(attempted)];
  }));
  if (scenario.kind === "session-switch-workspace-panel") return summarizePanelSwitches(observations);
  const lanes = {};
  for (const lane of SESSION_LANES) {
    const attempted = observations.filter((item) => item.case?.workspaceRelation === lane.workspaceRelation && item.case?.sessionState === lane.sessionState && item.case?.workload === "isolated-latency");
    const valid = attempted.filter(isValid).map((item) => item.durationMs);
    lanes[lane.id] = {
      ...summaryOrUnavailable(valid, attempted.length, "No valid observations."),
      transcriptBytes: scenario.cases.standardTranscriptBytes ?? scenario.cases.transcriptBytes[0],
    };
  }
  const progression = observations.filter((item) => item.case?.workload === (scenario.cases.sizeSamplesPerProcess ? "transcript-size-latency" : "progressive-resource"));
  lanes.transcriptSizeTrend = scenario.cases.transcriptBytes.map((transcriptBytes) => {
    const attempted = progression.filter((item) => item.case.transcriptBytes === transcriptBytes);
    return {
      transcriptBytes,
      ...summaryOrUnavailable(attempted.filter(isValid).map((item) => item.durationMs), attempted.length, "No valid observations."),
    };
  });
  return lanes;
}

function summarizeSessionNavigation(scenario, observations) {
  const summarizeLatency = (attempted) => summaryOrUnavailable(
    attempted.filter(isValid).map((item) => item.durationMs),
    attempted.length,
    "No valid navigation observations.",
    { includeP50: true },
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
        && item.case?.navigationType === "return-visited-panel-open" && item.case?.loadProfile === loadProfile), { includeP50: true }),
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
    cpuDefinition: PROCESS_FAMILY_CPU_DEFINITION,
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
    cpuDefinition: PROCESS_FAMILY_CPU_DEFINITION,
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

// Nearest-rank p95 inventory for the idle/active/idle resource windows and the per-step boundary
// trend. `summarizeResources` owns the persisted `result.resources` contract and reports window
// averages; this function reads the same preserved raw trace and is the single owner of the
// distributional (p95) memory and CPU statistics the comparison report presents. Every validity
// gate the runner already applied to `resources` (cadence, monitor errors, invalid workload
// observations, incomplete process family) is inherited here, never re-litigated or relaxed.
export const RESOURCE_WINDOW_IDS = ["baseline", "active", "ending"];

export const PROCESS_FAMILY_CPU_DEFINITION = "sampled cumulative CPU delta for descendants observed inside each boundary, divided by wall time; newborn descendants count from birth and exited descendants through their final sample; 100% equals one logical core";

export const PROCESS_FAMILY_DEFINITION = "The declared application root process, every descendant it spawns, and every driver-declared external application process, summed within each sample.";

export function summarizeResourceWindows(trace, resources) {
  const runs = resourceTraceRuns(trace);
  const failure = runs.length === 0
    ? "Raw resource trace is missing."
    : resources && resources.status !== "valid"
      ? resources.reason ?? "The derived resource result is invalid."
      : runs.map((run) => run.failure).find(Boolean) ?? null;
  const windows = Object.fromEntries(RESOURCE_WINDOW_IDS.map((id) => [id, summarizeResourceWindow(id, runs, failure)]));
  return {
    status: failure ? "invalid" : "valid",
    ...(failure ? { reason: failure } : {}),
    runCount: runs.length,
    rawSampleCount: runs.reduce((total, run) => total + run.samples.length, 0),
    windows,
    retainedRssGrowthMiB: retainedRssGrowth(windows.baseline.rssP95MiB, windows.ending.rssP95MiB),
    processFamily: { definition: PROCESS_FAMILY_DEFINITION, ...processFamilyEvidence(runs) },
  };
}

export function summarizeResourceTrendP95(trend) {
  const grouped = Map.groupBy(trend ?? [], (point) => point.transcriptBytes);
  return [...grouped.entries()]
    .filter(([transcriptBytes]) => Number.isFinite(transcriptBytes))
    .toSorted(([left], [right]) => left - right)
    .map(([transcriptBytes, points]) => ({
      transcriptBytes,
      rssMiB: trendMetric(points.map((point) => point.rssMiB), points.length),
      cpuPercent: trendMetric(points.map((point) => point.cpuPercent), points.length),
    }));
}

function trendMetric(values, attempted) {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length === 0) return invalidMetric("No valid boundary observation at this step.", 0, attempted);
  return validMetric({ p95: round(percentile(finite, 95)) }, finite.length, attempted);
}

function resourceTraceRuns(trace) {
  if (trace?.version === 2 && Array.isArray(trace.runs)) return trace.runs.filter((run) => run?.version === 1 && Array.isArray(run.samples));
  return trace?.version === 1 && Array.isArray(trace.samples) ? [trace] : [];
}

function summarizeResourceWindow(id, runs, failure) {
  const perRun = runs.map((run) => ({
    window: run.windows?.[id] ?? null,
    samples: run.windows?.[id] ? within(run.samples, run.windows[id]).toSorted((left, right) => left.atMs - right.atMs) : [],
  }));
  const samples = perRun.flatMap((run) => run.samples);
  const attempted = samples.length;
  const complete = samples.filter(isCompleteFamilySample);
  const bounded = perRun.length > 0 && perRun.every((run) => run.window);
  const reason = failure
    ?? (bounded ? null : `The ${id} resource window was never recorded.`)
    ?? (attempted === 0 ? `The ${id} resource window contains no samples.` : null)
    ?? (complete.length === attempted ? null : `The resource monitor lost part of the declared application process family during the ${id} window.`);
  const rssBytes = complete.map((sample) => sample.rssBytes);
  const cpu = windowCpuPercent(perRun);
  const cpuReason = reason ?? cpu.reason;
  return {
    sampleCount: attempted,
    observedWindowDurationMs: bounded ? round(median(perRun.map((run) => run.window.endMs - run.window.startMs))) : null,
    observedSampleIntervalMs: observedSampleInterval(perRun),
    rssP95MiB: reason ? invalidMetric(reason, complete.length, attempted) : validMetric({ p95: round(percentile(rssBytes, 95) / MIB) }, complete.length, attempted),
    rssMaximumMiB: reason ? invalidMetric(reason, complete.length, attempted) : validMetric({ maximum: round(maximum(rssBytes) / MIB) }, complete.length, attempted),
    cpuP95Percent: cpuReason ? invalidMetric(cpuReason, cpu.values.length, cpu.attempted) : validMetric({ p95: round(percentile(cpu.values, 95)) }, cpu.values.length, cpu.attempted),
  };
}

function windowCpuPercent(perRun) {
  const values = [];
  let attempted = 0;
  let reason = null;
  for (const run of perRun) {
    for (let index = 1; index < run.samples.length; index += 1) {
      const before = run.samples[index - 1];
      const after = run.samples[index];
      attempted += 1;
      // Two snapshots sharing one millisecond carry no measurable interval; they stay in the
      // attempted count so the reported valid/attempted pair discloses them.
      if (after.atMs <= before.atMs) continue;
      try {
        values.push((cpuDeltaMsBetween(before, after) / (after.atMs - before.atMs)) * 100);
      } catch (error) {
        reason ??= error instanceof Error ? error.message : String(error);
      }
    }
  }
  if (!reason && attempted === 0) reason = "The window has no consecutive sample pair to measure CPU across.";
  if (!reason && values.length === 0) reason = "No measurable CPU interval was observed in the window.";
  return { values, attempted, reason };
}

function retainedRssGrowth(baseline, ending) {
  const valid = Math.min(baseline.valid, ending.valid);
  const attempted = Math.min(baseline.attempted, ending.attempted);
  if (baseline.status !== "valid" || ending.status !== "valid") {
    return invalidMetric(baseline.status === "valid" ? ending.reason : baseline.reason, valid, attempted);
  }
  return { status: "valid", signed: true, p95: round(ending.p95 - baseline.p95), valid, attempted };
}

function processFamilyEvidence(runs) {
  const samples = runs.flatMap((run) => run.samples);
  return {
    samplesMissingRootProcess: samples.filter((sample) => sample.rootProcessFound === false).length,
    samplesWithInaccessibleProcesses: samples.filter((sample) => (sample.inaccessibleProcessCount ?? 0) > 0).length,
    samplesMissingExternalProcesses: samples.filter((sample) => (sample.missingExternalProcessCount ?? 0) > 0).length,
    monitorErrorCount: runs.reduce((total, run) => total + (run.monitorErrors?.length ?? 0), 0),
    observedProcessNames: [...new Set(samples.flatMap((sample) => sample.processes.map((process) => process.name)).filter(Boolean))].toSorted().slice(0, 12),
    maximumObservedProcessCount: samples.reduce((most, sample) => Math.max(most, sample.processes.length), 0),
  };
}

function observedSampleInterval(perRun) {
  const gaps = perRun.flatMap((run) => run.samples.slice(1).map((sample, index) => sample.atMs - run.samples[index].atMs)).filter((gap) => gap > 0);
  return gaps.length === 0 ? null : round(median(gaps));
}

const median = (values) => percentile(values, 50);
const validMetric = (fields, valid, attempted) => ({ status: "valid", ...fields, valid, attempted });
const invalidMetric = (reason, valid, attempted) => ({ status: "invalid", reason, valid, attempted });
const isCompleteFamilySample = (sample) => sample.rootProcessFound !== false
  && (sample.inaccessibleProcessCount ?? 0) === 0
  && (sample.missingExternalProcessCount ?? 0) === 0;

const MIB = 1024 * 1024;
const isValid = (observation) => observation.status === "valid" && Number.isFinite(observation.durationMs) && observation.durationMs >= 0;
const within = (samples, window) => samples.filter((sample) => sample.atMs >= window.startMs && sample.atMs <= window.endMs);
