/**
 * Phase 5 — selection (1.0.6 commercial-only over-generate).
 *
 * Algorithm:
 *   - All candidates are commercial-intent (brainstorm produces only commercial)
 *   - Pick top-3 by score; remainder become alternatives pool (2 spares typically)
 *   - Selected triplet MUST all be validated when validator was available;
 *     when validation was skipped (single-provider mode), use the score order
 *     as-is and mark alternatives as `unverified`.
 *
 * The 4-bucket intent-diversity logic (REQUIRED_INTENTS, FALLBACK_CHAIN,
 * verticalDominance) was retired in 1.0.6. Vertical / problem / comparison
 * queries reliably failed the downstream commercial-only validator —
 * generating only commercial candidates removes the upstream cause.
 *
 * Silent substitution happens DOWNSTREAM of this function: cmdInit validates
 * all 5 candidates through both stages and swaps top-3 failures with passing
 * spares. By the time the user sees `formatSelection` output, top-3 are
 * post-substitution.
 */

/**
 * Select top-3 by score plus alternatives pool.
 *
 * @param {Array} candidates   scored + validated candidate list (all commercial)
 * @returns {{
 *   selected: Array<{ intent, candidate, fallbackUsed }>,
 *   alternatives: Array<{ ...candidate, unverified: boolean }>,
 *   warnings: string[],
 *   infos: string[],
 * }}
 */
/**
 * Shared ordering comparator for selection. Primary key is `score` (unchanged
 * public behaviour); brand-fit rank (core > adjacent/unknown > aspirational) is
 * a SECONDARY tiebreaker that nudges down-rank an aspirational query when scores
 * are close. It is a ranking signal, never a filter — a candidate with any
 * brand-fit still competes on score first. Candidates without a brandFitRank
 * (older pools, pre-fix) sort exactly as before (neutral rank).
 *
 * Exported so the bin re-sort sites stay in lockstep with this file — otherwise
 * a downstream `sort((a,b) => b.score - a.score)` would erase the brand-fit bias.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
export function compareCandidates(a, b) {
  const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
  if (scoreDelta !== 0) return scoreDelta;
  // Tie on score → prefer the more plausible brand answer.
  const rankA = typeof a.brandFitRank === 'number' ? a.brandFitRank : 1;
  const rankB = typeof b.brandFitRank === 'number' ? b.brandFitRank : 1;
  return rankB - rankA;
}

// Absolute quality floor for the top-3. Base score is 50 (score.js); a query
// with the word-count sweet-spot alone already reaches 70, so 60 cleanly
// separates "has real signal" from "barely above base + one trivial bonus" (the
// score=55 that used to sneak into the basket). It's a SOFT floor: if fewer than
// 3 candidates clear it we still fill the basket from the weaker pool (never emit
// fewer than 3) and flag it weak. Tunable in one place.
export const SELECTION_MIN_SCORE = 60;

/**
 * Split a score-sorted pool into 3 picks + the remainder, applying the quality
 * floor. Candidates at/above SELECTION_MIN_SCORE are PREFERRED for the 3 slots;
 * weaker ones fill remaining slots only when fewer than 3 clear the floor (we
 * must always return 3). `weakBasket` flags that fallback so callers can warn.
 *
 * Shared by selectTopThree AND the cmdInit post-substitution re-rank so the floor
 * is applied in exactly one place, not duplicated.
 *
 * @param {Array} sortedPool  already ordered best-first (compareCandidates)
 * @returns {{ picks: Array, rest: Array, weakBasket: boolean, aboveFloor: number }}
 */
export function applySelectionFloor(sortedPool) {
  const aboveFloor = sortedPool.filter(c => (c.score ?? 0) >= SELECTION_MIN_SCORE);
  const belowFloor = sortedPool.filter(c => (c.score ?? 0) < SELECTION_MIN_SCORE);
  // Each partition preserves the incoming descending order, and every aboveFloor
  // score ≥ every belowFloor score, so the concatenation stays sorted.
  const ordered = [...aboveFloor, ...belowFloor];
  return {
    picks: ordered.slice(0, 3),
    rest: ordered.slice(3),
    weakBasket: aboveFloor.length < 3,
    aboveFloor: aboveFloor.length,
  };
}

export function selectTopThree(candidates, { validationSkipped = false } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      selected: [],
      alternatives: [],
      warnings: ['No candidates available after filter/validation'],
      infos: [],
    };
  }

  const validatedOnly = !validationSkipped;

  const sortedByScore = [...candidates]
    .filter(c => !validatedOnly || c.validation === 'ok')
    .sort(compareCandidates);

  const warnings = [];
  const infos = [];

  if (validationSkipped) {
    infos.push('Single-provider mode — candidates not cross-validated. See alternatives labelled (unverified).');
  }

  // When validator-only filtering leaves us short, retry without the
  // `validation==='ok'` requirement (the legacy fallback behaviour). The
  // unvalidated picks come through with a warning so the operator knows.
  let pool = sortedByScore;
  if (validatedOnly && pool.length < 3) {
    const allCandidates = [...candidates].sort(compareCandidates);
    if (allCandidates.length >= 3) {
      warnings.push(`only ${pool.length} validated commercial candidates — falling back to top-3 by score (unvalidated entries marked)`);
      pool = allCandidates;
    }
  }

  if (pool.length < 3) {
    return {
      selected: [],
      alternatives: [],
      warnings: [...warnings, `only ${pool.length} commercial candidates available — pipeline did not produce enough`],
      infos,
    };
  }

  const { picks, rest, weakBasket, aboveFloor } = applySelectionFloor(pool);
  if (weakBasket) {
    warnings.push(`only ${aboveFloor} of ${pool.length} candidates clear the quality floor (score ≥ ${SELECTION_MIN_SCORE}) — filling the basket with weaker queries; consider refining your company description`);
  }
  const selected = picks.map(c => ({
    intent: c.intent || 'commercial',
    candidate: c,
    fallbackUsed: null,
  }));
  const alternatives = rest.map(c => ({
    ...c,
    unverified: c.validation !== 'ok',
  }));

  return { selected, alternatives, warnings, infos };
}

/**
 * Format selection result for human display. Returns an array of printable
 * lines.
 */
export function formatSelection(result) {
  const lines = [];
  lines.push('Selected queries:');
  for (const pick of result.selected) {
    const { candidate, intent } = pick;
    const score = candidate.score ?? '?';
    const confidence = candidate.confidence || 'unknown';
    lines.push(`  ${(intent || 'commercial').padEnd(14)} score=${score} ${confidence}`);
    lines.push(`    → ${candidate.text}`);
  }
  if (result.alternatives.length > 0) {
    lines.push('');
    lines.push('Alternatives (for swap):');
    for (const alt of result.alternatives) {
      // 1.0.4 Fix A.1d: (validated) tag requires BOTH stages — category
      // validation (!alt.unverified) AND commercial-only / industry-fit
      // (search_behavior absent OR equal to 'retrieval-triggered').
      const passedBothStages = !alt.unverified
        && (!alt.search_behavior || alt.search_behavior === 'retrieval-triggered');
      const label = passedBothStages ? '(validated)' : '(unverified)';
      lines.push(`  [${alt.score}] ${(alt.intent || 'commercial').padEnd(14)} ${label} ${alt.text}`);
    }
  }
  if (result.infos && result.infos.length > 0) {
    lines.push('');
    for (const i of result.infos) lines.push(`  ℹ ${i}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines;
}
