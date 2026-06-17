// Tests for cross-run diff logic. Covers the data-integrity contract that
// a (provider, query) cell only contributes to the diff when BOTH runs
// measured it — a missing provider in run N−1 must NOT produce a fabricated
// regression in run N. See BUG 1 in the v0.3.1 maintenance notes.

import assert from 'node:assert/strict';
import { diff } from '../lib/diff.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ndiff — cellChanges');

test('provider absent in prev → no cellChange row emitted', () => {
  const a = {
    score: 33,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
      { query: 'q1', provider: 'gemini', mention: 'no' },
    ],
  };
  const b = {
    score: 42,
    results: [
      { query: 'q1', provider: 'openai',     mention: 'yes' },
      { query: 'q1', provider: 'gemini',     mention: 'yes' },
      // perplexity is new in run B — must NOT fabricate "missing → no" or "yes → no"
      { query: 'q1', provider: 'perplexity', mention: 'no' },
    ],
  };
  const d = diff(a, b);
  const perplexityChanges = d.cellChanges.filter(c => c.provider === 'perplexity');
  assert.equal(perplexityChanges.length, 0,
    `expected no perplexity diff rows when prev had no perplexity, got ${JSON.stringify(perplexityChanges)}`);
});

test('provider dropped in current → no fabricated "yes → missing" row', () => {
  const a = {
    score: 50,
    results: [
      { query: 'q1', provider: 'openai',     mention: 'yes' },
      { query: 'q1', provider: 'perplexity', mention: 'yes' },
    ],
  };
  const b = {
    score: 50,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
    ],
  };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0,
    `dropping perplexity from config is not a regression, got ${JSON.stringify(d.cellChanges)}`);
});

test('errored cells in prev are not comparable → skipped', () => {
  const a = {
    score: 0,
    results: [
      { query: 'q1', provider: 'openai', mention: 'error' },
    ],
  };
  const b = {
    score: 100,
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
    ],
  };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0, 'error → yes is not a measurable cell change');
});

test('real mention change is still emitted', () => {
  const a = { score: 0, results: [{ query: 'q1', provider: 'openai', mention: 'no' }] };
  const b = { score: 100, results: [{ query: 'q1', provider: 'openai', mention: 'yes' }] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].was, 'no');
  assert.equal(d.cellChanges[0].now, 'yes');
  assert.equal(d.cellChanges[0].mixedMethod, false);
});

test('mixed-method change (api ↔ manual-paste) is tagged mixedMethod: true', () => {
  const a = { score: 50, results: [{ query: 'q1', provider: 'anthropic', mention: 'yes', source: 'api' }] };
  const b = { score: 0, results: [{ query: 'q1', provider: 'anthropic', mention: 'no', source: 'manual-paste' }] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].mixedMethod, true);
});

test('competitor movement still tracked (independent of cellChanges fix)', () => {
  const a = {
    score: 0, results: [],
    topCompetitors: [{ name: 'CompA', count: 3 }],
  };
  const b = {
    score: 0, results: [],
    topCompetitors: [{ name: 'CompA', count: 3 }, { name: 'CompB', count: 1 }],
  };
  const d = diff(a, b);
  assert.equal(d.newCompetitors.length, 1);
  assert.equal(d.newCompetitors[0].name, 'CompB');
});

// ─── AP-MEASURE-SAMPLING-CI — distribution-aware change classification ───
//
// When BOTH runs sampled a cell, an overlapping-CI change is noise (dropped,
// never a regression); a clean separation is signal (emitted, method
// 'distribution'). When EITHER run is single-shot we cannot test a
// distribution → fall back to today's flip, tagged 'point-estimate'
// (back-compat with every legacy snapshot on disk).
//
// MUTATION-SANITY:
//   - revert diff to "was !== now" only (drop the classifier) → the
//     noise-overlap test below goes RED (3/5→2/5 would wrongly become a change).
//   - read r.presence.hits without the hasPresence guard on a mixed pair →
//     the mixed-case test throws (undefined.hits) instead of falling back.

console.log('\ndiff — sampled distribution classification');

const sampled = (mention, hits, n) => ({
  query: 'q1', provider: 'openai', mention,
  presence: { hits, n, rate: n ? hits / n : 0, ci: { level: 0.95 } },
});

test('overlapping CIs (3/5 → 2/5) → NOISE, no cellChange emitted', () => {
  const a = { score: 60, results: [sampled('yes', 3, 5)] };
  const b = { score: 40, results: [sampled('no', 2, 5)] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0,
    `3/5 vs 2/5 overlap → sampling noise, not a regression, got ${JSON.stringify(d.cellChanges)}`);
});

test('clean separation (5/5 → 0/5) → SIGNAL, cellChange method=distribution', () => {
  const a = { score: 100, results: [sampled('yes', 5, 5)] };
  const b = { score: 0,   results: [sampled('no', 0, 5)] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 1, 'disjoint CIs → real signal');
  assert.equal(d.cellChanges[0].was, 'yes');
  assert.equal(d.cellChanges[0].now, 'no');
  assert.equal(d.cellChanges[0].method, 'distribution');
});

test('CAVEAT #4 mixed-case — one sampled, one single-shot → point-estimate fallback, no crash', () => {
  // prev sampled (has presence), now single-shot (no presence). Must NOT read
  // .hits on the absent side; falls back to boolean flip.
  const a = { score: 100, results: [sampled('yes', 5, 5)] };
  const b = { score: 0,   results: [{ query: 'q1', provider: 'openai', mention: 'no' }] };
  let d;
  assert.doesNotThrow(() => { d = diff(a, b); }, 'mixed presence/no-presence must not throw');
  assert.equal(d.cellChanges.length, 1, 'yes → no flip still emitted on the single-shot side');
  assert.equal(d.cellChanges[0].method, 'point-estimate', 'mixed pair falls back to point-estimate');
});

test('CAVEAT #4 reverse mixed-case — prev single-shot, now sampled → point-estimate', () => {
  const a = { score: 0,   results: [{ query: 'q1', provider: 'openai', mention: 'no' }] };
  const b = { score: 100, results: [sampled('yes', 5, 5)] };
  let d;
  assert.doesNotThrow(() => { d = diff(a, b); });
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].method, 'point-estimate');
});

test('single-shot → single-shot keeps point-estimate (legacy back-compat)', () => {
  const a = { score: 0,   results: [{ query: 'q1', provider: 'openai', mention: 'no' }] };
  const b = { score: 100, results: [{ query: 'q1', provider: 'openai', mention: 'yes' }] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 1);
  assert.equal(d.cellChanges[0].method, 'point-estimate');
});

test('sampled-but-same-mention (4/5 → 5/5) → no change (was === now short-circuit)', () => {
  const a = { score: 80, results: [sampled('yes', 4, 5)] };
  const b = { score: 100, results: [sampled('yes', 5, 5)] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0, 'same representative mention → no cellChange regardless of distribution');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
