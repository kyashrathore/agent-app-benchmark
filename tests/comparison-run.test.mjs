import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../src/canonical-json.mjs";
import { validatePairedSchedule } from "../src/comparison.mjs";
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

test("new user-flow scenarios enforce the generic mirrored schedule", () => {
  const schedule = buildComparisonSchedule(["claxedo", "t3"], ["session-navigation-v1", "workspace-panel-v2"]);
  const scheduleDigest = digest(schedule);
  const results = schedule.steps.map((step) => ({
    result: {
      repetitions: 20,
      app: { id: step.appId },
      scenario: {
        id: step.scenarioId,
        kind: step.scenarioId === "session-navigation-v1" ? "session-navigation" : "workspace-panel",
      },
      provenance: { scheduleOrdinal: step.ordinal, comparisonScheduleDigestSha256: scheduleDigest },
    },
  }));
  assert.doesNotThrow(() => validatePairedSchedule(results));

  const noncontiguous = structuredClone(results);
  noncontiguous.at(-1).result.provenance.scheduleOrdinal += 1;
  assert.throws(() => validatePairedSchedule(noncontiguous), /unique and contiguous/u);

  const nonmirrored = structuredClone(results);
  [nonmirrored[2].result.app.id, nonmirrored[3].result.app.id] = [nonmirrored[3].result.app.id, nonmirrored[2].result.app.id];
  assert.throws(() => validatePairedSchedule(nonmirrored), /balanced mirrored/u);

  const wrongDigest = structuredClone(results);
  wrongDigest[0].result.provenance.comparisonScheduleDigestSha256 = "0".repeat(64);
  assert.throws(() => validatePairedSchedule(wrongDigest), /schedule digest/u);
});
