// The four weighted UVI axes, run by run — as DATA.
//
// WHY THIS FILE EXISTS
// ---------------------
// The HTML report renders these axes as a table with delta chips; the Mission
// Control payload ships the same axes to the customer portal, which renders
// them in four languages. Both need the same three answers per axis: what is
// its value, is it allowed to state a delta at all, and what is its history.
//
// That derivation used to live inside `html.js`'s render closure, tangled with
// the chip markup. A second caller could only have re-implemented it — the
// exact drift class `mc-metadata.js` already documents (an inlined copy of the
// index formula that diverged on four axes before it was caught). So the
// decision moved here, as pure data, and each surface renders it its own way.
//
// Pure function, no I/O.

import { computeComponents, computeUVIBreakdown } from './visibility-index.js';
import { buildMetric, coverageAllowsDelta, round1 } from './trend-model.js';

/**
 * Axis keys in the order the index defines them.
 * @type {ReadonlyArray<string>}
 */
export const AXIS_ORDER = Object.freeze(['presence', 'sentiment', 'rank', 'citation']);

/**
 * Per-axis value history across the whole record.
 *
 * A run whose components cannot be computed contributes `null` rather than a
 * zero: `buildMetric` treats null as "not measured this run" and skips it when
 * picking the previous value, where a zero would read as a real collapse.
 *
 * @param {Array<Object>} snapshots Chronological `_summary.json` objects.
 * @returns {Record<string, Array<number|null>>}
 */
export function axisHistories(snapshots) {
  const out = Object.fromEntries(AXIS_ORDER.map((k) => [k, []]));
  for (const snap of snapshots || []) {
    let comps = null;
    try { comps = computeComponents(snap); } catch { comps = null; }
    for (const k of AXIS_ORDER) {
      out[k].push(comps && Number.isFinite(comps[k]) ? comps[k] : null);
    }
  }
  return out;
}

/**
 * Build the axis model for the newest run in `snapshots`.
 *
 * `rows` is one entry per axis the index reports, in index order. `metrics`
 * carries ONLY the axes allowed to state a delta — that is what a "biggest
 * mover" line may rank, so an axis whose sample moved too much to compare
 * cannot win it. `shortCoverage` names the axes that printed coverage instead.
 *
 * @param {Array<Object>} snapshots Chronological `_summary.json` objects, oldest first.
 * @returns {{rows: Array<Object>, metrics: Array<Object>, shortCoverage: Array<string>}}
 */
export function buildAxisModel(snapshots) {
  const snaps = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  const latest = snaps.length ? snaps[snaps.length - 1] : null;
  const prevSnapshot = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const empty = { rows: [], metrics: [], shortCoverage: [] };
  if (!latest) return empty;

  let currBreak;
  try { currBreak = computeUVIBreakdown(computeComponents(latest)); }
  catch { return empty; }

  let prevBreak = null;
  if (prevSnapshot) {
    try { prevBreak = computeUVIBreakdown(computeComponents(prevSnapshot)); }
    catch { prevBreak = null; }
  }

  const histories = axisHistories(snaps);
  const prevByKey = new Map((prevBreak?.rows || []).map((r) => [r.key, r]));
  const shortCoverage = [];
  const metrics = [];

  const rows = (currBreak.rows || []).map((row) => {
    const prevRow = prevByKey.get(row.key) || null;
    // "Directly measured" is read off the breakdown's own sample basis, not
    // a hardcoded axis list — if the index definition changes which axes
    // are conditional, this follows it.
    const direct = row.sample?.basis === 'cells';
    const cover = direct ? { allowed: true, reason: null } : coverageAllowsDelta(row.sample, prevRow?.sample);
    const delta = cover.allowed && prevRow && Number.isFinite(row.value) && Number.isFinite(prevRow.value)
      ? round1(row.value - prevRow.value)
      : null;
    const label = row.label || row.key;
    if (!cover.allowed) shortCoverage.push(label);
    if (cover.allowed) {
      metrics.push(buildMetric({
        id: `axis-${row.key}`, label, unit: 'points',
        history: histories[row.key] || [], weight: row.weight, unitLabel: 'pp',
      }));
    }
    const sampleN = row.sample?.n ?? 0;
    const sampleDenominator = row.sample?.denominator ?? 0;
    const coverRatio = row.sample?.denominator
      ? (row.sample.n / row.sample.denominator) * 100
      : 0;
    return {
      key: row.key,
      label,
      weight: row.weight,
      // Re-normalised over the axes this run could measure. A renderer that
      // recomputed this would need the default weight table too, and would
      // silently disagree the day the index changes its weights.
      appliedWeight: Number.isFinite(row.appliedWeight) ? row.appliedWeight : null,
      contribution: Number.isFinite(row.contribution) ? row.contribution : null,
      present: row.value != null,
      value: Number.isFinite(row.value) ? row.value : null,
      delta,
      coverAllowed: cover.allowed,
      coverReason: cover.reason,
      sampleN,
      sampleDenominator,
      valueText: cover.allowed ? String(row.value) : `${sampleN} of ${sampleDenominator}`,
      // The bar shows the axis's own score out of 100 — or, on a row that
      // prints coverage instead of a delta, the share of answers the axis
      // was reported on. It is never the movement: a bar sized by delta
      // would make a small change on a heavy axis look like a small change.
      // The weight is printed as a number beside it rather than drawn,
      // because the weight is fixed and the score is not.
      fillPct: cover.allowed ? (Number.isFinite(row.value) ? row.value : 0) : coverRatio,
      muted: !cover.allowed,
      history: histories[row.key] || [],
    };
  });

  return { rows, metrics, shortCoverage };
}
