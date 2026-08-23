import assert from "node:assert/strict";
import test from "node:test";
import { buildComparisonSchedule, validateComparisonConfig } from "../src/comparison-run.mjs";

test("comparison schedule mirrors app order across the two V1 scenarios", () => {
  assert.deepEqual(buildComparisonSchedule(["t3", "claxedo"]).steps, [
    { ordinal: 1, appId: "t3", scenarioId: "app-start-v1" },
    { ordinal: 2, appId: "claxedo", scenarioId: "app-start-v1" },
    { ordinal: 3, appId: "claxedo", scenarioId: "session-switch-v1" },
    { ordinal: 4, appId: "t3", scenarioId: "session-switch-v1" },
  ]);
});

test("comparison schedule accepts the privacy-derived V2 scenarios", () => {
  const schedule = buildComparisonSchedule(["t3", "claxedo"], ["app-start-v2", "session-switch-v2"]);
  assert.equal(schedule.version, 2);
  assert.equal(schedule.policy, "balanced-mirrored-v2");
  assert.deepEqual(schedule.steps.map((step) => step.scenarioId), ["app-start-v2", "app-start-v2", "session-switch-v2", "session-switch-v2"]);
});

test("comparison config accepts one shared repetition override", () => {
  const config = {
    id: "configurable-repetitions",
    title: "Configurable repetitions",
    description: "test",
    provenance: "community-self-attested",
    frameworkRevision: "a".repeat(40),
    runProfile: "publication",
    repetitions: 7,
    resourceMonitor: "/resource-monitor",
    outputRoot: "/output",
    apps: [
      { id: "t3", driver: "/t3-driver" },
      { id: "claxedo", driver: "/claxedo-driver" },
    ],
  };
  assert.equal(validateComparisonConfig(config), undefined);
  assert.throws(() => validateComparisonConfig({ ...config, repetitions: 0 }), /1 through 100/u);
  assert.throws(() => validateComparisonConfig({ ...config, repetitions: 1.5 }), /1 through 100/u);
});
