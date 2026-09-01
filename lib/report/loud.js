// Loud-register render components.
//
// Every function here returns a fragment of class-based HTML for the report
// shell. Nothing in this file decides WHAT is true — the callers pass in
// already-computed models from trend-model.js, answer-history.js and
// run-comparison.js. This file only decides how a conclusion looks.
//
// Two rules the whole file obeys:
//   * Status is worded as well as coloured. A pill always carries text; colour
//     is never the only carrier of meaning (WCAG 1.4.1).
//   * No inline font-size, no raw hex. Type and colour live in styles.css
//     behind `lr-*` classes and `data-tone` variants, which is what the
//     design-lint test enforces on this file's callers.

import { esc } from '../svg/index.js';
import { ST_NAMED, ST_CITED, ST_ABSENT, ST_BLANK } from './answer-history.js';

/** Provider key -> the engine-colour slot used by `data-engine` in CSS. */
const ENGINE_KEYS = new Set(['openai', 'gemini', 'anthropic', 'perplexity']);

/**
 * A coloured delta chip. Always carries its own text.
 * @param {string} text
 * @param {'good'|'bad'|'quiet'|'flat'} tone
 * @param {{size?: 'sm'|'md'|'lg', title?: string}} [opts]
 * @returns {string}
 */
export function chip(text, tone = 'quiet', opts = {}) {
  const size = opts.size ? ` data-size="${esc(opts.size)}"` : '';
  const title = opts.title ? ` title="${esc(opts.title)}"` : '';
  return `<span class="lr-chip" data-tone="${esc(tone)}"${size}${title}>${esc(text)}</span>`;
}

/**
 * A worded status pill — the "Names you" / "Allowed" / "Unreachable" family.
 * @param {string} text
 * @param {'good'|'bad'|'warn'|'quiet'} tone
 * @returns {string}
 */
export function pill(text, tone = 'quiet') {
  return `<span class="lr-pill" data-tone="${esc(tone)}">${esc(text)}</span>`;
}

/**
 * Uppercase micro-label. The only role `--text-tertiary` is allowed to fill,
 * because it does not carry enough contrast for a number or a sentence.
 * @param {string} text
 * @param {string} [tone]
 * @returns {string}
 */
export function eyebrow(text, tone = '') {
  return `<span class="lr-eyebrow"${tone ? ` data-tone="${esc(tone)}"` : ''}>${esc(text)}</span>`;
}

/**
 * One headline KPI: label, big number, optional denominator, optional chip and
 * a supporting note.
 * @param {{label: string, value: string|number, denom?: string|null,
 *          chipHtml?: string, note?: string, noteHtml?: string}} spec
 * @returns {string}
 */
export function kpiCard(spec) {
  const denom = spec.denom ? `<span class="lr-kpi-denom">${esc(spec.denom)}</span>` : '';
  const note = spec.noteHtml
    ? `<p class="lr-kpi-note">${spec.noteHtml}</p>`
    : spec.note ? `<p class="lr-kpi-note">${esc(spec.note)}</p>` : '';
  return `<div class="lr-kpi">
    ${eyebrow(spec.label)}
    <div class="lr-kpi-row">
      <span class="lr-kpi-num">${esc(String(spec.value))}</span>
      ${denom}
      ${spec.chipHtml || ''}
    </div>
    ${note}
  </div>`;
}

/**
 * The verdict hero: what happened, in a sentence, before any number.
 * @param {{kicker: string, headlineHtml: string, ledeHtml: string, kpis: Array<string>}} spec
 * @returns {string}
 */
export function verdictHero(spec) {
  return `<section class="lr-hero" aria-label="Headline verdict">
    <div class="lr-hero-inner">
      <span class="lr-hero-kicker">${esc(spec.kicker)}</span>
      <h1 class="lr-hero-title">${spec.headlineHtml}</h1>
      <p class="lr-hero-lede">${spec.ledeHtml}</p>
      ${spec.kpis.length ? `<div class="lr-hero-kpis" data-count="${spec.kpis.length}">${spec.kpis.join('')}</div>` : ''}
    </div>
  </section>`;
}

/**
 * The one-page summary: one conclusion per section, each linking to its own
 * section, closing on the run's biggest mover.
 * @param {{meta: string, rows: Array<{num: string, label: string, href: string,
 *          sentence: string, chipHtml: string}>, moverHtml: string, title: string}} spec
 * @returns {string}
 */
export function onePage(spec) {
  const rows = spec.rows.map((r) => `<a class="lr-op-row" href="${esc(r.href)}">
      <span class="lr-op-id"><b class="lr-op-num">${esc(r.num)}</b><span class="lr-op-label">${esc(r.label)}</span></span>
      <span class="lr-op-sentence">${esc(r.sentence)}</span>
      <span class="lr-op-chip">${r.chipHtml}</span>
    </a>`).join('');
  return `<section class="lr-card lr-onepage" id="summary">
    <div class="lr-card-head">
      <span class="lr-head-titles">
        ${eyebrow('The run in one page')}
        <h2 class="lr-h2">${esc(spec.title)}</h2>
      </span>
      <span class="lr-head-meta">${esc(spec.meta)}</span>
    </div>
    <div class="lr-op-rows">${rows}</div>
    <p class="lr-op-mover">${spec.moverHtml}</p>
  </section>`;
}

/**
 * Numbered section header — the big orange numeral, kicker, verdict title.
 * @param {{num: string, kicker: string, title: string, meta?: string, tone?: string}} spec
 * @returns {string}
 */
export function sectionHead(spec) {
  return `<header class="lr-sec-head"${spec.tone ? ` data-tone="${esc(spec.tone)}"` : ''}>
    <span class="lr-sec-num">${esc(spec.num)}</span>
    <span class="lr-head-titles">
      ${eyebrow(spec.kicker)}
      <h2 class="lr-h2 lr-sec-title">${esc(spec.title)}</h2>
    </span>
    ${spec.meta ? `<span class="lr-head-meta">${esc(spec.meta)}</span>` : ''}
  </header>`;
}

/**
 * An alert card — the treatment a check earns only by tripping.
 *
 * Callers must decide loudness from the data, never from which section they
 * are in: the same generator on a clean run should render the same check quiet.
 *
 * @param {{tone: 'bad'|'warn'|'good', kicker: string, title: string,
 *          bodyHtml: string, extraHtml?: string, footHtml?: string}} spec
 * @returns {string}
 */
export function alertCard(spec) {
  return `<div class="lr-card lr-alert" data-tone="${esc(spec.tone)}">
    <span class="lr-alert-rail" aria-hidden="true"></span>
    <div class="lr-alert-body">
      <span class="lr-alert-kicker" data-tone="${esc(spec.tone)}">${esc(spec.kicker)}</span>
      <h3 class="lr-h3-lg">${esc(spec.title)}</h3>
      <p class="lr-lede">${spec.bodyHtml}</p>
      ${spec.extraHtml || ''}
      ${spec.footHtml ? `<p class="lr-note">${spec.footHtml}</p>` : ''}
    </div>
  </div>`;
}

/**
 * A check that ran and found nothing worth shouting about. Rendered because the
 * check ran; coloured only on the badge, which states its own result in words.
 * @param {{label: string, title: string, body: string, badge?: string,
 *          badgeTone?: string}} spec
 * @returns {string}
 */
export function quietCard(spec) {
  return `<div class="lr-card lr-quiet">
    ${eyebrow(spec.label)}
    <h3 class="lr-h3">${esc(spec.title)}</h3>
    <p class="lr-body">${esc(spec.body)}</p>
    ${spec.badge ? pill(spec.badge, spec.badgeTone || 'quiet') : ''}
  </div>`;
}

/**
 * A collapsed disclosure around a long block — the depth layer of a section,
 * shut on screen so it does not unroll into a wall of type under a reader who
 * only wanted the verdict.
 *
 * Collapsing is safe ONLY because the page's inline print handler opens every
 * `.fold` on `beforeprint` and restores the screen state on `afterprint`: a
 * closed <details> cannot be forced open by CSS, so without that handler this
 * would silently delete both blocks from the client's PDF. If you narrow that
 * selector, you delete them. (report-visibility-order.test.js pins it.)
 *
 * The label is a show/hide SPAN PAIR, not CSS `content` on the summary —
 * generated content on a <summary> is unreliable across engines. The count
 * lives here and nowhere else: it is what tells a reader whether the click is
 * worth it.
 *
 * `tag` leads the row and marks the block as the proof layer rather than the
 * report's spine. The same word in the same position on every fold is what
 * makes them read as one category of thing at a glance. It says EVIDENCE, not
 * "advanced": a badge telling a paying reader that a section is above their
 * level is a badge telling them not to read what they bought. `meta` states
 * the JOB the block does — that sentence, not the tag, is what a reader
 * actually decides on.
 *
 * @param {{show: string, hide: string, tag?: string, meta?: string,
 *          bodyHtml: string}} spec
 * @returns {string}
 */
export function fold(spec) {
  return `<details class="fold">
    <summary class="fold-sum">
      ${spec.tag ? `<span class="fold-tag">${esc(spec.tag)}</span>` : ''}
      <span class="fold-caret" aria-hidden="true"></span>
      <span class="fold-show">${esc(spec.show)}</span>
      <span class="fold-hide">${esc(spec.hide)}</span>
      ${spec.meta ? `<span class="fold-meta">${esc(spec.meta)}</span>` : ''}
    </summary>
    <div class="fold-body">${spec.bodyHtml}</div>
  </details>`;
}

/**
 * A named thing with a worded status — AI crawlers, identity links.
 * @param {{name: string, status: string, tone: string}} spec
 * @returns {string}
 */
export function statusTile(spec) {
  return `<div class="lr-tile">
    <span class="lr-tile-name">${esc(spec.name)}</span>
    ${pill(spec.status, spec.tone)}
  </div>`;
}

/**
 * The per-section "Where to act" line. Never omitted: when nothing cleared the
 * significance bar the sentence says so, because a missing callout reads as
 * "no finding" rather than "no finding large enough".
 * @param {{textHtml: string, meta?: string}} spec
 * @returns {string}
 */
export function whereToAct(spec) {
  return `<div class="lr-act">
    <span class="lr-act-label">Where to act</span>
    <span class="lr-act-text">${spec.textHtml}</span>
    ${spec.meta ? `<span class="lr-act-meta">${esc(spec.meta)}</span>` : ''}
  </div>`;
}

/**
 * The run-by-run dot strip for one answer.
 *
 * Four states, each with a distinct shape as well as a colour, and a title so
 * the record is readable to a screen reader and on a monochrome print:
 *   named  - filled
 *   cited  - filled, darker (a source, not a recommendation)
 *   absent - outlined
 *   blank  - flat grey (not measured, or the question was not asked)
 *
 * @param {Array<string>} states Ordered oldest -> newest.
 * @param {Array<{date: string, index: number, partial: boolean}>} runMeta
 * @param {{dotSize: number, dotGap: number, dotWindow: number|null}} caps
 * @param {{driftRuns?: Array<number>}} [opts]
 * @returns {string}
 */
export function recordDots(states, runMeta, caps, opts = {}) {
  const all = states || [];
  const drift = new Set(opts.driftRuns || []);
  const window = caps && caps.dotWindow ? caps.dotWindow : null;
  const hidden = window && all.length > window ? all.length - window : 0;
  const shown = hidden ? all.slice(hidden) : all;
  const prefix = hidden ? `<span class="lr-dots-more">+${hidden}</span>` : '';
  const dots = shown.map((state, i) => {
    const runIdx = hidden + i;
    const meta = runMeta[runIdx] || {};
    const isLast = runIdx === all.length - 1;
    const drifted = drift.has(meta.index);
    const label = [
      meta.date || `run ${runIdx + 1}`,
      state === ST_NAMED ? 'named' : state === ST_CITED ? 'cited as a source' : state === ST_ABSENT ? 'not named' : 'not measured',
      meta.partial ? 'partial run' : '',
      drifted ? 'question worded differently' : '',
    ].filter(Boolean).join(' · ');
    return `<i class="lr-dot" data-state="${esc(state)}"${isLast ? ' data-current="1"' : ''}${drifted ? ' data-drift="1"' : ''} title="${esc(label)}"></i>`;
  }).join('');
  return `<span class="lr-dots" data-size="${caps?.dotSize === 9 ? 'sm' : 'md'}" role="img" aria-label="Run-by-run record">${prefix}${dots}</span>`;
}

/**
 * The large run-by-run strip used once, for the answer that explains the run.
 * @param {Array<string>} states
 * @param {Array<{date: string, index: number, partial: boolean}>} runMeta
 * @returns {string}
 */
export function runStrip(states, runMeta) {
  const blocks = (states || []).map((state, i) => {
    const meta = runMeta[i] || {};
    const isLast = i === states.length - 1;
    const glyph = state === ST_NAMED ? '✓' : state === ST_CITED ? '◆' : state === ST_ABSENT ? '✕' : '–';
    return `<span class="lr-strip-col"${isLast ? ' data-current="1"' : ''}>
      <b class="lr-strip-idx">${String(meta.index ?? i + 1).padStart(2, '0')}</b>
      <i class="lr-strip-block" data-state="${esc(state)}">${glyph}${isLast ? '<span class="lr-strip-now">THIS RUN</span>' : ''}</i>
      <span class="lr-strip-date">${esc((meta.date || '').slice(5))}</span>
    </span>`;
  }).join('');
  return `<div class="lr-strip">${blocks}</div>`;
}

/**
 * One shared "partial" callout per contiguous run of partial points, drawn
 * above the plot where nothing else lives by default — a flag repeated over
 * every point (the previous design) crowded the chart and collided with the
 * baseline labels, which scale with the score.
 * @param {Array<number|null>} values
 * @param {Array<boolean>} partial
 * @param {(i: number) => number} x
 * @param {number} top
 * @returns {string}
 */
function partialCallouts(values, partial, x, top) {
  const ranges = [];
  values.forEach((v, i) => {
    if (!partial[i] || !Number.isFinite(v)) return;
    const prev = ranges[ranges.length - 1];
    if (prev && prev.end === i - 1) prev.end = i;
    else ranges.push({ start: i, end: i });
  });
  const flagY = top - 12;
  return ranges.map(({ start, end }) => {
    const x0 = round(x(start));
    const x1 = round(x(end));
    const span = start === end ? '' : `<line class="lr-chart-partial-span" x1="${x0}" y1="${flagY}" x2="${x1}" y2="${flagY}"></line>`;
    return `${span}<text class="lr-chart-flag" x="${round((x0 + x1) / 2)}" y="${round(flagY - 4)}" text-anchor="middle">partial</text>`;
  }).join('');
}

/**
 * Which side of a point has open space for its label: below when the point
 * sits in the plot's upper half (clear of the partial callout drawn near the
 * top), above when it sits in the lower half (clear of the fixed-y date axis
 * at the bottom). A label anchored a fixed distance in one direction only
 * collides with whichever of those two rows the point happens to be scoring
 * near — this is what keeps it clear regardless of score.
 * @param {number} pointY
 * @param {number} top
 * @param {number} base
 * @param {number} aboveOffset
 * @param {number} belowOffset
 * @returns {number}
 */
function openSideY(pointY, top, base, aboveOffset, belowOffset) {
  return round(pointY < (top + base) / 2 ? pointY + belowOffset : pointY - aboveOffset);
}

/** The date row under the plot, thinned to one label every `every`-th run (endpoints always shown). */
function dateAxisLabels(dates, x, n, every) {
  return dates.map((d, i) => {
    if (i !== 0 && i !== n - 1 && i % every !== 0) return '';
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `<text class="lr-chart-axis" x="${round(x(i))}" y="224" text-anchor="${anchor}">${esc(String(d).slice(5))}</text>`;
  }).join('');
}

/**
 * The dated index chart. Inline SVG with explicit strokes and no
 * `preserveAspectRatio="none"` — that attribute stretches the label glyphs
 * along with the plot when the container is not 1000x240.
 *
 * @param {{values: Array<number|null>, dates: Array<string>,
 *          partial: Array<boolean>, labelEvery: number}} spec
 * @returns {string}
 */
export function indexChart(spec) {
  const values = spec.values || [];
  const dates = spec.dates || [];
  const partial = spec.partial || [];
  const n = values.length;
  if (n < 2) return '';
  const W = 1000, H = 240, LEFT = 60, RIGHT = 960, BASE = 200, TOP = 30;
  const x = (i) => n === 1 ? LEFT : LEFT + (i * (RIGHT - LEFT)) / (n - 1);
  const y = (v) => BASE - (Math.max(0, Math.min(100, v)) / 100) * (BASE - TOP);
  const pts = values.map((v, i) => (Number.isFinite(v) ? `${round(x(i))},${round(y(v))}` : null)).filter(Boolean);
  if (pts.length < 2) return '';
  const first = values.find((v) => Number.isFinite(v));
  const last = values[n - 1];
  const lastX = round(x(n - 1));
  const lastY = round(y(last));
  const baseY = round(y(first));
  const lastLabelY = openSideY(lastY, TOP, BASE, 12, 20);
  const noteY = openSideY(baseY, TOP, BASE, 6, 14);

  const markers = values.map((v, i) => {
    if (!Number.isFinite(v)) return '';
    const cx = round(x(i));
    const cy = round(y(v));
    if (partial[i]) {
      // Per-point flag replaced by the shared partialCallouts() below; the
      // <title> keeps this point's own hover detail.
      return `<circle class="lr-chart-partial" cx="${cx}" cy="${cy}" r="6"><title>${esc(String(dates[i] || ''))} · partial run</title></circle>`;
    }
    if (i === 0) return `<circle class="lr-chart-first" cx="${cx}" cy="${cy}" r="6"></circle>`;
    if (i === n - 1) return '';
    return `<circle class="lr-chart-point" cx="${cx}" cy="${cy}" r="4"></circle>`;
  }).join('');

  const labels = dateAxisLabels(dates, x, n, Math.max(1, spec.labelEvery || 1));
  const label = `Visibility index by run: ${values.map((v, i) => (Number.isFinite(v) ? `${v}${partial[i] ? ' (partial run)' : ''}` : 'not measured')).join(', ')}`;
  return `<svg class="lr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    <line class="lr-chart-base" x1="${LEFT - 20}" y1="${BASE}" x2="${RIGHT + 30}" y2="${BASE}"></line>
    <line class="lr-chart-rule" x1="${LEFT - 20}" y1="${baseY}" x2="${RIGHT + 30}" y2="${baseY}"></line>
    <text class="lr-chart-note" x="${LEFT - 16}" y="${noteY}">day 1 · ${esc(String(first))}</text>
    <polygon class="lr-chart-fill" points="${pts.join(' ')} ${lastX},${BASE} ${round(x(0))},${BASE}"></polygon>
    <polyline class="lr-chart-line" points="${pts.join(' ')}"></polyline>
    ${markers}
    ${partialCallouts(values, partial, x, TOP)}
    <circle class="lr-chart-last" cx="${lastX}" cy="${lastY}" r="7"></circle>
    <text class="lr-chart-last-label" x="${round(lastX - 2)}" y="${lastLabelY}" text-anchor="end">${esc(String(last))}</text>
    ${labels}
  </svg>`;
}

/**
 * The four weighted axes. Bar widths are the FIXED weights, never the deltas —
 * a bar sized by movement would imply the axes are equally important.
 *
 * @param {Array<{label: string, weight: number, value: number|null, valueText: string,
 *                fillPct: number, muted: boolean, chipHtml: string}>} rows
 * @returns {string}
 */
export function axisTable(rows) {
  return `<div class="lr-rows lr-axes">${(rows || []).map((r) => `
    <div class="lr-axis-row">
      <span class="lr-axis-label">${esc(r.label)}</span>
      <span class="lr-axis-weight">${Math.round(r.weight * 100)}%</span>
      <span class="lr-bar"><i class="lr-bar-fill"${r.muted ? ' data-muted="1"' : ''} style="width:${clampPct(r.fillPct)}%"></i></span>
      <span class="lr-axis-value"${r.muted ? ' data-muted="1"' : ''}>${esc(r.valueText)}</span>
      <span class="lr-axis-chip">${r.chipHtml}</span>
    </div>`).join('')}</div>`;
}

/**
 * A share table row: name, count, proportional bar, share, chip, note.
 * @param {Array<{nameHtml: string, count: string, fillPct: number, share: string,
 *                chipHtml: string, note: string, you?: boolean, colorKey?: string}>} rows
 * @returns {string}
 */
export function shareTable(rows) {
  return `<div class="lr-rows">${(rows || []).map((r) => `
    <div class="lr-share-row"${r.you ? ' data-you="1"' : ''}>
      <span class="lr-share-name">${r.nameHtml}</span>
      <span class="lr-share-count">${esc(r.count)}</span>
      <span class="lr-share-track">
        <span class="lr-bar"><i class="lr-bar-fill"${r.colorKey ? ` data-color="${esc(r.colorKey)}"` : ''} style="width:${clampPct(r.fillPct)}%"></i></span>
        <span class="lr-share-pct">${esc(r.share)}</span>
      </span>
      <span class="lr-share-chip">${r.chipHtml}</span>
      <span class="lr-share-note">${esc(r.note)}</span>
    </div>`).join('')}</div>`;
}

/**
 * One question card: the question, the per-engine verdict rows, each row's two
 * deltas and its whole record.
 *
 * Rows are emitted `open`. Save-as-PDF prints the screen DOM, and CSS cannot
 * force a closed `<details>` open for print — so a collapsed row is a row that
 * does not exist in the client's PDF.
 *
 * @param {{group: Object, caps: Object, runMeta: Array<Object>}} spec
 * @returns {string}
 */
export function answerCard(spec) {
  const { group, caps, runMeta } = spec;
  const moved = group.lost + group.gained;
  const headTone = group.lost > 0 ? ' data-tone="bad"' : '';
  const tally = `Question ${String(group.query).replace(/^Q/, '')} · ${group.named} of ${group.total} engines name you`
    + (group.lost > 0 ? ` · down ${group.lost}` : group.gained > 0 ? ` · up ${group.gained}` : '');
  const rows = group.cells.map((cell, i) => answerRow(cell, runMeta, caps, i === group.cells.length - 1)).join('');
  return `<div class="lr-card lr-answers"${moved ? ' data-moved="1"' : ''}>
    <div class="lr-answers-head">
      <span class="lr-eyebrow"${headTone}>${esc(tally)}</span>
      <p class="lr-question">${esc(group.queryText || group.query)}</p>
    </div>
    ${rows}
  </div>`;
}

/**
 * @param {Object} cell
 * @param {Array<Object>} runMeta
 * @param {Object} caps
 * @param {boolean} isLast
 * @returns {string}
 */
function answerRow(cell, runMeta, caps, isLast) {
  const v = cell.verdict;
  const verdictPill = v === 'lost' ? pill('Does not name you', 'bad')
    : v === 'gained' ? pill('Now names you', 'good')
    : v === 'slipped' ? pill('Cited, not named', 'warn')
    : v === 'never' ? pill('Does not name you', 'quiet')
    : cell.state === ST_CITED ? pill('Cited as a source', 'warn')
    : cell.state === ST_ABSENT ? pill('Does not name you', 'quiet')
    : cell.rank === 1 ? pill('Names you first', 'warn')
    : cell.rank === 2 ? pill('Names you second', 'warn')
    : cell.rank != null ? pill(`Names you ${ordinal(cell.rank)}`, 'warn')
    : pill('Names you', 'warn');
  const rankText = cell.state === ST_ABSENT ? 'not in the answer'
    : cell.rank != null ? `rank #${cell.rank}`
    : 'no rank given';
  // The record sentence already opens with its own verdict when the cell
  // changed hands ("Lost this run — had appeared on the 7 runs before").
  // Prefixing a coloured verdict in front of it would print the words twice,
  // so the colour is applied to the sentence's own opening clause instead.
  const recordLead = (() => {
    const text = String(cell.record || '');
    const m = /^(Lost this run|Gained)\b/.exec(text);
    if (v === 'lost' && m) {
      return `<b class="lr-verdict-bad">${esc(m[1])}</b>${esc(text.slice(m[1].length))}`;
    }
    if (v === 'gained') {
      return `<b class="lr-verdict-good">Gained</b> — ${esc(lowerFirst(text))}`;
    }
    return esc(text);
  })();
  const drift = cell.textDrift
    ? `<p class="lr-note">This question was reworded; the record before ${esc(cell.textDrift.settledAt || 'the change')} measured a different wording of the same slot.</p>`
    : '';
  const competitors = cell.competitors && cell.competitors.length
    ? `<p class="lr-note">Named instead: ${esc(cell.competitors.join(', '))}.</p>`
    : '';
  return `<details class="lr-answer" open${isLast ? '' : ' data-divider="1"'}>
    <summary class="lr-answer-sum">
      <span class="lr-eng">${engineDot(cell.provider)}${esc(stripParen(cell.label))}</span>
      ${verdictPill}
      <span class="lr-answer-rank"${cell.rank != null ? ' data-strong="1"' : ''}>${esc(rankText)}</span>
      <span class="lr-answer-record">${recordLead}</span>
    </summary>
    <div class="lr-answer-detail">
      <div><h4 class="lr-eyebrow">vs previous run</h4><p class="lr-body">${esc(vsPrevSentence(cell))}</p></div>
      <div><h4 class="lr-eyebrow">vs first run</h4><p class="lr-body">${esc(vsFirstSentence(cell, runMeta))}</p></div>
      <div><h4 class="lr-eyebrow">Record</h4>
        ${caps && caps.shapes
          ? recordDots(cell.states, runMeta, caps, { driftRuns: cell.textDrift?.runs })
          : ''}
        <p class="lr-body">${esc(cell.record)}</p>
        ${competitors}
        ${drift}
      </div>
    </div>
  </details>`;
}

/**
 * @param {Object} cell
 * @returns {string}
 */
function vsPrevSentence(cell) {
  const states = cell.states || [];
  let before = null;
  for (let i = states.length - 2; i >= 0; i--) {
    if (states[i] !== ST_BLANK) { before = states[i]; break; }
  }
  if (before === null) return 'No earlier measurement of this answer to compare against.';
  const now = cell.state;
  if (before === now) {
    if (now === ST_NAMED && cell.rank != null) return 'Named on both runs, and this run states a position.';
    return now === ST_NAMED ? 'No change — named on both runs.'
      : now === ST_CITED ? 'No change — cited as a source on both runs.'
      : 'No change — absent on both runs.';
  }
  if (now === ST_NAMED && before === ST_CITED) return 'Cited but not named last run; named this run. A citation converted into a recommendation.';
  if (now === ST_NAMED) return 'Absent last run, named this run.';
  if (now === ST_CITED && before === ST_NAMED) return 'Named last run, cited only as a source this run.';
  if (now === ST_CITED) return 'Absent last run, cited as a source this run.';
  return before === ST_NAMED ? 'Named last run, absent this run.' : 'Cited last run, absent this run.';
}

/**
 * @param {Object} cell
 * @param {Array<Object>} runMeta
 * @returns {string}
 */
function vsFirstSentence(cell, runMeta) {
  const states = cell.states || [];
  const firstIdx = states.findIndex((s) => s !== ST_BLANK);
  if (firstIdx === -1) return 'Never measured before this run.';
  if (firstIdx === states.length - 1) return 'This is the first run that measured this answer.';
  const firstDate = runMeta[firstIdx]?.date || 'the first run';
  const leadingAbsent = (() => {
    let count = 0;
    for (const s of states) {
      if (s === ST_BLANK) continue;
      if (s === ST_ABSENT) count++;
      else break;
    }
    return count;
  })();
  if (leadingAbsent === 0) return `Present on ${firstDate} too — one of your oldest answers.`;
  return `Absent on the first ${leadingAbsent === 1 ? 'measured run' : `${leadingAbsent} measured runs`}, starting ${firstDate}.`;
}

/**
 * Engine identity dot. Colour is decorative here — the engine name always sits
 * next to it in text.
 * @param {string} provider
 * @returns {string}
 */
export function engineDot(provider) {
  const key = ENGINE_KEYS.has(provider) ? provider : 'other';
  return `<i class="lr-eng-dot" data-engine="${esc(key)}" aria-hidden="true"></i>`;
}

/**
 * A card built out of the page's inset surface — used for the paired
 * "what it cost / what to ship" blocks.
 * @param {{label: string, bodyHtml: string}} spec
 * @returns {string}
 */
export function insetCard(spec) {
  return `<div class="lr-inset">${eyebrow(spec.label)}<p class="lr-body-lg">${spec.bodyHtml}</p></div>`;
}

/** @param {number} n @returns {number} */
function round(n) { return Math.round(n * 10) / 10; }

/** @param {number} n @returns {number} */
function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/** @param {number} n @returns {string} */
function ordinal(n) {
  const names = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth' };
  return names[n] || `#${n}`;
}

/** @param {string} s @returns {string} */
function lowerFirst(s) {
  const t = String(s || '');
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** @param {string} s @returns {string} */
function stripParen(s) {
  return String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}
