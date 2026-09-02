import assert from "node:assert/strict";
import test from "node:test";
import { buildLatencyGroups, buildPanelSwitchGroups, buildResourceSequence, buildResourceSequences, buildSessionNavigationGroups, buildWorkspacePanelGroups, expandCases, PANEL_LOAD_PROFILES, repetitionsFor, SESSION_LANES, STRUCTURED_SESSION_LANES, WORKSPACE_PANEL_ACTIONS, WORKSPACE_PANEL_V2_ACTIONS } from "../src/cases.mjs";
import { readRegistered } from "../src/registry.mjs";

test("resource sequence progresses exact sizes through one fixed representative lane", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = buildResourceSequence(scenario);
  assert.deepEqual(cases.map((item) => item.transcriptBytes), scenario.cases.transcriptBytes);
  assert.ok(cases.every((item) => item.workspaceRelation === "within-workspace"));
  assert.ok(cases.every((item) => item.sessionState === "cold"));
});

test("app start schedules both exact process-launch states", async () => {
  const { value: scenario } = await readRegistered("scenario", "app-start-v1");
  const cases = expandCases(scenario, "smoke");
  assert.equal(cases.length, 2);
  assert.equal(cases.filter((item) => item.stateHandle === "P0").length, 1);
  assert.equal(cases.filter((item) => item.stateHandle === "P1").length, 1);
});

test("session switching uses stabilized process pools, structured lane order, counterbalanced size order, and repeated fresh resource runs", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const groups = buildLatencyGroups(scenario, "quick", "v3-seed");
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.cases.filter((item) => item.workload === "isolated-latency").length === 20));
  for (const lane of SESSION_LANES) {
    assert.equal(groups.flatMap((group) => group.cases).filter((item) => item.workload === "isolated-latency" && item.workspaceRelation === lane.workspaceRelation && item.sessionState === lane.sessionState).length, 10);
  }
  const standard = groups[0].cases.filter((item) => item.workload === "isolated-latency");
  // Standard cases are seeded-shuffled within the stabilized process so no lane is pinned to a
  // fixed process age; the schedule is identical for every application under the same seed.
  assert.deepEqual(
    [...new Set(standard.map((item) => `${item.workspaceRelation}:${item.sessionState}`))].sort(),
    STRUCTURED_SESSION_LANES.map((lane) => `${lane.workspaceRelation}:${lane.sessionState}`).sort(),
  );
  assert.deepEqual(
    buildLatencyGroups(scenario, "quick", "v3-seed")[0].cases.map((item) => item.caseId),
    groups[0].cases.map((item) => item.caseId),
  );
  assert.deepEqual(
    standard.filter((item) => item.workspaceRelation === "within-workspace" && item.sessionState === "warm").map((item) => item.sample).sort((left, right) => left - right),
    Array.from({ length: scenario.cases.latencySamplesPerProcess }, (_, index) => index),
  );
  const sizeOrders = groups.map((group) => group.cases.filter((item) => item.workload === "transcript-size-latency").map((item) => item.transcriptBytes));
  assert.notDeepEqual(sizeOrders[0], sizeOrders[1]);
  const resourceRuns = buildResourceSequences(scenario, 2);
  assert.equal(resourceRuns.length, 2);
  assert.deepEqual(resourceRuns[0].cases.map((item) => item.transcriptBytes), scenario.cases.transcriptBytes);
  assert.ok(resourceRuns.flatMap((run) => run.cases).every((item) => item.destinationSessionId.startsWith("progressive-resource-")));
});

test("session navigation walks all first-visits then all returns without interleaved pairs", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-navigation-v1");
  const groups = buildSessionNavigationGroups(scenario, "smoke", 2);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.cases.length === scenario.cases.transcriptBytes.length * 2 + PANEL_LOAD_PROFILES.length));
  const expectedSizes = [...scenario.cases.transcriptBytes].toReversed();
  for (const group of groups) {
    const history = group.cases.filter((item) => item.trend === "history-size");
    const firstVisits = history.filter((item) => item.navigationType === "first-visit");
    const returns = history.filter((item) => item.navigationType === "return-visited-panel-closed");
    assert.deepEqual(firstVisits.map((item) => item.transcriptBytes), expectedSizes);
    assert.deepEqual(returns.map((item) => item.transcriptBytes), expectedSizes);
    // The return walk must never start on the destination the last first-visit left active.
    assert.notEqual(returns[0].destinationSessionId, firstVisits.at(-1).destinationSessionId);
    for (let index = 1; index < history.length; index += 1) {
      assert.notEqual(history[index].destinationSessionId, history[index - 1].destinationSessionId);
    }
    assert.ok(Math.max(...firstVisits.map((item) => item.sequence)) < Math.min(...returns.map((item) => item.sequence)));
    assert.deepEqual(
      history.map((item) => item.navigationType),
      [...firstVisits.map(() => "first-visit"), ...returns.map(() => "return-visited-panel-closed")],
    );
    const panel = group.cases.filter((item) => item.trend === "panel-load");
    assert.deepEqual(
      panel.map((item) => item.loadProfile),
      rotate(scenario.cases.panelLoads, group.repetition % scenario.cases.panelLoads.length).map((item) => item.id),
    );
    assert.ok(panel.every((item) => item.navigationType === "return-visited-panel-open"));
    assert.ok(group.cases.every((item) => item.sessionState === undefined && item.workspaceRelation === undefined));
    assert.ok(history.every((item) => item.sequence < panel[0].sequence));
  }
  assert.deepEqual(
    groups[0].cases.filter((item) => item.trend === "history-size").map((item) => item.transcriptBytes),
    groups[1].cases.filter((item) => item.trend === "history-size").map((item) => item.transcriptBytes),
  );
});

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

test("workspace panel V2 emits ordinary interactions across each explicit load profile", async () => {
  const { value: scenario } = await readRegistered("scenario", "workspace-panel-v1");
  const [group] = buildWorkspacePanelGroups(scenario, "smoke");
  assert.equal(group.cases.length, PANEL_LOAD_PROFILES.length * WORKSPACE_PANEL_V2_ACTIONS.length);
  for (const loadProfile of PANEL_LOAD_PROFILES) {
    assert.deepEqual(group.cases.filter((item) => item.loadProfile === loadProfile).map((item) => item.action), WORKSPACE_PANEL_V2_ACTIONS);
  }
  assert.ok(group.cases.every((item) => item.workload === "workspace-panel-interaction"));
  assert.ok(group.cases.every((item) => !item.action.includes("toggle")));
});

test("session switching schedules five samples per lane plus long-row size cases", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const groups = buildLatencyGroups(scenario, "publication", "seed", 1);
  assert.equal(groups.length, 1);
  const cases = groups[0].cases;
  assert.equal(cases.filter((item) => item.workload === "isolated-latency").length, 4 * 5);
  const sizeCases = cases.filter((item) => item.workload === "transcript-size-latency" && item.rowShape === undefined);
  const longRowCases = cases.filter((item) => item.workload === "transcript-size-latency" && item.rowShape === "long");
  assert.equal(sizeCases.length, 2 * 4);
  assert.equal(longRowCases.length, 2 * 3);
  assert.ok(longRowCases.every((item) => item.destinationSessionId === `size-latency-long-${item.sample}-${item.transcriptBytes}` && item.caseId.includes("long-rows")));
  assert.equal(new Set(cases.map((item) => item.caseId)).size, cases.length);
});
