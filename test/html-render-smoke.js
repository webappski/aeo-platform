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

test('renders hero number element with id="heroNum"', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  assert.ok(/id="heroNum"/.test(html), 'hero number id missing');
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

test('top competitor in hero filters out accent (YOU) row', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  // Top competitor should be "Competitor A" (count 2), not "testbrand.com" (accent: true).
  assert.ok(/Competitor A/.test(html), 'top competitor missing');
  // Verify accent row name is not surfaced as the top competitor in hero KPI.
  // (testbrand.com appears in masthead — that's expected; check the hero KPI block specifically.)
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  assert.ok(/Competitor A/.test(heroBlock), 'hero should name a real competitor');
});

// ─── Bug fix v0.6: UVI «How is this calculated?» popover lives in the hero ──
test('hero renders ⓘ How is this calculated popover anchored to the UVI number', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  // The hero variant uses the shorter «How is this calculated?» label
  // (no parenthetical «click to expand») so it fits the dense header.
  assert.ok(/uvi-breakdown--hero/.test(heroBlock), 'hero variant of UVI popover not anchored to hero');
  assert.ok(/How is this calculated\?/.test(heroBlock), 'hero popover summary text missing');
  // The ⓘ icon is U+24D8, encoded as &#9432; in the markup
  assert.ok(/&#9432;/.test(heroBlock), 'hero popover ⓘ icon missing');
  // Same breakdown table content as the md-section copy — single source of truth.
  assert.ok(/uvi-breakdown-table/.test(heroBlock), 'hero popover breakdown table missing');
});

test('full report contains «How is this calculated?» twice — hero + markdown section', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const matches = html.match(/How is this calculated\?/g) || [];
  // ≥ 2 = hero popover + markdown popover land in the rendered HTML.
  // Hard-audit checklist: not a double-render of the same anchor.
  assert.ok(matches.length >= 2, `expected ≥ 2 popovers, got ${matches.length}`);
});

test('hero subtitle does NOT contain the BANNED phrase «cited X times»', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  // The literal pattern «cited N times» (number-of-citations bare assertion)
  // is banned — it conflates totalCitations (URL hits) with coverage.src
  // (cited-but-not-named cells). Both old hero copies («cited 0 times» and
  // «cited 5 times») must be gone.
  assert.ok(!/cited <b>\d+ times<\/b>/.test(heroBlock), 'banned phrase «cited N times» found in hero');
  assert.ok(!/cited \d+ times/.test(heroBlock), 'banned bare phrase «cited N times» found in hero');
});

test('hero subtitle uses the new lift-opportunity wording when coverage.src === 0', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  // baseSummary has coverage.yes=1, src=0, total=2 → trailing-but-named branch.
  // The new copy ends with the success-state «citation without naming» line.
  assert.ok(/citation without naming/.test(heroBlock),
    'hero copy does not mention «citation without naming» success-state for src=0');
});

test('hero subtitle uses the new lift-opportunity wording when coverage.src > 0', () => {
  const summary = {
    ...baseSummary,
    coverage: { yes: 2, src: 3, no: 1, error: 0, total: 6 },
  };
  const html = renderHtml(summary, [baseSnapshot]);
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  // When src > 0 the copy explicitly calls out the lift opportunity.
  assert.ok(/lift opportunity/i.test(heroBlock),
    'hero copy does not mention «lift opportunity» when coverage.src > 0');
});

test('KPI card renamed from «Citations earned» to «Lift opportunities»', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  // The old label is misleading because the underlying counter mixed
  // domain-URL-hits across all cells, so we ban it from the hero KPI strip.
  assert.ok(!/Citations earned/.test(heroBlock),
    'old «Citations earned» label still in hero KPI strip');
  assert.ok(/Lift opportunities/.test(heroBlock),
    'new «Lift opportunities» label missing from hero KPI strip');
});

test('KPI card subtitle does NOT recommend the wrong robots.txt fix when coverage.src === 0', () => {
  const html = renderHtml(baseSummary, [baseSnapshot]);
  const heroBlock = html.split('class="hero"')[1].split('class="promote"')[0];
  // Old subtitle said «No citations yet — make sure your domain is in
  // robots.txt allowlist» when coverage.src === 0. That advice is wrong
  // when every cited cell ALSO named the brand (a success state).
  assert.ok(!/robots\.txt allowlist/.test(heroBlock),
    'wrong robots.txt advice still appears in hero KPI card');
  assert.ok(/success state/.test(heroBlock),
    'success-state wording missing from KPI card when coverage.src === 0');
});

test('trend panel copy uses window delta (first vs last run), not last-step delta', () => {
  // Real-data regression: 33→42→42→58→100→83 is up 50 across the window, but
  // the last step is −17. The panel says «across N runs», so it must read the
  // window — it used to print «Score slipping · Down 17 points across 6 runs».
  const summary = {
    ...baseSummary,
    score: 83, scorePrev: 100,
    trend: [33, 42, 42, 58, 100, 83],
    trendDates: ['2026-04-23', '2026-05-13', '2026-05-18', '2026-05-25', '2026-06-10', '2026-06-11'],
  };
  const html = renderHtml(summary, [baseSnapshot]);
  assert.ok(/Score is climbing/.test(html),
    'trend title must reflect the window (up 50), not the last step (−17)');
  assert.ok(/Up 50 points across 6 runs\./.test(html),
    'trend subtitle must report first-vs-last window delta');
  assert.ok(!/Down 17 points across 6 runs/.test(html),
    'last-step delta must not be mislabeled as the multi-run trend');
});

test('trend panel reads slipping when the window is down even if the last step is up', () => {
  const summary = {
    ...baseSummary,
    score: 55, scorePrev: 40,
    trend: [80, 60, 50, 40, 55],
    trendDates: ['2026-05-01', '2026-05-08', '2026-05-15', '2026-05-22', '2026-05-29'],
  };
  const html = renderHtml(summary, [baseSnapshot]);
  assert.ok(/Score slipping/.test(html), 'window-down trend must title as slipping');
  assert.ok(/Down 25 points across 5 runs\./.test(html),
    'subtitle must report the window delta (80→55), not the last step (+15)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
