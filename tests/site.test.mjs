import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digest, digestBytes } from "../src/canonical-json.mjs";
import { buildResourceSequence, expandCases } from "../src/cases.mjs";
import { assertSharedComparisonRepetitions, loadComparison } from "../src/comparison.mjs";
import { eventSchemaDigest, OPENCODE_EVENT_SCHEMA_DIGEST } from "../src/corpus.mjs";
import { readRegistered } from "../src/registry.mjs";
import { buildSite } from "../src/report/site.mjs";
import { deriveResourcesFromTrace } from "../src/runner.mjs";
import { summarizeObservations } from "../src/summarize.mjs";
import { buildWorkspaceFixtureManifest } from "../src/workspace-fixture.mjs";

test("static site builds comparison and stable individual app pages from raw results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const output = path.join(root, "site");
    const built = await buildSite(comparisonFile, output);
    assert.deepEqual(built.model.apps.map((app) => app.id), ["claxedo", "t3"]);
    assert.equal(built.model.primaryStatistic, "p95");
    assert.equal(built.model.primaryStatisticMethod, "nearest-rank");
    assert.equal(built.model.p95Disclosure.equalsSampledMaximumBelowValidCount, 20);
    assert.equal(built.model.p95Disclosure.repetitions, 1);
    for (const file of ["index.html", "assets/site.css", "apps/t3/index.html", "apps/claxedo/index.html"]) await stat(path.join(output, file));
    const index = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(index, /Application start/);
    assert.match(index, /Cold app start/);
    assert.match(index, /Memory and CPU under historical-session load/);
    assert.match(index, /p95 summed RSS by historical-session size/);
    assert.match(index, /p95 process-family CPU by historical-session size/);
    for (const row of [
      "Memory when idle at the start",
      "Memory while working",
      "Largest single memory sample",
      "Memory when idle again",
      "Memory never released",
      "CPU when idle at the start",
      "CPU while working",
      "CPU when idle again",
    ]) assert.match(index, new RegExp(`<th scope="row">${row}</th>`, "u"));
    assert.match(index, /not an operating-system true peak/u);
    assert.match(index, /Observed sample cadence \(median\)/u);
    assert.match(index, /Missing-process evidence/u);
    assert.match(index, /Host memory pressure/u);
    assert.match(index, /Host power state/u);
    assert.match(index, /p95 summed process-family RSS after each historical-session step/u);
    assert.match(index, /p95 process-family CPU during each historical-session step/u);
    assert.doesNotMatch(index, /No valid chart points/u);
    assert.doesNotMatch(index, /style="--series:/);
    const stylesheet = await readFile(path.join(output, "assets", "site.css"), "utf8");
    assert.match(stylesheet, /\.series-0 polyline,.series-0 circle\{stroke:var\(--acc-0\)\}/);
    assert.match(stylesheet, /\.swatch\.series-1\{background:var\(--acc-1\)/);
    assert.doesNotMatch(index, />Average</);
    assert.doesNotMatch(index, />Maximum</);
    assert.match(index, /P95 · valid \/ attempted/);
    assert.match(index, /No Web Vitals/);
    assert.match(index, /1\.0\.0 · electron · native-opencode/);
    assert.match(index, /1\.0\.0 · electron · translated/);
    assert.doesNotMatch(index, /<script/i);
    assert.doesNotMatch(index, /cdn|fonts\.google|runtime fetch/i);
    assert.match(index, /&lt;unsafe-app&gt;/);
    const t3 = await readFile(path.join(output, "apps", "t3", "index.html"), "utf8");
    assert.match(t3, /<dt>GUI framework<\/dt><dd>electron<\/dd>/);
    await writeFile(path.join(output, "stale.html"), "stale");
    await buildSite(comparisonFile, output);
    await assert.rejects(stat(path.join(output, "stale.html")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison site renders compact navigation and workspace trend matrices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-trends-"));
  try {
    const comparisonFile = await writeTrendComparisonFixture(root);
    const output = path.join(root, "site");
    await buildSite(comparisonFile, output);
    const index = await readFile(path.join(output, "index.html"), "utf8");
    const methodology = await readFile(path.join(output, "methodology.html"), "utf8");
    assert.match(methodology, /Fairness ledger/);
    assert.match(methodology, /Balanced mirrored schedule/);
    assert.match(index, /Session navigation/);
    assert.match(index, /Navigation latency across every session/);
    assert.match(index, /First visit and return by history size — p95/);
    assert.match(index, /Return with workspace panel open/);
    assert.match(index, /All workspace interactions/);
    assert.match(index, /60 Hz budget/);
    assert.equal((index.match(/<caption>Workspace interaction responsiveness across retained load/g) ?? []).length, 1);
    assert.match(index, /same complete 24-file Review model/u);
    assert.match(index, /Setup does not scroll Review/u);
    assert.match(index, /Each load profile owns a distinct canonical target/u);
    assert.match(index, /measured input owns first surface creation and paint/u);
    assert.match(index, /Animation is presentation, not speed/u);
    assert.match(index, /16\.67 ms frame budget/u);
    assert.match(index, /60 Hz/u);
    for (const action of ["Open Panel", "Close Panel", "Files To Review", "Review To Files", "Open File", "Switch File Tab", "Expand All", "Collapse All"]) {
      assert.match(index, new RegExp(action, "u"));
    }
    assert.match(index, /P95 · valid \/ attempted/);
    assert.match(index, /class="series series-0 series-return"/);
    assert.match(index, /class="series series-1 series-return"/);
    assert.doesNotMatch(index, /class="series series-2"/);
    assert.match(index, /Renderer work and frame measurements/);
    assert.doesNotMatch(index, /Cold session|Warm session/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("five-repetition comparison reports nearest-rank p95 and preserves exact unsupported reasons", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-five-"));
  try {
    const reason = "T3 product Review preview limit cannot represent the canonical 24-file workspace fixture.";
    const comparisonFile = await writeTrendComparisonFixture(root, { repetitions: 5, invalidReason: reason });
    const output = path.join(root, "site");
    await buildSite(comparisonFile, output);
    const index = await readFile(path.join(output, "index.html"), "utf8");
    const methodology = await readFile(path.join(output, "methodology.html"), "utf8");
    assert.match(methodology, /<b>5<\/b><span>repetitions per measurement/);
    assert.match(methodology, /<b>P95<\/b><span>primary statistic/);
    assert.match(methodology, /Every measurement below is repeated 5 times/);
    assert.match(index, /its nearest-rank p95 is the sampled maximum of those observations/);
    assert.match(index, /5 \/ 5 · p95 = sampled max/u);
    assert.match(index, /First visit and return by history size — p95/);
    assert.match(index, /Return with workspace panel open/);
    assert.doesNotMatch(index, /No valid chart points/);
    assert.doesNotMatch(index, /withheld until 20 valid observations/u);
    assert.doesNotMatch(index, /<b>p50<\/b> primary/);
    assert.match(index, /Unsupported is not zero/);
    assert.match(index, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.match(index, /Not comparable/);
    assert.doesNotMatch(index, /<script/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison rejects result provenance that disagrees with its manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-provenance-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    await rewriteResult(comparisonFile, (entry) => entry.appId === "t3", (result) => { result.provenance.kind = "community-self-attested"; });
    await assert.rejects(loadComparison(comparisonFile), /provenance does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paired comparison requires one repetition count across scenarios", () => {
  assert.doesNotThrow(() =>
    assertSharedComparisonRepetitions([
      { result: { repetitions: 2 } },
      { result: { repetitions: 2 } },
    ]),
  );
  assert.throws(
    () =>
      assertSharedComparisonRepetitions([
        { result: { repetitions: 2 } },
        { result: { repetitions: 3 } },
      ]),
    /one repetition count/u,
  );
});

test("comparison bounds entry count before loading result files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-count-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const manifest = JSON.parse(await readFile(comparisonFile, "utf8"));
    manifest.results = Array.from({ length: 65 }, (_, index) => ({ appId: `app${index}`, scenarioId: "app-start-v1", path: `missing-${index}.json`, digestSha256: "a".repeat(64) }));
    await writeFile(comparisonFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(loadComparison(comparisonFile), /more than 64 results/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-member scenarios are unpaired and are not rendered side by side", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-unpaired-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const manifest = JSON.parse(await readFile(comparisonFile, "utf8"));
    manifest.results = manifest.results.filter((entry) => entry.scenarioId !== "app-start-v1" || entry.appId === "t3");
    await writeFile(comparisonFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const comparison = await loadComparison(comparisonFile);
    assert.equal(comparison.compatibility["app-start-v1"].status, "unpaired");
    const output = path.join(root, "site");
    await buildSite(comparisonFile, output);
    const index = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(index, /unpaired:/);
    assert.match(index, /At least two results are required/);
    assert.match(index, /Claxedo/);
    assert.match(index, /unsafe-app/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("incompatible scenarios and invalid resource measurements are explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-status-"));
  try {
    const incompatibleFile = await writeComparisonFixture(root);
    await rewriteResult(incompatibleFile, (entry) => entry.appId === "t3" && entry.scenarioId === "app-start-v1", (result) => { result.provenance.frameworkRevision = "1".repeat(40); });
    const incompatibleOutput = path.join(root, "incompatible-site");
    await buildSite(incompatibleFile, incompatibleOutput);
    const incompatible = await readFile(path.join(incompatibleOutput, "index.html"), "utf8");
    assert.match(incompatible, /incompatible:/);
    assert.match(incompatible, /Results do not share/);

    const resourceRoot = path.join(root, "resources");
    const resourceFile = await writeComparisonFixture(resourceRoot);
    await rewriteResult(resourceFile, (entry) => entry.appId === "t3" && entry.scenarioId === "session-switch-v1", (result) => {
      result.resourceTrace.failure = "T3 monitor rejected malformed data.";
      result.resources = { status: "invalid", reason: "T3 monitor rejected malformed data.", rawSampleCount: result.resourceTrace.samples.length, trend: [] };
    });
    const resourceOutput = path.join(root, "resource-site");
    await buildSite(resourceFile, resourceOutput);
    const resourcePage = await readFile(path.join(resourceOutput, "index.html"), "utf8");
    assert.match(resourcePage, /T3 monitor rejected malformed data/);
    assert.match(resourcePage, /Claxedo/);
    assert.match(resourcePage, /Memory and CPU under historical-session load/);
    // Invalid stays Invalid with its reason and keeps its sample counts; it is never scored as zero.
    assert.match(resourcePage, /<strong>Invalid<\/strong><small>241 \/ 241 · T3 monitor rejected malformed data\./u);
    assert.match(resourcePage, /Memory when idle at the start<\/th><td class="context"[^>]*>[^<]*<\/td><td class="metric"[^>]*><strong>122\.8 MiB<\/strong>/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory and CPU rows carry absolute values with the relative difference between applications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-memory-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const scenario = await readRegistered("scenario", "session-switch-v1");
    await rewriteResult(comparisonFile, (entry) => entry.appId === "t3" && entry.scenarioId === "session-switch-v1", (result) => {
      for (const item of result.resourceTrace.samples) {
        item.rssBytes *= 2;
        for (const process of item.processes) process.rssBytes *= 2;
      }
      result.resources = deriveResourcesFromTrace(result.resourceTrace, scenario.value, result.observations);
    });
    const output = path.join(root, "site");
    await buildSite(comparisonFile, output);
    const index = await readFile(path.join(output, "index.html"), "utf8");
    assert.match(index, /<strong>122\.8 MiB<\/strong>/u);
    assert.match(index, /<strong>245\.6 MiB<\/strong>/u);
    assert.match(index, /<strong>Claxedo<\/strong><small>2× lower · 50\.0% lower<\/small>/u);
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

test("comparison paths may reach sibling runs but cannot escape the results root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-app-site-paths-"));
  try {
    const comparisonFile = await writeComparisonFixture(root);
    const manifest = JSON.parse(await readFile(comparisonFile, "utf8"));
    const source = path.join(root, "results", "runs", "t3-app-start-v1.json");
    const outside = path.join(root, "outside.json");
    await writeFile(outside, await readFile(source));
    manifest.results[0].path = "../../../outside.json";
    await writeFile(comparisonFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(loadComparison(comparisonFile), /escapes its allowed root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeComparisonFixture(root) {
  const resultDirectory = path.join(root, "results", "runs");
  const comparisonDirectory = path.join(root, "results", "comparisons", "fixture-comparison");
  await mkdir(resultDirectory, { recursive: true });
  await mkdir(comparisonDirectory, { recursive: true });
  const entries = [];
  const steps = [
    { app: { id: "t3", name: "<unsafe-app>" }, scenarioId: "app-start-v1" },
    { app: { id: "claxedo", name: "Claxedo" }, scenarioId: "app-start-v1" },
    { app: { id: "claxedo", name: "Claxedo" }, scenarioId: "session-switch-v1" },
    { app: { id: "t3", name: "<unsafe-app>" }, scenarioId: "session-switch-v1" },
  ];
  const schedule = { version: 1, policy: "balanced-mirrored-v1", steps: steps.map((step, index) => ({ ordinal: index + 1, appId: step.app.id, scenarioId: step.scenarioId })) };
  const scheduleDigest = digest(schedule);
  for (let index = 0; index < steps.length; index += 1) {
      const { app, scenarioId } = steps[index];
      const result = await resultFixture(app, scenarioId, index + 1, scheduleDigest);
      const file = `${app.id}-${scenarioId}.json`;
      const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
      await writeFile(path.join(resultDirectory, file), bytes);
      entries.push({ appId: app.id, scenarioId, path: `../../runs/${file}`, digestSha256: digestBytes(bytes) });
  }
  const manifest = { schemaVersion: 1, id: "fixture-comparison", title: "Fixture comparison", description: "Deterministic test comparison.", provenance: "maintainer-observed", results: entries };
  const file = path.join(comparisonDirectory, "comparison.json");
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

async function writeTrendComparisonFixture(root, options = {}) {
  const resultDirectory = path.join(root, "results", "runs");
  const comparisonDirectory = path.join(root, "results", "comparisons", "fixture-trends");
  await mkdir(resultDirectory, { recursive: true });
  await mkdir(comparisonDirectory, { recursive: true });
  const steps = [
    { app: { id: "claxedo", name: "Claxedo" }, scenarioId: "session-navigation-v1" },
    { app: { id: "t3", name: "T3" }, scenarioId: "session-navigation-v1" },
    { app: { id: "t3", name: "T3" }, scenarioId: "workspace-panel-v2" },
    { app: { id: "claxedo", name: "Claxedo" }, scenarioId: "workspace-panel-v2" },
  ];
  const schedule = { version: 1, policy: "balanced-mirrored-v1", steps: steps.map((step, index) => ({ ordinal: index + 1, appId: step.app.id, scenarioId: step.scenarioId })) };
  const scheduleDigest = digest(schedule);
  const entries = [];
  for (let index = 0; index < steps.length; index += 1) {
    const { app, scenarioId } = steps[index];
    const result = await trendResultFixture(app, scenarioId, index + 1, scheduleDigest, options);
    const name = `${app.id}-${scenarioId}.json`;
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    await writeFile(path.join(resultDirectory, name), bytes);
    entries.push({ appId: app.id, scenarioId, path: `../../runs/${name}`, digestSha256: digestBytes(bytes) });
  }
  const file = path.join(comparisonDirectory, "comparison.json");
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, id: "fixture-trends", title: "Trend comparison", description: "User-facing trend fixture.", provenance: "maintainer-observed", results: entries }, null, 2)}\n`);
  return file;
}

async function trendResultFixture(app, scenarioId, scheduleOrdinal, scheduleDigest, options = {}) {
  const scenario = await readRegistered("scenario", scenarioId);
  const corpus = await readRegistered("corpus", scenario.value.corpusId);
  const artifact = await readRegistered("corpusArtifact", corpus.value.id);
  const repetitions = options.repetitions ?? scenario.value.runProfiles.publication;
  const cases = expandCases(scenario.value, "publication", corpus.value.seed, repetitions);
  const observations = trendObservations(cases, app.id === "t3" && scenarioId === "workspace-panel-v2" ? options.invalidReason : undefined);
  const summary = summarizeObservations(scenario.value, observations);
  const fixture = buildWorkspaceFixtureManifest(scenario.value.cases.workspaceLoad, corpus.value.seed);
  return {
    schemaVersion: 1,
    runId: `${app.id}-${scenarioId}`,
    createdAt: "2026-08-23T00:00:00.000Z",
    provenance: { kind: "maintainer-observed", comparisonRunId: "fixture-trends", frameworkRevision: "f".repeat(40), comparisonScheduleDigestSha256: scheduleDigest, scheduleOrdinal },
    environment: { platform: "darwin", architecture: "arm64", osRelease: "fixture", logicalCpuCount: 10, cpuModel: "fixture", totalMemoryBytes: 1, nodeVersion: "fixture", guiFramework: "electron" },
    app: { id: app.id, name: app.name, version: "1.0.0", buildDigestSha256: "a".repeat(64) },
    driver: { name: `${app.id}-driver`, version: "1.0.0", sourceCommit: "b".repeat(40), digestSha256: "c".repeat(64) },
    sourceEventFormat: { id: corpus.value.sourceEventFormat.id, sourceRevision: corpus.value.sourceEventFormat.sourceRevision, schemaDigestSha256: eventSchemaDigest(corpus.value.sourceEventFormat.id) },
    materialization: { mode: app.id === "claxedo" ? "native-opencode" : "translated", corpusDigestSha256: artifact.value.corpusDigestSha256, mappingDigestSha256: "e".repeat(64), workspaceFixtureDigestSha256: fixture.manifestDigestSha256 },
    scenario: { id: scenarioId, kind: scenario.value.kind, digestSha256: scenario.digest, status: "public-comparable" },
    corpus: { id: corpus.value.id, definitionDigestSha256: corpus.digest, digestSha256: artifact.value.corpusDigestSha256, status: "public-comparable" },
    runProfile: "publication",
    repetitions,
    observations,
    resources: null,
    resourceTrace: null,
    derivation: { version: 1, summaryDigestSha256: digest(summary), summary },
  };
}

function trendObservations(cases, invalidReason) {
  return cases.map((benchmarkCase, index) => {
    if (invalidReason && benchmarkCase.loadProfile === "heavy" && benchmarkCase.action === "open-file") {
      return {
        case: benchmarkCase,
        status: "invalid",
        reason: invalidReason,
        receivedAt: "2026-08-23T00:00:00.000Z",
      };
    }
    const start = 1000 + index * 100;
    const durationMs = 20 + (index % 11);
    const end = start + durationMs;
    const rendererTrace = benchmarkCase.workload === "workspace-panel-interaction"
      || benchmarkCase.navigationType === "return-visited-panel-open"
      ? trendRendererTrace(benchmarkCase, start, end)
      : undefined;
    return {
      case: benchmarkCase,
      status: "valid",
      durationMs,
      readiness: {
        endpoint: "correct-content-painted-and-input-ready",
        checks: ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"].map((id) => ({ id, passed: true, observedAt: end })),
      },
      clock: { kind: "single-monotonic-clock", clock: "trend-fixture", start, end },
      timingEvidence: { trustedInputAt: start, trustedInputEvent: "pointerdown" },
      ...(rendererTrace ? { rendererTrace } : {}),
      receivedAt: "2026-08-23T00:00:00.000Z",
    };
  });
}

function trendRendererTrace(benchmarkCase, start, end) {
  const span = end - start;
  const at = (fraction) => start + span * fraction;
  let milestones;
  let transitionMode = "none";
  if (benchmarkCase.action === "open-panel") {
    transitionMode = "animated";
    milestones = [
      { id: "trusted-input", at: start },
      { id: "shell-visible", at: at(0.1) },
      { id: "data-ready", at: at(0.3) },
      { id: "above-fold-painted", at: at(0.6) },
      { id: "animation-settled", at: at(0.8) },
      { id: "interactive", at: end },
    ];
  } else if (benchmarkCase.navigationType === "return-visited-panel-open") {
    milestones = [
      { id: "trusted-input", at: start },
      { id: "content-identity", at: at(0.2) },
      { id: "session-ready", at: at(0.5) },
      { id: "panel-ready", at: at(0.7) },
      { id: "above-fold-painted", at: at(0.8) },
      { id: "interactive", at: end },
    ];
  } else {
    milestones = [{ id: "trusted-input", at: start }, { id: "action-painted", at: at(0.8) }, { id: "interactive", at: end }];
  }
  return {
    clock: "trend-fixture",
    transitionMode,
    milestones,
    frameTimestampsMs: [start, end],
    longAnimationFrames: [],
    counterInterval: { start, end },
    counters: { scriptDurationMs: 4, styleRecalcDurationMs: 2, layoutDurationMs: 1, taskDurationMs: 8 },
  };
}

async function rewriteResult(comparisonFile, matches, mutate) {
  const manifest = JSON.parse(await readFile(comparisonFile, "utf8"));
  const root = path.dirname(comparisonFile);
  for (const entry of manifest.results.filter(matches)) {
    const file = path.resolve(root, entry.path);
    const result = JSON.parse(await readFile(file, "utf8"));
    mutate(result);
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
    await writeFile(file, bytes);
    entry.digestSha256 = digestBytes(bytes);
  }
  await writeFile(comparisonFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function resultFixture(app, scenarioId, scheduleOrdinal, scheduleDigest) {
  const scenario = await readRegistered("scenario", scenarioId);
  const corpus = await readRegistered("corpus", "opencode-completed-transcripts-v1");
  const observations = scenario.value.kind === "app-start" ? observationsFor(expandCases(scenario.value, "smoke")) : switchObservations(scenario.value);
  const summary = summarizeObservations(scenario.value, observations);
  const resourceTrace = scenario.value.kind === "session-switch" ? resourceTraceFixture(scenario.value) : null;
  const resources = resourceTrace ? deriveResourcesFromTrace(resourceTrace, scenario.value, observations) : null;
  return {
    schemaVersion: 1,
    runId: `${app.id}-${scenarioId}`,
    createdAt: "2026-08-23T00:00:00.000Z",
    provenance: { kind: "maintainer-observed", comparisonRunId: "fixture-comparison", frameworkRevision: "f".repeat(40), comparisonScheduleDigestSha256: scheduleDigest, scheduleOrdinal },
    environment: { platform: "darwin", architecture: "arm64", osRelease: "fixture", logicalCpuCount: 10, cpuModel: "fixture", totalMemoryBytes: 1, nodeVersion: "fixture", guiFramework: "electron" },
    app: { id: app.id, name: app.name, version: "1.0.0", buildDigestSha256: "a".repeat(64) },
    driver: { name: `${app.id}-driver`, version: "1.0.0", sourceCommit: "b".repeat(40), digestSha256: "c".repeat(64) },
    sourceEventFormat: { id: "opencode-event-v1", sourceRevision: "a9f7081d4015b0cc22ed67156e042b482a8d064a", schemaDigestSha256: OPENCODE_EVENT_SCHEMA_DIGEST },
    materialization: { mode: app.id === "claxedo" ? "native-opencode" : "translated", corpusDigestSha256: CANONICAL_CORPUS_DIGEST, mappingDigestSha256: "e".repeat(64) },
    scenario: { id: scenarioId, kind: scenario.value.kind, digestSha256: scenario.digest, status: "public-comparable" },
    corpus: { id: corpus.value.id, definitionDigestSha256: corpus.digest, digestSha256: CANONICAL_CORPUS_DIGEST, status: "public-comparable" },
    runProfile: "smoke",
    repetitions: scenario.value.runProfiles.smoke,
    observations,
    resources,
    resourceTrace,
    derivation: { version: 1, summaryDigestSha256: digest(summary), summary },
  };
}

function switchObservations(scenario) {
  return observationsFor([
    ...expandCases(scenario, "smoke", "agent-app-benchmark-public-v1"),
    ...buildResourceSequence(scenario, "agent-app-benchmark-public-v1"),
    { caseId: "progressive-resource-return-control", workload: "resource-control", destinationSessionId: "control" },
  ]);
}

function observationsFor(cases) {
  return cases.map((benchmarkCase, index) => {
    const durationMs = 20 + index;
    const start = 1000 + index * 100;
    return ({
    case: benchmarkCase,
    status: "valid",
    durationMs,
    readiness: {
      endpoint: "correct-content-painted-and-input-ready",
      checks: ["content-identity", "first-fold-painted", "two-presentations", "trusted-input"].map((id) => ({ id, passed: true })),
    },
    clock: { kind: "single-monotonic-clock", clock: "fixture-monotonic", start, end: start + durationMs },
    receivedAt: "2026-08-23T00:00:00.000Z",
  });
  });
}

function resourceTraceFixture(scenario) {
  const baseline = Array.from({ length: 241 }, (_, index) => sample(index * 250, 100 + index / 10, index * 5));
  const active = Array.from({ length: 25 }, (_, index) => sample(70000 + index * 250, 170 + index, 1210 + index * 5));
  const ending = Array.from({ length: 241 }, (_, index) => sample(80000 + index * 250, 112 + index / 100, 1340 + index * 5));
  const samples = [...baseline, ...active, ...ending];
  const activeOffset = baseline.length;
  return {
    version: 1,
    samples,
    windows: { baseline: { startMs: 0, endMs: 60000 }, active: { startMs: 70000, endMs: 76000 }, ending: { startMs: 80000, endMs: 140000 } },
    boundaries: buildResourceSequence(scenario).map((benchmarkCase, index) => ({ case: benchmarkCase, switchSequence: index + 1, beforeSampleIndex: activeOffset + index, afterSampleIndex: activeOffset + index + 1 })),
    monitorErrors: [],
    failure: null,
  };
}

function sample(atMs, rssMiB, cpuTimeMs) {
  const rssBytes = Math.round(rssMiB * 1048576);
  return { atMs, collectionDurationMicros: 100, rssBytes, cumulativeCpuTimeMs: cpuTimeMs, inaccessibleProcessCount: 0, rootProcessFound: true, missingExternalProcessCount: 0, processes: [{ pid: 10, startTimeMs: 0, cpuTimeMs, rssBytes, name: "fixture" }] };
}

const CANONICAL_CORPUS_DIGEST = "979d15dfeb87f2c539b39915c7324470a54f431a23c668f10ef484ab194b9e5e";
