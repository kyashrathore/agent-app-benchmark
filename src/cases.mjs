import { createHash } from "node:crypto";

export const SESSION_LANES = Object.freeze([
  { id: "within-workspace-cold", workspaceRelation: "within-workspace", sessionState: "cold" },
  { id: "within-workspace-warm", workspaceRelation: "within-workspace", sessionState: "warm" },
  { id: "across-workspaces-cold", workspaceRelation: "across-workspaces", sessionState: "cold" },
  { id: "across-workspaces-warm", workspaceRelation: "across-workspaces", sessionState: "warm" },
]);

export const WORKSPACE_PANEL_ACTIONS = Object.freeze([
  "open-cold",
  "interrupt-open-close",
  "interrupt-close-open",
  "open-warm-data",
  "switch-surface",
  "open-file",
  "switch-file-tab",
  "toggle-diff-view",
  "collapse-all",
  "expand-all",
]);

export const PANEL_PROFILES = Object.freeze(["closed", "files", "diff"]);

export function expandCases(scenario, runProfile, seed = "agent-app-benchmark-public-v1", repetitionOverride) {
  const repetitions = repetitionsFor(scenario, runProfile, repetitionOverride);
  if (scenario.kind === "app-start") {
    const cases = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const startMode of rotate(scenario.cases.startModes, repetition % scenario.cases.startModes.length)) {
        cases.push({
          caseId: `start-${startMode}-${repetition}`,
          repetition,
          startMode,
          stateHandle: startMode === "new-application-state" ? "P0" : "P1",
        });
      }
    }
    return cases;
  }
  if (scenario.kind === "session-switch") return buildLatencyGroups(scenario, runProfile, seed, repetitionOverride).flatMap((group) => group.cases);
  if (scenario.kind === "workspace-panel") return buildWorkspacePanelGroups(scenario, runProfile, repetitionOverride).flatMap((group) => group.cases);
  if (scenario.kind === "session-switch-workspace-panel") return buildPanelSwitchGroups(scenario, runProfile, seed, repetitionOverride).flatMap((group) => group.cases);
  throw new Error(`Unsupported scenario kind ${scenario.kind}.`);
}

export function buildWorkspacePanelGroups(scenario, runProfile, repetitionOverride) {
  if (scenario.kind !== "workspace-panel") throw new Error("Workspace-panel groups require a workspace-panel scenario.");
  const repetitions = repetitionsFor(scenario, runProfile, repetitionOverride);
  return Array.from({ length: repetitions }, (_, repetition) => ({
    groupId: `workspace-panel-${repetition}`,
    repetition,
    cases: scenario.cases.actions.map((action, sequence) => ({
      caseId: `workspace-panel-${repetition}-${action}`,
      repetition,
      sequence,
      workload: "workspace-panel-action",
      action,
    })),
  }));
}

export function buildPanelSwitchGroups(scenario, runProfile, seed = "agent-app-benchmark-public-v1", repetitionOverride) {
  if (scenario.kind !== "session-switch-workspace-panel") throw new Error("Panel-switch groups require a session-switch-workspace-panel scenario.");
  const repetitions = repetitionsFor(scenario, runProfile, repetitionOverride);
  return Array.from({ length: repetitions }, (_, repetition) => {
    const cases = PANEL_PROFILES.flatMap((panelProfile, profileIndex) => SESSION_LANES.map((lane) => ({
      caseId: `panel-session-switch-${repetition}-${panelProfile}-${lane.id}`,
      repetition,
      sample: profileIndex,
      workload: "panel-session-switch",
      workspaceRelation: lane.workspaceRelation,
      sessionState: lane.sessionState,
      panelProfile,
      transcriptBytes: scenario.cases.transcriptBytes,
      sourceSessionId: "control",
      destinationSessionId: `latency-${lane.id}-${profileIndex}-${scenario.cases.transcriptBytes}`,
    })));
    return {
      groupId: `panel-session-switch-${repetition}`,
      repetition,
      cases: seededShuffle(cases, `${seed}|panel-session-switch|${repetition}`).map((benchmarkCase, sequence) => ({ ...benchmarkCase, sequence })),
    };
  });
}

export function buildLatencyGroups(scenario, runProfile, seed = "agent-app-benchmark-public-v1", repetitionOverride) {
  const repetitions = repetitionsFor(scenario, runProfile, repetitionOverride);
  const transcriptBytes = scenario.cases.standardTranscriptBytes ?? scenario.cases.transcriptBytes[0];
  const samplesPerLane = scenario.cases.latencySamplesPerProcess ?? 1;
  const sizeSamplesPerProcess = scenario.cases.sizeSamplesPerProcess ?? 0;
  const groups = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    if (samplesPerLane === 1 && sizeSamplesPerProcess === 0) {
      for (const lane of seededShuffle(SESSION_LANES, `${seed}|lanes|${repetition}`)) {
        groups.push({
          groupId: `latency-${lane.id}-${repetition}`,
          repetition,
          lane,
          cases: [makeSwitchCase({ lane, transcriptBytes, repetition, sequence: 0, workload: "isolated-latency" })],
        });
      }
      continue;
    }
    const standardCases = [];
    for (const lane of SESSION_LANES) {
      for (let sample = 0; sample < samplesPerLane; sample += 1) {
        standardCases.push(makeSwitchCase({
          lane,
          transcriptBytes,
          repetition,
          sequence: sample,
          sample,
          workload: "isolated-latency",
          destinationSessionId: `latency-${lane.id}-${sample}-${transcriptBytes}`,
        }));
      }
    }
    const sizeCases = [];
    for (let sample = 0; sample < sizeSamplesPerProcess; sample += 1) {
      const sizes = counterbalancedSizes(scenario.cases.transcriptBytes, repetition + sample);
      for (let sequence = 0; sequence < sizes.length; sequence += 1) {
        const size = sizes[sequence];
        sizeCases.push(makeSwitchCase({
          lane: SESSION_LANES[0],
          transcriptBytes: size,
          repetition,
          sequence,
          sample,
          workload: "transcript-size-latency",
          destinationSessionId: `size-latency-${sample}-${size}`,
        }));
      }
    }
    const cases = [
      ...seededShuffle(standardCases, `${seed}|standard-cases|${repetition}`),
      ...sizeCases,
    ];
      groups.push({
        groupId: `latency-process-${repetition}`,
        repetition,
        lane: null,
        cases,
      });
  }
  return groups;
}

export function buildResourceSequence(scenario, repetition = 0) {
  if (scenario.kind !== "session-switch") throw new Error("Resource sequence requires a session-switch scenario.");
  const repetitionIndex = Number.isInteger(repetition) ? repetition : 0;
  const lane = SESSION_LANES[0];
  return scenario.cases.transcriptBytes.map((transcriptBytes, sequence) =>
    makeSwitchCase({
      lane,
      transcriptBytes,
      repetition: repetitionIndex,
      sequence,
      workload: "progressive-resource",
      destinationSessionId: scenario.cases.latencySamplesPerProcess
        ? `progressive-resource-${transcriptBytes}`
        : undefined,
    }),
  );
}

export function buildResourceSequences(scenario, repetitions) {
  return Array.from({ length: repetitions }, (_, repetition) => ({
    groupId: `progressive-resource-${repetition}`,
    repetition,
    cases: buildResourceSequence(scenario, repetition),
  }));
}

function makeSwitchCase({ lane, transcriptBytes, repetition, sequence, sample, workload, destinationSessionId }) {
  return {
    caseId: `${workload}-${repetition}-${lane.id}-${transcriptBytes}${sample === undefined ? "" : `-${sample}`}`,
    repetition,
    sequence,
    ...(sample === undefined ? {} : { sample }),
    workload,
    workspaceRelation: lane.workspaceRelation,
    sessionState: lane.sessionState,
    transcriptBytes,
    sourceSessionId: "control",
    destinationSessionId: destinationSessionId ?? `${lane.id}-${transcriptBytes}`,
  };
}

export function repetitionsFor(scenario, runProfile, repetitionOverride) {
  const profileRepetitions = scenario.runProfiles[runProfile];
  if (!Number.isInteger(profileRepetitions) || profileRepetitions < 1) throw new Error(`Unknown run profile: ${runProfile}.`);
  if (repetitionOverride === undefined) return profileRepetitions;
  if (!Number.isInteger(repetitionOverride) || repetitionOverride < 1 || repetitionOverride > 100) {
    throw new Error("Repetitions must be an integer from 1 through 100.");
  }
  return repetitionOverride;
}

function seededShuffle(values, seed) {
  return [...values].sort((left, right) => score(seed, left) - score(seed, right));
}

function score(seed, value) {
  const identity = typeof value === "object" ? (value.id ?? value.caseId) : String(value);
  return Number.parseInt(createHash("sha256").update(`${seed}|${identity}`).digest("hex").slice(0, 12), 16);
}

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function counterbalancedSizes(values, ordinal) {
  const rotated = rotate(values, ordinal % values.length);
  return ordinal % 2 === 0 ? rotated : rotated.toReversed();
}
