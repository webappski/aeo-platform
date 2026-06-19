/**
 * E2E / integration — prose-rank PERSIST round-trip (AP-PROSE-RANK,
 * AP-CYCLE-C-E2E residual).
 *
 * WHAT THIS COVERS THAT THE OTHER PROSE TESTS DON'T
 *   - prose-rank.test.js          — pure parse + merge (no I/O).
 *   - sampling-aggregate.test.js  — per-trial aggregation.
 *   - prose-rank-wiring.test.js   — fires the REAL extractor through the natural
 *                                   providerCall seam, then folds an IN-MEMORY
 *                                   _summary-shaped object through computeComponents.
 *   - THIS FILE                   — the load-bearing PERSIST round-trip the
 *                                   wiring test stops short of: the verdict is
 *                                   stamped onto a cell with the EXACT write-side
 *                                   gate the bin sinks use (`persistableProseRank`),
 *                                   written to a REAL `_summary.json` on disk via
 *                                   the SAME `atomicWriteJson` helper the sinks
 *                                   call, then READ BACK from disk and run through
 *                                   the REAL `computeComponents`. It proves the
 *                                   ordinal survives JSON serialise→rename→parse
 *                                   and that the persisted shape (proseRank.rank,
 *                                   position:null) lifts rankSample + proseRankSample.
 *
 * WHY NOT DRIVE cmdRunManual DIRECTLY (the originally-sketched design)
 *   `cmdRunManual` is module-private in bin/aeo-tracker.js and calls
 *   process.exit() at the end, so it cannot be invoked in-process without (a)
 *   exporting it for tests and (b) neutering its exit — both production
 *   test-seams. Stubbing the provider HTTP boundary on that path needs
 *   `node:test` `mock.module()`, which in THIS repo is doubly out of reach: it
 *   returns `undefined` unless the runner is launched with the experimental
 *   `--experimental-test-module-mocks` flag (verified: the whole harness runs
 *   `node test/X.test.js` with no flags), so wiring it would add a flagged npm
 *   script + an experimental Node feature + the two production seams above. That
 *   is a NEW non-trivial test-infra design beyond the approved "manual-path +
 *   provider-boundary stub" — it is being returned to test-design-audit rather
 *   than written blind (R37). This test reaches the SAME assertion goal — the
 *   persisted shape feeds the score — through the natural, already-approved
 *   provider-boundary seam (faking ONLY the HTTP round-trip, every parser /
 *   merge / gate / disk write executing for real) and a real on-disk file, with
 *   ZERO product test-hook and ZERO experimental flag.
 *
 * MUTATION-SANITY (verified out-of-tree against /tmp copies; repo files never
 * edited in the run):
 *   - Break the write-side gate `persistableProseRank` (lib/report/prose-rank.js)
 *     to `return false` → the cell is written WITHOUT a proseRank field →
 *     "persisted cell carries the prose ordinal" RED.
 *   - Drop the list-position guard in computeComponents' proseRanked filter
 *     (count a list-rank cell ALSO as prose) → "list cell is not double-counted
 *     as prose" RED (proseRankSample would be 2, not 1).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withTmpProject } from './_helpers.js';
import {
  extractProseRankWithTwoModels,
  persistableProseRank,
} from '../../lib/report/prose-rank.js';
import { atomicWriteJson } from '../../lib/util/atomic-write.js';
import { computeComponents } from '../../lib/report/visibility-index.js';

// A fake provider descriptor with the exact shape extractProseRankWithTwoModels
// consumes: { name, apiKey, model, providerCall }. `providerCall` is the ONE
// network boundary — return a canned strict-JSON body + a real-shaped usage
// object so extractUsage/calcCost run for real (model id is a real priced one).
// parseProseRankResponse, mergeProseRanks, the cost roll-up all execute for real.
function fakeProvider(name, model, replyJson) {
  return {
    name,
    apiKey: 'fake-key-not-used',
    model,
    providerCall: async () => ({
      text: replyJson,
      raw: { usage: { prompt_tokens: 120, completion_tokens: 30 } },
    }),
  };
}

const PROSE_TEXT =
  'The leading option for this is Profound, followed by TestBrand, with a budget pick after that.';

// Reproduce the bin sink's cell-build for a run-manual result, using the SAME
// shared write-side gate (`persistableProseRank`) the production sink applies —
// so this test exercises the real persist condition, not a copy that could drift.
function buildResultCell({ query, mention, position, proseVerdict }) {
  return {
    query,
    queryText: query,
    provider: 'openai',
    model: 'gpt-5',
    source: 'manual-paste',
    mention,
    position,
    canonicalCitations: [],
    ...(persistableProseRank(proseVerdict)
      ? { proseRank: { rank: proseVerdict.rank, confidence: proseVerdict.confidence, rationale: proseVerdict.rationale } }
      : {}),
  };
}

test('prose verdict → _summary.json on disk → read back → lifts the rank axis', async () => {
  await withTmpProject('aeo-e2e-prose-persist-', async (dir) => {
    // 1. Fire the REAL two-model extractor; both models agree rank 2 of 4.
    const reply = '{"rank": 2, "comparableCount": 4, "rationale": "named second after Profound"}';
    const proseVerdict = await extractProseRankWithTwoModels({
      text: PROSE_TEXT, brand: 'TestBrand', domain: 'testbrand.com',
      primary:   fakeProvider('openai', 'gpt-5-mini', reply),
      secondary: fakeProvider('gemini', 'gemini-2.5-flash-lite', reply),
    });
    assert.equal(proseVerdict.rank, 2, 'precondition: extractor produced the agreed ordinal');
    assert.ok(persistableProseRank(proseVerdict),
      'precondition: the verdict passes the shared write-side persist gate');

    // 2. Build a run-manual-shaped summary: a PROSE cell (body mention, no list
    //    position) carrying the verdict, plus a LIST cell (numeric position) and
    //    a plain-mention cell — the same mix the sink would write.
    const summary = {
      date: '2026-06-19',
      brand: 'TestBrand',
      domain: 'testbrand.com',
      results: [
        buildResultCell({ query: 'Q1', mention: 'yes', position: null, proseVerdict }),
        // List cell: explicit numeric position → list-rank path. Carries a stray
        // proseRank to prove the read-side list-position guard keeps it out of
        // the prose axis (no double count).
        buildResultCell({
          query: 'Q2', mention: 'yes', position: 1,
          proseVerdict: { rank: 5, confidence: 'med', rationale: 'stray — list wins' },
        }),
        // Plain mention, no rank of any kind.
        buildResultCell({ query: 'Q3', mention: 'yes', position: null, proseVerdict: { rank: null, confidence: 'none' } }),
      ],
    };

    // 3. Persist to a REAL _summary.json via the SAME atomic writer the sinks use.
    const responseDir = join(dir, 'aeo-responses', summary.date);
    mkdirSync(responseDir, { recursive: true });
    const summaryPath = join(responseDir, '_summary.json');
    await atomicWriteJson(summaryPath, summary);

    // 4. Read it BACK from disk — this is the round-trip under test (the
    //    in-memory wiring test never serialises/parses the cell).
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    const proseCell = persisted.results.find(r => r.query === 'Q1');
    assert.ok(proseCell.proseRank, 'persisted cell carries the prose ordinal');
    assert.equal(proseCell.proseRank.rank, 2, 'the ordinal survived JSON serialise→rename→parse');
    assert.equal(proseCell.proseRank.confidence, 'med', 'confidence persisted');
    assert.equal(proseCell.position, null, 'a prose-mention cell has no list position');

    // The plain mention persisted with NO proseRank field (write-side gate
    // rejected the null-rank verdict) — lean-JSON contract.
    const plainCell = persisted.results.find(r => r.query === 'Q3');
    assert.ok(!('proseRank' in plainCell),
      'a null-rank verdict is NOT persisted (no axis signal → no field)');

    // 5. Run the REAL UVI math on the disk-loaded summary.
    const comp = computeComponents(persisted);
    assert.equal(comp.rankSample, 2,
      'rank axis = 1 list cell + 1 prose cell (the plain mention contributes nothing)');
    assert.equal(comp.proseRankSample, 1,
      'exactly one cell contributed a prose ordinal (the list cell is not double-counted)');
    assert.ok(typeof comp.rank === 'number' && comp.rank > 0,
      'a non-null rank component is produced from the persisted prose + list cells');
  });
});
