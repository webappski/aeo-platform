/**
 * ONE definition of the visibility numerator and denominator.
 *
 * Before this module the same question — "out of how many?" — was answered in
 * at least five places with three different answers:
 *   - `bin/aeo-tracker.js` headline score: cells, errors excluded;
 *   - `bin/aeo-tracker.js` per-engine `pct`: cells, errors INCLUDED;
 *   - `lib/report/run-metrics.js` lift opportunity: `results.length`, errors INCLUDED;
 *   - `lib/report/sections.js` intent table: cells, errors INCLUDED;
 *   - `lib/report/html.js` matrix aggregate: its own count again.
 * A run with API errors therefore published several different denominators for
 * the same basket, and nothing in the report said which one the headline used.
 *
 * The second defect this closes is subtler and only fires with `--samples N>1`.
 * A sampled cell already carries its own fraction in `presence.hits/n`
 * (lib/stats.js), but every score above counted the cell's REPRESENTATIVE
 * label instead — modal, tie-broken `yes > src > no` (lib/sampling.js). A cell
 * measured twice with outcomes yes/no is 50% present and was scored as 100%.
 * `lib/report/visibility-index.js#perCellPresence` was the one surface that
 * already read the fraction; this module makes that the rule everywhere.
 *
 * The four numbers, each with exactly one meaning:
 *   hits     — trials where the brand appeared (answer text OR citation).
 *   valid    — trials that produced a measurement (`n`). THE DENOMINATOR.
 *   attempts — trials made, including the ones that errored.
 *   errors   — attempts − valid. Not measurements; never in the denominator.
 *
 * Legacy degrades exactly, not approximately: every record written before
 * sampling existed (including the 2026-08-31 baseline on disk) has no
 * `presence`, so it reads as one attempt — hits 1|0, valid 1 — and its score
 * is arithmetically identical to the number that run published. That
 * back-compat is pinned by a fixture, not assumed.
 *
 * Kept pure (no I/O) so it is unit-tested against exact expected values — the
 * same reasoning as lib/sampling.js's header (R37: E2E would only smear the
 * arithmetic). Zero dependencies (R4).
 */

/** Trial outcomes that count toward the numerator: named in the answer body
 *  ('yes') or present only in the cited sources ('src'). */
const HIT_MENTIONS = new Set(['yes', 'src']);

/** Outcomes that are NOT a measurement and must stay out of the denominator.
 *  'error' = the provider call failed; 'missing' = the cell was never asked at
 *  all (the matrix placeholder `lib/report/html.js` puts where an engine has no
 *  row for a question). Same population `lib/diff.js#isCoveredMention` refuses
 *  to compare — one definition of "we measured this", not two.
 *
 *  The two are NOT interchangeable downstream and `cellCounts` keeps them
 *  apart: a failed call is an attempt that produced nothing (attempts 1,
 *  errors 1), while a cell nobody asked is not an attempt (attempts 0,
 *  errors 0). Folding 'missing' into the error count would report engines as
 *  failing calls they never made. */
const UNMEASURED_MENTIONS = new Set(['error', 'missing']);

/** Outcomes where no call was made at all — neither a measurement nor a failure. */
const NEVER_ASKED_MENTIONS = new Set(['missing']);

/** @param {string} [mention] @returns {boolean} */
export function isHitMention(mention) {
  return HIT_MENTIONS.has(mention);
}

/** @param {string} [mention] @returns {boolean} true when the cell produced a real measurement */
export function isMeasuredMention(mention) {
  return !!mention && !UNMEASURED_MENTIONS.has(mention);
}

/** A `presence` object is usable when it carries a coherent hits/n pair. A
 *  malformed one (hits > n, negatives, non-finite) is ignored rather than
 *  trusted — never-fail: a corrupt field degrades the cell to single-shot
 *  reading instead of poisoning the run's headline. */
function usablePresence(presence) {
  if (!presence || typeof presence !== 'object') return false;
  const { hits, n } = presence;
  if (!Number.isFinite(hits) || !Number.isFinite(n)) return false;
  if (hits < 0 || n < 0 || hits > n) return false;
  return true;
}

/**
 * The four counts for ONE result record.
 *
 * Sampled record (`--samples N>1`): the fraction is authoritative — `presence`
 * holds hits/n over the non-error trials, and `trials[]` holds every attempt,
 * so errors are `attempts − n` without a second convention.
 *
 * Single-shot / legacy record: one attempt. An errored cell is an attempt with
 * no measurement (valid 0), which is what keeps it out of every denominator.
 *
 * @param {{mention?:string, presence?:{hits?:number,n?:number}, trials?:Array<object>}} record
 * @returns {{hits:number, valid:number, attempts:number, errors:number}}
 */
export function cellCounts(record) {
  if (!record || typeof record !== 'object') {
    return { hits: 0, valid: 0, attempts: 0, errors: 0 };
  }

  if (usablePresence(record.presence)) {
    const valid = record.presence.n;
    const hits = record.presence.hits;
    // trials[] is the only honest source of "how many calls did we make" — a
    // cell where every trial errored has n = 0 and would otherwise look like
    // zero attempts. When trials[] is absent (hand-written / trimmed record)
    // fall back to the measured count: we cannot invent errors we never saw.
    const attempts = Array.isArray(record.trials) ? record.trials.length : valid;
    return { hits, valid, attempts, errors: Math.max(0, attempts - valid) };
  }

  // A cell that was never asked is not an attempt, so it contributes nothing at
  // all — not a hit, not a denominator slot, and not a failure.
  if (NEVER_ASKED_MENTIONS.has(record.mention)) {
    return { hits: 0, valid: 0, attempts: 0, errors: 0 };
  }

  const measured = isMeasuredMention(record.mention);
  return {
    hits: isHitMention(record.mention) ? 1 : 0,
    valid: measured ? 1 : 0,
    attempts: 1,
    errors: measured ? 0 : 1,
  };
}

/**
 * Percentage of valid trials that were hits. `valid === 0` → 0, never NaN and
 * never a division by zero rendered as "—%": an empty basket scores 0, which
 * is the convention `lib/stats.js#wilson` already uses for n = 0.
 *
 * @param {number} hits @param {number} valid @returns {number} 0..100
 */
export function scorePercent(hits, valid) {
  if (!valid || valid <= 0) return 0;
  return Math.round((hits / valid) * 100);
}

/**
 * Roll up a list of result records into the run's four numbers plus the score.
 *
 * Every report surface that publishes a rate calls this — that is the whole
 * point of the module. `cells` is reported alongside because "150 cells" and
 * "150 valid trials" stop being the same number the moment a run samples or
 * errors, and a reader given only one of them cannot tell which.
 *
 * @param {Array<object>} results
 * @returns {{hits:number, valid:number, attempts:number, errors:number, cells:number, score:number}}
 */
export function aggregateScore(results) {
  const list = Array.isArray(results) ? results : [];
  let hits = 0, valid = 0, attempts = 0, errors = 0;
  for (const r of list) {
    const c = cellCounts(r);
    hits += c.hits;
    valid += c.valid;
    attempts += c.attempts;
    errors += c.errors;
  }
  return { hits, valid, attempts, errors, cells: list.length, score: scorePercent(hits, valid) };
}

/**
 * Convenience for the many per-slice surfaces (per engine, per region, per
 * tag, per topic) that want «hits/total + rate» for a filtered subset.
 * `total` is an alias of `valid` so an existing renderer that prints
 * `${hits}/${total}` keeps working and starts printing the honest pair.
 *
 * @param {Array<object>} results
 * @returns {{hits:number, total:number, valid:number, attempts:number, errors:number, rate:number}}
 */
export function sliceStats(results) {
  const agg = aggregateScore(results);
  return {
    hits: agg.hits,
    total: agg.valid,
    valid: agg.valid,
    attempts: agg.attempts,
    errors: agg.errors,
    rate: agg.score,
  };
}
