// AP-UVI-V2-SMALL-SAMPLE-GUARD — an axis backed by 1–2 cells must not carry
// full weight in the composite.
//
// PROVENANCE OF THE FIXTURE. `test/fixtures/uvi-small-sample-run.json` is a
// shape-only reduction of a REAL run (WS-CLIENT-4, 2026-07-15, 21 cells): every
// field `computeComponents` reads was copied verbatim, everything else —
// response bodies, citation URLs, the client's own domain — was dropped, since
// this package ships to npm. The reduction is arithmetically lossless: the
// fixture yields the same components the live run does.
//
//   node -e "import('./lib/report/visibility-index.js').then(async m => { \
//     const fs = await import('node:fs'); \
//     const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); \
//     const c = m.computeComponents(s); console.log(c, m.computeUVI(c)); })" \
//     ~/Projects/clients/verawang/aeo-responses/2026-07-15-internal-7q-with-brand-probe/_summary.json
//
//   → { presence: 14, sentiment: 100, rank: 70, citation: 0,
//       sample: 21, sentimentSample: 2, rankSample: 1 }   UVI v1 = 44
//
// 3 of 21 answers named the brand, and the report called it 44/100 — because a
// sentiment averaged over TWO cells and a rank taken from ONE (both echoes of
// the brand-probe query) carried 45% of the weight. Under v2 those two axes are
// reported but not counted, presence+citation re-normalise over 0.55, and the
// same run scores 9.
//
// MUTATION CHECK (run by hand 2026-09-20, must be redone if the guard moves):
// neutralise `smallSampleGuard` in lib/report/visibility-index.js by returning
// `new Map()` unconditionally → the first assertion below fails with 44 vs 9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  computeComponents,
  computeUVI,
  computeUVIBreakdown,
  smallSampleGuard,
  axisSampleSize,
  SMALL_SAMPLE_MIN,
  UVI_VERSION,
} from '../lib/report/visibility-index.js';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';

const run = JSON.parse(readFileSync(new URL('./fixtures/uvi-small-sample-run.json', import.meta.url), 'utf8'));

test('the precedent run: a 2-cell sentiment and a 1-cell rank no longer inflate the composite', () => {
  const c = computeComponents(run);

  // The components themselves are unchanged — the guard changes what is
  // WEIGHTED, not what is measured. If these drift, the fixture went stale.
  assert.equal(c.presence, 14);
  assert.equal(c.sentiment, 100);
  assert.equal(c.rank, 70);
  assert.equal(c.citation, 0);
  assert.equal(c.sample, 21);
  assert.equal(c.sentimentSample, 2);
  assert.equal(c.rankSample, 1);

  // v1 published 44 for this run. v2 publishes 9.
  assert.equal(computeUVI(c), 9, 'guarded composite = (14×0.35 + 0×0.20) / 0.55');
});

test('breakdown reports the guarded axes instead of hiding them', () => {
  const b = computeUVIBreakdown(computeComponents(run));

  assert.equal(b.uvi, 9);
  assert.equal(b.uvi, computeUVI(computeComponents(run)), 'breakdown and computeUVI never disagree');
  assert.equal(b.uviVersion, UVI_VERSION);
  assert.equal(b.weightSum, 0.55, 'only presence + citation are weighted');

  assert.deepEqual(
    b.guarded.map(g => [g.key, g.n]).sort(),
    [['rank', 1], ['sentiment', 2]],
  );

  const byKey = Object.fromEntries(b.rows.map(r => [r.key, r]));

  // A guarded axis KEEPS its value — the reader must see «100, n=2, not
  // counted», not a blank that reads as "never measured".
  assert.equal(byKey.sentiment.value, 100);
  assert.equal(byKey.sentiment.counted, false);
  assert.equal(byKey.sentiment.appliedWeight, null);
  assert.equal(byKey.sentiment.contribution, null);
  assert.equal(byKey.sentiment.lowConfidence, true);
  assert.equal(byKey.sentiment.excludedReason, 'small-sample');

  assert.equal(byKey.rank.value, 70);
  assert.equal(byKey.rank.counted, false);

  assert.equal(byKey.presence.counted, true);
  assert.equal(byKey.presence.lowConfidence, false);
  assert.equal(byKey.presence.excludedReason, null);

  // `excluded` keeps its v1 meaning — NEVER MEASURED, not "small sample".
  // Consumers (run-comparison.js) read it as "this run has no such signal".
  assert.deepEqual(b.excluded, []);

  // The rows still reconstruct the headline by hand.
  const sum = b.rows.filter(r => r.counted).reduce((s, r) => s + r.contribution, 0);
  assert.equal(Math.round(sum), b.uvi);
});

test('the Mission Control payload publishes the same guarded number plus its version', () => {
  const meta = buildMcMetadata(run);

  assert.equal(meta.scores.uvi, 9, 'MC payload must not publish the ungated 44');
  assert.equal(meta.scores.uviVersion, UVI_VERSION);
  assert.deepEqual(
    meta.scores.lowConfidence.map(x => [x.axis, x.n]).sort(),
    [['rank', 1], ['sentiment', 2]],
  );
  // The axis values themselves still ship — the portal renders them next to
  // their sample sizes.
  assert.equal(meta.scores.sentiment, 100);
  assert.equal(meta.scores.sentimentSample, 2);
});

test('an axis at the floor is counted; one below it is not', () => {
  const atFloor = { presence: 50, sentiment: 100, rank: null, citation: 0, sample: 10, sentimentSample: SMALL_SAMPLE_MIN, rankSample: 0 };
  assert.equal(smallSampleGuard(atFloor).size, 0, 'n === minSample passes');

  const belowFloor = { ...atFloor, sentimentSample: SMALL_SAMPLE_MIN - 1 };
  assert.equal(smallSampleGuard(belowFloor).has('sentiment'), true);
  assert.ok(computeUVI(atFloor) > computeUVI(belowFloor), 'dropping a 100 axis lowers the composite');
});

test('presence and citation are never guarded — a thin run reads as barely measured, not invisible', () => {
  // Two cells, both hits. Guarding presence/citation here would leave nothing
  // to weight, collapse weightSum to 0 and publish UVI 0 — "invisible" — for a
  // brand that was named in every answer we asked for.
  const thin = {
    domain: 'example-brand.eu',
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes', position: null, sentiment: null, canonicalCitations: [] },
      { query: 'q2', provider: 'openai', mention: 'yes', position: null, sentiment: null, canonicalCitations: [] },
    ],
  };
  const c = computeComponents(thin);
  assert.equal(c.sample, 2);
  assert.equal(smallSampleGuard(c).size, 0, 'only sentiment/rank are guardable, and both are null here');
  assert.equal(computeUVI(c), 64, '(100×0.35 + 0×0.20) / 0.55 — presence still counts');

  const b = computeUVIBreakdown(c);
  const presence = b.rows.find(r => r.key === 'presence');
  assert.equal(presence.counted, true);
  assert.equal(presence.lowConfidence, true, 'counted, but flagged: the whole run is 2 cells');
});

test('the guard narrows the composite, it never empties it', () => {
  // Every measured axis is small-sampled: presence/citation absent entirely,
  // sentiment over 1 cell. Guarding it would leave weightSum 0 → UVI 0, which
  // asserts invisibility we did not measure. The guard stands down instead.
  const allThin = { presence: null, sentiment: 100, rank: null, citation: null, sample: 1, sentimentSample: 1, rankSample: 0 };
  assert.equal(smallSampleGuard(allThin).size, 1, 'the axis IS small-sampled');
  assert.equal(computeUVI(allThin), 100, 'but with nothing left to weight, v1 math applies');

  const b = computeUVIBreakdown(allThin);
  assert.deepEqual(b.guarded, [], 'a stood-down guard reports nothing as guarded');
  assert.equal(b.rows.find(r => r.key === 'sentiment').counted, true);
});

test('an unreported sample size is unknown, not small — legacy components keep v1 math', () => {
  // Hand-built components objects (older callers, tests) carry no sample
  // fields. Guarding them on a number nobody reported would silently rewrite
  // historical scores.
  const noSamples = { presence: 100, sentiment: 100, rank: 100, citation: 100 };
  assert.equal(axisSampleSize(noSamples, 'sentiment'), null);
  assert.equal(smallSampleGuard(noSamples).size, 0);
  assert.equal(computeUVI(noSamples), 100);
});
