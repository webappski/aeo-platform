// prose-rank-wiring.test.js — INTEGRATION test for the prose-rank → UVI rank-axis
// wiring (AP-PROSE-RANK). The pure parser + merge are unit-tested in
// prose-rank.test.js; the per-trial aggregation in sampling-aggregate.test.js.
// What was UNCOVERED is the wiring that actually feeds a prose verdict into the
// score: (1) the two-model extractor turns a model JSON reply into a merged
// verdict, and (2) `computeComponents` (the UVI math the run loop persists from)
// folds that verdict into rankSample / proseRankSample at the confidence floor.
//
// Why this lives here and NOT in test/e2e/: the e2e harness spawns the CLI as a
// subprocess, and `--replay` zeroes proseRank (bin: `if (replaySrcDate) proseRank
// = null`) so prose-rank never fires under replay — the only offline e2e path.
// Firing it for real needs a stubbed HTTP boundary, which a subprocess can't
// receive. So we drive the SAME functions the run loop calls, in-process, with
// the natural `providerCall` seam the production code already exposes — no
// product edit, no test-only env hook (R37 nelgущий). The fake stubs ONLY the
// network round-trip; parseProseRankResponse + mergeProseRanks + usableProseRank
// + computeComponents all execute for real.
//
// MUTATION-SANITY (verified out-of-tree against a /tmp copy of
// lib/report/visibility-index.js — the repo file is never edited):
//   - drop the list-position guard in the proseRanked filter (count a list-rank
//     cell ALSO as prose) → "list-rank cell is NOT double-counted as prose" RED
//     (proseRankSample would become 1, rankSample would not match listed+prose).
//   - widen the confidence floor to admit 'none'/'failed' → "a null-rank /
//     no-confidence verdict contributes nothing to the rank axis" RED
//     (proseRankSample would become 1 on the no-order cell).

import assert from 'node:assert/strict';
import { extractProseRankWithTwoModels } from '../lib/report/prose-rank.js';
import { computeComponents, usableProseRank } from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

// A fake provider descriptor with the exact shape extractProseRankWithTwoModels
// consumes: { name, apiKey, model, providerCall }. `providerCall(prompt, apiKey,
// model, opts)` is the ONE network boundary — we return a canned strict-JSON
// body + a raw usage object so the real extractUsage/calcCost run (model id is a
// real priced one so calcCost returns a number, not null). Everything else —
// parseProseRankResponse, mergeProseRanks, the cost roll-up — is real.
function fakeProvider(name, model, replyJson) {
  return {
    name,
    apiKey: 'fake-key-not-used',
    model,
    providerCall: async (_prompt, _apiKey, _model, _opts) => ({
      text: replyJson,
      raw: { usage: { prompt_tokens: 120, completion_tokens: 30 } },
    }),
  };
}

const PROSE_TEXT =
  'The leading option for this is Profound, followed by TestBrand, with a budget pick after that.';

console.log('\nextractProseRankWithTwoModels — two-model verdict from canned model replies');

await test('both models agree rank 2 of 4 → merged { rank:2, confidence:"med" }', async () => {
  const reply = '{"rank": 2, "comparableCount": 4, "rationale": "named second after Profound"}';
  const verdict = await extractProseRankWithTwoModels({
    text: PROSE_TEXT,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    primary:   fakeProvider('openai', 'gpt-5-mini', reply),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash-lite', reply),
  });
  assert.equal(verdict.rank, 2, 'agreed rank surfaces');
  assert.equal(verdict.confidence, 'med', 'agreement on prose is capped at med, never high');
  // Cost rolled up from BOTH stub calls (real extractUsage + calcCost path).
  assert.ok(verdict.costInfo && verdict.costInfo.costUsd > 0,
    'cost is summed across the two model calls via the real pricing helpers');
  // The merged verdict is exactly the shape the run loop persists into the cell.
  assert.ok(usableProseRank({ rank: verdict.rank, confidence: verdict.confidence }),
    'the produced verdict passes the same usableProseRank gate the UVI math applies');
});

await test('models disagree (2 vs 4) → lower rank, confidence low (still usable)', async () => {
  const verdict = await extractProseRankWithTwoModels({
    text: PROSE_TEXT,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    primary:   fakeProvider('openai', 'gpt-5-mini', '{"rank": 2, "comparableCount": 5, "rationale": "second"}'),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash-lite', '{"rank": 4, "comparableCount": 5, "rationale": "fourth"}'),
  });
  assert.equal(verdict.rank, 2, 'disagreement keeps the lower (stronger) ordinal');
  assert.equal(verdict.confidence, 'low');
  assert.ok(usableProseRank({ rank: verdict.rank, confidence: verdict.confidence }),
    'low-confidence prose ordinal is still a usable axis signal');
});

await test('both models see no comparative order (rank null) → not usable for the axis', async () => {
  const verdict = await extractProseRankWithTwoModels({
    text: 'TestBrand is a tool some people use.',
    brand: 'TestBrand',
    domain: 'testbrand.com',
    primary:   fakeProvider('openai', 'gpt-5-mini', '{"rank": null, "comparableCount": 1, "rationale": "named alone"}'),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash-lite', '{"rank": null, "comparableCount": 0, "rationale": "no order"}'),
  });
  assert.equal(verdict.rank, null);
  assert.equal(verdict.confidence, 'none');
  assert.ok(!usableProseRank({ rank: verdict.rank, confidence: verdict.confidence }),
    'a null-rank "none"-confidence verdict must NOT count toward the rank axis');
});

console.log('\ncomputeComponents — prose verdict folds into the UVI rank axis (the wiring)');

// Build a _summary-shaped object the way the run loop writes it, then run it
// through the REAL UVI math. This is the load-bearing wiring: a prose-mention
// cell (mention 'yes', no list position) carrying the merged proseRank must
// raise rankSample AND proseRankSample; a list-rank cell must count in rankSample
// but NEVER in proseRankSample (no double signal).
await test('prose-rank cell lifts rankSample + proseRankSample; list cell counts only as list', async () => {
  // Fire the real extractor to get the verdict the run loop would persist.
  const reply = '{"rank": 2, "comparableCount": 4, "rationale": "second"}';
  const proseVerdict = await extractProseRankWithTwoModels({
    text: PROSE_TEXT, brand: 'TestBrand', domain: 'testbrand.com',
    primary:   fakeProvider('openai', 'gpt-5-mini', reply),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash-lite', reply),
  });

  const summary = {
    brand: 'TestBrand',
    domain: 'testbrand.com',
    results: [
      // (a) PROSE cell: brand named, list-rank null, carries the prose verdict
      //     in the exact persisted shape (rank/confidence/rationale).
      {
        query: 'Q1', provider: 'openai', model: 'gpt-5', mode: 'web',
        mention: 'yes', position: null,
        proseRank: { rank: proseVerdict.rank, confidence: proseVerdict.confidence, rationale: proseVerdict.rationale },
        canonicalCitations: [],
      },
      // (b) LIST cell: explicit numeric position → list rank path. Even if a
      //     stray proseRank were attached, the list-position guard must keep it
      //     OUT of proseRankSample (no double count).
      {
        query: 'Q2', provider: 'openai', model: 'gpt-5', mode: 'web',
        mention: 'yes', position: 1,
        proseRank: { rank: 5, confidence: 'med', rationale: 'stray — must be ignored, list wins' },
        canonicalCitations: [],
      },
      // (c) plain mention, no rank of any kind → contributes to neither axis.
      {
        query: 'Q3', provider: 'openai', model: 'gpt-5', mode: 'web',
        mention: 'yes', position: null,
        canonicalCitations: [],
      },
    ],
  };

  const comp = computeComponents(summary);
  assert.equal(comp.rankSample, 2,
    'rank axis = 1 list cell + 1 prose cell (the plain mention contributes nothing)');
  assert.equal(comp.proseRankSample, 1,
    'exactly one cell contributed a prose ordinal');
  assert.ok(typeof comp.rank === 'number' && comp.rank > 0,
    'a non-null rank component is produced from the wired prose + list cells');
});

await test('a no-order prose verdict on a cell adds nothing to the rank axis (confidence floor)', async () => {
  // The whole run has ONE prose-mention cell whose verdict was "no order"
  // (rank null / confidence none). The floor must reject it: rank axis empty.
  const summary = {
    brand: 'TestBrand', domain: 'testbrand.com',
    results: [
      {
        query: 'Q1', provider: 'openai', model: 'gpt-5', mode: 'web',
        mention: 'yes', position: null,
        // shape a run might persist for a low-signal verdict — confidence below
        // the floor must be ignored even if a rank number slipped through.
        proseRank: { rank: 3, confidence: 'none', rationale: 'no real order' },
        canonicalCitations: [],
      },
    ],
  };
  const comp = computeComponents(summary);
  assert.equal(comp.proseRankSample, 0, 'below-floor confidence excluded from prose axis');
  assert.equal(comp.rankSample, 0, 'no list rank, no usable prose rank → empty rank axis');
  assert.equal(comp.rank, null, 'rank component is null (absent), not a fabricated number');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
