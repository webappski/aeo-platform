// Tests for lib/report/sections.js::sectionRunComparison — the markdown
// copy layer over run-comparison.js's model. run-comparison.test.js covers
// the model itself; this file covers wording/formatting decisions that only
// live in sections.js: the stable-state heuristic, plural agreement in the
// causal narrative, and the "newly gained" query grouping.

import assert from 'node:assert/strict';
import { sectionRunComparison } from '../lib/report/sections.js';
import { mdToHtml } from '../lib/report/markdown-to-html.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const cell = (query, provider, mention, extra = {}) => ({
  query, provider, mention, queryText: `${query} text`, label: providerDisplay(provider), ...extra,
});
const toned = (query, provider, label, extra = {}) =>
  cell(query, provider, 'yes', { sentiment: { label, confidence: 'high' }, ...extra });
const run = (date, results) => ({ date, domain: 'example.com', results });

function providerDisplay(p) {
  return { openai: 'ChatGPT', gemini: 'Gemini', anthropic: 'Claude', perplexity: 'Perplexity' }[p] || p;
}

console.log('\nsectionRunComparison — first run / stable state');

test('first run (fewer than 2 snapshots) renders the placeholder, not the model', () => {
  const md = sectionRunComparison([run('2026-01-01', [cell('Q1', 'openai', 'yes')])]);
  assert.match(md, /nothing to compare yet/);
});

test('no cells changed hands and nothing genuinely moved -> calm "held steady" message', () => {
  const results = [toned('Q1', 'openai', 'positive')];
  const md = sectionRunComparison([run('2026-01-01', results), run('2026-02-01', results)]);
  assert.match(md, /held steady/);
  assert.doesNotMatch(md, /cell-badge/, 'stable message should not also render the full segment/table body');
});

test('no cells changed hands but a held cell genuinely moved -> full body, not the calm message', () => {
  // Tone moved on the one held cell (positive -> negative): lost=0, gained=0,
  // but this is real movement and must NOT be smoothed into "held steady".
  const prev = run('2026-01-01', [toned('Q1', 'openai', 'positive')]);
  const latest = run('2026-02-01', [toned('Q1', 'openai', 'negative')]);
  const md = sectionRunComparison([prev, latest]);
  assert.doesNotMatch(md, /held steady/);
  assert.match(md, /declined among the answers you kept/);
});

console.log('\nsectionRunComparison — gain-drag pluralisation');

test('a single dragging cell reads as singular, naming the engine', () => {
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive'), toned('Q1', 'gemini', 'positive'), cell('Q5', 'anthropic', 'no'),
  ]);
  const latest = run('2026-02-01', [
    cell('Q1', 'openai', 'no'), cell('Q1', 'gemini', 'no'), toned('Q5', 'anthropic', 'neutral'),
  ]);
  const md = sectionRunComparison([prev, latest]);
  assert.match(md, /A newly gained mention on Claude dragged/);
  assert.doesNotMatch(md, /newly gained mentions dragged/, 'must not pluralise for a single dragging cell');
});

test('two independent dragging cells read as plural, with a count', () => {
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive'), cell('Q5', 'anthropic', 'no'), cell('Q6', 'gemini', 'no'),
  ]);
  const latest = run('2026-02-01', [
    cell('Q1', 'openai', 'no'), toned('Q5', 'anthropic', 'neutral'), toned('Q6', 'gemini', 'neutral'),
  ]);
  const md = sectionRunComparison([prev, latest]);
  assert.match(md, /2 newly gained mentions dragged/);
});

console.log('\nsectionRunComparison — "newly gained" query grouping');

test('a mention gained on two engines for the SAME question groups into one item', () => {
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive'), cell('Q5', 'anthropic', 'no'), cell('Q5', 'gemini', 'no'),
  ]);
  const latest = run('2026-02-01', [
    toned('Q1', 'openai', 'positive'), toned('Q5', 'anthropic', 'neutral'), toned('Q5', 'gemini', 'neutral'),
  ]);
  const md = sectionRunComparison([prev, latest]);
  assert.match(md, /Newly gained: Q5 text on Claude and Gemini\._/);
});

console.log('\nsectionRunComparison — tone contract (no internal vocabulary leaks)');

test('never emits internal jargon in the rendered copy', () => {
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive', { position: 2 }),
    cell('Q5', 'anthropic', 'no'),
  ]);
  const latest = run('2026-02-01', [
    cell('Q1', 'openai', 'no'),
    toned('Q5', 'anthropic', 'neutral'),
  ]);
  const md = sectionRunComparison([prev, latest]);
  // Strip markup first — `class="cell-badge"` is implementation, not reader-
  // facing prose, and would otherwise false-positive the "cell" check.
  const prose = md.replace(/<[^>]+>/g, ' ');
  const banned = /\bcell\b|\bextractor\b|\bpipeline\b|\bconditional\b|\bcompositional\b|\bbug\b|\bfixed\b/i;
  assert.doesNotMatch(prose, banned, `client-facing copy must not use internal vocabulary: ${prose}`);
});

console.log('\nsectionRunComparison -> mdToHtml — the actual HTML the client sees');

test('the headline\'s bold numbers survive mdToHtml — not left as literal "**" text', () => {
  // Regression: mdToHtml treats a line starting with "<" as a raw-HTML block
  // and skips ALL inline processing for that line. The headline used to lead
  // with the deltaArrow <svg>, so "**45**" rendered as literal asterisks in
  // the HTML report (caught visually — the markdown-only tests above never
  // would have, since they check the markdown string, not the HTML render).
  const prev = run('2026-01-01', [toned('Q1', 'openai', 'positive')]);
  const latest = run('2026-02-01', [toned('Q1', 'openai', 'negative')]);
  const md = sectionRunComparison([prev, latest]);
  const html = mdToHtml(md);
  assert.doesNotMatch(html, /\*\*/, 'no literal "**" should remain once rendered to HTML');
  assert.match(html, /<strong>\d+<\/strong>/, 'the UVI numbers must actually render bold');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
