/**
 * Per-model pricing for cost tracking.
 * Searched by prefix via startsWith — MORE SPECIFIC entries MUST come before broader ones.
 * Example: 'gpt-5.4-mini' must precede 'gpt-5.4', or mini calls will match the pro price.
 * Prices in USD per 1M tokens.
 *
 * NO generic provider-wide catch-all (no bare 'gemini'/'claude'). A model that
 * isn't explicitly listed returns null from calcCost → the caller's honest
 * "cost not tracked" path — NEVER a silently-cheap fallback. A silently-wrong
 * cheap price is worse than an obvious "untracked": it once mispriced the
 * default gemini-3.5-flash by ~20x. Every default/fallback model is covered by
 * a specific row (test/pricing-defaults-covered.test.js enforces this); keep
 * that invariant when bumping a default model.
 */
const PRICING = [
  // ── OpenAI (source: developers.openai.com/api/docs/models/*, verified 2026-07-13) ──
  { prefix: 'gpt-5.4-pro',        inputPer1M: 30.00, outputPer1M: 180.00 },
  { prefix: 'gpt-5.4-mini',       inputPer1M: 0.75,  outputPer1M: 4.50  },
  { prefix: 'gpt-5.4-nano',       inputPer1M: 0.20,  outputPer1M: 1.25  },
  { prefix: 'gpt-5.4',            inputPer1M: 2.50,  outputPer1M: 15.00 },
  { prefix: 'gpt-5.2',            inputPer1M: 1.75,  outputPer1M: 14.00 },
  { prefix: 'gpt-5.1',            inputPer1M: 1.25,  outputPer1M: 10.00 },
  // Web search is a unified built-in tool billed at $10/1k calls = $0.01/call
  // (plus retrieved content as input tokens). The legacy gpt-5-search-api SKU
  // keeps its row `perRequest` (it ALWAYS searches). General models (gpt-5-mini
  // etc.) do NOT carry `perRequest` — they also serve non-search training/
  // classify calls; the tool fee is added per-call via calcCost({webSearch})
  // ONLY when they actually search. See WEB_SEARCH_TOOL_FEE below.
  { prefix: 'gpt-5-search-api',   inputPer1M: 1.25,  outputPer1M: 10.00, perRequest: 0.01 },
  { prefix: 'gpt-5-mini',         inputPer1M: 0.25,  outputPer1M: 2.00  },
  { prefix: 'gpt-5-nano',         inputPer1M: 0.05,  outputPer1M: 0.40  },
  { prefix: 'gpt-5',              inputPer1M: 1.25,  outputPer1M: 10.00 },
  { prefix: 'gpt-4o-mini-search', inputPer1M: 0.15,  outputPer1M: 0.60,  perRequest: 0.025 },
  { prefix: 'gpt-4o-search',      inputPer1M: 2.50,  outputPer1M: 10.00, perRequest: 0.025 },
  { prefix: 'gpt-4o-mini',        inputPer1M: 0.15,  outputPer1M: 0.60  },
  { prefix: 'gpt-4o',             inputPer1M: 2.50,  outputPer1M: 10.00 },
  // ── Anthropic ────────────────────────────────────────────────────────
  { prefix: 'claude-haiku',       inputPer1M: 1.00,  outputPer1M: 5.00  },
  { prefix: 'claude-opus',        inputPer1M: 5.00,  outputPer1M: 25.00 },
  { prefix: 'claude-sonnet',      inputPer1M: 3.00,  outputPer1M: 15.00 },
  // ── Gemini ───────────────────────────────────────────────────────────
  // Source: ai.google.dev/gemini-api/docs/pricing (paid tier, verified 2026-07-13).
  // Flash "output" rates INCLUDE thinking tokens — and thinkingLevel='high'
  // (forced on gemini-3.x, see gemini.js) multiplies output token VOLUME ~5-10x,
  // so the 3.x-flash effective cost is far above its rate alone. 2.5-flash uses a
  // dynamic thinkingBudget (auto) instead, so it is the cheap classify tier.
  // Pro models are context-tiered (≤200k vs >200k); we list the base ≤200k rate,
  // which covers our short calls. NO bare 'gemini' catch-all AND no bare-version
  // ('gemini-3.1'/'gemini-2.5') fallbacks — those aren't real model ids, and an
  // unlisted variant should be null → "cost not tracked", not a silent guess.
  { prefix: 'gemini-3.5-flash',       inputPer1M: 1.50,  outputPer1M: 9.00  },
  { prefix: 'gemini-3.1-pro',         inputPer1M: 2.00,  outputPer1M: 12.00 },  // served as gemini-3.1-pro-preview
  { prefix: 'gemini-3.1-flash-lite',  inputPer1M: 0.25,  outputPer1M: 1.50  },
  { prefix: 'gemini-3-flash-preview', inputPer1M: 0.50,  outputPer1M: 3.00  },
  { prefix: 'gemini-2.5-pro',         inputPer1M: 1.25,  outputPer1M: 10.00 },
  { prefix: 'gemini-2.5-flash-lite',  inputPer1M: 0.10,  outputPer1M: 0.40  },
  { prefix: 'gemini-2.5-flash',       inputPer1M: 0.30,  outputPer1M: 2.50  },
  { prefix: 'gemini-2.0-flash',       inputPer1M: 0.10,  outputPer1M: 0.40  },
  // ── Perplexity (docs.perplexity.ai, verified 2026-07-13) ─────────────
  // The per-request search fee is tiered by search-context size (low/med/high,
  // ~$5-$14 per 1k requests). We record the LOW-context tier as the base — a
  // single flat perRequest can't model the tiers; this is a floor estimate.
  { prefix: 'sonar-reasoning-pro',inputPer1M: 2.00,  outputPer1M: 8.00,  perRequest: 0.006 },
  { prefix: 'sonar-pro',          inputPer1M: 3.00,  outputPer1M: 15.00, perRequest: 0.006 },
  { prefix: 'sonar',              inputPer1M: 1.00,  outputPer1M: 1.00,  perRequest: 0.005 },
];

/**
 * Extract token counts from a raw API response.
 * Handles OpenAI, Anthropic, Gemini, and Perplexity (OpenAI-compatible) formats.
 */
export function extractUsage(provider, raw) {
  if (provider === 'gemini') {
    const m = raw?.usageMetadata || {};
    return { inputTokens: m.promptTokenCount || 0, outputTokens: m.candidatesTokenCount || 0 };
  }
  const u = raw?.usage || {};
  return {
    inputTokens:  u.input_tokens   || u.prompt_tokens     || 0,
    outputTokens: u.output_tokens  || u.completion_tokens || 0,
  };
}

/**
 * Find the pricing row whose prefix matches `model` (first/most-specific wins),
 * or null. Single lookup shared by calcCost/estimateWeeklyCost/findPricingPrefix
 * so they can't diverge on matching semantics.
 */
function findPricingRow(model) {
  return PRICING.find(row => model.startsWith(row.prefix)) || null;
}

/**
 * The matched pricing prefix for `model`, or null if unlisted. Exported for the
 * defaults-covered guard test (asserts every default/fallback model is priced).
 * @param {string} model
 * @returns {string|null}
 */
export function findPricingPrefix(model) {
  return findPricingRow(model)?.prefix ?? null;
}

/**
 * Shallow copy of the pricing rows. Exported for the maintainer drift-checker
 * (scripts/pricing-check.mjs) which diffs this curated table against an external
 * machine-readable feed. Not used at runtime.
 * @returns {Array<{prefix: string, inputPer1M: number, outputPer1M: number, perRequest?: number}>}
 */
export function pricingRows() {
  return PRICING.map(r => ({ ...r }));
}

// Flat OpenAI web_search built-in tool fee. Source: developers.openai.com/api/
// docs/pricing — $10.00 / 1k tool calls = $0.01/call, a SINGLE flat rate (no
// low/medium/high search_context_size tiers — those belonged to the retired
// -search-preview SKUs). Retrieved page content is billed SEPARATELY as input
// tokens (already captured in usage.inputTokens), so this is only the per-call
// tool fee on top. Applied via calcCost's `opts.webSearch`, not a pricing row,
// because a general model (e.g. gpt-5-mini) also serves non-search training/
// classify calls that must NOT be charged this fee.
export const WEB_SEARCH_TOOL_FEE = 0.01;

/**
 * Calculate cost for a single API call.
 * Returns null if the model is not in the pricing table.
 *
 * @param {string} model
 * @param {{inputTokens?: number, outputTokens?: number}} usage
 * @param {{webSearchCalls?: number}} [opts]  the number of web_search tool
 *   calls this response actually made (count them from the raw `output[]`).
 *   Each is billed at WEB_SEARCH_TOOL_FEE — but ONLY for models whose pricing
 *   row has no explicit `perRequest` (legacy search SKUs / Perplexity already
 *   price their built-in search per-request and must not be double-charged).
 */
export function calcCost(model, usage, opts = {}) {
  const p = findPricingRow(model);
  if (!p) return null;
  const { inputTokens = 0, outputTokens = 0 } = usage;
  // Per-call fee: an explicit row `perRequest` wins (legacy search SKUs price
  // their built-in search once per call; Perplexity likewise). Otherwise a
  // general model pays the flat web_search tool fee × the number of tool calls
  // it ACTUALLY made — 0 for non-search training/classify calls, ≥1 for a
  // forced web search, >1 if the model searched multiple times in one response.
  // Counting the real calls (vs assuming one) keeps billing honest and reads
  // ground truth instead of trusting an upstream "did it search" assumption.
  const searches = Math.max(0, Number(opts.webSearchCalls) || 0);
  const perCall = p.perRequest != null ? p.perRequest : searches * WEB_SEARCH_TOOL_FEE;
  const costUsd =
    (inputTokens  / 1_000_000) * p.inputPer1M  +
    (outputTokens / 1_000_000) * p.outputPer1M +
    perCall;
  return {
    inputTokens,
    outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };
}

/**
 * Display-only estimate of one weekly run cost for the given model — used by
 * the init wizard to help users compare flagship vs mid-tier choices.
 *
 * Assumes typical workload: 3 queries × 1 cell × ~500 input + ~1500 output
 * tokens per cell (extraction + sentiment cross-check excluded — they hit
 * classifyModel separately and are roughly equal across choices).
 *
 * Returns a short human string like "~$0.0050/run" or "~$??/run" if the
 * model is unknown.
 */
export function estimateWeeklyCost(modelId) {
  const p = findPricingRow(modelId);
  if (!p) return '~$??/run';
  const tokens = { in: 1500, out: 4500 }; // 3 cells × (~500 in + ~1500 out)
  // Per-call: explicit row perRequest (search SKUs / Perplexity) wins; else a
  // general OpenAI main always web-searches, so it pays the flat tool fee.
  // (Gemini grounding has its own per-query fee that we don't track yet — out
  // of scope; leave gemini/anthropic mains fee-free here.)
  const perCall = p.perRequest != null ? p.perRequest : (/^gpt-/.test(modelId) ? WEB_SEARCH_TOOL_FEE : 0);
  const costUsd =
    (tokens.in  / 1_000_000) * p.inputPer1M  +
    (tokens.out / 1_000_000) * p.outputPer1M +
    3 * perCall;
  if (costUsd < 0.001) return `~$${costUsd.toFixed(5)}/run`;
  if (costUsd < 0.01)  return `~$${costUsd.toFixed(4)}/run`;
  if (costUsd < 1)     return `~$${costUsd.toFixed(3)}/run`;
  return `~$${costUsd.toFixed(2)}/run`;
}
