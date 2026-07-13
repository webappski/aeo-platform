/**
 * Per-model pricing for cost tracking.
 * Searched by prefix via startsWith — MORE SPECIFIC entries MUST come before broader ones.
 * Example: 'gpt-5.4-mini' must precede 'gpt-5.4', or mini calls will match the pro price.
 * Prices in USD per 1M tokens.
 */
const PRICING = [
  // ── OpenAI (source: openai.com/api/pricing) ──────────────────────────
  { prefix: 'gpt-5.4-pro',        inputPer1M: 30.00, outputPer1M: 240.00 },
  { prefix: 'gpt-5.4-mini',       inputPer1M: 0.75,  outputPer1M: 4.50  },
  { prefix: 'gpt-5.4-nano',       inputPer1M: 0.20,  outputPer1M: 1.25  },
  { prefix: 'gpt-5.4',            inputPer1M: 2.50,  outputPer1M: 15.00 },
  { prefix: 'gpt-5.2',            inputPer1M: 1.75,  outputPer1M: 14.00 },
  { prefix: 'gpt-5.1',            inputPer1M: 1.25,  outputPer1M: 10.00 },
  { prefix: 'gpt-5-search-api',   inputPer1M: 0.625, outputPer1M: 5.00, perRequest: 0.025 },
  { prefix: 'gpt-5-mini',         inputPer1M: 0.25,  outputPer1M: 2.00  },
  { prefix: 'gpt-5-nano',         inputPer1M: 0.20,  outputPer1M: 1.25  },
  { prefix: 'gpt-5',              inputPer1M: 0.625, outputPer1M: 5.00  },
  { prefix: 'gpt-4o-mini-search', inputPer1M: 0.15,  outputPer1M: 0.60,  perRequest: 0.025 },
  { prefix: 'gpt-4o-search',      inputPer1M: 2.50,  outputPer1M: 10.00, perRequest: 0.025 },
  { prefix: 'gpt-4o-mini',        inputPer1M: 0.15,  outputPer1M: 0.60  },
  { prefix: 'gpt-4o',             inputPer1M: 2.50,  outputPer1M: 10.00 },
  // ── Anthropic ────────────────────────────────────────────────────────
  { prefix: 'claude-haiku',       inputPer1M: 1.00,  outputPer1M: 5.00  },
  { prefix: 'claude-opus',        inputPer1M: 5.00,  outputPer1M: 25.00 },
  { prefix: 'claude-sonnet',      inputPer1M: 3.00,  outputPer1M: 15.00 },
  { prefix: 'claude',             inputPer1M: 3.00,  outputPer1M: 15.00 },
  // ── Gemini ───────────────────────────────────────────────────────────
  // 3.1 prices indicative (preview) — source: ai.google.dev/pricing.
  // thinkingLevel='high' multiplies output token volume (~5-10x), but
  // per-token rate is unchanged.
  { prefix: 'gemini-3.5-flash',       inputPer1M: 1.50,  outputPer1M: 9.00  },
  { prefix: 'gemini-3.1-pro',         inputPer1M: 2.00,  outputPer1M: 15.00 },
  { prefix: 'gemini-3.1-flash-lite',  inputPer1M: 0.10,  outputPer1M: 0.40  },
  { prefix: 'gemini-3.1-flash',       inputPer1M: 0.40,  outputPer1M: 3.00  },
  { prefix: 'gemini-3.1',             inputPer1M: 0.40,  outputPer1M: 3.00  },
  { prefix: 'gemini-2.5-pro',         inputPer1M: 1.25,  outputPer1M: 10.00 },
  { prefix: 'gemini-2.5-flash-lite',  inputPer1M: 0.10,  outputPer1M: 0.40  },
  { prefix: 'gemini-2.5-flash',       inputPer1M: 0.30,  outputPer1M: 2.50  },
  { prefix: 'gemini-2.5',             inputPer1M: 1.25,  outputPer1M: 10.00 },
  { prefix: 'gemini-2.0-flash',       inputPer1M: 0.10,  outputPer1M: 0.40  },
  { prefix: 'gemini',                 inputPer1M: 0.10,  outputPer1M: 0.40  },
  // ── Perplexity ───────────────────────────────────────────────────────
  { prefix: 'sonar-reasoning-pro',inputPer1M: 2.00,  outputPer1M: 8.00,  perRequest: 0.005 },
  { prefix: 'sonar-pro',          inputPer1M: 3.00,  outputPer1M: 15.00, perRequest: 0.005 },
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
 * Calculate cost for a single API call.
 * Returns null if the model is not in the pricing table.
 */
export function calcCost(model, usage) {
  const p = PRICING.find(row => model.startsWith(row.prefix));
  if (!p) return null;
  const { inputTokens = 0, outputTokens = 0 } = usage;
  const costUsd =
    (inputTokens  / 1_000_000) * p.inputPer1M  +
    (outputTokens / 1_000_000) * p.outputPer1M +
    (p.perRequest || 0);
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
  const p = PRICING.find(row => modelId.startsWith(row.prefix));
  if (!p) return '~$??/run';
  const tokens = { in: 1500, out: 4500 }; // 3 cells × (~500 in + ~1500 out)
  const costUsd =
    (tokens.in  / 1_000_000) * p.inputPer1M  +
    (tokens.out / 1_000_000) * p.outputPer1M +
    3 * (p.perRequest || 0);
  if (costUsd < 0.001) return `~$${costUsd.toFixed(5)}/run`;
  if (costUsd < 0.01)  return `~$${costUsd.toFixed(4)}/run`;
  if (costUsd < 1)     return `~$${costUsd.toFixed(3)}/run`;
  return `~$${costUsd.toFixed(2)}/run`;
}
