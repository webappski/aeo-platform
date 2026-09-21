/**
 * «This part of the report is thinner than usual, and here is why» — the model,
 * and the promise that BOTH surfaces say it in the same words.
 *
 * R37: the roll-up is a pure reducer over records, so a unit test is the right
 * shape for it — no UI, no mocks, real inputs in and real values out. The
 * two-surface block is not a unit test of a helper: it renders the REAL
 * markdown section and the REAL HTML report and asserts the same sentence is in
 * both, which is the only assertion that can catch the failure this whole
 * module exists to prevent — a caveat that reaches one surface and not the one
 * the client is shown (lib/report/instrument-caveat.js, header).
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  degradationsFor, collectDegradations, buildSectionDegradationCaveat,
} from '../lib/report/section-degradation.js';
import { sectionScoreRepresentativeness } from '../lib/report/sections.js';
import { renderHtml } from '../lib/report/html.js';

// ── the per-cell derivation ───────────────────────────────────────────────

test('a clean cell produces no records at all', () => {
  assert.deepStrictEqual(degradationsFor({}), []);
  assert.deepStrictEqual(degradationsFor({
    extractionSources: {
      primary: { provider: 'openai', model: 'm1', brands: ['Acme'] },
      secondary: { provider: 'gemini', model: 'm2', brands: ['Acme'] },
    },
  }), []);
  // Mutation-sanity: emit a record for every seat regardless, and this goes red
  // — which matters, because a `degraded: []` on every cell would be written
  // into a year of summaries.
});

test('a failed seat records the TYPED cause, and an unknown kind is not guessed into one', () => {
  const [parsed] = degradationsFor({
    extractionSources: {
      primary: { provider: 'openai', model: 'm1', brands: [], error: 'extractor returned empty response', errorKind: 'parse', retriedOn: 'same-model' },
      secondary: { provider: 'gemini', model: 'm2', brands: ['Acme'] },
    },
  });
  assert.deepStrictEqual(parsed, {
    section: 'competitors', provider: 'openai', model: 'm1',
    kind: 'parse', recovered: false, retriedOn: 'same-model',
  });

  const [untyped] = degradationsFor({
    extractionSources: { primary: { provider: 'openai', model: 'm1', brands: [], error: 'something' } },
  });
  // R39 — the marker must not invent a cause. A record with no kind stays null
  // and is rendered as an unnamed failure, not as "the model returned bad JSON".
  assert.strictEqual(untyped.kind, null);
});

test('a slot that was re-asked and SUCCEEDED is recorded as recovered, not as a failure', () => {
  const [rec] = degradationsFor({
    sentiment: { slots: { primary: { provider: 'openai', model: 'm1', retriedOn: 'anthropic' }, secondary: null } },
  });
  assert.strictEqual(rec.section, 'sentiment');
  assert.strictEqual(rec.recovered, true);
  assert.strictEqual(rec.kind, 'parse');
  assert.strictEqual(rec.retriedOn, 'anthropic');
});

// ── the roll-up ───────────────────────────────────────────────────────────

const cellWithParseFailure = (provider = 'gemini') => ({
  mention: 'yes',
  degraded: [{ section: 'competitors', provider, model: 'm2', kind: 'parse', recovered: false, retriedOn: 'same-model' }],
});

test('identical failures collapse to one counted line, and degradations sort before recoveries', () => {
  const rolled = collectDegradations([
    cellWithParseFailure(), cellWithParseFailure(), cellWithParseFailure(),
    { mention: 'yes', degraded: [{ section: 'sentiment', provider: 'openai', model: 'm1', kind: 'parse', recovered: true, retriedOn: 'same-model' }] },
    { mention: 'no' },
  ]);
  assert.strictEqual(rolled.length, 2);
  assert.strictEqual(rolled[0].recovered, false, 'a reader acts on the failure, not on the recovery');
  assert.strictEqual(rolled[0].cells, 3, 'three cells, one line');
  assert.deepStrictEqual(rolled[0].providers, ['gemini']);
  assert.strictEqual(rolled[1].recovered, true);
});

test('an unknown section is ignored rather than printed as a headline about nothing', () => {
  const rolled = collectDegradations([
    { degraded: [{ section: 'wormhole', provider: 'openai', kind: 'parse' }] },
  ]);
  assert.deepStrictEqual(rolled, []);
});

test('a clean run gets no caveat — silence is the correct output', () => {
  assert.strictEqual(buildSectionDegradationCaveat([{ mention: 'yes' }, { mention: 'no' }]), null);
  assert.strictEqual(buildSectionDegradationCaveat([]), null);
  assert.strictEqual(buildSectionDegradationCaveat(undefined), null);
});

test('the caveat names the count and the typed cause — and what NOT to conclude', () => {
  const caveat = buildSectionDegradationCaveat([cellWithParseFailure(), cellWithParseFailure()]);
  assert.match(caveat.title, /2 answers were classified by one model instead of two/);
  const body = caveat.sentences.join(' ');
  assert.match(body, /Competitor cross-check: 2 answers could not be cross-checked/);
  assert.match(body, /not valid JSON/, 'the cause comes from the typed kind');
  // The sentence that stops the reader drawing a market conclusion from a
  // failed API call — the actual damage this card was filed about.
  assert.match(body, /not a finding that the market changed/);
});

test('the GRADING model is never named in the sentence, on any surface', () => {
  // The grading vendors are the same names this report uses for ANSWER ENGINES.
  // "Gemini returned unparseable JSON" in a note about the competitor list reads
  // as "your Gemini measurement is broken" — a second wrong conclusion inside
  // the copy written to prevent the first. It is also extractor plumbing, and
  // --white-label exists precisely to carry none of that.
  const caveat = buildSectionDegradationCaveat([
    cellWithParseFailure('gemini'),
    { degraded: [{ section: 'sentiment', provider: 'anthropic', model: 'm3', kind: 'parse', recovered: true, retriedOn: 'anthropic' }] },
  ]);
  const body = `${caveat.title} ${caveat.sentences.join(' ')}`;
  for (const vendor of [/Gemini/, /ChatGPT/, /Claude/, /Perplexity/, /gemini/, /openai/, /anthropic/]) {
    assert.doesNotMatch(body, vendor, `the caveat must not name a grading vendor; matched ${vendor}`);
  }
  // …but the vendor IS still in the data, for whoever debugs the run.
  assert.deepStrictEqual(collectDegradations([cellWithParseFailure('gemini')])[0].providers, ['gemini']);
});

test('an unnamed cause is reported as unnamed', () => {
  const caveat = buildSectionDegradationCaveat([
    { degraded: [{ section: 'competitors', provider: 'openai', kind: null, recovered: false }] },
  ]);
  assert.match(caveat.sentences.join(' '), /did not return a usable answer/);
  assert.doesNotMatch(caveat.sentences.join(' '), /JSON/, 'never guess "bad JSON" from a cause we do not have');
});

// ── the two surfaces ──────────────────────────────────────────────────────

const DEGRADED_RESULTS = [
  { query: 'Q1', queryText: 'best widgets', provider: 'openai', label: 'ChatGPT', model: 'm1', mention: 'yes', position: 1, citationCount: 0, canonicalCitations: [], competitors: [], competitorsUnverified: ['Acme Corp'], ...cellWithParseFailure() },
  { query: 'Q2', queryText: 'widget alternatives', provider: 'openai', label: 'ChatGPT', model: 'm1', mention: 'no', position: null, citationCount: 0, canonicalCitations: [], competitors: [], competitorsUnverified: [] },
];

const SNAPSHOT = {
  date: '2026-09-20',
  brand: 'TestBrand',
  domain: 'testbrand.com',
  score: 50, mentions: 1, total: 2, errors: 0,
  results: DEGRADED_RESULTS,
  topCompetitors: [], topCanonicalSources: [], topDomains: [],
};

const SUMMARY = {
  meta: { brand: 'TestBrand', domain: 'testbrand.com', date: '2026-09-20', prevDate: null, queryCount: 2, providerCount: 1, runId: 'test' },
  score: 50, scorePrev: null,
  trend: [50], trendDates: ['2026-09-20'],
  engines: [{ provider: 'openai', label: 'ChatGPT', model: 'm1', kind: 'm1', cells: ['yes', 'no'], pct: 50, hits: 1, total: 2, citations: 0, delta: null, series: [50] }],
  coverage: { yes: 1, src: 0, no: 1, error: 0, total: 2 },
  competitors: [],
};

test('the SAME sentence reaches the markdown report and the HTML report', () => {
  const caveat = buildSectionDegradationCaveat(DEGRADED_RESULTS);
  assert.ok(caveat, 'fixture must actually degrade, or this test asserts nothing');
  const sentence = caveat.sentences[0];

  const md = sectionScoreRepresentativeness([SNAPSHOT]);
  const html = renderHtml(SUMMARY, [SNAPSHOT]);

  assert.ok(md.includes(sentence), `markdown is missing the caveat sentence:\n${md}`);
  assert.ok(html.includes(sentence), 'HTML — the surface a client is shown — is missing the caveat sentence');
  // Mutation-sanity: delete either render site and exactly one of these two
  // goes red. That asymmetry IS the bug class — the markdown warned and the
  // page the founder prints did not.
});

test('the caveat reaches the public deliverable unchanged, still naming no grader', () => {
  // Deliberate, not an accident of placement: a client reading a thin competitor
  // list is exactly the reader who must know a call failed. `--public` is our
  // own page under our own name, so it keeps the full wording.
  const html = renderHtml(SUMMARY, [SNAPSHOT], { public: true });
  assert.ok(html.includes('could not be cross-checked'), 'caveat missing from public HTML');
  assert.doesNotMatch(html.slice(html.indexOf('could not be cross-checked') - 400, html.indexOf('could not be cross-checked') + 400),
    /Gemini|gemini/, 'public HTML names the grading vendor next to the caveat');
});

test('white-label keeps the caveat and drops the instrument architecture, not the warning', () => {
  // This test used to assert that the SAME sentence reaches white-label, on the
  // reasoning that it "carries no tool-internal detail". It does: a two-model
  // cross-check, an unparseable JSON reply and a re-ask are all how the tool is
  // built, and a self-made local stats tool has none of them. Corrected
  // 2026-09-21 (AP-LEAKTEST-BLIND-FIXTURES). The warning is what the client is
  // owed and it stays; the machinery is what breaks the legend and it goes.
  const html = renderHtml(SUMMARY, [SNAPSHOT], { whiteLabel: true });
  assert.ok(html.includes('classified at reduced confidence'),
    'white-label HTML must still tell the client those answers are weaker evidence');
  for (const re of [/grading model/i, /one model instead of two/i, /not valid JSON/i, /a second ask/i, /could not be cross-checked/]) {
    assert.doesNotMatch(html, re, `white-label HTML leaks the instrument architecture: ${re}`);
  }
  // Vendor check stays WINDOWED, as above: "Gemini" is a legitimate answer
  // engine all over this page — the leak would be naming it as the grader.
  const at = html.indexOf('classified at reduced confidence');
  assert.doesNotMatch(html.slice(at - 400, at + 400), /Gemini|gemini/,
    'white-label HTML names the grading vendor next to the caveat');
});

test('a clean run adds nothing to either surface', () => {
  const cleanResults = DEGRADED_RESULTS.map(({ degraded, ...rest }) => rest);
  const cleanSnapshot = { ...SNAPSHOT, results: cleanResults };
  const md = sectionScoreRepresentativeness([cleanSnapshot]);
  const html = renderHtml({ ...SUMMARY }, [cleanSnapshot]);
  assert.doesNotMatch(md, /could not be cross-checked/);
  assert.doesNotMatch(html, /could not be cross-checked/);
});
