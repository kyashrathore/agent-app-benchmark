import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadComparison } from "../comparison.mjs";
import { REPOSITORY_ROOT } from "../paths.mjs";
import { buildSiteModel } from "./model.mjs";
import { p95EqualsSampledMaximum, summaryOrUnavailable } from "../statistics.mjs";
import { PROCESS_FAMILY_CPU_DEFINITION } from "../summarize.mjs";
import { chart, disclosures, escapeHtml, format, page } from "./html.mjs";

const MARKER = ".agent-app-benchmark-site";
const LOGO_EXTENSIONS = ["svg", "png", "webp", "jpg", "jpeg"];

// Pages live either at the site root or one level down; every asset reference is
// resolved through this prefix, set by the page-level renderer before it emits HTML.
let ASSET_PREFIX = "assets/logos/";

export async function buildSite(comparisonFile, outputDirectory) {
  const comparison = await loadComparison(comparisonFile);
  const model = buildSiteModel(comparison);
  model.apps.forEach((app, index) => {
    app.tone = index % 8;
  });
  const logoDirectory = path.join(REPOSITORY_ROOT, "registry", "logos");
  const logos = await resolveAppLogos(logoDirectory, model.apps);
  const output = path.resolve(outputDirectory);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomBytes(5).toString("hex")}`);
  await mkdir(path.join(temporary, "assets"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(temporary, "apps"), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path.join(temporary, "index.html"), renderIndex(model), { mode: 0o600 });
    await writeFile(path.join(temporary, "methodology.html"), renderMethodology(model), { mode: 0o600 });
    const claims = claimsFor(model.apps);
    if (claims) await writeFile(path.join(temporary, "performance-promise.html"), renderClaims(model, claims), { mode: 0o600 });
    await writeFile(path.join(temporary, "assets", "site.css"), renderStylesheet(model.apps), { mode: 0o600 });
    for (const app of model.apps) {
      const directory = path.join(temporary, "apps", app.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, "index.html"), renderApp(model, app), { mode: 0o600 });
    }
    if (logos.length > 0) {
      await mkdir(path.join(temporary, "assets", "logos"), { recursive: true, mode: 0o700 });
      for (const app of logos) {
        await copyFile(path.join(logoDirectory, app.logoFile), path.join(temporary, "assets", "logos", app.logoFile));
      }
    }
    await writeFile(path.join(temporary, MARKER), `${model.id}\n`, { mode: 0o600 });
    await replaceGeneratedDirectory(output, temporary);
    return { output, model };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

// A logo is picked up purely by file convention — registering a new app and adding
// registry/logos/<app-id>.svg (or png/webp/jpg) is enough; apps without artwork fall
// back to a generated monogram so the layout never depends on assets existing.
async function resolveAppLogos(directory, apps) {
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const app of apps) {
    app.logoFile = LOGO_EXTENSIONS.map((extension) => `${app.id}.${extension}`).find((name) => entries.includes(name)) ?? null;
  }
  return apps.filter((app) => app.logoFile);
}

function appMark(app) {
  return app.logoFile
    ? `<img class="app-logo" src="${ASSET_PREFIX}${escapeHtml(app.logoFile)}" alt="" width="20" height="20" loading="lazy">`
    : `<span class="app-mono app-${escapeHtml(app.id)}" aria-hidden="true">${escapeHtml((app.name[0] ?? "?").toUpperCase())}</span>`;
}

function flowKicker(ordinal) {
  return `Flow ${String(ordinal).padStart(2, "0")}`;
}

/**
 * Whole-report win tally. Every comparable row on the index page records its
 * winner here, so the summary line is derived from the report itself instead of
 * restating any single metric.
 */
function createTally() {
  const wins = new Map();
  let comparable = 0;
  let ties = 0;
  return {
    record(winnerId) {
      if (winnerId === null || winnerId === undefined) return;
      comparable += 1;
      if (winnerId === "tie") {
        ties += 1;
        return;
      }
      wins.set(winnerId, (wins.get(winnerId) ?? 0) + 1);
    },
    readout(apps) {
      if (comparable === 0 || apps.length < 2) return null;
      const ranked = apps.toSorted((left, right) => (wins.get(right.id) ?? 0) - (wins.get(left.id) ?? 0));
      const leaderWins = wins.get(ranked[0].id) ?? 0;
      if (leaderWins === 0) return null;
      return { ranked, leader: ranked[0], leaderWins, comparable, ties, winsFor: (app) => wins.get(app.id) ?? 0 };
    },
  };
}

/**
 * Headline verdict. The report's first job is to answer "who won, and by how
 * much" before any table is read, so the winner's mark, its share of the
 * measurements, and the largest measured gap all appear at full size.
 */
function renderVerdictBanner(readout, best) {
  if (!readout) return "";
  const { leader, leaderWins, comparable, ties, ranked, winsFor } = readout;
  const share = Math.round((leaderWins / comparable) * 100);
  const bars = ranked.map((app) => {
    const won = winsFor(app);
    const width = comparable > 0 ? Math.max(1, Math.round((won / comparable) * 100)) : 0;
    return `<div class="verdict-bar app-${escapeHtml(app.id)}${app.id === leader.id ? " win" : ""}"><span class="verdict-bar-name">${appMark(app)}${escapeHtml(app.name)}</span><span class="verdict-track"><i class="bar-${width}"></i></span><span class="verdict-bar-count">${won}</span></div>`;
  }).join("");
  const gap = best && Number.isFinite(best.ratio)
    ? `<div class="verdict-stat"><b>${formatRatio(best.ratio)}×</b><span>biggest gap — ${escapeHtml(best.title.toLowerCase())}</span></div>`
    : "";
  const tieNote = ties > 0 ? `<div class="verdict-stat"><b>${ties}</b><span>${ties === 1 ? "tie" : "ties"}</span></div>` : "";
  return `<div class="verdict-banner app-${escapeHtml(leader.id)}"><div class="verdict-head"><span class="verdict-mark">${appMark(leader)}</span><div><p class="kicker">Winner</p><h2><b>${escapeHtml(leader.name)}</b> wins</h2></div></div><div class="verdict-stats"><div class="verdict-stat"><b>${leaderWins}<small>/${comparable}</small></b><span>measurements won (${share}%)</span></div>${gap}${tieNote}</div><div class="verdict-bars">${bars}</div></div>`;
}

// Lower wins everywhere in this benchmark. Ties require exact equality; the
// runner-up is the best value among the remaining distinct values.
function compareValues(values) {
  if (!values.every(Number.isFinite)) return null;
  const minimum = Math.min(...values);
  if (minimum === Math.max(...values)) return { tie: true, winnerIndex: -1 };
  const winnerIndex = values.indexOf(minimum);
  const runnerUp = [...new Set(values)].toSorted((left, right) => left - right)[1];
  return { tie: false, winnerIndex, minimum, maximum: Math.max(...values), runnerUp, ratio: minimum > 0 ? runnerUp / minimum : null };
}

// Methodology caveats stay on the page verbatim but collapsed: they qualify a
// result rather than being one, and at full weight they out-shouted the numbers.
function note(summary, detail) {
  return `<details class="note"><summary>${summary}</summary><p>${detail}</p></details>`;
}

// Pools raw observations across a whole trend axis and summarises them once.
// A per-step table restates what the chart already shows, and each step alone
// carries too few observations for its p95 to mean much; pooling every step
// gives one honest nearest-rank p95 over the full observation set.
function pooledLatency(result, predicate) {
  const observations = (result?.observations ?? []).filter((item) => predicate(item.case ?? {}));
  if (observations.length === 0) return null;
  const values = observations.filter((item) => item.status === "valid" && Number.isFinite(item.durationMs)).map((item) => item.durationMs);
  return summaryOrUnavailable(values, observations.length);
}

function asMetric(value) {
  if (value && typeof value === "object") return value;
  return Number.isFinite(value) ? { status: "valid", p95: value } : null;
}

function renderIndex(model) {
  ASSET_PREFIX = "assets/logos/";
  const apps = model.apps;
  const tally = createTally();
  const record = tally.record;
  const cards = apps.map((app) => `<a class="app-card app-${escapeHtml(app.id)}" href="apps/${escapeHtml(app.id)}/index.html">${appMark(app)}<span class="app-card-name">${escapeHtml(app.name)}</span><small>${escapeHtml(app.version)} · ${escapeHtml(app.guiFramework)} · ${escapeHtml(app.materializationModes.join(", "))}</small><span class="app-card-go" aria-hidden="true">→</span></a>`).join("");
  const startScenarioId = apps.find((app) => app.appStart)?.appStart.scenario.id;
  const switchScenarioId = apps.find((app) => app.sessionSwitch)?.sessionSwitch.scenario.id;
  const startStatus = model.compatibility[startScenarioId] ?? { status: "unpaired", reason: "No app-start results were supplied." };
  const switchStatus = model.compatibility[switchScenarioId] ?? { status: "unpaired", reason: "No session-switch results were supplied." };
  const appStart = startStatus.status === "valid"
    ? renderAppStartP95(apps.filter((app) => app.appStart), record)
    : comparisonUnavailable("Application start", startStatus, apps, "appStart");
  const memory = switchStatus.status === "valid"
    ? renderMemoryP95(apps.filter((app) => app.sessionSwitch), model, record)
    : comparisonUnavailable("Memory", switchStatus, apps, "sessionSwitch");

  // Flow numbers are derived from whichever flows this run actually contains,
  // so adding a scenario never leaves stale hand-written numbering behind.
  let ordinal = 0;
  const kickerFor = (property) => apps.some((app) => app[property]) ? flowKicker(++ordinal) : "";
  const kickers = Object.fromEntries(["sessionSwitch", "sessionNavigation", "workspacePanel"].map((property) => [property, kickerFor(property)]));
  const sessionSwitchComparison = pairedScenarioSection(model, "sessionSwitch", "Session switching", renderSessionSwitchComparison, { kicker: kickers.sessionSwitch, record });
  const navigationComparison = pairedScenarioSection(model, "sessionNavigation", "Session navigation", renderSessionNavigationComparison, { kicker: kickers.sessionNavigation, record });
  const workspacePanelComparison = pairedScenarioSection(model, "workspacePanel", "Workspace panel", renderWorkspacePanelComparison, { kicker: kickers.workspacePanel, record });

  const scorecard = renderScorecard(model, record);
  const readout = tally.readout(apps);
  const bannerHtml = renderVerdictBanner(readout, scorecard.best);
  const verdict = scorecard.html || bannerHtml
    ? `<section class="verdict" id="verdict" aria-label="Verdict at a glance">${bannerHtml}<div class="flow-heading"><p class="kicker">Every headline measurement</p><h2>How much better, metric by metric</h2><p>Lower is better throughout. Each card shows the gap first, then the measured values behind it.</p></div>${scorecard.html ? `<div class="score-grid">${scorecard.html}</div>` : ""}</section>`
    : "";
  const hasSystemScenarios = apps.some((app) => app.appStart || app.sessionSwitch);
  const environment = apps[0]?.environment;
  const validScenarios = Object.values(model.compatibility).filter((item) => item.status === "valid").length;
  const totalScenarios = Object.keys(model.compatibility).length;
  const scheduleOrder = model.schedule.map((step) => `${step.ordinal}. ${step.appId} / ${step.scenarioId}`).join(" → ");
  const revisions = model.frameworkRevisions.map((revision) => `<code>${escapeHtml(shortRevision(revision))}</code>`).join(", ");
  const repetitionLabel = `${model.repetitions ?? "—"} ${model.repetitions === 1 ? "repetition" : "repetitions"}`;
  const statisticExplanation = model.p95Disclosure?.note
    ?? `Nearest-rank p95 is the primary statistic for every distributional comparison at ${repetitionLabel}.`;
  const systemNavigation = hasSystemScenarios ? `<a href="#application-start">App start</a><a href="#memory">Memory &amp; CPU</a>` : "";
  const hostLine = environment
    ? `${environment.cpuModel} · ${environment.logicalCpuCount} logical CPUs · ${formatMemory(environment.totalMemoryBytes)} RAM · ${environment.platform}/${environment.architecture}`
    : "Not supplied";
  const navigation = `<nav class="section-nav" aria-label="Report sections"><a href="#verdict">Verdict</a><a href="#session-switching">Session switching</a>${systemNavigation}<a href="#session-navigation">Session navigation</a><a href="#workspace-panel">Workspace panel</a><a href="#method">Method</a></nav>`;
  // The front page asks the question the benchmark answers. The machine, the
  // repetition count, the workload sizes, and the operator's run notes all live
  // on the methodology page, one click away.
  //
  // The headline questions whichever application actually made a public
  // performance claim, so it stays accurate for any comparison rather than
  // hard-coding one product name.
  const claims = claimsFor(apps);
  const headline = claims
    ? `How fast is ${claims.dossier.subject}, really?`
    : `Is ${apps.map((app) => app.name).join(" or ")} actually fast?`;
  const lede = claims
    ? `${claims.dossier.subject} was built and launched on a performance argument — that agent GUIs burn RAM, CPU, and battery, and that a well-built Electron app could beat them. That is a testable claim, so this is it tested: packaged builds, identical frozen sessions, one machine, mirrored order.`
    : `${apps.length === 2 ? "Two" : String(apps.length)} packaged coding-agent desktop apps, the same frozen sessions, the same machine, ${orderPhrase(model)}. Every number below is the time a real user action took, measured from the input to the moment the app was ready again.`;
  const claimsLink = claims ? `<a class="button button-quiet" href="performance-promise.html">Read the performance promise</a>` : "";
  const hero = `<section class="hero" id="overview"><p class="eyebrow">${escapeHtml(model.title)}</p><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(lede)}</p><p class="hero-actions"><a class="button" href="#verdict">See the verdict</a>${claimsLink}<a class="button button-quiet" href="methodology.html">Methodology</a></p></section>`;
  const systemSection = hasSystemScenarios
    ? `<section class="benchmark-section system-performance"><div class="flow-heading"><p class="kicker">System envelope</p><h2>Launch, memory, and CPU</h2><p>Cold and initialized process launch are measured separately. Memory and CPU are summed across each declared application process family across a baseline idle window, the progressive historical-session workload, and an ending idle window.</p></div>${appStart}${memory}</section>`
    : "";
  const appsSection = `<section class="app-section"><div class="matrix-heading"><h3>Individual application reports</h3><p>Full per-application breakdown and provenance</p></div><nav class="app-grid" aria-label="Application identity and individual reports">${cards}</nav></section>`;

  // Setup, fairness controls, and provenance are the report's warrant, not its
  // result. They stay complete and linkable but sit after every measurement and
  // open only on request, so the flows above read without interruption.
  const method = `<section class="method" id="method"><div class="flow-heading"><p class="kicker">Method and provenance</p><h2>Every number here has a procedure behind it</h2><p>The machine, the repetition count, the session sizes, the fairness controls, and the statistics are documented in full on the methodology page.</p></div><p class="hero-actions"><a class="button" href="methodology.html">Read the methodology</a></p></section>`;

  const body = `${navigation}${hero}${verdict}${sessionSwitchComparison}${systemSection}${navigationComparison}${workspacePanelComparison}${appsSection}${method}`;
  return page({ title: model.title, current: "index", body });
}

/**
 * Methodology page.
 *
 * Everything about how the run was set up — the machine, the repetition count,
 * the workload sizes, the fairness controls, the statistics, and the raw run
 * description — lives here rather than on the results page. The results page
 * links to it and otherwise stays about the numbers.
 */
/**
 * Public performance claims that motivated this benchmark, kept as a dossier
 * keyed by application id. Every entry is a short excerpt plus a link to the
 * original public post; the page exists to state the claim being tested, not to
 * reproduce anyone's writing wholesale.
 *
 * Entries were supplied by the report operator and are presented as cited
 * claims, not as verified facts.
 */
const PERFORMANCE_CLAIMS = {
  t3: {
    subject: "T3 Code",
    author: "Theo",
    handle: "@theo",
    lede: "T3 Code was built, and launched, on an explicitly performance-shaped argument: that agent GUIs were eating RAM, CPU, and battery, and that a carefully built Electron app could beat them. That argument is the reason this benchmark exists — it is a testable claim, so this report tests it.",
    chapters: [
      {
        title: "The complaint",
        period: "Late January – early February 2026",
        summary: "The starting position: existing agent orchestrator GUIs were resource hogs, and the cost showed up in battery life.",
        posts: [
          { date: "Jan 30, 2026", quote: "They use too much RAM and CPU.", gloss: "On agent-orchestrator GUIs generally, alongside a claim that battery life dropped from 10 hours to 2.", url: "https://x.com/theo/status/2017062344380256529" },
          { date: "Jan 30, 2026", quote: "the tauri apps have had the WORST perf issues for me", gloss: "Tauri alternatives are described as leaking memory constantly; Electron apps are called bad but better.", url: "https://x.com/theo/status/2017067566297215372" },
          { date: "Jan 30, 2026", quote: "Claude Code is slow. Well…kind of.", gloss: "A video arguing the situation is more complex than it looks.", url: "https://x.com/theo/status/2017361674181943757" },
          { date: "Jan 31, 2026", quote: "Claude Code's performance is unacceptable.", gloss: "A reversal of the previous day's position, citing laptop fans and battery drain, with Codex and OpenCode named as fine.", url: "https://x.com/theo/status/2017725704386056214" },
          { date: "Feb 2, 2026", quote: "Codex doesn't absolutely eviscerate my battery", gloss: "Contrasted against Conductor.", url: "https://x.com/theo/status/2018402703911911678" },
          { date: "Feb 3, 2026", quote: "why are my laptop's fans going so hard right now", gloss: "Posted with a screenshot of Claude Code's own answer.", url: "https://x.com/theo/status/2018525055756705976" },
        ],
      },
      {
        title: "The build",
        period: "January – February 2026",
        summary: "A native macOS alternative was started, then abandoned for Electron — on the argument that Electron was the faster path, not the slower one.",
        posts: [
          { date: "Jan 30, 2026", quote: "So I started building a native alternative for MacOS", gloss: "Announced with a video demo.", url: "https://x.com/theo/status/2017062344380256529" },
          { date: "Jan 30, 2026", quote: "Built with Swift and AppKit (SwiftUI perf is garbage)", gloss: "With the caveat that Electron apps can be good and performant.", url: "https://x.com/theo/status/2017062992987508924" },
          { date: "Jan 30, 2026", quote: "a memory leak that drains my laptop battery in under 2 hours", gloss: "On the state of the native prototype at the time.", url: "https://x.com/theo/status/2017106707881881676" },
          { date: "Feb 8, 2026", quote: "ported to electron to GAIN perf", gloss: "The reasoning given is that text rendering and smooth scrolling were hard to get right in AppKit and come free with Electron.", url: "https://x.com/theo/status/2020376657203454160" },
          { date: "Feb 20, 2026", quote: "Claude Code needs to be rewritten from scratch at this point", gloss: "Following a post describing a sharp recent regression.", url: "https://x.com/theo/status/2024718133676867608" },
        ],
      },
      {
        title: "The launch",
        period: "February – March 2026",
        summary: "T3 Code is named and shipped, with the pitch tied back to the resource complaint.",
        posts: [
          { date: "Feb 27, 2026", gloss: "The Claude Code integration is described as mostly done, built on the Codex App Server and the Agent SDK.", url: "https://x.com/theo/status/2027497483061072301" },
          { date: "Mar 7, 2026", quote: "T3 Code is now available", gloss: "Launch post: fully open source, built on top of the Codex CLI.", url: "https://x.com/theo/status/2030071716530245800" },
          { date: "Mar 7, 2026", quote: "Codex? If you hate having RAM.", gloss: "A self-described buzzword-clickbait launch follow-up.", url: "https://x.com/theo/status/2030116220805296554" },
          { date: "Mar 7, 2026", quote: "we weren't happy with existing solutions, so we built our own", gloss: "The stated reason for building it.", url: "https://x.com/theo/status/2030081607902941553" },
        ],
      },
      {
        title: "The measurable claim",
        period: "March 2026 onward",
        summary: "The pitch becomes a specific, checkable number — which is the kind of claim a benchmark can actually settle.",
        posts: [
          { date: "Mar 22, 2026", quote: "T3 Code uses half as much RAM as Claude Code.", gloss: "Quoted as 635.5 MB for the Claude Code CLI against 350.9 MB for T3 Code, with the claim that the Electron app is twice as efficient as a Bun-written CLI.", url: "https://x.com/theo/status/2035531539581485151" },
          { date: "Apr 30, 2026", quote: "a focus on customizability, extensibility and performance", gloss: "Positioning against the Codex App.", url: "https://x.com/theo/status/2049975633569251550" },
          { date: "Apr 4, 2026", quote: "I don't really have battery problems anymore", gloss: "Quoting a user after switching.", url: "https://x.com/theo/status/2040381377930277367" },
        ],
      },
      {
        title: "The ongoing work",
        period: "May – August 2026",
        summary: "Performance stays an active, publicly tracked concern after launch — including on T3 Code itself.",
        posts: [
          { date: "Jul 13, 2026", quote: "the performance of the harnesses was the vast majority of CPU and memory utilization", gloss: "On where the cost was found to sit.", url: "https://x.com/theo/status/2076786459600924836" },
          { date: "Jul 14, 2026", quote: "Performance isn't where it should be on T3 Code web", gloss: "Posted after two days of fixes.", url: "https://x.com/theo/status/2077176552186581372" },
          { date: "Jul 19, 2026", quote: "Way too many sub processes.", gloss: "Each subagent and thread spawning multiple MCP servers, each monitored by syspolicyd.", url: "https://x.com/theo/status/2078967740115923292" },
          { date: "Jul 31, 2026", quote: "We've been working hard on performance for T3 Code", gloss: "", url: "https://x.com/theo/status/2083323744404332640" },
          { date: "Aug 26, 2026", quote: "93.8%+ performance improvement for rendering long threads", gloss: "From release notes also citing an in-app terminal performance overhaul and an 80%+ reduction in thread data transferred and stored.", url: "https://x.com/theo/status/2092455706582499815" },
        ],
      },
    ],
  },
};

function claimsFor(apps) {
  for (const app of apps) {
    if (PERFORMANCE_CLAIMS[app.id]) return { app, dossier: PERFORMANCE_CLAIMS[app.id] };
  }
  return null;
}

/**
 * The performance-promise page: the public claim under test, in the claimant's
 * own words, with a link on every entry so a reader can check the source.
 */
function renderClaims(model, claims) {
  ASSET_PREFIX = "assets/logos/";
  const { app, dossier } = claims;
  const chapters = dossier.chapters.map((chapter, index) => {
    const posts = chapter.posts.map((post) => `<li><p class="post-date">${escapeHtml(post.date)}</p>${post.quote ? `<blockquote>${escapeHtml(post.quote)}</blockquote>` : ""}${post.gloss ? `<p class="post-gloss">${escapeHtml(post.gloss)}</p>` : ""}<a class="post-link" href="${escapeHtml(post.url)}" rel="noopener noreferrer nofollow" target="_blank">Read the original post ↗</a></li>`).join("");
    return `<section class="chapter" id="${escapeHtml(slugify(chapter.title))}"><div class="chapter-head"><p class="kicker">Chapter ${String(index + 1).padStart(2, "0")} · ${escapeHtml(chapter.period)}</p><h2>${escapeHtml(chapter.title)}</h2><p>${escapeHtml(chapter.summary)}</p></div><ol class="posts">${posts}</ol></section>`;
  }).join("");

  const body = `<nav class="section-nav" aria-label="Sections"><a href="index.html" class="nav-back">← Results</a>${dossier.chapters.map((chapter) => `<a href="#${escapeHtml(slugify(chapter.title))}">${escapeHtml(chapter.title)}</a>`).join("")}</nav>

<section class="hero"><p class="eyebrow">The claim under test</p><h1>${escapeHtml(dossier.subject)} was pitched on performance</h1><p>${escapeHtml(dossier.lede)}</p><p class="hero-actions"><a class="button" href="index.html">See the measurements</a><a class="button button-quiet" href="methodology.html">How it was measured</a></p></section>

<section class="method-block"><div class="notice-card"><p><strong>What this page is.</strong> A collection of public posts by ${escapeHtml(dossier.author)} (${escapeHtml(dossier.handle)}) about desktop coding-agent performance, gathered because they set the expectation this benchmark measures. Excerpts are short and every entry links to the original. They are reproduced as cited claims, not as findings of this benchmark, and nothing here is endorsed or disputed by the numbers on the results page except where the results page says so directly.</p></div></section>

${chapters}

<section class="method-block"><div class="flow-heading"><p class="kicker">So — is it?</p><h2>The claim is testable, so we tested it</h2><p>Every post above is an argument about how a desktop coding-agent app should feel to use. This report measures exactly that, on packaged builds, over identical frozen sessions, on one machine.</p></div><p class="hero-actions"><a class="button" href="index.html">See the results</a><a class="button button-quiet" href="methodology.html">Read the methodology</a></p></section>`;

  return page({ title: `The performance promise · ${escapeHtml(dossier.subject)}`, current: "claims", root: "", body });
}

const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function renderMethodology(model) {
  ASSET_PREFIX = "assets/logos/";
  const apps = model.apps;
  const environment = apps[0]?.environment;
  const validScenarios = Object.values(model.compatibility).filter((item) => item.status === "valid").length;
  const totalScenarios = Object.keys(model.compatibility).length;
  const revisions = model.frameworkRevisions.map((revision) => `<code>${escapeHtml(shortRevision(revision))}</code>`).join(", ");
  const scheduleRows = model.schedule.map((step) => `<tr><th scope="row">${step.ordinal}</th><td>${escapeHtml(appName(apps, step.appId))}</td><td>${escapeHtml(step.scenarioId)}${step.createdAt ? ` <small>(${escapeHtml(step.createdAt)})</small>` : ""}</td></tr>`).join("");

  const transcriptSizes = [...new Set(apps.flatMap((app) => (app.sessionSwitch?.derivation.summary.transcriptSizeTrend ?? []).map((point) => point.transcriptBytes)))].toSorted((left, right) => left - right);
  const sizeList = transcriptSizes.length > 0 ? transcriptSizes.map((bytes) => `${bytes / 1048576} MiB`).join(" · ") : "not recorded by this run";
  const loadProfiles = [...new Set(apps.flatMap((app) => (app.workspacePanel?.derivation.summary.loadTrend ?? []).map((point) => point.loadProfile)))];
  const loadList = loadProfiles.length > 0 ? loadProfiles.join(" · ") : "not recorded by this run";

  const hostRows = environment ? [
    ["Processor", `${environment.cpuModel} · ${environment.logicalCpuCount} logical CPUs`],
    ["Memory", formatMemory(environment.totalMemoryBytes)],
    ["Platform", `${environment.platform}/${environment.architecture}`],
    ["Free memory at run start", Number.isFinite(environment.freeMemoryBytes) ? `${format(environment.freeMemoryBytes / 1073741824)} GiB` : "not recorded"],
    ["Load average per CPU at run start", Number.isFinite(environment.loadAverage1mPerCpu) ? format(environment.loadAverage1mPerCpu) : "not recorded"],
    ["Power source", `${environment.powerSource ?? "not recorded"}${environment.lowPowerMode === null || environment.lowPowerMode === undefined ? "" : ` · low-power mode ${environment.lowPowerMode ? "on" : "off"}`}`],
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("") : `<div><dt>Host</dt><dd>Not supplied</dd></div>`;

  const appRows = apps.map((app) => `<tr><th scope="row"><span class="app-key">${appMark(app)}${escapeHtml(app.name)}</span></th><td>${escapeHtml(app.version)}</td><td>${escapeHtml(app.guiFramework)}</td><td>${escapeHtml(app.materializationModes.join(", "))}</td><td>${escapeHtml(app.sourceEventFormat.id)}</td></tr>`).join("");
  const driverRows = apps.flatMap((app) => app.scenarioProvenance.map((run) => `<tr><th scope="row">${escapeHtml(run.scenarioId)}</th><td>${escapeHtml(app.name)}</td><td>${escapeHtml(run.driver.name)} ${escapeHtml(run.driver.version)}</td><td>${escapeHtml(run.materializationMode)}</td><td><code>${escapeHtml(shortRevision(run.frameworkRevision))}</code></td></tr>`)).join("");

  const flowRows = FLOW_EXPLANATIONS
    .filter((flow) => apps.some((app) => app[flow.property]))
    .map((flow) => `<div class="explain"><h3>${escapeHtml(flow.title)}</h3><p>${escapeHtml(flow.what)}</p><p class="explain-why"><strong>Why it matters.</strong> ${escapeHtml(flow.why)}</p></div>`)
    .join("");

  const processFamily = apps.map((app) => {
    const evidence = app.resourceWindows?.processFamily;
    if (!evidence) return "";
    return `<div><dt>${escapeHtml(app.name)}</dt><dd>Up to ${evidence.maximumObservedProcessCount} processes observed${evidence.observedProcessNames.length > 0 ? `: ${escapeHtml(evidence.observedProcessNames.join(", "))}` : ""}.</dd></div>`;
  }).join("");

  const body = `<nav class="section-nav" aria-label="Methodology sections"><a href="index.html" class="nav-back">← Results</a><a href="#what">What this is</a><a href="#machine">Machine</a><a href="#run">The run</a><a href="#workload">Workload</a><a href="#flows">What each flow measures</a><a href="#fairness">Fairness</a><a href="#statistics">Statistics</a><a href="#provenance">Provenance</a></nav>

<section class="hero" id="what"><p class="eyebrow">Methodology</p><h1>How this comparison was measured</h1><p>Agent App Benchmark measures what a coding-agent desktop app actually feels like to use, on real packaged builds, over identical pinned session data, on one machine, ${orderPhrase(model)}. Every number on the results page comes from the procedure described below.</p><p class="hero-actions"><a class="button" href="index.html">← Back to results</a></p></section>

<section class="method-block"><div class="flow-heading"><p class="kicker">The premise</p><h2>Same work, same machine, ${model.policy === "balanced-mirrored" ? "mirrored order" : "independent runs"}</h2></div><div class="pillars"><article><h3>Real packaged builds</h3><p>Each application is exercised through its own registered production path as a packaged desktop build — not a dev server, not a stripped harness. Whatever the shipping app does on launch, it does here.</p></article><article><h3>Identical pinned data</h3><p>Both applications replay the same frozen corpus of completed OpenCode-format sessions. Nothing is generated live, so neither app can win or lose on model speed, network latency, or tool execution.</p></article><article><h3>One machine, ${model.policy === "balanced-mirrored" ? "mirrored order" : "independent runs"}</h3><p>${escapeHtml(orderPillar(model))}</p></article><article><h3>Nothing scored as zero</h3><p>Where a product contract genuinely does not support a flow, the observation is excluded and the driver's exact reason is printed. An unsupported capability is never silently recorded as instant.</p></article></div></section>

<section class="method-block" id="machine"><div class="flow-heading"><p class="kicker">The machine</p><h2>Where this run executed</h2><p>${apps.length === 2 ? "Both" : "All"} applications ran on this one host${model.policy === "balanced-mirrored" ? ", back to back" : ", each in its own sealed run"}. Host identity is part of compatibility validation: results measured on different machines are never paired.</p></div><dl class="method-summary">${hostRows}</dl></section>

<section class="method-block" id="run"><div class="flow-heading"><p class="kicker">The run</p><h2>Repetitions, profile, and coverage</h2></div><div class="stat-row"><div class="stat"><b>${model.repetitions ?? "—"}</b><span>${model.repetitions === 1 ? "repetition" : "repetitions"} per measurement</span></div><div class="stat"><b>${escapeHtml(String(model.primaryStatistic).toUpperCase())}</b><span>primary statistic (${escapeHtml(model.primaryStatisticMethod)})</span></div><div class="stat"><b>${validScenarios}/${totalScenarios}</b><span>scenarios paired and valid</span></div><div class="stat"><b>${escapeHtml(model.runProfile ?? "—")}</b><span>run profile</span></div></div><p class="prose">Every measurement below is repeated ${escapeHtml(String(model.repetitions ?? "an unrecorded number of"))} ${model.repetitions === 1 ? "time" : "times"} per application, and each reported value carries its own valid / attempted count so you can see exactly how many observations survived validation.</p><details class="quiet"><summary>Execution order — every step, in the order it ran</summary><div class="table-scroll"><table><caption>${model.policy === "balanced-mirrored" ? "Balanced mirrored execution schedule" : "Independent runs, listed by start time"}</caption><thead><tr><th scope="col">Step</th><th scope="col">Application</th><th scope="col">Scenario</th></tr></thead><tbody>${scheduleRows || `<tr><td colspan="3">No paired schedule supplied.</td></tr>`}</tbody></table></div></details></section>

<section class="method-block" id="workload"><div class="flow-heading"><p class="kicker">The workload</p><h2>How much data the apps were pushed through</h2><p>Session size is the main stressor in this benchmark. A coding-agent transcript that is pleasant at 1 MiB can be unusable at 128 MiB, and that divergence is exactly what the trend charts are looking for.</p></div><dl class="method-summary"><div><dt>Historical session sizes</dt><dd>${escapeHtml(sizeList)}</dd></div><div><dt>Workspace panel load profiles</dt><dd>${escapeHtml(loadList)} — each varies retained directory and file-tab state while keeping the same complete 24-file Review model.</dd></div><div><dt>Source event formats</dt><dd>${escapeHtml([...new Set(apps.map((app) => app.sourceEventFormat.id))].join(", "))}</dd></div><div><dt>Materialization</dt><dd>${escapeHtml([...new Set(apps.flatMap((app) => app.materializationModes))].join(", "))} — each application uses its registered production path; native and translated mappings are disclosed rather than hidden.</dd></div></dl>${processFamily ? `<details class="quiet"><summary>Process families measured for memory and CPU</summary><p class="prose">${escapeHtml(PROCESS_FAMILY_CPU_DEFINITION)}</p><dl class="method-summary">${processFamily}</dl></details>` : ""}</section>

<section class="method-block" id="flows"><div class="flow-heading"><p class="kicker">The flows</p><h2>What each measurement actually times</h2><p>Every flow measures a real user action end to end: from the trusted input event to the moment the requested surface is correct, painted, and ready for the next input.</p></div><div class="explain-grid">${flowRows}</div></section>

<section class="method-block" id="fairness"><div class="flow-heading"><p class="kicker">Fairness ledger</p><h2>What stops this from being a rigged demo</h2></div><dl class="method-summary"><div><dt>Order control</dt><dd>${escapeHtml(orderControl(model))}</dd></div><div><dt>Corpus and cases</dt><dd>Compatibility validation requires identical framework revision, scenario, corpus, profile, repetition count, and host identity${model.policy === "balanced-mirrored" ? "" : " (independent runs are not required to share a schedule or a framework revision)"}. Anything that fails to match is reported as unpaired instead of being compared anyway.</dd></div><div><dt>Materialization</dt><dd>Each application uses its registered production path. Native and translated mappings are disclosed; unsupported product contracts are not scored as zero.</dd></div><div><dt>Presentation vs speed</dt><dd>Deliberate animation duration is never used to name a latency winner. Panel open and close are scored on trusted-input response and p95 frame health only.</dd></div><div><dt>Withheld values</dt><dd>A measurement that lost its process family, recorded no sample, or failed validation stays Invalid with its reason attached. It is never substituted with a zero or an average.</dd></div></dl></section>

<section class="method-block" id="statistics"><div class="flow-heading"><p class="kicker">Statistics</p><h2>Why p95, and what the disclosures mean</h2></div><p class="prose">${escapeHtml(model.p95Disclosure?.note ?? "Nearest-rank p95 is the primary statistic for every distributional comparison.")}</p><dl class="method-summary"><div><dt>Primary statistic</dt><dd>${escapeHtml(model.primaryStatistic)} (${escapeHtml(model.primaryStatisticMethod)})</dd></div><div><dt>Why p95 rather than the average</dt><dd>An average hides the slow interactions that actually make an application feel bad. p95 describes the experience you notice — the worst one in twenty actions — which is where sluggishness is felt.</dd></div><div><dt>&quot;p95 = sampled max&quot;</dt><dd>Nearest-rank p95 selects the ceil(0.95 × n)-th ordered valid observation. Below ${model.p95Disclosure?.equalsSampledMaximumBelowValidCount ?? 20} valid observations that rank is the last one, so the p95 is exactly the largest observation. Those values are labelled rather than quietly relabelled as a different statistic.</dd></div><div><dt>Sampled maximum</dt><dd>Where a sampled maximum appears in the resource tables it is the largest observed framework sample and is diagnostic only; it is not an operating-system true peak.</dd></div><div><dt>Winner definition</dt><dd>Lower is better on every metric in this benchmark. A winner is the strict minimum; exact equality is reported as a tie; ratios are quoted against the best remaining value.</dd></div></dl></section>

<section class="method-block" id="provenance"><div class="flow-heading"><p class="kicker">Provenance</p><h2>Exactly what was built, and by whom</h2></div><dl class="method-summary"><div><dt>Run identifier</dt><dd><code>${escapeHtml(model.id)}</code></dd></div><div><dt>Attestation</dt><dd>${escapeHtml(model.provenance)}</dd></div><div><dt>Framework revision</dt><dd>${revisions || "—"}</dd></div></dl><div class="matrix-heading"><h3>Applications under test</h3></div><div class="table-scroll"><table><caption>Applications compared in this run</caption><thead><tr><th scope="col">Application</th><th scope="col">Version</th><th scope="col">GUI framework</th><th scope="col">Materialization</th><th scope="col">Source events</th></tr></thead><tbody>${appRows}</tbody></table></div><details class="quiet"><summary>Driver and framework revision for every scenario run</summary><div class="table-scroll"><table><caption>Per-scenario driver provenance</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Application</th><th scope="col">Driver</th><th scope="col">Materialization</th><th scope="col">Revision</th></tr></thead><tbody>${driverRows}</tbody></table></div></details>${model.description ? `<details class="quiet"><summary>Run notes as recorded by the operator</summary><p class="prose run-notes">${escapeHtml(model.description)}</p></details>` : ""}<p class="scope"><strong>Scope.</strong> This report measures packaged GUI flows over pinned completed-session data. It does not measure Web Vitals, model or harness speed, live streaming output, live tool execution, or terminal coding agents.</p></section>`;

  return page({ title: `Methodology · ${model.title}`, current: "methodology", root: "", body });
}

// Plain-language description of every flow, kept next to the methodology page so
// the results page can stay terse without the meaning being lost.
const FLOW_EXPLANATIONS = [
  {
    property: "sessionSwitch",
    title: "Session switching",
    what: "Click a different completed session in the session list, and time until that session's transcript is correctly painted and the app accepts input again. Measured both within one workspace and across workspaces, and both for surfaces never rendered before (cold) and surfaces already rendered once in the same launch (warm).",
    why: "This is the single most repeated action in a coding-agent app. If it degrades as transcripts grow, the app gets slower the more you actually use it.",
  },
  {
    property: "appStart",
    title: "Application start",
    what: "Time from process spawn to a painted, input-ready window. Cold start begins with no saved application state; initialized start begins with application state already on disk.",
    why: "Launch cost is paid every session and is the first impression of whether an app feels heavy.",
  },
  {
    property: "sessionNavigation",
    title: "Session navigation",
    what: "First visit times a session surface that has never been mounted. Return times revisiting a session already rendered, with the workspace panel closed. Panel-open returns are isolated as their own seeded-load trend.",
    why: "The gap between first visit and return shows whether an application is genuinely caching rendered work or rebuilding it every time.",
  },
  {
    property: "workspacePanel",
    title: "Workspace panel",
    what: "Every panel interaction is scored on two questions: how quickly the requested surface responded or became usable, and whether rendering stayed inside the 16.67 ms frame budget. Load profiles vary retained directory and file-tab state against the same complete 24-file Review model.",
    why: "Panel work is where a desktop app either holds 60 Hz or visibly stutters, and frame health is not visible in a latency number alone.",
  },
];

function appName(apps, id) {
  return apps.find((app) => app.id === id)?.name ?? id;
}

function renderApp(model, app) {
  ASSET_PREFIX = "../../assets/logos/";
  let ordinal = 0;
  const kickerFor = (has) => has ? flowKicker(++ordinal) : "";
  const kickers = {
    sessionSwitch: kickerFor(Boolean(app.sessionSwitch)),
    sessionNavigation: kickerFor(Boolean(app.sessionNavigation)),
    workspacePanel: kickerFor(Boolean(app.workspacePanel)),
  };
  const sections = [disclosures(app)];
  if (app.appStart) sections.push(renderAppStartP95([app]));
  if (app.sessionSwitch) sections.push(renderSessionSwitchComparison([app], model, { kicker: kickers.sessionSwitch }));
  if (app.sessionSwitch) sections.push(renderMemoryP95([app], model));
  if (app.sessionNavigation) sections.push(renderSessionNavigationComparison([app], model, { kicker: kickers.sessionNavigation }));
  if (app.workspacePanel) sections.push(renderWorkspacePanelComparison([app], model, { kicker: kickers.workspacePanel }));
  const maximumMiB = app.sessionSwitch?.derivation.summary.transcriptSizeTrend.at(-1)?.transcriptBytes / 1048576;
  const activeRange = Number.isFinite(maximumMiB) ? `1 MiB through ${format(maximumMiB)} MiB` : "the configured session sizes";
  const heroMark = app.logoFile
    ? `<img class="hero-logo" src="${ASSET_PREFIX}${escapeHtml(app.logoFile)}" alt="" width="72" height="72">`
    : `<span class="app-mono hero-mono app-${escapeHtml(app.id)}" aria-hidden="true">${escapeHtml((app.name[0] ?? "?").toUpperCase())}</span>`;
  const body = `<section class="hero compact"><p class="eyebrow"><a href="../../index.html">← All applications</a></p><div class="hero-app">${heroMark}<div><h1>${escapeHtml(app.name)}</h1><p>Individual result page for ${escapeHtml(model.title)}.</p></div></div></section>${sections.join("")}<section class="method"><div class="flow-heading"><p class="kicker">Definitions</p><h2>What the windows mean</h2></div><p class="scope"><strong>Active memory</strong> is measured while completed historical sessions progress across ${activeRange}. <strong>Idle</strong> means the fixed 1 MiB control transcript is fully ready with no benchmark input for the scenario's configured idle window. No live session stream is running.</p></section>`;
  return page({ title: `${app.name} · ${model.title}`, current: app.id, body });
}

/**
 * Headline scorecard: one card per paired-valid scenario's primary metric, with
 * every participating app stacked and the strict minimum highlighted. Cards
 * appear only where at least two apps have finite values — anything invalid or
 * unpaired keeps its full disclosure in the sections below.
 */
function renderScorecard(model, record) {
  const apps = model.apps;
  if (apps.length < 2) return { html: "", best: null };
  const pairedValid = (property) => apps.every((app) => app[property]) && model.compatibility[apps[0][property].scenario.id]?.status === "valid";
  const cards = [];
  if (pairedValid("sessionSwitch")) {
    const lane = (key) => (app) => app.sessionSwitch.derivation.summary[key];
    cards.push(scorecardCard(apps, "Switching session", "Click another session, wait until its transcript is painted and typing works again", lane("within-workspace-cold"), "ms", "faster", record));
    cards.push(scorecardCard(apps, "Returning to a session", "The same click, but back to a session this launch already rendered once", lane("within-workspace-warm"), "ms", "faster", record));
  }
  if (pairedValid("appStart")) {
    cards.push(scorecardCard(apps, "Starting the app", "Launching from nothing until the window is painted and accepts input", (app) => app.appStart.derivation.summary["new-application-state"], "ms", "faster", record));
  }
  if (pairedValid("sessionSwitch")) {
    cards.push(scorecardCard(apps, "Memory while working", "Memory held by every app process while working through sessions of growing size", (app) => app.resourceWindows?.windows?.active?.rssP95MiB, "MiB", "lower", record));
    cards.push(scorecardCard(apps, "Memory never released", "Still held after returning to the small starting session, compared with before", (app) => app.resourceWindows?.retainedRssGrowthMiB, "MiB", "lower", record));
  }
  const scored = cards.filter(Boolean);
  const best = scored.filter((card) => Number.isFinite(card.ratio)).toSorted((left, right) => right.ratio - left.ratio)[0] ?? null;
  return { html: scored.map((card) => card.html).join(""), best };
}

function scorecardCard(apps, title, context, metricForApp, unit, word, record) {
  const metrics = apps.map((app) => asMetric(metricForApp(app)));
  const values = metrics.map((metric) => metricValue(metric, "p95"));
  const outcome = compareValues(values);
  if (!outcome) return null;
  record?.(outcome.tie ? "tie" : apps[outcome.winnerIndex].id);
  const winner = outcome.tie ? null : apps[outcome.winnerIndex];

  // Bars encode measured magnitude against the worst value in the row, so the
  // slower application is visibly longer rather than merely a larger number.
  const scale = Math.max(...values.filter(Number.isFinite), 0);
  const ordered = apps.map((app, index) => ({ app, index })).toSorted((left, right) => values[left.index] - values[right.index]);
  const rows = ordered.map(({ app, index }) => {
    const win = !outcome.tie && outcome.winnerIndex === index;
    const counts = Number.isFinite(metrics[index]?.valid) ? `${metrics[index].valid} of ${metrics[index].attempted} runs valid` : "";
    const share = scale > 0 && Number.isFinite(values[index]) ? Math.max(2, Math.round((values[index] / scale) * 100)) : 0;
    return `<div class="score-row app-${escapeHtml(app.id)}${win ? " win" : ""}"><span class="score-name">${appMark(app)}${escapeHtml(app.name)}</span><span class="score-value">${formatWithUnit(values[index], unit)}</span><span class="score-bar"><i class="bar-${share}"></i></span><span class="score-count">${escapeHtml(counts)}</span></div>`;
  }).join("");

  const lead = outcome.tie
    ? `<p class="score-lead tie"><b>Tie</b><span>identical ${escapeHtml(word === "faster" ? "timing" : "value")}</span></p>`
    : `<p class="score-lead app-${escapeHtml(winner.id)}"><b>${outcome.ratio ? `${formatRatio(outcome.ratio)}×` : formatWithUnit(outcome.maximum - outcome.minimum, unit)}</b><span>${escapeHtml(word)}</span></p>`;
  const verdict = outcome.tie
    ? `<span class="score-tie">Neither application is ahead here</span>`
    : `<b class="app-${escapeHtml(winner.id)}">${escapeHtml(winner.name)}</b> wins this measurement`;
  const html = `<article class="score-card${outcome.tie ? " is-tie" : ""}"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(context)}</p>${lead}<div class="score-rows">${rows}</div><p class="score-verdict">${verdict}</p></article>`;
  return { html, ratio: outcome.tie ? null : outcome.ratio, title, word, winnerId: winner?.id ?? null };
}

/**
 * Session-switch latency: the four 1 MiB lanes as a table, and the ONE genuine
 * trend in this scenario — latency against transcript size — as a chart.
 */
function renderSessionSwitchComparison(apps, model = {}, { kicker = "Flow 01", record = null } = {}) {
  const statistic = model.primaryStatistic ?? "p95";
  const statisticLabel = statistic.toUpperCase();
  const lanes = [
    ["within-workspace-cold", "Within workspace", "destination never rendered before"],
    ["within-workspace-warm", "Within workspace", "destination already rendered this launch"],
    ["across-workspaces-cold", "Across workspaces", "destination never rendered before"],
    ["across-workspaces-warm", "Across workspaces", "destination already rendered this launch"],
  ];
  const rows = lanes
    .filter(([key]) => apps.some((app) => app.sessionSwitch.derivation.summary[key]))
    .map(([key, flow, context]) => navigationMatrixRow(flow, context, apps, (app) => app.sessionSwitch.derivation.summary[key], statistic, "ms", record))
    .join("");
  const trendSeries = apps.flatMap((app) => [
    {
      label: app.name,
      colorIndex: app.tone,
      points: (app.sessionSwitch.derivation.summary.transcriptSizeTrend ?? []).map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point, statistic) })),
    },
    ...(app.sessionSwitch.derivation.summary.longRowSizeTrend
      ? [{
          label: `${app.name} · long rows`,
          colorIndex: app.tone,
          dashed: true,
          points: app.sessionSwitch.derivation.summary.longRowSizeTrend.map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point, statistic) })),
        }]
      : []),
  ]);
  const hasTrend = trendSeries.some((series) => series.points.filter((point) => Number.isFinite(point.y)).length >= 3);
  const headers = comparisonHeaders(apps, statisticLabel);
  return `<section class="benchmark-section" id="session-switching"><div class="flow-heading"><p class="kicker">${escapeHtml(kicker)}</p><h2>Session switching</h2><p>Clicking between completed sessions in the session list. Each observation measures trusted input → correct transcript painted and input-ready. Warm means the destination surface was rendered earlier in the same launch.</p></div><section class="matrix"><div class="matrix-heading"><h3>Switch latency by lane</h3><p>${escapeHtml(statisticLabel)} in milliseconds · lower is better</p></div><div class="table-scroll"><table><caption>Session-switch ${escapeHtml(statisticLabel)} latency in milliseconds by lane</caption><thead><tr><th scope="col">Lane</th><th scope="col">Condition</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${rows}</tbody></table></div></section>${hasTrend ? chart(`Switch latency by transcript size — ${statistic}`, trendSeries, "Transcript size (MiB)", `${statistic} latency (ms)`) : ""}${unsupportedReasons(apps, "sessionSwitch")}</section>`;
}

function pairedScenarioSection(model, property, title, render, options = {}) {
  const apps = model.apps.filter((app) => app[property]);
  if (apps.length === 0) return "";
  const scenarioId = apps[0][property].scenario.id;
  const compatibility = model.compatibility[scenarioId] ?? { status: "unpaired", reason: `No paired ${title.toLowerCase()} results were supplied.` };
  return compatibility.status === "valid" ? render(apps, model, options) : comparisonUnavailable(title, compatibility, model.apps, property);
}

function renderAppStartP95(apps, record = null) {
  const rows = [
    navigationMatrixRow(
      "Cold app start",
      "first launch, nothing cached on disk",
      apps,
      (app) => app.appStart.derivation.summary["new-application-state"],
      "p95",
      "ms",
      record,
    ),
    navigationMatrixRow(
      "Initialized app start",
      "relaunch, application state already on disk",
      apps,
      (app) => app.appStart.derivation.summary["initialized-application-state"],
      "p95",
      "ms",
      record,
    ),
  ].join("");
  return `<section class="matrix" id="application-start"><div class="matrix-heading"><h3>Application start</h3><p>Process spawn → painted, input-ready application</p></div><div class="table-scroll"><table><caption>Application-start p95 latency in milliseconds</caption><thead><tr><th scope="col">State</th><th scope="col">Starting condition</th>${comparisonHeaders(apps, "P95")}<th scope="col">Relative result</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderMemoryP95(apps, model = {}, record = null) {
  const window = (app, id, metric) => app.resourceWindows?.windows?.[id]?.[metric];
  const inventoryRows = [
    resourceMatrixRow("Memory when idle at the start", "small control session open, app sitting idle", apps, (app) => window(app, "baseline", "rssP95MiB"), "p95", "MiB", record),
    resourceMatrixRow("Memory while working", "switching through sessions from 1 MiB up to 128 MiB", apps, (app) => window(app, "active", "rssP95MiB"), "p95", "MiB", record),
    resourceMatrixRow("Largest single memory sample", "diagnostic only — not an operating-system true peak", apps, (app) => window(app, "active", "rssMaximumMiB"), "maximum", "MiB"),
    resourceMatrixRow("Memory when idle again", "back on the same small control session, idle", apps, (app) => window(app, "ending", "rssP95MiB"), "p95", "MiB", record),
    retainedGrowthRow(apps, record),
    resourceMatrixRow("CPU when idle at the start", "all app processes, sitting idle", apps, (app) => window(app, "baseline", "cpuP95Percent"), "p95", "%", record),
    resourceMatrixRow("CPU while working", "all app processes, during the session workload", apps, (app) => window(app, "active", "cpuP95Percent"), "p95", "%", record),
    resourceMatrixRow("CPU when idle again", "all app processes, back to idle", apps, (app) => window(app, "ending", "cpuP95Percent"), "p95", "%", record),
  ].join("");
  const steps = [...new Set(apps.flatMap((app) => (app.resourceStepTrend ?? []).map((point) => point.transcriptBytes)))].toSorted((left, right) => left - right);
  const stepMetric = (app, bytes, key) => (app.resourceStepTrend ?? []).find((point) => point.transcriptBytes === bytes)?.[key];
  const rssStepRows = steps.map((bytes) => resourceMatrixRow("p95 summed RSS after step", formatBytes(bytes), apps, (app) => stepMetric(app, bytes, "rssMiB"), "p95", "MiB")).join("");
  const cpuStepRows = steps.map((bytes) => resourceMatrixRow("p95 process-family CPU during step", formatBytes(bytes), apps, (app) => stepMetric(app, bytes, "cpuPercent"), "p95", "%")).join("");
  const stepSeries = (key) => apps.map((app) => ({
    label: app.name,
    colorIndex: app.tone,
    points: (app.resourceStepTrend ?? []).map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point[key], "p95") })),
  }));
  const invalid = apps.flatMap((app) => {
    const reasons = new Set();
    if (app.sessionSwitch?.resources?.status !== "valid") reasons.add(app.sessionSwitch?.resources?.reason ?? "the resource monitor did not produce a valid result");
    if (app.resourceWindows?.status !== "valid") reasons.add(app.resourceWindows?.reason ?? "the raw resource trace could not be summarized");
    return [...reasons].map((reason) => `${app.name}: ${reason}`);
  });
  const headers = comparisonHeaders(apps, "P95");
  return `<section class="matrix" id="memory"><div class="matrix-heading"><h3>Memory and CPU under historical-session load</h3><p>Summed application process family · lower is better</p></div>${invalid.length > 0 ? `<p class="status invalid">${escapeHtml(invalid.join("; "))}</p>` : ""}${note("Idle means ready, not empty.", "Both idle windows hold the same fixed 1 MiB control session, fully loaded and visible, with no benchmark input. Sampled maximum is the largest observed framework sample and is diagnostic only; it is not an operating-system true peak. A window that lost the declared process family or recorded no sample stays Invalid with its reason and is never scored as zero.")}<div class="table-scroll"><table><caption>Process-family memory and CPU by measurement window</caption><thead><tr><th scope="col">Metric</th><th scope="col">Measurement window</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${inventoryRows}</tbody></table></div>${chart("p95 summed RSS by historical-session size", stepSeries("rssMiB"), "History size (MiB)", "p95 RSS (MiB)")}${chart("p95 process-family CPU by historical-session size", stepSeries("cpuPercent"), "History size (MiB)", "p95 CPU (%)")}<details class="technical"><summary>Per-step RSS and CPU values</summary><div class="table-scroll"><table><caption>p95 summed process-family RSS after each historical-session step</caption><thead><tr><th scope="col">Metric</th><th scope="col">History step</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${rssStepRows}</tbody></table></div><div class="table-scroll"><table><caption>p95 process-family CPU during each historical-session step</caption><thead><tr><th scope="col">Metric</th><th scope="col">History step</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${cpuStepRows}</tbody></table></div></details>${resourceDisclosureTable(apps)}</section>`;
}

function resourceMatrixRow(flow, context, apps, metricForApp, statistic, unit, record = null) {
  const metrics = apps.map(metricForApp);
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td class="context" data-label="Window">${escapeHtml(context)}</td>${metrics.map((metric, index) => metricCell(metric, statistic, unit, apps[index].name)).join("")}<td class="verdict" data-label="Result">${relativeResult(apps, metrics, statistic, "magnitude", record)}</td></tr>`;
}

function retainedGrowthRow(apps, record = null) {
  const metrics = apps.map((app) => asMetric(app.resourceWindows?.retainedRssGrowthMiB));
  const values = metrics.map((metric) => metricValue(metric, "p95"));
  const verdict = values.every(Number.isFinite) ? signedRelativeResult(apps, values, "MiB", record) : (record?.(null), `<span class="status invalid">Not comparable</span>`);
  return `<tr><th scope="row">Memory never released</th><td class="context" data-label="Window">idle at the end minus idle at the start · negative values stay visible</td>${metrics.map((metric, index) => metricCell(metric, "p95", "MiB", apps[index].name)).join("")}<td class="verdict" data-label="Result">${verdict}</td></tr>`;
}

function resourceDisclosureTable(apps) {
  const row = (label, render) => `<tr><th scope="row">${escapeHtml(label)}</th>${apps.map((app) => `<td>${escapeHtml(render(app))}</td>`).join("")}</tr>`;
  const windows = (app) => app.resourceWindows?.windows;
  const duration = (value) => Number.isFinite(value) ? `${format(value)} ms` : "not recorded";
  const evidence = (app) => app.resourceWindows?.processFamily;
  const environment = (app) => app.environment ?? {};
  const rows = [
    row("Observed sample cadence (median)", (app) => windows(app)
      ? `baseline ${duration(windows(app).baseline.observedSampleIntervalMs)} · active ${duration(windows(app).active.observedSampleIntervalMs)} · ending ${duration(windows(app).ending.observedSampleIntervalMs)}`
      : "no raw trace"),
    row("Observed window duration", (app) => windows(app)
      ? `baseline idle ${duration(windows(app).baseline.observedWindowDurationMs)} · active ${duration(windows(app).active.observedWindowDurationMs)} · ending idle ${duration(windows(app).ending.observedWindowDurationMs)}`
      : "no raw trace"),
    row("Raw samples", (app) => app.resourceWindows
      ? `${app.resourceWindows.rawSampleCount} across ${app.resourceWindows.runCount} monitored run${app.resourceWindows.runCount === 1 ? "" : "s"}`
      : "no raw trace"),
    row("Samples in each window", (app) => windows(app)
      ? `baseline ${windows(app).baseline.sampleCount} · active ${windows(app).active.sampleCount} · ending ${windows(app).ending.sampleCount}`
      : "no raw trace"),
    row("Process family", (app) => evidence(app)
      ? `${evidence(app).definition} Up to ${evidence(app).maximumObservedProcessCount} processes observed${evidence(app).observedProcessNames.length > 0 ? `: ${evidence(app).observedProcessNames.join(", ")}` : ""}.`
      : "no raw trace"),
    row("Missing-process evidence", (app) => evidence(app)
      ? `${evidence(app).samplesMissingRootProcess} samples lost the root process · ${evidence(app).samplesWithInaccessibleProcesses} had inaccessible processes · ${evidence(app).samplesMissingExternalProcesses} missed a declared external process · ${evidence(app).monitorErrorCount} monitor errors`
      : "no raw trace"),
    row("CPU definition", (app) => `${PROCESS_FAMILY_CPU_DEFINITION}. This host reports ${environment(app).logicalCpuCount ?? "an unrecorded number of"} logical CPUs, so a fully saturated host reads ${Number.isFinite(environment(app).logicalCpuCount) ? `${environment(app).logicalCpuCount * 100}%` : "logical CPU count × 100%"}.`),
    row("Host memory pressure", (app) => Number.isFinite(environment(app).memoryPressureLevel)
      ? `level ${environment(app).memoryPressureLevel}`
      : "not recorded by this run"),
    row("Host power state", (app) => `${environment(app).powerSource ?? "not recorded"}${environment(app).lowPowerMode === null || environment(app).lowPowerMode === undefined ? "" : ` · low-power mode ${environment(app).lowPowerMode ? "on" : "off"}`}`),
    row("Host free memory / load at run start", (app) => `${Number.isFinite(environment(app).freeMemoryBytes) ? `${format(environment(app).freeMemoryBytes / 1073741824)} GiB free` : "free memory not recorded"} · ${Number.isFinite(environment(app).loadAverage1mPerCpu) ? `${format(environment(app).loadAverage1mPerCpu)} load per CPU` : "load not recorded"}`),
  ].join("");
  return `<details class="technical"><summary>Resource measurement disclosures</summary><div class="table-scroll"><table><caption>Sampling, process-family, and host disclosures for the resource measurement</caption><thead><tr><th scope="col">Disclosure</th>${apps.map((app) => `<th scope="col">${escapeHtml(app.name)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function renderSessionNavigationComparison(apps, model = {}, { kicker = "Flow 01", record = null } = {}) {
  const statistic = model.primaryStatistic ?? "p95";
  const statisticLabel = statistic.toUpperCase();
  const historySeries = apps.flatMap((app) => {
    const trend = app.sessionNavigation.derivation.summary.historySizeTrend;
    return [
      { label: `${app.name} — first visit`, colorIndex: app.tone, points: trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point.firstVisit, statistic) })) },
      { label: `${app.name} — return to visited session`, colorIndex: app.tone, variant: "return", points: trend.map((point) => ({ x: point.transcriptBytes / 1048576, y: metricValue(point.returnVisitedPanelClosed, statistic) })) },
    ];
  });
  const historyTrend = apps[0]?.sessionNavigation.derivation.summary.historySizeTrend ?? [];
  const sizes = historyTrend.map((point) => point.transcriptBytes);
  const sizeSpan = sizes.length > 0 ? `${sizes[0] / 1048576} MiB through ${sizes.at(-1) / 1048576} MiB` : "every history size";
  // The size-by-size breakdown is the chart's job. The table answers the flat
  // question — across every session this run touched, what is the p95?
  const historyRows = [
    navigationMatrixRow("First visit", `every session pooled · ${sizeSpan}`, apps, (app) => pooledLatency(app.sessionNavigation, (item) => item.trend === "history-size" && item.navigationType === "first-visit"), statistic, "ms", record),
    navigationMatrixRow("Return to visited session", `every session pooled · ${sizeSpan}`, apps, (app) => pooledLatency(app.sessionNavigation, (item) => item.trend === "history-size" && item.navigationType === "return-visited-panel-closed"), statistic, "ms", record),
  ].join("");
  const panelTrend = apps[0]?.sessionNavigation.derivation.summary.panelLoadTrend ?? [];
  const panelRows = panelTrend.map((point, index) => navigationMatrixRow(
    "Return with panel open",
    point.loadProfile,
    apps,
    (app) => app.sessionNavigation.derivation.summary.panelLoadTrend[index]?.returnVisitedPanelOpen.durationMs,
    statistic,
    "ms",
    record,
  )).join("");
  const headers = comparisonHeaders(apps, statisticLabel);
  const rendererRows = apps.flatMap((app) => app.sessionNavigation.derivation.summary.panelLoadTrend.map((point) => rendererWorkRow(
    app,
    `Return with panel open · ${point.loadProfile}`,
    point.returnVisitedPanelOpen,
    statistic,
  ))).join("");
  return `<section class="benchmark-section" id="session-navigation"><div class="flow-heading"><p class="kicker">${escapeHtml(kicker)}</p><h2>Session navigation</h2><p>First visit means a session surface has not been mounted before. Return means revisiting a previously rendered session with the workspace panel closed. Panel-open returns are isolated as a separate seeded-load trend.</p></div>${note(`${statisticLabel} shown.`, "Nearest-rank p95 is reported at every repetition count, with valid / attempted counts attached to each value. Where a value has fewer than 20 valid observations its nearest-rank p95 is the sampled maximum of those observations and says so; p50, average, and maximum stay in the diagnostic drill-down.")}<section class="matrix"><div class="matrix-heading"><h3>Navigation latency across every session</h3><p>${escapeHtml(statisticLabel)} over all pooled observations · lower is better</p></div><div class="table-scroll"><table><caption>Session navigation ${statisticLabel} latency in milliseconds by history size</caption><thead><tr><th scope="col">Visit state</th><th scope="col">History</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${historyRows}</tbody></table></div></section>${chart(`First visit and return by history size — ${statistic}`, historySeries, "History size (MiB)", `${statistic} latency (ms)`)}<section class="matrix"><div class="matrix-heading"><h3>Return with workspace panel open</h3><p>The panel begins open with light, moderate, or heavy seeded content.</p></div><div class="table-scroll"><table><caption>Panel-open session return ${statisticLabel} latency in milliseconds</caption><thead><tr><th scope="col">Visit state</th><th scope="col">Seeded load</th>${headers}<th scope="col">Relative result</th></tr></thead><tbody>${panelRows}</tbody></table></div></section>${unsupportedReasons(apps, "sessionNavigation")}<details class="technical"><summary>Renderer work for panel-open returns</summary><p>Durations use ${statisticLabel}; renderer counters and worst frames show their declared aggregate from the same observations.</p><div class="table-scroll"><table class="wide"><caption>Panel-open renderer work</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">Duration</th><th scope="col">JavaScript</th><th scope="col">Style</th><th scope="col">Layout</th><th scope="col">Worst frame</th></tr></thead><tbody>${rendererRows}</tbody></table></div></details></section>`;
}

function renderWorkspacePanelComparison(apps, model = {}, { kicker = "Flow 02", record = null } = {}) {
  const statistic = model.primaryStatistic ?? "p95";
  const statisticLabel = statistic.toUpperCase();
  const frameStatistic = "p95";
  const actions = apps[0]?.workspacePanel?.derivation.summary.loadTrend[0]?.interactions
    ? Object.keys(apps[0].workspacePanel.derivation.summary.loadTrend[0].interactions)
    : [];
  const loadTrend = apps[0]?.workspacePanel?.derivation.summary.loadTrend ?? [];
  const rows = loadTrend.flatMap((point, loadIndex) =>
    actions.map((action) => workspaceInteractionRow(apps, loadIndex, action, point.loadProfile, statistic, frameStatistic, record)),
  ).join("");
  // One latency column per app keeps the winner readable at a glance; the
  // 60 Hz frame verdict stays in the Result cell, and the raw frame numbers
  // live in the technical drill-down below. Three categorical load profiles
  // are not a trend, so they get no chart.
  const matrix = `<section class="matrix"><div class="matrix-heading"><h3>All workspace interactions</h3><p>${escapeHtml(statisticLabel)} latency in milliseconds · frame verdict inline</p></div><div class="table-scroll"><table><caption>Workspace interaction responsiveness across retained load</caption><thead><tr><th scope="col">Action</th><th scope="col">Load / presentation</th>${comparisonHeaders(apps, statisticLabel)}<th scope="col">Result</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  const rendererRows = apps.flatMap((app) => app.workspacePanel.derivation.summary.loadTrend.flatMap((point) => Object.entries(point.interactions).map(([action, metric]) => rendererWorkRow(
    app,
    `${workspaceActionLabel(action)} · ${point.loadProfile}`,
    metric,
    statistic,
  )))).join("");
  return `<section class="benchmark-section" id="workspace-panel"><div class="flow-heading"><p class="kicker">${escapeHtml(kicker)}</p><h2>Workspace panel</h2><p>Every interaction answers two user-facing questions: how quickly did the requested surface respond or become usable, and did rendering remain inside the 16.67 ms frame budget? Light, moderate, and heavy vary retained directory and file-tab state while keeping the same complete 24-file Review model.</p></div>${note("Animation is presentation, not speed.", "Open and close keep each product&#39;s production behavior. Their intentional animation duration is not used to name a latency winner; only trusted-input response and p95 frame health are scored. Other actions compare interactive completion and the same 60 Hz evidence. Setup does not scroll Review.")}${note("Data-warm, surface-cold file opening.", "Each load profile owns a distinct canonical target whose bytes are warm but whose tab and preview have never mounted. The measured input owns first surface creation and paint.")}${matrix}${unsupportedReasons(apps, "workspacePanel")}<details class="technical"><summary>Renderer work and frame measurements</summary><p>Durations and renderer work use ${statisticLabel}; frame columns use P95 from the same observations. Total open/close duration remains available here as diagnostic context only.</p><div class="table-scroll"><table class="wide"><caption>Workspace-panel renderer work</caption><thead><tr><th scope="col">Flow</th><th scope="col">Application</th><th scope="col">Duration</th><th scope="col">JavaScript</th><th scope="col">Style</th><th scope="col">Layout</th><th scope="col">Frame interval</th></tr></thead><tbody>${rendererRows}</tbody></table></div></details></section>`;
}

function workspaceInteractionRow(apps, loadIndex, action, loadProfile, statistic, frameStatistic, record = null) {
  const interactions = apps.map((app) => app.workspacePanel.derivation.summary.loadTrend[loadIndex]?.interactions[action]);
  const cells = interactions.map((interaction, index) => workspaceInteractionCells(interaction, action, statistic, frameStatistic, apps[index].name)).join("");
  return `<tr><th scope="row">${escapeHtml(workspaceActionLabel(action))}</th><td class="context" data-label="Load">${escapeHtml(workspacePresentationContext(apps, loadIndex, action, loadProfile))}</td>${cells}<td class="verdict" data-label="Result">${workspaceInteractionResult(apps, interactions, action, statistic, frameStatistic, record)}</td></tr>`;
}

function workspaceInteractionCells(interaction, action, statistic, frameStatistic, appName) {
  const response = action === "open-panel"
    ? interaction?.milestones?.inputToShellMs
    : action === "close-panel"
      ? interaction?.milestones?.inputToActionPaintMs
      : interaction?.durationMs;
  const responseLabel = action === "open-panel" ? "input → shell" : action === "close-panel" ? "input → closed paint · not ranked" : "interactive completion";
  return workspaceMetricCell(response, statistic, "ms", responseLabel, appName);
}

function workspaceMetricCell(metric, statistic, unit, label, appName) {
  const value = metricValue(metric, statistic);
  if (!Number.isFinite(value)) return `<td class="metric status invalid" data-label="${escapeHtml(appName)}"><strong>Withheld</strong><small>${metric?.valid ?? 0} / ${metric?.attempted ?? 0} · ${escapeHtml(label)}</small></td>`;
  return `<td class="metric" data-label="${escapeHtml(appName)}"><strong>${formatWithUnit(value, unit)}</strong><small>${metric.valid} / ${metric.attempted} · ${escapeHtml(label)}${escapeHtml(sampledMaximumNote(metric, statistic))}</small></td>`;
}

function workspaceInteractionResult(apps, interactions, action, statistic, frameStatistic, record = null) {
  const frameValues = interactions.map((interaction) => metricValue(interaction?.frames?.p95IntervalMs, frameStatistic));
  const overBudgetValues = interactions.map((interaction) => metricValue(interaction?.frames?.overBudgetIntervalCount, frameStatistic));
  if (![...frameValues, ...overBudgetValues].every(Number.isFinite)) {
    record?.(null);
    return `<span class="status invalid">Not comparable</span>`;
  }
  const held = frameValues.map((value, index) => value <= 16.667 && overBudgetValues[index] === 0);
  const frameResult = held.every(Boolean)
    ? "Both held 60 Hz"
    : held.some(Boolean)
      ? `${apps[held.findIndex(Boolean)].name} held 60 Hz`
      : "Both exceeded 60 Hz budget";
  if (held.some(Boolean) && !held.every(Boolean)) record?.(apps[held.findIndex(Boolean)].id);
  if (action === "open-panel" || action === "close-panel") return `<strong>${escapeHtml(frameResult)}</strong><small>animation length not scored</small>`;
  const durations = interactions.map((interaction) => interaction?.durationMs);
  const latency = relativeResult(apps, durations, statistic, "latency", record);
  return `${latency}<small>${escapeHtml(frameResult)}</small>`;
}

function workspacePresentationContext(apps, loadIndex, action, loadProfile) {
  if (action !== "open-panel" && action !== "close-panel") return loadProfile;
  const modes = apps.map((app) => {
    const transitionModes = app.workspacePanel.derivation.summary.loadTrend[loadIndex]?.interactions[action]?.transitionModes;
    const animated = transitionModes?.animated ?? 0;
    const none = transitionModes?.none ?? 0;
    const mode = animated === none ? "mixed" : animated > none ? "animated" : "no animation";
    return `${app.name}: ${mode}`;
  });
  return `${loadProfile} · ${modes.join("; ")}`;
}

function comparisonHeaders(apps, statisticLabel) {
  return apps.map((app) => `<th scope="col"><span class="app-key">${appMark(app)}${escapeHtml(app.name)}</span><small>${escapeHtml(statisticLabel)} · valid / attempted</small></th>`).join("");
}

function navigationMatrixRow(flow, context, apps, metricForApp, statistic, unit = "ms", record = null) {
  const metrics = apps.map(metricForApp);
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td class="context" data-label="Condition">${escapeHtml(context)}</td>${metrics.map((metric, index) => metricCell(metric, statistic, unit, apps[index].name)).join("")}<td class="verdict" data-label="Result">${relativeResult(apps, metrics, statistic, "latency", record)}</td></tr>`;
}

function metricCell(metric, statistic, unit = "ms", appName = "") {
  const labelAttribute = appName ? ` data-label="${escapeHtml(appName)}"` : "";
  const value = metricValue(metric, statistic);
  if (!Number.isFinite(value)) {
    const label = metric?.status === "invalid" ? "Invalid" : "Withheld";
    const reason = metric?.reason ? ` · ${metric.reason}` : "";
    return `<td class="metric status invalid"${labelAttribute}><strong>${label}</strong><small>${metric?.valid ?? 0} / ${metric?.attempted ?? 0}${escapeHtml(reason)}</small></td>`;
  }
  return `<td class="metric"${labelAttribute}><strong>${formatWithUnit(value, unit)}</strong><small>${metric.valid} / ${metric.attempted}${escapeHtml(sampledMaximumNote(metric, statistic))}</small></td>`;
}

function formatWithUnit(value, unit) {
  if (!unit) return format(value);
  return unit === "%" ? `${format(value)}%` : `${format(value)} ${escapeHtml(unit)}`;
}

function metricValue(metric, statistic) {
  if (!metric || metric.status !== "valid") return null;
  return Number.isFinite(metric[statistic]) ? metric[statistic] : null;
}

// Nearest-rank p95 is reported at any n. Below the threshold the selected rank is the last one, so
// the value is disclosed as the sampled maximum instead of being withheld or renamed.
function sampledMaximumNote(metric, statistic) {
  return statistic === "p95" && metric?.status === "valid" && p95EqualsSampledMaximum(metric.valid) ? " · p95 = sampled max" : "";
}

// Works for any number of apps: the strict minimum wins, the ratio is quoted
// against the best remaining value, and the optional recorder feeds the
// page-level win tally.
function relativeResult(apps, metrics, statistic, comparison = "latency", record = null) {
  const values = metrics.map((metric) => metricValue(metric, statistic));
  const outcome = compareValues(values);
  if (!outcome) {
    record?.(null);
    return `<span class="status invalid">Not comparable</span>`;
  }
  if (outcome.tie) {
    record?.("tie");
    return "Tie";
  }
  const word = comparison === "latency" ? "faster" : "lower";
  record?.(apps[outcome.winnerIndex].id);
  if (outcome.ratio === null) {
    return `<strong>${escapeHtml(apps[outcome.winnerIndex].name)}</strong><small>${format(outcome.maximum - outcome.minimum)} ${word}</small>`;
  }
  const percent = Math.round((1 - outcome.minimum / outcome.runnerUp) * 1000) / 10;
  return `<strong>${escapeHtml(apps[outcome.winnerIndex].name)}</strong><small>${formatRatio(outcome.ratio)}× ${word} · ${format(percent)}% ${word}</small>`;
}

function signedRelativeResult(apps, values, unit, record = null) {
  const outcome = compareValues(values);
  if (!outcome) {
    record?.(null);
    return `<span class="status invalid">Not comparable</span>`;
  }
  if (outcome.tie) {
    record?.("tie");
    return "Tie";
  }
  record?.(apps[outcome.winnerIndex].id);
  return `<strong>${escapeHtml(apps[outcome.winnerIndex].name)}</strong><small>${formatWithUnit(outcome.maximum - outcome.minimum, unit)} lower</small>`;
}

function rendererWorkRow(app, flow, metric, statistic) {
  return `<tr><th scope="row">${escapeHtml(flow)}</th><td>${escapeHtml(app.name)}</td>${technicalMetricCell(metric?.durationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.scriptDurationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.styleRecalcDurationMs, statistic)}${technicalMetricCell(metric?.rendererWork?.layoutDurationMs, statistic)}${technicalMetricCell(metric?.frames?.worstIntervalMs, statistic)}</tr>`;
}

function technicalMetricCell(metric, statistic) {
  const value = metricValue(metric, statistic);
  return `<td class="${Number.isFinite(value) ? "" : "status invalid"}">${Number.isFinite(value) ? `${format(value)} ms` : "—"}</td>`;
}

function unsupportedReasons(apps, property) {
  const rows = apps.flatMap((app) => {
    const scenarioId = app[property]?.scenario.id;
    return (app.invalidReasons?.[scenarioId] ?? []).map((reason) => `<li><strong>${escapeHtml(app.name)}</strong><code>${escapeHtml(reason)}</code></li>`);
  });
  if (rows.length === 0) return "";
  return `<aside class="unsupported" aria-labelledby="${escapeHtml(property)}-unsupported"><p class="kicker">Unsupported is not zero</p><h3 id="${escapeHtml(property)}-unsupported">Product-contract exclusions</h3><p>These observations are excluded from ratios and winner statements. The benchmark recorded the exact driver reason:</p><ul>${rows.join("")}</ul></aside>`;
}

function formatRatio(value) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function shortRevision(revision) {
  return revision?.length > 12 ? revision.slice(0, 12) : revision;
}

function formatMemory(bytes) {
  return Number.isFinite(bytes) ? `${format(bytes / 1073741824)} GiB` : "unknown";
}

function workspaceActionLabel(action) {
  return action.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function comparisonUnavailable(title, compatibility, apps, property) {
  const rows = apps.map((app) => `<tr><th scope="row"><a href="apps/${escapeHtml(app.id)}/index.html">${escapeHtml(app.name)}</a></th><td>${app[property] ? "Available as an individual result" : "No result supplied"}</td></tr>`).join("");
  return `<section class="panel"><h2>${escapeHtml(title)}</h2><p class="status invalid"><strong>${escapeHtml(compatibility.status)}:</strong> ${escapeHtml(compatibility.reason)}</p><div class="table-scroll"><table><caption>Individual result availability</caption><thead><tr><th scope="col">Application</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function formatBytes(bytes) {
  return Number.isFinite(bytes) && bytes % 1048576 === 0 ? `${bytes / 1048576} MiB (${bytes} bytes)` : `${bytes} bytes`;
}

async function replaceGeneratedDirectory(output, temporary) {
  let exists = false;
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Site output must be a real directory.");
    exists = true;
    const marker = await lstat(path.join(output, MARKER));
    if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Refusing to replace a directory not generated by this benchmark.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    if (exists) throw new Error("Refusing to replace a directory not generated by this benchmark.");
  }
  if (!exists) {
    await rename(temporary, output);
    return;
  }
  const backup = `${output}.previous-${process.pid}`;
  await rename(output, backup);
  try {
    await rename(temporary, output);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rename(backup, output);
    throw error;
  }
}


/* ---------------------------------------------------------------------------
 * Stylesheet
 *
 * The palette is Claxedo's own semantic token set, lifted verbatim from the
 * shipping app so the report reads as part of the same product: a #101010 base,
 * surfaces and borders expressed as alpha-white over that base, four text
 * weights, and the apricot brand accent.
 *
 * The sheet is generated rather than static because the report's CSP forbids
 * inline styles, so anything data-dependent — per-application identity colours
 * and the scorecard bar widths — has to exist as a class here.
 * ------------------------------------------------------------------------- */

// Accent ramp drawn from Claxedo's own hue scales (brand, info, cobalt, apple,
// yuzu, ember). Applications take these in registration order, so the app whose
// design system this is keeps the brand apricot.
const ACCENTS = [
  { dark: "#fab283", light: "#a5622a" },
  { dark: "#edb2f1", light: "#9c3a9e" },
  { dark: "#89b5ff", light: "#1251ec" },
  { dark: "#5fc9ab", light: "#0e7a5f" },
  { dark: "#dbdda0", light: "#7c7c2c" },
  { dark: "#fc9a3a", light: "#a8571b" },
  { dark: "#cf87dd", light: "#8b3fa0" },
  { dark: "#8ec2fc", light: "#2b6aa8" },
];

function renderStylesheet(apps = []) {
  const accentVariables = (mode) => ACCENTS.map((accent, index) => `--acc-${index}:${accent[mode]}`).join(";");
  const appAccents = apps.map((app, index) => `.app-${app.id}{--accent:var(--acc-${index % 8})}`).join("");
  const seriesColors = ACCENTS.map((_, index) => `.series-${index} polyline,.series-${index} circle{stroke:var(--acc-${index})}.series-${index} .stop-top{stop-color:var(--acc-${index});stop-opacity:.22}.series-${index} .stop-bottom{stop-color:var(--acc-${index});stop-opacity:0}.swatch.series-${index}{background:var(--acc-${index});color:var(--acc-${index})}.end-label.series-${index}{fill:var(--acc-${index})}`).join("");
  // Scorecard bars are data-driven widths; CSP rules out a style attribute.
  const barWidths = Array.from({ length: 101 }, (_, percent) => `.bar-${percent}{width:${percent}%}`).join("");

  return `:root{color-scheme:dark;${accentVariables("dark")};--background-base:#101010;--background-weak:#1e1e1e;--background-strong:#121212;--surface-base:#ffffff08;--surface-raised:#ffffff0f;--surface-raised-hover:#ffffff14;--surface-float:#161616;--text-strong:#ffffffef;--text-base:#ffffff9e;--text-weak:#ffffff6c;--text-weaker:#ffffff48;--border-base:#ffffff32;--border-weak:#282828;--border-weaker:#202020;--brand:#fab283;--interactive:#9dbefe;--critical:#fc533a;--critical-surface:#1f0603;--critical-border:#6a1206;--radius-sm:.25rem;--radius-md:.375rem;--radius-lg:.5rem;--radius-xl:.625rem;--radius-2xl:.875rem;--sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-family:var(--sans);color:var(--text-base);background:var(--background-base);font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:light){:root{color-scheme:light;${accentVariables("light")};--background-base:#f8f8f8;--background-weak:#f3f3f3;--background-strong:#fcfcfc;--surface-base:#00000008;--surface-raised:#ffffff;--surface-raised-hover:#0000000d;--surface-float:#ffffff;--text-strong:#171717;--text-base:#4f4f4f;--text-weak:#8f8f8f;--text-weaker:#adadad;--border-base:#00000029;--border-weak:#e5e5e5;--border-weaker:#f0f0f0;--brand:#a5622a;--interactive:#1251ec;--critical:#b72d1a;--critical-surface:#fdf1ef;--critical-border:#f0cdc7}}
*{box-sizing:border-box}
html,body{max-width:100%}html{scroll-behavior:smooth;scroll-padding-top:104px}body{margin:0;line-height:1.6;background:var(--background-base);font-size:15px}
.shell{width:min(1080px,calc(100% - clamp(20px,5vw,48px)));margin-inline:auto}
h1,h2,h3{color:var(--text-strong)}
a{color:var(--interactive);text-underline-offset:3px}
:focus-visible{outline:2px solid var(--interactive);outline-offset:3px;border-radius:var(--radius-sm)}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--surface-float);padding:10px;z-index:9}

.masthead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;padding:16px 0;max-width:100%}
.brand{font-weight:620;letter-spacing:-.01em;color:var(--text-strong);text-decoration:none;display:flex;align-items:center;gap:10px;font-size:.92rem}
.brand-mark{width:14px;height:14px;border-radius:var(--radius-sm);background:var(--brand);flex:none}
.version{font-family:var(--mono);font-size:.66rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--text-weak);border:1px solid var(--border-weak);border-radius:99px;padding:4px 10px}
.eyebrow,.kicker{font-family:var(--mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:var(--text-weaker);margin:0}

.section-nav{position:sticky;top:0;z-index:5;display:flex;gap:2px;overflow-x:auto;max-width:100%;margin:0 0 4px;padding:10px 0;border-bottom:1px solid var(--border-weaker);background:color-mix(in srgb,var(--background-base) 88%,transparent);backdrop-filter:blur(12px);scrollbar-width:none}
.section-nav::-webkit-scrollbar{display:none}
.section-nav a{padding:6px 12px;border-radius:var(--radius-lg);color:var(--text-weak);font-size:.82rem;font-weight:520;text-decoration:none;white-space:nowrap}
.section-nav a:hover,.section-nav a:focus-visible{color:var(--text-strong);background:var(--surface-raised)}

.hero{padding:clamp(40px,7vw,84px) 0 8px}.hero.compact{padding:36px 0 8px}
.hero h1{font-size:clamp(2rem,5.4vw,3.5rem);line-height:1.04;letter-spacing:-.035em;font-weight:640;margin:.34em 0 .3em;max-width:20ch;text-wrap:balance}
.hero>p:not(.eyebrow){max-width:64ch;font-size:1rem;color:var(--text-weak);margin:0}
.hero-app{display:flex;align-items:center;gap:20px}.hero-app h1{margin:0 0 .12em;font-size:clamp(1.8rem,4.6vw,2.9rem)}.hero-app p{margin:0;color:var(--text-weak);font-size:.92rem}
.hero-logo{width:64px;height:64px;border-radius:var(--radius-2xl);object-fit:contain;background:var(--surface-raised);border:1px solid var(--border-weaker);padding:7px;flex:none}
.run-stamp{display:flex;flex-wrap:wrap;gap:6px;margin-top:30px}
.run-stamp span{font-family:var(--mono);padding:6px 12px;border:1px solid var(--border-weaker);border-radius:99px;background:var(--surface-base);color:var(--text-weak);font-size:.74rem}
.run-stamp b{color:var(--text-strong);font-weight:600}

.flow-heading{margin:0 0 26px}
.flow-heading h2{font-size:clamp(1.55rem,3.4vw,2.4rem);line-height:1.08;letter-spacing:-.03em;font-weight:620;margin:.22em 0 0;text-wrap:balance}
.flow-heading>p:last-child{margin:.7em 0 0;color:var(--text-weak);max-width:68ch;font-size:.92rem}

.verdict{padding:38px 0 12px}
.verdict-banner{border:1px solid color-mix(in srgb,var(--accent) 34%,var(--border-weak));border-radius:var(--radius-2xl);padding:26px 28px;background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 9%,var(--surface-base)),var(--surface-base) 62%);margin:0 0 46px}
.verdict-head{display:flex;align-items:center;gap:16px}
.verdict-mark{display:flex;flex:none}
.verdict-mark .app-logo,.verdict-mark .app-mono{width:52px;height:52px;border-radius:var(--radius-xl)}
.verdict-head h2{margin:.1em 0 0;font-size:clamp(1.7rem,4vw,2.7rem);letter-spacing:-.035em;font-weight:640;line-height:1}
.verdict-head h2 b{color:var(--accent);font-weight:640}
.verdict-stats{display:flex;flex-wrap:wrap;gap:16px 44px;margin:26px 0 22px;padding:22px 0;border-top:1px solid var(--border-weaker);border-bottom:1px solid var(--border-weaker)}
.verdict-stat b{display:block;font-family:var(--mono);font-size:clamp(2rem,5.2vw,3rem);font-weight:560;letter-spacing:-.05em;line-height:1;color:var(--accent)}
.verdict-stat b small{font-size:.42em;color:var(--text-weaker);letter-spacing:-.02em}
.verdict-stat span{display:block;margin-top:8px;color:var(--text-weak);font-size:.78rem}
.verdict-bars{display:grid;gap:10px}
.verdict-bar{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr) auto;align-items:center;gap:14px}
.verdict-bar-name{display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--text-weak);min-width:0}
.verdict-bar.win .verdict-bar-name{color:var(--text-strong);font-weight:600}
.verdict-track{display:block;height:10px;border-radius:99px;background:var(--border-weaker);overflow:hidden}
.verdict-track i{display:block;height:100%;border-radius:99px;background:var(--accent);opacity:.4}
.verdict-bar.win .verdict-track i{opacity:1}
.verdict-bar-count{font-family:var(--mono);font-size:1rem;color:var(--text-weak);min-width:2ch;text-align:right}
.verdict-bar.win .verdict-bar-count{color:var(--accent);font-weight:600}
.score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(290px,100%),1fr));gap:12px;margin:12px 0 0}
.score-card{background:var(--surface-base);border:1px solid var(--border-weaker);border-radius:var(--radius-2xl);padding:20px 22px 16px;display:flex;flex-direction:column}
.score-card h3{margin:0;font-size:.92rem;font-weight:620;letter-spacing:-.01em}
.score-card>p{margin:5px 0 0;color:var(--text-weaker);font-size:.75rem;line-height:1.45}
.score-lead{display:flex;align-items:baseline;gap:9px;margin:18px 0 14px}
.score-lead b{font-family:var(--mono);font-size:2.6rem;font-weight:560;letter-spacing:-.05em;line-height:1;color:var(--accent)}
.score-lead span{font-size:.9rem;font-weight:600;color:var(--text-base)}
.score-lead.tie b{color:var(--text-weak);font-size:1.9rem}
.score-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 14px;padding:10px 0 8px;border-top:1px solid var(--border-weaker)}
.score-name{display:flex;align-items:center;gap:8px;font-size:.85rem;font-weight:560;color:var(--text-weak);min-width:0}
.score-value{font-family:var(--mono);font-size:1.12rem;font-weight:560;letter-spacing:-.025em;color:var(--text-weak);white-space:nowrap;text-align:right}
.score-row.win .score-name{color:var(--text-strong)}
.score-row.win .score-value{color:var(--accent)}
.score-bar{display:block;height:7px;border-radius:99px;background:var(--border-weaker);overflow:hidden}
.score-bar i{display:block;height:100%;border-radius:99px;background:var(--accent);opacity:.4}
.score-row.win .score-bar i{opacity:1}
.score-count{font-family:var(--mono);font-size:.63rem;color:var(--text-weaker);text-align:right;letter-spacing:.02em}
.score-verdict{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--border-weaker);font-size:.76rem;color:var(--text-weaker)}
.score-verdict b{color:var(--accent);font-weight:620}
.score-tie{color:var(--text-weaker)}
${appAccents}
.app-logo{width:20px;height:20px;border-radius:var(--radius-sm);object-fit:contain;flex:none}
.app-mono{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--radius-sm);background:var(--accent,var(--brand));color:var(--background-base);font-size:.66rem;font-weight:700;flex:none}
.hero-mono{width:64px;height:64px;border-radius:var(--radius-2xl);font-size:1.7rem}

.benchmark-section{padding:52px 0 0;border-top:1px solid var(--border-weaker);margin-top:52px}
.matrix,.panel,.chart{margin:26px 0}
.matrix-heading{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 20px;padding-bottom:10px}
.matrix-heading h3,.panel h3,.chart h3{margin:0;font-size:.94rem;font-weight:600;letter-spacing:-.01em}
.matrix-heading p{margin:0;color:var(--text-weaker);font-size:.76rem;font-family:var(--mono)}

.table-scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;width:100%;min-width:660px;font-size:.88rem}table.wide{min-width:820px}
caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
th,td{padding:12px 14px;border-bottom:1px solid var(--border-weaker);text-align:right;vertical-align:top}
thead th{font-family:var(--mono);font-size:.63rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--text-weaker);border-bottom:1px solid var(--border-weak);padding-bottom:9px}
th:first-child,td:first-child{text-align:left}
tbody th{font-weight:560;text-align:left;color:var(--text-strong)}
tbody tr:hover{background:var(--surface-base)}
.context{color:var(--text-weak);text-align:left;max-width:250px;font-size:.8rem}
.metric{min-width:132px}
td.verdict{min-width:168px}
tbody th{min-width:112px}
.metric strong,td.verdict strong{display:block;white-space:nowrap;font-family:var(--mono);font-size:1rem;font-weight:560;letter-spacing:-.02em;color:var(--text-strong)}
td.verdict strong{font-family:var(--sans);font-size:.88rem;font-weight:600;white-space:normal}
.metric small,td.verdict small,th small{display:block;margin-top:3px;color:var(--text-weaker);font-size:.66rem;font-weight:400;text-transform:none;letter-spacing:.01em;font-family:var(--mono);line-height:1.4}
.app-key{white-space:nowrap;display:inline-flex;align-items:center;gap:7px;font-family:var(--sans);font-size:.8rem;font-weight:600;color:var(--text-strong);text-transform:none;letter-spacing:0}
.status.invalid{color:var(--critical)}
.metric.status.invalid strong{color:var(--critical)}

.unsupported{margin:28px 0;padding:16px 18px;background:var(--critical-surface);border:1px solid var(--critical-border);border-radius:var(--radius-xl)}
.unsupported h3{margin:.3em 0 .4em;font-size:.92rem}
.unsupported .kicker{color:var(--critical)}
.unsupported>p:not(.kicker){color:var(--text-base);font-size:.85rem;margin:0}
.unsupported ul{padding-left:18px;margin:.7em 0 0;font-size:.85rem}
.unsupported li+li{margin-top:10px}
.unsupported code{display:block;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.72rem;color:var(--text-weak)}

details{margin:18px 0}
details summary{cursor:pointer;color:var(--text-weak);font-size:.8rem;padding:8px 0;list-style:none;display:flex;align-items:center;gap:8px}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"+";font-family:var(--mono);color:var(--text-weaker);font-size:.9rem;width:12px;flex:none}
details[open]>summary::before{content:"–"}
details summary:hover{color:var(--text-strong)}
.note{border-left:1px solid var(--border-weak);padding-left:14px;margin:16px 0}
.note summary{font-weight:560;color:var(--text-base)}
.note>p{margin:2px 0 8px;color:var(--text-weak);font-size:.85rem;max-width:74ch}
.quiet{border-top:1px solid var(--border-weaker);padding-top:2px}
.quiet>p{color:var(--text-weak);font-size:.85rem}

.chart{padding:8px 0 4px}
.chart-heading{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin-bottom:6px}
.chart-heading p{margin:0;font-family:var(--mono);font-size:.7rem;color:var(--text-weaker)}
.axis-note{font-family:var(--mono);font-size:.63rem;text-transform:uppercase;letter-spacing:.09em;color:var(--text-weaker);border:1px solid var(--border-weaker);border-radius:99px;padding:2px 8px}
.chart svg{width:100%;height:auto;display:block;margin-top:6px}
.axis{stroke:var(--border-weak);stroke-width:1}
.grid{stroke:var(--border-weaker);stroke-width:1}
.chart text{fill:var(--text-weaker);font-size:11px;font-family:var(--mono);text-anchor:middle}
.chart text.tick-y{text-anchor:end}
.chart text.axis-title{fill:var(--text-weaker);font-size:11px;font-family:var(--sans);letter-spacing:.02em}
.chart text.end-label{text-anchor:start;font-size:11.5px;font-weight:600}
.series polyline{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.series circle{fill:var(--background-base);stroke-width:2}
.series .area{stroke:none}
.series-return polyline{stroke-dasharray:5 4;stroke-width:1.75}
.series-return .area{display:none}
.series-return circle{fill:var(--background-weak)}
${seriesColors}
.legend{display:flex;gap:6px 18px;flex-wrap:wrap;list-style:none;padding:0;margin:12px 0 0;font-size:.76rem;color:var(--text-weak)}
.swatch{display:inline-block;width:16px;height:2px;vertical-align:middle;margin-right:8px;background:var(--border-base);border-radius:2px}
.swatch.series-return{height:0;border-top:2px dashed currentColor;background:none!important}

.app-section{padding:52px 0 0;border-top:1px solid var(--border-weaker);margin-top:52px}
.app-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:10px;margin:14px 0 0}
.app-card{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:2px 12px;padding:14px 16px;color:inherit;text-decoration:none;border:1px solid var(--border-weaker);border-radius:var(--radius-xl);background:var(--surface-base)}
.app-card:hover,.app-card:focus-visible{background:var(--surface-raised-hover);border-color:var(--accent,var(--border-base))}
.app-card .app-logo,.app-card .app-mono{grid-column:1;grid-row:1/3;width:32px;height:32px;border-radius:var(--radius-md);align-self:center}
.app-card .app-mono{font-size:.86rem}
.app-card-name{grid-column:2;grid-row:1;justify-self:start;font-size:.94rem;font-weight:600;color:var(--text-strong)}
.app-card small{grid-column:2;grid-row:2;justify-self:start;color:var(--text-weaker);font-size:.7rem;font-family:var(--mono)}
.app-card-go{grid-column:3;grid-row:1/3;align-self:center;color:var(--text-weaker);font-size:1rem}
.app-card:hover .app-card-go{color:var(--accent)}

.method{padding:52px 0 0;border-top:1px solid var(--border-weaker);margin-top:52px}
.method-summary,.compact-list{margin:0}
.method-summary div,.compact-list div{display:grid;grid-template-columns:1fr;gap:3px;padding:12px 0;border-bottom:1px solid var(--border-weaker)}
dt{color:var(--text-weaker);font-family:var(--mono);font-size:.66rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em}
dd{margin:0;overflow-wrap:anywhere;font-size:.87rem;color:var(--text-base)}
@media(min-width:720px){.method-summary div,.compact-list div{grid-template-columns:170px 1fr;gap:20px}}
.scope{margin:24px 0 0;padding:14px 16px;border:1px solid var(--border-weaker);border-radius:var(--radius-xl);background:var(--surface-base);font-size:.83rem;color:var(--text-weak);max-width:78ch}
.scope strong{color:var(--text-base)}
.schedule,code{font-family:var(--mono)}
.schedule{font-size:.74rem;line-height:1.9;overflow-wrap:anywhere;color:var(--text-weak);margin:0 0 8px}
.disclosures{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:1px;background:var(--border-weaker);border:1px solid var(--border-weaker);border-radius:var(--radius-xl);overflow:hidden;margin:26px 0}
.disclosures div{padding:14px 16px;background:var(--background-base)}
.disclosures dd{margin:5px 0 0;font-weight:560;color:var(--text-strong)}
.panel{padding:8px 0}.panel>p{color:var(--text-weak)}.panel h2{font-size:1.05rem;margin:0 0 .4em}
footer{padding:56px 0 44px;margin-top:52px;border-top:1px solid var(--border-weaker);color:var(--text-weaker);font-size:.74rem;font-family:var(--mono)}
.masthead-nav{display:flex;align-items:center;gap:14px}
.masthead-nav a{color:var(--text-weak);font-size:.82rem;text-decoration:none;font-weight:520}
.masthead-nav a:hover{color:var(--text-strong)}
.hero-actions{display:flex;flex-wrap:wrap;gap:10px;margin:30px 0 0}
.button{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:99px;background:var(--brand);color:var(--background-base);font-size:.85rem;font-weight:620;text-decoration:none;border:1px solid var(--brand)}
.button:hover{filter:brightness(1.08)}
.button-quiet{background:transparent;color:var(--text-base);border-color:var(--border-base)}
.button-quiet:hover{color:var(--text-strong);background:var(--surface-raised);filter:none}
.nav-back{color:var(--text-strong)!important;font-weight:620}
.method-block{padding:52px 0 0;border-top:1px solid var(--border-weaker);margin-top:52px}
.method-block:first-of-type{border-top:0}
.prose{color:var(--text-base);font-size:.92rem;max-width:74ch}
.run-notes{font-family:var(--mono);font-size:.8rem;color:var(--text-weak);line-height:1.75}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}
.pillars article{border:1px solid var(--border-weaker);border-radius:var(--radius-2xl);padding:18px 20px;background:var(--surface-base)}
.pillars h3{margin:0 0 .5em;font-size:.9rem;font-weight:620}
.pillars p{margin:0;color:var(--text-weak);font-size:.85rem}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px;margin:0 0 24px}
.stat{border:1px solid var(--border-weaker);border-radius:var(--radius-2xl);padding:18px 20px;background:var(--surface-base)}
.stat b{display:block;font-family:var(--mono);font-size:2rem;font-weight:560;letter-spacing:-.04em;color:var(--brand);line-height:1.1}
.stat span{display:block;margin-top:6px;color:var(--text-weak);font-size:.76rem}
.explain-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:12px}
.explain{border:1px solid var(--border-weaker);border-radius:var(--radius-2xl);padding:20px 22px;background:var(--surface-base)}
.explain h3{margin:0 0 .5em;font-size:1rem;font-weight:620}
.explain p{margin:0;color:var(--text-weak);font-size:.86rem}
.explain-why{margin-top:.9em!important;padding-top:.9em;border-top:1px solid var(--border-weaker)}
.explain-why strong{color:var(--text-base)}
.notice-card{border:1px solid var(--border-weaker);border-left:2px solid var(--brand);border-radius:var(--radius-xl);padding:16px 20px;background:var(--surface-base)}
.notice-card p{margin:0;color:var(--text-weak);font-size:.83rem;max-width:80ch}
.notice-card strong{color:var(--text-base)}
.chapter{padding:52px 0 0;border-top:1px solid var(--border-weaker);margin-top:52px}
.chapter-head{margin:0 0 26px}
.chapter-head h2{margin:.2em 0 0;font-size:clamp(1.5rem,3.4vw,2.3rem);letter-spacing:-.03em;font-weight:620;line-height:1.08}
.chapter-head>p:last-child{margin:.7em 0 0;color:var(--text-weak);max-width:70ch;font-size:.92rem}
.posts{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:12px}
.posts li{border:1px solid var(--border-weaker);border-radius:var(--radius-2xl);padding:18px 20px;background:var(--surface-base);display:flex;flex-direction:column}
.post-date{margin:0 0 10px;font-family:var(--mono);font-size:.66rem;text-transform:uppercase;letter-spacing:.1em;color:var(--text-weaker)}
.posts blockquote{margin:0 0 10px;font-size:1rem;line-height:1.45;color:var(--text-strong);font-weight:520;letter-spacing:-.01em}
.posts blockquote::before{content:open-quote}.posts blockquote::after{content:close-quote}
.posts blockquote{quotes:"\u201C" "\u201D"}
.post-gloss{margin:0 0 14px;color:var(--text-weak);font-size:.82rem}
.post-link{margin-top:auto;padding-top:12px;border-top:1px solid var(--border-weaker);font-size:.74rem;color:var(--text-weak);text-decoration:none;font-family:var(--mono)}
.posts li:hover .post-link{color:var(--accent,var(--brand))}
${barWidths}

/* Phones: every comparison table becomes stacked cards. Each data cell carries its column name in data-label, so no information is hidden by the collapse. */
@media(max-width:760px){
.table-scroll{overflow-x:visible}
table{min-width:0;display:block}table.wide{min-width:0;display:block;overflow-x:auto}
thead,caption{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
tbody tr{display:block;border:1px solid var(--border-weaker);border-radius:var(--radius-xl);background:var(--surface-base);padding:6px 14px;margin:0 0 10px}
tbody tr:last-child{margin-bottom:0}
tbody th{display:block;padding:10px 0 3px;border-bottom:0;font-size:.92rem}
tbody td{display:flex;justify-content:space-between;align-items:baseline;gap:18px;text-align:right;border-bottom:1px solid var(--border-weaker);padding:9px 0}
tbody td:last-child{border-bottom:0}
tbody td::before{content:attr(data-label);color:var(--text-weaker);font-family:var(--mono);font-size:.64rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;text-align:left}
tbody td.context{display:block;text-align:left;padding-bottom:10px}
tbody td.context::before{content:""}
.benchmark-section,.method,.app-section{padding-top:40px;margin-top:40px}
.matrix-heading{display:block}
.tally{padding:16px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{.section-nav{display:none}body{background:#fff}details{display:none}}
`;
}

function orderPhrase(model) {
  return model.policy === "balanced-mirrored" ? "in a mirrored order" : "each application in its own sealed run";
}

function orderPillar(model) {
  return model.policy === "balanced-mirrored"
    ? "Every paired scenario runs on the same host in a balanced mirrored schedule, so warm-up, thermal drift, and ordering effects fall on both applications equally."
    : "Each application ran its scenarios in its own sealed run on the same host. Order was not counterbalanced across applications, so every leg's start time is listed on this page and any application can be rerun or added without touching the others.";
}

function orderControl(model) {
  return model.policy === "balanced-mirrored"
    ? "Balanced mirrored schedule across every paired scenario, so neither application is systematically favoured by running first or last."
    : "Independent runs: no counterbalanced order. Run start times are disclosed per leg; host load is gated before each run, and pairing requires the same scenario and corpus digests, run profile, repetition count, and host identity. Every framework revision involved is listed above.";
}
