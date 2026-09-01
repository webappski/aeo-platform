/**
 * E2E — the model axis, end to end on the REAL run pair that exposed it.
 *
 * WHAT WENT WRONG, VERBATIM FROM THE SHIPPED REPORT
 *   > Your visibility index moved from 87 to 69 — down 18 points
 * followed by a "Where you lost ground" table naming Talk2Forms, Speak2Fill.ai,
 * Smart Form Automation, ServiceMark AI Form Filler, Fulcrum Audio FastFill and
 * VoiceFill.ai as having taken the brand's place. Four of those five rows had
 * been measured on a different model than the run they were compared against —
 * ChatGPT on `gpt-5-search-api` in August and `gpt-5.4-mini` in September,
 * Gemini on `gemini-3.5-flash` then `gemini-3.7-flash`. The newer OpenAI SKU
 * read the e-commerce question as being about browser extensions and listed
 * those. The names were real strings in real answers; the story built on them
 * was not true.
 *
 * WHAT THIS TEST PINS
 *   1. The delta is STILL STATED. Founder ruling 2026-09-01: «никак мы не можем
 *      не сравнивать его движение пользователя». A regression that turned this
 *      into a `coverageAllowsDelta`-style refusal is as wrong as the original
 *      defect, in the opposite direction — so "down 18 points" is asserted.
 *   2. The caveat lands INSIDE the block that names competitors, not only in a
 *      note underneath it. A reader who has already read the names is not
 *      reached by a footnote.
 *   3. «было → стало» is printed with real model ids — the only form in which
 *      the claim can be checked rather than believed.
 *   4. "No overlap at all" is stated as its own fact. Neither engine measured a
 *      single answer on the same model twice, which is a stronger statement
 *      than "the model changed" and the findings require it be named.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0): this runs the REAL renderer over REAL
 * captured runs — the whole chain from summary JSON through buildRunComparison,
 * the drivers, and the markdown section. The pure classifier underneath is
 * unit-covered in test/model-change.test.js; what only an integration test can
 * see is whether the caveat actually reaches the rendered copy, which is where
 * the previous version of this report told the false story. Offline,
 * deterministic, no API, no cost — the fixtures are committed.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_ROOT } from './_helpers.js';
import { sectionRunComparison } from '../../lib/report/sections.js';
import { buildRunComparison } from '../../lib/report/run-comparison.js';
import { buildComparisonPayload } from '../../lib/report/comparison-payload.js';

const PAIR = join(FIXTURE_ROOT, 'model-change-pair');
const snapshots = ['prev.json', 'curr.json'].map(
  (f) => JSON.parse(readFileSync(join(PAIR, f), 'utf-8')),
);

test('the delta survives an engine swap — the customer still sees their own movement', () => {
  const md = sectionRunComparison(snapshots);
  assert.match(md, /moved from \*\*87\*\* to \*\*69\*\*/,
    `the index movement must still be stated in full; got:\n${md}`);
  assert.match(md, /down 18 points/,
    `the delta must still be named; got:\n${md}`);
  const model = buildRunComparison(snapshots);
  assert.strictEqual(model.uvi.delta, -18);
});

test('the competitor table itself carries the engine caveat', () => {
  const md = sectionRunComparison(snapshots);
  const lostBlock = md.slice(md.indexOf('**Where you lost ground:**'));
  const upToNextSection = lostBlock.slice(0, lostBlock.indexOf('_Most frequently'));

  assert.match(upToNextSection, /different model than last run/,
    `rows measured on a swapped engine must be marked in the table itself; got:\n${upToNextSection}`);
  assert.match(upToNextSection, /4 of 5 rows above were measured on a different model/,
    `the table must state HOW MANY of its own rows are affected; got:\n${upToNextSection}`);
  // The names it is qualifying are still there — this is attribution, not
  // suppression. Removing the finding would be a different kind of lie.
  assert.match(upToNextSection, /Talk2Forms/);
});

test('«было → стало» names the actual model ids, on both engines', () => {
  const md = sectionRunComparison(snapshots);
  assert.match(md, /ChatGPT ran gpt-5-search-api last time and gpt-5\.4-mini this time/, md);
  assert.match(md, /Gemini ran gemini-3\.5-flash last time and gemini-3\.7-flash this time/, md);
});

test('zero overlap is named as its own state, not folded into "the model changed"', () => {
  const md = sectionRunComparison(snapshots);
  assert.match(md, /no overlap at all between the two runs/, md);
  const model = buildRunComparison(snapshots);
  assert.deepStrictEqual(model.modelChanges.noOverlapProviders, ['gemini', 'openai']);
  assert.strictEqual(model.counts.lostOnChangedEngine, 4);
});

/**
 * Build a two-run pair where the brand's presence is IDENTICAL and only the
 * engine moved. Deliberately not a fixture: the point is the shape (flat
 * visibility across a swap), and inlining it makes the shape readable.
 */
function flatPairAcrossSwap(beforeModel, afterModel) {
  const cells = (model) => ['Q1', 'Q2', 'Q3'].map((query, i) => ({
    query, queryText: `question ${i + 1}`, provider: 'openai', label: 'ChatGPT',
    model, mode: 'web', mention: 'yes', position: 1, citationCount: 1,
    canonicalCitations: ['https://example.com/a'], competitors: [],
    hasBrandInCitations: true,
  }));
  return [
    { date: '2026-08-01', brand: 'TestBrand', domain: 'testbrand.com', score: 100, results: cells(beforeModel) },
    { date: '2026-09-01', brand: 'TestBrand', domain: 'testbrand.com', score: 100, results: cells(afterModel) },
  ];
}

test('a flat run across an engine swap is not described as movement', () => {
  // The path this diff itself opened. Stopping the calm "visibility held
  // steady" message from firing on a swapped engine is right — but it drops
  // the reader into the full body, where the caveat used to close with "The
  // movement is still real and still worth acting on" two paragraphs under a
  // headline reading "unchanged". Self-contradictory copy on the exact surface
  // this section exists to keep honest, and reachable on the very next run for
  // any brand whose presence pattern happens to hold across the default bump.
  const md = sectionRunComparison(flatPairAcrossSwap('gpt-5-search-api', 'gpt-5.4-mini'));
  assert.match(md, /unchanged/, `precondition: the pair really is flat; got:\n${md}`);
  assert.match(md, /A note on the measurement/,
    `the swap must still be disclosed on a flat run; got:\n${md}`);
  assert.ok(!/The movement is still real/.test(md),
    `asserted movement on a run where nothing moved:\n${md}`);
  assert.match(md, /Nothing changed hands this run/,
    `expected the flat-run wording instead; got:\n${md}`);
});

test('the caveat describes WHAT changed, not just how strong it was', () => {
  // `moderate` strength is shared by a genuine small step and by "we could not
  // relate these two ids at all", and `strong` is shared by a model swap and by
  // a change of measurement surface. Copy chosen from strength alone therefore
  // said "a smaller step within the same model family" about a column that had
  // moved between a pasted app answer and a live API call.
  const surface = sectionRunComparison(flatPairAcrossSwap('manual', 'gpt-5.4-mini'));
  assert.match(surface, /different surfaces, not just different models/, surface);
  // `manual` is an internal sentinel — it must never reach the copy as if it
  // were a model name ("ChatGPT ran manual last time").
  assert.match(surface, /ran a pasted answer from its own app last time/, surface);
  assert.ok(!/ran manual last time/.test(surface), surface);
  assert.ok(!/smaller step within the same model family/.test(surface),
    `a surface change was described as a small model step:\n${surface}`);

  const minor = sectionRunComparison(flatPairAcrossSwap('gpt-5.4-mini', 'gpt-5.5-mini'));
  assert.match(minor, /smaller step within the same model family/, minor);
});

test('the portal payload carries the same axis, with the strength split intact', () => {
  const payload = buildComparisonPayload(snapshots, { domain: 'typelessform.com' });
  assert.strictEqual(payload.modelChange.changed, true);
  assert.deepStrictEqual(payload.modelChange.explanatoryProviders, ['gemini', 'openai']);
  const openai = payload.modelChange.engines.find((e) => e.provider === 'openai');
  // A product-line swap and a minor version step explain very different
  // amounts of movement; flattening them to one flag would make the caveat
  // useless on the runs where it matters most.
  assert.strictEqual(openai.kind, 'line');
  assert.strictEqual(openai.strength, 'strong');
  const gemini = payload.modelChange.engines.find((e) => e.provider === 'gemini');
  assert.strictEqual(gemini.kind, 'minor');
  assert.strictEqual(gemini.strength, 'moderate');
});
