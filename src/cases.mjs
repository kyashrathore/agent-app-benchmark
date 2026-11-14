import { createHash } from "node:crypto";

/** The lane the progressive memory run switches in; its steps are not scored latencies. */
const RESOURCE_LANE = Object.freeze({ id: "within-workspace-cold", workspaceRelation: "within-workspace", sessionState: "cold" });
const LAUNCHED_KINDS = new Set(["session-switch", "new-thread", "long-thread", "typing-while-streaming"]);

/** Every observation the schedule requires, in order. */
export function expandCases(scenario, runProfile, repetitionOverride) {
  if (scenario.kind === "app-start") return appStartCases(scenario, repetitionsFor(scenario, runProfile, repetitionOverride));
  if (LAUNCHED_KINDS.has(scenario.kind)) return buildGroups(scenario, runProfile, repetitionOverride).flatMap((group) => group.cases);
  throw new Error(`Unsupported scenario kind ${scenario.kind}.`);
}

function appStartCases(scenario, repetitions) {
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

/**
 * One launched process per group. Each action is one `execute` request; its
 * `cases` are the observations the framework derives from the response, which
 * is the request itself except for typing, where one request yields one
 * observation per key.
 */
export function buildGroups(scenario, runProfile, repetitionOverride) {
  const repetitions = repetitionsFor(scenario, runProfile, repetitionOverride);
  const build = { "session-switch": walkGroup, "new-thread": newThreadGroup, "long-thread": longThreadGroup, "typing-while-streaming": typingGroup }[scenario.kind];
  if (!build) throw new Error(`Scenario kind ${scenario.kind} has no launched groups.`);
  return Array.from({ length: repetitions }, (_, repetition) => {
    const group = build(scenario, runProfile, repetition);
    const actions = group.actions ?? group.cases.map((benchmarkCase) => ({ request: benchmarkCase, cases: [benchmarkCase] }));
    return { ...group, actions };
  });
}

/**
 * The process walks the session list top to bottom: every destination is the
 * row below the previous one, first on a visit that opens each session for
 * the first time, then on a second visit in the same order that returns to
 * each. The walk starts from the control session the app is launched on, so
 * its first step comes from a session outside the list.
 */
function walkGroup(scenario, _runProfile, repetition) {
  const walk = scenario.cases.walk;
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
        nominalBytes: destination.nominalBytes,
        sourceSessionId: source.sessionId,
        destinationSessionId: destination.sessionId,
      });
      source = destination;
    }
  }
  return { groupId: `list-walk-${repetition}`, repetition, cases };
}

function newThreadGroup(scenario, runProfile, repetition) {
  const samples = profileOf(scenario, runProfile).samplesPerProcess;
  const cases = Array.from({ length: samples }, (_, sample) => ({
    caseId: `new-thread-${repetition}-${String(sample).padStart(2, "0")}`,
    repetition,
    sample,
    sequence: sample,
    workload: "new-thread",
    sourceSessionId: scenario.cases.sourceSessionId,
  }));
  return { groupId: `new-thread-${repetition}`, repetition, cases };
}

/** Each visit is a list-walk step from the control session to the long thread, then the scroll over it. */
function longThreadGroup(scenario, _runProfile, repetition) {
  const { sourceSessionId, sessionId, visits, scroll } = scenario.cases;
  const cases = visits.flatMap((sessionState, visit) => [
    {
      caseId: `long-thread-open-${repetition}-${sessionState}`,
      repetition,
      sequence: visit * 2,
      workload: "long-thread-open",
      sessionState,
      sourceSessionId,
      destinationSessionId: sessionId,
    },
    {
      caseId: `long-thread-scroll-${repetition}-${sessionState}`,
      repetition,
      sequence: visit * 2 + 1,
      workload: "long-thread-scroll",
      sessionState,
      destinationSessionId: sessionId,
      scroll: { wheelCount: scroll.wheelCount, deltaY: scroll.deltaY, intervalMs: scroll.intervalMs, tailMs: scroll.tailMs },
    },
  ]);
  return { groupId: `long-thread-${repetition}`, repetition, cases };
}

function typingGroup(scenario, runProfile, repetition) {
  const profile = profileOf(scenario, runProfile);
  const { keys, streams } = scenario.cases;
  const firstWords = Array.from({ length: profile.streamCount }, (_, sample) => ({
    caseId: `stream-first-word-${repetition}-${sample}`,
    repetition,
    sample,
    sequence: sample,
    workload: "stream-first-word",
    startIntervalMs: streams.startIntervalMs,
  }));
  const keyCases = keySchedule(keys, profile.keyCount).map(({ key, delayMs }, sample) => ({
    caseId: `typing-key-${repetition}-${String(sample).padStart(3, "0")}`,
    repetition,
    sample,
    sequence: profile.streamCount + sample,
    workload: "typing-key",
    key,
    delayMs,
  }));
  const typing = {
    caseId: `typing-${repetition}`,
    repetition,
    workload: "typing",
    keys: keyCases.map(({ key, delayMs }) => ({ key, delayMs })),
    missAfterMs: keys.missAfterMs,
  };
  return {
    groupId: `typing-while-streaming-${repetition}`,
    repetition,
    cases: [...firstWords, ...keyCases],
    actions: [...firstWords.map((benchmarkCase) => ({ request: benchmarkCase, cases: [benchmarkCase] })), { request: typing, cases: keyCases }],
  };
}

/** The first key is pressed at once; each later one `intervalMs` after the one before, ± `jitter`, from a fixed seed. */
export function keySchedule(keys, count) {
  if (count > keys.sequence.length) throw new Error(`The key sequence holds ${keys.sequence.length} keys; ${count} are required.`);
  return Array.from(keys.sequence.slice(0, count), (key, index) => {
    if (index === 0) return { key, delayMs: 0 };
    const unit = Number.parseInt(createHash("sha256").update(`${keys.seed}:${index}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
    return { key, delayMs: Math.round(keys.intervalMs * (1 - keys.jitter + 2 * keys.jitter * unit)) };
  });
}

export function profileOf(scenario, runProfile) {
  const profile = scenario.cases.profiles?.[runProfile];
  if (!profile) throw new Error(`Unknown run profile: ${runProfile}.`);
  return profile;
}

export function buildResourceSequence(scenario, repetition = 0) {
  if (scenario.kind !== "session-switch") throw new Error("Resource sequence requires a session-switch scenario.");
  const repetitionIndex = Number.isInteger(repetition) ? repetition : 0;
  return scenario.cases.nominalBytes.map((nominalBytes, sequence) => ({
    caseId: `progressive-resource-${repetitionIndex}-${RESOURCE_LANE.id}-${nominalBytes}`,
    repetition: repetitionIndex,
    sequence,
    workload: "progressive-resource",
    workspaceRelation: RESOURCE_LANE.workspaceRelation,
    sessionState: RESOURCE_LANE.sessionState,
    nominalBytes,
    sourceSessionId: "control",
    destinationSessionId: `progressive-resource-${nominalBytes}`,
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
