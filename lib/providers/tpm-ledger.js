// Per-(provider, model) token-budget ledger with reservation pattern.
//
// Problem: with CONCURRENCY_LIMIT=2, two fetches fire BEFORE either records its
// actual token usage. If we only recorded on success, the second cell would see
// sum=0 when checking the ledger — race condition that lets both pass the
// threshold check and slam into the TPM ceiling together.
//
// Solution: two-phase accounting.
//   1. reserve(cdKey, estimate) BEFORE fetch — appends a 'reserved' entry
//   2. confirm(cdKey, id, actual) on success — replaces reserved with 'actual'
//   3. release(cdKey, id) on failure       — removes the reservation
// forecastTokensInWindow sums BOTH kinds, so concurrent reservations are visible.
//
// Lives separately from _retry.js to avoid a circular import (_retry.js imports
// from here; this file imports nothing from _retry.js).

import { getTier1Limit } from './rate-limits.js';

// Per-provider default token estimate when we have no ledger history yet.
// Hit during the narrow edge case where learnedTpmLimit exists (we've seen
// a 429 before) but no successful response is recorded. Calibrate via
// AEO_LOG_TOKENS=1.
const DEFAULT_ESTIMATE_BY_PREFIX = [
  // longest-prefix-first
  { prefix: 'openai:gpt-5-search',  tokens: 2500 },
  { prefix: 'openai:gpt-4o-search', tokens: 2500 },
  { prefix: 'openai:',              tokens: 1500 },
  { prefix: 'anthropic:',           tokens: 800  },
  { prefix: 'gemini:',              tokens: 1000 },
  { prefix: 'perplexity:',          tokens: 1200 },
];

const WINDOW_MS = 60_000;

// State per cdKey:
//   entries: Array<{ id, ts, tokens, kind: 'reserved' | 'actual' }>
//   learnedTpmLimit: number | null
//   lastLimitSource: 'observed' | 'header' | null
/** @type {Map<string, {entries: Array, learnedTpmLimit: number|null, lastLimitSource: string|null}>} */
const state = new Map();

// Monotonic int — unique reservation IDs across all cdKeys, even under burst.
let _nextReservationId = 1;

function getOrCreate(cdKey) {
  let s = state.get(cdKey);
  if (!s) {
    s = { entries: [], learnedTpmLimit: null, lastLimitSource: null };
    state.set(cdKey, s);
  }
  return s;
}

function gcEntries(s, now) {
  // Drop entries older than 60s. Mutates in place.
  const cutoff = now - WINDOW_MS;
  if (s.entries.length === 0) return;
  if (s.entries[0].ts >= cutoff) return;  // fast path: nothing to drop
  s.entries = s.entries.filter(e => e.ts >= cutoff);
}

/**
 * Reserve estimated tokens for an in-flight call. Returns an id used by
 * confirm() (on success) or release() (on failure).
 *
 * @param {string} cdKey
 * @param {number} estimateTokens
 * @returns {number}
 */
export function reserve(cdKey, estimateTokens) {
  const now = Date.now();
  const s = getOrCreate(cdKey);
  gcEntries(s, now);
  const id = _nextReservationId++;
  s.entries.push({ id, ts: now, tokens: estimateTokens, kind: 'reserved' });
  return id;
}

/**
 * Replace a reservation with actual usage on successful call.
 * No-op if id not found (defensive — already released or never existed).
 *
 * @param {string} cdKey
 * @param {number} reservationId
 * @param {number} actualTokens
 */
export function confirm(cdKey, reservationId, actualTokens) {
  const s = state.get(cdKey);
  if (!s) return;
  const idx = s.entries.findIndex(e => e.id === reservationId);
  if (idx === -1) return;
  s.entries[idx].kind = 'actual';
  s.entries[idx].tokens = actualTokens;
}

/**
 * Remove a reservation when the call failed.
 * No-op if id not found.
 *
 * @param {string} cdKey
 * @param {number} reservationId
 */
export function release(cdKey, reservationId) {
  const s = state.get(cdKey);
  if (!s) return;
  const idx = s.entries.findIndex(e => e.id === reservationId);
  if (idx === -1) return;
  s.entries.splice(idx, 1);
}

/**
 * Record a learned TPM limit (from 429 body OR from successful 200 headers).
 * Shrink-only: keeps the most conservative limit seen — protects against
 * transient burst-quota readings that would otherwise inflate budget.
 *
 * Only call for TPM limits — RPM is defended by the per-provider semaphore,
 * RPD by the cooldown gate's 'rpd' branch. Mixing kinds here would poison
 * the budget tracker (ledger sums TOKENS, not requests).
 *
 * @param {string} cdKey
 * @param {number} limit
 * @param {string} [source='observed']  'observed' from 429 body | 'header' from 200 response
 */
export function learnTpmLimit(cdKey, limit, source = 'observed') {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const s = getOrCreate(cdKey);
  if (s.learnedTpmLimit == null || limit < s.learnedTpmLimit) {
    s.learnedTpmLimit = limit;
    s.lastLimitSource = source;
  }
}

/**
 * Sum tokens (both 'reserved' and 'actual') in the last 60-second window.
 *
 * @param {string} cdKey
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function forecastTokensInWindow(cdKey, now = Date.now()) {
  const s = state.get(cdKey);
  if (!s) return 0;
  gcEntries(s, now);
  let sum = 0;
  for (const e of s.entries) sum += e.tokens;
  return sum;
}

/**
 * Earliest entry timestamp in the current window. Used by `computeHonestCooldownMs`
 * (in _retry.js) to derive a dynamic cooldown floor when the TPM bucket is full.
 *
 * @param {string} cdKey
 * @param {number} [now=Date.now()]
 * @returns {number|null}
 */
export function getFirstTokenTimestampInWindow(cdKey, now = Date.now()) {
  const s = state.get(cdKey);
  if (!s || s.entries.length === 0) return null;
  gcEntries(s, now);
  if (s.entries.length === 0) return null;
  let min = s.entries[0].ts;
  for (const e of s.entries) if (e.ts < min) min = e.ts;
  return min;
}

/**
 * Estimate per-request cost: moving average over last 5 'actual' entries,
 * falling back to a provider-specific default. Called when we need to
 * reserve tokens BEFORE knowing the actual usage.
 *
 * @param {string} cdKey
 * @returns {number}
 */
export function estimatePerRequest(cdKey) {
  const s = state.get(cdKey);
  if (s) {
    const actuals = s.entries.filter(e => e.kind === 'actual').slice(-5);
    if (actuals.length > 0) {
      const sum = actuals.reduce((a, e) => a + e.tokens, 0);
      return Math.round(sum / actuals.length);
    }
  }
  for (const { prefix, tokens } of DEFAULT_ESTIMATE_BY_PREFIX) {
    if (cdKey.startsWith(prefix)) return tokens;
  }
  return 2000;  // catch-all
}

/**
 * Decide whether to delay the next fire to avoid blowing the TPM budget.
 *
 * Threshold = learnedTpmLimit * 0.9 — 10% headroom for OpenAI's own
 * accounting jitter + race between our 'fire' decision and the provider's
 * window counter. With CONCURRENCY_LIMIT=2 and est=2500: 2 cells fit
 * (5000 ≤ 5400), 3rd waits.
 *
 * Returns { wait: false } if no learned limit yet (first run — fire blindly,
 * we'll learn the limit from the first 429 or 200 header).
 *
 * @param {string} cdKey
 * @param {number} [now=Date.now()]
 * @returns {{wait: false} | {wait: true, ms: number}}
 */
export function shouldWait(cdKey, now = Date.now()) {
  const s = state.get(cdKey);
  if (!s || s.learnedTpmLimit == null) return { wait: false };
  const sum = forecastTokensInWindow(cdKey, now);
  const est = estimatePerRequest(cdKey);
  const threshold = s.learnedTpmLimit * 0.9;
  if (sum + est <= threshold) return { wait: false };
  // Find earliest entry whose expiry frees enough tokens to fit.
  const sorted = [...s.entries].filter(e => e.ts >= now - WINDOW_MS).sort((a, b) => a.ts - b.ts);
  let agedOut = 0;
  for (const e of sorted) {
    agedOut += e.tokens;
    if (sum - agedOut + est <= threshold) {
      return { wait: true, ms: Math.max(0, (e.ts + WINDOW_MS) - now) };
    }
  }
  return { wait: true, ms: WINDOW_MS };
}

/**
 * Look up the effective TPM limit for a (provider, model) pair.
 * Prefers a learned value (from observed 429s or 200 headers) over the
 * static tier-1 fallback. Used by the adaptive scheduler (Fix 9) to size
 * its pacing windows.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {number|null}
 */
export function getLearnedOrTierLimit(provider, model) {
  const cdKey = `${provider}:${model}`;
  const s = state.get(cdKey);
  if (s?.learnedTpmLimit) return s.learnedTpmLimit;
  const tier1 = getTier1Limit(provider, model);
  return tier1?.tpm || null;
}

/**
 * Parse provider-specific rate-limit-limit headers from a 200 response.
 * Critical for tier-4+ users whose limits are much higher than tier-1 defaults:
 * without this, the scheduler would pace unnecessarily forever (they never
 * hit 429 because conservative pacing prevents it).
 *
 * @param {Headers|Record<string,string>|null} headers  fetch Response.headers or plain object
 * @param {string} provider
 * @returns {number|null}
 */
export function parseTpmLimitHeader(headers, provider) {
  if (!headers) return null;
  const get = (name) => {
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()] ?? null;
  };
  let raw = null;
  if (provider === 'openai') {
    raw = get('x-ratelimit-limit-tokens');
  } else if (provider === 'anthropic') {
    // Anthropic splits input/output token limits; take the smaller for safety.
    const inLim = parseInt(get('anthropic-ratelimit-input-tokens-limit') || '0', 10);
    const outLim = parseInt(get('anthropic-ratelimit-output-tokens-limit') || '0', 10);
    const totalLim = parseInt(get('anthropic-ratelimit-tokens-limit') || '0', 10);
    const candidates = [inLim, outLim, totalLim].filter(n => Number.isFinite(n) && n > 0);
    if (candidates.length === 0) return null;
    return Math.min(...candidates);
  }
  // Gemini / Perplexity don't expose TPM headers reliably — skip.
  if (raw == null) return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Export the learned per-(provider,model) TPM limits as a plain object, so a
 * caller can persist them between runs (AP-RATELIMIT-UX). The in-window token
 * ENTRIES are deliberately NOT exported — they are stale 60s after the run and
 * meaningless next time. Only the durable, slowly-changing learned ceilings
 * (and where we learned them) survive.
 *
 * Shape: { "openai:gpt-5-search-api": { limit: 30000, source: "observed" }, ... }
 *
 * @returns {Record<string, {limit:number, source:string|null}>}
 */
export function exportLearnedLimits() {
  const out = {};
  for (const [cdKey, s] of state.entries()) {
    if (Number.isFinite(s.learnedTpmLimit) && s.learnedTpmLimit > 0) {
      out[cdKey] = { limit: s.learnedTpmLimit, source: s.lastLimitSource || null };
    }
  }
  return out;
}

/**
 * Seed the ledger with learned limits from a previous run. Uses the same
 * shrink-only learnTpmLimit() path, so a more-conservative in-memory value from
 * THIS run is never overwritten by a looser persisted one. Malformed entries
 * are skipped silently — a corrupt ledger file must never break a run (a
 * persisted limit is an optimisation, not a correctness requirement).
 *
 * @param {Record<string, {limit:number, source?:string}>|null|undefined} obj
 * @returns {number} count of limits actually seeded
 */
export function importLearnedLimits(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let seeded = 0;
  for (const [cdKey, v] of Object.entries(obj)) {
    if (!cdKey || !v || typeof v !== 'object') continue;
    const limit = Number(v.limit);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    learnTpmLimit(cdKey, limit, 'persisted');
    seeded++;
  }
  return seeded;
}

// Test-only reset hook (not exported in production index). Modules under test
// can import this to start each test with a clean state map.
export function _resetForTests() {
  state.clear();
  _nextReservationId = 1;
}
