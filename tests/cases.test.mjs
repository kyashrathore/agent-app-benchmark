import assert from "node:assert/strict";
import test from "node:test";
import { buildLatencyGroups, buildResourceSequence, expandCases, repetitionsFor, SESSION_LANES } from "../src/cases.mjs";
import { readRegistered } from "../src/registry.mjs";

test("publication schedule emits 2 observations per lane and transcript size", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = expandCases(scenario, "publication");
  assert.equal(cases.length, 4 * 6 * 2);
  for (const lane of SESSION_LANES) {
    for (const transcriptBytes of scenario.cases.transcriptBytes) {
      assert.equal(cases.filter((item) => item.workspaceRelation === lane.workspaceRelation && item.sessionState === lane.sessionState && item.transcriptBytes === transcriptBytes).length, 2);
    }
  }
});

test("a run can override its profile repetition count", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const cases = expandCases(scenario, "publication", "override-seed", 4);
  assert.equal(cases.length, 4 * 6 * 4);
  assert.equal(repetitionsFor(scenario, "publication", undefined), 2);
  assert.equal(repetitionsFor(scenario, "publication", 4), 4);
  assert.throws(() => repetitionsFor(scenario, "publication", 0), /1 through 100/u);
  assert.throws(() => repetitionsFor(scenario, "publication", 101), /1 through 100/u);
});

test("isolated groups use one lane per fresh process and counterbalanced sizes", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-v1");
  const groups = buildLatencyGroups(scenario, "smoke", "fixed-seed");
  assert.equal(groups.length, 4);
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
  assert.equal(cases.length, 2);
  assert.equal(cases.filter((item) => item.stateHandle === "P0").length, 1);
  assert.equal(cases.filter((item) => item.stateHandle === "P1").length, 1);
});
