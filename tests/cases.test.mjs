import assert from "node:assert/strict";
import test from "node:test";
import { buildResourceSequence, buildWalkGroups, expandCases, repetitionsFor } from "../src/cases.mjs";
import { readRegistered } from "../src/registry.mjs";

test("the memory run progresses through every declared size in one fixed lane", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-walk");
  const cases = buildResourceSequence(scenario);
  assert.deepEqual(cases.map((item) => item.transcriptBytes), scenario.cases.transcriptBytes);
  assert.deepEqual(cases.map((item) => item.caseId), ["progressive-resource-0-within-workspace-cold-1048576", "progressive-resource-0-within-workspace-cold-8388608"]);
  assert.ok(cases.every((item) => item.workload === "progressive-resource" && item.sourceSessionId === "control"));
});

test("app start alternates both launch states in every repetition", async () => {
  const { value: scenario } = await readRegistered("scenario", "app-start");
  const cases = expandCases(scenario, "publication");
  assert.equal(cases.length, 8);
  assert.deepEqual(cases.slice(0, 4).map((item) => item.stateHandle), ["P0", "P1", "P1", "P0"]);
});

test("the list walk steps to the next row down, first opening every session and then returning in the same order", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-walk");
  const list = scenario.cases.walk.sessions.map((session) => session.sessionId);
  const groups = buildWalkGroups(scenario, "publication");
  assert.equal(groups.length, 2);
  const [group] = groups;
  assert.equal(group.cases.length, list.length * 2);
  assert.deepEqual(group.cases.map((item) => item.destinationSessionId), [...list, ...list]);
  assert.deepEqual(group.cases.map((item) => item.sourceSessionId), ["control", ...list, ...list.slice(0, -1)]);
  assert.deepEqual([...new Set(group.cases.slice(0, list.length).map((item) => item.sessionState))], ["cold"]);
  assert.deepEqual([...new Set(group.cases.slice(list.length).map((item) => item.sessionState))], ["warm"]);
  assert.equal(group.cases.filter((item) => item.workspaceRelation === "across-workspaces").length, 4);
});

test("a repetition override replaces the profile's count within bounds", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-walk");
  assert.equal(repetitionsFor(scenario, "publication"), 2);
  assert.equal(repetitionsFor(scenario, "publication", 1), 1);
  assert.throws(() => repetitionsFor(scenario, "publication", 101), /from 1 through 100/u);
  assert.throws(() => repetitionsFor(scenario, "turbo"), /Unknown run profile/u);
});
