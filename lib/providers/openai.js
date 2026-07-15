import { withRetry, withProviderCall, parseRetryAfter, maybeSetCooldown } from './_retry.js';
import { classifyProviderError } from './classify-error.js';
import { learnTpmLimit, parseTpmLimitHeader } from './tpm-ledger.js';
import { extractUsage } from './pricing.js';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

/**
 * Call OpenAI for one query.
 *
 * Two API surfaces, routed purely by whether web search is requested:
 *
 *   webSearch:true  → Responses API (`/v1/responses`) with the built-in
 *                     `{type:'web_search'}` tool. CRITICAL: the tool bills and
 *                     rate-limits against the UNDERLYING model's bucket (e.g.
 *                     gpt-5-mini = 500k TPM), NOT the tiny dedicated bucket of
 *                     the legacy `-search-api` SKU (~6k TPM — see the
 *                     .tpm-ledger.json header proof). That ~83× headroom is the
 *                     entire reason we stopped calling the search SKU.
 *   webSearch:false → Chat Completions (`/v1/chat/completions`), no tool — used
 *                     for classify + the --depth=full training-data pass.
 *
 * The route is decided by the CALLER's `webSearch` flag, never by the model id.
 * A general model (gpt-5-mini) does web search via the tool; the model name no
 * longer needs to contain "search".
 *
 * @param {string} query    user prompt
 * @param {string} apiKey   OpenAI API key
 * @param {string} model    model name (e.g. "gpt-5-mini")
 * @param {object} [options]
 * @param {boolean} [options.webSearch=true]
 *   true → Responses API + web_search tool. false → plain Chat Completions
 *   (analysis/classify tasks where content is already supplied in-prompt).
 * @param {string} [options.reasoning_effort]
 *   'low' / 'medium' / 'high'. Forwarded to reasoning-capable models — as
 *   `reasoning.effort` on the Responses API, or `reasoning_effort` on Chat
 *   Completions. Silently dropped for non-reasoning models (gpt-4o, search
 *   SKUs) to keep CLI overrides safe.
 * @param {string} [options.searchContextSize]
 *   'low' / 'medium' / 'high' — caps how much retrieved page content the tool
 *   folds into the prompt (and thus TPM burn per call). Omitted → provider
 *   default (medium). Env AEO_OPENAI_SEARCH_CONTEXT overrides globally.
 */

// reasoning support gate — future-proof by excluding known-legacy generations.
// Whitelist: any `gpt-`-prefix model EXCEPT gen-0..4 (these lack reasoning
// support); plus o-series (o1..o99). Future gpt-5/6/7/N auto-pass without
// code changes. Sending reasoning to a non-reasoning model returns HTTP 400.
//
// HARD EXCLUDE: any model ID containing 'search'. Legacy search-variant SKUs
// (gpt-5-search-api, gpt-4o-search-preview, etc.) REJECT reasoning with HTTP
// 400 "Unrecognized request argument". The search-exclusion fires first so
// o-series search variants are blocked before the o-series allowlist.
//
// `[0-4](?:\D|$)` catches gen 0-4: gpt-4, gpt-4o, gpt-3.5-turbo, gpt-4.5
// (digit 0-4 followed by non-digit or end). Doesn't catch future gpt-50.
const SUPPORTS_REASONING_EFFORT = (id) =>
  !/search/i.test(id) && (
    (/^gpt-/i.test(id) && !/^gpt-[0-4](?:\D|$)/i.test(id))
    || /^o[1-9]\d?(?:[-_]|$)/i.test(id)
  );

// Build the Responses-API request (web_search tool path).
function buildResponsesRequest(query, model, options) {
  const body = {
    model,
    input: query,
    store: false,
    tools: [{ type: 'web_search' }],
    // FORCE the web_search tool (not 'auto'). AEO measurement must reflect what
    // the engine answers WITH live retrieval — matching the always-search
    // behaviour of the legacy gpt-5-search-api SKU this replaces. With 'auto'
    // the model could answer from training data on some queries, silently
    // recording a no-search cell as mode:'web' and skewing citation metrics.
    tool_choice: { type: 'web_search' },
  };
  const ctx = options.searchContextSize || process.env.AEO_OPENAI_SEARCH_CONTEXT;
  if (ctx === 'low' || ctx === 'medium' || ctx === 'high') {
    body.tools[0].search_context_size = ctx;
  }
  if (typeof options.reasoning_effort === 'string' && SUPPORTS_REASONING_EFFORT(model)) {
    body.reasoning = { effort: options.reasoning_effort };
  }
  return { url: 'https://api.openai.com/v1/responses', body };
}

// Build the Chat-Completions request. `attachWebSearch` is set only for the
// legacy `-search` SKUs doing a search call — those do web search via
// `web_search_options`, NOT the Responses tool (which rejects them). Plain
// (non-search) calls and general models never take this path with search on.
function buildChatRequest(query, model, options, attachWebSearch) {
  const body = { model, messages: [{ role: 'user', content: query }] };
  if (attachWebSearch) body.web_search_options = {};
  if (typeof options.reasoning_effort === 'string' && SUPPORTS_REASONING_EFFORT(model)) {
    body.reasoning_effort = options.reasoning_effort;
  }
  return { url: 'https://api.openai.com/v1/chat/completions', body };
}

/**
 * Extract { text, citations } from an OpenAI raw response body, auto-detecting
 * the API shape. SINGLE source of truth for OpenAI extraction — used both by
 * the live call below AND by the replay/cache reader in bin/aeo-tracker.js
 * (_extractFromRaw), so the two can never drift.
 *
 * Handles BOTH shapes, because the cache holds whichever the call produced:
 *   - Responses API (`/v1/responses`, web_search tool): ordered `output[]`
 *     array; the answer lives in the `message` item's `output_text` parts, and
 *     url_citation annotations (flat `.url`) hang off those parts.
 *   - Chat Completions (`/v1/chat/completions`, non-search + legacy caches):
 *     `choices[0].message.content` + nested `annotations[].url_citation.url`.
 *
 * @param {object} raw  parsed JSON response body
 * @returns {{text: string, citations: string[]}}
 */
export function extractOpenAIResponse(raw) {
  if (Array.isArray(raw?.output)) {
    let text = '';
    const citations = [];
    for (const item of raw.output) {
      if (item.type !== 'message') continue;
      for (const part of (item.content || [])) {
        if (part.type !== 'output_text') continue;
        text += part.text || '';
        for (const a of (part.annotations || [])) {
          if (a.type === 'url_citation' && a.url) citations.push(a.url);
        }
      }
    }
    // Some SDK/models also expose a flattened convenience field.
    if (!text && typeof raw.output_text === 'string') text = raw.output_text;
    return { text, citations };
  }
  const text = raw?.choices?.[0]?.message?.content || '';
  const citations = (raw?.choices?.[0]?.message?.annotations || [])
    .filter(a => a.url_citation).map(a => a.url_citation.url);
  return { text, citations };
}

export async function callOpenAI(query, apiKey, model, options = {}) {
  const webSearch = options.webSearch !== false;
  // Legacy `-search` SKUs (gpt-5-search-api, gpt-4o-search-preview) can ONLY
  // web-search via Chat Completions `web_search_options`; general models can
  // ONLY web-search via the Responses `web_search` tool. Route by BOTH signals
  // so every model reaches its correct endpoint (a `--openai-model` override to
  // a search SKU keeps working instead of 400-ing against /v1/responses):
  //   general    + search    → Responses API + web_search tool (big bucket)
  //   search-SKU + search    → Chat Completions + web_search_options (native)
  //   anything   + no-search → plain Chat Completions
  const isSearchSku = /search/i.test(model);
  const { url, body } = (webSearch && !isSearchSku)
    ? buildResponsesRequest(query, model, options)
    : buildChatRequest(query, model, options, webSearch && isSearchSku);

  // cdKey is per-(provider, model) — TPM limits at OpenAI are scoped that way,
  // so e.g. gpt-5-mini exhaustion doesn't block parallel gpt-4o-mini classify
  // calls. sem stays per-provider so the RPM cap covers the whole OpenAI org.
  const cdKey = `openai:${model}`;
  const onStatus = options.onStatus;
  return withRetry('OpenAI', () => withProviderCall({ sem: 'openai', cd: cdKey, onStatus }, async () => {
    const res = await fetchWithTimeout(url, {
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
    // defaults — they may never hit a 429 to learn from. Also how we learned
    // the honest gpt-5-mini 500k vs gpt-5-search-api 6k split in the first place.
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
    const { text, citations } = extractOpenAIResponse(json);
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
