import { withRetry, withProviderCall, parseRetryAfter, maybeSetCooldown } from './_retry.js';
import { classifyProviderError } from './classify-error.js';
import { learnTpmLimit, parseTpmLimitHeader } from './tpm-ledger.js';
import { extractUsage } from './pricing.js';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

// Shared with main-options.js (detectThinkingActive) so the "does this model get
// an explicit thinkingBudget" predicate can't drift between the request-building
// code here and the ETA-estimation code there.
export const GEMINI_2X_THINKING_BUDGET_MODEL = /^gemini-2\.(?:[5-9]|\d{2,})/;
export function isGeminiThinkingBudgetModel(model) {
  return GEMINI_2X_THINKING_BUDGET_MODEL.test(model) && !/-lite\b/i.test(model);
}

/**
 * The `generationConfig.thinkingConfig` object for a model id, or null if the
 * model gets no explicit thinking field. Two mutually-exclusive shapes, chosen
 * by generation (sending the wrong one / both errors out):
 *   - gemini-3.x            → { thinkingLevel: 'high' }  (forced; inflates output ~5-10x)
 *   - gemini-2.5+ non-lite  → { thinkingBudget: -1 }     (dynamic/auto, task-scaled)
 *   - else (2.x-lite, 2.0)  → null                       (no field; provider default)
 * The classify tier used to be pinned to gemini-2.5-flash specifically to land
 * on the dynamic-budget path — but Google retired the entire 2.5 generation
 * for new API access (2026-08-13), so classify now pins to gemini-3.1-flash-lite
 * and eats the forced-high multiplier like everything else on gemini-3.x; see
 * discover.js::fetchGeminiClassifyModel for the cost reasoning. Exported so the
 * tier→thinking mapping is unit-testable without a live API call.
 * @param {string} model
 * @returns {{thinkingLevel: string}|{thinkingBudget: number}|null}
 */
export function geminiThinkingConfig(model) {
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'high' };
  if (isGeminiThinkingBudgetModel(model)) return { thinkingBudget: -1 };
  return null;
}

/**
 * Call Google Gemini generateContent API.
 *
 * @param {object} [options]
 * @param {boolean} [options.webSearch=true]
 *   When true, attaches `google_search` grounding tool.
 *   When false, omits the tool — use for analysis tasks (e.g. init auto-suggest).
 */
export async function callGemini(query, apiKey, model, options = {}) {
  const webSearch = options.webSearch !== false;
  // API key goes in `x-goog-api-key` header (Google's recommended form for
  // server-side calls) instead of `?key=` in the URL. URL-based keys leak into
  // proxy access logs, browser history (if a user pastes the URL), and HTTP
  // Referer headers on any 30x redirect. Header-based is the default for the
  // official Google SDKs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = { contents: [{ parts: [{ text: query }] }] };
  // Thinking is controlled by TWO different, mutually-exclusive fields depending
  // on generation (sending both / the wrong one for the model's gen errors out):
  //   - gemini-3.x   → thinkingLevel (enum: low/medium/high) — the newer interface.
  //   - gemini-2.x   → thinkingBudget (token count; -1 = dynamic/auto, 0 = off).
  //     Google enables this BY DEFAULT for 2.5+ flash/pro (auto budget) — NOT for
  //     flash-lite (off by default). Leaving the field unset therefore does not
  //     mean "no thinking"; it means "whatever Google defaults to today", which
  //     silently drifts if the provider changes its default. We pin it explicitly
  //     so behaviour doesn't depend on an undocumented, movable default.
  //   Both main AND classify calls get this identically — there is no
  //   intent-based (main vs classify) gate here, only a generation-based one.
  //   (Classify used to pin to gemini-2.5-flash for the dynamic-budget path;
  //   Google retired that generation 2026-08-13, so classify now pins to
  //   gemini-3.1-flash-lite and gets forced-high like everything else on 3.x —
  //   see discover.js::fetchGeminiClassifyModel.)
  const thinking = geminiThinkingConfig(model);
  if (thinking) body.generationConfig = { thinkingConfig: thinking };
  // Caller-controlled temperature — used by the init-time model classifier
  // to ask for deterministic output (temperature=0) so repeated `init --force`
  // runs don't shuffle the picker order. Optional; absent => provider default.
  if (typeof options.temperature === 'number') {
    body.generationConfig = body.generationConfig || {};
    body.generationConfig.temperature = options.temperature;
  }
  if (webSearch) body.tools = [{ google_search: {} }];

  // cdKey per-(provider, model) — TPM scoping. sem stays per-provider.
  const cdKey = `gemini:${model}`;
  const onStatus = options.onStatus;
  return withRetry('Gemini', () => withProviderCall({ sem: 'gemini', cd: cdKey, onStatus }, async () => {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      // Optional caller-supplied AbortSignal. fetchWithTimeout composes it
      // with its own AbortSignal.timeout (whichever aborts first wins), so
      // both caller-cancellation and the runtime timeout work together.
      signal: options.signal,
    }, { kind: 'runtime' });
    // Branch (a): HTTP failure path.
    if (!res.ok) {
      const headerMs = parseRetryAfter(res);
      const json = await res.json().catch(() => ({}));
      const err = new Error(`Gemini: ${json?.error?.message || res.statusText || `HTTP ${res.status}`}`);
      // Stash HTTP status + body on the error so upstream callers (e.g. bootstrap
      // classifier) can surface the real cause instead of a generic message.
      // The withRetry/withProviderCall pipeline forwards these unchanged.
      err.status = res.status;
      err.body = json;
      if (headerMs > 0) err.retryAfterMs = headerMs;
      const parsed = classifyProviderError(err);
      if (parsed.rateLimit?.kind === 'tpm' && parsed.rateLimit.limit != null) {
        learnTpmLimit(cdKey, parsed.rateLimit.limit, 'observed');
      }
      maybeSetCooldown(err, cdKey, headerMs);
      throw err;
    }

    // Successful 200: header-based limit learning (Gemini doesn't currently
    // expose TPM headers but parseTpmLimitHeader returns null gracefully).
    const headerLimit = parseTpmLimitHeader(res.headers, 'gemini');
    if (headerLimit != null) learnTpmLimit(cdKey, headerLimit, 'header');

    const json = await res.json();
    // Branch (b): 200 with error payload.
    if (json.error) {
      const err = new Error(`Gemini: ${json.error.message}`);
      err.status = 200;  // HTTP succeeded but body has error — distinguish from network/HTTP failure
      err.body = json;
      maybeSetCooldown(err, cdKey, 0);
      throw err;
    }

    const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
    const citations = (json.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map(ch => resolveGeminiCitation(ch.web))
      .filter(Boolean);
    // Token log fallback — see openai.js for rationale.
    if (!onStatus && process.env.AEO_LOG_TOKENS === '1') {
      const u = extractUsage('gemini', json);
      process.stderr.write(`  [tokens] ${cdKey}: input=${u.inputTokens} output=${u.outputTokens} total=${(u.inputTokens || 0) + (u.outputTokens || 0)}\n`);
    }
    return { text, citations, raw: json };
  }));
}

// Gemini's groundingChunks[*].web.uri is a Vertex AI redirect token, not a resolvable URL.
// The `title` field contains the real domain (e.g. "example.com"). Fall back to that when the uri is a redirect.
function resolveGeminiCitation(web) {
  if (!web) return null;
  const uri = web.uri;
  const title = web.title;
  if (!uri) return null;
  const isVertexRedirect = /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(uri);
  if (isVertexRedirect) {
    if (title && /^[\w-]+(?:\.[\w-]+)+(?:\/|$)/.test(title)) {
      return title.startsWith('http') ? title : `https://${title}`;
    }
    return null; // drop unreadable redirect if title is unusable
  }
  return uri;
}
