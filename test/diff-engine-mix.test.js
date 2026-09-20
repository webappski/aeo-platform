// AP-DIFF-ENGINE-MIX-AXIS — two runs that measured different ENGINES do not
// have subtractable headlines, exactly as two runs that asked different
// questions do not (D4, the basket axis).
//
// THE REAL PAIR THIS REPRODUCES. webappski.com, 2026-08-31 → 2026-09-16:
//
//   2026-08-31  openai 50 · gemini 50 · anthropic 50 = 150 cells, score 13
//   2026-09-16  openai 50 · gemini 50               = 100 cells, score 11
//
// The basket was byte-identical, so D4's gate stayed shut and the tool
// published «scoreDelta −2» with an empty reason, and the report header printed
// «11% ▼ −2pp vs 2026-08-31». Over the 100 cells the two runs share the score
// was 11 against 11 — no movement whatsoever. Verified live 2026-09-20 against
// the two real summaries:
//
//   scoreDelta null · reason engines-changed ·
//   intersection { scoreA 11, scoreB 11, delta 0, cellsCompared 100 }
//
// The fixtures below are synthetic but carry that exact geometry (same engine
// counts, same 13-vs-11 headlines, same shared-cell equality), because the real
// summaries hold a client's raw answers and live in another repository's
// working tree.
//
// MUTATION CHECKS (run by hand 2026-09-20 — redo them if this gate moves):
//   - make `headlineComparability` ignore `engines.changed` → the first two
//     tests fail, scoreDelta reappears as −2 and the hero prints «▼ −2pp»;
//   - make `measuredEngines` count errored cells → the "an engine that only
//     errored" test fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diff } from '../lib/diff.js';
import { measuredEngines, engineSetDelta, headlineComparability } from '../lib/run-axes.js';
import { sectionHero } from '../lib/report/sections.js';

const ENGINES_3 = ['openai', 'gemini', 'anthropic'];
const ENGINES_2 = ['openai', 'gemini'];

// 50 questions. `hitsPerEngine` questions are named on every engine measured,
// so each engine's rate — and the run's headline — is the same number, which is
// what makes the two runs' shared cells provably equal below.
function run(date, engines, hitsPerEngine, score) {
  const results = [];
  for (const provider of engines) {
    for (let q = 1; q <= 50; q++) {
      results.push({
        query: `Q${q}`,
        queryText: `question number ${q}`,
        provider,
        mention: q <= hitsPerEngine ? 'yes' : 'no',
        position: q <= hitsPerEngine ? 1 : null,
        canonicalCitations: [],
      });
    }
  }
  return { date, domain: 'example-brand.eu', score, results };
}

// 2026-08-31: 3 engines, ~13% headline. 2026-09-16: 2 engines, 11%.
const BASELINE_3_ENGINES = run('2026-08-31', ENGINES_3, 6, 13);
const LATER_2_ENGINES = run('2026-09-16', ENGINES_2, 6, 11);

test('the real pair: a dropped engine no longer publishes a headline delta as fact', () => {
  const d = diff(BASELINE_3_ENGINES, LATER_2_ENGINES);

  assert.equal(d.basket.changed, false, 'precondition: the basket is identical — only the engines differ');
  assert.equal(d.scoreDelta, null, 'the −2pp that shipped on 2026-09-16 must not ship again');
  assert.equal(d.scoreDeltaReason, 'engines-changed');
  assert.deepEqual(d.scoreDeltaReasons, ['engines-changed']);

  assert.equal(d.engines.changed, true);
  assert.deepEqual(d.engines.onlyInBaseline, ['anthropic']);
  assert.deepEqual(d.engines.onlyInNew, []);
  assert.deepEqual(d.engines.common, ['gemini', 'openai']);
  assert.equal(d.engines.countBaseline, 3);
  assert.equal(d.engines.countNew, 2);
  assert.match(d.engines.note, /anthropic was measured in the earlier run/);
});

test('the defensible number is still published — the intersection over shared engines', () => {
  const d = diff(BASELINE_3_ENGINES, LATER_2_ENGINES);
  assert.equal(d.intersection.cellsCompared, 100, 'two engines × fifty questions');
  assert.equal(d.intersection.scoreA, d.intersection.scoreB, 'the shared cells did not move');
  assert.equal(d.intersection.delta, 0, 'the honest answer is «no movement», not «down 2»');
});

test('the report header obeys the same gate — it used to subtract on its own', () => {
  const withheld = sectionHero([BASELINE_3_ENGINES, LATER_2_ENGINES]);
  assert.doesNotMatch(withheld, /▼ -?2pp/, 'the hero must not print the cross-basis delta');
  assert.match(withheld, /not compared to 2026-08-31/);
  assert.match(withheld, /3 engines measured then, 2 now/);
  assert.match(withheld, /different engine sets/, 'the reason travels with the withheld number');

  // Same engines both runs → the delta is a fact again and still renders.
  const comparable = sectionHero([run('2026-08-31', ENGINES_2, 8, 16), LATER_2_ENGINES]);
  assert.match(comparable, /▼ -5pp vs 2026-08-31/);
  assert.doesNotMatch(comparable, /not compared to/);
});

test('an unchanged engine set leaves the delta exactly where it was', () => {
  const a = run('2026-08-31', ENGINES_2, 8, 16);
  const d = diff(a, LATER_2_ENGINES);
  assert.equal(d.engines.changed, false);
  assert.equal(d.scoreDelta, -5, 'same basket, same engines — the headline delta is a fact');
  assert.equal(d.scoreDeltaReason, null);
  assert.equal(d.engines.note, null);
});

test('a changed basket still reports basket-changed first — the v1 contract holds', () => {
  const a = run('2026-08-31', ENGINES_2, 8, 16);
  const b = {
    ...LATER_2_ENGINES,
    results: LATER_2_ENGINES.results.map((r) => ({ ...r, queryText: `${r.queryText} rewritten` })),
  };
  const d = diff(a, b);
  assert.equal(d.basket.changed, true);
  assert.equal(d.scoreDelta, null);
  assert.equal(d.scoreDeltaReason, 'basket-changed', 'consumers that only knew this value keep working');
});

test('an engine that only errored or was never asked did not measure anything', () => {
  const withDeadEngine = {
    ...LATER_2_ENGINES,
    results: [
      ...LATER_2_ENGINES.results,
      { query: 'Q1', queryText: 'question number 1', provider: 'perplexity', mention: 'error', canonicalCitations: [] },
      { query: 'Q2', queryText: 'question number 2', provider: 'anthropic', mention: 'missing', canonicalCitations: [] },
    ],
  };
  const engines = measuredEngines(withDeadEngine);
  assert.deepEqual([...engines].sort(), ['gemini', 'openai'],
    'a provider whose every cell errored or was never asked contributed no measurement');

  // …so a run where the anthropic leg produced only unasked cells compares as
  // two engines, not three — which is what a declared subsample with zero
  // covered questions would otherwise look like.
  const delta = engineSetDelta(LATER_2_ENGINES, withDeadEngine);
  assert.equal(delta.changed, false);
  assert.equal(headlineComparability(LATER_2_ENGINES, withDeadEngine).comparable, true);
});
