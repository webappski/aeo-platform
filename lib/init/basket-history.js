/**
 * Basket versioning for `.aeo-tracker.json`.
 *
 * Concept:
 *   The "basket" is the set of queries currently configured for a project.
 *   When a user expands their basket (e.g. 3 → 6 queries via
 *   `aeo-platform init --queries-only --add-queries`), historical snapshots
 *   for the original Q1-Q3 still exist and their trends should remain
 *   continuous — but new queries Q4-Q6 start fresh.
 *
 *   To make this explicit, we tag the config with a basket version number
 *   that bumps on every change, and keep a history of every prior version.
 *   Reports can then segment trend lines per basket-era.
 *
 * Schema added to .aeo-tracker.json:
 *   {
 *     "basketVersion": 2,
 *     "basketHistory": [
 *       { "version": 1, "queries": ["q1","q2","q3"], "since": "2026-04-22", "kind": "initial" },
 *       { "version": 2, "queries": ["q1","q2","q3","q4","q5","q6"], "since": "2026-05-04", "kind": "additive" }
 *     ]
 *   }
 *
 * Backward compat:
 *   Configs without basketVersion are treated as v1 silently. The first save
 *   that touches basket logic will materialise basketVersion=1 +
 *   basketHistory[0] from existing queries.
 *
 * @module basket-history
 */

import { queryText } from '../config/queries-normalize.js';

/**
 * Read basket version + history from a parsed config object.
 * Always returns a non-null structure (synthesises v1 from current queries
 * if config has no basketVersion field — legacy migration on the fly).
 *
 * @param {Object} config         parsed .aeo-tracker.json
 * @param {string} [fallbackDate] ISO date for synthesised initial entry (e.g. earliest snapshot date or today)
 * @returns {{ version: number, history: Array<{version:number,queries:string[],since:string,kind:string}> }}
 */
export function readBasket(config, fallbackDate) {
  const queries = Array.isArray(config?.queries) ? config.queries.slice() : [];
  if (Array.isArray(config?.basketHistory) && config.basketHistory.length > 0) {
    return {
      version: Number(config.basketVersion) || config.basketHistory.length,
      history: config.basketHistory,
    };
  }
  // Legacy migration: synthesise v1 from current queries.
  return {
    version: 1,
    history: [{
      version: 1,
      queries,
      since: fallbackDate || todayIso(),
      kind: 'initial',
    }],
  };
}

/**
 * Append an additive expansion to the basket history. Returns the new basket
 * struct ready to splat into the saved config.
 *
 * Caller is responsible for merging existing queries with newly-suggested
 * queries (de-duplicated, order preserved). This module just records the
 * version bump.
 *
 * @param {Object} config             current parsed config
 * @param {string[]} mergedQueries    the FINAL query list after expansion
 * @param {string} [date]             ISO date of the expansion (default today)
 * @returns {{ basketVersion: number, basketHistory: Array<Object> }}
 */
export function recordExpansion(config, mergedQueries, date) {
  const since = date || todayIso();
  const prior = readBasket(config, since);
  const nextVersion = prior.version + 1;
  const newEntry = {
    version: nextVersion,
    queries: mergedQueries.slice(),
    since,
    kind: 'additive',
  };
  return {
    basketVersion: nextVersion,
    basketHistory: prior.history.concat([newEntry]),
  };
}

/**
 * Append a replacement (full basket fork). Same shape as recordExpansion but
 * marked as kind="replace" so report tooling can show a "trend forked" badge
 * instead of additive continuation.
 *
 * @param {Object} config
 * @param {string[]} newQueries
 * @param {string} [date]
 * @returns {{ basketVersion: number, basketHistory: Array<Object> }}
 */
export function recordReplacement(config, newQueries, date) {
  const since = date || todayIso();
  const prior = readBasket(config, since);
  const nextVersion = prior.version + 1;
  const newEntry = {
    version: nextVersion,
    queries: newQueries.slice(),
    since,
    kind: 'replace',
  };
  return {
    basketVersion: nextVersion,
    basketHistory: prior.history.concat([newEntry]),
  };
}

/**
 * Materialise a v1 entry for first-time init when no prior config existed.
 * Used by full `cmdInit` (not --queries-only) on a clean install.
 *
 * @param {string[]} initialQueries
 * @param {string} [date]
 * @returns {{ basketVersion: 1, basketHistory: [Object] }}
 */
export function initialBasket(initialQueries, date) {
  return {
    basketVersion: 1,
    basketHistory: [{
      version: 1,
      queries: initialQueries.slice(),
      since: date || todayIso(),
      kind: 'initial',
    }],
  };
}

/**
 * Merge two query lists preserving order: existing first, then new ones not
 * already in existing. Case-insensitive de-duplication.
 *
 * Entries may be bare strings OR `{q, brandFit, tag?}` objects (object form is
 * AP-SEGMENT-LIVE — the brand-fit label persisted onto the active basket). The
 * dedup key is always the query TEXT (via queryText), so a string and an object
 * with the same `q` collapse to one entry, and — critically — multiple distinct
 * object queries no longer all key to `"[object Object]"` (the silent
 * `--add-queries` corruption the old `String(q)` dedup caused). Each surviving
 * entry keeps its ORIGINAL shape, so a brand-fit-tagged object survives the
 * merge with its label intact.
 *
 * @param {Array<string|{q:string}>} existing
 * @param {Array<string|{q:string}>} additions
 * @returns {Array<string|{q:string}>}
 */
export function mergeQueries(existing, additions) {
  const seen = new Set((existing || []).map(q => normaliseForDedup(q)));
  const out = (existing || []).slice();
  for (const q of additions || []) {
    const key = normaliseForDedup(q);
    if (key && !seen.has(key)) {
      out.push(q);
      seen.add(key);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

// Dedup key for a basket entry — string OR {q,...} object. Routes through the
// shared queryText() so the string-only and object forms can never diverge.
function normaliseForDedup(s) {
  return queryText(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
