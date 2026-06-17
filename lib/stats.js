/**
 * Pure statistics helpers for sampled (multi-trial) AEO measurement.
 *
 * Zero dependencies (R4) — everything here is closed-form arithmetic on the
 * standard normal. Used by:
 *   - the run loop, to attach a confidence interval to a cell's presence rate
 *     when `--samples N>1` produced several trials;
 *   - the report, to render «3/5 · 95% CI [0.23, 0.88]» on the presence axis;
 *   - diff.js, to decide whether a presence change between two runs is a real
 *     signal or sampling noise (overlapping Wilson intervals → noise).
 *
 * Why Wilson, not Wald (normal-approximation `p ± z·√(p(1−p)/n)`):
 *   Wald collapses to a zero-width, out-of-range interval at the boundaries
 *   (`hits=0` → [0,0]; `hits=n` → [1,1]) and is badly miscalibrated for the
 *   small n we actually run (n≈5). Wilson is the standard small-sample binomial
 *   interval — never leaves [0,1], stays sensible at the boundaries, and is the
 *   interval the design + test-design audit fixed expected values against.
 */

// z for common two-sided confidence levels. We only ship the ones the CLI can
// reach; an unknown level falls back to 95% rather than throwing (never-fail —
// a bad config value must not crash a run).
const Z_BY_LEVEL = {
  0.80: 1.2815515655446004,
  0.90: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
};

export const DEFAULT_Z = Z_BY_LEVEL[0.95];
export const DEFAULT_CONFIDENCE = 0.95;

/**
 * Resolve a z-score from a confidence level (0–1). Unknown levels degrade to
 * the 95% z rather than throwing.
 * @param {number} level e.g. 0.95
 * @returns {number} two-sided z
 */
export function zForConfidence(level = DEFAULT_CONFIDENCE) {
  return Z_BY_LEVEL[level] ?? DEFAULT_Z;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 *   centre    = (p̂ + z²/2n) / (1 + z²/n)
 *   half-width= z·√( p̂(1−p̂)/n + z²/4n² ) / (1 + z²/n)
 *   [low, high] = centre ∓ half-width, clamped to [0,1]
 *
 * Boundary contract (verified against the design's reference values):
 *   wilson(0, 0) → { low: 0, high: 1, rate: 0 }   // no data → maximal ignorance
 *   wilson(5, 5) → high === 1, low ≈ 0.566        // unanimous yes, lower bound < 1
 *   wilson(0, 5) → low === 0, high ≈ 0.434         // unanimous no, upper bound > 0
 *
 * @param {number} hits successes (0 ≤ hits ≤ n)
 * @param {number} n     trials
 * @param {number} [z]   z-score (default: 95% two-sided)
 * @returns {{ low: number, high: number, rate: number, n: number, hits: number, z: number }}
 */
export function wilson(hits, n, z = DEFAULT_Z) {
  // n=0 → no information. The honest interval is the whole range [0,1]; the
  // point rate is reported as 0 (share-of-zero-cells convention, matches the
  // run loop's score=0 on an empty basket) but the CI says "we know nothing".
  if (!n || n <= 0) {
    return { low: 0, high: 1, rate: 0, n: 0, hits: 0, z };
  }
  const phat = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  const low = Math.max(0, centre - margin);
  const high = Math.min(1, centre + margin);
  return { low, high, rate: phat, n, hits, z };
}

/**
 * Build the persisted `presence` object for a cell from its trial outcomes.
 * `hits` = trials counted as a presence (caller decides what counts — for AEO
 * a 'yes' OR 'src' trial is a hit; 'error' trials are excluded from n upstream).
 *
 * The CI level is recorded alongside the interval so a future change of default
 * (e.g. 95% → 90%) is self-describing in the JSON, never an unlabelled number.
 *
 * @param {number} hits
 * @param {number} n
 * @param {number} [level] confidence level (default 0.95)
 * @returns {{ hits:number, n:number, rate:number, ci:{ low:number, high:number, level:number } }}
 */
export function presenceFromCounts(hits, n, level = DEFAULT_CONFIDENCE) {
  const z = zForConfidence(level);
  const w = wilson(hits, n, z);
  return {
    hits,
    n,
    rate: w.rate,
    ci: { low: w.low, high: w.high, level },
  };
}

/**
 * Two-proportion z-test (pooled) for "did presence change between two runs?".
 *
 * Returns the test statistic and a coarse `significant` flag at the given
 * level. This is the parametric companion to the CI-overlap heuristic in
 * `ciOverlap` — `classifyProportionChange` combines BOTH so a borderline call
 * isn't decided by a single fragile rule.
 *
 *   pooled p = (h1 + h2) / (n1 + n2)
 *   SE = √( p(1−p)(1/n1 + 1/n2) )
 *   z  = (p̂1 − p̂2) / SE
 *
 * Degenerate inputs (n=0 on either side, or SE=0 because pooled p is 0 or 1)
 * return z=0, significant=false — there is no measurable difference to test.
 *
 * @returns {{ z:number, significant:boolean, p1:number, p2:number }}
 */
export function twoProportionZ(hits1, n1, hits2, n2, level = DEFAULT_CONFIDENCE) {
  if (!n1 || !n2 || n1 <= 0 || n2 <= 0) {
    return { z: 0, significant: false, p1: 0, p2: 0 };
  }
  const p1 = hits1 / n1;
  const p2 = hits2 / n2;
  const pooled = (hits1 + hits2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) {
    // pooled p is exactly 0 or 1 → both runs unanimous in the same direction →
    // no difference to detect.
    return { z: 0, significant: false, p1, p2 };
  }
  const z = (p1 - p2) / se;
  const significant = Math.abs(z) > zForConfidence(level);
  return { z, significant, p1, p2 };
}

/**
 * Do two intervals overlap? Inclusive endpoints — touching intervals count as
 * overlapping (conservative: we err toward calling a change "noise").
 */
export function ciOverlap(a, b) {
  if (!a || !b) return false;
  return a.low <= b.high && b.low <= a.high;
}

/**
 * Classify a presence change between two sampled runs as `signal` or `noise`.
 *
 * Decision rule (conservative — designed to KILL false regressions, which is
 * the whole point of sampling; a single noisy flip must not trip exit-1):
 *   - if the two Wilson CIs OVERLAP → `noise` (the rates are statistically
 *     indistinguishable at this sample size), regardless of the z-test;
 *   - else → defer to the two-proportion z-test: significant → `signal`,
 *     otherwise → `noise`.
 *
 * Requiring BOTH a non-overlap AND a significant z keeps a borderline case
 * (e.g. 3/5 vs 2/5, n far too small) firmly in `noise` instead of letting one
 * rule alone fabricate a regression.
 *
 * @param {{hits:number,n:number}} a  earlier run's counts for the cell
 * @param {{hits:number,n:number}} b  later run's counts for the cell
 * @param {number} [level]
 * @returns {{ classification:'signal'|'noise', z:number, overlap:boolean,
 *             ciA:{low:number,high:number}, ciB:{low:number,high:number} }}
 */
export function classifyProportionChange(a, b, level = DEFAULT_CONFIDENCE) {
  const z = zForConfidence(level);
  const wa = wilson(a.hits, a.n, z);
  const wb = wilson(b.hits, b.n, z);
  const overlap = ciOverlap(wa, wb);
  const zt = twoProportionZ(a.hits, a.n, b.hits, b.n, level);
  const classification = (!overlap && zt.significant) ? 'signal' : 'noise';
  return {
    classification,
    z: zt.z,
    overlap,
    ciA: { low: wa.low, high: wa.high },
    ciB: { low: wb.low, high: wb.high },
  };
}
