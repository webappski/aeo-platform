// Answer-surface model-drift detection.
//
// WHY: the per-cell record stores the model the tracker REQUESTED (the
// discovered / configured id, e.g. `gemini-3.5-flash`). Providers expose the
// model they ACTUALLY served in the raw response. When a floating alias is
// hot-swapped server-side (Google rolls `gemini-2.5-flash` → a newer release
// with ~2-week notice; OpenAI/Anthropic pin a dated snapshot under a stable
// pointer) the two can diverge. For a month-over-month comparable timeline
// (the frozen-basket measurement standard) a SILENT answer-model swap would
// poison the trend. This module surfaces the divergence as provenance +
// a loud WARN instead of letting it pass unseen.
//
// Pure functions only — no I/O. Unit-tested as non-lying pure functions
// (R37: pure reducer with no UI surface) AND exercised on the run path by an
// E2E that injects a mismatched raw response.

/**
 * Extract the model id the provider reports it actually served, from the raw
 * API response. Returns null when the provider exposes no such field (then no
 * drift claim can be made — absence is not divergence).
 *
 * @param {string} provider  'openai' | 'anthropic' | 'gemini' | 'perplexity'
 * @param {object} raw       the unparsed provider response (result.raw)
 * @returns {string|null}    served model id, or null if unavailable
 */
export function resolvedModelFrom(provider, raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Gemini reports the served model under `modelVersion`; the OpenAI-style
  // providers (OpenAI, Anthropic, Perplexity sonar) echo it under `model`.
  const field = provider === 'gemini' ? raw.modelVersion : raw.model;
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/**
 * Decide whether a requested→resolved pair is a genuine drift.
 *
 * NOT drift (returns false):
 *   - either side missing/empty (nothing to compare),
 *   - exact match (`claude-sonnet-4-6` === `claude-sonnet-4-6`),
 *   - resolved is the requested id extended by a snapshot/date suffix
 *     (`gpt-5-search-api` → `gpt-5-search-api-2025-10-14`). This is the normal,
 *     benign alias→pinned-snapshot resolution and must NOT warn — otherwise
 *     every OpenAI cell would false-positive.
 *
 * IS drift (returns true):
 *   - both present and neither is a prefix of the other, i.e. the served model
 *     is a different lineage than requested
 *     (`gemini-2.5-flash` requested, `gemini-3.5-flash` served).
 *
 * @param {string|null} requested  the id we asked for (cellModel)
 * @param {string|null} resolved   the id the provider says it served
 * @returns {boolean}
 */
export function isModelDrift(requested, resolved) {
  if (!requested || !resolved) return false;
  if (requested === resolved) return false;
  // Benign alias→snapshot: resolved starts with `${requested}-` (date/snapshot
  // suffix). A bare `startsWith(requested)` would wrongly clear
  // `gemini-2.5` vs `gemini-2.5-flash`; require the boundary hyphen.
  if (resolved.startsWith(`${requested}-`)) return false;
  // Symmetric guard: if the requested id is itself a snapshot of a shorter
  // resolved pointer (rare, but keep the relation honest), also treat as benign.
  if (requested.startsWith(`${resolved}-`)) return false;
  return true;
}

/**
 * Full answer-cell drift decision — the testable atom the run loop calls so the
 * warn line, provenance stamp, and tally key are all derived in ONE pure place
 * (the loop stays a thin caller; see the silent-substitute test for the same
 * house pattern). Combines resolvedModelFrom + isModelDrift.
 *
 * @param {string} provider       provider name
 * @param {string} requestedModel the model we asked for (cellModel)
 * @param {object} raw            the provider's raw response (result.raw)
 * @returns {{
 *   resolvedModel: string|null,
 *   isDrift: boolean,
 *   warnLine: string|null,        human WARN text (null when no drift)
 *   provenance: ?{requestedModel:string, resolvedModel:string},  record fields (null when no drift)
 *   tallyKey: string|null         stable per-(provider, requested→resolved) key (null when no drift)
 * }}
 */
export function evaluateModelDrift(provider, requestedModel, raw) {
  const resolvedModel = resolvedModelFrom(provider, raw);
  const isDrift = isModelDrift(requestedModel, resolvedModel);
  if (!isDrift) {
    return { resolvedModel, isDrift: false, warnLine: null, provenance: null, tallyKey: null };
  }
  return {
    resolvedModel,
    isDrift: true,
    warnLine: `model drift — ${provider} requested ${requestedModel}, served ${resolvedModel} (floating-alias hot-swap; pin the model to keep the timeline comparable)`,
    provenance: { requestedModel, resolvedModel },
    tallyKey: `${provider}:${requestedModel}→${resolvedModel}`,
  };
}
