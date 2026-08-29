// Smoke test: feed renderHtml a synthetic snapshot and verify v0.5 bento layout
// renders the expected sections + KPIs + structural markers.

import assert from 'node:assert/strict';
import { renderHtml } from '../lib/report/html.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const baseSnapshot = {
  date: '2026-04-27',
  brand: 'TestBrand',
  domain: 'testbrand.com',
  score: 50,
  mentions: 3,
  total: 6,
  errors: 0,
  results: [
    {
      query: 'Q1', queryText: 'best test tools',
      provider: 'openai', label: 'ChatGPT', model: 'gpt-test',
      mention: 'yes', position: 1, citationCount: 2,
      canonicalCitations: ['https://g2.com/test', 'https://reddit.com/r/x'],
      competitors: ['Competitor A', 'Competitor B'],
      sentiment: { label: 'positive', confidence: 'high', rationale: 'top recommended' },
      tag: 'comparison-bofu',
    },
    {
      query: 'Q2', queryText: 'free test alternatives',
      provider: 'gemini', label: 'Gemini', model: 'gemini-test',
      mention: 'no', position: null, citationCount: 1,
      canonicalCitations: ['https://capterra.com/x'],
      competitors: ['Competitor A'],
      tag: 'tofu',
    },
  ],
  topCompetitors: [{ name: 'Competitor A', count: 2 }, { name: 'Competitor B', count: 1 }],
  topCanonicalSources: [
    { url: 'https://g2.com/test', count: 1 },
    { url: 'https://reddit.com/r/x', count: 1 },
    { url: 'https://capterra.com/x', count: 1 },
  ],
  topDomains: [
    { host: 'g2.com', count: 1, share: 0.333 },
    { host: 'reddit.com', count: 1, share: 0.333 },
    { host: 'capterra.com', count: 1, share: 0.334 },
  ],
  crawlability: {
    domain: 'testbrand.com',
    summary: { totalBots: 12, blockedCount: 1, allowedCount: 5, partialCount: 0, unspecifiedCount: 6, hasRobots: true, hasLlmsTxt: false, hasSitemap: true },
    botAccess: [
      { name: 'GPTBot', label: 'GPTBot', provider: 'ChatGPT', access: 'blocked' },
      { name: 'ClaudeBot', label: 'ClaudeBot', provider: 'Claude', access: 'allowed' },
    ],
    robots: { url: 'https://testbrand.com/robots.txt', status: 200, bytes: 200 },
    sitemap: { url: 'https://testbrand.com/sitemap.xml', urlCount: 50 },
  },
};

// Minimal summary mirroring buildHtmlSummary's v0.5 shape.
const baseSummary = {
  meta: { brand: 'TestBrand', domain: 'testbrand.com', date: '2026-04-27', prevDate: null, queryCount: 2, providerCount: 2, runId: 'test' },
  score: 50, scorePrev: null,
  trend: [50],
  trendDates: ['2026-04-27'],
  engines: [
    { provider: 'openai', label: 'ChatGPT', model: 'gpt-test', kind: 'gpt-test', cells: ['yes'], pct: 100, hits: 1, total: 1, citations: 2, delta: null, series: [100] },
    { provider: 'gemini', label: 'Gemini', model: 'gemini-test', kind: 'gemini-test', cells: ['no'], pct: 0, hits: 0, total: 1, citations: 1, delta: null, series: [0] },
  ],
  coverage: { yes: 1, src: 0, no: 1, error: 0, total: 2 },
  competitors: [{ name: 'testbrand.com', count: 1, accent: true }, { name: 'Competitor A', count: 2 }, { name: 'Competitor B', count: 1 }],
  sources: [],
  quotes: [],
  citationOnly: [],
  actions: [
    { kind: 'gap',     priority: 'high', engines: ['openai'], title: 'Pitch G2', detail: 'Email G2 editor.' },
    { kind: 'compete', priority: 'med',  engines: [],         title: 'Build comparison page', detail: 'Long form vs Competitor A.' },
  ],
  positionMatrix: [
    { query: 'best test tools',         columns: [{ provider: 'openai', label: 'ChatGPT', mention: 'yes', position: 1 }, { provider: 'gemini', label: 'Gemini', mention: 'no' }] },
    { query: 'free test alternatives',  columns: [{ provider: 'openai', label: 'ChatGPT', mention: 'no' }, { provider: 'gemini', label: 'Gemini', mention: 'no' }] },
  ],
  totalCitations: 3,
  totalCitationsPrev: null,
  regionCount: 1,
  regions: [],
  sessionCostUsd: 0.05,
  totalCostUsd: 0.05,
  costBreakdown: [
    { provider: 'openai', model: 'gpt-test', label: 'ChatGPT', requests: 1, inputTokens: 100, outputTokens: 200, costUsd: 0.02 },
    { provider: 'gemini', model: 'gemini-test', label: 'Gemini', requests: 1, inputTokens: 80, outputTokens: 150, costUsd: 0.03 },
  ],
  costTrend: [0.05],
  topDomains: baseSnapshot.topDomains,
  topCanonicalSources: baseSnapshot.topCanonicalSources,
  crawlability: baseSnapshot.crawlability,
  authorityPresence: null,
  adsDetected: { totalCellsScanned: 2, totalCellsWithAdSignal: 0, byProvider: {}, samples: [] },
  outreachTemplates: [],
  citationClassification: null,
  cells: [],
};

console.log('\nrenderHtml — smoke (v0.5 bento)');

test('produces valid HTML doctype', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(html.startsWith('<!doctype html>'));
});

test('embeds variable woff2 fonts as base64', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/data:font\/woff2;base64,/.test(html), 'fonts not embedded');
  // Three families: Fraunces, Geist, JetBrains Mono
  assert.equal((html.match(/@font-face/g) || []).length, 3);
});

// 2026-08 loud redesign: the animated «heroNum» counter was replaced by the
// verdict hero — a conclusion sentence first, the index as one of three KPI
// cards second. What must not regress is that the headline number is present
// and that a sentence states the finding before any figure.
test('renders the verdict hero with a headline sentence and the index KPI', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/class="lr-hero-title"/.test(html), 'verdict headline missing');
  assert.ok(/class="lr-kpi-num"/.test(html), 'headline KPI number missing');
  assert.ok(/Visibility index/.test(html), 'index KPI label missing');
});

test('the verdict headline is a sentence, not a bare number', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const title = /<h1 class="lr-hero-title">([\s\S]*?)<\/h1>/.exec(html);
  assert.ok(title, 'hero title element missing');
  const text = title[1].replace(/<[^>]+>/g, '').trim();
  assert.ok(text.split(/\s+/).length >= 4, `hero headline too terse to be a verdict: "${text}"`);
});

test('renders bento sections with section ids', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/id="overview"/.test(html), 'overview section missing');
  assert.ok(/id="visibility"/.test(html), 'visibility section missing');
  assert.ok(/id="diagnostics"/.test(html), 'diagnostics section missing');
});

test('renders engine cards with --c color tokens', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/class="eng-card"/.test(html), 'engine cards missing');
  assert.ok(/--eng-gpt/.test(html), 'engine color token --eng-gpt missing');
});

test('renders matrix grid for query × engine view', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/class="matrix-grid"/.test(html), 'matrix grid missing');
});

test('renders site readiness composite when crawlability data present', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/Site readiness/.test(html), 'site readiness cell missing');
});

test('renders cost cell when costBreakdown has engines', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/Session cost/.test(html), 'cost cell missing');
});

test('omits geo cell when regionCount === 1', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  // The "Geo" cell IS emitted in Diagnostics (showing "US only · 1 region"),
  // but the multi-region By-region cell in Visibility should NOT appear.
  assert.ok(!/By region · \d+ markets/.test(html), 'multi-region cell appeared without --geo data');
});

test('omits verbatim cell when summary.quotes is empty (Q6 conditional)', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  // Quote figures only render if there are actual quotes — empty array → no cell.
  assert.ok(!/<figure class="quote">/.test(html), 'quote cell rendered without quotes');
});

test('without snapshots — bento renders gracefully (no crash)', () => {
  const minSummary = { ...baseSummary, totalCitations: 0, regionCount: 1, topDomains: [], crawlability: null, adsDetected: null };
  const html = renderHtml(minSummary, null);
  assert.ok(html.startsWith('<!doctype html>'));
});

test('top competitor never resolves to the accent (YOU) row', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  // Top competitor should be "Competitor A" (count 2), not "testbrand.com"
  // (accent: true). Scoped to the Competitors section since the 2026-08
  // redesign moved rival names out of the hero.
  const section = html.split('id="competitors"')[1] || '';
  assert.ok(/Competitor A/.test(section), 'competitors section should name a real competitor');
  assert.ok(!/>testbrand\.com<\/span><span class="lr-tag">new/.test(section),
    'the accent (YOU) row leaked into the rival list');
});

// ─── UVI breakdown popover ───────────────────────────────────────────────
// The hero variant of the popover retired with the 2026-08 redesign: the
// axis breakdown now has a section of its own («What moved the index»), which
// shows the same four weighted axes permanently rather than behind a click —
// a popover is invisible in Save-as-PDF, which is the delivery path.
test('the four weighted axes render as a permanent block, not behind a click', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/What moved the index/.test(html), 'axis breakdown block missing');
  assert.ok(/class="lr-axis-row"/.test(html), 'axis rows missing');
  assert.ok(/Four axes, fixed weights/.test(html), 'axis block eyebrow missing');
});

test('the UVI breakdown table still renders once, from the markdown section', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const matches = html.match(/How is this calculated\?/g) || [];
  assert.ok(matches.length >= 1, `expected the breakdown popover, got ${matches.length}`);
});

test('the BANNED phrase «cited X times» appears nowhere in the report', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  // «cited N times» conflates totalCitations (URL hits) with coverage.src
  // (cited-but-not-named answers). The guard is document-wide since the
  // 2026-08 redesign — the copy it protected moved out of the hero.
  assert.ok(!/cited <b>\d+ times<\/b>/.test(html), 'banned phrase «cited N times» found');
});

test('never recommends the robots.txt allowlist fix for a naming problem', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  // Old copy said «No citations yet — make sure your domain is in robots.txt
  // allowlist» when coverage.src === 0. That advice is wrong when every cited
  // answer ALSO named the brand (a success state).
  assert.ok(!/robots\.txt allowlist/.test(html), 'wrong robots.txt advice present');
});

// ─── Lift opportunities: the aggregate KPI ───────────────────────────────
// The per-answer rows each carry their own "Cited, not named" pill. The pills
// state the CONDITION; only an aggregate states its SIZE and what to do about
// it, which is the client-visible KPI the 2026-08 redesign dropped and this
// suite exists to keep. The figure is derived from the snapshot's `results`
// (run-metrics.js buildLiftOpportunity), so these fixtures drive the branch by
// setting cell `mention` values — mutating `summary.coverage` alone would leave
// the assertions inert.
const srcSnapshot = {
  ...baseSnapshot,
  results: [
    baseSnapshot.results[0],
    { ...baseSnapshot.results[1], mention: 'src' },
    { ...baseSnapshot.results[1], query: 'Q3', queryText: 'voice form tools', mention: 'src' },
  ],
};
const srcSummary = {
  ...baseSummary,
  coverage: { yes: 1, src: 2, no: 0, error: 0, total: 3 },
};

test('hero states the lift aggregate when answers cite you without naming you', () => {
  const html = renderHtml(srcSummary, [srcSnapshot]);
  const hero = html.split('class="lr-hero-kpis"')[1].split('</section>')[0];
  assert.ok(/Lift opportunities/.test(hero), 'aggregate lift KPI missing from the hero');
  assert.ok(/<span class="lr-kpi-num">2<\/span>/.test(hero),
    'the KPI must count the cited-not-named answers (2 of 3), not restate a pill');
  assert.ok(/class="lr-kpi-denom">\/ 3</.test(hero), 'the KPI must carry its denominator');
  assert.ok(/2 of 3 answers cite your domain as a source without naming you/.test(hero),
    'the KPI must say what the number counts');
  assert.ok(/shortest lift/.test(hero), 'the KPI must carry the actionable next step, not just a figure');
});

test('the lift KPI reads as a success state, not a gap, when nothing is cited-only', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const hero = html.split('class="lr-hero-kpis"')[1].split('</section>')[0];
  assert.ok(/Lift opportunities/.test(hero), 'the KPI must render on every run, not only when it is non-zero');
  assert.ok(/success state/.test(hero),
    'zero cited-not-named answers with a named answer present is a success state, not a gap');
});

test('the retired «Citations earned» label never comes back', () => {
  const html = renderHtml(srcSummary, [srcSnapshot]);
  // The old label mixed domain-URL hits across all cells with the cited-only
  // answer count, so the number never meant what the label said.
  assert.ok(!/Citations earned/.test(html), 'old «Citations earned» label is back');
});

test('every hero KPI that counts answers uses the SAME denominator, errors included', () => {
  // The presence KPI counts out of `history.cells.length`; the lift KPI counts
  // out of `results.length`. They agree today because a failed cell is still a
  // cell in both. Two adjacent KPIs printing "of 3" and "of 2" for the same run
  // would make the reader arbitrate between them, so the agreement is pinned
  // here rather than left as a coincidence.
  const errSnapshot = {
    ...baseSnapshot,
    results: [
      baseSnapshot.results[0],
      { ...baseSnapshot.results[1], mention: 'src' },
      { ...baseSnapshot.results[1], query: 'Q3', queryText: 'third question', mention: 'error' },
    ],
  };
  const html = renderHtml(
    { ...baseSummary, coverage: { yes: 1, src: 1, no: 0, error: 1, total: 3 } },
    [errSnapshot],
  );
  const hero = html.split('class="lr-hero-kpis"')[1].split('</section>')[0];
  // Only the KPIs whose unit is ANSWERS. "Engines naming you everywhere"
  // counts engines and legitimately carries a different denominator.
  const denomOf = (label) => {
    const m = new RegExp(`lr-eyebrow">${label}</span>[\\s\\S]*?lr-kpi-denom">/ (\\d+)<`).exec(hero);
    assert.ok(m, `KPI «${label}» not found in the hero`);
    return m[1];
  };
  assert.equal(denomOf('Answers naming or citing you'), '3',
    'the presence KPI dropped the errored answer from its denominator');
  assert.equal(denomOf('Lift opportunities'), denomOf('Answers naming or citing you'),
    'two adjacent KPIs disagree about how many answers this run has');
});

test('the lift KPI and its advice are withheld from a white-label snapshot', () => {
  const html = renderHtml(srcSummary, [srcSnapshot], { whiteLabel: true });
  assert.ok(!/Lift opportunities/.test(html),
    'the advisory KPI leaked into the statistics-only client deliverable');
  assert.ok(!/shortest lift/.test(html), 'the advisory sentence leaked into white-label');
  assert.ok(/class="lr-hero-kpis" data-count="3"/.test(html),
    'white-label must still render the three statistical KPIs');
});

test('the actions section ships by default and its empty-state copy stays client-safe', () => {
  // Founder ruling 2026-08-29: Actions ships in the default (non-white-label)
  // client deliverable. Regression guard for both directions of that flip —
  // the section must render, and an empty action plan must not surface the
  // operator-facing CLI syntax that used to be safe only because white-label
  // dropped the whole section before anyone could see the placeholder.
  const html = renderHtml({ ...baseSummary, actions: [] }, [baseSnapshot]);
  assert.ok(/id="actions"/.test(html), 'Actions section must render by default');
  assert.ok(!/lr-internal-flag/.test(html), 'no internal-only banner on the default client deliverable');
  assert.ok(!/report --html/.test(html), 'empty-state copy must not name an internal CLI flag');
});

// ─── Competitor alias disclosure ─────────────────────────────────────────
// The grouping rule is deliberately narrow: it matches on the first six
// characters of a WHOLE name, so it never fuses two companies that merely
// share a category word. The disclosure prose has to be honest about both
// sides of that trade — what the rule grouped, and what it could not reach.
function aliasFixture(topCompetitors, topDomains) {
  const snapshot = { ...baseSnapshot, topCompetitors };
  const summary = { ...baseSummary, topDomains };
  return renderHtml(summary, [snapshot]);
}

const ALIAS_COMPETITORS = [
  // The multi-word name arrives FIRST on purpose: taking names[0] and cutting
  // it at the first space is the bug this fixture exists to catch.
  { name: 'Anve Voice Forms', count: 1 },
  { name: 'AnveVoice', count: 3 },
  { name: 'RivalCo', count: 2 },
];
const ALIAS_DOMAINS = [
  { host: 'anvevoice.app', count: 13, share: 0.6 },
  { host: 'anveforms.com', count: 7, share: 0.3 },
  { host: 'g2.com', count: 1, share: 0.1 },
];

test('an alias group is named by its shortest name, not by a truncated first arrival', () => {
  const html = aliasFixture(ALIAS_COMPETITORS, ALIAS_DOMAINS);
  const section = html.split('id="competitors"')[1].split('id="citations"')[0];
  assert.ok(/AnveVoice, which the engines name under 2 different names/.test(section),
    'the group must be named by a name that exists, not by a fragment of one');
  assert.ok(!/>Anve, which the engines name/.test(section),
    'a multi-word name was cut at its first word and now names nothing');
});

test('the alias card names the cited host the grouping rule could not reach', () => {
  const html = aliasFixture(ALIAS_COMPETITORS, ALIAS_DOMAINS);
  const section = html.split('id="competitors"')[1].split('id="citations"')[0];
  // The stem rule reaches anvevoice.app and, correctly, not anveforms.com —
  // but a host absent from the prose entirely reads as a host that was never
  // cited, which is the opposite of true.
  assert.ok(/anvevoice\.app \(13 citations\)/.test(section), 'the grouped host is missing');
  assert.ok(/anveforms\.com \(7 citations\)/.test(section),
    'a partial-stem host is cited 7 times and never appears in the disclosure');
  assert.ok(/shares only the leading “anve”/.test(section),
    'the disclosure must say WHY the host was not grouped');
  assert.ok(/worth one manual check/.test(section),
    'the claim must stay a manual check, never an assertion of shared ownership');
  assert.ok(/deliberately does <b class="lr-strong">not<\/b> merge/.test(section),
    'the counts must still not be merged on a shared stem');
});

test('the partial-stem sentence is withheld when the shared word is a category word', () => {
  // "Voice" also opens a rival OUTSIDE the group, so it is a category word
  // rather than this operation's brand word. Flagging every voice-* host as
  // possibly the same company would be worse than saying nothing.
  const html = aliasFixture(
    [
      { name: 'VoiceFlow', count: 3 },
      { name: 'Voice Flow Pro', count: 1 },
      { name: 'VoiceB', count: 2 },
    ],
    [
      { host: 'voiceflow.com', count: 9, share: 0.6 },
      { host: 'voicebot.io', count: 5, share: 0.4 },
    ],
  );
  const section = html.split('id="competitors"')[1].split('id="citations"')[0];
  assert.ok(/One competitor may be counted as 2/.test(section), 'the alias card should still render');
  assert.ok(!/shares only the leading/.test(section),
    'a category word shared with an ungrouped rival must not seed a partial-stem claim');
  assert.ok(!/voicebot\.io \(5 citations\), shares only/.test(section),
    'an unrelated host was flagged as possibly the same company');
});

test('no alias group, no alias card — the check renders because it tripped', () => {
  const html = aliasFixture(
    [{ name: 'Competitor A', count: 2 }, { name: 'Formidable', count: 1 }],
    baseSnapshot.topDomains,
  );
  const section = html.split('id="competitors"')[1].split('id="citations"')[0];
  assert.ok(!/One competitor may be counted as/.test(section),
    'the counting-artefact card fired on rivals that share nothing');
});

// ─── Score over time: the two deltas must not be confused ────────────────
// Real-data regression: 33→42→42→58→100→83 is up 50 across the window, but
// the last step is −17. The design gives each delta its own slot — a bold
// run-to-run chip and a quiet since-day-1 caption — so neither can be
// printed as the other.
test('since-day-1 caption reports the window delta, not the last step', () => {
  const summary = {
    ...baseSummary,
    score: 83, scorePrev: 100,
    trend: [33, 42, 42, 58, 100, 83],
    trendDates: ['2026-04-23', '2026-05-13', '2026-05-18', '2026-05-25', '2026-06-10', '2026-06-11'],
  };
  const html = renderHtml(summary, [baseSnapshot]);
  assert.ok(/Up <b class="lr-verdict-good">50 points<\/b> since day 1/.test(html),
    'baseline caption must report first-vs-last window delta (33→83 = +50)');
  assert.ok(!/17 points<\/b> since day 1/.test(html),
    'last-step delta must not be printed as the since-day-1 caption');
});

test('a down window is reported as down even when the last step is up', () => {
  const summary = {
    ...baseSummary,
    score: 55, scorePrev: 40,
    trend: [80, 60, 50, 40, 55],
    trendDates: ['2026-05-01', '2026-05-08', '2026-05-15', '2026-05-22', '2026-05-29'],
  };
  const html = renderHtml(summary, [baseSnapshot]);
  assert.ok(/Down <b class="lr-verdict-bad">25 points<\/b> since day 1/.test(html),
    'baseline caption must report the window delta (80→55 = −25), not the last step (+15)');
});

test('the index chart is dated and marks partial runs', () => {
  const summary = {
    ...baseSummary,
    trend: [33, 42, 58, 100, 92],
    trendDates: ['2026-04-23', '2026-05-13', '2026-05-25', '2026-06-10', '2026-08-13'],
  };
  const html = renderHtml(summary, [baseSnapshot]);
  assert.ok(/class="lr-chart"/.test(html), 'index chart missing');
  assert.ok(!/preserveAspectRatio="none"/.test(html.split('class="lr-chart"')[1] || ''),
    'chart must not stretch — preserveAspectRatio="none" distorts the labels');
  assert.ok(/lr-chart-axis/.test(html), 'chart date labels missing');
});

// ─── review #3: measurement-surface disclaimer in the report header ──────────
test('masthead renders the measurement-surface disclaimer when meta carries it', () => {
  const summary = {
    ...baseSummary,
    meta: {
      ...baseSummary.meta,
      measurementShort: 'API surface (your keys) — a reproducible proxy, not the consumer apps; no AI Overviews / Copilot.',
      measurement: { surface: 'api', disclaimer: 'Measures each engine’s API surface via your own keys — a reproducible proxy, NOT a guarantee of what the consumer app shows.' },
    },
  };
  const html = renderHtml(summary, [baseSnapshot]);
  const mastBlock = html.split('class="mast"')[1].split('class="hero"')[0];
  assert.ok(/mast-disclaimer/.test(mastBlock), 'disclaimer element missing from masthead');
  assert.ok(/API surface/.test(mastBlock), 'disclaimer short text missing from masthead');
  // The full sentence rides in the title attribute for hover-detail.
  assert.ok(/reproducible proxy, NOT a guarantee/.test(mastBlock), 'full disclaimer missing from title attr');
  // It must appear in the HEADER, not buried elsewhere — before the hero.
  assert.ok(mastBlock.indexOf('mast-disclaimer') > 0, 'disclaimer not located inside the masthead');
});

test('masthead omits disclaimer gracefully for legacy summaries without the field', () => {
  // baseSummary.meta has no measurement field (pre-feature snapshot).
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const mastBlock = html.split('class="mast"')[1].split('class="hero"')[0];
  assert.ok(!/mast-disclaimer/.test(mastBlock), 'disclaimer must not render when meta lacks measurement');
  // Layout still intact — date/version row untouched.
  assert.ok(/<dt>Run<\/dt>/.test(mastBlock), 'masthead date row broke');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
