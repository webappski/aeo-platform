// Universal error classifier for every failure path in aeo-tracker.
//
// Used in three places:
//   1) init --auto research loop — retryable provider errors (billing/auth/rate-limit)
//      cause fallback to next provider; non-retryable errors bubble to the panel.
//   2) run command — per-engine errors become ERROR cells; "all engines failed"
//      aggregates classifications into an actionable summary panel.
//   3) top-level dispatcher — any uncaught error hits this classifier so the
//      user sees a structured panel instead of a raw Node stack trace.
//
// Categories split into:
//   - Provider-side (billing, auth, rate-limit)   — retryable across providers
//   - Environment-side (network, filesystem, config, site-fetch, bot-protection)
//     — NOT retryable across providers (retrying with Gemini won't fix a broken
//     domain fetch or a corrupted config file)
//   - other — real bug or unexpected state; surface raw message + stack

/**
 * @typedef {Object} AeoErrorClass
 * @property {boolean} retryable  True only for provider billing/auth/rate-limit.
 *                                Environment errors are NOT retryable with another
 *                                provider — they need their own fix.
 * @property {'billing'|'auth'|'rate-limit'|'model-deprecated'|'network'|'site-fetch'|'bot-protection'|'config'|'filesystem'|'other'} category
 * @property {string}  reason     Short human phrase for the "trying next" log line.
 * @property {string=} fixHint    Provider-agnostic nudge (top-up, check key, wait).
 */

/**
 * @param {unknown} err  Error, Error-like, or string.
 * @returns {AeoErrorClass}
 */
export function classifyProviderError(err) {
  const msg = errToString(err);
  const code = (err && typeof err === 'object' && 'code' in err) ? String(err.code) : '';

  // ─── Provider-side: retryable across providers ───

  // Billing: account has no credit. Retry → next provider helps.
  // Anthropic: "Your credit balance is too low to access the Anthropic API"
  // OpenAI: "You exceeded your current quota, please check your plan and billing"
  // Google: "Billing account ... is disabled"
  if (/credit.*balance|balance.*too.*low|insufficient.*(credit|fund|balance)|exceeded.*(your.*)?(current.*)?quota|billing.*(disabled|not.*enabled)|plan.*and.*billing|402/i.test(msg)) {
    return {
      retryable: true,
      category: 'billing',
      reason: 'empty billing balance',
      fixHint: 'top up the provider\'s billing dashboard',
    };
  }

  // Auth: key revoked, typo'd, missing scope.
  if (/\b401\b|unauthori[sz]ed|invalid.*api.*key|incorrect.*api.*key|api.*key.*not.*valid|authentication.*failed|invalid.*x-api-key/i.test(msg)) {
    return {
      retryable: true,
      category: 'auth',
      reason: 'invalid or revoked API key',
      fixHint: 'regenerate the key in the provider console',
    };
  }

  // Model deprecated / not found at provider: API returned 404 or "model not
  // found / does not exist / deprecated / unavailable". Caller should re-run
  // `aeo-platform init` to enumerate currently-available models. Must be
  // classified BEFORE rate-limit, otherwise a bare 404 might match the 4xx
  // generic regex and be interpreted as transient.
  if (/\b404\b|model.*(not found|does not exist|deprecated|invalid|unsupported|unavailable)|invalid.*model/i.test(msg)) {
    return {
      retryable: false,
      category: 'model-deprecated',
      reason: 'configured model is no longer available at the provider',
      fixHint: 're-run `aeo-platform init` to refresh model selection',
    };
  }

  // Rate-limit / quota exhausted / transient server overload: retryable per-provider.
  // Includes Gemini "high demand" / Anthropic "overloaded" / generic 5xx — all
  // transient signals that justify either an inner retry or a provider-fallback.
  if (/\b(408|429|502|503|504|529)\b|rate.?limit|rate_limit|too.?many.?requests|resource.*exhausted|quota.*exceeded|high.?demand|overload|service.?unavailable|temporarily.?unavailable|request.?timeout/i.test(msg)) {
    return {
      retryable: true,
      category: 'rate-limit',
      reason: 'rate-limit, quota, or transient server overload',
      fixHint: 'wait a minute, or use a different provider',
      rateLimit: parseRateLimitInfo(msg),
    };
  }

  // ─── Environment-side: NOT retryable across providers ───

  // Network: OS-level errno codes from Node's net stack. These beat regex on
  // message because Node sets err.code explicitly.
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET'].includes(code)
      || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EAI_AGAIN|ECONNRESET|getaddrinfo|socket hang up|fetch failed|network/i.test(msg)) {
    return {
      retryable: false,
      category: 'network',
      reason: 'network unreachable or DNS failed',
      fixHint: 'check your internet connection and try again',
    };
  }

  // Bot protection: Cloudflare / captcha challenge on the user's own site.
  // Our fetchSite layer detects this by scanning HTML body for markers;
  // if caller re-throws with these phrases we classify here too.
  if (/cloudflare|captcha|bot.*protect|challenge.*page|access.*denied.*forbidden/i.test(msg)) {
    return {
      retryable: false,
      category: 'bot-protection',
      reason: 'site is behind bot protection (Cloudflare/captcha)',
      fixHint: 'temporarily whitelist aeo-platform\'s User-Agent, or use --keywords to skip site fetch',
    };
  }

  // Site fetch: user's own domain returned 4xx/5xx or SSL failed. Distinct
  // from network errors because connectivity works but the site itself refuses.
  if (/SSL|certificate|ERR_CERT|self.signed|unable to verify.*certificate/i.test(msg)) {
    return {
      retryable: false,
      category: 'site-fetch',
      reason: 'SSL/certificate error on target domain',
      fixHint: 'verify your site\'s certificate, or use http:// if the cert is intentionally self-signed',
    };
  }
  if (/^(40[0-9]|50[0-9])\s/i.test(msg) && /https?:\/\//.test(msg)) {
    return {
      retryable: false,
      category: 'site-fetch',
      reason: 'target domain returned an HTTP error',
      fixHint: 'check the domain is live and reachable from this machine',
    };
  }

  // Filesystem: writes to aeo-responses/, read of .aeo-tracker.json, etc.
  if (['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EROFS', 'EISDIR'].includes(code)
      || /EACCES|EPERM|ENOSPC|EROFS|EISDIR|permission denied/i.test(msg)) {
    // ENOENT alone is ambiguous — config file missing is a config error, not fs.
    // So we check path clues when available.
    const looksLikeConfig = /\.aeo-tracker\.json|config/i.test(msg);
    if (code === 'ENOENT' && looksLikeConfig) {
      return {
        retryable: false,
        category: 'config',
        reason: 'config file not found — run `aeo-platform init` first',
        fixHint: 'run `aeo-platform init` in this directory before `run`',
      };
    }
    return {
      retryable: false,
      category: 'filesystem',
      reason: code === 'EACCES' || code === 'EPERM' ? 'permission denied on filesystem' :
              code === 'ENOSPC' ? 'disk full' :
              code === 'EROFS' ? 'filesystem is read-only' : 'filesystem error',
      fixHint: 'check directory permissions and disk space',
    };
  }

  // Config: corrupted JSON in .aeo-tracker.json specifically. We only match
  // when the config file path is mentioned in the error message — a bare
  // JSON SyntaxError could equally mean an API provider returned HTML (a 5xx
  // error page) instead of JSON, which is NOT a config issue. Generic JSON
  // SyntaxError → 'other' so the real cause surfaces to the bug report.
  if (/\.aeo-tracker\.json/i.test(msg)) {
    if (err instanceof SyntaxError || /invalid|malformed|Unexpected token/i.test(msg)) {
      return {
        retryable: false,
        category: 'config',
        reason: 'config file has invalid JSON',
        fixHint: 'check .aeo-tracker.json for syntax errors, or re-run `aeo-platform init`',
      };
    }
  }
  if (/config.*(missing|invalid|malformed)/i.test(msg)) {
    return {
      retryable: false,
      category: 'config',
      reason: 'config is missing or malformed',
      fixHint: 're-run `aeo-platform init` to regenerate a valid config',
    };
  }

  // ─── Real bugs ───
  return {
    retryable: false,
    category: 'other',
    reason: 'unknown error',
  };
}

/**
 * Top-level classifier used by the global catch in bin/aeo-tracker.js. Currently
 * an alias for classifyProviderError — the split exists so we can evolve one
 * without breaking the other.
 */
export const classifyAeoError = classifyProviderError;

/**
 * Safely convert an unknown caught value to a human-readable string.
 *
 * Handles the edge cases where code throws something weird:
 *   throw null                    → "(no error details)"
 *   throw undefined               → "(no error details)"
 *   throw ""                      → "(no error details)"
 *   throw new Error()             → "(no error details)"  (empty message)
 *   throw new Error("boom")       → "boom"
 *   throw "plain string"          → "plain string"
 *   throw { message: "x" }        → "x"
 *
 * Never returns the literal strings "null" or "undefined" — those panic
 * users reading error panels ("Error: null" reads like a bug in aeo-tracker
 * itself, not the actual failure).
 */
export function errToString(err) {
  if (err == null) return '(no error details)';
  if (err instanceof Error) {
    if (err.message) return err.message;
    // `new Error().toString()` returns "Error" (the class name) — useless to the
    // reader. Filter out those default strings and show a friendly message instead.
    const s = err.toString();
    return (s === 'Error' || s === '[object Error]' || s.startsWith('Error: ') && s.length <= 7) ? '(no error details)' : s;
  }
  if (typeof err === 'string') return err || '(no error details)';
  if (typeof err === 'object' && 'message' in err) {
    const m = String(err.message);
    return m || '(no error details)';
  }
  const s = String(err);
  return s === '[object Object]' ? '(no error details)' : s;
}

/**
 * Extract structured rate-limit info from a 429 error message.
 *
 * OpenAI returns a rich body like:
 *   "Rate limit reached for gpt-5-search-api ... on tokens per min (TPM):
 *    Limit 6000, Used 6000, Requested 14. Please try again in 140ms."
 * — full TPM/RPM/RPD parse possible.
 *
 * Anthropic / Gemini / Perplexity emit terser strings without structured numbers,
 * so most invocations degrade to kind='unknown' with limit/used/requested = null.
 * The cooldown gate + ledger handle 'unknown' gracefully (30s default cooldown,
 * no learnTpmLimit fed to ledger).
 *
 * @param {string} msg
 * @returns {{kind: 'tpm'|'rpm'|'rpd'|'unknown', limit: number|null, used: number|null, requested: number|null, retryAfterMs: number|null, windowMs: number}}
 */
export function parseRateLimitInfo(msg) {
  const out = {
    kind: 'unknown',
    limit: null,
    used: null,
    requested: null,
    retryAfterMs: null,
    windowMs: 60_000,
  };
  if (!msg || typeof msg !== 'string') return out;

  // Kind selector — order matters: 'tokens per day' must beat 'tokens per min'.
  if (/tokens?\s*per\s*day|TPD|requests?\s*per\s*day|RPD/i.test(msg)) {
    out.kind = 'rpd';
    out.windowMs = 86_400_000;
  } else if (/tokens?\s*per\s*min|TPM/i.test(msg)) {
    out.kind = 'tpm';
  } else if (/requests?\s*per\s*min|RPM/i.test(msg)) {
    out.kind = 'rpm';
  }

  // OpenAI-style: "Limit 6000, Used 6000, Requested 14. Please try again in 140ms"
  const openaiMatch = msg.match(/Limit\s+(\d+).*?Used\s+(\d+).*?Requested\s+(\d+).*?try again in\s+([\d.]+)(ms|s)/i);
  if (openaiMatch) {
    out.limit = parseInt(openaiMatch[1], 10);
    out.used = parseInt(openaiMatch[2], 10);
    out.requested = parseInt(openaiMatch[3], 10);
    const t = parseFloat(openaiMatch[4]);
    out.retryAfterMs = openaiMatch[5].toLowerCase() === 's' ? Math.round(t * 1000) : Math.round(t);
    return out;
  }

  // Anthropic best-effort: "limit of 50000 tokens"
  const anthroMatch = msg.match(/limit of\s+(\d+)\s+tokens?/i);
  if (anthroMatch) {
    out.limit = parseInt(anthroMatch[1], 10);
    // Anthropic doesn't expose used/requested in body; ledger can't learn from this alone.
    return out;
  }

  return out;
}

export const PROVIDER_BILLING_URLS = {
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  anthropic: 'https://console.anthropic.com/settings/billing',
  gemini: 'https://aistudio.google.com/apikey',
  perplexity: 'https://www.perplexity.ai/settings/api',
};
