// Dynamic model discovery — queries each provider's /v1/models endpoint
// and returns the single best CURRENT search-capable model per provider.
//
// Selection policy (per AEO-tracker contract: mid + thinking + web search):
//   openai      — flagship search-capable (mini explicitly de-prioritized per
//                 user verdict; OpenAI mini is too weak for reasoning queries).
//   anthropic   — latest claude-sonnet (mid by name; opus is 5-10× more expensive
//                 with similar AEO-detection quality).
//   gemini      — version-sorted, prefer flash (mid) over pro (flagship);
//                 stable > preview. Preview-only newest-gen → fallback to
//                 previous-gen stable (preview models deprecate unpredictably).
//   perplexity  — sonar-reasoning (mid + reasoning) preferred; fallback chain
//                 sonar-reasoning-pro > sonar-pro.
//
// Returns { models: string[]|null, authError: boolean } per provider. cmdRun
// uses authError to skip provider entirely on 401/403; null with authError=false
// triggers fallback to cfg.model.

import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

// Discovery is a lightweight GET to /v1/models (small JSON, cold-start TLS
// + handshake fits in seconds). Default 10s; env-tunable for slow ISPs.
const DISCOVERY_TIMEOUT_MS =
  Number.isFinite(+process.env.AEO_DISCOVERY_TIMEOUT_MS) && +process.env.AEO_DISCOVERY_TIMEOUT_MS > 1000
    ? +process.env.AEO_DISCOVERY_TIMEOUT_MS
    : 10_000;

// ─── FALLBACK (when discovery fails / cfg.model also absent) ────────────────
// FALLBACK invariant: each main MUST be a verified-existing model (no bleeding-
// edge speculative IDs). Selection rules в fetcher'е aim for "best mid+thinking
// +search"; FALLBACK is the safe baseline когда discovery failed. Two concepts:
// discovery → best, fallback → guaranteed alive.
//
// MUST stay in sync with DEFAULT_CONFIG.providers in lib/config.js (drift
// catcher in test/discover.test.js verifies).
export const FALLBACK = {
  openai:     { main: 'gpt-5-search-api',   classify: 'gpt-5-nano' },
  anthropic:  { main: 'claude-sonnet-5',    classify: 'claude-haiku-4-5' },
  gemini:     { main: 'gemini-3.5-flash',   classify: 'gemini-2.5-flash' },
  perplexity: { main: 'sonar-reasoning',    classify: 'sonar' },
};

// ─── Error helpers ──────────────────────────────────────────────────────────

function authThrow(status) {
  const err = new Error(`auth: ${status}`);
  err.authError = true;
  throw err;
}

function debugLog(provider, rawCount, filteredCount, sortedTop3, picked) {
  if (process.env.AEO_DEBUG_DISCOVERY !== '1') return;
  process.stderr.write(
    `  [discover-debug] ${provider}: raw=${rawCount}, filtered=${filteredCount}, top3=[${sortedTop3.join(', ')}], picked=${picked || '<none>'}\n`,
  );
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────
//
// Selection rules per user verdict (revised):
//   - search-capable only (`id.includes('search')`)
//   - skip audio/realtime
//   - SORT priority:
//     (1) Generation desc — newest gen first (gpt-5 > gpt-4).
//     (2) Mini penalty — within gen, non-mini wins (user said mini is "тупая").
//     (3) Undated > dated — stable pointer over snapshot.
//
// Edge case: if newest gen has ONLY mini-search variant — берём mini (alternative
// is fallback to previous-gen flagship which is potentially deprecated).
async function fetchOpenAIModels(apiKey, baseURL = 'https://api.openai.com') {
  const res = await fetchWithTimeout(
    `${baseURL}/v1/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { timeoutMs: DISCOVERY_TIMEOUT_MS },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) authThrow(res.status);
    throw new Error(`${res.status}`);
  }
  const { data } = await res.json();
  const ids = (data || []).map(m => m.id).filter(Boolean);
  const filtered = ids.filter(id =>
    id.includes('search') &&
    !id.includes('audio') &&
    !id.includes('realtime'),
  );
  // Generation extractor: gpt-5* → 5, gpt-4o* → 4. Default 0.
  const gen = (id) => {
    const m = id.match(/^gpt-(\d+)/);
    return m ? Number(m[1]) : 0;
  };
  const isMini = (id) => /-mini[-_]/i.test(id) || /-mini$/i.test(id);
  const isDated = (id) => /-\d{4}-\d{2}-\d{2}$/.test(id);
  const sorted = filtered.slice().sort((a, b) => {
    const dGen = gen(b) - gen(a);
    if (dGen !== 0) return dGen;
    const dMini = (isMini(a) ? 1 : 0) - (isMini(b) ? 1 : 0);
    if (dMini !== 0) return dMini;
    return (isDated(a) ? 1 : 0) - (isDated(b) ? 1 : 0);
  });
  debugLog('openai', ids.length, filtered.length, sorted.slice(0, 3), sorted[0]);
  return sorted.length > 0 ? [sorted[0]] : null;
}

// ─── Anthropic ──────────────────────────────────────────────────────────────
//
// Selection rules:
//   - Only sonnet (mid by name; opus is too expensive for weekly tracking).
//   - Skip dated snapshots (8-digit YYYYMMDD or hyphenated YYYY-MM-DD).
//   - Sort chain (defensive against API shape changes):
//     (1) created_at desc — provider-provided ground truth.
//     (2) Date-in-id extraction — if API stops returning created_at,
//         match `/-(\d{4})-(\d{2})-(\d{2})/` and sort by extracted date.
//     (3) id lex desc — last-resort fallback.
//
// Anthropic uses two naming conventions historically (`claude-sonnet-4-6`
// semver-like vs dated `claude-sonnet-2026-04-19`). Sort chain handles both;
// if naming changes again — extend chain, not replace.
async function fetchAnthropicModels(apiKey) {
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/models',
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
    { timeoutMs: DISCOVERY_TIMEOUT_MS },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) authThrow(res.status);
    throw new Error(`${res.status}`);
  }
  const { data } = await res.json();
  const candidates = (data || []).filter(m =>
    /claude.*sonnet/i.test(m.id) &&
    !/\d{8}$/.test(m.id) &&
    !/-\d{4}-\d{2}-\d{2}$/.test(m.id),
  );
  const extractDateFromId = (id) => {
    const m = id.match(/-(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}` : '';
  };
  const sorted = candidates.slice().sort((a, b) => {
    // (1) created_at — primary.
    if (a.created_at && b.created_at) {
      return b.created_at > a.created_at ? 1 : -1;
    }
    // (2) date-in-id fallback.
    const dA = extractDateFromId(a.id);
    const dB = extractDateFromId(b.id);
    if (dA && dB) return dB.localeCompare(dA);
    // (3) lex desc — last resort.
    return b.id.localeCompare(a.id);
  });
  debugLog('anthropic', (data || []).length, candidates.length, sorted.slice(0, 3).map(m => m.id), sorted[0]?.id);
  return sorted.length > 0 ? [sorted[0].id] : null;
}

// ─── Gemini ─────────────────────────────────────────────────────────────────
//
// Selection rules (future-proof — works for any gen-N without code changes):
//   - Filter ANY `^gemini-` (not hardcoded gen filter).
//   - Skip lite/embedding/aqa/exp/thinking-experimental — non-chat or unstable.
//   - Sort:
//     (1) Numerical version desc — extracts via parseFloat. Auto-orders
//         3.1 > 3.0 > 2.5 > 4.0 in future without code update.
//         Note: if Google switches to date-naming (`gemini-2027-04`), parseFloat
//         will return 2027 — treated as "newest" by luck. Re-evaluate if naming
//         convention shifts again.
//     (2) Stable > preview — preview deprecate unpredictably.
//     (3) Flash > pro — mid preference.
//   - Preview-only newest-gen guard: if top pick is preview AND any non-preview
//     exists in previous gen — switch to previous-gen stable.
async function fetchGeminiModels(apiKey) {
  // API key in `x-goog-api-key` header — see lib/providers/gemini.js for
  // the reasoning (URL-based keys leak through proxy logs / redirects).
  const res = await fetchWithTimeout(
    'https://generativelanguage.googleapis.com/v1beta/models',
    { headers: { 'x-goog-api-key': apiKey } },
    { timeoutMs: DISCOVERY_TIMEOUT_MS },
  );
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) authThrow(res.status);
    throw new Error(`${res.status}`);
  }
  const { models } = await res.json();
  const all = (models || []).filter(m => {
    const id = (m.name || '').replace(/^models\//, '');
    return (
      m.supportedGenerationMethods?.includes('generateContent') &&
      /^gemini-/i.test(id) &&
      !id.includes('embedding') &&
      !id.includes('lite') &&
      !id.includes('aqa') &&
      !id.includes('thinking-experimental') &&
      !id.includes('exp')
    );
  }).map(m => m.name.replace(/^models\//, ''));

  const ver = (id) => parseFloat(id.match(/gemini-(\d+\.?\d*)/i)?.[1] || '0');
  const isPreview = (id) => /-preview/i.test(id);
  const isFlash = (id) => /flash/i.test(id);
  const isPro = (id) => /\bpro\b/i.test(id);
  const sorted = all.slice().sort((a, b) => {
    const dVer = ver(b) - ver(a);
    if (dVer !== 0) return dVer;
    const dPreview = (isPreview(a) ? 1 : 0) - (isPreview(b) ? 1 : 0);
    if (dPreview !== 0) return dPreview;
    // mid preference: flash > pro
    const aIsFlash = isFlash(a), bIsFlash = isFlash(b);
    if (aIsFlash !== bIsFlash) return aIsFlash ? -1 : 1;
    const aIsPro = isPro(a), bIsPro = isPro(b);
    if (aIsPro !== bIsPro) return aIsPro ? 1 : -1;
    return 0;
  });

  let picked = sorted[0];
  // Preview-only newest-gen guard: if top is preview, check if any non-preview
  // exists in any previous gen. If yes, switch to that stable model.
  if (picked && isPreview(picked)) {
    const newestVer = ver(picked);
    const previousStable = sorted.find(id => !isPreview(id) && ver(id) < newestVer);
    if (previousStable) picked = previousStable;
  }
  debugLog('gemini', (models || []).length, all.length, sorted.slice(0, 3), picked);
  return picked ? [picked] : null;
}

// ─── Perplexity ─────────────────────────────────────────────────────────────
//
// Perplexity's /models endpoint is unreliable historically (sometimes 404s,
// sometimes returns abbreviated list). Try it; fallback to preference chain:
// sonar-reasoning > sonar-reasoning-pro > sonar-pro.
async function fetchPerplexityModels(apiKey) {
  const PREFERENCE = ['sonar-reasoning', 'sonar-reasoning-pro', 'sonar-pro'];
  try {
    const res = await fetchWithTimeout(
      'https://api.perplexity.ai/models',
      { headers: { Authorization: `Bearer ${apiKey}` } },
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) authThrow(res.status);
      // Other failures — fall through to preference chain.
    } else {
      const json = await res.json();
      const ids = (json.data || json.models || []).map(m => m.id || m).filter(Boolean);
      // Pick first preference that exists in API response.
      for (const pref of PREFERENCE) {
        if (ids.includes(pref)) {
          debugLog('perplexity', ids.length, ids.length, ids.slice(0, 3), pref);
          return [pref];
        }
      }
      // None of preferred — fall back to any sonar variant.
      const anySonar = ids.find(id => /sonar/i.test(id));
      if (anySonar) {
        debugLog('perplexity', ids.length, 1, [anySonar], anySonar);
        return [anySonar];
      }
    }
  } catch (err) {
    if (err?.authError) throw err;  // bubble auth — caller handles
    // Other errors — fall through.
  }
  // /models endpoint failed or empty — use preference chain blindly.
  debugLog('perplexity', 0, 0, [], 'sonar-reasoning (chain fallback)');
  return ['sonar-reasoning'];
}

// ─── Registry ───────────────────────────────────────────────────────────────

const FETCHERS = {
  openai:     fetchOpenAIModels,
  anthropic:  fetchAnthropicModels,
  gemini:     fetchGeminiModels,
  perplexity: fetchPerplexityModels,
};

/**
 * Discover current main model(s) for the given provider.
 *
 * Contract change vs main branch (was: Promise<string[]|null>).
 * Single internal caller (bin/aeo-tracker.js cmdRun) — safe to evolve.
 *
 * @param {string} provider
 * @param {string} apiKey
 * @param {string} [baseURL]
 * @param {Object} [opts]
 * @param {boolean} [opts.quiet=false]  suppress the always-on [discover-warn]
 *        stderr line. The init key-probe sets this: on an offline init the
 *        "response shape might've changed" wording is misleading (the real
 *        cause is no network), so the probe prints its own honest line instead
 *        (fail-branch I-8). Has no effect on the live `run` path.
 * @returns {Promise<{models: string[]|null, authError: boolean}>}
 *   - authError=true means 401/403 from /v1/models → skip provider entirely.
 *   - models=null with authError=false means network/5xx/other → caller falls
 *     back to cfg.model from .aeo-tracker.json.
 */
export async function discoverModels(provider, apiKey, baseURL, opts = {}) {
  const fn = FETCHERS[provider];
  if (!fn) return { models: null, authError: false };
  try {
    const models = await fn(apiKey, baseURL);
    return { models, authError: false };
  } catch (err) {
    // Always-on warning for non-auth failures — provider response shape might've
    // changed (renamed field, removed property). Maintainer should see this
    // immediately, not wait for user reports. Suppressed for the init probe
    // (opts.quiet) where the message would mislead on an offline machine.
    if (!err?.authError && !opts.quiet) {
      process.stderr.write(`  [discover-warn] ${provider}: ${err?.message || err}\n`);
    }
    return { models: null, authError: err?.authError === true };
  }
}
