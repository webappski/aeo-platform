import { isGeminiThinkingBudgetModel } from './gemini.js';

// Static maps of "options to inject when calling a provider's MAIN model" and
// "...its CLASSIFY model". Two maps, not one, because the WEIGHT of thinking
// differs by tier even where both are non-zero (main gets more thinking budget/
// effort than classify) — decision (Alex, 2026-07-08): classify tasks now get
// a light amount of thinking too (previously they got none at all for openai/
// anthropic), accepting a small latency/cost increase for better classification
// quality.
//
// Why a separate file (not inline in bin/aeo-tracker.js): bin has no unit
// tests (only smoke). Drift here is silent — if someone edits bin and sneaks
// out `reasoning_effort: 'high'`, juser pays for mid-tier model without the
// quality bonus. With this file + test/main-options.test.js, deepStrictEqual
// catches the drift.
//
// Semantics per provider:
//   - openai:    main `reasoning_effort: 'high'`, classify `'low'` — GPT-5+
//                reasoning model trigger. Gate in openai.js drops it silently
//                on non-reasoning models.
//   - anthropic: main `thinking: { type: 'enabled', budget_tokens: 16000 }`,
//                classify `{ type: 'enabled', budget_tokens: 4096 }` — Claude
//                4.x+ extended thinking (auto-upgrades to `type:'adaptive'` for
//                gen≥5 models regardless of tier — see anthropic.js). Gate in
//                anthropic.js drops on legacy gen. max_tokens auto-bumped in
//                anthropic.js to budget+2048.
//   - gemini:    {} for BOTH — thinking is injected by gemini.js purely from
//                the MODEL id (gemini-3.x → thinkingLevel='high', gemini-2.x-
//                non-lite → thinkingBudget=-1), identically for main AND
//                classify calls. Intentional, not a leak: the classify-tier
//                model is itself chosen to be the SAME thinking-capable tier
//                as main (discover.js's Gemini fetcher — classify == main by
//                design), so there's nothing tier-specific to inject here.
//   - perplexity: {} for BOTH — reasoning is built into the `sonar-reasoning*`
//                 model id (classify's target model too, as of 2026-07-08 —
//                 see discover.js's fetchPerplexityClassifyModel); no
//                 request-time flag exists for either tier.
//
// Caller (bin/aeo-tracker.js makeResearchProvider) merges MAIN_OPTIONS_BY_PROVIDER
// into `mainCall` options and CLASSIFY_OPTIONS_BY_PROVIDER into `classifyCall`
// options; call sites outside that builder (report/extraction helpers) read
// CLASSIFY_OPTIONS_BY_PROVIDER directly by provider name.

export const MAIN_OPTIONS_BY_PROVIDER = {
  openai:     { reasoning_effort: 'high' },
  anthropic:  { thinking: { type: 'enabled', budget_tokens: 16000 } },
  gemini:     {},
  perplexity: {},
};

// Lighter than MAIN_OPTIONS_BY_PROVIDER on purpose — classify tasks are short
// structured judgements (validation/extraction/sentiment/classification), not
// open-ended generation. Values are a starting point, not measured — expect to
// tune budget_tokens/reasoning_effort after real usage ("let's try it and see").
export const CLASSIFY_OPTIONS_BY_PROVIDER = {
  openai:     { reasoning_effort: 'low' },
  anthropic:  { thinking: { type: 'enabled', budget_tokens: 4096 } },
  gemini:     {},
  perplexity: {},
};

/**
 * Single source of truth for "is thinking/reasoning active for this (provider,
 * model) pair?". Used by ETA estimation in cost-estimate.js — same logic must
 * apply to runtime loop AND any future init UI / preview hint to avoid number
 * drift between estimates and actuals.
 *
 * thinking is active when ANY of:
 *   - MAIN_OPTIONS_BY_PROVIDER[provider] has a thinking-related key
 *     (reasoning_effort, thinking — both indicate active reasoning).
 *   - model is `^gemini-3` (gemini.js auto-injects thinkingLevel=high regardless
 *     of mainOptions, so caller can't opt out).
 *   - model is gemini-2.x-non-lite (gemini.js auto-injects thinkingBudget=-1 —
 *     see isGeminiThinkingBudgetModel, imported so this can't drift from the
 *     actual request-building gate in gemini.js).
 *   - model is `sonar-reasoning*` (Perplexity reasoning is built-in to model).
 *
 * @param {string} provider  'openai' | 'anthropic' | 'gemini' | 'perplexity'
 * @param {string} model     model id
 * @returns {boolean}
 */
export function detectThinkingActive(provider, model) {
  if (!provider || !model) return false;
  if (provider === 'gemini') {
    return /^gemini-3/i.test(model) || isGeminiThinkingBudgetModel(model);
  }
  if (provider === 'perplexity') return /sonar-reasoning/i.test(model);
  const opts = MAIN_OPTIONS_BY_PROVIDER[provider];
  return !!(opts && Object.keys(opts).length > 0);
}
