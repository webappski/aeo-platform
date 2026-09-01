// Orchestrator for the Run Comparison feature — builds the full comparison
// model that the HTML and markdown sections render.
//
// WHY THIS FILE EXISTS
// ---------------------
// `comparison-segments.js` classifies cells and `comparison-drivers.js`
// decomposes an axis's movement. Neither knows about the report's actual data
// shapes end to end: which snapshot pair to compare, how to turn a raw result
// row into a per-axis numeric value, when the UVI weight basis shifted between
// runs, or which competitors filled the space a lost cell left behind. This
// module is the seam that wires the two pure primitives to `_summary.json`.
//
// Pure function, no I/O — safe to unit-test with inline fixtures and safe to
// call from both `sections.js` (markdown) and `html.js` (HTML) without either
// renderer re-deriving the model differently.

import {
  computeComponents, computeUVIBreakdown, usableProseRank,
  SENTIMENT_VALUE, isSignalBearingSentiment,
} from './visibility-index.js';
import { segmentCells, findBlankQueries } from './comparison-segments.js';
import {
  decomposeConditional, summarizeDrivers, KIND_DIRECT, KIND_CONDITIONAL,
} from './comparison-drivers.js';
import { buildModelChanges } from './model-change.js';
import { classifyProportionChange } from '../stats.js';

/** @type {string[]} UVI axis keys, in the order `computeUVIBreakdown` returns rows. */
const AXES = ['presence', 'sentiment', 'rank', 'citation'];

/**
 * Build the full run-over-run comparison model for the two newest entries in
 * `snapshots`.
 *
 * The pair is always the LAST TWO elements of the array as given, never a
 * lookup against the newest run on disk. `--for-date` truncates `snapshots`
 * in place before this is called (`bin/aeo-tracker.js`), so a rendered
 * historical report and today's report both get the pair relative to the run
 * actually being rendered.
 *
 * @param {Object[]} snapshots  Chronological `_summary.json` objects, oldest first.
 * @returns {Object|null} Comparison model, or `null` when fewer than two runs
 *   exist — the caller renders the house "first run" placeholder in that case
 *   (same convention as `sectionDiff`), not this module.
 */
export function buildRunComparison(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return null;
  const prev = snapshots[snapshots.length - 2];
  const latest = snapshots[snapshots.length - 1];

  const prevBreakdown = computeUVIBreakdown(computeComponents(prev));
  const currBreakdown = computeUVIBreakdown(computeComponents(latest));
  const weightBasis = weightBasisNote(prevBreakdown, currBreakdown);

  const rawSegments = segmentCells(latest, prev);
  // Which engines changed instrument between the two runs. Computed BEFORE the
  // segments are annotated, because every lost/gained cell needs to know whether
  // it was measured on a swapped engine — a caveat that only appears at the
  // bottom of the section, while the table above it names competitors for cells
  // the two runs never measured the same way, is not a fix.
  const modelChanges = buildModelChanges(prev, latest);
  const segments = annotateSegments(rawSegments, modelChanges);
  const components = buildComponentSummaries(rawSegments, prevBreakdown, currBreakdown, weightBasis);

  return {
    prevDate: prev?.date || null,
    currDate: latest?.date || null,
    uvi: {
      prev: prevBreakdown.uvi,
      curr: currBreakdown.uvi,
      delta: currBreakdown.uvi - prevBreakdown.uvi,
    },
    weightBasis,
    modelChanges,
    segments,
    // Faithful mirror of segment sizes — a client-facing headline must never
    // disagree with the detail table below it. Noise-suppressed cells stay
    // counted here; `noiseSuppressed` is reported alongside so a renderer can
    // choose to caveat or exclude them, but the orchestrator does not silently
    // pick a smaller number on its own.
    counts: {
      lost: segments.lost.length,
      held: segments.held.length,
      gained: segments.gained.length,
      never: segments.never.length,
      indeterminate: segments.indeterminate.length,
      noiseSuppressed: segments.lost.filter((e) => e.isNoise).length
        + segments.gained.filter((e) => e.isNoise).length,
      // The number that decides whether an engine swap is a footnote or the
      // story: how much of what moved sits on an engine that was not the same
      // instrument in both runs. On the 2026-09-01 TypelessForm pair this was 3
      // of 5 lost cells.
      lostOnChangedEngine: segments.lost.filter((e) => e.engineChanged).length,
      gainedOnChangedEngine: segments.gained.filter((e) => e.engineChanged).length,
    },
    components,
    driverSummary: summarizeDrivers(components, modelChanges),
    replacements: aggregateReplacements(segments.lost),
    blankQueries: findBlankQueries(latest, prev),
  };
}

/**
 * Per-cell sentiment value, valued and gated by `visibility-index.js` itself —
 * the module that owns the axis. Both the table and the gate are imported
 * rather than restated: a model-disagreement tie-break (`confidence:'low'`,
 * `label:'neutral'`) that this module averaged into `likeForLike` as a real 50,
 * while the reported `prevValue`/`currValue` (from `computeComponents`)
 * excluded it, would flip `likeForLike.delta` off zero and fabricate a tone
 * finding — the exact failure this module exists to prevent.
 *
 * The unknown-label fallback is `null`, NOT the index's `?? 50`: this module
 * averages only cells it can value, where the index averages over a population
 * it has already filtered. Those are different questions, so the two keep
 * different fallbacks on purpose.
 *
 * @param {Object} row
 * @returns {number|null}
 */
function sentimentValueOf(row) {
  const s = row?.sentiment;
  if (!isSignalBearingSentiment(s)) return null;
  return SENTIMENT_VALUE[s.label] ?? null;
}

/**
 * Per-cell rank value: explicit list position when present, else a usable
 * prose ordinal. Lower is better (list #2 beats #11), so callers must pass
 * `lowerIsBetter: true`.
 * @param {Object} row
 * @returns {number|null}
 */
function rankValueOf(row) {
  if (typeof row?.position === 'number' && row.position > 0) return row.position;
  if (usableProseRank(row?.proseRank)) return row.proseRank.rank;
  return null;
}

const AXIS_VALUE_OF = { sentiment: sentimentValueOf, rank: rankValueOf };
const AXIS_LOWER_IS_BETTER = { rank: true };

/**
 * Build the four per-axis summaries `summarizeDrivers` and the render layer
 * consume. Direct vs conditional is read off `sample.basis` ('cells' = direct)
 * rather than hardcoded, so a future axis is classified correctly without
 * editing this file.
 * @param {Object} rawSegments   Output of `segmentCells` (unannotated is fine —
 *   `decomposeConditional` only reads `before`/`after`).
 * @param {Object} prevBreakdown `computeUVIBreakdown()` for the earlier run.
 * @param {Object} currBreakdown `computeUVIBreakdown()` for the later run.
 * @param {{changed: boolean}} weightBasis
 * @returns {Array<Object>}
 */
function buildComponentSummaries(rawSegments, prevBreakdown, currBreakdown, weightBasis) {
  return AXES.map((key) => {
    const prevRow = prevBreakdown.rows.find((r) => r.key === key);
    const currRow = currBreakdown.rows.find((r) => r.key === key);
    const kind = currRow.sample.basis === 'cells' ? KIND_DIRECT : KIND_CONDITIONAL;
    const base = {
      key,
      label: currRow.label,
      kind,
      prevValue: prevRow.value,
      currValue: currRow.value,
      // AP-WEIGHT-BASIS: `contribution = value * appliedWeight`, and
      // `appliedWeight` is re-normalised per run. When the measured axis set
      // differs between runs, EVERY axis's appliedWeight differs too, not just
      // the one that changed — so a contribution delta computed across the
      // shift is not attributable to real movement. Null it out rather than
      // report a polluted number; `weightBasis` on the returned model carries
      // the caveat text for the renderer instead.
      contributionDelta: weightBasis.changed
        ? null
        : contributionDelta(prevRow, currRow),
    };
    if (kind !== KIND_CONDITIONAL) return base;
    return {
      ...base,
      decomposition: decomposeConditional({
        segments: rawSegments,
        valueOf: AXIS_VALUE_OF[key],
        prevValue: prevRow.value,
        currValue: currRow.value,
        lowerIsBetter: !!AXIS_LOWER_IS_BETTER[key],
      }),
    };
  });
}

function contributionDelta(prevRow, currRow) {
  const prev = prevRow.contribution;
  const curr = currRow.contribution;
  if (typeof prev !== 'number' || typeof curr !== 'number') return null;
  return Math.round((curr - prev) * 100) / 100;
}

/**
 * Detect whether the set of measured axes differs between the two runs —
 * i.e. whether re-normalisation put the UVI on a different weight basis in
 * one of the two runs. `computeUVIBreakdown().excluded` lists axes with no
 * underlying data that run.
 * @param {Object} prevBreakdown
 * @param {Object} currBreakdown
 * @returns {{changed: boolean, axes: string[]}}
 */
function weightBasisNote(prevBreakdown, currBreakdown) {
  const prevExcluded = new Set(prevBreakdown.excluded);
  const currExcluded = new Set(currBreakdown.excluded);
  const axes = AXES.filter((key) => prevExcluded.has(key) !== currExcluded.has(key));
  return { changed: axes.length > 0, axes };
}

/**
 * Add `isNoise` + `engineChanged` (lost + gained) and `competitorShift` (lost
 * only) to segment entries without mutating `segmentCells`'s output.
 *
 * `engineChanged` marks a cell whose engine was measured on a different model in
 * the two runs, so a renderer can qualify THAT ROW rather than appending a
 * general note underneath the table. Only kinds that can plausibly explain
 * movement count (see `EXPLANATORY` in model-change.js): a dated-snapshot pin
 * would otherwise flag every OpenAI cell forever and the mark would stop meaning
 * anything.
 *
 * @param {Object} segments
 * @param {{explanatoryProviders: string[]}} modelChanges
 * @returns {Object}
 */
function annotateSegments(segments, modelChanges) {
  const swapped = new Set(modelChanges?.explanatoryProviders || []);
  const mark = (entry) => ({
    ...entry,
    isNoise: isNoiseChange(entry.before, entry.after),
    engineChanged: swapped.has(entry.provider),
  });
  return {
    ...segments,
    lost: segments.lost.map((entry) => ({
      ...mark(entry),
      competitorShift: competitorSubstitution(entry.before, entry.after),
    })),
    gained: segments.gained.map(mark),
  };
}

/**
 * True when a mention flip between two SAMPLED cells (`--samples N>1`) is
 * statistically indistinguishable from no change — same Wilson-CI test
 * `lib/diff.js` uses, so a noisy trial flip isn't reported as a real loss or
 * gain. Single-shot cells (the default; no `presence` field) always return
 * false here — there is no distribution to test, so the mention flip stands.
 * @param {Object|null} before
 * @param {Object|null} after
 * @returns {boolean}
 */
function isNoiseChange(before, after) {
  if (!hasSampledPresence(before) || !hasSampledPresence(after)) return false;
  const verdict = classifyProportionChange(
    { hits: before.presence.hits, n: before.presence.n },
    { hits: after.presence.hits, n: after.presence.n },
  );
  return verdict.classification === 'noise';
}

function hasSampledPresence(row) {
  return !!(row && row.presence && typeof row.presence.n === 'number' && row.presence.n > 0);
}

/**
 * Which verified competitors filled (or left) a lost cell's answer. Only
 * dual-model-verified names — same rule `findBlankQueries` uses — so a
 * client is never shown a single model's unconfirmed guess as fact.
 * @param {Object|null} before
 * @param {Object|null} after
 * @returns {{newEntrants: string[], droppedOut: string[]}}
 */
function competitorSubstitution(before, after) {
  const wasSet = new Set(before?.competitors || []);
  const isSet = new Set(after?.competitors || []);
  return {
    newEntrants: [...isSet].filter((name) => !wasSet.has(name)),
    droppedOut: [...wasSet].filter((name) => !isSet.has(name)),
  };
}

/**
 * Roll up "who filled the space" across every lost cell, most frequent first
 * — the single list a client needs to answer "who is replacing us".
 * @param {Array<Object>} lostCells  Annotated `segments.lost` entries.
 * @param {number} [limit]
 * @returns {Array<{name: string, count: number}>}
 */
function aggregateReplacements(lostCells, limit = 8) {
  const counts = new Map();
  for (const entry of lostCells) {
    for (const name of entry.competitorShift?.newEntrants || []) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}
