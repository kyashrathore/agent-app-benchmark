import assert from "node:assert/strict";
import test from "node:test";
import { buildComparisonSchedule } from "../src/comparison-run.mjs";

test("comparison schedule mirrors app order across the two V1 scenarios", () => {
  assert.deepEqual(buildComparisonSchedule(["t3", "claxedo"]).steps, [
    { ordinal: 1, appId: "t3", scenarioId: "app-start-v1" },
    { ordinal: 2, appId: "claxedo", scenarioId: "app-start-v1" },
    { ordinal: 3, appId: "claxedo", scenarioId: "session-switch-v1" },
    { ordinal: 4, appId: "t3", scenarioId: "session-switch-v1" },
  ]);
});
