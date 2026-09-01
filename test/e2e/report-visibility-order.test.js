// The Visibility section has two audiences in one section, and their order —
// and now their folded state — is a product decision, not a rendering accident.
//
// The three scan blocks — per-engine card, query × engine matrix, verbatim
// answers — answer "what happened this run" at a glance. The question-by-
// question record answers "what happened to THIS question, across every run"
// and is the layer most readers never open. It used to render FIRST, above
// all three, so the reader met the deepest material before the summary.
// Founder ruling 2026-09-01: it moves behind them, and the two longest blocks
// (verbatim answers, the record) fold shut so neither unrolls unasked.
//
// Nothing else pins any of this. The order is decided by one field in
// SECTION_SPECS (`tail:` vs `lead:`) and three guards in the section renderer
// that must all agree about `tail`. The folding is safe ONLY because the
// inline print handler opens every `.fold` before a PDF is drawn — a closed
// <details> cannot be opened by CSS, so a narrowed selector there deletes
// both blocks from the client's PDF with no symptom on screen. This file is
// the guard for all three.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../../lib/report/html.js';

const QUERIES = [
  ['Q1', 'best voice form builder 2026'],
  ['Q2', 'conversational form widget for Shopify'],
];
const PROVIDERS = [['openai', 'ChatGPT'], ['gemini', 'Gemini']];

/** One synthetic run — the shape buildAnswerHistory() walks. */
function makeSnapshot(index, score) {
  const results = [];
  QUERIES.forEach(([query, queryText]) => {
    PROVIDERS.forEach(([provider, label]) => {
      results.push({
        query, queryText, provider, label,
        model: 'test-model', mode: 'web',
        mention: 'yes', position: 1, citationCount: 2,
        canonicalCitations: ['https://testbrand.com/a', 'https://rival.example/b'],
        competitors: ['Rival One'],
        responseQuality: 'rich', hasBrandInCitations: true,
        responseExcerpt: 'excerpt',
      });
    });
  });
  return {
    date: `2026-01-0${index}`, score, results,
    brand: 'TestBrand', domain: 'testbrand.com',
    topCompetitors: [{ name: 'Rival One', count: 1 }],
    topDomains: [{ host: 'testbrand.com', count: 4 }],
  };
}

/**
 * A report carrying BOTH populations at once: `snapshots` feed the answer
 * history (the question cards), `positionMatrix` with responseFull feeds the
 * matrix and the verbatim reveals. A fixture missing either one would make
 * the order assertions below pass vacuously.
 */
function render() {
  const snaps = [makeSnapshot(1, 40), makeSnapshot(2, 55)];
  const positionMatrix = QUERIES.map(([, queryText]) => ({
    query: queryText,
    columns: PROVIDERS.map(([provider, label]) => ({
      provider, label, mention: 'yes', position: 1, citationCount: 2, competitors: [],
      responseFull: `${label} names TestBrand first when asked about ${queryText}.`,
    })),
  }));
  const summary = {
    meta: {
      brand: 'TestBrand', domain: 'testbrand.com',
      date: '2026-01-02', prevDate: '2026-01-01',
      runId: 'order', queryCount: QUERIES.length, providerCount: PROVIDERS.length,
    },
    score: 55, scorePrev: 40, trend: [40, 55], trendDates: ['2026-01-01', '2026-01-02'],
    engines: PROVIDERS.map(([provider, label]) => ({
      provider, label, model: 'test-model', kind: 'test',
      pct: 100, hits: 2, total: 2, citations: 4, delta: null, series: [100], cells: ['yes'],
    })),
    coverage: { yes: 4, src: 0, no: 0, error: 0, total: 4 },
    competitors: [{ name: 'Rival One', count: 1 }],
    sources: [], quotes: [], citationOnly: [], actions: [],
    positionMatrix,
    totalCitations: 8, totalCitationsPrev: 8,
    regionCount: 1, regions: [],
    sessionCostUsd: 0, totalCostUsd: 0, costBreakdown: [],
    topCompetitors: [{ name: 'Rival One', count: 1 }],
    topCanonicalSources: [], topDomains: [{ host: 'testbrand.com', count: 4 }],
  };
  return renderHtml(summary, snaps);
}

test('the question record renders BELOW the three blocks a reader scans', () => {
  const html = render();

  // Every landmark must exist before any order claim about it means anything.
  const engines = html.indexOf('Per-engine visibility');
  const matrix = html.indexOf('Query × engine matrix');
  const verbatim = html.indexOf('cell-label">Verbatim answers');
  const record = html.indexOf('class="lr-card lr-answers"');
  assert.ok(engines > -1, 'fixture rendered no per-engine block');
  assert.ok(matrix > -1, 'fixture rendered no matrix block');
  assert.ok(verbatim > -1, 'fixture rendered no verbatim block — the order check would be vacuous');
  assert.ok(record > -1, 'fixture rendered no question cards — the order check would be vacuous');

  assert.ok(engines < matrix, 'per-engine block must precede the matrix');
  assert.ok(matrix < verbatim, 'the matrix must precede the verbatim answers');
  assert.ok(verbatim < record,
    'the question-by-question record must come AFTER the verbatim answers — it is the layer most readers never open');
});

test('the record is introduced by its own sub-header, not left hanging under the bento', () => {
  const html = render();
  const subsec = html.indexOf('class="lr-subsec"');
  const record = html.indexOf('class="lr-card lr-answers"');
  assert.ok(subsec > -1, 'the record must be announced — an unlabelled fold after a bento reads as a rendering bug');
  assert.ok(subsec < record, 'the sub-header must precede the cards it introduces');
  assert.match(html, /class="lr-subsec"[\s\S]{0,400}?Question by question/);
  assert.match(html, /\.lr-subsec\s*\{/, 'the sub-header rule must ship in the embedded stylesheet');
  // The heading and its explanation stay OUTSIDE the fold: a reader has to be
  // able to learn what is behind the click without making it.
  const foldAt = html.indexOf('<details class="fold"', subsec);
  assert.ok(subsec < foldAt && foldAt < record,
    'the fold must sit between the sub-header and the cards, not swallow the header');
});

test('both long blocks ship folded shut, and the fold is the ONLY new collapse level', () => {
  const html = render();
  const folds = html.match(/<details class="fold"[^>]*>/g) || [];
  assert.equal(folds.length, 2, 'exactly two folds: the verbatim answers and the record');
  for (const f of folds) {
    assert.doesNotMatch(f, /\bopen\b/, 'a fold that ships open defeats the whole change');
  }
  // The rows INSIDE the record stay open — answerCard's contract is unchanged,
  // and a second collapse level would make the reader click twice for one row.
  assert.match(html, /<details class="lr-answer" open/);
  assert.doesNotMatch(html, /<details class="lr-answer"(?! open)/,
    'no answer row may ship closed');
});

test('the print handler opens the folds, or the client PDF loses both blocks', () => {
  // A closed <details> cannot be opened by CSS, and an outer closed <details>
  // prints nothing in some engines even when its children carry `open`. The
  // inline handler is the entire reason folding is safe here; narrowing its
  // selector back to '.reveal' would silently drop the verbatim answers and
  // the whole per-question record from every saved PDF, with no symptom on
  // screen. Asserted against the emitted script text, since there is no DOM
  // harness in this repo to fire beforeprint against.
  const html = render();
  assert.match(html, /querySelectorAll\('\.reveal, \.fold'\)/,
    'the print expander must select .fold as well as .reveal');
  assert.match(html, /addEventListener\('beforeprint'/);
  assert.match(html, /addEventListener\('afterprint'/,
    'the screen state must be restored after printing');
  assert.match(html, /@media print\s*\{[\s\S]*?\.fold-sum\s*\{\s*display:\s*none/,
    '"Show all N answers" is a dead instruction on paper and must not print');
});

test('the fold summary carries the count, and says so in one place only', () => {
  const html = render();
  // 2 questions × 2 engines in the fixture.
  assert.match(html, /class="fold-show">Show all 4 answers</,
    'the verbatim fold must state how many answers are behind it');
  assert.match(html, /class="fold-show">Show the record for all 2 questions</);
  assert.match(html, /class="fold-hide">Hide answers</,
    'the label must flip when open — a summary that still reads "Show" while open is a broken control');
  assert.doesNotMatch(html, /class="reveals-hint"/,
    'the old always-visible hint is replaced by the fold summary; two prompts for one control is one too many');
});

test('both folds are marked as the proof layer, and only those two are', () => {
  // The same word in the same position on both is what makes them read as one
  // kind of thing — the layer a reader opens to see WHY, not the report's
  // spine. A third block wearing it would dilute that to decoration.
  const html = render();
  const tags = html.match(/class="fold-tag">([^<]+)</g) || [];
  assert.equal(tags.length, 2, 'exactly two blocks carry the marker: the verbatim answers and the record');
  assert.ok(tags.every(t => t.includes('Evidence')), 'both markers must read the same');
  assert.doesNotMatch(html, /class="fold-tag">\s*Advanced/i,
    'a badge telling a paying reader a section is above their level tells them not to read what they bought');
  // The purpose line, not the marker, is what a reader actually decides on.
  assert.match(html, /class="fold-meta">read exactly how an engine worded its answer</);
  assert.match(html, /class="fold-meta">trace why one question keeps failing</);
  assert.match(html, /\.fold-tag\s*\{/, 'the marker rule must ship in the embedded stylesheet');
});

test('the section still renders when only the record has data', () => {
  // `cells` come from this run's positionMatrix, the record from the answer
  // history across snapshots — a partial run can leave one empty and the
  // other full. With the substance in `tail`, a renderer guard that keys only
  // on `lead` prints "No visibility data this run." above a populated record.
  const snaps = [makeSnapshot(1, 40), makeSnapshot(2, 55)];
  const html = renderHtml({
    meta: {
      brand: 'TestBrand', domain: 'testbrand.com',
      date: '2026-01-02', prevDate: '2026-01-01',
      runId: 'order-partial', queryCount: QUERIES.length, providerCount: PROVIDERS.length,
    },
    score: 55, scorePrev: 40, trend: [40, 55], trendDates: ['2026-01-01', '2026-01-02'],
    engines: [], coverage: { yes: 4, src: 0, no: 0, error: 0, total: 4 },
    competitors: [], sources: [], quotes: [], citationOnly: [], actions: [],
    positionMatrix: [],
    totalCitations: 8, totalCitationsPrev: 8,
    regionCount: 1, regions: [],
    sessionCostUsd: 0, totalCostUsd: 0, costBreakdown: [],
    topCompetitors: [], topCanonicalSources: [], topDomains: [],
  }, snaps);

  assert.match(html, /class="lr-card lr-answers"/, 'the record is the section\'s remaining substance and must render');
  assert.doesNotMatch(html, /No visibility data this run\./,
    'the empty-state placeholder must not print above a populated record');
});
