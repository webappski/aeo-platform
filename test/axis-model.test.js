// The shared axis model — the derivation the HTML report and the Mission
// Control payload both read, so neither can state a different axis delta.
import assert from 'node:assert/strict';
import { buildAxisModel, axisHistories, AXIS_ORDER } from '../lib/report/axis-model.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const cell = (query, provider, mention, extra = {}) => ({
  query, provider, label: provider, mention, queryText: `${query} text`,
  position: mention === 'yes' ? 1 : null, citationCount: 0,
  canonicalCitations: [], competitors: [], ...extra,
});
const run = (date, score, results) => ({ date, score, brand: 'Acme', domain: 'acme.com', results });

console.log('\nbuildAxisModel');

test('an empty record yields an empty model, not a throw', () => {
  assert.deepEqual(buildAxisModel([]), { rows: [], metrics: [], shortCoverage: [] });
  assert.deepEqual(buildAxisModel(null), { rows: [], metrics: [], shortCoverage: [] });
});

test('rows cover every axis the index reports, with machine-readable keys', () => {
  const m = buildAxisModel([run('2026-01-01', 10, [cell('Q1', 'openai', 'yes')])]);
  const keys = m.rows.map((r) => r.key);
  for (const k of AXIS_ORDER) assert.ok(keys.includes(k), `axis ${k} missing from rows`);
});

test('a directly-measured axis states a delta once there are two runs', () => {
  const m = buildAxisModel([
    run('2026-01-01', 50, [cell('Q1', 'openai', 'yes'), cell('Q2', 'openai', 'yes')]),
    run('2026-02-01', 0, [cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'no')]),
  ]);
  const presence = m.rows.find((r) => r.key === 'presence');
  assert.equal(presence.coverAllowed, true);
  assert.ok(presence.delta < 0, 'losing both answers must read as a negative presence delta');
});

test('an axis whose sample collapsed prints coverage instead of a delta', () => {
  const toned = (q, p, label) => cell(q, p, 'yes', { sentiment: { label, confidence: 'high' } });
  const m = buildAxisModel([
    run('2026-01-01', 50, [toned('Q1', 'openai', 'positive'), toned('Q2', 'openai', 'positive')]),
    run('2026-02-01', 50, [cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'no')]),
  ]);
  const sentiment = m.rows.find((r) => r.key === 'sentiment');
  assert.equal(sentiment.coverAllowed, false);
  assert.equal(sentiment.delta, null);
  assert.ok(sentiment.coverReason, 'the gate must name its reason');
  assert.ok(m.shortCoverage.includes(sentiment.label));
  assert.ok(!m.metrics.some((x) => x.id === 'axis-sentiment'), 'a gated axis may not be ranked as a mover');
});

test('a falsy entry in the record is dropped, never read as a collapse to zero', () => {
  // A missing snapshot must not enter the history at all: `computeComponents`
  // answers 0 for an empty run, and a 0 in the middle of the series would draw
  // a cliff on the chart and hand `buildMetric` a fake previous value.
  const good = run('2026-01-01', 10, [cell('Q1', 'openai', 'yes')]);
  const m = buildAxisModel([good, null, good]);
  const presence = m.rows.find((r) => r.key === 'presence');
  assert.equal(presence.history.length, 2, 'the null run must not occupy a slot');
  assert.ok(presence.history.every((v) => v !== 0), 'no fabricated zero in the series');
});

test('axisHistories keeps one slot per run it is given, oldest first', () => {
  const h = axisHistories([
    run('2026-01-01', 10, [cell('Q1', 'openai', 'yes')]),
    run('2026-02-01', 0, [cell('Q1', 'openai', 'no')]),
  ]);
  assert.equal(h.presence.length, 2);
  assert.ok(h.presence[0] > h.presence[1], 'the series must read oldest -> newest');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
