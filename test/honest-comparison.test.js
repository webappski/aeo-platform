// MEAS-3 (+ the MEAS-2 back-compat floor) — a comparison may only subtract
// measurements of the same question, and a re-scored historical run must land
// on the number that run published.
//
// The two real runs this file reads are committed projections of
// `~/Projects/webappka/aeo-responses/webappski.com/{2026-08-27,2026-08-31}/
// _summary.json`, produced by `scripts/trim-run-fixture.mjs` (see each file's
// `_provenance` block). They are trimmed to the fields scoring and comparison
// read; nothing about the counts under test is changed by the trim, which is
// why the published headline travels inside the fixture and is asserted here.
//
// R37: pure arithmetic and pure set logic — unit-tested against exact expected
// values, the same standard lib/sampling.js states in its header.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diff } from '../lib/diff.js';
import { aggregateScore } from '../lib/score.js';
import { sectionDiff, sectionRunComparison, sectionTrend } from '../lib/report/sections.js';
import { renderMarkdown } from '../lib/report/markdown.js';
import { segmentCells, findBlankQueries } from '../lib/report/comparison-segments.js';
import { buildRunComparison } from '../lib/report/run-comparison.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(HERE, 'fixtures', f), 'utf-8'));

const RUN_0827 = load('run-2026-08-27.trimmed.json');
const RUN_0831 = load('run-2026-08-31.trimmed.json');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nFIXTURE 3 — a question whose text changed is not the same question');

test('same ordinal label, different text → incomparable, and named as such', () => {
  const a = {
    score: 50,
    results: [
      { query: 'Q1', queryText: 'best aeo agencies 2026', provider: 'openai', mention: 'yes' },
      { query: 'Q2', queryText: 'ai visibility checker', provider: 'openai', mention: 'no' },
    ],
  };
  const b = {
    score: 50,
    results: [
      // Q1 was re-worded between runs. Pre-MEAS-3 this pair was compared as one
      // cell because both were called "Q1".
      { query: 'Q1', queryText: 'best aeo agencies 2027', provider: 'openai', mention: 'no' },
      { query: 'Q2', queryText: 'ai visibility checker', provider: 'openai', mention: 'no' },
    ],
  };
  const d = diff(a, b);

  assert.equal(d.basket.comparable, 1, 'only the untouched question is comparable');
  assert.equal(d.basket.incomparable, 1, 'the re-worded question must be counted, not silently paired');
  assert.equal(d.basket.retired, 1, 'and its predecessor must be counted as no longer asked');
  assert.equal(d.basket.onlyInNew[0].text, 'best aeo agencies 2027');
  assert.equal(d.basket.onlyInBaseline[0].text, 'best aeo agencies 2026');
  assert.equal(d.cellChanges.length, 0, 'yes → no across two different questions is not a loss');
  assert.equal(d.scoreDelta, null, 'the baskets differ, so the overall delta is not a fact');
  assert.equal(d.scoreDeltaReason, 'basket-changed');
});

test('identical baskets still report a plain score delta (back-compat)', () => {
  const a = { score: 40, results: [{ query: 'Q1', queryText: 'same question', provider: 'openai', mention: 'no' }] };
  const b = { score: 55, results: [{ query: 'Q1', queryText: 'same question', provider: 'openai', mention: 'yes' }] };
  const d = diff(a, b);
  assert.equal(d.basket.changed, false);
  assert.equal(d.scoreDelta, 15);
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].queryText, 'same question');
});

test('a declared market change on the same text is incomparable, and says why', () => {
  const manifest = { queries: [{ id: 'ignored', q: 'agencja aeo', market: 'PL' }] };
  const a = { score: 0, results: [{ query: 'Q1', queryText: 'agencja aeo', market: 'PL', provider: 'openai', mention: 'no' }] };
  const b = { score: 100, results: [{ query: 'Q1', queryText: 'agencja aeo', market: 'DE', provider: 'openai', mention: 'yes' }] };
  const d = diff(a, b, { manifest });
  assert.equal(d.basket.marketChanged, 1);
  assert.equal(d.basket.comparable, 0);
  assert.equal(d.scoreDelta, null);
});

console.log('\nFIXTURE 4 — the 2026-08-31 baseline re-scores to the number it published');

test('legacy records without `presence` reproduce 13 exactly', () => {
  const published = RUN_0831._provenance.publishedHeadline;
  assert.equal(published.score, 13, 'fixture drift: this run published 13');
  assert.ok(RUN_0831.results.every(r => r.presence === undefined),
    'the whole point of this fixture is that these records predate `presence`');

  const agg = aggregateScore(RUN_0831.results);
  assert.equal(agg.score, 13, 'the new formula must not move a historical number');
  assert.deepEqual(
    { hits: agg.hits, valid: agg.valid, attempts: agg.attempts, errors: agg.errors },
    { hits: 20, valid: 150, attempts: 150, errors: 0 },
  );
});

test('`mentions` and `total` are aliases of the same computation, exact on legacy data', () => {
  // If these were computed a second way, M07 would simply move inside
  // _summary.json. On single-shot records the alias is exact: one non-error
  // cell = one valid trial.
  const agg = aggregateScore(RUN_0831.results);
  assert.equal(agg.hits, RUN_0831._provenance.publishedHeadline.mentions);
  assert.equal(agg.valid, RUN_0831._provenance.publishedHeadline.total);
  assert.equal(agg.cells, RUN_0831._provenance.publishedHeadline.cells);

  const agg27 = aggregateScore(RUN_0827.results);
  assert.equal(agg27.score, RUN_0827._provenance.publishedHeadline.score);
  assert.equal(agg27.hits, RUN_0827._provenance.publishedHeadline.mentions);
  assert.equal(agg27.valid, RUN_0827._provenance.publishedHeadline.total);
});

console.log('\nFIXTURE 5 — the real 2026-08-27 → 2026-08-31 pair');

test('31 comparable questions, 19 incomparable, and no overall score delta', () => {
  const d = diff(RUN_0827, RUN_0831);

  assert.equal(d.basket.comparable, 31, 'the two baskets share 31 questions');
  assert.equal(d.basket.incomparable, 19, '19 questions on 2026-08-31 have no baseline');
  assert.equal(d.basket.retired, 25, '25 questions asked on 2026-08-27 were dropped');
  assert.equal(d.basket.questionsBaseline, 56);
  assert.equal(d.basket.questionsNew, 50);
  assert.equal(d.basket.identity, 'text', 'both runs carry queryText, so identity is not positional');

  assert.equal(d.scoreDelta, null,
    '1% → 13% across two different baskets is a change of questions, not of visibility');
  assert.equal(d.scoreDeltaReason, 'basket-changed');
});

test('the like-for-like delta is reported instead, stamped with what it rests on', () => {
  const d = diff(RUN_0827, RUN_0831);
  assert.equal(d.intersection.questionsCompared, 31);
  assert.equal(d.intersection.cellsCompared, 93, '31 questions × 3 engines');
  assert.deepEqual(
    { a: d.intersection.scoreA, b: d.intersection.scoreB, delta: d.intersection.delta },
    { a: 1, b: 8, delta: 7 },
    'on the questions both runs asked, the move is +7pp — not the +12pp the headline implied',
  );
  assert.equal(d.intersection.validA, 93);
  assert.equal(d.intersection.validB, 93);
});

test('every emitted cell change belongs to a question both runs asked', () => {
  const d = diff(RUN_0827, RUN_0831);
  const sharedTexts = new Set(
    RUN_0827.results.map(r => r.queryText).filter(t => RUN_0831.results.some(x => x.queryText === t)),
  );
  assert.ok(d.cellChanges.length > 0, 'the real pair does contain genuine movement');
  for (const ch of d.cellChanges) {
    assert.ok(sharedTexts.has(ch.queryText),
      `cell change on a question only one run asked: ${ch.queryText}`);
  }
});

console.log('\nFIXTURE 5b — the REPORT surfaces, on the same real pair');

// `lib/diff.js` is the CLI's comparison. The document a client reads is built
// by other code, and that code had the same defect keyed the same way:
//   - sections.js  sectionDiff       → the "What Changed" table, which ships
//                                      inside renderWhiteLabelMarkdown;
//   - comparison-segments.js cellKey → segmentCells, on which run-comparison.js
//                                      (its own docs: "single source of truth"
//                                      for the run verdict) is built.
// Before 2026-09-15 `sectionDiff` produced TWENTY green "no → yes" rows on this
// pair — pairs of two different questions that happen to share an ordinal
// label. These tests exist so that can never be true again on either surface.

const sharedTexts = new Set(
  RUN_0827.results.map(r => r.queryText).filter(t => RUN_0831.results.some(x => x.queryText === t)),
);

test('the "What Changed" table lists only questions BOTH runs asked', () => {
  const md = sectionDiff([RUN_0827, RUN_0831]);
  const rows = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Δ') && !l.startsWith('|---'));
  assert.ok(rows.length > 0, 'the real pair does contain genuine movement');
  for (const row of rows) {
    const cells = row.split('|').map(s => s.trim());
    const queryCell = cells[3] || '';
    const text = queryCell.includes('—') ? queryCell.split('—').slice(1).join('—').trim() : '';
    assert.ok(text, `a change row must name the question, got: ${queryCell}`);
    const matched = [...sharedTexts].some(t => t.startsWith(text.replace(/\s*_\(.*\)_$/, '')));
    assert.ok(matched, `"What Changed" row on a question only one run asked: ${text}`);
  }
});

test('the table and the CLI diff report the SAME movement, not two stories', () => {
  const md = sectionDiff([RUN_0827, RUN_0831]);
  const rows = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Δ') && !l.startsWith('|---'));
  const d = diff(RUN_0827, RUN_0831);
  assert.equal(rows.length, d.cellChanges.length,
    `the client table shows ${rows.length} changes and the CLI diff ${d.cellChanges.length} — one of them is inventing rows`);
  assert.equal(rows.length, 6, 'six real cell changes on this pair');
});

test('the table states that the two runs did not ask the same questions', () => {
  const md = sectionDiff([RUN_0827, RUN_0831]);
  assert.match(md, /did not ask the same questions/,
    'a client reading this table must be told it does not cover the whole period');
  assert.match(md, /19 asked only on 2026-08-31/);
  assert.match(md, /25 asked only on 2026-08-27/);
});

test('the white-label client document carries the corrected table, not the old one', () => {
  // renderWhiteLabelMarkdown composes sectionDiff — the paid deliverable is
  // where a fabricated gain does the most damage.
  const md = renderMarkdown([RUN_0827, RUN_0831], {}, { whiteLabel: true });
  // Bound the slice at the next heading — the sections that follow carry their
  // own tables, and counting those would make this assertion meaningless.
  const section = (md.split('## What Changed')[1] || '').split('\n## ')[0];
  assert.ok(section, 'the white-label document still contains the What Changed section');
  assert.match(section, /did not ask the same questions/,
    'the client document must state the basket change');
  const rows = section.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Δ') && !l.startsWith('|---'));
  assert.equal(rows.length, 6, `white-label showed ${rows.length} change rows instead of 6`);
});

test('segmentCells never calls a question only one run asked a gain, a loss or a never', () => {
  const segments = segmentCells(RUN_0831, RUN_0827);
  for (const seg of ['lost', 'held', 'gained', 'never']) {
    for (const entry of segments[seg]) {
      assert.ok(sharedTexts.has(entry.queryText),
        `${seg} segment contains a question only one run asked: ${entry.queryText}`);
      assert.ok(entry.before && entry.after, `${seg} entry is missing one of its two sides`);
    }
  }
  // …and the ones it refused to classify are counted, not dropped.
  const incomparableQuestions = new Set(segments.incomparable.map(e => e.queryId));
  assert.equal(incomparableQuestions.size, 44, '19 new + 25 retired questions');
  assert.equal(segments.incomparable.length, 132, '44 questions × 3 engines');
  assert.ok(segments.incomparable.every(e => e.askedIn !== 'both'));
});

test('the run-comparison model publishes the size of the basket change', () => {
  const model = buildRunComparison([RUN_0827, RUN_0831]);
  assert.equal(model.counts.incomparableQuestions, 44);
  assert.equal(model.counts.incomparable, 132);
  // The four decision counts must now describe the 31 shared questions only.
  const decided = model.counts.lost + model.counts.held + model.counts.gained
    + model.counts.never + model.counts.indeterminate;
  assert.equal(decided, 93, '31 shared questions × 3 engines — nothing else may be classified');
});

test('the run-comparison section states the basket change next to the figures it qualifies', () => {
  const md = sectionRunComparison([RUN_0827, RUN_0831]);
  assert.match(md, /A note on the questions/);
  assert.match(md, /44 questions \(132 answers\)/);
});

test('a rewritten basket is never rendered as "visibility held steady"', () => {
  // The hazard introduced by the fix itself: incomparable cells keep lost and
  // gained at zero, which is exactly the shape of the calm message. A basket
  // rewrite with no comparable movement must not read as a quiet week.
  const mk = (texts, mention) => ({
    date: '2026-01-01', domain: 'x.com', score: 0,
    results: texts.map((t, i) => ({ query: `Q${i + 1}`, queryText: t, provider: 'openai', model: 'm', mention })),
  });
  const prev = mk(['old question one', 'old question two'], 'no');
  const curr = { ...mk(['new question one', 'new question two'], 'no'), date: '2026-01-08' };
  const md = sectionRunComparison([prev, curr]);
  assert.ok(!/held steady/.test(md), 'a report that changed every question must not claim stability');
  assert.match(md, /A note on the questions/);
});

test('a trend sparkline never draws one line through two different questions', () => {
  // Four runs (TREND_MIN_RUNS) where slot Q1 is reworded halfway through. The
  // slot-keyed version drew a single continuous line; the question-keyed one
  // draws two lines, each with gaps where its question was not asked.
  const run = (date, q1text) => ({
    date, domain: 'x.com', score: 0,
    results: [{ query: 'Q1', queryText: q1text, provider: 'openai', model: 'm', mention: 'yes' }],
  });
  const md = sectionTrend([
    run('2026-01-01', 'question A'),
    run('2026-01-08', 'question A'),
    run('2026-01-15', 'question B'),
    run('2026-01-22', 'question B'),
  ]);
  const lines = md.split('\n').filter(l => l.startsWith('- '));
  assert.equal(lines.length, 2, 'two different questions must get two lines, not one merged trend');
  assert.ok(lines.some(l => l.includes('question A')));
  assert.ok(lines.some(l => l.includes('question B')));
});

test('a dropped engine is credited only with the answers its absence explains', () => {
  // Both axes at once: an engine dropped AND a changed basket. The engine's
  // "N answers left out" figure must count only the shared questions it stopped
  // answering (31) — not the 44 questions nobody asked it, which are excluded
  // for a reason that has nothing to do with the engine.
  const bDropped = { ...RUN_0831, results: RUN_0831.results.filter(r => r.provider !== 'anthropic') };
  const model = buildRunComparison([RUN_0827, bDropped]);
  assert.equal(model.coverageChange.dropped.length, 1);
  assert.equal(model.coverageChange.dropped[0].cells, 31,
    'the engine may only own the shared questions it stopped answering');
  assert.ok(model.counts.incomparable > 100, 'the basket change is still counted — just not against the engine');
});

test('"never held in either run" is computed per question, not per slot', () => {
  const blanks = findBlankQueries(RUN_0831, RUN_0827);
  for (const b of blanks) {
    assert.ok(sharedTexts.has(b.queryText),
      `blank-query claim about a question the previous run never asked: ${b.queryText}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
