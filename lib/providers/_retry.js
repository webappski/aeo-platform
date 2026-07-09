// Provider call middleware: per-provider semaphore + per-(provider, model)
// cooldown gate + smart retries.
//
// Why three primitives layered together:
//   - withRetry(label, fn)         — retries transient errors. For rate-limit
//                                    it does NOT sleep and does NOT log; the
//                                    cooldown gate below handles wait + signal.
//                                    For overload/network it keeps the fast
//                                    2s loop because those resolve quickly.
//   - withProviderCall({sem,cd},fn)— wraps the actual fetch. acquire/release
//                                    semaphore (RPM defence, per-provider) +
//                                    wait cooldown gate (TPM defence, per-
//                                    (provider, model)). Re-checks cooldown
//                                    AFTER acquire to close the race where
//                                    another cell pushes cooldown out.
//   - maybeSetCooldown(err,cd,ms)  — called by provider modules on every throw
//                                    path. Helper itself decides (via
//                                    classifyProviderError) whether the error
//                                    is rate-limit-class and worth raising
//                                    the gate; callers don't duplicate the
//                                    check. This avoids missing edge-cases
//                                    where caller's local notion of
//                                    "rate-limit" diverges from classifier's.
//
// Wrap order matters: withRetry(withProviderCall(fetch)) — semaphore is
// acquired+released per attempt. The previous flip (withProviderCall(
// withRetry(fetch))) pinned the slot for the whole retry chain, defeating
// cooldown gate semantics because queued cells couldn't even reach the gate.

import { classifyProviderError } from './classify-error.js';
import {
  reserve as reserveTokens,
  confirm as confirmTokens,
  release as releaseTokens,
  shouldWait,
  getFirstTokenTimestampInWindow,
  estimatePerRequest,
} from './tpm-ledger.js';
import { extractUsage } from './pricing.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

// Per-provider concurrency cap (RPM defence). 6 is grounded in the confirmed
// RPM floor across providers (Perplexity's 150 rpm is the tightest budget of the four).
// Override with AEO_PROVIDER_CONCURRENCY for higher tiers; set to 1 for
// ultra-conservative serial mode.
const CONCURRENCY_LIMIT = Math.max(
  1,
  parseInt(process.env.AEO_PROVIDER_CONCURRENCY || '6', 10) || 6,
);

// Transient overload (Anthropic "overloaded", Gemini "high demand") resolves
// in seconds — keep the fast retry loop with jitter.
const OVERLOAD_MAX_ATTEMPTS = process.env.AEO_NO_RETRY === '1' ? 1 : 30;
const OVERLOAD_INTERVAL_MS = 2000;
const OVERLOAD_JITTER_MS = 500;

// Rate-limit: budget-based retry (replaces old "3 attempt" cap which gave up
// in ~420ms when cooldown was 140ms). New shape: keep retrying until BOTH the
// min-attempts floor is reached AND the total wait budget is exhausted.
// AEO_NO_RETRY=1 collapses to single-attempt-no-wait for tests.
const RATE_LIMIT_MIN_ATTEMPTS = process.env.AEO_NO_RETRY === '1' ? 1 : 5;
const RATE_LIMIT_MAX_WAIT_MS  = process.env.AEO_NO_RETRY === '1' ? 0 : 300_000;

// Cooldown reentry cap: bounds the inner while-loop in withProviderCall so a
// pathological case (many cells all pushing cooldown forward, OR ledger
// repeatedly saying "wait" while other cells extend the gate) can't pin one
// cell forever. Bumped 5→10 to absorb ledger waits alongside cooldown
// re-engagements. Safety net at exceed: withRetry's wait-budget cap takes over.
const MAX_REENTRIES = 10;

// Default cooldown when provider returns 429 without a Retry-After header.
// Covers typical per-minute TPM/RPM windows.
const COOLDOWN_FALLBACK_MS = 30_000;

// ─── Retry-After header helper ───────────────────────────────────────────────

/**
 * Parse the HTTP `Retry-After` response header into milliseconds.
 * Returns 0 if absent or unparseable. Accepts both forms per RFC 7231:
 *   - integer seconds (e.g. "30")
 *   - HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
 *
 * @param {Response} res
 * @returns {number}  milliseconds; 0 if no usable value
 */
export function parseRetryAfter(res) {
  const v = res?.headers?.get?.('retry-after');
  if (!v) return 0;
  if (/^\d+$/.test(v.trim())) {
    const sec = Number(v);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

// ─── Cooldown gate ───────────────────────────────────────────────────────────

/** @type {Map<string, number>}  cdKey -> timestamp (ms) until which gate is closed */
const cooldownUntil = new Map();

/** @type {Map<string, number>}  cdKey -> last cooldown timestamp we logged */
const lastLoggedFor = new Map();

/**
 * Raise the cooldown gate for a (provider, model) key. Always extends the
 * existing gate (Math.max) — never shrinks it. Concurrent calls are safe
 * because JS event loop is single-threaded and these ops are synchronous.
 *
 * @param {string} cdKey   e.g. 'openai:gpt-5-search-api'
 * @param {number} ms      milliseconds to keep the gate closed; 0/invalid falls
 *                         back to COOLDOWN_FALLBACK_MS (30s)
 */
export function setProviderCooldown(cdKey, ms) {
  const effectiveMs = (Number.isFinite(ms) && ms > 0) ? ms : COOLDOWN_FALLBACK_MS;
  const newTimestamp = Date.now() + effectiveMs;
  const existing = cooldownUntil.get(cdKey) || 0;
  cooldownUntil.set(cdKey, Math.max(existing, newTimestamp));
}

/**
 * Wait until cooldown gate for cdKey is open. Logs ONE line when entering
 * a wait, deduped by cooldown timestamp — so a re-entered cell sleeping on
 * the same gate doesn't print twice. When the gate is extended by another
 * cell mid-sleep, the new timestamp triggers a fresh log on the next wait.
 *
 * Returns the actual ms slept (0 if no wait was needed). withRetry accumulates
 * this into its total-wait budget so a sequence of cooldown-then-fail-then-
 * cooldown-then-fail eventually gives up by elapsed wall-clock, not attempt count.
 *
 * @param {string} cdKey
 * @param {string} label  provider label shown in log (e.g. 'OpenAI')
 * @returns {Promise<number>}  ms slept
 */
export async function waitForProviderCooldown(cdKey, label, opts = {}) {
  const until = cooldownUntil.get(cdKey) || 0;
  const wait = until - Date.now();
  if (wait <= 0) return 0;
  // Live status manager (when supplied) owns the user-facing message — caller
  // emits onStatus({kind:'cooldown'}) and updates its row in place. We stay
  // silent in that case to avoid double-writing the cooldown info.
  if (!opts.silent && lastLoggedFor.get(cdKey) !== until) {
    process.stderr.write(
      `  ${label} provider cooldown — waiting ${(wait / 1000).toFixed(1)}s for ${cdKey} TPM window\n`,
    );
    lastLoggedFor.set(cdKey, until);
  }
  await new Promise(r => setTimeout(r, wait));
  return wait;
}

/**
 * Compute honest cooldown duration from parsed rate-limit info.
 *
 * Why: OpenAI's `Retry-After: 0.14s` is the BEST-case calculation
 * `(requested / limit) * windowMs` assuming tokens are spread uniformly across
 * the 60s window. In reality 6 parallel cells burst ~5000 tokens in the first
 * second — through 140ms still ~4986 tokens are in-window, so we'd 429 again.
 *
 * Strategy:
 *   - tpm/rpm with used >= limit: prefer dynamic floor from ledger
 *     (when oldest in-window token expires), fallback 30s = half-window.
 *   - rpd: trust the header if it's < 24h, else 5 min.
 *   - unknown kind: degrade to existing 30s fallback.
 *   - burst case (used < limit but 429 anyway): cap headerMs at 5s.
 *
 * @param {{rateLimit?: {kind: string, limit: number|null, used: number|null, windowMs: number}} | undefined} parsed
 * @param {number} headerMs
 * @param {string} cdKey
 * @returns {number}
 */
function computeHonestCooldownMs(parsed, headerMs, cdKey) {
  const rl = parsed?.rateLimit;
  if (!rl || rl.kind === 'unknown') {
    return headerMs > 0 ? headerMs : COOLDOWN_FALLBACK_MS;
  }
  if (rl.kind === 'rpd') {
    return headerMs > 0 && headerMs < 24 * 3600_000 ? headerMs : 5 * 60_000;
  }
  // tpm / rpm
  if (rl.used != null && rl.limit != null && rl.used >= rl.limit) {
    const tFirst = getFirstTokenTimestampInWindow(cdKey);
    if (tFirst != null) {
      const dynamicMs = Math.max(0, (tFirst + (rl.windowMs || 60_000)) - Date.now());
      return Math.max(headerMs, dynamicMs);
    }
    return Math.max(headerMs, 30_000);
  }
  // Burst case — used < limit but provider returned 429 anyway (e.g. RPM hit
  // before TPM filled). Short trusted wait.
  return headerMs > 0 ? Math.min(headerMs, 5_000) : 1_000;
}

/**
 * Called by provider modules unconditionally on every throw path. The helper
 * itself decides (via classifyProviderError) whether the error is rate-limit
 * class and worth raising the cooldown gate. Callers MUST NOT add their own
 * `if (isRateLimit)` guard — that risks divergence between caller's notion of
 * rate-limit and classifier's.
 *
 * @param {Error} err
 * @param {string} cdKey
 * @param {number} headerMs   0 if no Retry-After header was available;
 *                            computeHonestCooldownMs decides the actual wait
 *                            (using ledger data when available, fallback otherwise)
 */
export function maybeSetCooldown(err, cdKey, headerMs) {
  const parsed = classifyProviderError(err);
  if (parsed.category !== 'rate-limit') return;
  const cooldownMs = computeHonestCooldownMs(parsed, headerMs || 0, cdKey);
  setProviderCooldown(cdKey, cooldownMs);
}

// ─── Per-provider semaphore (RPM defence) ────────────────────────────────────

// Display labels for cooldown log messages — keeps user-facing output
// consistent with withRetry's labels ('OpenAI transient error…') instead
// of lower-case semaphore keys. Falls back to capitalised sem if missing.
const DISPLAY_LABELS = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  perplexity: 'Perplexity',
};

/** @type {Map<string, {active: number, queue: Array<() => void>}>} */
const semaphores = new Map();

function acquire(name) {
  let s = semaphores.get(name);
  if (!s) {
    s = { active: 0, queue: [] };
    semaphores.set(name, s);
  }
  if (s.active < CONCURRENCY_LIMIT) {
    s.active++;
    return Promise.resolve();
  }
  return new Promise(resolve => s.queue.push(resolve));
}

function release(name) {
  const s = semaphores.get(name);
  if (!s) return;
  const next = s.queue.shift();
  if (next) {
    // Hand the slot directly to the next waiter — keeps `active` stable and
    // avoids a race where two awaiters could see active==LIMIT-1 simultaneously.
    next();
  } else {
    s.active--;
  }
}

// ─── Provider call wrapper (semaphore + cooldown + actual fn) ────────────────

/**
 * Run `fn` under the per-provider semaphore AND the per-(provider, model)
 * cooldown gate. Re-checks cooldown after acquire to close the race where
 * another cell raises the gate between waitForProviderCooldown and acquire.
 *
 * Note: this is invoked per retry attempt (withRetry wraps it from the
 * outside), so the slot is released between attempts. Cross-provider calls
 * (e.g. main on OpenAI + sub-call on Gemini) are independent — each provider
 * has its own semaphore and its own cooldown map keyed by model. A sub-call
 * on the SAME provider but DIFFERENT model is unaffected by the main call's
 * cooldown (cdKey is per-(provider, model)).
 *
 * @template T
 * @param {Object} keys
 * @param {string} keys.sem  per-provider semaphore key (e.g. 'openai')
 * @param {string} keys.cd   per-(provider, model) cooldown key (e.g. 'openai:gpt-5-search-api')
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProviderCall({ sem, cd, onStatus }, fn) {
  let reEntries = 0;
  while (true) {
    if (reEntries > MAX_REENTRIES) {
      // Cooldown keeps getting pushed forward by other cells, OR the ledger
      // keeps saying "wait". Surface as transient so withRetry's wait-budget
      // cap takes over instead of pinning this cell forever.
      throw new Error(`Cooldown re-entry exhausted for ${cd} — provider keeps pushing rate limit`);
    }

    // Cooldown gate. Emit a status event with the remaining wait ms so a live
    // UI can show a live countdown; suppress the legacy stderr line when
    // onStatus is wired (manager owns the user-facing message).
    const cooldownUntilTs = cooldownUntil.get(cd) || 0;
    const cooldownMs = cooldownUntilTs - Date.now();
    if (cooldownMs > 0) {
      onStatus?.({ kind: 'cooldown', ms: cooldownMs, cdKey: cd });
    }
    await waitForProviderCooldown(cd, DISPLAY_LABELS[sem] || sem, { silent: !!onStatus });

    // Ledger preflight: if the rolling 60s window is near full, sleep until
    // enough tokens age out. Cheaper than firing into a guaranteed 429.
    // No-op when learnedTpmLimit is null (first run — learn from response).
    const ledgerDecision = shouldWait(cd, Date.now());
    if (ledgerDecision.wait) {
      onStatus?.({ kind: 'ledger-wait', ms: ledgerDecision.ms, cdKey: cd });
      await new Promise(r => setTimeout(r, ledgerDecision.ms));
      reEntries++;
      continue;
    }

    await acquire(sem);
    if (Date.now() < (cooldownUntil.get(cd) || 0)) {
      release(sem);
      reEntries++;
      continue;
    }

    // Reserve our estimated token cost BEFORE fire — race-safe accounting.
    // Other concurrent cells see this reservation in shouldWait, even though
    // we haven't completed yet.
    const reservationId = reserveTokens(cd, estimatePerRequest(cd));
    onStatus?.({ kind: 'firing', cdKey: cd });
    try {
      const res = await fn();
      // Replace reservation with actual usage from response.
      // res shape (per provider): { text, citations, raw }
      // Provider name comes from cdKey: 'openai:gpt-5' -> 'openai'.
      const provider = cd.split(':')[0];
      const usage = extractUsage(provider, res?.raw);
      const actualTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      confirmTokens(cd, reservationId, actualTokens > 0 ? actualTokens : estimatePerRequest(cd));
      onStatus?.({
        kind: 'tokens',
        input: usage.inputTokens || 0,
        output: usage.outputTokens || 0,
        cdKey: cd,
      });
      return res;
    } catch (err) {
      // Call failed — release the reservation so future cells don't see
      // phantom in-flight tokens that never resolved.
      releaseTokens(cd, reservationId);
      throw err;
    } finally {
      release(sem);
    }
  }
}

// ─── Retry classification + scheduling ───────────────────────────────────────

const TRANSIENT_RE =
  /\b(408|429|502|503|504)\b|rate.?limit|too.?many.?requests|resource.*exhausted|quota.*exceeded|high.?demand|overload|service.?unavailable|temporarily.?unavailable|try.?again.?later|server.?error|internal.?error|request.?timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i;

export function isTransientError(err) {
  const msg = String(err?.message || err || '');
  const code = err?.code || '';
  return TRANSIENT_RE.test(msg) || TRANSIENT_RE.test(code);
}

function isRateLimit(err) {
  return classifyProviderError(err).category === 'rate-limit';
}

function overloadWaitMs() {
  const jitter = Math.floor((Math.random() - 0.5) * 2 * OVERLOAD_JITTER_MS);
  return OVERLOAD_INTERVAL_MS + jitter;
}

// ─── Retry wrapper ───────────────────────────────────────────────────────────

/**
 * Call `fn` and retry on transient errors only.
 *
 * Rate-limit path (budget-based): the cooldown gate inside withProviderCall
 * owns the actual sleep + log. withRetry tracks elapsed wall-clock and gives
 * up only when BOTH conditions hold:
 *   - attempt >= RATE_LIMIT_MIN_ATTEMPTS (floor)
 *   - elapsed >= RATE_LIMIT_MAX_WAIT_MS  (budget)
 * This replaces the old "fail after 3 attempts" cap that would give up in
 * ~420ms when Retry-After was 140ms.
 *
 * Overload path (transient 5xx, network): fast 2s loop with jitter, log
 * first attempt only.
 *
 * @template T
 * @param {string} label  Provider name for log/error context (e.g. 'OpenAI')
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRetry(label, fn, opts = {}) {
  const { onStatus } = opts;
  let totalWaitMs = 0;
  let firstRetryLogged = false;
  let attempt = 1;
  const startedAt = Date.now();
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err)) throw err;

      // Optional debug log — one line per retry attempt with category + elapsed.
      // Gated by AEO_DEBUG=1 to avoid noise in normal multi-cell `run` output.
      // Most useful for diagnosing bootstrap path where a hidden 401/429/500
      // would otherwise be swallowed by retry loop.
      if (process.env.AEO_DEBUG === '1') {
        const elapsedSoFar = Date.now() - startedAt;
        const category = isRateLimit(err) ? 'rate-limit' : 'overload';
        process.stderr.write(
          `  [retry] ${label} attempt=${attempt} category=${category} elapsed=${elapsedSoFar}ms msg="${(err?.message || '').slice(0, 100)}"\n`,
        );
      }

      if (isRateLimit(err)) {
        // Budget check: only give up if we've burned enough wall-clock AND
        // tried enough attempts. The cooldown gate inside withProviderCall
        // owns the actual wait — by the time we get back here, time has passed.
        const elapsed = Date.now() - startedAt;
        if (attempt >= RATE_LIMIT_MIN_ATTEMPTS && elapsed >= RATE_LIMIT_MAX_WAIT_MS) {
          process.stderr.write(
            `  ${label} gave up after ${attempt} attempts (~${Math.round(elapsed / 1000)}s total wait — provider keeps rate-limiting)\n`,
          );
          throw err;
        }
        // Bump attempt and re-enter — withProviderCall will block on gate again.
        attempt++;
        onStatus?.({ kind: 'retrying', attempt, label });
        continue;
      }

      // Overload / transient 5xx — fast retry with jitter, capped by OVERLOAD_MAX_ATTEMPTS.
      if (attempt >= OVERLOAD_MAX_ATTEMPTS) {
        if (firstRetryLogged) {
          process.stderr.write(
            `  ${label} gave up after ${attempt} attempts (~${(totalWaitMs / 1000).toFixed(0)}s total wait)\n`,
          );
        }
        throw err;
      }
      const wait = overloadWaitMs();
      totalWaitMs += wait;
      if (!firstRetryLogged) {
        process.stderr.write(
          `  ${label} transient error — backing off ${(wait / 1000).toFixed(1)}s (1/${OVERLOAD_MAX_ATTEMPTS})\n`,
        );
        firstRetryLogged = true;
      }
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }
}
