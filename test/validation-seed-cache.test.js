// Tests for the 1.1.8 "one validation, one source of truth" contract (F1)
// and the verified-substitute recovery for llm blockers (F2).
//
// Production trigger: the substitution block validated all 5 candidates and
// PASSED a borderline query; the main validation then re-ran with an empty
// cache, the non-deterministic classifier flipped the same query to
// valid:false, and init aborted — the pipeline rejected its own selection.
// With a seeded validationCache the second LLM call must NOT happen, so a
// flip is impossible by construction.

import assert from 'node:assert/strict';
import { runTwoStageValidation, SEARCH_BEHAVIORS } from '../lib/init/research/run-validation.js';
import {
  isVerifiedSubstitute, dedupeBlockersByQuery, tryAutoRecover, formatAutoPromoteWarning,
} from '../lib/init/validator-recovery.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  const p = (async () => fn())();
  return p.then(
    () => { passed++; results.push({ name, ok: true }); },
    err => { failed++; results.push({ name, ok: false, err: err.message }); }
  );
}

const QUERIES = [
  'top booking software for healthcare providers',
  'best AI conversational booking widget tools 2026',
  'best appointment scheduling services for salons 2026',
];

const seedVerdict = (query) => ({
  query, valid: true, confidence: 0.9,
  alternate_meanings: [], dominant_interpretation: '',
  search_behavior: SEARCH_BEHAVIORS.RETRIEVAL, reason: 'ok', validatedAt: '2026-06-11T00:00:00Z',
});

/** Provider whose verdict REJECTS everything — used to prove it is not called. */
function rejectingProvider() {
  let calls = 0;
  return {
    name: 'openai', apiKey: 'k', model: 'm',
    get calls() { return calls; },
    providerCall: async (prompt) => {
      calls++;
      const queries = QUERIES;
      return {
        text: JSON.stringify({
          results: queries.map((q, i) => ({
            index: i + 1, query: q, alternate_meanings: ['a', 'b'],
            dominant_interpretation: 'something else',
            search_behavior: 'retrieval-triggered', valid: false,
            confidence: 0.86, reason: 'would reject on a fresh roll',
          })),
        }),
        raw: {},
      };
    },
  };
}

await test('FLIP REGRESSION: seeded cache → zero LLM calls, zero llmIssues (verdicts cannot flip)', async () => {
  const provider = rejectingProvider();
  const v = await runTwoStageValidation({
    queries: QUERIES, brand: 'typelessity', domain: 'typelessity.com',
    category: 'AI conversational booking widget',
    primary: provider, secondary: null,
    validationCache: QUERIES.map(seedVerdict),
  });
  assert.equal(provider.calls, 0, 'provider must not be called on full cache hit');
  assert.equal(v.cacheHits, 3);
  assert.equal(v.llmIssues.length, 0);
  assert.equal(v.updatedCache.length, 3);
});

await test('control: WITHOUT the seed the same provider rejects all 3 (the bug class is real)', async () => {
  const provider = rejectingProvider();
  const v = await runTwoStageValidation({
    queries: QUERIES, brand: 'typelessity', domain: 'typelessity.com',
    category: 'AI conversational booking widget',
    primary: provider, secondary: null,
    validationCache: [],
  });
  assert.equal(provider.calls, 1);
  assert.equal(v.llmIssues.length, 3);
});

// ─── isVerifiedSubstitute ───

await test('isVerifiedSubstitute: valid + retrieval → true', () => {
  assert.equal(isVerifiedSubstitute({ text: 'q', valid: true, search_behavior: 'retrieval-triggered' }), true);
});

await test('isVerifiedSubstitute: fails closed on missing valid (legacy pool), valid:false, or non-retrieval', () => {
  assert.equal(isVerifiedSubstitute({ text: 'q', search_behavior: 'retrieval-triggered' }), false);
  assert.equal(isVerifiedSubstitute({ text: 'q', valid: false, search_behavior: 'retrieval-triggered' }), false);
  assert.equal(isVerifiedSubstitute({ text: 'q', valid: true, search_behavior: 'mixed' }), false);
  assert.equal(isVerifiedSubstitute(null), false);
});

// ─── dedupeBlockersByQuery ───

await test('dedupeBlockersByQuery: same query flagged by two stages → one blocker, first (llm) wins', () => {
  const llm = { query: 'q1', valid: false, reason: 'llm says no', search_behavior: 'retrieval-triggered' };
  const info = { query: 'q1', search_behavior: 'mixed' };
  const out = dedupeBlockersByQuery([llm, info, { query: 'q2', search_behavior: 'mixed' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].reason, 'llm says no');
});

// ─── llm-blocker substitution carries the verdict reason ───

await test('tryAutoRecover: llm blocker substitution carries blockReason; warning renders it', () => {
  const blocker = {
    query: 'best appointment scheduling services for salons 2026',
    valid: false, reason: 'AI returns general platforms', search_behavior: 'retrieval-triggered',
  };
  const pool = [
    { text: 'best AI booking tools for clinics 2026', intent: 'commercial', score: 70, valid: true, search_behavior: 'retrieval-triggered' },
  ];
  const verifiedPool = pool.filter(isVerifiedSubstitute);
  assert.equal(verifiedPool.length, 1);
  const r = tryAutoRecover({
    blockers: [blocker],
    queries: QUERIES.map(t => ({ text: t, intent: 'commercial' })),
    candidatePool: verifiedPool,
  });
  assert.equal(r.unresolvedBlockers.length, 0);
  assert.equal(r.substitutions.length, 1);
  assert.equal(r.substitutions[0].blockReason, 'AI returns general platforms');
  const lines = formatAutoPromoteWarning(r.substitutions[0], false).join('\n');
  assert.match(lines, /LLM rejected: AI returns general platforms/);
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
