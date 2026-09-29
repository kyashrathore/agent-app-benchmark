import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digest } from "../src/canonical-json.mjs";
import { buildResourceSequence, expandCases } from "../src/cases.mjs";
import { eventSchemaDigest } from "../src/corpus.mjs";
import { readRegistered } from "../src/registry.mjs";
import { deriveResourcesFromTrace } from "../src/runner.mjs";
import { buildSite } from "../src/site.mjs";
import { summarizeObservations } from "../src/summarize.mjs";

test("the site lists every run and renders one verdict per app against the first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-"));
  try {
    const t3 = await writeRun(root, { id: "t3", name: "<T3>" }, 100);
    const opencode = await writeRun(root, { id: "opencode", name: "OpenCode" }, 50);
    const output = path.join(root, "site");
    const built = await buildSite([t3, opencode], output);
    assert.deepEqual(built.tables.map((table) => table.title), ["<T3> vs OpenCode"]);
    for (const file of ["index.html", "methodology.html", "assets/site.css", "apps/t3/index.html", "apps/opencode/index.html"]) await stat(path.join(output, file));
    const index = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(index, /&lt;T3&gt; vs OpenCode/u);
    assert.doesNotMatch(index, /<T3>/u);
    assert.match(index, /<th scope="row">App start, fresh profile<\/th>/u);
    assert.match(index, /<th scope="row">Next session down the list, return: 8 MiB session<\/th>/u);
    assert.match(index, /<td>0\.\d\d× \(OpenCode [12]\.\d\d× faster\)<\/td>/u);
    assert.match(index, /settle-31-frames/u);
    assert.doesNotMatch(index, /<script/iu);
    const app = await readFile(path.join(output, "apps", "opencode", "index.html"), "utf8");
    assert.match(app, /<dt>Materialization<\/dt><dd>native-opencode<\/dd>/u);
    await writeFile(path.join(output, "stale.html"), "stale");
    await buildSite([t3, opencode], output);
    await assert.rejects(stat(path.join(output, "stale.html")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the site refuses runs the verdict would refuse, and a directory it did not generate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-refuse-"));
  try {
    const t3 = await writeRun(root, { id: "t3", name: "T3" }, 100);
    const opencode = await writeRun(root, { id: "opencode", name: "OpenCode" }, 50, { frameworkRevision: "1".repeat(40) });
    await assert.rejects(buildSite([t3, opencode], path.join(root, "site")), /runs differ in framework revision/u);
    const same = await writeRun(root, { id: "opencode", name: "OpenCode" }, 50, { directory: "opencode-same" });
    const output = path.join(root, "user-directory");
    await mkdir(output);
    await writeFile(path.join(output, "important.txt"), "keep");
    await assert.rejects(buildSite([t3, same], output), /not generated/u);
    assert.equal(await readFile(path.join(output, "important.txt"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A sealed run directory of one app: both benchmark scenarios, every observation `baseMs` plus its index. */
async function writeRun(root, app, baseMs, { frameworkRevision = "f".repeat(40), directory = app.id } = {}) {
  const runDirectory = path.join(root, "runs", directory);
  for (const scenarioId of ["app-start", "session-switch-walk"]) {
    const result = await resultFixture(app, scenarioId, baseMs, frameworkRevision);
    await mkdir(path.join(runDirectory, scenarioId), { recursive: true });
    await writeFile(path.join(runDirectory, scenarioId, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return runDirectory;
}

async function resultFixture(app, scenarioId, baseMs, frameworkRevision) {
  const scenario = await readRegistered("scenario", scenarioId);
  const corpus = await readRegistered("corpus", scenario.value.corpusId);
  const artifact = (await readRegistered("corpusArtifact", corpus.value.id)).value;
  const registered = (await readRegistered("app", app.id)).value;
  const walk = scenario.value.kind === "session-switch";
  const cases = walk
    ? [...expandCases(scenario.value, "publication"), ...buildResourceSequence(scenario.value), { caseId: "progressive-resource-return-control", repetition: 0, workload: "resource-control", destinationSessionId: "control" }]
    : expandCases(scenario.value, "publication");
  const observations = cases.map((benchmarkCase, index) => {
    const durationMs = baseMs + (index % 7);
    return {
      case: benchmarkCase,
      receivedAt: "2026-09-28T00:00:00.000Z",
      status: "valid",
      durationMs,
      readiness: { endpoint: "correct-content-painted-and-input-ready", checks: ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"].map((id) => ({ id, passed: true })) },
      clock: { kind: "single-monotonic-clock", clock: "fixture", start: 1000, end: 1000 + durationMs },
    };
  });
  const resourceTrace = walk ? resourceTraceFixture(scenario.value) : null;
  const summary = summarizeObservations(scenario.value, observations);
  return {
    schemaVersion: 1,
    runId: `${app.id}-${scenarioId}`,
    createdAt: "2026-09-28T00:00:00.000Z",
    provenance: { kind: "maintainer-observed", frameworkRevision },
    environment: { platform: "darwin", architecture: "arm64", osRelease: "25.6.0", logicalCpuCount: 12, cpuModel: "Apple M4 Pro", totalMemoryBytes: 24 * 2 ** 30, loadAverage1mPerCpu: 1.2, nodeVersion: "fixture" },
    app: { id: app.id, name: app.name, version: "1.0.0", buildDigestSha256: "a".repeat(64) },
    driver: { name: `${app.id}-driver`, version: "1", sourceCommit: "b".repeat(40), digestSha256: "c".repeat(64) },
    clockRule: { id: "settle-31-frames", declared: "settle-31-frames", frameLogs: { checked: observations.length, failed: 0, missing: 0 } },
    sourceEventFormat: { id: corpus.value.sourceEventFormat.id, sourceRevision: corpus.value.sourceEventFormat.sourceRevision, schemaDigestSha256: eventSchemaDigest(corpus.value.sourceEventFormat.id) },
    materialization: { mode: registered.materializationModes[0], corpusDigestSha256: artifact.corpusDigestSha256, mappingDigestSha256: "e".repeat(64) },
    scenario: { id: scenarioId, kind: scenario.value.kind, digestSha256: scenario.digest, status: "public-comparable" },
    corpus: { id: corpus.value.id, definitionDigestSha256: corpus.digest, digestSha256: artifact.corpusDigestSha256, status: "public-comparable" },
    runProfile: "publication",
    repetitions: scenario.value.runProfiles.publication,
    observations,
    resources: resourceTrace ? deriveResourcesFromTrace(resourceTrace, scenario.value, observations) : null,
    resourceTrace,
    derivation: { version: 1, summaryDigestSha256: digest(summary), summary },
  };
}

/** Idle, active and idle windows sampled every 250 ms, one boundary per memory-run step. */
function resourceTraceFixture(scenario) {
  const samples = Array.from({ length: 21 }, (_, index) => sample(index * 250, 700 + index, index * 3));
  const window = (first, last) => ({ startMs: samples[first].atMs, endMs: samples[last].atMs });
  return {
    version: 1,
    samples,
    windows: { baseline: window(0, 6), active: window(7, 13), ending: window(14, 20) },
    boundaries: buildResourceSequence(scenario).map((benchmarkCase, index) => ({ case: benchmarkCase, switchSequence: index + 1, beforeSampleIndex: 7 + index * 2, afterSampleIndex: 8 + index * 2 })),
    monitorErrors: [],
    failure: null,
  };
}

function sample(atMs, rssMiB, cpuTimeMs) {
  const rssBytes = rssMiB * 1024 * 1024;
  return { atMs, collectionDurationMicros: 100, rssBytes, cumulativeCpuTimeMs: cpuTimeMs, inaccessibleProcessCount: 0, rootProcessFound: true, missingExternalProcessCount: 0, processes: [{ pid: 10, startTimeMs: 0, cpuTimeMs, rssBytes, name: "fixture" }] };
}
