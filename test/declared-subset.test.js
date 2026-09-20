// AP-RUNMANUAL-DECLARED-SUBSET — a manual leg that covers part of the basket
// on purpose imports instead of being refused, and the gap is recorded rather
// than guessed at.
//
// THE REAL GEOMETRY. The numbers below are the actual Claude leg of
// 2026-09-16: questions 1, 2, 3, 4, 5, 12, 17, 26, 27, 31, 33, 34, 40, 44, 46
// of a 50-question basket (the fixed subsample recorded in
// `resources/webappski/runs/claude-leg-2026-09-16/SUBSET.md` in the ops repo).
// The test builds a temp directory with exactly that shape rather than reading
// the real one, so it is deterministic and does not reach into another repo's
// working tree; the bodies do not matter here, only which files exist.
//
// MUTATION CHECKS (run by hand 2026-09-20 — redo them if this logic moves):
//   - make `planSubsetCoverage` report every query as covered → the
//     "undeclared import still refuses" and coverage assertions fail;
//   - value a `missing` cell as measured in `computeComponents` (drop the
//     `isMeasuredMention` filter) → "unasked questions stay out of every
//     denominator" fails with presence 20 instead of 67.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDeclaredSubset,
  planSubsetCoverage,
  buildDeclaredSubsetStamp,
  buildMissingCell,
  buildDeclaredSubsetCaveat,
} from '../lib/declared-subset.js';
import { cellCounts, aggregateScore, isMeasuredMention } from '../lib/score.js';
import { computeComponents, computeUVI } from '../lib/report/visibility-index.js';
import { buildLiftOpportunity } from '../lib/report/run-metrics.js';
import { sectionCompetitorIntelligence } from '../lib/report/sections.js';

const CLAUDE_LEG_2026_09_16 = [1, 2, 3, 4, 5, 12, 17, 26, 27, 31, 33, 34, 40, 44, 46];
const BASKET = 50;

function pasteDirWith(questionNumbers) {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-declared-subset-'));
  for (const n of questionNumbers) writeFileSync(join(dir, `q${n}.txt`), `answer body for q${n}\n`);
  return dir;
}

test('the flag is read in both spellings, and its absence is not a subsample', () => {
  const base = ['anthropic', '--from-dir', '/tmp/x'];
  assert.equal(parseDeclaredSubset([...base, '--declared-subset=claude-leg-15of50']), 'claude-leg-15of50');
  assert.equal(parseDeclaredSubset([...base, '--declared-subset', 'claude-leg-15of50']), 'claude-leg-15of50');
  assert.equal(parseDeclaredSubset(base), null);
  assert.equal(parseDeclaredSubset([...base, '--declared-subset']), null, 'a bare flag names nothing');
  assert.equal(parseDeclaredSubset([...base, '--declared-subset', '--html']), null, 'the next flag is not a name');
});

test('the real 15-of-50 leg: coverage is split exactly, nothing is inferred', () => {
  const dir = pasteDirWith(CLAUDE_LEG_2026_09_16);
  const queries = Array.from({ length: BASKET }, (_, i) => `query text ${i + 1}`);

  const { covered, uncovered } = planSubsetCoverage({
    queries,
    hasFile: (n) => existsSync(join(dir, `q${n}.txt`)),
  });

  assert.deepEqual(covered, CLAUDE_LEG_2026_09_16);
  assert.equal(uncovered.length, 35);
  assert.equal(covered.length + uncovered.length, BASKET, 'every question lands in exactly one bucket');
  assert.ok(!uncovered.includes(1) && uncovered.includes(6));
});

test('the stamp names the subsample, its coverage, and why the number is not a percentage', () => {
  const stamp = buildDeclaredSubsetStamp({
    name: 'claude-leg-15of50',
    provider: 'Claude',
    covered: CLAUDE_LEG_2026_09_16,
    total: BASKET,
  });

  assert.equal(stamp.covered, 15);
  assert.equal(stamp.total, 50);
  assert.deepEqual(stamp.questions, CLAUDE_LEG_2026_09_16);
  assert.match(stamp.warning, /15 of 50/);
  assert.match(stamp.warning, /not a visibility percentage/);
  assert.match(stamp.warning, /not misses/);

  const caveat = buildDeclaredSubsetCaveat(stamp);
  assert.match(caveat.title, /Claude answered 15 of 50/);
  assert.match(caveat.sentences[0], /other 35 questions were never put to this engine/);
  assert.equal(caveat.sentences[1], stamp.warning);
  assert.equal(buildDeclaredSubsetCaveat(null), null, 'a full leg carries no caveat');
});

test('an unasked cell is neither a hit nor a miss nor a failed call', () => {
  const cell = buildMissingCell({
    index: 6, queryText: 'query text 6', queryId: 'qid-6',
    provider: 'anthropic', label: 'Claude', model: 'manual',
    subsetName: 'claude-leg-15of50',
  });

  assert.equal(cell.mention, 'missing');
  assert.equal(isMeasuredMention(cell.mention), false);
  assert.deepEqual(cellCounts(cell), { hits: 0, valid: 0, attempts: 0, errors: 0 },
    'not a hit, not a denominator slot, and not an error');
  assert.equal(cell.queryId, 'qid-6', 'stays identity-comparable with the same question on another leg');
  assert.equal(cell.position, null);
  assert.equal(cell.sentiment, undefined, 'no tone was observed, so none is recorded');
  assert.match(cell.notAskedReason, /^declared-subset:/);
});

test('unasked questions stay out of every denominator the report publishes', () => {
  // Three answered cells (2 hits), and the rest of a 50-question basket unasked.
  const asked = [
    { query: 'Q1', provider: 'anthropic', mention: 'yes', position: 1, canonicalCitations: [], sentiment: { label: 'positive', confidence: 'high' } },
    { query: 'Q2', provider: 'anthropic', mention: 'yes', position: 2, canonicalCitations: [], sentiment: { label: 'positive', confidence: 'high' } },
    { query: 'Q3', provider: 'anthropic', mention: 'no', position: null, canonicalCitations: [], sentiment: null },
  ];
  const unasked = [4, 5, 6].map((n) => buildMissingCell({
    index: n, queryText: `query text ${n}`, provider: 'anthropic', label: 'Claude',
    model: 'manual', subsetName: 'claude-leg-15of50',
  }));
  const summary = { domain: 'example-brand.eu', results: [...asked, ...unasked] };

  const agg = aggregateScore(summary.results);
  assert.equal(agg.valid, 3, 'three questions were asked');
  assert.equal(agg.hits, 2);
  assert.equal(agg.score, 67, 'score is over what was asked, not over the basket');
  assert.equal(agg.errors, 0, 'an unasked question is not a failed call');

  const c = computeComponents(summary);
  assert.equal(c.sample, 3, 'the UVI sample is the asked cells, not six');
  assert.equal(c.presence, 67, 'with the unasked cells counted this would read 33');
  assert.ok(computeUVI(c) > 0);

  const lift = buildLiftOpportunity(summary);
  assert.equal(lift.absent, 1, 'only the answered-and-unnamed cell is absent');
  assert.equal(lift.notAsked, 3, 'the unasked ones have their own bucket');
  assert.equal(lift.errored, 0);
});

test('the Competitor Intelligence gap line counts gaps, not unasked questions', () => {
  // The FIFTH surface of the same class, missed when the other four were fixed
  // and caught by the 2026-09-20 code review: `N gaps found` counted every cell
  // that was not a hit, so a declared subsample's unasked cells were published
  // as competitive gaps — in `renderWhiteLabelMarkdown` too, which is the
  // client's own document. With the Claude leg running 15 of 50 in production
  // since 2026-09-16, every report was inflating this number.
  const asked = [
    { query: 'Q1', queryText: 'best widgets', provider: 'anthropic', mention: 'no', competitors: ['Acme Corp'] },
    { query: 'Q2', queryText: 'widget alternatives', provider: 'anthropic', mention: 'no', competitors: [] },
    { query: 'Q3', queryText: 'who sells widgets', provider: 'anthropic', mention: 'yes', competitors: [] },
  ];
  const unasked = [4, 5].map((n) => buildMissingCell({
    index: n, queryText: `query text ${n}`, provider: 'anthropic', label: 'Claude',
    model: 'manual', subsetName: 'claude-leg-15of50',
  }));
  const md = sectionCompetitorIntelligence([{ results: [...asked, ...unasked] }]);

  assert.match(md, /_2 gaps found/, 'two answered-and-unnamed cells are the only gaps');
  assert.doesNotMatch(md, /_4 gaps found/, 'the two unasked cells must not be counted');
  // Mutation-sanity: drop the isMeasuredMention guard and this reads 4.

  // An errored cell is not a gap either — and no longer wears the same status
  // string as a question nobody asked.
  const withError = sectionCompetitorIntelligence([{
    results: [...asked, ...unasked, { query: 'Q6', queryText: 'widget vendors', provider: 'anthropic', mention: 'error', competitors: [] }],
  }]);
  assert.match(withError, /_2 gaps found/, 'a failed call is not a competitive gap');
  assert.match(withError, /data-status="error"/, 'a failed call says so');
  assert.match(withError, /data-status="missing"/, 'an unasked question says so, separately');
});

test('a leg with no paste files at all is still nothing to import', () => {
  const dir = pasteDirWith([]);
  const queries = Array.from({ length: 5 }, (_, i) => `q${i + 1}`);
  const { covered, uncovered } = planSubsetCoverage({
    queries,
    hasFile: (n) => existsSync(join(dir, `q${n}.txt`)),
  });
  assert.equal(covered.length, 0);
  assert.equal(uncovered.length, 5);
});
