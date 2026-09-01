// The matrix cell is a six-state control, and five of those states share one
// code path. This file pins the rendered HTML for each state against fixture
// data, because the classification itself (html.js — `noStatus`) is a silent
// three-way branch: a competitor cell, a cell that cited sources but named
// nobody, and a cell where the engine said nothing at all all arrive as
// `mention: 'no'` and are told apart only by what else the column carries.
//
// Written after a code review found the split shipping with zero coverage.
// Kept at the rendered-HTML level on purpose: the toggle's runtime behaviour
// needs a DOM this repo has no harness for, but WHICH class and WHICH glyph a
// given row produces is pure output and testable here in the ordinary style.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHtml } from '../../lib/report/html.js';

const ENGINE = { provider: 'openai', label: 'ChatGPT', model: 'gpt-test', kind: 'gpt-test', pct: 50, hits: 1, total: 2, citations: 3, delta: null, series: [50], cells: ['yes'] };

/** Render a one-engine report whose single matrix row carries `column`. */
function renderCell(column, coverage) {
  const summary = {
    meta: { brand: 'TestBrand', domain: 'testbrand.com', date: '2026-09-01', prevDate: null, queryCount: 1, providerCount: 1, runId: 'cellstates' },
    score: 50, scorePrev: null, trend: [50], trendDates: ['2026-09-01'],
    engines: [ENGINE],
    coverage: coverage || { yes: 1, src: 0, no: 1, error: 0, total: 2 },
    competitors: [], sources: [], quotes: [], citationOnly: [], actions: [],
    positionMatrix: [{ query: 'best test tools', columns: [{ provider: 'openai', label: 'ChatGPT', ...column }] }],
    totalCitations: 3, totalCitationsPrev: null,
    regionCount: 1, regions: [],
    sessionCostUsd: 0, totalCostUsd: 0, costBreakdown: [],
    topCompetitors: [], topCanonicalSources: [], topDomains: [],
  };
  return renderHtml(summary, null);
}

/** The single matrix data cell (the row-Σ tile is excluded by its own class). */
function cellOf(html) {
  const m = html.match(/<div class="mx-c (?!mx-c-total)([a-z-]+)"[^>]*>([\s\S]*?)<\/div>\s*<div class="mx-c mx-c-total"/);
  assert.ok(m, 'no matrix data cell rendered at all');
  return { cls: m[1], inner: m[2] };
}

test('a named answer is one glyph, not a repeated word', () => {
  const { cls, inner } = cellOf(renderCell({ mention: 'yes', position: 2, citationCount: 4 }));
  assert.equal(cls, 'named');
  assert.match(inner, /<span class="mx-v mx-v-mention">✓<\/span>/, 'Mention view must be the ✓ glyph');
  assert.match(inner, /#2/, 'Position view must show the rank when one exists');
  assert.doesNotMatch(inner, /named<\/span>/, 'the word "named" must not come back — the fill already says it');
});

test('a cited-only answer reads "cite", and keeps reading "cite" when unranked', () => {
  const { cls, inner } = cellOf(renderCell({ mention: 'src', position: null, citationCount: 9 }));
  assert.equal(cls, 'cited');
  assert.match(inner, /<span class="mx-v mx-v-mention">cite<\/span>/);
  assert.match(inner, /<span class="mx-v mx-v-position">cite<\/span>/,
    'an unranked cited cell must still read as cited in Position view, never fall through to a blank');
});

// ── the three-way "no mention" split ────────────────────────────────────────

test('competitor: the engine named someone else', () => {
  const { cls, inner } = cellOf(renderCell({ mention: 'no', citationCount: 5, competitors: [{ name: 'RivalCo' }, { name: 'OtherCo' }] }));
  assert.equal(cls, 'competitor');
  assert.match(inner, /class="mx-comp-name">RivalCo</);
  assert.match(inner, /class="mx-comp-more">\+1</, 'the remaining competitors are counted, not dropped');
  assert.doesNotMatch(inner, /↳/, 'the ↳ comes from CSS ::before — emitting it here too would double it');
});

test('empty: sources cited, none of them yours — the ratio is the finding', () => {
  const { cls, inner } = cellOf(renderCell({ mention: 'no', citationCount: 12, competitors: [] }));
  assert.equal(cls, 'empty');
  assert.match(inner, /class="mx-cited-share">0 \/ 12 cited</,
    'the count is the diagnosis (12 sources cited, yours in none) and must not be flattened to prose');
  assert.doesNotMatch(inner, /○/, 'the ○ comes from CSS ::before — emitting it here too would double it');
});

test('absent: no brands and no sources is its own state, not "empty"', () => {
  const { cls, inner } = cellOf(renderCell({ mention: 'no', citationCount: 0, competitors: [] }));
  assert.equal(cls, 'absent', 'a cell with nothing to report must not be mislabelled as a citation-pool miss');
  assert.doesNotMatch(inner, /cited/, 'there is no pool to report a share of');
});

test('an engine error is never silently folded into "not named"', () => {
  const { cls, inner } = cellOf(renderCell({ mention: 'error', errorMessage: 'rate limit exceeded (429)' }));
  assert.equal(cls, 'err');
  assert.match(inner, /err/);
});

// ── the placeholder contract ────────────────────────────────────────────────

test('every state fills all three view-spans, or the stylesheet fills them for it', () => {
  // Sentiment is only ever scored for named/cited cells, so competitor/empty/
  // absent cells ship an empty sentiment span by design. That is only safe
  // because the stylesheet draws a placeholder into ANY empty view-span;
  // without it those tiles render blank and read as a broken report.
  const css = renderCell({ mention: 'no', citationCount: 0, competitors: [] });
  assert.match(css, /\.mx-c \.mx-v:empty::after\s*\{[^}]*content:\s*'·'/,
    'the empty-view-span placeholder rule is missing — competitor/empty/absent cells will render blank in Sentiment view');

  for (const column of [
    { mention: 'no', citationCount: 0, competitors: [] },
    { mention: 'no', citationCount: 7, competitors: [] },
    { mention: 'no', citationCount: 0, competitors: [{ name: 'RivalCo' }] },
  ]) {
    const { inner } = cellOf(renderCell(column));
    for (const view of ['mention', 'position', 'sentiment']) {
      assert.match(inner, new RegExp(`class="mx-v mx-v-${view}"`),
        `the ${view} span must always be emitted — CSS cannot reveal a span that is not there`);
    }
  }
});

test('the toggle target and the legend target carry the same view attribute', () => {
  // The legend and the sentiment empty-state are siblings of .matrix, not of
  // .matrix-grid, so both nodes must carry data-view or one of them silently
  // stops responding to the toggle.
  const html = renderCell({ mention: 'yes', position: 1, citationCount: 2 });
  assert.match(html, /<div class="matrix" data-view="mention"/, '.matrix must carry the view attribute the legend selects on');
  assert.match(html, /<div class="matrix-grid" data-view="mention"/, '.matrix-grid must carry the view attribute the cells select on');
  assert.match(html, /wrap\.setAttribute\('data-view', view\)/, 'the toggle must mirror the view onto the wrapper, not just the grid');
});

// ── the per-engine headline states THIS run's result ────────────────────────

test('a zero-coverage run is not told it is cited when nothing of its was cited', () => {
  // Regression: "Cited but never named" fired on any coverage.yes === 0,
  // including runs where the domain was never a source either. Found on
  // merchpilot.ai's real 2026-08-31 run — 27 cells all `no`, zero of our URLs
  // in a 175-URL pool — where the client would have been told their site is
  // being cited. Three distinct states, each with copy that matches it.
  const nothing = renderCell({ mention: 'no', citationCount: 8, competitors: [] }, { yes: 0, src: 0, no: 27, error: 0, total: 27 });
  assert.match(nothing, /Neither named nor cited/);
  assert.doesNotMatch(nothing, /Cited but never named/);
  assert.doesNotMatch(nothing, /engines see your domain in citations/,
    'the sub must not claim citations the run does not have');
  assert.match(nothing, /none of the sources they cited were yours/);

  const citedOnly = renderCell({ mention: 'src', citationCount: 8 }, { yes: 0, src: 4, no: 23, error: 0, total: 27 });
  assert.match(citedOnly, /Cited but never named/);
  assert.match(citedOnly, /engines see your domain in citations/);

  const named = renderCell({ mention: 'yes', position: 1, citationCount: 2 }, { yes: 9, src: 2, no: 16, error: 0, total: 27 });
  assert.match(named, /Named in 9\/27 cells/);
  // Scoped to this block's own sub — "This run:" is a phrase other sections
  // use legitimately, so a whole-document search would assert nothing.
  const sub = named.match(/Every engine got the same questions\.[\s\S]*?<\/p>/);
  assert.ok(sub, 'the per-engine sub did not render');
  assert.doesNotMatch(sub[0], /This run:/, 'a run with hits leads with the count, not with a consolation sentence');
});
