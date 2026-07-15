import { CLASSIFY_PROVIDER_PRIORITY } from '../config.js';

/**
 * Pick the single provider to use for a ONE-MODEL classify task (query
 * validation without --strict-validation, init's cleanCategory step, outreach
 * drafting, citation-domain classification). NOT for two-model cross-checks
 * (competitor extraction, sentiment) — those always use every available
 * research-capable provider regardless of this order.
 *
 * Pure function — no I/O, easy to unit test. Returns the first entry in
 * `providers` whose `.name` appears earliest in `priority`; entries whose name
 * isn't in `priority` at all are ignored (never picked, never crash the sort).
 *
 * @param {Array<{name: string}>} providers   already-built provider descriptors
 * @param {string[]} [priority]               defaults to CLASSIFY_PROVIDER_PRIORITY
 * @returns {object|null}  the chosen provider descriptor, or null if `providers`
 *                          is empty / none of its entries appear in `priority`
 */
export function pickClassifyProvider(providers, priority = CLASSIFY_PROVIDER_PRIORITY) {
  const pool = (providers || []).filter(Boolean);
  for (const name of priority) {
    const found = pool.find(p => p.name === name);
    if (found) return found;
  }
  return null;
}
