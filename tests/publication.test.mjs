import assert from "node:assert/strict";
import test from "node:test";
import { validateAppendOnlyEntries } from "../src/publication.mjs";

test("public registry, schema, and result paths are append-only", () => {
  assert.equal(validateAppendOnlyEntries([{ status: "A", paths: ["results/runs/new/result.json"] }]), true);
  assert.throws(() => validateAppendOnlyEntries([{ status: "M", paths: ["registry/scenarios/test-session-switch.json"] }]), /append-only/);
  assert.throws(() => validateAppendOnlyEntries([{ status: "R100", paths: ["schemas/result.schema.json", "schemas/result-renamed.schema.json"] }]), /append-only/);
  assert.equal(validateAppendOnlyEntries([{ status: "M", paths: ["src/runner.mjs"] }]), true);
});
