// loud.js — the register contract, enforced on the markup itself.
//
// These are not cosmetic assertions. Each one guards a rule from the approved
// spec that is invisible until it is broken in a client's PDF:
//   * status is worded as well as coloured (WCAG 1.4.1)
//   * white text never sits on a fill that fails AA
//   * answer rows ship `open`, because CSS cannot open a <details> for print
//   * charts do not stretch their own labels
//   * the "where to act" line is never silently omitted

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  chip, pill, eyebrow, kpiCard, verdictHero, onePage, sectionHead,
  alertCard, quietCard, statusTile, whereToAct, recordDots, runStrip,
  indexChart, axisTable, shareTable, answerCard, engineDot, insetCard,
} from '../lib/report/loud.js';
import { ST_NAMED, ST_CITED, ST_ABSENT, ST_BLANK, VERDICT } from '../lib/report/answer-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(__dirname, '../lib/report/styles.css'), 'utf-8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const RUN_META = [
  { date: '2026-01-01', index: 1, partial: false },
  { date: '2026-02-01', index: 2, partial: true },
  { date: '2026-03-01', index: 3, partial: false },
];
const CAPS = { dotSize: 13, dotGap: 4, dotWindow: null, labelEvery: 1 };

console.log('\nloud — status is worded, not only coloured');

test('every chip carries its own text', () => {
  for (const tone of ['good', 'bad', 'quiet', 'flat']) {
    const html = chip('▼ 8 points', tone);
    assert.match(html, /data-tone="/, 'tone attribute missing');
    assert.match(html, />▼ 8 points</, `chip tone=${tone} lost its text`);
  }
});

test('every status pill carries its own text', () => {
  assert.match(pill('Unreachable', 'bad'), />Unreachable</);
  assert.match(pill('Allowed', 'good'), />Allowed</);
});

test('a status tile names the thing and states the status in words', () => {
  const html = statusTile({ name: 'npmjs.com', status: 'Unreachable', tone: 'bad' });
  assert.match(html, /npmjs\.com/);
  assert.match(html, />Unreachable</);
});

test('a status tile keeps a long, prefix-sharing host name intact — the component itself never slices it', () => {
  // typelessform.com / typelessity.com share a long prefix; a JS-side
  // truncation (e.g. a future `.slice(0, N) + '…'`) would make both read
  // identically. statusTile() must always emit the full string — clipping,
  // if any, is a CSS-only, purely visual concern (next two tests).
  const a = statusTile({ name: 'typelessform.com', status: 'Reciprocates', tone: 'good' });
  const b = statusTile({ name: 'typelessity.com', status: 'Reciprocates', tone: 'good' });
  assert.match(a, />typelessform\.com</, 'host name truncated or altered in the markup itself');
  assert.match(b, />typelessity\.com</, 'host name truncated or altered in the markup itself');
});

test('.lr-tile-name never truncates with an ellipsis — a long host name must stay fully readable, not clip', () => {
  // Regression guard: a prior fix (reverted per founder correction) made
  // .lr-tile-name `overflow: hidden; text-overflow: ellipsis; white-space:
  // nowrap`, which silently clipped host names — "typelessform.com" and
  // "typelessity.com" both rendered as "typele…", indistinguishable. The
  // name must always render in full; the pill shrinks/wraps instead (next
  // two tests), never the name.
  const rule = CSS.match(/\.lr-tile-name\s*\{[^}]*\}/s);
  assert.ok(rule, '.lr-tile-name has no rule at all');
  assert.doesNotMatch(rule[0], /text-overflow/, '.lr-tile-name must never truncate — the host name is the load-bearing fact in that row');
  assert.doesNotMatch(rule[0], /white-space:\s*nowrap/, '.lr-tile-name must be allowed to wrap, not forced onto one clipped line');
});

test('.lr-tile wraps instead of letting a long name and its pill collide', () => {
  // The tile's grid minimum (260px) plus a long host name can still leave no
  // room for the pill on one line — flex-wrap is the safety net that drops
  // the pill to its own line rather than overlapping/clipping either side.
  const rule = CSS.match(/\.lr-tile\s*\{[^}]*\}/s);
  assert.ok(rule, '.lr-tile has no rule at all');
  assert.match(rule[0], /flex-wrap:\s*wrap/, '.lr-tile must wrap — without it a long name + pill can only overflow or overlap');
});

test('the status pill shrinks inside a tile, so it never crowds out a long host name', () => {
  const scoped = CSS.match(/\.lr-tile \.lr-pill\s*\{[^}]*\}/s);
  assert.ok(scoped, 'no .lr-tile .lr-pill scoped rule — the pill renders at full base size next to the name');
  assert.match(scoped[0], /font-size:\s*1[0-3]px/, 'the in-tile pill should read smaller than the base pill (var(--t-body), 16px)');
  const base = CSS.match(/\.lr-pill\s*\{[^}]*\}/s);
  assert.doesNotMatch(base[0], /flex-shrink|font-size:\s*1[0-3]px/, 'the base .lr-pill (used outside tiles too) must stay unshrunk — only the tile-scoped rule shrinks it');
});

console.log('\nloud — contrast contract');

test('white text never sits on the decorative red or the accent orange', () => {
  // --error-color #FF4D4F (3.27:1) and --accent #F77300 (2.84:1) both fail AA
  // for white text. Any rule that sets a white foreground must pair it with a
  // fill from the surviving triple.
  const rules = CSS.split('}');
  const offenders = [];
  for (const rule of rules) {
    if (!/color:\s*(var\(--raised\)|#FFFFFF|#fff\b)/i.test(rule)) continue;
    if (/background:\s*var\(--error-color\)\s*;/.test(rule) || /background:\s*var\(--accent\)\s*;/.test(rule)) {
      offenders.push(rule.trim().split('\n')[0]);
    }
  }
  assert.deepEqual(offenders, [], `white text on a sub-AA fill: ${offenders.join(' | ')}`);
});

test('the retired status tokens are gone from the stylesheet', () => {
  // --good / --bad / --warn were retired outright rather than aliased, so a
  // rule cannot quietly drift back onto the previous palette.
  assert.ok(!/var\(--good[,)]/.test(CSS), '--good is still referenced');
  assert.ok(!/var\(--bad[,)]/.test(CSS), '--bad is still referenced');
  assert.ok(!/var\(--warn[,)]/.test(CSS), '--warn is still referenced');
  assert.match(CSS, /--error-color-strong:\s*#C22B2D/, 'the AA-safe red token is missing');
  assert.match(CSS, /--success-color:\s*#2E7D32/);
  assert.match(CSS, /--orange-600:\s*#B85000/);
});

test('the tertiary grey is confined to uppercase micro-labels', () => {
  // #A8AEB7 measures 2.23:1. It may set the eyebrow and nothing else.
  const usages = CSS.split('\n').filter(l => /var\(--text-tertiary\)/.test(l));
  assert.ok(usages.length > 0, 'the token should be used by the eyebrow');
  for (const line of usages) {
    assert.ok(!/font-size:\s*(2[0-9]|[3-9][0-9])px/.test(line),
      `--text-tertiary used on body-scale text: ${line.trim()}`);
  }
  assert.match(eyebrow('Score over time'), /class="lr-eyebrow"/);
});

console.log('\nloud — print constraints');

test('answer rows are emitted open, because CSS cannot open a <details> for print', () => {
  const group = {
    query: 'Q1', queryText: 'best voice form tools', named: 1, total: 1, lost: 0, gained: 0,
    cells: [{
      key: 'Q1::openai', query: 'Q1', queryText: 'best voice form tools',
      provider: 'openai', label: 'ChatGPT', rank: 1, citationCount: 3, competitors: [],
      states: [ST_NAMED, ST_NAMED, ST_NAMED], textDrift: null,
      state: ST_NAMED, verdict: VERDICT.HELD, record: 'Named on all 3 runs.',
    }],
  };
  const html = answerCard({ group, caps: CAPS, runMeta: RUN_META });
  assert.match(html, /<details class="lr-answer" open/, 'answer row is not shipped open');
  assert.ok(!/<details class="lr-answer">/.test(html), 'a collapsed row is invisible in the PDF');
});

test('the chart does not stretch its own labels', () => {
  const svg = indexChart({
    values: [33, 42, 92], dates: ['2026-01-01', '2026-02-01', '2026-03-01'],
    partial: [false, true, false], labelEvery: 1,
  });
  assert.ok(!/preserveAspectRatio="none"/.test(svg), 'preserveAspectRatio="none" distorts the glyphs');
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="[^"]*33[^"]*92/, 'the series must be readable without the picture');
});

test('the chart marks a partial run rather than hiding or trusting it', () => {
  const svg = indexChart({
    values: [33, 100, 92], dates: ['2026-01-01', '2026-02-01', '2026-03-01'],
    partial: [false, true, false], labelEvery: 1,
  });
  assert.match(svg, /lr-chart-partial/, 'partial run not marked on the plot');
  assert.match(svg, />partial</, 'partial run not labelled in words');
  assert.match(svg, /aria-label="[^"]*partial run/, 'partial run missing from the accessible label specifically — a per-point <title> also contains this substring, so the assertion must be anchored to aria-label or it stops proving anything about non-visual/print access');
});

test('the last-value label never sits in the fixed-y date-axis row — the "1"/"08-27" collision bug', () => {
  // A near-zero score parks the last point right on the baseline. The old
  // label was drawn at lastY + 26, which lands almost exactly on the axis
  // row's fixed y=224 whenever the score is low — garbling the two together.
  const svg = indexChart({
    values: [0, 0, 1], dates: ['2026-01-01', '2026-02-01', '2026-08-27'],
    partial: [false, false, false], labelEvery: 1,
  });
  const labelMatch = svg.match(/<text class="lr-chart-last-label"[^>]*y="([\d.]+)"/);
  assert.ok(labelMatch, 'last-value label missing');
  assert.ok(Number(labelMatch[1]) < 210, `last-value label at y=${labelMatch[1]} sits in the fixed-y (224) date-axis row`);
});

test('a repeated "partial" flag over every point is gone — one callout per contiguous partial stretch', () => {
  const svg = indexChart({
    values: [10, 10, 10, 10, 50, 90],
    dates: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'],
    partial: [true, true, true, true, false, false], labelEvery: 1,
  });
  const flagCount = (svg.match(/class="lr-chart-flag"/g) || []).length;
  assert.equal(flagCount, 1, 'four consecutive partial points must draw one shared callout, not four');
  assert.match(svg, /<circle class="lr-chart-partial"[^>]*><title>[^<]*partial run<\/title><\/circle>/,
    'each partial point must still keep its own marker + hover detail even without a visible flag');
});

test('a partial LAST run scoring near 100 does not collide with the top-of-chart "partial" callout', () => {
  // Boundary case caught in review: the last-value label sits ABOVE its
  // point by default, which is exactly where the partial callout lives —
  // openSideY() must flip it below once a high score pushes the point
  // into the callout's zone, whether or not that specific point is the
  // partial one.
  const svg = indexChart({
    values: [50, 97], dates: ['2026-01-01', '2026-02-01'],
    partial: [false, true], labelEvery: 1,
  });
  const flagY = Number(svg.match(/class="lr-chart-flag" x="[\d.]+" y="([\d.]+)"/)?.[1]);
  const labelY = Number(svg.match(/class="lr-chart-last-label"[^>]*y="([\d.]+)"/)?.[1]);
  assert.ok(Number.isFinite(flagY) && Number.isFinite(labelY), 'both the flag and the last-value label must render');
  assert.ok(Math.abs(flagY - labelY) >= 15,
    `partial flag (y=${flagY}) and last-value label (y=${labelY}) are too close — the same collision class, one boundary over`);
});

test('a partial FIRST run scoring near 100 does not collide with the top-of-chart "partial" callout', () => {
  const svg = indexChart({
    values: [98, 50], dates: ['2026-01-01', '2026-02-01'],
    partial: [true, false], labelEvery: 1,
  });
  const flagY = Number(svg.match(/class="lr-chart-flag" x="[\d.]+" y="([\d.]+)"/)?.[1]);
  const noteY = Number(svg.match(/class="lr-chart-note"[^>]*y="([\d.]+)"/)?.[1]);
  assert.ok(Number.isFinite(flagY) && Number.isFinite(noteY), 'both the flag and the day-1 note must render');
  assert.ok(Math.abs(flagY - noteY) >= 15,
    `partial flag (y=${flagY}) and day-1 note (y=${noteY}) are too close`);
});

test('a two-point series still plots; a one-point series does not', () => {
  assert.equal(indexChart({ values: [50], dates: ['2026-01-01'], partial: [false], labelEvery: 1 }), '',
    'one point is not a line');
  assert.notEqual(indexChart({ values: [50, 60], dates: ['a', 'b'], partial: [false, false], labelEvery: 1 }), '');
});

test('every card carries a break guard in the stylesheet', () => {
  for (const cls of ['.lr-card', '.lr-kpi', '.lr-inset', '.lr-tile', '.lr-answer']) {
    assert.ok(CSS.includes(cls), `${cls} has no rule at all`);
  }
  assert.match(CSS, /\.lr-card \{[^}]*break-inside: avoid/s, '.lr-card is missing its break guard');
  assert.match(CSS, /@media print \{[\s\S]*?\.lr-hero \{[^}]*position|@media print/, 'no print block');
});

test('the sticky header un-sticks under print', () => {
  assert.match(CSS, /@media print[\s\S]*?\.lr-hero \{[^}]*margin: 0/, 'the hero keeps its bleed margin in print');
});

console.log('\nloud — the record strip');

test('each dot states its own run, state and caveats in its title', () => {
  const html = recordDots([ST_NAMED, ST_BLANK, ST_ABSENT], RUN_META, CAPS);
  assert.match(html, /title="2026-01-01 · named"/);
  assert.match(html, /title="2026-02-01 · not measured · partial run"/, 'a partial run must say so');
  assert.match(html, /data-current="1"/, 'the current run is marked');
  assert.match(html, /aria-label="Run-by-run record"/);
});

test('a reworded run is marked on the dot, not silently included', () => {
  const html = recordDots([ST_NAMED, ST_NAMED, ST_NAMED], RUN_META, CAPS, { driftRuns: [1] });
  assert.match(html, /data-drift="1"/);
  assert.match(html, /question worded differently/);
});

test('beyond the window the hidden runs are counted, not dropped', () => {
  const states = new Array(20).fill(ST_NAMED);
  const meta = states.map((_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, index: i + 1, partial: false }));
  const html = recordDots(states, meta, { dotSize: 9, dotGap: 4, dotWindow: 16 });
  assert.match(html, /class="lr-dots-more">\+4</, 'the hidden count must be stated');
  assert.equal((html.match(/class="lr-dot"/g) || []).length, 16);
});

test('the four dot states are visually distinct in CSS, not colour-only', () => {
  for (const state of [ST_NAMED, ST_CITED, ST_BLANK]) {
    assert.ok(CSS.includes(`.lr-dot[data-state="${state}"]`), `no rule for dot state ${state}`);
  }
  // The default (absent) rule is the outlined base .lr-dot.
  assert.match(CSS, /\.lr-dot \{[^}]*box-shadow: inset/s, 'absent dots must be outlined, not just pale');
});

test('the run strip glyphs differ per state so a monochrome print still reads', () => {
  const html = runStrip([ST_NAMED, ST_ABSENT, ST_CITED], RUN_META);
  assert.match(html, />✓/);
  assert.match(html, />✕/);
  assert.match(html, />◆/);
  assert.match(html, /THIS RUN/, 'the current run is labelled in words');
});

console.log('\nloud — structure');

test('the where-to-act line is rendered even when it says nothing moved', () => {
  const html = whereToAct({ textHtml: 'No metric moved far enough to act on.', meta: 'floor 3.0 pt' });
  assert.match(html, /Where to act/);
  assert.match(html, /No metric moved far enough/);
});

test('an alert card carries a rail, a worded kicker and a tone', () => {
  const html = alertCard({ tone: 'bad', kicker: 'Quotable content', title: 'One of eleven sections', bodyHtml: 'body' });
  assert.match(html, /data-tone="bad"/);
  assert.match(html, /lr-alert-rail/);
  assert.match(html, />Quotable content</, 'the kicker states the finding in words');
});

test('a quiet card still states its result', () => {
  const html = quietCard({ label: 'Sponsored placements', title: 'None detected', body: '12 answers scanned.', badge: '0 of 12' });
  assert.match(html, />None detected</);
  assert.match(html, />0 of 12</);
});

test('axis bars are sized by weight and muted rows are marked', () => {
  const html = axisTable([
    { label: 'Presence', weight: 0.35, valueText: '92', fillPct: 87.5, muted: false, chipHtml: chip('▼ 8 pp', 'bad') },
    { label: 'Rank', weight: 0.2, valueText: '4 of 12', fillPct: 50, muted: true, chipHtml: chip('too few to score', 'quiet') },
  ]);
  assert.match(html, />35%</, 'the fixed weight must be printed');
  assert.match(html, /data-muted="1"/, 'a row without a delta must be visibly muted');
  assert.match(html, />4 of 12</, 'coverage prints in place of the value');
});

test('the one-page summary links every row to its section and never omits the mover line', () => {
  const html = onePage({
    title: '5 findings, one per section',
    meta: 'run of 2026-03-01',
    rows: [{ num: '01', label: 'Overview', href: '#overview', sentence: 'Down 8 points', chipHtml: chip('▼ 8', 'bad') }],
    moverHtml: 'Biggest mover: Presence.',
  });
  assert.match(html, /href="#overview"/);
  assert.match(html, /lr-op-mover/);
  assert.match(html, /Biggest mover/);
});

test('the verdict hero leads with a sentence, then the numbers', () => {
  const html = verdictHero({
    kicker: 'Run 3 · 2026-03-01',
    headlineHtml: 'Down 8 points. Gemini dropped an answer.',
    ledeHtml: 'Brand scored 92 of 100.',
    kpis: [kpiCard({ label: 'Visibility index', value: 92, denom: '/ 100', chipHtml: chip('▼ 8', 'bad') })],
  });
  const headlineAt = html.indexOf('lr-hero-title');
  const numberAt = html.indexOf('lr-kpi-num');
  assert.ok(headlineAt > -1 && numberAt > headlineAt, 'the conclusion must precede the figures');
});

test('section headers carry a number, a kicker and a verdict title', () => {
  const html = sectionHead({ num: '02', kicker: 'Visibility · per engine', title: '11 answers name you', meta: '3 × 4' });
  assert.match(html, />02</);
  assert.match(html, />11 answers name you</);
});

test('share rows mark the brand\'s own row explicitly', () => {
  const html = shareTable([
    { nameHtml: 'You', count: '11 / 12', fillPct: 100, share: '18%', chipHtml: '', note: 'n', you: true },
    { nameHtml: 'Rival', count: '3 / 12', fillPct: 50, share: '9%', chipHtml: '', note: 'n', colorKey: 'rival' },
  ]);
  assert.match(html, /data-you="1"/);
  assert.match(html, /data-color="rival"/);
});

test('engine dots are decorative only — an unknown provider still renders', () => {
  assert.match(engineDot('openai'), /data-engine="openai"/);
  assert.match(engineDot('something-else'), /data-engine="other"/);
  assert.match(engineDot('openai'), /aria-hidden="true"/, 'colour must not be the carrier of identity');
});

test('inset cards keep their label', () => {
  assert.match(insetCard({ label: 'What it cost', bodyHtml: 'x' }), />What it cost</);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
