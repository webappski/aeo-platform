/**
 * Per-cell trial aggregation for sampled (multi-trial) runs.
 *
 * When `--samples N>1` is set, each (query × region × provider × mode) cell is
 * queried N times. The N raw trial outcomes are collapsed back into ONE record
 * in `results[]` (the load-bearing invariant — 7+ consumers do
 * `results.find(query && provider)` and take the first/only match). The N
 * trials live INSIDE that record as `trials[]`, and the top-level
 * mention/position/citationCount fields carry a deterministic REPRESENTATIVE
 * summary so every existing consumer keeps working unchanged.
 *
 * This module owns the collapse rules — kept pure (no I/O) so it is unit-tested
 * against exact expected values (R37: E2E would only smear the arithmetic).
 *
 * Zero dependencies beyond lib/stats.js (R4).
 */

import { presenceFromCounts, DEFAULT_CONFIDENCE } from './stats.js';

/** A trial counts toward the presence numerator when the brand appeared in the
 *  body ('yes') OR only in a citation ('src'). 'no' is a real absence; 'error'
 *  is NOT a measurement and is excluded from the denominator entirely. */
function isHit(mention) {
  return mention === 'yes' || mention === 'src';
}

/**
 * Pick the representative top-level `mention` for a cell from its trial
 * outcomes (errors already removed). Modal value with a deterministic
 * tie-break `yes > src > no`, so a cell that is 'yes' in as many trials as it
 * is 'no' is reported as the stronger 'yes' (presence is the headline signal,
 * and the fraction is preserved separately in `presence`).
 *
 * @param {Array<{mention:string}>} measured non-error trials
 * @returns {'yes'|'src'|'no'}
 */
function representativeMention(measured) {
  const counts = { yes: 0, src: 0, no: 0 };
  for (const t of measured) {
    if (t.mention === 'yes') counts.yes++;
    else if (t.mention === 'src') counts.src++;
    else counts.no++;
  }
  const max = Math.max(counts.yes, counts.src, counts.no);
  // Tie-break order is the strength order, NOT object key order — explicit so a
  // future key reshuffle can't silently change the winner.
  if (counts.yes === max) return 'yes';
  if (counts.src === max) return 'src';
  return 'no';
}

/** Median of a numeric array (already filtered to finite numbers). Even-length
 *  → lower-mid (deterministic; positions are small integers, averaging would
 *  invent a fractional rank). */
function medianLower(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** Confidence strength order for prose-rank — used to pick the representative
 *  confidence of a sampled cell (the WEAKEST observed, so a single low-conf
 *  trial doesn't get upgraded by aggregation). */
const PROSE_CONF_RANK = { med: 3, low: 2, 'single-model': 1 };

/**
 * Representative prose-rank for a cell from its trials. A trial contributes when
 * it carries a usable prose ordinal (`proseRank.rank` ≥ 1). Rank = lower-median
 * of those ordinals (same deterministic rule as list position); confidence =
 * the WEAKEST confidence among contributing trials (conservative — aggregation
 * must not manufacture certainty). Returns null when no trial had a prose rank.
 *
 * @param {Array<{proseRank?:{rank?:number,confidence?:string,rationale?:string}}>} measured
 * @returns {{rank:number,confidence:string,rationale:string}|null}
 */
function representativeProseRank(measured) {
  const withRank = measured.filter(
    t => t.proseRank && typeof t.proseRank.rank === 'number' && t.proseRank.rank > 0,
  );
  if (withRank.length === 0) return null;
  const rank = medianLower(withRank.map(t => t.proseRank.rank));
  // weakest confidence among contributors (default to 'low' for any unlabelled)
  let weakest = withRank[0].proseRank.confidence || 'low';
  for (const t of withRank) {
    const conf = t.proseRank.confidence || 'low';
    if ((PROSE_CONF_RANK[conf] ?? 0) < (PROSE_CONF_RANK[weakest] ?? 0)) weakest = conf;
  }
  // rationale from a trial whose rank equals the representative rank (stable pick)
  const repr = withRank.find(t => t.proseRank.rank === rank) || withRank[0];
  return { rank, confidence: weakest, rationale: repr.proseRank.rationale || '' };
}

/**
 * Aggregate the trial outcomes of ONE cell into a representative summary plus a
 * fractional presence object.
 *
 * Input trials are the per-call shapes the run loop already builds, restricted
 * to the fields that vary per trial:
 *   { mention, position, citationCount, canonicalCitations?, hasBrandInCitations?,
 *     elapsedMs? }
 *
 * Rules:
 *   - presence.hits / presence.n: hits = #('yes'|'src') trials; n = #non-error
 *     trials. n=0 (every trial errored) → presence.rate 0, CI [0,1].
 *   - representative `mention`: modal over non-error trials, tie-break yes>src>no.
 *   - representative `position`: median over trials that were 'yes' WITH a
 *     numeric position (a 'no'/'src' trial has no body rank). null when none.
 *   - representative `citationCount`: max across trials (union semantics —
 *     a citation seen in ANY trial is a real citation for the cell).
 *   - `hasBrandInCitations`: OR across trials (seen in any trial → true).
 *   - canonicalCitations: union across trials (dedup, order-stable by
 *     first-seen) so the report's source aggregation sees every cited URL.
 *
 * @param {Array<object>} trials non-error+error trial outcomes for one cell
 * @param {object} [opts]
 * @param {number} [opts.level] confidence level for the CI (default 0.95)
 * @returns {{ mention:string, position:(number|null), citationCount:number,
 *             canonicalCitations:string[], hasBrandInCitations:boolean,
 *             presence:{hits:number,n:number,rate:number,
 *                       ci:{low:number,high:number,level:number}} }}
 */
export function aggregateCellTrials(trials, opts = {}) {
  const level = opts.level ?? DEFAULT_CONFIDENCE;
  const all = Array.isArray(trials) ? trials : [];
  const measured = all.filter(t => t && t.mention !== 'error');

  const n = measured.length;
  const hits = measured.filter(t => isHit(t.mention)).length;
  const presence = presenceFromCounts(hits, n, level);

  // Representative mention. With zero measured trials (all errored) there is no
  // representative outcome — report 'error' so the cell is treated as
  // uncovered everywhere (diff skips it, score excludes it), matching the
  // single-shot all-error contract.
  const mention = n === 0 ? 'error' : representativeMention(measured);

  // Position: median over 'yes' trials with a usable numeric position.
  const yesPositions = measured
    .filter(t => t.mention === 'yes' && typeof t.position === 'number' && t.position > 0)
    .map(t => t.position);
  const position = mention === 'yes' ? medianLower(yesPositions) : null;

  // Citation count: union magnitude = max across trials.
  const citationCount = measured.reduce(
    (mx, t) => Math.max(mx, typeof t.citationCount === 'number' ? t.citationCount : 0),
    0,
  );

  // hasBrandInCitations: any-trial OR.
  const hasBrandInCitations = measured.some(t => t.hasBrandInCitations === true);

  // AP-PROSE-RANK — representative prose ordinal across trials (null when the
  // cell got a list-rank or no trial produced a prose rank). Only meaningful
  // when the representative mention is 'yes' AND there is no list position
  // (prose answers), matching the run-loop gate; the caller keeps list-rank
  // primary so a cell never carries both.
  const proseRank = (mention === 'yes' && position === null)
    ? representativeProseRank(measured)
    : null;

  // canonicalCitations: first-seen-stable union across trials.
  const seen = new Set();
  const canonicalCitations = [];
  for (const t of measured) {
    for (const u of (t.canonicalCitations || [])) {
      if (!seen.has(u)) { seen.add(u); canonicalCitations.push(u); }
    }
  }

  return {
    mention,
    position,
    citationCount,
    canonicalCitations,
    hasBrandInCitations,
    presence,
    proseRank,
  };
}

/**
 * Resolve and validate the `--samples` flag. Never-fail (AP-FAIL-BRANCHES):
 * a missing/garbage/over-cap value degrades to a sane number rather than
 * throwing. The default is 1 → byte-identical single-shot behaviour (R39).
 *
 * @param {*} raw      the raw flag value (string | number | undefined)
 * @param {number} [max] cost-stop ceiling (default 25)
 * @returns {number} integer in [1, max]
 */
export function resolveSamples(raw, max = MAX_SAMPLES) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;       // garbage / 0 / negative → single-shot
  if (n > max) return max;                           // cost-stop
  return n;
}

/** Cost-stop ceiling for --samples (×N API cost). */
export const MAX_SAMPLES = 25;
