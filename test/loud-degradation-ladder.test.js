// The degradation ladder, checked end-to-end through renderHtml.
//
// The unit tests in trend-model.test.js check the ladder's DECISIONS. This
// file checks that the renderer obeys them: that a one-run report draws no
// chip, a two-run report draws no shape, and a twenty-run report windows its
// per-answer marks instead of printing a twenty-dot smear.
//
// The 20-run case is a synthetic fixture and is used ONLY for the ladder
// check. It is deliberately not written into any project's aeo-responses/
// directory: fabricating dated run folders would contaminate a real record.

import assert from 'node:assert/strict';
import { renderHtml } from '../lib/report/html.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const QUERIES = [
  ['Q1', 'best voice form filling tools 2026'],
  ['Q2', 'top one-shot voice form filling services for e-commerce'],
];
const PROVIDERS = [['openai', 'ChatGPT'], ['gemini', 'Gemini']];

/**
 * One synthetic run. `mentionAt(queryIdx, providerIdx)` decides each cell so a
 * caller can shape a loss or a hold without hand-writing every row.
 */
function makeSnapshot(index, score, mentionAt) {
  const date = `2026-01-${String(index).padStart(2, '0')}`;
  const results = [];
  QUERIES.forEach(([query, queryText], qi) => {
    PROVIDERS.forEach(([provider, label], pi) => {
      results.push({
        query, queryText, provider, label,
        model: 'test-model', mode: 'web',
        mention: mentionAt(qi, pi, index),
        position: null,
        citationCount: 2,
        canonicalCitations: ['https://testbrand.com/a', 'https://rival.example/b'],
        // Per-cell competitors are plain strings in a real snapshot; the
        // per-run topCompetitors rollup below is objects. Both shapes matter.
        competitors: ['Rival One'],
        responseQuality: 'rich',
        hasBrandInCitations: true,
        responseExcerpt: 'excerpt',
      });
    });
  });
  return {
    date, score, results,
    brand: 'TestBrand', domain: 'testbrand.com',
    topCompetitors: [{ name: 'Rival One', count: 1 }],
    topDomains: [{ host: 'testbrand.com', count: 2 }, { host: 'rival.example', count: 2 }],
  };
}

/** A run series of length `n`, holding every cell except the last run's Q1×Gemini. */
function series(n) {
  return Array.from({ length: n }, (_, i) => makeSnapshot(
    i + 1,
    50 + i,
    (qi, pi, index) => (index === n && qi === 0 && pi === 1 ? 'no' : 'yes'),
  ));
}

function summaryFor(snaps) {
  const last = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  return {
    meta: {
      brand: 'TestBrand', domain: 'testbrand.com',
      date: last.date, prevDate: prev?.date || null,
      runId: 'run_test', queryCount: QUERIES.length, providerCount: PROVIDERS.length,
      measurement: { surface: 'api', disclaimer: 'Measured on each engine API surface.' },
      measurementShort: 'API surface',
    },
    score: last.score,
    scorePrev: prev?.score ?? null,
    coverage: { yes: 3, src: 0, no: 1, error: 0, total: 4 },
    trend: snaps.map(s => s.score),
    trendDates: snaps.map(s => s.date),
    queries: QUERIES.map(q => q[1]),
    engines: PROVIDERS.map(([provider, label]) => ({ provider, label, citations: 2 })),
    competitors: [{ name: 'Rival One', count: 1 }],
    sources: [],
    positionMatrix: [],
    totalCitations: 8,
    totalCitationsPrev: 8,
    regionCount: 1,
    regions: [],
    quotes: [],
    citationOnly: [],
    actions: [],
    topDomains: last.topDomains,
    topCanonicalSources: [],
    crawlability: null,
    authorityPresence: null,
    adsDetected: null,
    outreachTemplates: [],
    citationClassification: null,
    cells: [],
  };
}

const render = (n) => {
  const snaps = series(n);
  return renderHtml(summaryFor(snaps), snaps);
};

const countOf = (html, re) => (html.match(re) || []).length;

console.log('\nloud ladder — through renderHtml');

test('N=1 draws no chip, no chart and no record marks', () => {
  const html = render(1);
  assert.equal(countOf(html, /class="lr-chip"/g), 0, 'a first run has nothing to compare against');
  assert.equal(countOf(html, /class="lr-chart"/g), 0, 'one point is not a line');
  assert.equal(countOf(html, /class="lr-dots"/g), 0, 'one run is not a record');
  assert.match(html, /on the first run/, 'the hero must state the score, not a change');
  assert.match(html, /Movement is not called until run 3/, 'silence about movement must be explained');
});

test('N=2 draws chips but still no shape', () => {
  const html = render(2);
  assert.ok(countOf(html, /class="lr-chip"/g) > 0, 'a delta exists at two runs');
  assert.equal(countOf(html, /class="lr-chart"/g), 0, 'two points are a delta, not a trend');
  assert.equal(countOf(html, /class="lr-dots"/g), 0, 'no per-answer record marks yet');
  assert.ok(!/since day 1/.test(html), 'the baseline caption would restate the same delta');
});

test('N=3 switches the whole pattern on', () => {
  const html = render(3);
  assert.ok(countOf(html, /class="lr-chip"/g) > 0);
  assert.equal(countOf(html, /class="lr-chart"/g), 1, 'the dated chart appears');
  assert.ok(countOf(html, /class="lr-dots"/g) > 0, 'per-answer record marks appear');
  assert.match(html, /since day 1/, 'the baseline caption appears');
  assert.match(html, /Biggest mover since/, 'a section may now name something to act on');
});

test('N=8 renders full-size marks, one per run', () => {
  const html = render(8);
  assert.match(html, /class="lr-dots" data-size="md"/, 'marks stay full size below 10 runs');
  const firstStrip = /<span class="lr-dots"[^>]*>([\s\S]*?)<\/span>\s*<p/.exec(html);
  assert.ok(firstStrip, 'no record strip found');
  assert.equal((firstStrip[1].match(/class="lr-dot"/g) || []).length, 8, 'one mark per run');
  assert.ok(!/class="lr-dots-more"/.test(html), 'nothing is hidden at eight runs');
});

test('N=20 windows the marks behind a +N prefix rather than smearing them', () => {
  const html = render(20);
  assert.match(html, /class="lr-dots" data-size="sm"/, 'marks compress past ten runs');
  assert.match(html, /class="lr-dots-more">\+4</, 'the four hidden runs must be counted in words');
  const firstStrip = /<span class="lr-dots"[^>]*>([\s\S]*?)<\/span>\s*<p/.exec(html);
  assert.equal((firstStrip[1].match(/class="lr-dot"/g) || []).length, 16, 'the window is sixteen runs');
  // The sentence underneath still describes the whole record, including the
  // part the window hides.
  assert.match(html, /Named on all 20 runs|Named on every|Lost this run/,
    'the record sentence must still cover the full history');
});

test('a 20-run chart thins its date labels instead of overprinting them', () => {
  const html = render(20);
  const chart = /<svg class="lr-chart"[\s\S]*?<\/svg>/.exec(html);
  assert.ok(chart, 'chart missing at 20 runs');
  const labels = (chart[0].match(/class="lr-chart-axis"/g) || []).length;
  assert.ok(labels < 20, `all 20 date labels would overprint; got ${labels}`);
  assert.ok(labels >= 2, 'the first and last dates must survive the thinning');
});

test('every answer row is expanded at every rung of the ladder', () => {
  for (const n of [1, 2, 3, 8, 20]) {
    const html = render(n);
    const open = countOf(html, /<details class="lr-answer" open/g);
    const closed = countOf(html, /<details class="lr-answer">/g);
    assert.ok(open > 0, `N=${n}: no answer rows rendered`);
    assert.equal(closed, 0, `N=${n}: a collapsed row is invisible in the client's PDF`);
  }
});

test('the where-to-act line is present at every rung, never silently dropped', () => {
  for (const n of [1, 2, 3, 8, 20]) {
    const html = render(n);
    assert.ok(countOf(html, /class="lr-act-label">Where to act/g) > 0,
      `N=${n}: the callout vanished — "no finding" and "no finding large enough" must not look the same`);
  }
});

test('session cost never reaches a white-label render at any rung', () => {
  for (const n of [1, 8, 20]) {
    const snaps = series(n);
    const html = renderHtml({ ...summaryFor(snaps), sessionCostUsd: 0.31 }, snaps, { whiteLabel: true });
    assert.ok(!/Session cost/.test(html), `N=${n}: cost card leaked into the client deliverable`);
    assert.ok(!/id="actions"/.test(html), `N=${n}: the internal Actions section leaked`);
  }
});

console.log('\nloud ladder — truthfulness regressions');

test('a rival with a cited domain shows its real share, never a hardcoded absence', () => {
  // Regression: every rival row printed the literal string "not a cited host"
  // and a zero-width bar, including rivals holding a real share of the
  // citation pool. Three states must stay distinct: cited N times, known
  // domain cited zero times, and domain never identified.
  const snaps = series(3);
  const last = snaps[snaps.length - 1];
  last.competitorPricing = [
    { name: 'Rival One', domain: 'rival.example' },
    { name: 'Ghost Tool', domain: null },
  ];
  last.topCompetitors = [{ name: 'Rival One', count: 2 }, { name: 'Ghost Tool', count: 1 }];
  const html = renderHtml(summaryFor(snaps), snaps);
  const section = html.split('id="competitors"')[1].split('id="citations"')[0];
  assert.ok(!/not a cited host/.test(section), 'the hardcoded absence string is back');
  assert.match(section, /rival\.example cited \d+ times?/, 'a cited rival must show where its citations are');
  assert.match(section, /domain not identified/,
    'a rival whose domain was never established must say so, not assert an absence');
});

test('axis bars are drawn from the value, or from coverage — never from a magic scalar', () => {
  const snaps = series(3);
  const html = renderHtml(summaryFor(snaps), snaps);
  const rows = [...html.matchAll(/<div class="lr-axis-row">([\s\S]*?)<\/div>\s*(?=<div class="lr-axis-row">|<\/div>)/g)];
  assert.ok(rows.length >= 2, 'axis rows missing');
  for (const [, body] of rows) {
    const width = Number(/width:([\d.]+)%/.exec(body)?.[1]);
    const muted = /data-muted="1"/.test(body);
    const valueText = /lr-axis-value[^>]*>([^<]*)/.exec(body)?.[1] || '';
    assert.ok(Number.isFinite(width), 'axis bar has no width');
    if (!muted) {
      assert.equal(width, Number(valueText),
        `a reportable axis bar must equal its own score; got width ${width} for value "${valueText}"`);
    } else {
      const m = /(\d+) of (\d+)/.exec(valueText);
      assert.ok(m, `a muted axis must print coverage; got "${valueText}"`);
      const expected = Math.round((Number(m[1]) / Number(m[2])) * 1000) / 10;
      assert.equal(width, expected, 'a muted axis bar must equal its coverage share');
    }
  }
});

test('the citation share denominator is every citation, not the brand\'s own', () => {
  // Regression: summary.totalCitations counts ONLY own-domain citations, so
  // using it as the share denominator made the brand read as 100% of a
  // category it holds a fraction of.
  const snaps = series(3);
  const html = renderHtml({ ...summaryFor(snaps), totalCitations: 4 }, snaps);
  assert.ok(!/100% of everything cited/.test(html), 'own-domain count used as the share denominator');
  assert.match(html, /the engines cited 8 sources/,
    'the lede must count every citation across all hosts (2 per answer x 4 answers)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
