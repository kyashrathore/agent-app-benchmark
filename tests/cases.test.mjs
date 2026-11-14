import assert from "node:assert/strict";
import test from "node:test";
import { buildGroups, buildResourceSequence, expandCases, keySchedule, repetitionsFor } from "../src/cases.mjs";
import { readRegistered } from "../src/registry.mjs";

test("the memory run progresses through every declared size in one fixed lane", async () => {
  const { value: scenario } = await readRegistered("scenario", "session-switch-walk");
  const cases = buildResourceSequence(scenario);
  assert.deepEqual(cases.map((item) => item.nominalBytes), scenario.cases.nominalBytes);
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
  const groups = buildGroups(scenario, "publication");
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

test("new thread takes its samples per process from the run profile", async () => {
  const { value: scenario } = await readRegistered("scenario", "new-thread");
  assert.equal(expandCases(scenario, "publication").length, 20);
  assert.equal(expandCases(scenario, "smoke").length, 4);
  assert.ok(expandCases(scenario, "publication").every((item) => item.workload === "new-thread" && item.sourceSessionId === "control"));
});

test("long thread visits the long thread twice per process, scrolling after each open", async () => {
  const { value: scenario } = await readRegistered("scenario", "long-thread");
  const [group] = buildGroups(scenario, "publication");
  assert.deepEqual(group.cases.map((item) => item.workload), ["long-thread-open", "long-thread-scroll", "long-thread-open", "long-thread-scroll"]);
  assert.deepEqual(group.cases[1].scroll, { wheelCount: 20, deltaY: -480, intervalMs: 50, tailMs: 500 });
  assert.equal(expandCases(scenario, "publication").length, 8);
});

test("typing while streaming sends five streams, then types sixty keys in one request that yields one observation per key", async () => {
  const { value: scenario } = await readRegistered("scenario", "typing-while-streaming");
  const [group] = buildGroups(scenario, "publication");
  assert.equal(group.cases.length, 65);
  assert.equal(group.actions.length, 6);
  const typing = group.actions.at(-1);
  assert.equal(typing.request.workload, "typing");
  assert.equal(typing.request.keys.length, 60);
  assert.equal(typing.cases.length, 60);
  assert.equal(typing.request.keys.map((item) => item.key).join(""), scenario.cases.keys.sequence.slice(0, 60));
  assert.deepEqual(keySchedule(scenario.cases.keys, 60), typing.request.keys, "the schedule is fixed by its seed");
  assert.ok(typing.request.keys.slice(1).every((item) => item.delayMs >= 200 && item.delayMs <= 300));
  assert.equal(buildGroups(scenario, "smoke")[0].cases.length, 22);
});
