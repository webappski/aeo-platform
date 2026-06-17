import assert from 'node:assert/strict';
import { MEASUREMENT_DISCLAIMER, MEASUREMENT_DISCLAIMER_SHORT } from '../lib/report/measurement-disclaimer.js';

// review #3 (AP-DISCLAIMER-API-SURFACE): the disclaimer that gets stamped into
// `_summary.json::measurement` and rendered in the report header. This is the
// single source of truth — lock its shape and the claims it must carry.

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nMEASUREMENT_DISCLAIMER (the _summary.measurement object)');

test('carries surface = "api"', () => {
  assert.equal(MEASUREMENT_DISCLAIMER.surface, 'api');
});

test('carries a non-empty disclaimer string', () => {
  assert.equal(typeof MEASUREMENT_DISCLAIMER.disclaimer, 'string');
  assert.ok(MEASUREMENT_DISCLAIMER.disclaimer.length > 40, 'disclaimer too short to be meaningful');
});

test('disclaimer is honest about being a proxy, not the consumer app', () => {
  const d = MEASUREMENT_DISCLAIMER.disclaimer.toLowerCase();
  assert.ok(d.includes('api'), 'must say it measures the API surface');
  assert.ok(d.includes('proxy'), 'must frame itself as a proxy');
  assert.ok(/not|excludes/.test(d), 'must state what it does NOT guarantee');
  assert.ok(d.includes('chatgpt.com'), 'must name the consumer app it is NOT');
});

test('disclaimer names the excluded surfaces (AI Overviews + Copilot)', () => {
  const d = MEASUREMENT_DISCLAIMER.disclaimer.toLowerCase();
  assert.ok(d.includes('overview'), 'must mention AI Overviews are excluded');
  assert.ok(d.includes('copilot'), 'must mention Copilot is excluded');
});

test('object is frozen (single source of truth cannot be mutated at runtime)', () => {
  assert.ok(Object.isFrozen(MEASUREMENT_DISCLAIMER));
});

test('short form is a non-empty one-liner for the dense masthead', () => {
  assert.equal(typeof MEASUREMENT_DISCLAIMER_SHORT, 'string');
  assert.ok(MEASUREMENT_DISCLAIMER_SHORT.length > 0);
  assert.ok(MEASUREMENT_DISCLAIMER_SHORT.length < 140, 'short form should stay compact for the header');
  const s = MEASUREMENT_DISCLAIMER_SHORT.toLowerCase();
  assert.ok(s.includes('proxy'), 'short form must still frame itself as a proxy');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
