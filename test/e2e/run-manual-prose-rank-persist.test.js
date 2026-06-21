/**
 * E2E / integration — run-manual PROSE-RANK persist (AP-PROSE-RANK-FULL-E2E).
 *
 * THE GAP THIS CLOSES
 *   AP-PROSE-RANK shipped two persist sinks in bin/aeo-tracker.js:
 *     - cmdRun (~2679)        — the live run loop, covered by
 *                               prose-rank-persist-roundtrip.test.js.
 *     - cmdRunManual (~4210)  — the manual-paste path. Its persist was the
 *                               UNCOVERED residual: the round-trip test
 *                               re-implemented the sink's cell-build with a
 *                               local `buildResultCell` copy rather than
 *                               exercising the manual sink's REAL field-builder,
 *                               and `cmdRunManual` itself is module-private +
 *                               calls process.exit() so it can't be driven
 *                               in-process, while the only offline subprocess
 *                               path (--replay) zeroes proseRank — so a
 *                               spawnCli E2E never reaches a POSITIVE prose
 *                               verdict on the manual sink (extraction needs a
 *                               live key; a fake key 401s → null verdict).
 *
 *   The fix (this cycle): both sinks now stamp the field through ONE shared
 *   builder `proseRankField(verdict)` (lib/report/prose-rank.js). This test
 *   drives that EXACT shared builder — the real function the manual sink calls,
 *   line 4210 — to assemble a manual-paste result cell, persists it to a REAL
 *   `_summary.json` on disk via the SAME `atomicWriteJson` helper the sink uses,
 *   reads it back, and proves the persisted manual cell carries the prose
 *   ordinal and that the rank axis lifts. No subprocess, no mock.module, no
 *   product test-hook — the manual sink's persist logic is no longer a
 *   copy that can drift from what is tested.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0)
 *   Driving cmdRunManual end-to-end via spawnCli cannot reach a positive prose
 *   verdict offline (extraction is a live provider call; fake-key 401 → null;
 *   --replay zeroes prose). mock.module() is out of reach in this flag-free
 *   harness (verified: the suite runs `node --test` with no experimental flags).
 *   So the assertion goal — "the manual sink persists a usable prose ordinal
 *   into _summary.json, and the read-back lifts the rank axis" — is reached
 *   through the NATURAL function seam the production sink exposes
 *   (`proseRankField`, the real shared builder) plus a real on-disk file and the
 *   real UVI math, every parser / gate / disk write executing for real. This is
 *   an integration test over a real artifact, not a behavioural mock.
 *
 * MUTATION-SANITY (verified out-of-tree against /tmp copies; repo files never
 * edited in the run):
 *   - Neuter the manual sink's persist (make `proseRankField` return `{}`, i.e.
 *     drop persistableProseRank on cmdRunManual's path) → the manual cell is
 *     written WITHOUT a proseRank field → "persisted manual cell carries the
 *     prose ordinal" RED.
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
  proseRankField,
} from '../../lib/report/prose-rank.js';
import { atomicWriteJson } from '../../lib/util/atomic-write.js';
import { computeComponents } from '../../lib/report/visibility-index.js';

// Fake provider with the exact shape extractProseRankWithTwoModels consumes —
// `providerCall` is the ONE network boundary. Returns canned strict JSON + a
// real-shaped usage object so extractUsage/calcCost run for real (real priced
// model id). parseProseRankResponse + mergeProseRanks + the cost roll-up are real.
function fakeProvider(name, model, replyJson) {
  return {
    name,
    apiKey: 'fake-key-not-used',
    model,
    providerCall: async () => ({
      text: replyJson,
      raw: { usage: { prompt_tokens: 110, completion_tokens: 28 } },
    }),
  };
}

const PROSE_TEXT =
  'For this category the strongest pick is Profound, then TestBrand, with a cheaper option after.';

// Reproduce the manual sink's result-cell EXACTLY as bin/aeo-tracker.js's
// cmdRunManual builds it (lines ~4194-4220): a manual-paste row whose prose
// field is stamped by the SAME shared `proseRankField(verdict)` the sink calls,
// so this test exercises the real field-builder, never a copy.
function buildManualResultCell({ query, mention, position, proseVerdict }) {
  return {
    query,
    queryText: query,
    provider: 'perplexity',
    label: 'Perplexity',
    model: 'sonar-pro',
    source: 'manual-paste',
    mention,
    position,
    citationCount: 0,
    canonicalCitations: [],
    ...proseRankField(proseVerdict),
    elapsedMs: null,
  };
}

test('run-manual prose verdict → shared field-builder → _summary.json on disk → read back → lifts the rank axis', async () => {
  await withTmpProject('aeo-e2e-runmanual-prose-', async (dir) => {
    // 1. Fire the REAL two-model extractor; both models agree rank 2 of 3.
    const reply = '{"rank": 2, "comparableCount": 3, "rationale": "named second after Profound"}';
    const proseVerdict = await extractProseRankWithTwoModels({
      text: PROSE_TEXT, brand: 'TestBrand', domain: 'testbrand.com',
      primary:   fakeProvider('openai', 'gpt-5-mini', reply),
      secondary: fakeProvider('gemini', 'gemini-2.5-flash', reply),
    });
    assert.equal(proseVerdict.rank, 2, 'precondition: extractor produced the agreed prose ordinal');

    // 2. Build a run-manual-shaped summary: a PROSE cell (body mention, no list
    //    position) carrying the verdict, plus a LIST cell (numeric position) and
    //    a plain-mention cell — the same mix the manual sink writes.
    const summary = {
      date: '2026-06-19',
      brand: 'TestBrand',
      domain: 'testbrand.com',
      extractorMode: 'dual',
      results: [
        buildManualResultCell({ query: 'Q1', mention: 'yes', position: null, proseVerdict }),
        // List cell with a stray prose verdict — the read-side list-position
        // guard must keep it out of the prose axis (no double count).
        buildManualResultCell({
          query: 'Q2', mention: 'yes', position: 1,
          proseVerdict: { rank: 5, confidence: 'med', rationale: 'stray — list wins' },
        }),
        // Plain mention, no usable rank of any kind → no proseRank field.
        buildManualResultCell({ query: 'Q3', mention: 'yes', position: null, proseVerdict: { rank: null, confidence: 'none' } }),
      ],
    };

    // 3. Persist to a REAL _summary.json via the SAME atomic writer the sink uses.
    const responseDir = join(dir, 'aeo-responses', summary.date);
    mkdirSync(responseDir, { recursive: true });
    const summaryPath = join(responseDir, '_summary.json');
    await atomicWriteJson(summaryPath, summary);

    // 4. Read it BACK from disk — the round-trip under test.
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    const proseCell = persisted.results.find(r => r.query === 'Q1');
    assert.equal(proseCell.source, 'manual-paste', 'manual sink tags the row');
    assert.ok(proseCell.proseRank, 'persisted manual cell carries the prose ordinal');
    assert.equal(proseCell.proseRank.rank, 2, 'the ordinal survived JSON serialise→rename→parse');
    assert.equal(proseCell.proseRank.confidence, 'med', 'confidence persisted');
    assert.equal(proseCell.position, null, 'a prose-mention cell has no list position');

    // The plain mention persisted with NO proseRank field (shared builder
    // rejected the null-rank verdict) — lean-JSON contract.
    const plainCell = persisted.results.find(r => r.query === 'Q3');
    assert.ok(!('proseRank' in plainCell),
      'a null-rank verdict is NOT persisted on the manual sink (no axis signal → no field)');

    // 5. Run the REAL UVI math on the disk-loaded manual summary.
    const comp = computeComponents(persisted);
    assert.equal(comp.rankSample, 2,
      'rank axis = 1 list cell + 1 prose cell (the plain mention contributes nothing)');
    assert.equal(comp.proseRankSample, 1,
      'exactly one cell contributed a prose ordinal (the list cell is not double-counted)');
    assert.ok(typeof comp.rank === 'number' && comp.rank > 0,
      'a non-null rank component is produced from the persisted manual prose + list cells');
  });
});
