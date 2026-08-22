import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digest, digestBytes } from "../src/canonical-json.mjs";
import { OPENCODE_EVENT_SCHEMA_DIGEST } from "../src/corpus.mjs";
import { readRegistered } from "../src/registry.mjs";
import { buildSite } from "../src/report/site.mjs";
import { summarizeObservations } from "../src/summarize.mjs";

test("static site builds comparison and stable individual app pages from raw results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const output = path.join(root, "site");
    const built = await buildSite(comparisonFile, output);
    assert.deepEqual(built.model.apps.map((app) => app.id), ["claxedo", "t3"]);
    for (const file of ["index.html", "assets/site.css", "apps/t3/index.html", "apps/claxedo/index.html"]) await stat(path.join(output, file));
    const index = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(index, /Warm session switch — within the same workspace/);
    assert.match(index, /CPU growth with session switching/);
    assert.match(index, /No Web Vitals/);
    assert.doesNotMatch(index, /<script/i);
    assert.doesNotMatch(index, /cdn|fonts\.google|runtime fetch/i);
    assert.match(index, /&lt;unsafe-app&gt;/);
    await writeFile(path.join(output, "stale.html"), "stale");
    await buildSite(comparisonFile, output);
    await assert.rejects(stat(path.join(output, "stale.html")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("site refuses to replace a directory it did not generate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-safe-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const output = path.join(root, "user-directory");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(output));
    await writeFile(path.join(output, "important.txt"), "keep");
    await assert.rejects(buildSite(comparisonFile, output), /not generated/);
    assert.equal(await readFile(path.join(output, "important.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeComparisonFixture(root) {
  const entries = [];
  for (const app of [{ id: "t3", name: "<unsafe-app>" }, { id: "claxedo", name: "Claxedo" }]) {
    for (const scenarioId of ["app-start-v1", "session-switch-v1"]) {
      const result = await resultFixture(app, scenarioId);
      const file = `${app.id}-${scenarioId}.json`;
      const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
      await writeFile(path.join(root, file), bytes);
      entries.push({ appId: app.id, scenarioId, path: file, digestSha256: digestBytes(bytes) });
    }
  }
  const manifest = { schemaVersion: 1, id: "fixture-comparison", title: "Fixture comparison", description: "Deterministic test comparison.", provenance: "maintainer-observed", results: entries };
  const file = path.join(root, "comparison.json");
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

async function resultFixture(app, scenarioId) {
  const scenario = await readRegistered("scenario", scenarioId);
  const corpus = await readRegistered("corpus", "opencode-completed-transcripts-v1");
  const observations = scenario.value.kind === "app-start" ? startObservations() : switchObservations(scenario.value);
  const summary = summarizeObservations(scenario.value, observations);
  return {
    schemaVersion: 1,
    runId: `${app.id}-${scenarioId}`,
    createdAt: "2026-08-23T00:00:00.000Z",
    provenance: { kind: "maintainer-observed", comparisonRunId: "fixture-run", frameworkRevision: "fixture-framework" },
    environment: { platform: "darwin", architecture: "arm64", osRelease: "fixture", logicalCpuCount: 10, cpuModel: "fixture", totalMemoryBytes: 1, nodeVersion: "fixture", guiFramework: "electron" },
    app: { id: app.id, name: app.name, version: "1.0.0", buildDigestSha256: "a".repeat(64) },
    driver: { name: `${app.id}-driver`, version: "1.0.0", sourceCommit: "b".repeat(40), digestSha256: "c".repeat(64) },
    sourceEventFormat: { id: "opencode-event-v1", sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a", schemaDigestSha256: OPENCODE_EVENT_SCHEMA_DIGEST },
    materialization: { mode: app.id === "claxedo" ? "native-opencode" : "translated", corpusDigestSha256: "d".repeat(64), mappingDigestSha256: "e".repeat(64) },
    scenario: { id: scenarioId, kind: scenario.value.kind, digestSha256: scenario.digest, status: "public-comparable" },
    corpus: { id: corpus.value.id, definitionDigestSha256: corpus.digest, digestSha256: "d".repeat(64), status: "public-comparable" },
    runProfile: "smoke",
    observations,
    resources: scenario.value.kind === "session-switch" ? resourceFixture() : null,
    derivation: { version: 1, summaryDigestSha256: digest(summary), summary },
  };
}

function startObservations() {
  return ["new-application-state", "initialized-application-state"].flatMap((startMode, modeIndex) => Array.from({ length: 3 }, (_, repetition) => ({
    case: { caseId: `${startMode}-${repetition}`, repetition, startMode },
    status: "valid",
    durationMs: 20 + modeIndex * 5 + repetition,
    receivedAt: "2026-08-23T00:00:00.000Z",
  })));
}

function switchObservations(scenario) {
  const output = [];
  for (const workspaceRelation of scenario.cases.workspaceRelations) {
    for (const sessionState of scenario.cases.sessionStates) {
      for (const transcriptBytes of scenario.cases.transcriptBytes) {
        for (let repetition = 0; repetition < 3; repetition += 1) output.push({
          case: { caseId: `${workspaceRelation}-${sessionState}-${transcriptBytes}-${repetition}`, workload: "isolated-latency", workspaceRelation, sessionState, transcriptBytes, repetition },
          status: "valid",
          durationMs: transcriptBytes / 1048576 + repetition,
          receivedAt: "2026-08-23T00:00:00.000Z",
        });
      }
    }
  }
  return output;
}

function resourceFixture() {
  return {
    status: "valid",
    scope: "summed application process-family RSS",
    cpuDefinition: "fixture",
    baselineIdleAverageRssMiB: 100,
    activeAverageRssMiB: 120,
    activeMaximumRssMiB: 150,
    activeP95RssMiB: 145,
    endingIdleAverageRssMiB: 110,
    retainedRssGrowthMiB: 10,
    rawSampleCount: 100,
    trend: Array.from({ length: 24 }, (_, index) => ({ switchSequence: index + 1, transcriptBytes: 1048576 * (1 << Math.floor(index / 4)), rssMiB: 100 + index, cpuPercent: 10 + index })),
  };
}
