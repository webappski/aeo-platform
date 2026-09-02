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
import { renderHtml } from '../../lib/report/html.js';

const PAIR = join(FIXTURE_ROOT, 'model-change-pair');
const snapshots = ['prev.json', 'curr.json'].map(
  (f) => JSON.parse(readFileSync(join(PAIR, f), 'utf-8')),
);

/**
 * The HTML report over a snapshot pair.
 *
 * `renderHtml` takes the run summary AND the snapshot history; the fixtures are
 * snapshots, so the summary is built around them here rather than committed as
 * a third fixture that could drift out of step with the pair it describes.
 * Everything the caveats depend on comes from `snaps`, not from this wrapper.
 */
function renderPair(snaps, opts = {}) {
  const [prev, curr] = [snaps[snaps.length - 2], snaps[snaps.length - 1]];
  const summary = {
    meta: {
      brand: curr.brand, domain: curr.domain, date: curr.date, prevDate: prev.date,
      queryCount: 3, providerCount: 4, runId: 'model-change-e2e',
    },
    score: curr.score, scorePrev: prev.score,
    trend: [prev.score, curr.score], trendDates: [prev.date, curr.date],
    engines: [], coverage: { yes: 0, src: 0, no: 0, error: 0, total: curr.results.length },
    competitors: [], sources: [], quotes: [], citationOnly: [], actions: [],
    positionMatrix: [], totalCitations: 0, totalCitationsPrev: null,
    regionCount: 1, regions: [], sessionCostUsd: 0, totalCostUsd: 0, costBreakdown: [],
    topCompetitors: [], topCanonicalSources: [], topDomains: [],
  };
  return renderHtml(summary, snaps, opts);
}

/** Strip tags so an assertion reads the sentence a human sees, not the markup. */
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

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

// ── The HTML surface ────────────────────────────────────────────────────────
//
// Everything above this line tests the markdown report. The markdown report is
// not the document anyone reads. On 2026-09-01 the HTML report — the file the
// founder opens and shows a client — printed «scored 50 of 100 … 42 points
// below the 2026-08-13 run» and named the companies that had taken the brand's
// place, with no mention anywhere on the page that ChatGPT had answered the two
// runs on two different models. The caveat model was built (`html.js` computed
// `buildRunComparison` into a local) and then read by nothing: the guard stood
// at the wrong door for a month, and every test in this file passed throughout.
//
// So these assertions run the REAL HTML renderer over the REAL pair.

test('the HTML report carries the caveat at all — the door the guard was missing', () => {
  const html = renderPair(snapshots);
  assert.match(html, /A note on the measurement/,
    'the HTML report printed a movement figure with no instrument caveat anywhere');
  // The «было → стало» in the form a reader can check, on both swapped engines.
  assert.match(text(html), /ChatGPT ran gpt-5-search-api last time and gpt-5\.4-mini this time/);
  assert.match(text(html), /Gemini ran gemini-3\.5-flash last time and gemini-3\.7-flash this time/);
  assert.match(text(html), /no overlap at all between the two runs/,
    'zero overlap is a stronger statement than "the model changed" and must survive to HTML');
});

test('the caveat LEADS the section that names competitors, never trails it', () => {
  // A note underneath does not reach a reader who has already read the names —
  // the same rule the markdown table follows with its per-row mark.
  const html = renderPair(snapshots);
  const overview = html.slice(html.indexOf('id="overview"'), html.indexOf('id="visibility"'));
  const caveatAt = overview.indexOf('A note on the measurement');
  const namesAt = overview.indexOf('Who was named instead');
  assert.ok(caveatAt >= 0, 'no caveat inside the Overview section');
  if (namesAt >= 0) {
    assert.ok(caveatAt < namesAt,
      'the caveat rendered BELOW the block that names competitors — that is the footnote failure');
  }
});

test('the caveat states the delta rather than withholding it, on HTML too', () => {
  // Founder ruling 2026-09-01: «никак мы не можем не сравнивать его движение».
  // A regression that turned the caveat into a refusal to compare is as wrong
  // as the original defect, in the opposite direction.
  //
  // The sentence asserted here is the one the shipped 2026-09-01 report.html
  // actually carried, verbatim.
  //
  // SCOPE, precisely: this pins that the delta survives, and that the same
  // document now carries the caveat SOMEWHERE. It does NOT pin that a reader
  // meets the caveat before the number — the hero lede is still byte-identical
  // and still carries no marker of its own; the caveat leads Overview, which is
  // the third block of the page. The founder chose that placement (2026-09-02)
  // over restoring a full Run Comparison chapter. The guarantee that IS pinned
  // on ordering is the test above: within Overview, the caveat precedes the
  // block that names competitors.
  const html = renderPair(snapshots);
  const lede = text(html.match(/<p class="lr-hero-lede">([\s\S]*?)<\/p>/)?.[1] || '');
  assert.match(lede, /scored 50 of 100 on 2026-09-01 — 42 points below the 2026-08-13 run/,
    `the movement must still be stated in full; hero lede was:\n${lede}`);
  assert.match(text(html), /A note on the measurement/,
    'the same report must now also say the two runs were not measured the same way');
});

test('a white-label client snapshot keeps the caveat', () => {
  // White-label strips the tool fingerprint and the advice. The honesty
  // qualifier on the statistics is not either of those, and it ships in the
  // deliverable a paying client acts on — the one reader who most needs it.
  const html = renderPair(snapshots, { whiteLabel: true });
  assert.match(html, /A note on the measurement/);
  assert.match(text(html), /gpt-5-search-api/,
    'the model id is the only checkable form of the claim and survives white-label');
});

// ── The coverage axis: an engine on only one side of the pair ───────────────
//
// The same class of silence, one axis over. `buildModelChanges` deliberately
// skips a provider present in only one run — correctly, it is not an instrument
// swap — and until 2026-09-02 the coverage side was then reported by nobody: it
// landed in `segments.indeterminate`, whose count reached the payload and no
// renderer. An engine measured last run and skipped this run said nothing.

/** The same pair with one engine missing from the newest run. */
const droppedPair = [
  snapshots[0],
  { ...snapshots[1], results: snapshots[1].results.filter((r) => r.provider !== 'perplexity') },
];

/** The same pair with an engine that appears only in the newest run. */
const addedPair = [
  { ...snapshots[0], results: snapshots[0].results.filter((r) => r.provider !== 'perplexity') },
  snapshots[1],
];

/** Both at once: one engine leaves, another arrives. */
const swappedPair = [
  { ...snapshots[0], results: snapshots[0].results.filter((r) => r.provider !== 'anthropic') },
  { ...snapshots[1], results: snapshots[1].results.filter((r) => r.provider !== 'perplexity') },
];

test('a dropped engine is named, with the number of answers it takes out', () => {
  const model = buildRunComparison(droppedPair);
  assert.deepEqual(model.coverageChange.dropped, [
    { provider: 'perplexity', label: 'Perplexity', cells: 3 },
  ]);

  const md = sectionRunComparison(droppedPair);
  assert.match(md, /Perplexity was measured in the previous run and not in this one/, md);
  assert.match(md, /its 3 answers are left out of the tally of answers won, held and lost/,
    `the count is the part that lets a reader judge the comparison; got:\n${md}`);

  const html = text(renderPair(droppedPair));
  assert.match(html, /Perplexity was not measured this run/, html);
  assert.match(html, /its 3 answers are left out of the tally of answers won, held and lost/, html);
});

test('an ADDED engine is named too — the branch that shipped a false claim', () => {
  // This path had no assertion on its rendered sentence in the first version of
  // this diff, and that is exactly where the falsehood below hid: it asserted
  // the new engine "counts towards this run's score and towards no movement
  // figure". A branch whose generated English nobody reads is a branch that
  // will say something untrue.
  const model = buildRunComparison(addedPair);
  assert.deepEqual(model.coverageChange.added, [
    { provider: 'perplexity', label: 'Perplexity', cells: 3 },
  ]);
  assert.deepEqual(model.coverageChange.dropped, []);

  const md = sectionRunComparison(addedPair);
  assert.match(md, /Perplexity was measured in this run and not in the previous one/, md);
  assert.match(md, /there is nothing on the other side to compare them against/, md);
  // "too" leans on a dropped sentence that does not exist here.
  assert.ok(!/tally of answers won, held and lost too/.test(md),
    `the added-only sentence referred back to a sentence that was never printed:\n${md}`);

  const html = text(renderPair(addedPair));
  assert.match(html, /Perplexity is new to this run/, html);
});

test('neither caveat claims the score is scoped to the shared engines', () => {
  // The claim a review caught before it shipped. Only the won/held/lost tally
  // is shared-cell-scoped; the index is scored per run over that run's own
  // answers, so coverage moves it by basket composition alone. Proven here
  // rather than asserted, so a future rewording cannot quietly re-adopt the
  // false version.
  const base = buildRunComparison(snapshots).uvi.delta;
  const withDrop = buildRunComparison(droppedPair).uvi.delta;
  const withAdd = buildRunComparison(addedPair).uvi.delta;
  assert.notEqual(withDrop, base,
    'precondition: dropping an engine really does move the headline delta');
  assert.notEqual(withAdd, base,
    'precondition: adding an engine really does move the headline delta');

  for (const pair of [droppedPair, addedPair]) {
    const md = sectionRunComparison(pair);
    assert.ok(!/compared only on the engines they share/.test(md),
      `claimed the comparison excludes the coverage change when the score does not:\n${md}`);
    assert.ok(!/no movement figure/.test(md),
      `claimed the new engine touches no movement figure when it moves the delta:\n${md}`);
    assert.match(md, /part of the movement between the two belongs to the change in coverage/,
      `the score needs the same hedge the instrument caveat gives it; got:\n${md}`);
  }
});

test('a swap — one engine out, another in — names both, and hedges once', () => {
  const model = buildRunComparison(swappedPair);
  assert.deepEqual(model.coverageChange.dropped.map((d) => d.provider), ['perplexity']);
  assert.deepEqual(model.coverageChange.added.map((a) => a.provider), ['anthropic']);

  const md = sectionRunComparison(swappedPair);
  assert.match(md, /Perplexity was measured in the previous run and not in this one/, md);
  assert.match(md, /Claude was measured in this run and not in the previous one/, md);
  // The score hedge is one sentence however many sides fired — saying it twice
  // reads as two separate problems with the same number.
  assert.equal(md.match(/part of the movement between the two belongs to the change in coverage/g).length, 1, md);

  // A heading that named only the departing engine would let a reader who stops
  // at headings accept the newcomer on a caveat that never mentioned it.
  const html = text(renderPair(swappedPair));
  assert.match(html, /Perplexity was not measured this run, Claude is new to it/, html);
});

test('two engines leaving at once read as plural, with their combined count', () => {
  const twoOut = [
    snapshots[0],
    { ...snapshots[1], results: snapshots[1].results.filter((r) => r.provider !== 'perplexity' && r.provider !== 'anthropic') },
  ];
  const md = sectionRunComparison(twoOut);
  // Named in provider-id order (anthropic, perplexity), which is what
  // `buildModelChanges` sorts by — stable run to run, so the sentence does not
  // reshuffle its own engines between two reports of the same change.
  assert.match(md, /Claude and Perplexity were measured in the previous run and not in this one/, md);
  assert.match(md, /their 6 answers are left out/,
    `the plural path emitted singular grammar or the wrong count; got:\n${md}`);
});

test('two engines arriving at once read as plural too', () => {
  // The mirror of the case above. Kept for suite symmetry: the two sides are
  // separate branches with separate grammar, and the added side is the one that
  // shipped a false sentence once already because nothing read its output.
  const twoIn = [
    { ...snapshots[0], results: snapshots[0].results.filter((r) => r.provider !== 'perplexity' && r.provider !== 'anthropic') },
    snapshots[1],
  ];
  const md = sectionRunComparison(twoIn);
  assert.match(md, /Claude and Perplexity were measured in this run and not in the previous one/, md);
  assert.match(md, /their 6 answers are left out/, md);
  assert.match(md, /nothing on the other side to compare them against/, md);
});

test('a single excluded answer reads "1 answer is", not "1 answers are"', () => {
  // No fixture in this file reaches cells === 1 — the pair is three questions
  // wide, so a dropped engine always takes 3 or 6 answers with it. The singular
  // branch is therefore only reachable from a purpose-built pair, and without
  // one it would ship having never rendered.
  const one = (provider) => ([{
    query: 'Q1', queryText: 'question 1', provider, label: provider === 'openai' ? 'ChatGPT' : 'Perplexity',
    model: 'gpt-5.4-mini', mode: 'web', mention: 'yes', position: 1, citationCount: 1,
    canonicalCitations: ['https://example.com/a'], competitors: [], hasBrandInCitations: true,
  }]);
  const pair = [
    { date: '2026-08-01', brand: 'TestBrand', domain: 'testbrand.com', score: 100, results: [...one('openai'), ...one('perplexity')] },
    { date: '2026-09-01', brand: 'TestBrand', domain: 'testbrand.com', score: 100, results: one('openai') },
  ];
  const md = sectionRunComparison(pair);
  assert.match(md, /its 1 answer is left out/, md);
  assert.ok(!/1 answers are/.test(md), `singular count with plural verb:\n${md}`);
});

test('an errored cell on a SHARED engine is never counted against a dropped one', () => {
  // `segments.indeterminate` holds both — one-sided cells and cells that simply
  // failed — and the count is filtered by provider. If that filter ever went
  // away the report would overstate how many answers the missing engine took
  // with it, which is the one number in the sentence a reader can act on.
  const withError = [
    snapshots[0],
    {
      ...snapshots[1],
      results: snapshots[1].results
        .filter((r) => r.provider !== 'perplexity')
        .map((r, i) => (i === 0 ? { ...r, mention: 'error' } : r)),
    },
  ];
  const model = buildRunComparison(withError);
  assert.ok(model.counts.indeterminate > 3,
    'precondition: there is an errored shared-engine cell alongside the dropped engine');
  assert.deepEqual(model.coverageChange.dropped, [
    { provider: 'perplexity', label: 'Perplexity', cells: 3 },
  ]);
});

test('a dropped engine is never smoothed into "visibility held steady"', () => {
  // The failure mode this closes: a one-sided cell is `indeterminate`, which
  // keeps `lost` and `gained` at zero — so a run that quietly stopped measuring
  // an engine was the very shape that produced the calm all-clear message.
  const flat = (providers) => providers.map((provider, i) => ({
    query: `Q${i + 1}`, queryText: `question ${i + 1}`, provider, label: provider,
    model: 'gpt-5.4-mini', mode: 'web', mention: 'yes', position: 1, citationCount: 1,
    canonicalCitations: ['https://example.com/a'], competitors: [], hasBrandInCitations: true,
  }));
  const pair = [
    { date: '2026-08-01', brand: 'TestBrand', domain: 'testbrand.com', score: 100, results: flat(['openai', 'perplexity']) },
    { date: '2026-09-01', brand: 'TestBrand', domain: 'testbrand.com', score: 100, results: flat(['openai']) },
  ];
  const md = sectionRunComparison(pair);
  assert.ok(!/held steady across every tracked question and engine/.test(md),
    `claimed every engine held steady on a run that skipped one:\n${md}`);
  assert.match(md, /A note on the coverage/, md);
});

test('both notes can fire on one run, and stay two separate facts', () => {
  // "The ruler moved" and "this engine was not on the ruler at all" mean
  // different things — only the second says part of the comparison has no basis
  // rather than an uncertain one. Merging them would let a reader discount a
  // missing engine as a model-version footnote.
  const html = text(renderPair(droppedPair));
  assert.match(html, /A note on the measurement/);
  assert.match(html, /A note on the coverage/);
  assert.ok(html.indexOf('A note on the measurement') < html.indexOf('A note on the coverage'));
});

test('the portal payload carries the coverage axis too', () => {
  const payload = buildComparisonPayload(droppedPair, { domain: 'typelessform.com' });
  assert.deepEqual(payload.coverageChange.dropped, [
    { provider: 'perplexity', label: 'Perplexity', cells: 3 },
  ]);
  assert.deepEqual(payload.coverageChange.added, []);
  // Null, not absent, when both runs measured the same engines — same
  // convention as `modelChange`, so the portal tests one field either way.
  assert.equal(buildComparisonPayload(snapshots, { domain: 'typelessform.com' }).coverageChange, null);
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
