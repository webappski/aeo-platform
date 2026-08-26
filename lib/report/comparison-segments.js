// Cell-level segmentation between two runs of the same frozen basket.
//
// The report's headline components (Presence / Sentiment / Rank / Citation)
// aggregate away WHERE visibility moved. A client deciding where to spend the
// next quarter needs the opposite: which specific query x engine cells changed
// hands, and which were never held at all.
//
// The four segments below are deliberately NOT a severity ranking - they are
// four different problems with four different responses:
//   lost       - held it, then lost it. Recoverable, most urgent.
//   held       - still there. Protect.
//   gained     - newly there. Reinforce.
//   never      - never appeared in either run. NOT a decline: ground never
//                taken. Collapsing this into "lost" (or into an undifferentiated
//                grey) is the single easiest way to make a comparison report
//                lie, because "never present" is usually the largest bucket.

/**
 * Mention values that count as the brand actually appearing in the answer.
 * "src" means the brand surfaced only as a cited source rather than in prose -
 * still a real appearance, so it is counted alongside "yes" exactly as the
 * engine-level visibility percentages in the snapshot report do.
 * @type {ReadonlySet<string>}
 */
export const PRESENT_MENTIONS = new Set(['yes', 'src']);

/** @type {string} Segment key: present before, absent now. */
export const SEG_LOST = 'lost';
/** @type {string} Segment key: present in both runs. */
export const SEG_HELD = 'held';
/** @type {string} Segment key: absent before, present now. */
export const SEG_GAINED = 'gained';
/** @type {string} Segment key: absent in both runs. */
export const SEG_NEVER = 'never';
/**
 * @type {string} Segment key: at least one side errored or is missing, so the
 * cell cannot honestly be called a gain or a loss.
 */
export const SEG_INDETERMINATE = 'indeterminate';

/**
 * True when a result row represents the brand appearing in that answer.
 * @param {{mention?: string}|null|undefined} row
 * @returns {boolean}
 */
export function isPresent(row) {
  return !!row && PRESENT_MENTIONS.has(row.mention);
}

/**
 * True when a row carries no usable verdict - an API error, or no row at all.
 *
 * This guard exists because of a real incident: a run whose secondary extractor
 * was broken produced six "error" cells. Treated naively those read as six
 * fresh losses and would have reported a collapse that never happened. An
 * unusable cell must be excluded from the diff, not silently counted as absent.
 *
 * @param {{mention?: string}|null|undefined} row
 * @returns {boolean}
 */
export function isIndeterminate(row) {
  return !row || row.mention === 'error' || row.mention === 'missing';
}

/**
 * Stable identity for one measurement cell within a run.
 * Model is deliberately excluded: providers hot-swap model versions between
 * runs, and keying on model would report every such swap as a lost cell.
 * @param {{query?: string, provider?: string}} row
 * @returns {string}
 */
export function cellKey(row) {
  return `${row?.query || ''}::${row?.provider || ''}`;
}

/**
 * Split every cell of a run pair into the four decision segments (plus an
 * indeterminate bucket for cells that errored on either side).
 *
 * @param {{results?: Array<Object>}} latest  Newest run summary.
 * @param {{results?: Array<Object>}} prev    Immediately preceding run summary.
 * @returns {{lost: Array<Object>, held: Array<Object>, gained: Array<Object>,
 *            never: Array<Object>, indeterminate: Array<Object>}}
 *   Each entry is `{key, query, queryText, provider, label, before, after}`
 *   where `before`/`after` are the raw result rows (null when absent).
 */
export function segmentCells(latest, prev) {
  const prevRows = indexRows(prev);
  const latestRows = indexRows(latest);
  const segments = {
    [SEG_LOST]: [], [SEG_HELD]: [], [SEG_GAINED]: [],
    [SEG_NEVER]: [], [SEG_INDETERMINATE]: [],
  };

  for (const key of orderedKeys(latest, prev)) {
    const before = prevRows.get(key) || null;
    const after = latestRows.get(key) || null;
    const entry = {
      key,
      query: after?.query || before?.query || '',
      queryText: after?.queryText || before?.queryText || '',
      provider: after?.provider || before?.provider || '',
      label: after?.label || before?.label || after?.provider || before?.provider || '',
      before,
      after,
    };
    segments[classifyCell(before, after)].push(entry);
  }
  return segments;
}

/**
 * Decide which segment a single cell belongs to.
 * @param {Object|null} before
 * @param {Object|null} after
 * @returns {string} One of the SEG_* constants.
 */
function classifyCell(before, after) {
  if (isIndeterminate(before) || isIndeterminate(after)) return SEG_INDETERMINATE;
  const was = isPresent(before);
  const is = isPresent(after);
  if (was && is) return SEG_HELD;
  if (was) return SEG_LOST;
  if (is) return SEG_GAINED;
  return SEG_NEVER;
}

/**
 * Map of cellKey -> result row for one snapshot.
 * @param {{results?: Array<Object>}|null|undefined} snapshot
 * @returns {Map<string, Object>}
 */
function indexRows(snapshot) {
  const map = new Map();
  for (const row of snapshot?.results || []) map.set(cellKey(row), row);
  return map;
}

/**
 * Union of cell keys across both runs, in the latest run's own order so the
 * rendered grid follows the report's existing query order rather than a
 * hash-map ordering that would shuffle between runs.
 * @param {{results?: Array<Object>}|null|undefined} latest
 * @param {{results?: Array<Object>}|null|undefined} prev
 * @returns {Array<string>}
 */
function orderedKeys(latest, prev) {
  const keys = [];
  const seen = new Set();
  for (const row of [...(latest?.results || []), ...(prev?.results || [])]) {
    const key = cellKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Queries with zero brand mentions across every engine in BOTH runs, together
 * with the competitors that do occupy those answers.
 *
 * These are strategically distinct from a decline: the brand is not losing
 * this ground, it has never been on it. Surfacing them separately is what lets
 * a reader tell "win it back" apart from "decide whether to compete at all".
 *
 * @param {{results?: Array<Object>}} latest
 * @param {{results?: Array<Object>}} prev
 * @param {number} [occupantLimit] Max competitor names returned per query.
 * @returns {Array<{query: string, queryText: string, cellsPerRun: number,
 *                  occupiedBy: Array<string>}>}
 */
export function findBlankQueries(latest, prev, occupantLimit = 8) {
  const byQuery = new Map();
  for (const row of latest?.results || []) {
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push(row);
  }

  const blanks = [];
  for (const [query, rows] of byQuery) {
    const prevRows = (prev?.results || []).filter((r) => r.query === query);
    const anyMention = [...rows, ...prevRows].some(isPresent);
    if (anyMention || prevRows.length === 0) continue;
    blanks.push({
      query,
      queryText: rows[0]?.queryText || '',
      cellsPerRun: rows.length,
      occupiedBy: rankOccupants(rows, occupantLimit),
    });
  }
  return blanks;
}

/**
 * Competitor names occupying a set of answers, most frequent first.
 * Only dual-model verified competitors are used - unverified extractions are
 * one model's unconfirmed reading and must never be shown to a client as fact.
 * @param {Array<Object>} rows
 * @param {number} limit
 * @returns {Array<string>}
 */
function rankOccupants(rows, limit) {
  const counts = new Map();
  for (const row of rows) {
    for (const raw of row.competitors || []) {
      const name = typeof raw === 'string' ? raw : raw?.name;
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}
