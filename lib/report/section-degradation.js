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
 * WHITE-LABEL SAYS THE SAME THING WITHOUT SAYING HOW THE TOOL IS BUILT. Until
 * 2026-09-21 this caveat rendered identically in every mode, so a white-label
 * deliverable — whose whole premise is a self-made local stats tool — told the
 * client that two grading models cross-check every cell and that one of them
 * returned unparseable JSON. Naming the vendor was already ruled out below; the
 * ARCHITECTURE was not, and it is the same leak one level up.
 *
 * Dropping the caveat under white-label would have been worse than the leak: it
 * trades a tell for hiding that some answers are weaker evidence. So the caveat
 * stays and only the machinery goes — one builder, one set of words per mode,
 * never two copies for the two surfaces to drift apart.
 *
 * THE GRADING MODEL IS NEVER NAMED IN THE SENTENCE, and that is deliberate.
 * The vendors that grade our cells (`openai` / `gemini` / `anthropic`) are the
 * same names that appear all over this page as ANSWER ENGINES. «Gemini returned
 * unparseable JSON» in a note about the competitor list reads as «your Gemini
 * measurement is broken» — a second wrong conclusion in the copy written to
 * prevent the first one. It is also extractor plumbing, and the report has a
 * `--white-label` mode whose whole premise is that no tool-internal detail
 * renders. The vendor IS recorded, in `degraded[].provider` in the summary,
 * where whoever debugs the run will look; the sentence a reader acts on says
 * how many answers and why, which is the actionable half.
 *
 * SENTENCES, NOT MARKUP — the doctrine `instrument-caveat.js` is written around.
 * `buildSectionDegradationCaveat` returns the words; markdown quotes them, HTML
 * puts them in an alert card. A caveat two surfaces word differently is a caveat
 * a reader can shop around.
 *
 * Pure functions, no I/O.
 */
/** Sections this module can speak about, in the order a reader meets them. */
const SECTION_LABELS = Object.freeze({
  competitors: 'Competitor cross-check',
  sentiment: 'Sentiment cross-check',
});
const SECTION_ORDER = Object.freeze(['competitors', 'sentiment']);

/**
 * Human cause, keyed by the TYPED error kind, phrased to follow «one of the two
 * grading models …». Unknown kinds stay honest rather than borrowing whichever
 * sentence is nearby.
 */
const KIND_CAUSE = Object.freeze({
  parse: 'returned something that was not valid JSON',
  provider: 'could not be reached',
});
function causeOf(kind) {
  return KIND_CAUSE[kind] || 'did not return a usable answer';
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
 * @param {Object}  [opts]
 * @param {boolean} [opts.whiteLabel]  same facts, no instrument architecture:
 *        the reader still learns which answers are weaker evidence, without
 *        learning that a two-model cross-check produced them.
 * @returns {{title: string, sentences: string[]}|null}  null on a clean run —
 *          silence is correct when nothing degraded, and an "all good" line
 *          would be one more thing to read on every report.
 */
export function buildSectionDegradationCaveat(results, { whiteLabel = false } = {}) {
  const entries = collectDegradations(results);
  if (entries.length === 0) return null;

  const degraded = entries.filter((e) => !e.recovered);
  const recovered = entries.filter((e) => e.recovered);

  const sentences = [];
  for (const e of degraded) {
    const n = `${e.cells} answer${e.cells === 1 ? '' : 's'}`;
    sentences.push(whiteLabel
      ? `${SECTION_LABELS[e.section]}: ${n} could not be classified at full confidence.`
      : `${SECTION_LABELS[e.section]}: ${n} could not be cross-checked — one of the two grading models ${causeOf(e.kind)}.`);
  }
  if (degraded.length > 0) {
    // What the reader must NOT conclude. Both sections fail the same way: the
    // surviving model's output is kept, and it loses its second opinion.
    sentences.push(whiteLabel
      ? 'Those answers are reported at reduced confidence, so they are weaker evidence than the rest — not a finding that the market changed.'
      : 'Those answers are reported from the one model that did respond, so they are weaker evidence than the rest — not a finding that the market changed.');
  }
  for (const e of recovered) {
    const n = `${e.cells} answer${e.cells === 1 ? '' : 's'}`;
    const where = e.retriedOn.some((x) => x !== 'same-model')
      ? 'a second ask to a different grading model'
      : 'a second ask';
    const was = e.cells === 1 ? 'was' : 'were';
    sentences.push(whiteLabel
      ? `${SECTION_LABELS[e.section]}: ${n} came back unreadable the first time and ${was} recovered on a repeat — nothing was lost.`
      : `${SECTION_LABELS[e.section]}: ${n} came back unreadable the first time and ${was} recovered by ${where} — nothing was lost, listed so the extra call is visible.`);
  }

  const totalDegraded = degraded.reduce((s, e) => s + e.cells, 0);
  const plural = totalDegraded === 1 ? '' : 's';
  const title = totalDegraded > 0
    ? (whiteLabel
        ? `${totalDegraded} answer${plural} ${totalDegraded === 1 ? 'was' : 'were'} classified at reduced confidence`
        : `${totalDegraded} answer${plural} were classified by one model instead of two`)
    : (whiteLabel
        ? 'A classification had to be repeated before it could be read'
        : 'A classification was re-asked before it could be read');

  return { title, sentences };
}
