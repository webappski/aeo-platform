// Causal decomposition of an index movement between two runs.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The Unified Visibility Index has four components, but they are NOT four
// independent levers, and presenting them as a flat "biggest mover first" list
// actively misleads whoever has to act on the report.
//
// Presence and Citation are measured across every cell of the run. Sentiment
// and Rank are averages taken ONLY over cells where the brand actually appears.
// That makes the latter two *conditional*: when the brand drops out of an
// answer, the conditional averages move on their own, because the population
// they average over changed - not because anything about the surviving answers
// got worse.
//
// A worked example from a real run pair: sentiment fell 100 -> 83 and read as
// the single largest contributor to a 14-point index drop. Decomposed, the
// like-for-like change across cells present in BOTH runs was exactly zero. The
// entire movement came from one NEWLY GAINED mention that was factual rather
// than glowing. The brand had broken into a third engine - an unambiguous win -
// and the report scored it as its worst decline. Acting on the undecomposed
// number would have meant commissioning reputation work against a tone problem
// that did not exist.
//
// So every conditional component is split into:
//   like-for-like  - movement among cells present in both runs. A REAL signal.
//   compositional  - movement caused purely by which cells entered or left.
// and gained cells that scored below the previous average are flagged
// explicitly, so a gain is never reported to a client as a decline.

import { SEG_GAINED, SEG_HELD, SEG_LOST } from './comparison-segments.js';

/** @type {string} Component measured across every cell in the run. */
export const KIND_DIRECT = 'direct';
/**
 * @type {string} Component averaged only over cells where the brand appears,
 * so its movement is partly an artefact of which cells appear at all.
 */
export const KIND_CONDITIONAL = 'conditional';

/**
 * Decompose a conditional component's movement into the part that reflects a
 * genuine change and the part that is an artefact of sample composition.
 *
 * "Eligible" means the extractor returned a usable number for that cell. A held
 * cell that carried no rank in one of the runs is not eligible for the rank
 * like-for-like comparison, and is reported as such rather than silently
 * dropped - a component where NOTHING was comparable across both runs is a
 * meaningful finding, not a blank.
 *
 * @param {Object} params
 * @param {Object} params.segments  Output of `segmentCells`.
 * @param {(row: Object) => (number|null)} params.valueOf
 *   Per-cell numeric value for this component, or null when not applicable.
 * @param {number|null} params.prevValue  Reported component value, previous run.
 * @param {number|null} params.currValue  Reported component value, latest run.
 * @param {boolean} [params.lowerIsBetter]
 *   True for position-like values where #2 beats #11. Affects only which gained
 *   cells count as dragging the average, never the arithmetic.
 * @returns {{likeForLike: {prev: number, curr: number, delta: number,
 *                          cellCount: number}|null,
 *            compositionalDelta: number|null,
 *            totalDelta: number|null,
 *            isPurelyCompositional: boolean,
 *            gainDrag: Array<{key: string, queryText: string, label: string,
 *                             value: number}>}}
 */
export function decomposeConditional({
  segments, valueOf, prevValue, currValue, lowerIsBetter = false,
}) {
  const eligible = (segments?.[SEG_HELD] || []).filter(
    (cell) => isNumber(valueOf(cell.before)) && isNumber(valueOf(cell.after)),
  );

  const likeForLike = eligible.length
    ? buildLikeForLike(eligible, valueOf)
    : null;

  const totalDelta = isNumber(prevValue) && isNumber(currValue)
    ? round2(currValue - prevValue)
    : null;

  const compositionalDelta = totalDelta !== null && likeForLike
    ? round2(totalDelta - likeForLike.delta)
    : totalDelta;

  return {
    likeForLike,
    compositionalDelta,
    totalDelta,
    isPurelyCompositional: totalDelta !== null
      && (likeForLike === null || likeForLike.delta === 0),
    gainDrag: findGainDrag(segments, valueOf, lowerIsBetter),
  };
}

/**
 * Average the component across cells comparable in both runs.
 * @param {Array<Object>} eligible
 * @param {(row: Object) => (number|null)} valueOf
 * @returns {{prev: number, curr: number, delta: number, cellCount: number}}
 */
function buildLikeForLike(eligible, valueOf) {
  const prev = mean(eligible.map((cell) => valueOf(cell.before)));
  const curr = mean(eligible.map((cell) => valueOf(cell.after)));
  return {
    prev: round2(prev),
    curr: round2(curr),
    delta: round2(curr - prev),
    cellCount: eligible.length,
  };
}

/**
 * Newly gained cells whose value sits below the previous run's average, i.e.
 * cells that pulled a conditional average down purely by arriving.
 *
 * Surfacing these is the difference between telling a client "your tone got
 * worse" and telling them "you broke into a new engine and it described you
 * factually" - opposite conclusions from the same arithmetic.
 *
 * The baseline is recomputed from the previous run's own cells rather than
 * taken from the reported component value. Those are not always in the same
 * units - the rank component is a 0-100 strength while a cell carries a list
 * position - and comparing across that mismatch would silently flag the wrong
 * cells.
 *
 * @param {Object} segments
 * @param {(row: Object) => (number|null)} valueOf
 * @param {boolean} lowerIsBetter
 * @returns {Array<{key: string, queryText: string, label: string, value: number}>}
 */
function findGainDrag(segments, valueOf, lowerIsBetter) {
  const baseline = previousAverage(segments, valueOf);
  if (baseline === null) return [];
  const isWorse = (value) => (lowerIsBetter ? value > baseline : value < baseline);
  return (segments?.[SEG_GAINED] || [])
    .map((cell) => ({ cell, value: valueOf(cell.after) }))
    .filter(({ value }) => isNumber(value) && isWorse(value))
    .map(({ cell, value }) => ({
      key: cell.key,
      queryText: cell.queryText,
      label: cell.label,
      value: round2(value),
    }));
}

/**
 * Name the root cause behind an index movement, so the report can lead with one
 * cause rather than four ranked symptoms.
 *
 * The rule is structural, not tuned to any particular brand: if the directly
 * measured components moved and no conditional component shows a like-for-like
 * change, then every movement traces back to which answers the brand appears
 * in, and the report should say exactly that.
 *
 * @param {Array<{key: string, kind: string, label: string,
 *                contributionDelta: number, decomposition?: Object}>} components
 * @returns {{primary: Array<Object>, derived: Array<Object>,
 *            hasGenuineConditionalChange: boolean,
 *            allMovementIsCompositional: boolean,
 *            gainPenalisedComponents: Array<string>}}
 */
export function summarizeDrivers(components) {
  const list = components || [];
  const primary = list.filter((comp) => comp.kind === KIND_DIRECT);
  const derived = list.filter((comp) => comp.kind === KIND_CONDITIONAL);

  const hasGenuineConditionalChange = derived.some(
    (comp) => (comp.decomposition?.likeForLike?.delta || 0) !== 0,
  );

  const movedPrimary = primary.some((comp) => (comp.contributionDelta || 0) !== 0);
  const movedDerived = derived.some((comp) => (comp.contributionDelta || 0) !== 0);

  return {
    primary,
    derived,
    hasGenuineConditionalChange,
    allMovementIsCompositional:
      movedPrimary && movedDerived && !hasGenuineConditionalChange,
    gainPenalisedComponents: derived
      .filter((comp) => (comp.decomposition?.gainDrag || []).length > 0)
      .map((comp) => comp.key),
  };
}

/**
 * Average of this component across every cell where the brand appeared in the
 * previous run - that is, the cells that were lost plus the cells still held.
 * Returned in per-cell units, so it is safe to compare a cell against it.
 * @param {Object} segments
 * @param {(row: Object) => (number|null)} valueOf
 * @returns {number|null} Null when no previous cell carried a usable value.
 */
function previousAverage(segments, valueOf) {
  const values = [...(segments?.[SEG_LOST] || []), ...(segments?.[SEG_HELD] || [])]
    .map((cell) => valueOf(cell.before))
    .filter(isNumber);
  return values.length ? mean(values) : null;
}

/**
 * Arithmetic mean of a numeric list. Callers guarantee a non-empty list.
 * @param {Array<number>} values
 * @returns {number}
 */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Finite-number guard. Rejects null/undefined/NaN alike, which matters because
 * an absent rank is legitimately null and must not be averaged as zero.
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Round to two decimals to keep contribution arithmetic stable and printable.
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}
