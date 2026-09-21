/**
 * Unit: the UVI-v2 baseline reader (`scripts/uvi-v2-baseline.mjs`).
 *
 * WHY A UNIT AND NOT AN E2E. This script has no CLI surface worth driving — it
 * reads JSON off disk and prints a table. The two things that can be wrong are
 * both pure: whether it finds every summary in a tree, and whether a row says
 * the same thing the canonical module says. E2E here would be a subprocess
 * wrapped around two function calls (AGENTS.md: unit only when E2E is
 * disproportionate, and say why — this is why).
 *
 * WHAT IT PROTECTS. The script exists because re-rendering old reports to get a
 * v2 number costs money and rewrites historical summaries. Its whole value is
 * that it delegates the composite to `lib/report/visibility-index.js` instead
 * of re-implementing it — so the assertion that matters is `row.v2 ===
 * computeUVI(computeComponents(summary))`, checked against the module rather
 * than against a hard-coded number. A literal expected value here would pass
 * happily on the day the script grew its own copy of the formula, which is the
 * one failure this file is for.
 *
 * Mutation-sanity (each MUST go red):
 *   - make `rowFor` return a rounded average of its own instead of delegating →
 *     the delegation assertion fails on the guarded fixture.
 *   - drop the `smallSampleGuard` call so `guardFired` is always false → the
 *     "guard fired / did not fire" pair fails.
 *   - make `findSummaries` non-recursive → the nested-tree count fails.
 *   - compute v1 as `computeUVI(components)` (forgetting the zero floor) → the
 *     v1 delegation test and the negative-delta test both fail.
 *   - remove the `minSample` passthrough from `computeUVI` so the third
 *     argument is ignored → v1 collapses onto v2 and every delta reads 0.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSummaries, rowFor } from '../scripts/uvi-v2-baseline.mjs';
import { computeComponents, computeUVI } from '../lib/report/visibility-index.js';

/** A cell in the shape the run loop writes. */
const cell = (i, extra = {}) => ({
  query: `Q${i}`, queryText: `q${i}`, provider: 'openai', label: 'ChatGPT',
  model: 'gpt-5-search-api', mention: 'no', position: null, citationCount: 0,
  canonicalCitations: [], competitors: [], competitorsUnverified: [],
  responseQuality: 'ok', hasBrandInCitations: false, ...extra,
});

/** Many measured cells, but sentiment on only two → the v2 guard has to fire. */
function summaryWithThinSentiment() {
  const results = [];
  for (let i = 1; i <= 20; i++) results.push(cell(i, { mention: i <= 6 ? 'yes' : 'no', position: i <= 6 ? 2 : null }));
  results[0].sentiment = { label: 'positive', confidence: 'high' };
  results[1].sentiment = { label: 'positive', confidence: 'high' };
  return { date: '2026-07-15', domain: 'thin.example', brand: 'Thin', score: 30, results };
}

/** Same pool, sentiment on enough cells that nothing is small-sampled. */
function summaryWithFullSentiment() {
  const s = summaryWithThinSentiment();
  s.date = '2026-07-16';
  for (const r of s.results) {
    if (r.mention === 'yes') r.sentiment = { label: 'positive', confidence: 'high' };
  }
  return s;
}

test('a row reports the composite the canonical module computes — it never derives one itself', () => {
  for (const summary of [summaryWithThinSentiment(), summaryWithFullSentiment()]) {
    const row = rowFor(summary);
    assert.equal(row.v2, computeUVI(computeComponents(summary)),
      'the script must delegate the composite, not re-implement it');
    assert.equal(row.date, summary.date);
    assert.equal(row.cells, summary.results.length);
  }
});

test('the guard column is what tells a reader whether v1 and v2 can differ at all', () => {
  const thin = rowFor(summaryWithThinSentiment());
  assert.equal(thin.guardFired, true, 'two sentiment-bearing cells must trip the small-sample guard');
  assert.ok(thin.uncounted.some(u => u.startsWith('sentiment')),
    `the excluded axis must be named with its n; got ${JSON.stringify(thin.uncounted)}`);

  const full = rowFor(summaryWithFullSentiment());
  assert.equal(full.guardFired, false, 'a well-sampled run must not be flagged');
  assert.deepEqual(full.uncounted, [], 'nothing to exclude means an empty list, not a placeholder');
});

test('the stored headline is carried through untouched and never mixed into the composite', () => {
  const summary = summaryWithThinSentiment();
  const row = rowFor(summary);
  // It is a mention rate, not an index. The script must surface it as-is; the
  // moment anything subtracts it from `v2` the table is comparing a rate with
  // an index, which is the error this column's label exists to prevent.
  assert.equal(row.storedHeadline, 30);
  assert.equal(row.delta, row.v1 - row.v2, 'the delta is between the two composites and nothing else');
  assert.notEqual(row.delta, row.storedHeadline - row.v2);
});

test('v1 is the same module with the guard floor at zero — never a second formula', () => {
  for (const summary of [summaryWithThinSentiment(), summaryWithFullSentiment()]) {
    const components = computeComponents(summary);
    assert.equal(rowFor(summary).v1, computeUVI(components, undefined, 0),
      'the pre-v2 composite must be recovered through the canonical module');
  }
});

test('a run the guard never matched scores identically under both versions', () => {
  const row = rowFor(summaryWithFullSentiment());
  assert.equal(row.guardFired, false);
  assert.equal(row.delta, 0, 'no guarded axis means no re-normalisation means no movement');
  assert.equal(row.v1, row.v2);
});

test('dropping a WEAK axis raises the composite — the delta sign is not fixed', () => {
  // The claim this file exists to disprove: "the guard fired, so the client was
  // shown an inflated number." The guard re-normalises over what is left, so a
  // thin axis scoring BELOW the rest pulls the composite down while it counts
  // and releases it when excluded. Here sentiment is measured on two cells and
  // both are negative, so v2 must come out ABOVE v1.
  const s = summaryWithThinSentiment();
  s.results[0].sentiment = { label: 'negative', confidence: 'high' };
  s.results[1].sentiment = { label: 'negative', confidence: 'high' };
  const row = rowFor(s);
  assert.equal(row.guardFired, true, 'two sentiment cells must still trip the guard');
  assert.ok(row.delta < 0,
    `excluding a negative-sentiment axis must raise the score; got v1=${row.v1} v2=${row.v2}`);
});

test('the axes the guard can touch are never the ones that always count', () => {
  // Why this is worth pinning: `resolveAxes` carries a stand-down branch for
  // "the guard matched every measured axis", and a row hitting it would be
  // flagged while scoring identically under both versions — which would make
  // the guard column mean something different from the delta column. It cannot
  // happen: the guard only ever considers sentiment and rank, while presence
  // and citation come out of `computeComponents` as numbers on every path
  // (0 with no cells at all), so a measured axis the guard cannot touch always
  // survives. A single-cell run — the most guarded a run can be — still moves.
  const summary = {
    date: '2026-01-01', domain: 'tiny.example', brand: 'Tiny', score: 50,
    results: [cell(1, { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high' } })],
  };
  const components = computeComponents(summary);
  assert.equal(typeof components.presence, 'number', 'presence must never be null');
  assert.equal(typeof components.citation, 'number', 'citation must never be null');

  const row = rowFor(summary);
  assert.deepEqual(row.uncounted.map(u => u.split(' ')[0]).sort(), ['rank', 'sentiment']);
  assert.notEqual(row.delta, 0, 'with two axes dropped and two kept, the composite has to move');
});

test('every summary in a nested tree is found, and nothing else is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uvi-baseline-'));
  try {
    mkdirSync(join(dir, 'clientA', 'aeo-responses', '2026-01-01'), { recursive: true });
    mkdirSync(join(dir, 'clientB', 'aeo-responses', '2026-02-02'), { recursive: true });
    mkdirSync(join(dir, 'clientB', 'aeo-reports', '2026-02-02'), { recursive: true });
    writeFileSync(join(dir, 'clientA', 'aeo-responses', '2026-01-01', '_summary.json'), '{}');
    writeFileSync(join(dir, 'clientB', 'aeo-responses', '2026-02-02', '_summary.json'), '{}');
    // Neither of these is a stored run and neither may be picked up.
    writeFileSync(join(dir, 'clientB', 'aeo-reports', '2026-02-02', 'report.md'), '# not a summary');
    writeFileSync(join(dir, 'clientA', 'notes.json'), '{}');

    const found = findSummaries(dir);
    assert.equal(found.length, 2, `expected both nested summaries, got ${JSON.stringify(found)}`);
    assert.ok(found.every(f => f.endsWith('_summary.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
