// Static tier-1 TPM/RPM limits, used by the adaptive scheduler and the init
// wizard ETA hints. Tier-1 = entry-level paid tier — what most CLI users have.
//
// SNAPSHOT as of 2026-07-08. Source URLs:
//   OpenAI:     https://developers.openai.com/api/docs/guides/rate-limits
//   Anthropic:  https://platform.claude.com/docs/en/api/rate-limits
//   Gemini:     https://ai.google.dev/gemini-api/docs/rate-limits
//   Perplexity: https://docs.perplexity.ai/guides/rate-limits-usage-tiers
//
// Numbers drift — re-check yearly or on user reports. We only use this as a
// FALLBACK: the tpm-ledger learns the real limit from 429 bodies and successful
// 200 response headers, then `getLearnedOrTierLimit` prefers learned values.

/** @type {Record<string, Record<string, {tpm: number|null, rpm: number}>>} */
export const TIER_1_LIMITS = {
  openai: {
    // Search-capable variants share the gpt-5 TPM cap on tier 1, per user decision.
    // There is no separate rate-limited "Search API" model page in OpenAI's current docs.
    'gpt-5-search-api':           { tpm: 500_000, rpm: 500 },
    'gpt-5-mini':                 { tpm: 500_000, rpm: 500 },  // before 'gpt-5' (longest-prefix)
    'gpt-5-nano':                 { tpm: 200_000, rpm: 500 },
    'gpt-5':                      { tpm: 500_000, rpm: 500 },
    'gpt-4o-mini-search-preview': { tpm: 200_000, rpm: 500 },
    'gpt-4o-search-preview':      { tpm: 30_000,  rpm: 100 },
    'gpt-4o-mini':                { tpm: 200_000, rpm: 500 },
    'gpt-4o':                     { tpm: 30_000,  rpm: 500 },
  },
  anthropic: {
    // Claude Start tier: TPM is smaller of ITPM (2M) and OTPM (400K).
    'claude-opus':       { tpm: 400_000, rpm: 1_000 },
    'claude-sonnet':     { tpm: 400_000, rpm: 1_000 },
    'claude-haiku':      { tpm: 400_000, rpm: 1_000 },
  },
  gemini: {
    // Tier-1 paid (free tier is stricter — we assume paid).
    'gemini-3.5-flash':      { tpm: 2_000_000, rpm: 1_000 },
    'gemini-3.1-pro':        { tpm: 1_000_000, rpm: 1_000 },
    'gemini-3.1-flash-lite': { tpm: 4_000_000, rpm: 4_000 },
    'gemini-3.1-flash':      { tpm: 4_000_000, rpm: 2_000 },
    'gemini-2.5-pro':        { tpm: 2_000_000, rpm: 1_000 },
    'gemini-2.5-flash':      { tpm: 4_000_000, rpm: 2_000 },
  },
  perplexity: {
    // Perplexity doesn't publish explicit TPM — only RPM. tpm: null signals
    // "use semaphore-based RPM throttling only, no scheduler pacing needed."
    'sonar-reasoning-pro': { tpm: null, rpm: 150 },
    'sonar-pro':           { tpm: null, rpm: 150 },
    'sonar':               { tpm: null, rpm: 150 },
  },
};

/**
 * Find the longest-prefix family name in TIER_1_LIMITS that matches modelId.
 * Returns null if no family matches.
 *
 * Example: matchModelFamily('openai', 'gpt-5-search-api-2025-01-01')
 *   → 'gpt-5-search-api' (longest prefix that startsWith() matches)
 *
 * @param {string} provider
 * @param {string} modelId
 * @returns {string|null}
 */
export function matchModelFamily(provider, modelId) {
  const fams = Object.keys(TIER_1_LIMITS[provider] || {});
  if (fams.length === 0 || !modelId) return null;
  const matching = fams.filter(f => modelId.startsWith(f));
  if (matching.length === 0) return null;
  matching.sort((a, b) => b.length - a.length);
  return matching[0];
}

/**
 * Get tier-1 limits for a (provider, model) pair, or null if unknown.
 *
 * @param {string} provider
 * @param {string} modelId
 * @returns {{tpm: number|null, rpm: number}|null}
 */
export function getTier1Limit(provider, modelId) {
  const fam = matchModelFamily(provider, modelId);
  return fam ? TIER_1_LIMITS[provider][fam] : null;
}
