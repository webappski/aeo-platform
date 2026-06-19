/**
 * AP-FIX-COVERAGE-AXIS — coverage axis = product lines, not client verticals
 * (Gcore root-cause 2026-06-17).
 *
 * Two upstream causes of the off-target basket:
 *   1. brainstorm rule B rewarded spanning 2+ client INDUSTRIES — wrong axis for
 *      a horizontal brand (Gcore: CDN/GPU/DDoS), so it generated healthcare/
 *      fintech queries the brand can't rank for.
 *   2. score.js gave +10 (and a +10 long-tail) for ANY vertical marker, floating
 *      those off-target queries into the top-3.
 *
 * The fix derives the brand's product lines once (product-lines.js) and:
 *   - brainstorm rule B steers across product lines when they're known;
 *   - the score specificity bonus is gated on product-line overlap (legacy
 *     behaviour preserved when lines can't be extracted — no regression);
 *   - the shared select comparator keeps brand-fit a tiebreaker, score primary.
 */

import test from 'node:test';
import assert from 'node:assert';
import { deriveProductLines } from '../lib/init/research/product-lines.js';
import { scoreCandidate } from '../lib/init/research/score.js';
import { tokenize } from '../lib/init/research/brand-fit.js';
import { compareCandidates } from '../lib/init/research/select.js';
import { buildBrainstormPrompt } from '../lib/init/research/brainstorm.js';
import {
  coverageOfProductLines,
  segmentByBrandFit,
  productLinesFromPageSignals,
  sectionScoreRepresentativeness,
  SMALL_N_CELL_THRESHOLD,
} from '../lib/report/sections.js';
import { normalizeQueries, attachBrandFit } from '../lib/config/queries-normalize.js';

// ── product-line derivation ─────────────────────────────────────────────────

test('deriveProductLines extracts a real product list from H2', () => {
  const r = deriveProductLines({ h2: ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage'] });
  assert.deepEqual(r.lines, ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage']);
  assert.equal(r.source, 'h2');
  assert.equal(r.degraded, false);
});

test('deriveProductLines de-dupes case-insensitively', () => {
  const r = deriveProductLines({ h2: ['CDN', 'cdn', 'GPU Cloud', 'GPU Cloud'] });
  assert.deepEqual(r.lines, ['CDN', 'GPU Cloud']);
});

test('NEGATIVE REGRESSION: slogan-only H2 degrades to empty + flag (never junk lines)', () => {
  // Horizontal-infra landing pages: H2 is marketing chrome, not a product list.
  const r = deriveProductLines({
    h2: ['Build without limits', 'Trusted by thousands of teams', 'Get started today'],
    h1: ['The platform for everyone'],
  });
  assert.deepEqual(r.lines, [], 'must NOT treat slogans as product lines');
  assert.equal(r.degraded, true, 'must flag degraded so brand-fit becomes unknown, basket not penalised');
});

test('deriveProductLines drops sentences/questions/over-long headings', () => {
  const r = deriveProductLines({
    h2: ['Edge Network', 'How does our pricing work?', 'We help you ship faster than ever before today'],
  });
  // Only the short noun-phrase line survives; degraded because <2 clean lines.
  assert.deepEqual(r.lines, [], 'one clean line is below the 2-line confidence floor → degraded');
  assert.equal(r.degraded, true);
});

test('deriveProductLines falls back to H1 when H2 is slogan-heavy but H1 lists offerings', () => {
  const r = deriveProductLines({
    h2: ['Build without limits'],
    h1: ['Managed Kubernetes', 'Serverless Functions'],
  });
  assert.deepEqual(r.lines, ['Managed Kubernetes', 'Serverless Functions']);
  assert.equal(r.source, 'h1');
});

// ── score gating (the core Gcore fix) ───────────────────────────────────────

test('NEGATIVE REGRESSION: off-target vertical query earns NO specificity/long-tail bonus when product lines are known', () => {
  // "VPC for healthcare" against a CDN/DDoS brand — the exact Gcore failure.
  // Before the fix this earned +10 specificity AND +10 long-tail (= +20),
  // floating it into the top-3. After the fix: zero, because it overlaps no line.
  const r = scoreCandidate(
    { text: 'best VPC for healthcare companies', intent: 'commercial' },
    { productLines: ['CDN', 'DDoS Protection', 'GPU Cloud'] },
  );
  const specOrLongtail = r.scoreReasons.filter(x => /product-line|specificity|long-tail/.test(x));
  assert.deepEqual(specOrLongtail, [],
    'off-target vertical must earn no product-line/specificity/long-tail bonus');
});

test('on-target product-line query earns the gated bonus + long-tail', () => {
  const r = scoreCandidate(
    { text: 'best CDN providers for enterprise', intent: 'commercial' },
    { productLines: ['CDN', 'DDoS Protection'] },
  );
  assert.ok(r.scoreReasons.some(x => x.includes('+10 product-line match')));
  assert.ok(r.scoreReasons.some(x => x.includes('+10 long-tail structure')));
});

test('NO REGRESSION: when product lines are unknown, a specificity marker is still rewarded', () => {
  // Single-vertical brand whose offering we couldn't enumerate — must keep the
  // legacy +10 so we don't silently down-rank legitimate vertical queries.
  const r = scoreCandidate(
    { text: 'best tools for healthcare', intent: 'commercial' },
    {}, // no productLines
  );
  assert.ok(r.scoreReasons.some(x => x.includes('+10 specificity marker')),
    'legacy specificity bonus preserved when lines unknown');
});

test('score gating does not touch unrelated bonuses (word-count, recency, comparison)', () => {
  const r = scoreCandidate(
    { text: 'best CDN alternative to competitor 2026', intent: 'commercial' },
    { productLines: ['CDN'] },
  );
  assert.ok(r.scoreReasons.some(x => x.includes('word-count sweet-spot')));
  assert.ok(r.scoreReasons.some(x => x.includes('recency marker')));
  assert.ok(r.scoreReasons.some(x => x.includes('comparison structure')));
});

// ── shared selection comparator ─────────────────────────────────────────────

test('compareCandidates: score is the primary key', () => {
  const sorted = [
    { text: 'lower', score: 70, brandFitRank: 2 },
    { text: 'higher', score: 90, brandFitRank: 0 },
  ].sort(compareCandidates);
  assert.equal(sorted[0].text, 'higher', 'higher score wins even with worse brand-fit');
});

test('compareCandidates: brand-fit breaks a score tie (core over aspirational)', () => {
  const sorted = [
    { text: 'aspirational', score: 80, brandFitRank: 0 },
    { text: 'core', score: 80, brandFitRank: 2 },
  ].sort(compareCandidates);
  assert.equal(sorted[0].text, 'core');
});

test('compareCandidates: a candidate without brandFitRank sorts at neutral rank', () => {
  const sorted = [
    { text: 'aspirational', score: 80, brandFitRank: 0 },
    { text: 'legacy-no-rank', score: 80 },
  ].sort(compareCandidates);
  assert.equal(sorted[0].text, 'legacy-no-rank', 'legacy candidate (neutral) beats aspirational on a tie');
});

// ── brainstorm rule B (prompt steering) ─────────────────────────────────────

test('NEGATIVE REGRESSION: rule B steers across product lines (not industries) when lines are known', () => {
  const prompt = buildBrainstormPrompt({
    brand: 'gcore', domain: 'gcore.com',
    site: { lang: 'en', title: 'Gcore', h2: ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage'] },
    categoryDescription: 'cloud and edge infrastructure',
  });
  assert.match(prompt, /PRODUCT LINES/);
  assert.match(prompt, /CDN, DDoS Protection, GPU Cloud, Object Storage/);
  // The old wording explicitly told the LLM to span client industries — gone
  // when lines are present.
  assert.doesNotMatch(prompt, /span 2\+ industries/);
});

test('rule B falls back to offering-diversity guidance when product lines cannot be extracted', () => {
  const prompt = buildBrainstormPrompt({
    brand: 'acme', domain: 'acme.com',
    site: { lang: 'en', title: 'Acme', h2: ['Build without limits', 'Get started'] }, // slogans → no lines
    categoryDescription: 'some product',
  });
  assert.match(prompt, /Product-line coverage/);
  assert.match(prompt, /distinct offerings/);
});

// ── score.js tokenizer reuse (minor #2) ─────────────────────────────────────

test('score overlap uses token equality, not substring — "cloud" does NOT match "clouds"', () => {
  // MUTATION SANITY: the old naive `lower.includes(token)` matched the line
  // "cloud" inside the query word "clouds". Token equality must NOT.
  const r = scoreCandidate(
    { text: 'best clouds review portal', intent: 'commercial' },
    { productLines: ['cloud'] },
  );
  assert.ok(!r.scoreReasons.some(x => x.includes('product-line match')),
    'substring-only collision (clouds⊃cloud) must not earn the product-line bonus');
});

test('score overlap still fires on a genuine token hit (CDN)', () => {
  const r = scoreCandidate(
    { text: 'best CDN providers 2026', intent: 'commercial' },
    { productLines: ['CDN', 'GPU Cloud'] },
  );
  assert.ok(r.scoreReasons.some(x => x.includes('+10 product-line match')));
});

test('score.js and brand-fit share one tokenizer (stopwords + 3-char floor)', () => {
  // The shared tokenizer drops stopwords and <3-char tokens — proves score.js
  // is using brand-fit's tokenize, not a private regex.
  assert.deepEqual(tokenize('best CDN for the 2026'), ['cdn']);
});

// ── AP-FIX-SCORE-SEGMENT: coverage measure ───────────────────────────────────

test('coverageOfProductLines counts lines the basket touches (token overlap)', () => {
  const { covered, total } = coverageOfProductLines(
    ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage'],
    ['best CDN for video', 'cheap object storage'],
  );
  assert.equal(total, 4);
  assert.equal(covered, 2, 'CDN + Object Storage are touched; DDoS + GPU are not');
});

test('coverageOfProductLines: no lines → {covered:0,total:0} (caller omits the line)', () => {
  assert.deepEqual(coverageOfProductLines([], ['anything']), { covered: 0, total: 0 });
});

test('coverageOfProductLines: zero overlap is honestly zero, not rounded up', () => {
  const { covered, total } = coverageOfProductLines(
    ['CDN', 'GPU Cloud'],
    ['best VPC for healthcare'],
  );
  assert.equal(covered, 0);
  assert.equal(total, 2);
});

// ── AP-FIX-SCORE-SEGMENT: brand-fit segmentation ─────────────────────────────

test('segmentByBrandFit aggregates hit-rate per fit bucket', () => {
  const seg = segmentByBrandFit([
    { brandFit: 'core', mention: 'yes' },
    { brandFit: 'core', mention: 'no' },
    { brandFit: 'aspirational', mention: 'no' },
    { brandFit: 'aspirational', mention: 'no' },
    { brandFit: 'core', mention: 'src' },
  ]);
  assert.deepEqual(seg.core, { total: 3, mentions: 2, rate: 67 });
  assert.deepEqual(seg.aspirational, { total: 2, mentions: 0, rate: 0 });
  assert.equal(seg.adjacent, undefined, 'absent buckets are omitted, not zero-filled');
});

test('segmentByBrandFit: no brandFit labels → {} (block skipped, never fabricated)', () => {
  assert.deepEqual(segmentByBrandFit([{ mention: 'yes' }, { mention: 'no' }]), {});
});

test('segmentByBrandFit excludes error cells from the denominator', () => {
  const seg = segmentByBrandFit([
    { brandFit: 'core', mention: 'yes' },
    { brandFit: 'core', mention: 'error' },
  ]);
  assert.deepEqual(seg.core, { total: 1, mentions: 1, rate: 100 });
});

// ── AP-FIX-SCORE-SEGMENT: pageSignals adapter ────────────────────────────────

test('productLinesFromPageSignals adapts {h2:{samples}} → product lines', () => {
  const r = productLinesFromPageSignals({ h2: { samples: ['CDN', 'DDoS Protection', 'GPU Cloud'] } });
  assert.ok(r && r.lines.length === 3);
});

test('productLinesFromPageSignals: no headings → null (coverage line omitted)', () => {
  assert.equal(productLinesFromPageSignals({ h2: { samples: [] }, h1: { samples: [] } }), null);
  assert.equal(productLinesFromPageSignals(null), null);
});

test('productLinesFromPageSignals: slogan-only headings degrade to null', () => {
  const r = productLinesFromPageSignals({ h2: { samples: ['Build without limits', 'Get started today'] } });
  assert.equal(r, null, 'degraded derivation must not produce a junk coverage line');
});

// ── AP-FIX-SCORE-SEGMENT: section assembly ───────────────────────────────────

const cellGrid = (n, fit) => Array.from({ length: n }, (_, i) => ({
  query: `Q${i + 1}`, queryText: `q${i + 1}`, mention: 'no', ...(fit ? { brandFit: fit } : {}),
}));

test('section fires a small-N warning at/below the threshold', () => {
  const md = sectionScoreRepresentativeness([{ domain: 'x.com', results: cellGrid(SMALL_N_CELL_THRESHOLD) }]);
  assert.match(md, /Small sample/);
  assert.match(md, /How representative is this score\?/);
});

test('section suppresses the small-N warning above the threshold (no other blocks)', () => {
  // A wide basket, no pageSignals, no brandFit → all three blocks absent → ''.
  const md = sectionScoreRepresentativeness([{ domain: 'x.com', results: cellGrid(SMALL_N_CELL_THRESHOLD + 1) }]);
  assert.equal(md, '', 'no warning, no coverage data, no fit labels → empty section');
});

test('section renders the coverage line from pageSignals', () => {
  const md = sectionScoreRepresentativeness([{
    domain: 'gcore.com',
    pageSignals: { h2: { samples: ['CDN', 'DDoS Protection', 'GPU Cloud'] } },
    results: [
      { query: 'Q1', queryText: 'best CDN for video', mention: 'no' },
      { query: 'Q2', queryText: 'cheap object storage', mention: 'no' },
    ],
  }]);
  assert.match(md, /Basket coverage/);
  assert.match(md, /1 of 3/, 'only CDN is touched by these queries');
});

test('section renders the fit segmentation only when results carry brandFit', () => {
  const withFit = sectionScoreRepresentativeness([{ domain: 'x.com', results: cellGrid(12, 'core') }]);
  assert.match(withFit, /Score by brand-capability fit/);
  const withoutFit = sectionScoreRepresentativeness([{ domain: 'x.com', results: cellGrid(12) }]);
  assert.doesNotMatch(withoutFit, /Score by brand-capability fit/);
});

test('section returns empty string on an all-error / empty run (no fabricated context)', () => {
  assert.equal(sectionScoreRepresentativeness([{ domain: 'x.com', results: [] }]), '');
  assert.equal(sectionScoreRepresentativeness([{ domain: 'x.com', results: [{ mention: 'error' }] }]), '');
});

// ── AP-SEGMENT-LIVE: the source→config→run→report wiring wakes the block ──────
//
// End-result of the migration, exercised purely (no network/replay): a basket
// SAVED as {q,brandFit} objects (attachBrandFit at init) is READ by run
// (normalizeQueries), the per-index brandFit is COPIED onto each result exactly
// as bin/aeo-tracker.js does (`...(brandFits[qi] ? { brandFit } : {})`), and the
// report's segment block then renders a LIVE core-vs-aspirational split.

/** Mirror of the run loop's result-attach: one result per (query, engine),
 * carrying brandFit ONLY when the config supplied a label for that index —
 * byte-for-byte the `...(queryBrandFits[qi] ? { brandFit } : {})` spread. */
function attachResults(savedQueries, perQueryMention) {
  const { texts, brandFits } = normalizeQueries(savedQueries);
  const results = [];
  for (let qi = 0; qi < texts.length; qi++) {
    results.push({
      query: `Q${qi + 1}`,
      queryText: texts[qi],
      provider: 'openai',
      mention: perQueryMention[qi],
      ...(brandFits[qi] ? { brandFit: brandFits[qi] } : {}),
    });
  }
  return results;
}

test('LIVE WIRING: object basket → run-attach → segment splits core from aspirational', () => {
  // Saved exactly as init would write it after AP-SEGMENT-LIVE.
  const saved = attachBrandFit(
    ['best CDN providers', 'edge GPU rental', 'object storage'],
    { 'best CDN providers': 'core', 'edge GPU rental': 'aspirational', 'object storage': 'core' },
  );
  // CDN hits, GPU misses (aspirational 0%), object-storage misses (core partial).
  const results = attachResults(saved, ['yes', 'no', 'no']);
  const seg = segmentByBrandFit(results);
  assert.deepEqual(seg.core, { total: 2, mentions: 1, rate: 50 }, 'core = CDN(yes)+storage(no) = 1/2');
  assert.deepEqual(seg.aspirational, { total: 1, mentions: 0, rate: 0 }, 'aspirational = GPU(no) = 0/1');
});

test('LIVE WIRING: a raw 0% headline is decomposed — 0%-on-aspirational is NOT 0%-on-core', () => {
  // The Gcore failure: a 0% headline that is really "invisible only where the
  // brand does not compete". With one core MISS and one aspirational MISS, the
  // segment block must show them as SEPARATE rows, not one undifferentiated 0%.
  const saved = attachBrandFit(
    ['core thing', 'moonshot thing'],
    { 'core thing': 'core', 'moonshot thing': 'aspirational' },
  );
  const results = attachResults(saved, ['no', 'no']); // headline 0/2 = 0%
  const md = sectionScoreRepresentativeness([{ domain: 'gcore.com', results }]);
  assert.match(md, /Score by brand-capability fit/, 'segment block is now AWAKE (was dormant pre-wiring)');
  assert.match(md, /Core \(brand sells this\)/);
  assert.match(md, /Aspirational \(not a core player\)/);
  // The honest framing: a 0% driven by aspirational rows is expected, not a regression.
  assert.match(md, /aspirational rows is expected, not a regression/);
});

test('DORMANT BACK-COMPAT: a legacy string basket attaches NO brandFit → segment stays asleep', () => {
  // The exact pre-AP-SEGMENT-LIVE config shape. run-attach adds no brandFit,
  // so the segment block is absent — byte-identical behaviour to before.
  const legacy = ['best CDN providers', 'edge GPU rental', 'object storage'];
  const results = attachResults(legacy, ['no', 'no', 'no']);
  assert.ok(results.every(r => !('brandFit' in r)), 'no label reaches results from a string basket');
  assert.deepEqual(segmentByBrandFit(results), {}, 'segment data empty → block skipped');
  const md = sectionScoreRepresentativeness([{ domain: 'x.com', results }]);
  assert.doesNotMatch(md, /Score by brand-capability fit/, 'segmentation remains gracefully dormant');
});

test('DORMANT BACK-COMPAT: a summary missing brandFit (old _summary.json) renders no segment', () => {
  // Re-reading a pre-wiring _summary.json: results have no brandFit field.
  const oldSummaryResults = [
    { query: 'Q1', queryText: 'a', mention: 'yes' },
    { query: 'Q2', queryText: 'b', mention: 'no' },
  ];
  assert.deepEqual(segmentByBrandFit(oldSummaryResults), {});
});

console.log('coverage-axis.test.js — all assertions passed');
