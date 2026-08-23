import { createHash } from "node:crypto";

export const SESSION_LANES = Object.freeze([
  { id: "within-workspace-cold", workspaceRelation: "within-workspace", sessionState: "cold" },
  { id: "within-workspace-warm", workspaceRelation: "within-workspace", sessionState: "warm" },
  { id: "across-workspaces-cold", workspaceRelation: "across-workspaces", sessionState: "cold" },
  { id: "across-workspaces-warm", workspaceRelation: "across-workspaces", sessionState: "warm" },
]);

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
  if (scenario.kind !== "session-switch") throw new Error(`Unsupported scenario kind ${scenario.kind}.`);
  return buildLatencyGroups(scenario, runProfile, seed, repetitionOverride).flatMap((group) => group.cases);
}

export function buildLatencyGroups(scenario, runProfile, seed = "agent-app-benchmark-public-v1", repetitionOverride) {
  const repetitions = repetitionsFor(scenario, runProfile, repetitionOverride);
  const baseOrder = seededShuffle(scenario.cases.transcriptBytes, `${seed}|sizes`);
  const groups = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const lane of seededShuffle(SESSION_LANES, `${seed}|lanes|${repetition}`)) {
      const sizes = rotate(baseOrder, repetition % baseOrder.length);
      groups.push({
        groupId: `latency-${lane.id}-${repetition}`,
        repetition,
        lane,
        cases: sizes.map((transcriptBytes, sequence) => makeSwitchCase({ lane, transcriptBytes, repetition, sequence, workload: "isolated-latency" })),
      });
    }
  }
  return groups;
}

export function buildResourceSequence(scenario) {
  if (scenario.kind !== "session-switch") throw new Error("Resource sequence requires a session-switch scenario.");
  const lane = SESSION_LANES[0];
  return scenario.cases.transcriptBytes.map((transcriptBytes, sequence) =>
    makeSwitchCase({
      lane,
      transcriptBytes,
      repetition: 0,
      sequence,
      workload: "progressive-resource",
    }),
  );
}

function makeSwitchCase({ lane, transcriptBytes, repetition, sequence, workload }) {
  return {
    caseId: `${workload}-${repetition}-${lane.id}-${transcriptBytes}`,
    repetition,
    sequence,
    workload,
    workspaceRelation: lane.workspaceRelation,
    sessionState: lane.sessionState,
    transcriptBytes,
    sourceSessionId: "control",
    destinationSessionId: `${lane.id}-${transcriptBytes}`,
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
  const identity = typeof value === "object" ? value.id : String(value);
  return Number.parseInt(createHash("sha256").update(`${seed}|${identity}`).digest("hex").slice(0, 12), 16);
}

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}
