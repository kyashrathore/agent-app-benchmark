/** The lane the progressive memory run switches in; its steps are not scored latencies. */
const RESOURCE_LANE = Object.freeze({ id: "within-workspace-cold", workspaceRelation: "within-workspace", sessionState: "cold" });

export function expandCases(scenario, runProfile, repetitionOverride) {
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
  if (scenario.kind === "session-switch") return buildWalkGroups(scenario, runProfile, repetitionOverride).flatMap((group) => group.cases);
  throw new Error(`Unsupported scenario kind ${scenario.kind}.`);
}

/**
 * One process per repetition walks the session list top to bottom: every
 * destination is the row below the previous one, first on a visit that opens
 * each session for the first time, then on a second visit in the same order
 * that returns to each. The walk starts from the control session the app is
 * launched on, so its first step comes from a session outside the list.
 */
export function buildWalkGroups(scenario, runProfile, repetitionOverride) {
  const walk = scenario.cases.walk;
  return Array.from({ length: repetitionsFor(scenario, runProfile, repetitionOverride) }, (_, repetition) => {
    const cases = [];
    let source = { sessionId: "control", workspaceId: walk.controlWorkspaceId };
    for (const [passIndex, sessionState] of walk.passes.entries()) {
      for (const [position, destination] of walk.sessions.entries()) {
        cases.push({
          caseId: `list-walk-${repetition}-${sessionState}-${String(position).padStart(2, "0")}-${destination.sessionId}`,
          repetition,
          sequence: cases.length,
          workload: "list-walk",
          walkPass: passIndex + 1,
          walkPosition: position,
          workspaceRelation: source.workspaceId === destination.workspaceId ? "within-workspace" : "across-workspaces",
          sessionState,
          transcriptBytes: destination.transcriptBytes,
          ...(destination.rowShape === undefined ? {} : { rowShape: destination.rowShape }),
          sourceSessionId: source.sessionId,
          destinationSessionId: destination.sessionId,
        });
        source = destination;
      }
    }
    return { groupId: `list-walk-${repetition}`, repetition, lane: null, cases };
  });
}

export function buildResourceSequence(scenario, repetition = 0) {
  if (scenario.kind !== "session-switch") throw new Error("Resource sequence requires a session-switch scenario.");
  const repetitionIndex = Number.isInteger(repetition) ? repetition : 0;
  return scenario.cases.transcriptBytes.map((transcriptBytes, sequence) => ({
    caseId: `progressive-resource-${repetitionIndex}-${RESOURCE_LANE.id}-${transcriptBytes}`,
    repetition: repetitionIndex,
    sequence,
    workload: "progressive-resource",
    workspaceRelation: RESOURCE_LANE.workspaceRelation,
    sessionState: RESOURCE_LANE.sessionState,
    transcriptBytes,
    sourceSessionId: "control",
    destinationSessionId: `progressive-resource-${transcriptBytes}`,
  }));
}

/** Progressive memory processes: `resourceRuns` when the scenario declares it, else one per repetition. */
export function buildResourceSequences(scenario, repetitions) {
  return Array.from({ length: scenario.cases.resourceRuns ?? repetitions }, (_, repetition) => ({
    groupId: `progressive-resource-${repetition}`,
    repetition,
    cases: buildResourceSequence(scenario, repetition),
  }));
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

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}
