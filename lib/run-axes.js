/**
 * AP-DIFF-ENGINE-MIX-AXIS — the second axis along which two runs can stop being
 * comparable.
 *
 * D4 (2026-09-16) closed the BASKET axis: a headline computed over a different
 * set of questions is not a number you may subtract from, so `lib/diff.js`
 * withholds `scoreDelta` and publishes an intersection delta instead.
 *
 * The very next run exposed the same defect one axis over. 2026-08-31 measured
 * three engines (openai, gemini, anthropic — 150 cells); 2026-09-16 measured
 * two (100 cells), because the Claude leg was not run. The baskets were
 * identical, so the basket gate stayed shut and the headline delta shipped as
 * fact: «11% ▼ −2pp vs 2026-08-31». Both percentages are honest over their own
 * denominators and their difference is not: over the 100 cells the two runs
 * share, the score was 11 against 11 — no movement at all.
 *
 * So the engine set is an axis of comparability exactly like the basket, and it
 * lives here rather than inside `diff.js` because TWO surfaces subtract these
 * numbers: the diff, and the report's own hero/key-metrics header, which never
 * went through the diff at all and did its own `latest.score - prev.score`.
 *
 * Pure functions over two `_summary.json` objects — no I/O, no manifest needed.
 */

import { isMeasuredMention } from './score.js';

/**
 * The engines a run actually MEASURED. A provider that appears only as errored
 * or unasked cells did not contribute to that run's headline and must not make
 * the two runs look like they covered different ground when they did.
 *
 * @param {{results?: Array<{provider?: string, mention?: string}>}} summary
 * @returns {Set<string>}
 */
export function measuredEngines(summary) {
  const set = new Set();
  for (const r of (summary?.results || [])) {
    if (!r || !r.provider) continue;
    if (!isMeasuredMention(r.mention)) continue;
    set.add(r.provider);
  }
  return set;
}

/**
 * How the measured engine set moved between two runs.
 *
 * @param {Object} summaryA earlier run
 * @param {Object} summaryB later run
 * @returns {{changed: boolean, common: string[], onlyInNew: string[],
 *            onlyInBaseline: string[], countBaseline: number, countNew: number}}
 */
export function engineSetDelta(summaryA, summaryB) {
  const a = measuredEngines(summaryA);
  const b = measuredEngines(summaryB);
  const common = [...b].filter((p) => a.has(p)).sort();
  const onlyInNew = [...b].filter((p) => !a.has(p)).sort();
  const onlyInBaseline = [...a].filter((p) => !b.has(p)).sort();
  return {
    changed: onlyInNew.length > 0 || onlyInBaseline.length > 0,
    common,
    onlyInNew,
    onlyInBaseline,
    countBaseline: a.size,
    countNew: b.size,
  };
}

/**
 * May the two runs' headline figures be subtracted from one another?
 *
 * ONE answer for every surface that prints a «vs <date>» delta, so the report
 * header and the diff can never disagree about whether a movement is real.
 * `basketChanged` is passed in because the two callers know it by different
 * means (the diff resolves question identity through the manifest; the report
 * header has only the snapshots), but the verdict is assembled here.
 *
 * @param {Object} summaryA earlier run
 * @param {Object} summaryB later run
 * @param {{basketChanged?: boolean}} [opts]
 * @returns {{comparable: boolean, reason: string|null, reasons: string[],
 *            engines: ReturnType<typeof engineSetDelta>, note: string|null}}
 */
export function headlineComparability(summaryA, summaryB, opts = {}) {
  const engines = engineSetDelta(summaryA, summaryB);
  const reasons = [];
  if (opts.basketChanged) reasons.push('basket-changed');
  if (engines.changed) reasons.push('engines-changed');

  return {
    comparable: reasons.length === 0,
    // Single-reason string for the existing `scoreDeltaReason` contract; when
    // both axes moved the first is 'basket-changed', unchanged for consumers
    // that only ever knew that value.
    reason: reasons[0] || null,
    reasons,
    engines,
    note: engines.changed ? engineChangeNote(engines) : null,
  };
}

/**
 * The sentence a reader needs next to a withheld delta: which engines differ,
 * and why that makes the two headlines incomparable rather than merely noisy.
 *
 * @param {ReturnType<typeof engineSetDelta>} engines
 * @returns {string}
 */
export function engineChangeNote(engines) {
  const parts = [];
  if (engines.onlyInBaseline.length > 0) {
    parts.push(`${engines.onlyInBaseline.join(', ')} ${engines.onlyInBaseline.length === 1 ? 'was' : 'were'} measured in the earlier run and not in this one`);
  }
  if (engines.onlyInNew.length > 0) {
    parts.push(`${engines.onlyInNew.join(', ')} ${engines.onlyInNew.length === 1 ? 'is' : 'are'} new to this run`);
  }
  return `${parts.join(', and ')} — the two headline percentages are computed over different engine sets, `
    + `so their difference is not a change in visibility. Compare over the ${engines.common.length} engine${engines.common.length === 1 ? '' : 's'} `
    + `both runs measured (${engines.common.join(', ') || 'none'}) instead.`;
}
