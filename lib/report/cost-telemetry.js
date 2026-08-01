/**
 * Append a per-call cost entry to a snapshot and re-derive `sessionCostUsd` from
 * the WHOLE breakdown.
 *
 * ALWAYS use this instead of pushing to `costByModel` by hand. `report`'s
 * cache-fillers run concurrently inside one `Promise.all`, and a branch that
 * pushed its entry without re-deriving the total left `sessionCostUsd` stale.
 * Observed on the webappski 2026-07-31 report: `costByModel` summed to $0.0577
 * while `sessionCostUsd` said $0.0296, because the outreach-templates branch
 * pushed and only the recommendations branch recomputed — the cost line
 * under-reported by half.
 *
 * Push-then-derive is safe under that concurrency: each call is synchronous, so
 * whichever branch runs last observes every earlier push.
 *
 * @param {{costByModel?: Array<{costUsd?: number}>, sessionCostUsd?: number}} snapshot
 *   the snapshot being mutated (mutated in place, and returned for convenience)
 * @param {{costUsd?: number}|null|undefined} costInfo
 *   the entry to append; a falsy entry is a no-op (a provider call that reported
 *   no usage must not create an empty row or disturb the total)
 * @returns {object} the same snapshot
 */
export function addCostEntry(snapshot, costInfo) {
  if (!costInfo) return snapshot;
  if (!snapshot.costByModel) snapshot.costByModel = [];
  snapshot.costByModel.push(costInfo);
  snapshot.sessionCostUsd = sumCostUsd(snapshot.costByModel);
  return snapshot;
}

/**
 * Total a `costByModel` breakdown, rounded to the micro-dollar the rest of the
 * codebase stores. Entries with no `costUsd` (an untracked model — see
 * `lib/providers/pricing.js`) contribute 0 rather than NaN: an untracked call is
 * "cost not known", and poisoning the whole total with NaN would hide every
 * tracked cost alongside it.
 *
 * @param {Array<{costUsd?: number}>} entries
 * @returns {number}
 */
export function sumCostUsd(entries) {
  const total = (entries || []).reduce((sum, entry) => sum + (Number(entry?.costUsd) || 0), 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}
