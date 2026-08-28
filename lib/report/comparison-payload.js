/**
 * Run-over-run comparison, as the client-portal payload carries it.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * `run-comparison.js`, `answer-history.js`, `run-metrics.js` and
 * `trend-model.js` already decide everything the report says about movement.
 * Until now that decision only ever reached the HTML and markdown surfaces.
 * The customer portal renders the same run and was left re-deriving a much
 * poorer version of it (a score delta and nothing else), which meant our two
 * surfaces could — and did — disagree about whether anything moved.
 *
 * This module is the seam: it runs the existing derivation once and emits it
 * as DATA, so the portal renders the same findings without owning a second
 * copy of the arithmetic. `mc-metadata.js:309-323` records what the second
 * copy costs — an inlined index formula that drifted on four separate axes
 * before anyone noticed.
 *
 * TWO HARD RULES, both load-bearing:
 *
 * 1. NO PROSE. Every sentence the report writes in English is emitted here as
 *    a `kind` token plus the numbers behind it. The portal ships in four
 *    languages; an English sentence in the payload would either appear
 *    verbatim in a German report or force the portal to re-decide which branch
 *    applies — and re-deciding is the drift this module exists to prevent.
 *
 *    The one deliberate exception: `label` on a metric/axis and `unitLabel` on
 *    a metric carry the report's own English wording. They are a FALLBACK for
 *    internal surfaces, never the client-facing string. A localised renderer
 *    keys off the stable machine identifiers instead — `metrics[].id`
 *    (`index` | `presence` | `competitors` | `own-citations` | `hosts` |
 *    `capsules`), `axes[].key`, `metrics[].unit` (`points` | `count` | `rank`)
 *    and `answers[].record.kind` — and supplies its own words for each.
 *
 * 2. STRICT ALLOW-LIST. `segmentCells` entries carry the WHOLE result row on
 *    `before`/`after` — including `responseExcerpt`, `costUsd`, `inputTokens`
 *    and `extractionSources`. Never spread a segment entry. Every field below
 *    is named one at a time, exactly as `mc-metadata.js` does.
 *
 * Pure function, no I/O.
 *
 * @module comparison-payload
 */

import { buildRunComparison } from './run-comparison.js';
import { buildAnswerHistory } from './answer-history.js';
import { buildRunMetrics, headlineMover } from './run-metrics.js';
import { trendCapabilities } from './trend-model.js';
import { buildAxisModel } from './axis-model.js';

/** @type {number} Payload shape version, independent of the tracker's own semver. */
export const COMPARISON_SCHEMA = 1;

/** Cap on the per-cell lists shipped for the "where you lost ground" table. */
const LOST_LIMIT = 60;
/** Cap on the "ground you've never held" list. */
const NEVER_HELD_LIMIT = 60;

/**
 * One metric, stripped to what a renderer needs.
 * @param {Object} m From `buildMetric()`.
 * @returns {Object}
 */
function metricOut(m) {
  return {
    id: m.id,
    label: m.label,
    unit: m.unit,
    unitLabel: m.unitLabel,
    weight: m.weight ?? null,
    higherIsBetter: !!m.higherIsBetter,
    current: numOrNull(m.current),
    prev: numOrNull(m.prev),
    first: numOrNull(m.first),
    deltaPrev: numOrNull(m.deltaPrev),
    deltaFirst: numOrNull(m.deltaFirst),
    tone: m.tone,
    isMover: !!m.isMover,
    isSignificant: !!m.isSignificant,
    history: (m.history || []).map(numOrNull),
  };
}

/**
 * @param {*} n
 * @returns {number|null}
 */
function numOrNull(n) {
  return Number.isFinite(n) ? n : null;
}

/**
 * Competitor names off a raw result row, verified entries only — the same
 * filter `comparison-segments.js` applies. An unverified extraction is one
 * model's unconfirmed reading and must never reach a client as fact.
 * @param {Object|null} row
 * @returns {Array<string>}
 */
function competitorNames(row) {
  return (row?.competitors || [])
    .map((c) => (typeof c === 'string' ? c : c?.name))
    .filter(Boolean);
}

/**
 * Build the comparison payload.
 *
 * Always returns an object, even on the first run: the portal needs to know
 * the run count and what it is therefore ALLOWED to claim (`capabilities`)
 * before it can decide to render nothing. Returning null on a first run would
 * leave the portal guessing, and guessing is how it started drawing arrows on
 * two data points.
 *
 * @param {Array<Object>} snapshots Chronological `_summary.json` objects, oldest first.
 * @param {{domain?: string}} [opts]
 * @returns {Object|null} Null only when there is no run at all.
 */
export function buildComparisonPayload(snapshots, opts = {}) {
  const snaps = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  if (snaps.length === 0) return null;

  const latest = snaps[snaps.length - 1];
  const domain = opts.domain || latest.domain || '';
  const runCount = snaps.length;

  // `buildRunMetrics` reads the same two fields off the HTML report's summary
  // object; passing a shim rather than the whole object keeps this module free
  // of the render layer's shape.
  const metricsModel = buildRunMetrics(
    { meta: { domain }, trend: snaps.map((s) => (Number.isFinite(s.score) ? s.score : null)) },
    snaps,
  );
  const axisModel = buildAxisModel(snaps);
  const history = buildAnswerHistory(snaps);
  const model = buildRunComparison(snaps);
  const prevDate = model ? model.prevDate : null;
  const mover = headlineMover(metricsModel, axisModel.metrics, prevDate);

  const caps = trendCapabilities(runCount);

  const out = {
    schema: COMPARISON_SCHEMA,
    runCount,
    expectedCells: history.expectedCells,
    runs: history.runs.map((r) => ({
      date: r.date,
      index: r.index,
      cells: r.cells,
      partial: !!r.partial,
      score: numOrNull(r.score),
    })),
    capabilities: {
      chips: caps.chips,
      baselineCaption: caps.baselineCaption,
      shapes: caps.shapes,
      whereToAct: caps.whereToAct,
      trendLanguage: caps.trendLanguage,
      noiseTest: caps.noiseTest,
      dotWindow: caps.dotWindow,
      labelEvery: caps.labelEvery,
    },
    metrics: metricsModel.all.map(metricOut),
    axes: axisModel.rows.map((row) => ({
      key: row.key,
      label: row.label,
      weight: row.weight,
      appliedWeight: numOrNull(row.appliedWeight),
      contribution: numOrNull(row.contribution),
      present: !!row.present,
      value: numOrNull(row.value),
      delta: numOrNull(row.delta),
      coverAllowed: row.coverAllowed,
      coverReason: row.coverReason,
      sampleN: row.sampleN,
      sampleDenominator: row.sampleDenominator,
      history: (row.history || []).map(numOrNull),
    })),
    // The mover is decided HERE, not by the portal ranking `metrics` itself:
    // the ranking is in multiples of each metric's own significance floor, and
    // a renderer re-sorting by raw magnitude would name a different metric.
    headlineMover: mover.metric
      ? {
        id: mover.metric.id,
        label: mover.metric.label,
        deltaPrev: numOrNull(mover.metric.deltaPrev),
        unitLabel: mover.metric.unitLabel,
      }
      : null,
    engines: {
      now: { full: metricsModel.engines.now.full, total: metricsModel.engines.now.total },
      prev: {
        full: numOrNull(metricsModel.engines.prev.full),
        total: metricsModel.engines.prev.total,
      },
    },
    // Per-answer record: the states array is the whole history of that cell,
    // and `record` is the branch already decided for it. Join back to
    // `perCell` on queryId + provider — the question text and the competitor
    // names already ship there and are not repeated here.
    answers: history.cells.map((c) => ({
      queryId: c.query,
      provider: c.provider,
      states: c.states,
      verdict: c.verdict,
      record: c.recordFacts,
      textDrift: c.textDrift
        ? { runs: c.textDrift.runs, settledAt: c.textDrift.settledAt }
        : null,
    })),
    pair: null,
    uvi: null,
    weightBasis: null,
    counts: null,
    lost: null,
    gained: null,
    replacements: null,
    neverHeld: null,
    drivers: null,
    changed: null,
  };

  if (!model) return out;

  out.pair = { prevDate: model.prevDate, currDate: model.currDate };
  out.uvi = {
    prev: numOrNull(model.uvi.prev),
    curr: numOrNull(model.uvi.curr),
    delta: numOrNull(model.uvi.delta),
  };
  out.weightBasis = { changed: !!model.weightBasis.changed, axes: model.weightBasis.axes };
  out.counts = { ...model.counts };

  out.lost = model.segments.lost.slice(0, LOST_LIMIT).map((e) => ({
    queryId: e.query,
    provider: e.provider,
    isNoise: !!e.isNoise,
    // "Who appeared instead" — the names that were NOT in this answer on the
    // previous run. The full current list stays in `perCell.competitors`.
    newEntrants: e.competitorShift?.newEntrants || [],
    was: e.before?.mention ?? null,
    now: e.after?.mention ?? null,
  }));
  out.gained = model.segments.gained.slice(0, LOST_LIMIT).map((e) => ({
    queryId: e.query,
    provider: e.provider,
    isNoise: !!e.isNoise,
    was: e.before?.mention ?? null,
    now: e.after?.mention ?? null,
  }));
  out.replacements = model.replacements.map((r) => ({ name: r.name, count: r.count }));
  out.neverHeld = model.blankQueries.slice(0, NEVER_HELD_LIMIT).map((b) => ({
    queryId: b.query,
    cellsPerRun: b.cellsPerRun,
    occupiedBy: b.occupiedBy,
  }));

  out.drivers = {
    hasGenuineConditionalChange: !!model.driverSummary.hasGenuineConditionalChange,
    allMovementIsCompositional: !!model.driverSummary.allMovementIsCompositional,
    gainPenalisedComponents: model.driverSummary.gainPenalisedComponents,
    components: model.components.map((comp) => ({
      key: comp.key,
      label: comp.label,
      kind: comp.kind,
      prevValue: numOrNull(comp.prevValue),
      currValue: numOrNull(comp.currValue),
      contributionDelta: numOrNull(comp.contributionDelta),
      likeForLike: comp.decomposition?.likeForLike
        ? {
          prev: numOrNull(comp.decomposition.likeForLike.prev),
          curr: numOrNull(comp.decomposition.likeForLike.curr),
          delta: numOrNull(comp.decomposition.likeForLike.delta),
          cellCount: comp.decomposition.likeForLike.cellCount,
        }
        : null,
      compositionalDelta: comp.decomposition ? numOrNull(comp.decomposition.compositionalDelta) : null,
      isPurelyCompositional: comp.decomposition ? !!comp.decomposition.isPurelyCompositional : null,
      // Only the COUNT: a gain-drag entry is a whole result row.
      gainDragCount: comp.decomposition ? (comp.decomposition.gainDrag || []).length : 0,
    })),
  };

  // "What changed" — every cell that flipped, in the report's own order.
  // Cells covered by only one of the two runs are excluded upstream by
  // `segmentCells`'s indeterminate bucket, so this table never implies a
  // config change was a visibility change.
  out.changed = [
    ...model.segments.gained.map((e) => ({ dir: 'gained', entry: e })),
    ...model.segments.lost.map((e) => ({ dir: 'lost', entry: e })),
  ].map(({ dir, entry }) => ({
    queryId: entry.query,
    provider: entry.provider,
    direction: dir,
    was: entry.before?.mention ?? null,
    now: entry.after?.mention ?? null,
  }));

  return out;
}
