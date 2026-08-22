import assert from "node:assert/strict";
import test from "node:test";
import { buildLatencyGroups, buildResourceSequence, expandCases, SESSION_LANES } from "../src/cases.mjs";
import { readRegistered } from "../src/registry.mjs";

test("publication schedule emits 20 observations per lane and transcript size", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = expandCases(scenario, "publication");
  assert.equal(cases.length, 4 * 6 * 20);
  for (const lane of SESSION_LANES) {
    for (const transcriptBytes of scenario.cases.transcriptBytes) {
      assert.equal(cases.filter((item) => item.workspaceRelation === lane.workspaceRelation && item.sessionState === lane.sessionState && item.transcriptBytes === transcriptBytes).length, 20);
    }
  }
});

test("isolated groups use one lane per fresh process and counterbalanced sizes", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const groups = buildLatencyGroups(scenario, "smoke", "fixed-seed");
  assert.equal(groups.length, 12);
  assert.ok(groups.every((group) => group.cases.length === 6));
  assert.ok(groups.every((group) => new Set(group.cases.map((item) => `${item.workspaceRelation}:${item.sessionState}`)).size === 1));
  assert.notDeepEqual(groups[0].cases.map((item) => item.transcriptBytes), scenario.cases.transcriptBytes);
});

test("resource sequence is size-ascending with all four lanes at each size", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = buildResourceSequence(scenario, "fixed-seed");
  assert.equal(cases.length, 24);
  for (let index = 0; index < scenario.cases.transcriptBytes.length; index += 1) {
    const slice = cases.slice(index * 4, index * 4 + 4);
    assert.ok(slice.every((item) => item.transcriptBytes === scenario.cases.transcriptBytes[index]));
    assert.equal(new Set(slice.map((item) => `${item.workspaceRelation}:${item.sessionState}`)).size, 4);
  }
});

test("app start schedules both exact process-launch states", async () => {
  const { value: scenario } = await readRegistered("scenario", "app-start-v1");
  const cases = expandCases(scenario, "smoke");
  assert.equal(cases.length, 6);
  assert.equal(cases.filter((item) => item.stateHandle === "P0").length, 3);
  assert.equal(cases.filter((item) => item.stateHandle === "P1").length, 3);
});
