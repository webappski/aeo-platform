/**
 * «This part of the report is thinner than usual, and here is why» — in one
 * place, in sentences, for every surface that renders it.
 *
 * WHY THIS FILE EXISTS
 * The report's LLM sections degrade quietly. When a classify-tier call fails,
 * the competitor cross-check silently becomes single-model (every name drops to
 * the `unverified` tier) and a cell's sentiment silently becomes `single-model`
 * or disappears. Both are correct behaviours — the alternative is inventing a
 * verdict — but until 2026-09-20 NOTHING on either surface said a degradation
 * had happened, so «only two competitors this week» read as a finding about the
 * market rather than a call that came back broken. Same class as every other
 * silence this report has had to close: the run knew, and told nobody.
 *
 * THE MISLABELLING RISK IS THE POINT (R39). A marker that says «the model
 * returned unparseable JSON» when the real cause was an expired key is worse
 * than no marker: it sends the reader to fix the wrong thing. So every reason
 * here is derived from the TYPED error recorded at the call site
 * (`errorKind: 'parse' | 'provider'`), never inferred from an empty result. A
 * record that carries no kind is reported as an unnamed failure rather than
 * guessed into one of the two.
 *
 * SENTENCES, NOT MARKUP — the doctrine `instrument-caveat.js` is written around.
 * `buildSectionDegradationCaveat` returns the words; markdown quotes them, HTML
 * puts them in an alert card. A caveat two surfaces word differently is a caveat
 * a reader can shop around.
 *
 * Pure functions, no I/O.
 */
import { providerLabel } from './instrument-caveat.js';

/** Sections this module can speak about, in the order a reader meets them. */
const SECTION_LABELS = Object.freeze({
  competitors: 'Competitor cross-check',
  sentiment: 'Sentiment cross-check',
});
const SECTION_ORDER = Object.freeze(['competitors', 'sentiment']);

/** Human cause, keyed by the TYPED error kind. Unknown kinds stay honest. */
const KIND_CAUSE = Object.freeze({
  parse: 'the model returned something that was not valid JSON',
  provider: 'the API call failed',
});
function causeOf(kind) {
  return KIND_CAUSE[kind] || 'the call did not return a usable answer';
}

/**
 * The degradation records for ONE cell, derived from what the two LLM sections
 * wrote into it. Returns [] for a clean cell — the common case, and the reason
 * the field is omitted rather than written empty.
 *
 * Shape per entry: `{ section, provider, model, kind, recovered }`.
 *   - `recovered: true` — the slot failed to parse and a re-ask succeeded. Worth
 *     recording even though nothing degraded: it is the evidence that the retry
 *     added by this release is doing something, and it is the only place the
 *     extra call is visible.
 *
 * @param {Object} cell  a run result record (or the live objects that build one)
 * @returns {Array<Object>}
 */
export function degradationsFor({ extractionSources, sentiment } = {}) {
  const out = [];
  const push = (section, seat) => {
    if (!seat) return;
    if (seat.error) {
      out.push({
        section,
        provider: seat.provider || null,
        model: seat.model || null,
        kind: seat.errorKind || null,
        recovered: false,
        ...(seat.retriedOn ? { retriedOn: seat.retriedOn } : {}),
      });
    } else if (seat.retriedOn) {
      out.push({
        section,
        provider: seat.provider || null,
        model: seat.model || null,
        kind: 'parse',
        recovered: true,
        retriedOn: seat.retriedOn,
      });
    }
  };
  push('competitors', extractionSources?.primary);
  push('competitors', extractionSources?.secondary);
  push('sentiment', sentiment?.slots?.primary);
  push('sentiment', sentiment?.slots?.secondary);
  return out;
}

/**
 * Roll the per-cell records up to one entry per (section, kind, recovered),
 * counting cells. A reader does not need nine identical lines; they need «three
 * answers, this section, this cause».
 *
 * @param {Array<Object>} results  `_summary.json` results
 * @returns {Array<{section, kind, recovered, cells, providers: string[], retriedOn: string[]}>}
 */
export function collectDegradations(results) {
  const byKey = new Map();
  for (const r of results || []) {
    for (const d of r?.degraded || []) {
      if (!SECTION_LABELS[d.section]) continue;
      const key = `${d.section}|${d.kind || 'unknown'}|${d.recovered ? 'r' : 'd'}`;
      const entry = byKey.get(key) || {
        section: d.section,
        kind: d.kind || null,
        recovered: !!d.recovered,
        cells: 0,
        providers: new Set(),
        retriedOn: new Set(),
      };
      entry.cells++;
      if (d.provider) entry.providers.add(d.provider);
      if (d.retriedOn) entry.retriedOn.add(d.retriedOn);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .map((e) => ({ ...e, providers: [...e.providers].sort(), retriedOn: [...e.retriedOn].sort() }))
    .sort((a, b) => {
      // Degradations before recoveries — a reader acts on the first and only
      // notes the second.
      if (a.recovered !== b.recovered) return a.recovered ? 1 : -1;
      const s = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
      return s !== 0 ? s : b.cells - a.cells;
    });
}

/**
 * The caveat, in the words both surfaces print.
 *
 * @param {Array<Object>} results  `_summary.json` results
 * @returns {{title: string, sentences: string[]}|null}  null on a clean run —
 *          silence is correct when nothing degraded, and an "all good" line
 *          would be one more thing to read on every report.
 */
export function buildSectionDegradationCaveat(results) {
  const entries = collectDegradations(results);
  if (entries.length === 0) return null;

  const degraded = entries.filter((e) => !e.recovered);
  const recovered = entries.filter((e) => e.recovered);

  const sentences = [];
  for (const e of degraded) {
    const who = e.providers.length > 0
      ? e.providers.map(providerLabel).join(' and ')
      : 'one of the two models';
    const n = `${e.cells} answer${e.cells === 1 ? '' : 's'}`;
    sentences.push(
      `${SECTION_LABELS[e.section]}: ${n} could not be cross-checked because ${who} — ${causeOf(e.kind)}.`,
    );
  }
  if (degraded.length > 0) {
    // What the reader must NOT conclude. Both sections fail the same way: the
    // surviving model's output is kept, and it loses its second opinion.
    sentences.push(
      'Those answers are reported from the one model that did respond, so they are weaker evidence than the rest — not a finding that the market changed.',
    );
  }
  for (const e of recovered) {
    const n = `${e.cells} answer${e.cells === 1 ? '' : 's'}`;
    const where = e.retriedOn.includes('same-model') && e.retriedOn.length === 1
      ? 'the same model on a second ask'
      : `${e.retriedOn.filter((x) => x !== 'same-model').map(providerLabel).join(' and ')} on a second ask`;
    sentences.push(
      `${SECTION_LABELS[e.section]}: ${n} came back unreadable the first time and were recovered by ${where} — no loss, listed so the extra call is visible.`,
    );
  }

  const totalDegraded = degraded.reduce((s, e) => s + e.cells, 0);
  const title = totalDegraded > 0
    ? `${totalDegraded} answer${totalDegraded === 1 ? '' : 's'} were classified by one model instead of two`
    : 'A classification was re-asked before it could be read';

  return { title, sentences };
}
