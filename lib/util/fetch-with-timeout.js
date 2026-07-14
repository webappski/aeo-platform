// Universal fetch wrapper with hard timeout.
//
// Why: Node.js native `fetch` has no built-in timeout. A hung TCP/TLS or a
// slow server keeps the call pending until the OS-level keepalive fires
// (~2 min on Windows) or forever on some networks. This wrapper enforces a
// deadline AT THE FETCH LAYER, so any code calling `fetchWithTimeout(...)`
// is guaranteed to settle within `timeoutMs` regardless of provider/network.
//
// On timeout, throws an Error with:
//   - name: 'TimeoutError'
//   - code: 'ETIMEDOUT'  ← classifyProviderError() tags this `network`, so _retry.js
//                          gives it a small bounded retry (NETWORK_MAX_ATTEMPTS)
//   - message: `fetch timed out after ${ms}ms: ${host}`
//
// On externally-aborted signal (caller's AbortController.abort()), bubbles up
// the original AbortError unchanged. Callers distinguish by `err.name`.
//
// Used by runtime provider calls (gemini.js / openai.js / anthropic.js /
// perplexity.js), discover.js HTTP fetchers (/v1/models per provider), and
// site-fetch / authority HTTP modules.

// Defaults picked to cover real-world response times without firing on
// legitimate slow requests:
//   - bootstrap (init-time, interactive): 30s — user is waiting at the prompt
//   - runtime (run command, web-search models): 60s — Perplexity sonar-reasoning
//     and gpt-5-search-api can legitimately take 30-50s on complex queries
//   - site (HTML fetch of user's domain): 15s — small page, low latency expected
const DEFAULT_TIMEOUTS = {
  bootstrap: 30_000,
  runtime: 60_000,
  site: 15_000,
};

// Env override read at module-load (matches _retry.js convention so tests
// can preset AEO_HTTP_TIMEOUT_MS before importing this module).
const ENV_GLOBAL = clampMs(parseInt(process.env.AEO_HTTP_TIMEOUT_MS || '', 10));
const ENV_BOOTSTRAP = clampMs(parseInt(process.env.AEO_BOOTSTRAP_TIMEOUT_MS || '', 10));
const DISABLED = process.env.AEO_NO_HTTP_TIMEOUT === '1';

function clampMs(n) {
  // Min 10ms (tests use sub-second values); max 10 min. Below 10ms is almost
  // certainly a unit confusion (seconds vs ms) — refuse silently and let the
  // call run with no timeout from this path. Above 10 min is treated as the
  // cap (matches typical CI per-step ceilings).
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 10) return null;
  if (n > 600_000) return 600_000;
  return n;
}

function resolveTimeout(opts) {
  if (DISABLED) return null;
  if (Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0) return clampMs(opts.timeoutMs);
  if (ENV_GLOBAL != null) return ENV_GLOBAL;
  const kind = opts?.kind || 'runtime';
  if (kind === 'bootstrap' && ENV_BOOTSTRAP != null) return ENV_BOOTSTRAP;
  return DEFAULT_TIMEOUTS[kind] ?? DEFAULT_TIMEOUTS.runtime;
}

// Compose external signal + timeout signal. AbortSignal.any() is Node 20.3+;
// for 20.0-20.2 (engines.node says >=20.0) we fall back to a manual combiner.
function composeSignals(externalSignal, timeoutMs) {
  if (timeoutMs == null) return externalSignal || undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([externalSignal, timeoutSignal]);
  }
  // Fallback for Node 20.0-20.2: combine into a new controller.
  const ac = new AbortController();
  const onAbort = (reason) => ac.abort(reason);
  if (externalSignal.aborted) ac.abort(externalSignal.reason);
  else externalSignal.addEventListener('abort', () => onAbort(externalSignal.reason), { once: true });
  if (timeoutSignal.aborted) ac.abort(timeoutSignal.reason);
  else timeoutSignal.addEventListener('abort', () => onAbort(timeoutSignal.reason), { once: true });
  return ac.signal;
}

function hostFromUrl(url) {
  try { return new URL(url).host; } catch { return '<unknown-host>'; }
}

/**
 * Drop-in wrapper around `fetch` with mandatory timeout.
 *
 * Signal precedence: if both `init.signal` and `opts.signal` are supplied,
 * `init.signal` wins (matches standard fetch convention — init owns the
 * request). The chosen external signal is composed with an internal
 * AbortSignal.timeout(timeoutMs); whichever fires first wins.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]   Standard fetch init (method/headers/body).
 *                               If init.signal is set, it composes with the
 *                               timeout signal (whichever aborts first wins).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  Explicit timeout. Otherwise resolved from
 *                                   env (AEO_HTTP_TIMEOUT_MS / AEO_BOOTSTRAP_TIMEOUT_MS)
 *                                   or kind default.
 * @param {AbortSignal} [opts.signal]  Alternative way to supply external signal.
 *                                     Only used when init.signal is absent.
 * @param {'bootstrap'|'runtime'|'site'} [opts.kind='runtime']  Default-bucket selector.
 * @returns {Promise<Response>}
 * @throws {Error} On timeout: { name: 'TimeoutError', code: 'ETIMEDOUT' }.
 *                On external abort: original AbortError.
 *                On network failure: original fetch error.
 */
export async function fetchWithTimeout(url, init = {}, opts = {}) {
  const timeoutMs = resolveTimeout(opts);
  const externalSignal = init.signal || opts.signal;
  const signal = composeSignals(externalSignal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    // Distinguish our timeout from caller's abort. AbortSignal.timeout()
    // aborts with a TimeoutError-shaped DOMException; bare AbortController
    // .abort() aborts with AbortError. Both surface here as the same thrown
    // value, so we check whether OUR timeout fired vs the caller's signal.
    const timeoutFired = timeoutMs != null && err?.name === 'TimeoutError';
    const externalAborted = externalSignal?.aborted === true;
    if (timeoutFired && !externalAborted) {
      const e = new Error(`fetch timed out after ${timeoutMs}ms: ${hostFromUrl(url)}`);
      e.name = 'TimeoutError';
      e.code = 'ETIMEDOUT';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

// Exported for tests — lets a test set explicit timeouts without env juggling.
export const _internals = { DEFAULT_TIMEOUTS, resolveTimeout, composeSignals };
