// The instrument axis, in the words a client reads.
//
// WHY THIS FILE EXISTS
// --------------------
// `model-change.js` decides WHETHER the ruler was swapped between two runs;
// `comparison-drivers.js` shapes that verdict into a driver record. Neither
// says it out loud. Until 2026-09-02 the saying-it-out-loud lived inside
// `sections.js` as markdown-emitting helpers, which meant exactly ONE surface
// could warn — and it was not the surface anyone reads.
//
// The HTML report is the file the founder opens, prints, and hands to a client.
// It computed `buildRunComparison(snaps)` into a local named `comparison` and
// then never read it: `grep -n comparison lib/report/html.js` returned the
// import, that assignment, and nothing else. So on 2026-09-01 the HTML report
// asserted «scored 50 of 100 … 42 points below the 2026-08-13 run» with no
// mention anywhere on the page that ChatGPT had answered the two runs on two
// different models. The guard was built correctly and stood at the wrong door.
//
// So the copy lives here, as SENTENCES rather than markup, and every surface
// renders the same words: markdown italicises them, HTML puts them in an alert
// card, the portal payload carries the model they were built from. A caveat two
// surfaces word differently is a caveat a reader can shop around.
//
// SECOND AXIS, SAME CLASS OF SILENCE
// ----------------------------------
// `buildModelChanges` deliberately skips a provider present in only one of the
// two runs (model-change.js: `if (!prev.has(provider)) continue;`) — that is a
// coverage change, not an instrument swap, and classifying it as one would
// double-count it. Correct, except the coverage change was then reported by
// nobody: it lands in `segments.indeterminate`, whose count reaches the payload
// and no renderer at all. An engine that was measured last run and skipped this
// run left no trace in any sentence of any report. Same failure as the model
// axis — the fact was computed and never said — so it is said here, next to it.
//
// Pure functions, no I/O, no markup.

/** @type {Readonly<Record<string, string>>} Engine ids as a client should read them. */
const PROVIDER_LABELS = Object.freeze({
  openai: 'ChatGPT',
  gemini: 'Gemini',
  anthropic: 'Claude',
  perplexity: 'Perplexity',
});

/**
 * Client-facing name for a provider id. Unknown ids pass through: a new engine
 * printing its own slug is honest, where a fallback like "another engine" would
 * hide which one from the reader who has to act on it.
 * @param {string} p
 * @returns {string}
 */
export function providerLabel(p) {
  return PROVIDER_LABELS[p] || p;
}

/**
 * The per-row marker for a table row measured on a swapped engine. Shared so
 * the row-level mark and the section-level caveat cannot drift apart into two
 * different descriptions of one fact.
 * @type {string}
 */
export const INSTRUMENT_ROW_NOTE = 'different model than last run';

/**
 * `manual` is an internal sentinel for a human-pasted answer, not a model id —
 * "ChatGPT ran manual last time" reads as a leaked field name in a document a
 * client acts on. Every other value is a real id and is printed verbatim, which
 * is the whole point of naming it: a model id is the only form in which "the
 * ruler was swapped" can be checked rather than taken on faith.
 * @param {string} id
 * @returns {string}
 */
export function instrumentName(id) {
  return id === 'manual' ? 'a pasted answer from its own app' : id;
}

/**
 * One sentence per KIND of engine change, describing ONLY the change itself.
 *
 * Movement is claimed exactly once, by `closing` below, which knows whether any
 * occurred. These used to end in "…so some of the movement above belongs to
 * that change", which put the assertion in two places — and the second one
 * fired on a flat run, printing it under a headline reading "unchanged".
 *
 * Keyed by `model-change.js`'s kinds; `unknown` doubles as the fallback so a
 * future kind added there degrades to an honest "we can't size this" rather
 * than borrowing whichever sentence happens to be nearby.
 * @type {Readonly<Record<string, string>>}
 */
export const INSTRUMENT_EXPLANATION = Object.freeze({
  line: 'Different models read the same question differently and return different lists.',
  generation: 'Those are a whole generation apart — the newer one retrieves and writes differently enough to return a different list.',
  // No restatement of the pair: the transition sentence right before this one
  // already spells out "a pasted answer from its own app" (instrumentName).
  surface: 'Those are different surfaces, not just different models — they retrieve differently and personalise differently.',
  minor: 'That is a smaller step within the same model family — it can nudge how prominently you are described, but it rarely decides whether you appear at all.',
  unknown: 'We cannot tell from the model names how large that step is, so treat the comparison on that engine as indicative rather than exact.',
});

/** "a" / "a and b" / "a, b and c" — the small English list-join every caveat needs. */
export function joinWithAnd(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * "ChatGPT ran gpt-5-search-api last time and gpt-5.4-mini this time." — the
 * «было → стало» the founder asked for, in the only form that lets a reader
 * verify it.
 * @param {Object} model Output of `buildRunComparison`.
 * @returns {string} Empty when no engine changed explanatorily.
 */
export function instrumentTransitions(model) {
  const driver = model?.driverSummary?.engineChange;
  if (!driver) return '';
  return driver.transitions.map((t) => {
    const [before, after] = t.text.split(' → ');
    return `${providerLabel(t.provider)} ran ${instrumentName(before)} last time and ${instrumentName(after)} this time.`;
  }).join(' ');
}

/**
 * The instrument caveat, as four independent sentences.
 *
 * Returned in PARTS rather than one joined string because the two surfaces
 * legitimately need different assemblies. The markdown section prints
 * `transitions` inside its "Where you lost ground" table when it has one — that
 * is where the misleading story gets told, and a footnote under the table does
 * not reach a reader who has already read the names — so it must be able to
 * drop the sentence from the closing paragraph without re-deriving it. The HTML
 * report has no such table and always needs it.
 *
 * Every sentence is position-neutral: `closing` says "this run's movement", not
 * "the movement above", because in HTML the caveat LEADS the section rather than
 * closing it. A caveat a reader meets after the numbers is the footnote failure
 * this module exists to prevent.
 *
 * @param {Object} model Output of `buildRunComparison`.
 * @returns {{providers: string[], transitions: string, explanation: string,
 *            noLikeForLike: string, closing: string, sentences: string[]}|null}
 *   Null when no engine changed in a way that could explain movement — a
 *   dated-snapshot pin is provenance, not a caveat.
 */
export function buildInstrumentCaveat(model) {
  const driver = model?.driverSummary?.engineChange;
  if (!driver) return null;

  const transitions = instrumentTransitions(model);
  const explanation = INSTRUMENT_EXPLANATION[driver.strongestKind]
    || INSTRUMENT_EXPLANATION.unknown;

  const blind = (driver.noLikeForLike || []).map(providerLabel);
  const noLikeForLike = blind.length > 0
    ? `On ${joinWithAnd(blind)} there is no overlap at all between the two runs — not one answer was measured the same way twice, so nothing on ${blind.length === 1 ? 'that engine' : 'those engines'} is a like-for-like comparison.`
    : '';

  // The closing sentence must not assert movement that did not happen. When
  // nothing was lost, nothing was gained and no kept answer moved, "the
  // movement is still real" sits under a headline reading "unchanged" — a
  // self-contradiction on the one surface this whole feature exists to keep
  // honest, and one that only appears BECAUSE an engine swap now (correctly)
  // stops the calm "held steady" message from firing.
  const moved = model.counts.lost > 0 || model.counts.gained > 0
    || model.driverSummary.hasGenuineConditionalChange;
  const closing = moved
    ? 'So some of this run’s movement belongs to that change rather than to your visibility. It is still real and still worth acting on; it is the size of it that carries this caveat.'
    : 'Nothing changed hands this run — no answer was won or lost. Holding your ground while the engine underneath moved is a better result than a flat line usually looks, but it is not measured against the same instrument as last time.';

  return {
    providers: driver.providers,
    transitions,
    explanation,
    noLikeForLike,
    closing,
    sentences: [transitions, explanation, noLikeForLike, closing].filter(Boolean),
  };
}

/**
 * The coverage caveat: an engine measured in one run and not the other.
 *
 * Kept separate from the instrument caveat rather than folded into it. They
 * answer different questions — "the ruler moved" versus "this engine was not on
 * the ruler at all" — and only the second one means a chunk of the comparison
 * has no basis rather than an uncertain one. Merging them would let a reader
 * discount a missing engine as a model-version footnote.
 *
 * Cell counts come from `segments.indeterminate`, which is exactly where a
 * one-sided cell lands (`comparison-segments.js` classifies a null on either
 * side as indeterminate) — so the number is the real count of answers excluded
 * from the won/held/lost tally, not an estimate.
 *
 * WHAT THIS MAY NOT CLAIM
 * -----------------------
 * The first version of this copy said "the two runs are compared only on the
 * engines they share", and for the added case, that the new engine "counts
 * towards this run's score and towards no movement figure". Both are false, and
 * a review caught them before they shipped. Only the WON/HELD/LOST TALLY is
 * scoped to shared cells: `segmentCells` keys on query×provider and routes a
 * one-sided cell to `indeterminate`. The headline index is not scoped to
 * anything — `computeUVIBreakdown(computeComponents(run))` scores each run over
 * that run's own `results`, so a coverage change moves the delta by basket
 * composition alone. Reproducible on the committed pair in
 * `test/fixtures/model-change-pair` — both pairs are the ones the E2E builds:
 *
 *   both runs, all four engines                          uvi.delta = −18
 *   `perplexity` removed from curr  (engine dropped)      uvi.delta = −21
 *   `perplexity` removed from prev  (engine added)        uvi.delta = −17
 *
 * A number in this comment has to be checkable from the fixture in the
 * repository, or it is one more claim taken on faith inside a guard that exists
 * to stop exactly that. An earlier draft of this block cited a −24 obtained by
 * splicing a synthetic fifth provider into the run — a real value, but not one
 * a reader could reproduce, and a post-commit check could not find it.
 *
 * So the score gets the same hedge the instrument caveat gives it — "part of
 * the movement belongs to the change rather than to your visibility" — and
 * never a claim of exclusion it does not have. Asserting a false all-clear is
 * the same defect as saying nothing, one direction over.
 *
 * @param {Object} model Output of `buildRunComparison`.
 * @returns {{dropped: Array<{provider: string, label: string, cells: number}>,
 *            added: Array<{provider: string, label: string, cells: number}>,
 *            sentences: string[]}|null}
 *   Null when both runs measured the same set of engines.
 */
export function buildCoverageCaveat(model) {
  const coverage = model?.coverageChange;
  if (!coverage) return null;
  const dropped = coverage.dropped || [];
  const added = coverage.added || [];
  if (dropped.length === 0 && added.length === 0) return null;

  // "the tally of answers won, held and lost" names what the reader can see —
  // the lost/held/gained/never badges — without reaching for `cell`, `segment`
  // or any other word from inside the pipeline (the tone contract in
  // sections.js). Named once and referred back to when both sides fire.
  const TALLY = 'the tally of answers won, held and lost';
  const sentences = [];
  const side = (rows, tallyPhrase) => {
    const names = joinWithAnd(rows.map((r) => r.label));
    const cells = rows.reduce((n, r) => n + r.cells, 0);
    const possessive = rows.length === 1 ? 'its' : 'their';
    return { names, cells, possessive, tallyPhrase };
  };

  if (dropped.length > 0) {
    const s = side(dropped, TALLY);
    sentences.push(
      `${s.names} ${dropped.length === 1 ? 'was' : 'were'} measured in the previous run and not in this one, `
      + `so ${s.possessive} ${s.cells} ${s.cells === 1 ? 'answer is' : 'answers are'} left out of ${s.tallyPhrase} — `
      + `that tally counts only the answers both runs measured.`,
    );
  }
  if (added.length > 0) {
    // "that same tally … too" only reads as English once a dropped sentence has
    // introduced the tally. Alone, the added sentence has to name it itself.
    const alongsideDropped = dropped.length > 0;
    const s = side(added, alongsideDropped ? 'that same tally' : TALLY);
    sentences.push(
      `${s.names} ${added.length === 1 ? 'was' : 'were'} measured in this run and not in the previous one, `
      + `so ${s.possessive} ${s.cells} ${s.cells === 1 ? 'answer is' : 'answers are'} left out of ${s.tallyPhrase}`
      + `${alongsideDropped ? ' too' : ''} — `
      + `there is nothing on the other side to compare ${s.cells === 1 ? 'it' : 'them'} against.`,
    );
  }
  // Stated ONCE however many sides fired, and stated as attribution rather than
  // exclusion — the score really did move, and part of why is the coverage.
  sentences.push(
    'The score is a different matter: each run is scored on everything it measured that run, '
    + 'so part of the movement between the two belongs to the change in coverage rather than to your visibility.',
  );
  return { dropped, added, sentences };
}

/**
 * Headline for the coverage caveat — "Perplexity was not measured this run".
 * A title, not a sentence: the surfaces that have a card slot need one, and
 * deriving it twice is how the two end up naming different engines.
 *
 * Both sides are named when both fired. Titling a swap with only the dropped
 * engine would put a heading over a body that talks about two, and the reader
 * who stops at headings would take the new engine on the strength of a caveat
 * that never mentioned it.
 *
 * @param {{dropped: Array<{label: string}>, added: Array<{label: string}>}} caveat
 * @returns {string}
 */
export function coverageCaveatTitle(caveat) {
  const dropped = caveat?.dropped || [];
  const added = caveat?.added || [];
  const parts = [];
  if (dropped.length > 0) {
    parts.push(`${joinWithAnd(dropped.map((d) => d.label))} ${dropped.length === 1 ? 'was' : 'were'} not measured this run`);
  }
  if (added.length > 0) {
    parts.push(`${joinWithAnd(added.map((a) => a.label))} ${added.length === 1 ? 'is' : 'are'} new to it`);
  }
  // "X was not measured this run" alone, or "X was not measured this run, Y is
  // new to it" — the second clause leans on the first for "this run".
  return parts.length === 2 ? parts.join(', ') : parts[0].replace(' new to it', ' new to this run');
}
