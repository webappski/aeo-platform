import { withRetry, withProviderCall, parseRetryAfter, maybeSetCooldown } from './_retry.js';
import { classifyProviderError } from './classify-error.js';
import { learnTpmLimit, parseTpmLimitHeader } from './tpm-ledger.js';
import { extractUsage } from './pricing.js';
import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

/**
 * Call Anthropic Messages API.
 *
 * @param {object} [options]
 * @param {boolean} [options.webSearch=true]
 *   When true, attaches the `web_search` tool.
 *   When false, omits the tool — use for analysis tasks where the model should not fetch web results
 *   (e.g. init auto-suggest, where we already provide the site content).
 * @param {{type: 'enabled', budget_tokens: number}} [options.thinking]
 *   Extended thinking config. Forwarded to body when model supports it (Claude 4+).
 *   max_tokens is auto-bumped to accommodate (Anthropic requires max_tokens > budget_tokens).
 *   Silently dropped for legacy Claude (1/2/3) to keep CLI overrides safe.
 */

// Extended thinking: defensive whitelist by exclusion of legacy gen-1/2/3.
// Future-proof — claude-4-X, claude-5-X, и любые будущие claude-N-X (N≥4)
// auto-pass без code changes. Anthropic uses both `claude-sonnet-4-6` and
// dated `claude-sonnet-2026-04-19` conventions; both pass this gate.
const SUPPORTS_THINKING = (id) =>
  /^claude-/i.test(id) && !/^claude-[1-3](?:[.-]|$)/i.test(id);

export async function callAnthropic(query, apiKey, model, options = {}) {
  const webSearch = options.webSearch !== false;
  const body = {
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: query }],
  };
  if (webSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }
  if (options.thinking && typeof options.thinking === 'object' && SUPPORTS_THINKING(model)) {
    // Claude gen-5+ ids (claude-sonnet-5, dated variants) reject thinking.type
    // "enabled" — the API demands "adaptive". Gen 4.x keeps the legacy contract.
    // Assumes family-first ids (claude-<family>-<gen>...); a digit-first id would fall
    // through to legacy — unreachable today (discover.js never emits bare aliases).
    const genMatch = /^claude-[a-z]+-(\d+)(?:[.-]|$)/i.exec(model);
    const gen = genMatch ? parseInt(genMatch[1], 10) : null;
    body.thinking = gen != null && gen >= 5 ? { type: 'adaptive' } : options.thinking;
    // Anthropic requires max_tokens > thinking.budget_tokens. Bump conservatively.
    const budget = Number(options.thinking.budget_tokens) || 0;
    if (budget > 0) body.max_tokens = Math.max(body.max_tokens, budget + 2048);
  }
  // cdKey per-(provider, model) — TPM scoping. sem stays per-provider.
  const cdKey = `anthropic:${model}`;
  const onStatus = options.onStatus;
  return withRetry('Anthropic', () => withProviderCall({ sem: 'anthropic', cd: cdKey, onStatus }, async () => {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }, { kind: 'runtime' });
    // Branch (a): HTTP failure path.
    if (!res.ok) {
      const headerMs = parseRetryAfter(res);
      const json = await res.json().catch(() => ({}));
      const err = new Error(`Anthropic: ${json?.error?.message || res.statusText || `HTTP ${res.status}`}`);
      if (headerMs > 0) err.retryAfterMs = headerMs;
      const parsed = classifyProviderError(err);
      if (parsed.rateLimit?.kind === 'tpm' && parsed.rateLimit.limit != null) {
        learnTpmLimit(cdKey, parsed.rateLimit.limit, 'observed');
      }
      maybeSetCooldown(err, cdKey, headerMs);
      throw err;
    }

    // Successful 200: header-based limit learning.
    const headerLimit = parseTpmLimitHeader(res.headers, 'anthropic');
    if (headerLimit != null) learnTpmLimit(cdKey, headerLimit, 'header');

    const json = await res.json();
    // Branch (b): 200 with error payload.
    if (json.error) {
      const err = new Error(`Anthropic: ${json.error.message}`);
      maybeSetCooldown(err, cdKey, 0);
      throw err;
    }
    const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const citations = (json.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (b.content || []).map(c => c.url).filter(Boolean));
    // Token log fallback — see openai.js for rationale.
    if (!onStatus && process.env.AEO_LOG_TOKENS === '1') {
      const u = extractUsage('anthropic', json);
      process.stderr.write(`  [tokens] ${cdKey}: input=${u.inputTokens} output=${u.outputTokens} total=${(u.inputTokens || 0) + (u.outputTokens || 0)}\n`);
    }
    return { text, citations, raw: json };
  }));
}
