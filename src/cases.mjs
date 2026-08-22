export function expandCases(scenario, runProfile) {
  const repetitions = scenario.runProfiles[runProfile];
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error(`Unknown run profile: ${runProfile}`);
  if (scenario.kind === "app-start") {
    return Array.from({ length: repetitions }, (_, repetition) =>
      scenario.cases.startModes.map((startMode) => ({
        caseId: `${startMode}-${repetition}`,
        repetition,
        startMode,
      })),
    ).flat();
  }
  if (scenario.kind === "session-switch") {
    const cases = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const transcriptBytes of scenario.cases.transcriptBytes) {
        for (const workspaceRelation of scenario.cases.workspaceRelations) {
          for (const sessionState of ["cold", "warm"]) {
            const destinationWorkspace = workspaceRelation === "within-workspace" ? "workspace-a" : "workspace-b";
            cases.push({
              caseId: `${repetition}-${workspaceRelation}-${sessionState}-${transcriptBytes}`,
              repetition,
              workspaceRelation,
              sessionState,
              transcriptBytes,
              sourceSessionId: "workspace-a-source",
              destinationSessionId: `${destinationWorkspace}-session-${transcriptBytes}`,
            });
          }
        }
      }
    }
    return cases;
  }
  throw new Error(`The runner does not know how to expand custom scenario kind ${scenario.kind}.`);
}
