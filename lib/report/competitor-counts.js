/**
 * Aggregate the per-cell LLM-extracted competitor lists into the two summary
 * fields every sink renders: `topCompetitors` (both extractor models agreed —
 * strong) and `unverifiedOnly` (only one model agreed, and the name was never
 * verified in ANY cell — weaker, shown with a dashed badge).
 *
 * Shared by the live `run` loop and `run-manual` so the two sinks can never
 * drift — the same reason `prose-rank.js` exposes a shared field-builder. Before
 * this existed, `run-manual` re-implemented only the verified half inline and
 * never produced `unverifiedOnly` at all, so merging a manual column into a day
 * left that tier describing whatever the live run had computed earlier.
 *
 * Pure function over the result rows: no I/O, no provider calls.
 *
 * @param {Array<{competitors?: string[], competitorsUnverified?: string[]}>} results
 * @param {{limit?: number}} [opts]  how many verified names to keep (default 8)
 * @returns {{
 *   verifiedCounts: Record<string, number>,
 *   classifiedCompetitors: Array<[string, number]>,
 *   topCompetitors: Array<{name: string, count: number}>,
 *   unverifiedOnly: Array<{name: string, count: number}>,
 * }}
 */
export function aggregateCompetitorCounts(results, { limit = 8 } = {}) {
  const verifiedCounts = {};
  const unverifiedCounts = {};
  for (const r of results || []) {
    for (const name of r.competitors || [])           verifiedCounts[name]   = (verifiedCounts[name]   || 0) + 1;
    for (const name of r.competitorsUnverified || []) unverifiedCounts[name] = (unverifiedCounts[name] || 0) + 1;
  }

  const classifiedCompetitors = Object.entries(verifiedCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const verifiedSet = new Set(Object.keys(verifiedCounts));
  const unverifiedOnly = Object.entries(unverifiedCounts)
    .filter(([name]) => !verifiedSet.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  return {
    verifiedCounts,
    classifiedCompetitors,
    topCompetitors: classifiedCompetitors.map(([name, count]) => ({ name, count })),
    unverifiedOnly,
  };
}
