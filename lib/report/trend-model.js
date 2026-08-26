// Trend + significance model for the loud report register.
//
// One place decides three questions the whole report keeps asking:
//   1. Is this movement worth colouring?      -> clearsFloor()
//   2. Is it worth NAMING as the mover?       -> isMover()
//   3. How much history do we have the right
//      to draw at all?                        -> trendCapabilities()
//
// The separation in 1-vs-2 is deliberate and load-bearing. A delta that clears
// the floor gets a coloured chip (the reader can see a number moved); only a
// delta that ALSO beats the metric's own typical run-to-run step gets named in
// the "Where to act" line (the reader is told where to spend money). On a noisy
// metric those are different questions, and collapsing them either paints every
// wobble red or refuses to colour a real drop.

/**
 * Absolute movement below which a delta is not coloured.
 * Keyed by unit, because "3" means nothing until you know 3 of what.
 *   points - a 0-100 axis (index, presence %, coverage %)
 *   count  - whole things (answers, competitors, citations, hosts)
 *   rank   - ordinal position in an answer (#1, #2 …)
 * @type {Readonly<Record<string, number>>}
 */
export const FLOOR = Object.freeze({ points: 3.0, count: 1, rank: 0.5 });

/** @type {number} Runs required before the noise test is allowed to run at all. */
export const NOISE_TEST_MIN_RUNS = 5;

/** @type {number} Runs required before any trend WORD ("falling", "climbing") is allowed. */
export const TREND_LANGUAGE_MIN_RUNS = 3;

/**
 * @type {number} Runs required before a section may NAME something to act on,
 * and before per-answer record marks are drawn. Below this the report states
 * what is true today; it does not describe a direction.
 */
export const SHAPES_MIN_RUNS = 3;

/**
 * Minimum share of this run's answers a conditional metric must be reported on
 * before its delta may be printed at all.
 *
 * Rank and Sentiment are averaged only over the answers that carry them. When
 * that population halves between runs, the average moves for reasons that have
 * nothing to do with visibility, and a delta computed across the two is a
 * statement about which answers happened to be classifiable — not about the
 * brand. Below the floor the report prints the coverage instead of a delta.
 * @type {number}
 */
export const MIN_COVERAGE_RATIO = 0.6;

/**
 * Maximum change in coverage (as a share of cells) that still permits a delta.
 * Guards the case both runs clear MIN_COVERAGE_RATIO but the population still
 * moved enough to explain the delta on its own (e.g. 100% -> 65%).
 * @type {number}
 */
export const MAX_COVERAGE_SHIFT = 0.25;

/**
 * The floor for one unit.
 * @param {string} unit One of 'points' | 'count' | 'rank'.
 * @returns {number}
 */
export function significanceFloor(unit) {
  return FLOOR[unit] ?? FLOOR.points;
}

/**
 * True when |delta| reaches the unit's floor.
 * @param {number|null|undefined} delta
 * @param {string} unit
 * @returns {boolean}
 */
export function clearsFloor(delta, unit) {
  if (delta == null || !Number.isFinite(delta)) return false;
  return Math.abs(delta) >= significanceFloor(unit);
}

/**
 * Median absolute run-to-run step of a value history — the metric's own
 * definition of "normal wobble".
 *
 * Non-numeric entries (a run where the metric was not reported) break the
 * chain rather than counting as a step: pretending an unmeasured run is a
 * change of `undefined` would poison the median.
 *
 * @param {Array<number|null|undefined>} history Ordered oldest -> newest.
 * @returns {number|null} null when fewer than two consecutive numeric points exist.
 */
export function medianStep(history) {
  const steps = [];
  const values = Array.isArray(history) ? history : [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    steps.push(Math.abs(b - a));
  }
  if (steps.length === 0) return null;
  steps.sort((x, y) => x - y);
  const mid = Math.floor(steps.length / 2);
  return steps.length % 2 === 1 ? steps[mid] : (steps[mid - 1] + steps[mid]) / 2;
}

/**
 * True when a delta is larger than this metric's typical step.
 *
 * Below NOISE_TEST_MIN_RUNS the test is not online and this returns true — we
 * do not have enough history to call anything noise, and silently failing the
 * test would suppress every mover on a young account.
 *
 * @param {number|null|undefined} delta
 * @param {Array<number|null|undefined>} history Ordered oldest -> newest, includes the current value.
 * @returns {boolean}
 */
export function beatsNoise(delta, history) {
  const values = Array.isArray(history) ? history : [];
  // Count MEASURED points, not array slots. A metric reported on only two of
  // eight runs has exactly one step on record, and that one step is the delta
  // being judged — it could never beat its own median, so the test would
  // silently veto every finding on a newly-added check.
  const measured = values.filter((v) => Number.isFinite(v)).length;
  if (measured < NOISE_TEST_MIN_RUNS) return true;
  const med = medianStep(values);
  if (med == null) return true;
  return Math.abs(delta ?? 0) > med;
}

/**
 * Units the noise test applies to.
 *
 * Continuous 0-100 axes only. On a COUNT the floor is already one whole unit
 * — the smallest change the metric can express — so a "must beat the typical
 * step" test would permanently veto the smallest meaningful movement on any
 * metric that typically moves by one. (Real case: answers naming the brand,
 * history 4,5,5,7,9,10,12,11 — median step exactly 1, so losing an answer
 * would never be reportable.) The floor alone decides for counts and ranks;
 * the design's own Visibility footnote states the same rule as
 * "count metrics: 1-unit floor, no noise test".
 * @type {ReadonlySet<string>}
 */
export const NOISE_TESTED_UNITS = new Set(['points']);

/**
 * Whether a metric may be NAMED as the section's mover: it must clear the
 * floor and, on a continuous axis, beat its own noise.
 * @param {number|null|undefined} delta
 * @param {string} unit
 * @param {Array<number|null|undefined>} history
 * @returns {boolean}
 */
export function isMover(delta, unit, history) {
  if (!clearsFloor(delta, unit)) return false;
  if (!NOISE_TESTED_UNITS.has(unit)) return true;
  return beatsNoise(delta, history);
}

/**
 * Chip tone for a delta.
 *   quiet - below the floor: the number is shown, uncoloured, with no claim
 *   good / bad - direction, respecting metrics where lower is better (rank)
 *   flat - exactly zero movement
 * @param {number|null|undefined} delta
 * @param {string} unit
 * @param {boolean} [higherIsBetter]
 * @returns {'quiet'|'good'|'bad'|'flat'}
 */
export function chipTone(delta, unit, higherIsBetter = true) {
  if (delta == null || !Number.isFinite(delta)) return 'quiet';
  if (delta === 0) return 'flat';
  if (!clearsFloor(delta, unit)) return 'quiet';
  const improving = higherIsBetter ? delta > 0 : delta < 0;
  return improving ? 'good' : 'bad';
}

/**
 * Human-readable delta: an arrow, the magnitude, and the unit suffix.
 * @param {number|null|undefined} delta
 * @param {string} [unitLabel] Appended after the number ('pp', 'answers', …).
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatDelta(delta, unitLabel = '', decimals = 0) {
  if (delta == null || !Number.isFinite(delta)) return '—';
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '–';
  const mag = Math.abs(delta);
  const num = decimals > 0 ? mag.toFixed(decimals) : String(Math.round(mag * 10) / 10);
  return `${arrow} ${num}${unitLabel ? ' ' + unitLabel : ''}`.trim();
}

/**
 * What the report is allowed to draw at a given run count.
 *
 * The ladder exists because every visual in the loud register implies a claim.
 * A sparkline through two points asserts a direction that two points cannot
 * support; a "since day 1" caption on run 2 restates the same delta twice.
 *
 * @param {number} runCount Total runs on record, including this one.
 * @returns {{runCount:number, chips:boolean, baselineCaption:boolean, shapes:boolean,
 *            whereToAct:boolean, trendLanguage:boolean, noiseTest:boolean,
 *            dotSize:number, dotGap:number, labelEvery:number, dotWindow:number|null}}
 */
export function trendCapabilities(runCount) {
  const n = Number.isFinite(runCount) ? runCount : 0;
  const base = {
    runCount: n,
    chips: n >= 2,
    baselineCaption: n >= SHAPES_MIN_RUNS,
    shapes: n >= SHAPES_MIN_RUNS,
    whereToAct: n >= SHAPES_MIN_RUNS,
    trendLanguage: n >= TREND_LANGUAGE_MIN_RUNS,
    noiseTest: n >= NOISE_TEST_MIN_RUNS,
    dotSize: 13,
    dotGap: 4,
    labelEvery: 1,
    dotWindow: null,
  };
  if (n >= 10 && n <= 16) return { ...base, dotSize: 9, dotGap: 4, labelEvery: 2 };
  // 17+: the strip stops being readable as individual runs. Window to the last
  // 16 behind a "+N" prefix and let the sentence underneath carry what the
  // window hides.
  if (n >= 17) return { ...base, dotSize: 9, dotGap: 4, labelEvery: 3, dotWindow: 16 };
  return base;
}

/**
 * Whether a conditional metric (one averaged only over the answers that carry
 * it) may print a delta rather than its coverage.
 *
 * @param {{n?: number, denominator?: number}|null|undefined} curr Current-run sample.
 * @param {{n?: number, denominator?: number}|null|undefined} prev Previous-run sample.
 * @returns {{allowed: boolean, reason: string|null, currRatio: number|null, prevRatio: number|null}}
 */
export function coverageAllowsDelta(curr, prev) {
  const ratio = (s) => {
    const d = Number(s?.denominator);
    const n = Number(s?.n);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(n)) return null;
    return n / d;
  };
  const currRatio = ratio(curr);
  const prevRatio = ratio(prev);
  if (currRatio == null || prevRatio == null) {
    return { allowed: false, reason: 'no-coverage-record', currRatio, prevRatio };
  }
  if (currRatio < MIN_COVERAGE_RATIO || prevRatio < MIN_COVERAGE_RATIO) {
    return { allowed: false, reason: 'below-floor', currRatio, prevRatio };
  }
  if (Math.abs(currRatio - prevRatio) > MAX_COVERAGE_SHIFT) {
    return { allowed: false, reason: 'coverage-shift', currRatio, prevRatio };
  }
  return { allowed: true, reason: null, currRatio, prevRatio };
}

/**
 * A run measured fewer answers than the basket asks for.
 *
 * The index normalises over the answers it measured, so a run that lost an
 * engine to an API failure can score higher than a complete one. Marking it is
 * the difference between "we scored 100" and "we scored 100 on three quarters
 * of the questions".
 *
 * @param {{results?: Array<Object>}} snapshot
 * @param {number} expectedCells
 * @returns {boolean}
 */
export function isPartialRun(snapshot, expectedCells) {
  const n = (snapshot?.results || []).length;
  return Number.isFinite(expectedCells) && expectedCells > 0 && n > 0 && n < expectedCells;
}

/**
 * The cell count a complete run of this basket should have: the largest cell
 * count seen across the record. Using the max rather than the latest run's own
 * count means a partial LATEST run is still recognised as partial.
 * @param {Array<{results?: Array<Object>}>} snapshots
 * @returns {number}
 */
export function expectedCellCount(snapshots) {
  return (snapshots || []).reduce((m, s) => Math.max(m, (s?.results || []).length), 0);
}

/**
 * Assemble one metric's full trend record.
 *
 * @param {Object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {string} spec.unit 'points' | 'count' | 'rank'
 * @param {Array<number|null>} spec.history Ordered oldest -> newest, current value last.
 * @param {number} [spec.weight] UVI axes only.
 * @param {boolean} [spec.higherIsBetter]
 * @param {string} [spec.unitLabel] Suffix shown on the chip ('pp', 'answers', …).
 * @returns {{id:string,label:string,unit:string,unitLabel:string,weight:number|null,
 *            history:Array<number|null>,current:number|null,prev:number|null,first:number|null,
 *            deltaPrev:number|null,deltaFirst:number|null,isSignificant:boolean,isMover:boolean,
 *            tone:string,chipText:string,higherIsBetter:boolean}}
 */
export function buildMetric({ id, label, unit, history, weight = null, higherIsBetter = true, unitLabel = '', unitLabelOne = null }) {
  const values = Array.isArray(history) ? history.slice() : [];
  const numeric = values.filter((v) => Number.isFinite(v));
  const current = Number.isFinite(values[values.length - 1]) ? values[values.length - 1] : null;
  // "prev" is the most recent EARLIER run that reported a value, not simply
  // values[len-2]: a metric skipped last run should compare against the last
  // run that actually measured it rather than reporting no movement at all.
  let prev = null;
  for (let i = values.length - 2; i >= 0; i--) {
    if (Number.isFinite(values[i])) { prev = values[i]; break; }
  }
  const first = numeric.length ? numeric[0] : null;
  const deltaPrev = current != null && prev != null ? round1(current - prev) : null;
  const deltaFirst = current != null && first != null ? round1(current - first) : null;
  const significant = clearsFloor(deltaPrev, unit);
  // "1 answers" is the kind of seam that makes generated copy read as
  // generated. A metric may declare its singular form; magnitude 1 uses it.
  const effectiveLabel = (unitLabelOne && Math.abs(deltaPrev ?? 0) === 1) ? unitLabelOne : unitLabel;
  return {
    id,
    label,
    unit,
    unitLabel: effectiveLabel,
    weight,
    history: values,
    current,
    prev,
    first,
    deltaPrev,
    deltaFirst,
    isSignificant: significant,
    isMover: isMover(deltaPrev, unit, values),
    tone: chipTone(deltaPrev, unit, higherIsBetter),
    chipText: formatDelta(deltaPrev, effectiveLabel),
    higherIsBetter,
  };
}

/**
 * The section's "Where to act" sentence: the largest qualifying mover, or the
 * explicit no-mover statement. Never returns an empty string — a silently
 * omitted callout reads as "nothing to say" when it means "nothing cleared the
 * bar", and those are different messages.
 *
 * @param {Array<Object>} metrics Built by buildMetric().
 * @param {string|null} prevDate
 * @returns {{text: string, metric: Object|null}}
 */
export function whereToAct(metrics, prevDate) {
  const since = prevDate ? ` since ${prevDate}` : '';
  const movers = (metrics || []).filter((m) => m && m.isMover && m.deltaPrev != null);
  if (movers.length === 0) {
    return {
      metric: null,
      text: `No metric moved far enough to act on${since} — everything measured stayed inside its usual run-to-run range.`,
    };
  }
  // Ranked in multiples of each metric's OWN floor, not by raw magnitude.
  // Raw magnitude compares 13 hosts against 1 answer against 9 percentage
  // points as if they were the same quantity, and the metric with the largest
  // natural scale always wins. Floor-multiples are the one unit-normalised
  // quantity this model defines.
  const floors = (m) => Math.abs(m.deltaPrev) / significanceFloor(m.unit);
  // Ties are broken by index weight (an axis the score is actually made of
  // outranks an incidental count), then alphabetically. Falling back to the
  // caller's array order would make the sentence depend on where a metric
  // happened to be listed.
  movers.sort((a, b) => (floors(b) - floors(a))
    || ((b.weight || 0) - (a.weight || 0))
    || String(a.label).localeCompare(String(b.label)));
  const top = movers[0];
  const signed = `${top.deltaPrev > 0 ? '+' : '−'}${Math.abs(top.deltaPrev)}${top.unitLabel ? ' ' + top.unitLabel : ''}`;
  return { metric: top, text: `Biggest mover${since}: ${top.label} ${signed}.` };
}

/**
 * @param {number} n
 * @returns {number} One decimal place, without float dust (8.299999 -> 8.3).
 */
export function round1(n) {
  return Math.round(n * 10) / 10;
}
