// The client-portal comparison payload: what it carries, and — more
// importantly — what it must never carry.
//
// Two invariants are load-bearing and have their own tests below:
//   1. no deny-listed result-row internals (excerpt / cost / tokens / paths)
//   2. no English prose — the portal renders four languages off `kind` tokens
import assert from 'node:assert/strict';
import { buildComparisonPayload, COMPARISON_SCHEMA } from '../lib/report/comparison-payload.js';
import { RECORD_KIND } from '../lib/report/answer-history.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// A result row as the tracker writes it — deliberately including the fields
// that must be stripped, so the leak test is testing something real.
const cell = (query, provider, mention, extra = {}) => ({
  query,
  provider,
  label: provider,
  mention,
  queryText: `${query} text`,
  position: mention === 'yes' ? 1 : null,
  citationCount: 2,
  canonicalCitations: ['https://example.com/a'],
  competitors: [],
  // deny-listed internals — present on every real row
  responseExcerpt: 'the engine said a long thing here',
  costUsd: 0.0123,
  inputTokens: 5100,
  outputTokens: 900,
  elapsedMs: 4200,
  extractionSources: ['internal-debug-path'],
  ...extra,
});
const run = (date, score, results) => ({ date, score, brand: 'Acme', domain: 'acme.com', results });

console.log('\nbuildComparisonPayload — shape');

test('returns null when there is no run at all', () => {
  assert.equal(buildComparisonPayload([]), null);
  assert.equal(buildComparisonPayload(null), null);
});

test('first run carries the ladder but claims no movement', () => {
  const p = buildComparisonPayload([run('2026-01-01', 10, [cell('Q1', 'openai', 'no')])]);
  assert.equal(p.schema, COMPARISON_SCHEMA);
  assert.equal(p.runCount, 1);
  assert.equal(p.pair, null);
  assert.equal(p.uvi, null);
  assert.equal(p.counts, null);
  assert.equal(p.headlineMover, null);
  // Every capability that would let a renderer assert a direction is off.
  for (const k of ['chips', 'baselineCaption', 'shapes', 'whereToAct', 'trendLanguage', 'noiseTest']) {
    assert.equal(p.capabilities[k], false, `capability ${k} must be off on run 1`);
  }
  assert.equal(p.answers[0].record.kind, RECORD_KIND.FIRST_RUN);
  assert.ok(p.metrics.every((m) => m.deltaPrev === null), 'no metric may carry a delta on run 1');
});

test('second run carries the pair, the counts and the flipped cells', () => {
  const p = buildComparisonPayload([
    run('2026-01-01', 10, [cell('Q1', 'openai', 'yes'), cell('Q2', 'openai', 'no')]),
    run('2026-02-01', 6, [cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'yes')]),
  ]);
  assert.deepEqual(p.pair, { prevDate: '2026-01-01', currDate: '2026-02-01' });
  assert.equal(p.counts.lost, 1);
  assert.equal(p.counts.gained, 1);
  assert.equal(p.capabilities.chips, true, 'chips unlock at run 2');
  assert.equal(p.capabilities.shapes, false, 'shapes stay locked until run 3');
  assert.deepEqual(
    p.lost.map((e) => [e.queryId, e.provider, e.was, e.now]),
    [['Q1', 'openai', 'yes', 'no']],
  );
  assert.deepEqual(
    p.gained.map((e) => [e.queryId, e.provider, e.was, e.now]),
    [['Q2', 'openai', 'yes'.replace('yes', 'no'), 'yes']],
  );
  assert.equal(p.changed.length, 2);
});

test('answers join back to perCell on queryId + provider, and never repeat its payload', () => {
  const p = buildComparisonPayload([
    run('2026-01-01', 10, [cell('Q1', 'openai', 'yes')]),
    run('2026-02-01', 10, [cell('Q1', 'openai', 'yes')]),
  ]);
  const a = p.answers[0];
  assert.equal(a.queryId, 'Q1');
  assert.equal(a.provider, 'openai');
  assert.deepEqual(Object.keys(a).sort(), ['provider', 'queryId', 'record', 'states', 'textDrift', 'verdict']);
  assert.deepEqual(a.states, ['named', 'named']);
});

console.log('\nbuildComparisonPayload — the two hard rules');

test('carries no deny-listed result-row internals anywhere', () => {
  const p = buildComparisonPayload([
    run('2026-01-01', 10, [cell('Q1', 'openai', 'yes'), cell('Q2', 'gemini', 'no')]),
    run('2026-02-01', 6, [cell('Q1', 'openai', 'no'), cell('Q2', 'gemini', 'yes')]),
  ]);
  const json = JSON.stringify(p);
  for (const denied of [
    'responseExcerpt', 'costUsd', 'inputTokens', 'outputTokens',
    'elapsedMs', 'extractionSources', 'the engine said a long thing here',
    'internal-debug-path',
  ]) {
    assert.ok(!json.includes(denied), `payload leaked "${denied}"`);
  }
});

test('every per-answer record is a known kind token, never a sentence', () => {
  const kinds = new Set(Object.values(RECORD_KIND));
  const p = buildComparisonPayload([
    run('2026-01-01', 10, [cell('Q1', 'openai', 'yes'), cell('Q2', 'gemini', 'no')]),
    run('2026-02-01', 6, [cell('Q1', 'openai', 'no'), cell('Q2', 'gemini', 'yes')]),
    run('2026-03-01', 6, [cell('Q1', 'openai', 'no'), cell('Q2', 'gemini', 'yes')]),
  ]);
  for (const a of p.answers) {
    assert.ok(kinds.has(a.record.kind), `unknown record kind "${a.record.kind}"`);
    for (const [k, v] of Object.entries(a.record)) {
      if (k === 'kind' || k === 'startDate') continue;
      assert.ok(v === null || typeof v === 'number', `record.${k} must be a number, got ${typeof v}`);
    }
  }
});

test('drivers ship the arithmetic, never the cells behind it', () => {
  const toned = (q, p2, label) => cell(q, p2, 'yes', { sentiment: { label, confidence: 'high' } });
  const p = buildComparisonPayload([
    run('2026-01-01', 10, [toned('Q1', 'openai', 'positive'), toned('Q2', 'openai', 'positive')]),
    run('2026-02-01', 10, [toned('Q1', 'openai', 'positive'), toned('Q2', 'openai', 'negative')]),
  ]);
  assert.ok(Array.isArray(p.drivers.components));
  for (const comp of p.drivers.components) {
    assert.ok(!('gainDrag' in comp), 'gainDrag cells must not ship — only their count');
    assert.equal(typeof comp.gainDragCount, 'number');
  }
});

console.log('\nbuildComparisonPayload — agreement with the report');

test('the headline mover is decided here, not left to the renderer', () => {
  const p = buildComparisonPayload([
    run('2026-01-01', 50, [cell('Q1', 'openai', 'yes'), cell('Q2', 'openai', 'yes')]),
    run('2026-02-01', 20, [cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'no')]),
  ]);
  assert.ok(p.headlineMover, 'a two-answer collapse must name a mover');
  // The mover is ranked across the run metrics AND the reportable index axes,
  // so its id resolves in one of the two collections the payload ships.
  const ids = [...p.metrics.map((m) => m.id), ...p.axes.map((a) => `axis-${a.key}`)];
  assert.ok(ids.includes(p.headlineMover.id), `mover id ${p.headlineMover.id} not in ${ids.join(',')}`);
  // Machine-resolvable identity, so a four-language renderer never has to
  // parse the English label.
  assert.match(p.headlineMover.id, /^[a-z-]+$/);
});

test('a gated axis reports its coverage instead of a delta', () => {
  const p = buildComparisonPayload([
    run('2026-01-01', 10, [cell('Q1', 'openai', 'yes', { sentiment: { label: 'positive', confidence: 'high' } })]),
    run('2026-02-01', 10, [cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'no')]),
  ]);
  const sentiment = p.axes.find((a) => a.key === 'sentiment');
  assert.ok(sentiment, 'sentiment axis must always be listed');
  if (!sentiment.coverAllowed) {
    assert.equal(sentiment.delta, null, 'a gated axis must not state a delta');
    assert.ok(sentiment.coverReason, 'a gated axis must say why it is gated');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
