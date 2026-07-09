import { withRetry, withProviderCall, parseRetryAfter, maybeSetCooldown } from './_retry.js';
import { classifyProviderError } from './classify-error.js';
import { learnTpmLimit, parseTpmLimitHeader } from './tpm-ledger.js';
import { extractUsage } from './pricing.js';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

/**
 * Call OpenAI chat completions API.
 *
 * @param {string} query    user prompt
 * @param {string} apiKey   OpenAI API key
 * @param {string} model    model name (e.g. "gpt-5-search-api" or "gpt-5.4")
 * @param {object} [options]
 * @param {boolean} [options.webSearch=true]
 *   When true, attaches `web_search_options: {}` — required for `-search-preview` models.
 *   When false, omits the flag — use for analysis tasks where the model should not fetch web results
 *   (e.g. init auto-suggest, where we already provide the site content).
 * @param {string} [options.reasoning_effort]
 *   When 'low' / 'medium' / 'high' AND model is reasoning-capable (GPT-5+ family
 *   or o-series), forwarded into the request body. Silently dropped for non-
 *   reasoning models (gpt-4o, gpt-4o-search etc.) to keep CLI overrides safe.
 */

// reasoning_effort: future-proof gate by exclusion of known-legacy generations.
// Whitelist: any `gpt-`-prefix model EXCEPT gen-0..4 (these lack reasoning
// support); plus o-series (o1..o99). Future gpt-5/6/7/N auto-pass without
// code changes. Sending reasoning_effort to a non-reasoning model returns
// HTTP 400 — gate is the safety net for CLI overrides / future config drift.
//
// 1.0.7 HARD EXCLUDE: any model ID containing 'search'. Search-variants
// (gpt-5-search-api, gpt-5-mini-search-api, gpt-4o-search-preview, hypothetical
// gpt-6-search, o4-search, etc.) are stripped-down RAG-tuned models — they
// REJECT reasoning_effort with HTTP 400 "Unrecognized request argument".
// The search-exclusion fires first in the conjunction so o-series search
// variants are blocked before they reach the o-series allowlist.
//
// `[0-4](?:\D|$)` catches gen 0-4: gpt-4, gpt-4o, gpt-3.5-turbo, gpt-4.5
// (digit 0-4 followed by non-digit or end). Doesn't accidentally catch future
// gpt-50 (which would start with `5`, not `[0-4]`).
const SUPPORTS_REASONING_EFFORT = (id) =>
  !/search/i.test(id) && (
    (/^gpt-/i.test(id) && !/^gpt-[0-4](?:\D|$)/i.test(id))
    || /^o[1-9]\d?(?:[-_]|$)/i.test(id)
  );

// `web_search_options` is only a valid/meaningful field on OpenAI's
// "-search-"-suffixed model SKUs (gpt-5-search-api, gpt-4o-search-preview,
// etc.) — plain models like the classify-tier gpt-*-mini don't support it.
// AND with the caller's own flag (not a replacement): some call sites
// deliberately request webSearch:false on a search-capable model (content
// already supplied in-prompt); this gate must never force search ON, only
// ever prevent an unwanted default-on attach when the resolved model isn't
// actually a search variant (e.g. a classify-tier model, or a main-tier
// model overridden via --openai-model to a non-search id).
const IS_SEARCH_MODEL = (id) => /search/i.test(id);

export async function callOpenAI(query, apiKey, model, options = {}) {
  const webSearch = options.webSearch !== false && IS_SEARCH_MODEL(model);
  const body = {
    model,
    messages: [{ role: 'user', content: query }],
  };
  if (webSearch) {
    body.web_search_options = {};
  }
  if (typeof options.reasoning_effort === 'string' && SUPPORTS_REASONING_EFFORT(model)) {
    body.reasoning_effort = options.reasoning_effort;
  }
  // cdKey is per-(provider, model) — TPM limits at OpenAI are scoped that way,
  // so e.g. gpt-5-search-api exhaustion doesn't block parallel gpt-5-mini calls.
  // sem stays per-provider so the RPM cap covers the whole OpenAI org.
  const cdKey = `openai:${model}`;
  const onStatus = options.onStatus;
  return withRetry('OpenAI', () => withProviderCall({ sem: 'openai', cd: cdKey, onStatus }, async () => {
    const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { kind: 'runtime' });
    // Branch (a): HTTP-level failure (e.g. 429, 5xx). Read Retry-After from
    // headers before parsing JSON, raise cooldown gate, throw.
    if (!res.ok) {
      const headerMs = parseRetryAfter(res);
      const json = await res.json().catch(() => ({}));
      const err = new Error(`OpenAI: ${json?.error?.message || res.statusText || `HTTP ${res.status}`}`);
      if (headerMs > 0) err.retryAfterMs = headerMs;
      // Feed ledger BEFORE setting cooldown — so computeHonestCooldownMs sees
      // the just-learned limit when it queries the ledger.
      const parsed = classifyProviderError(err);
      if (parsed.rateLimit?.kind === 'tpm' && parsed.rateLimit.limit != null) {
        learnTpmLimit(cdKey, parsed.rateLimit.limit, 'observed');
      }
      maybeSetCooldown(err, cdKey, headerMs);
      throw err;
    }

    // Successful 200: opportunistically learn TPM limit from response headers.
    // Critical for tier-4+ users whose real limits are much higher than tier-1
    // defaults — they may never hit a 429 to learn from.
    const headerLimit = parseTpmLimitHeader(res.headers, 'openai');
    if (headerLimit != null) learnTpmLimit(cdKey, headerLimit, 'header');

    const json = await res.json();
    // Branch (b): 200 OK with error payload (OpenAI sometimes returns
    // rate-limit messages this way). No Retry-After header here — helper
    // falls back to 30s cooldown if classifier matches rate-limit.
    if (json.error) {
      const err = new Error(`OpenAI: ${json.error.message}`);
      maybeSetCooldown(err, cdKey, 0);
      throw err;
    }
    const text = json.choices?.[0]?.message?.content || '';
    const citations = (json.choices?.[0]?.message?.annotations || [])
      .filter(a => a.url_citation).map(a => a.url_citation.url);
    // Token log: when a live status manager is wired up (onStatus supplied),
    // withProviderCall emits a `tokens` event and the manager logs it. Without
    // a manager (init, tests, scripts), keep the direct stderr write so
    // AEO_LOG_TOKENS=1 still works.
    if (!onStatus && process.env.AEO_LOG_TOKENS === '1') {
      const u = extractUsage('openai', json);
      process.stderr.write(`  [tokens] ${cdKey}: input=${u.inputTokens} output=${u.outputTokens} total=${(u.inputTokens || 0) + (u.outputTokens || 0)}\n`);
    }
    return { text, citations, raw: json };
  }));
}
