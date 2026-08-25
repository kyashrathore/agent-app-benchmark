import assert from "node:assert/strict";
import test from "node:test";
import { buildLatencyGroups, buildPanelSwitchGroups, buildResourceSequence, buildResourceSequences, buildSessionNavigationGroups, buildWorkspacePanelGroups, expandCases, PANEL_LOAD_PROFILES, repetitionsFor, SESSION_LANES, WORKSPACE_PANEL_ACTIONS, WORKSPACE_PANEL_V2_ACTIONS } from "../src/cases.mjs";
import { readRegistered } from "../src/registry.mjs";

test("publication schedule emits 2 observations per lane at the fixed standard size", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = expandCases(scenario, "publication");
  assert.equal(cases.length, 4 * 2);
  for (const lane of SESSION_LANES) {
    assert.equal(cases.filter((item) => item.workspaceRelation === lane.workspaceRelation && item.sessionState === lane.sessionState && item.transcriptBytes === scenario.cases.transcriptBytes[0]).length, 2);
  }
});

test("a run can override its profile repetition count", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = expandCases(scenario, "publication", "override-seed", 4);
  assert.equal(cases.length, 4 * 4);
  assert.equal(repetitionsFor(scenario, "publication", undefined), 2);
  assert.equal(repetitionsFor(scenario, "publication", 4), 4);
  assert.throws(() => repetitionsFor(scenario, "publication", 0), /1 through 100/u);
  assert.throws(() => repetitionsFor(scenario, "publication", 101), /1 through 100/u);
});

test("isolated groups use one fixed-size lane per fresh process", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const groups = buildLatencyGroups(scenario, "publication", "fixed-seed");
  assert.equal(groups.length, 8);
  assert.ok(groups.every((group) => group.cases.length === 1));
  assert.ok(groups.every((group) => new Set(group.cases.map((item) => `${item.workspaceRelation}:${item.sessionState}`)).size === 1));
  assert.ok(groups.every((group) => group.cases[0].transcriptBytes === scenario.cases.transcriptBytes[0]));
});

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

test("V3 uses stabilized process pools, counterbalanced size order, and repeated fresh resource runs", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v3");
  const groups = buildLatencyGroups(scenario, "quick", "v3-seed");
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.cases.filter((item) => item.workload === "isolated-latency").length === 40));
  for (const lane of SESSION_LANES) {
    assert.equal(groups.flatMap((group) => group.cases).filter((item) => item.workload === "isolated-latency" && item.workspaceRelation === lane.workspaceRelation && item.sessionState === lane.sessionState).length, 20);
  }
  const sizeOrders = groups.map((group) => group.cases.filter((item) => item.workload === "transcript-size-latency").map((item) => item.transcriptBytes));
  assert.notDeepEqual(sizeOrders[0], sizeOrders[1]);
  const resourceRuns = buildResourceSequences(scenario, 2);
  assert.equal(resourceRuns.length, 2);
  assert.deepEqual(resourceRuns[0].cases.map((item) => item.transcriptBytes), scenario.cases.transcriptBytes);
  assert.ok(resourceRuns.flatMap((run) => run.cases).every((item) => item.destinationSessionId.startsWith("progressive-resource-")));
});

test("workspace panel schedules one raw per-action observation in each process", async () => {
  const { value: scenario } = await readRegistered("scenario", "workspace-panel-v1");
  const groups = buildWorkspacePanelGroups(scenario, "smoke");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].cases.map((item) => item.action), WORKSPACE_PANEL_ACTIONS);
  assert.ok(groups[0].cases.every((item) => item.workload === "workspace-panel-action"));
});

test("session navigation emits paired first and return visits by history size plus one open-panel trend", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-navigation-v1");
  const groups = buildSessionNavigationGroups(scenario, "smoke", 2);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.cases.length === scenario.cases.transcriptBytes.length * 2 + PANEL_LOAD_PROFILES.length));
  for (const group of groups) {
    const history = group.cases.filter((item) => item.trend === "history-size");
    for (const transcriptBytes of scenario.cases.transcriptBytes) {
      const pair = history.filter((item) => item.transcriptBytes === transcriptBytes);
      assert.deepEqual(pair.map((item) => item.navigationType), ["first-visit", "return-visited-panel-closed"]);
      assert.equal(new Set(pair.map((item) => item.destinationSessionId)).size, 1);
    }
    const panel = group.cases.filter((item) => item.trend === "panel-load");
    assert.deepEqual(new Set(panel.map((item) => item.loadProfile)), new Set(PANEL_LOAD_PROFILES));
    assert.ok(panel.every((item) => item.navigationType === "return-visited-panel-open"));
    assert.ok(group.cases.every((item) => item.sessionState === undefined && item.workspaceRelation === undefined));
  }
  assert.notDeepEqual(
    groups[0].cases.filter((item) => item.trend === "history-size").map((item) => item.transcriptBytes),
    groups[1].cases.filter((item) => item.trend === "history-size").map((item) => item.transcriptBytes),
  );
});

test("workspace panel V2 emits ordinary interactions across each explicit load profile", async () => {
  const { value: scenario } = await readRegistered("scenario", "workspace-panel-v2");
  const [group] = buildWorkspacePanelGroups(scenario, "smoke");
  assert.equal(group.cases.length, PANEL_LOAD_PROFILES.length * WORKSPACE_PANEL_V2_ACTIONS.length);
  for (const loadProfile of PANEL_LOAD_PROFILES) {
    assert.deepEqual(group.cases.filter((item) => item.loadProfile === loadProfile).map((item) => item.action), WORKSPACE_PANEL_V2_ACTIONS);
  }
  assert.ok(group.cases.every((item) => item.workload === "workspace-panel-interaction"));
  assert.ok(group.cases.every((item) => !item.action.includes("toggle")));
});

test("panel-open session switching uses distinct real V3 latency-pool destinations", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-workspace-panel-v1");
  const groups = buildPanelSwitchGroups(scenario, "smoke", "panel-seed");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].cases.length, 12);
  assert.equal(new Set(groups[0].cases.map((item) => item.destinationSessionId)).size, 12);
  assert.ok(groups[0].cases.every((item) => item.destinationSessionId === `latency-${item.workspaceRelation}-${item.sessionState}-${item.sample}-${item.transcriptBytes}`));
  assert.deepEqual(new Set(groups[0].cases.map((item) => item.panelProfile)), new Set(["closed", "files", "diff"]));
});

test("panel profiles stay adjacent and rotate through every within-lane schedule position", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-workspace-panel-v1");
  const groups = buildPanelSwitchGroups(scenario, "smoke", "panel-seed", 3);
  for (const group of groups) {
    for (let offset = 0; offset < group.cases.length; offset += 3) {
      const block = group.cases.slice(offset, offset + 3);
      assert.equal(new Set(block.map((item) => `${item.workspaceRelation}:${item.sessionState}`)).size, 1);
      assert.deepEqual(new Set(block.map((item) => item.panelProfile)), new Set(["closed", "files", "diff"]));
    }
  }
  for (const lane of SESSION_LANES) {
    const positions = groups.map((group) => {
      const block = group.cases.filter((item) => item.workspaceRelation === lane.workspaceRelation && item.sessionState === lane.sessionState);
      return Object.fromEntries(block.map((item, index) => [item.panelProfile, index]));
    });
    for (const profile of ["closed", "files", "diff"]) assert.deepEqual(new Set(positions.map((item) => item[profile])), new Set([0, 1, 2]));
  }
});
