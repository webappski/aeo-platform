export const CONFIG_FILE = '.aeo-tracker.json';

// Priority order for picking primary/validator providers in the research pipeline.
// Decision (Alex, 2026-07-08): Gemini first, then Claude, then GPT, then
// Perplexity — Gemini/Anthropic are cheaper and preferred over OpenAI now that
// both are proven research-capable. This still keeps the two providers that
// were required pre-0.2.2 (OpenAI + Gemini, per README contract) ahead of the
// optional pair (Anthropic used to be optional too, back when it caused a 0.2.2
// crash as priority #1 with empty billing) — the front two slots are always
// filled by proven, research-capable providers, just re-pointed to Gemini+Claude.
// Retry loop in bin/aeo-tracker.js walks this list on billing/auth/rate errors.
// Perplexity stays last (optional, search-only) — included so cmdRun discovery
// iterates ALL configured providers, not just the research-eligible three.
//
// This governs MAIN-tier provider order and the primary/secondary labelling in
// two-model classify cross-checks (competitor extraction, sentiment — both fire
// regardless of label). It does NOT govern single-model classify tasks — see
// CLASSIFY_PROVIDER_PRIORITY below for those.
export const PROVIDER_PRIORITY = ['gemini', 'anthropic', 'openai', 'perplexity'];

// Priority order for ONE-MODEL provider-pick tasks: query validation without
// --strict-validation, init's cleanCategory step, outreach-email drafting
// (provider chosen here, but drafted on the FLAGSHIP model — it's structured
// generation, not a cheap classify; see cmdReport's outreach block),
// citation-domain classification. Decision (Alex, 2026-07-08): same order as
// PROVIDER_PRIORITY now (Gemini, Claude, GPT, Perplexity) — previously this was
// gemini-first/openai-residual (2026-07-07) while PROVIDER_PRIORITY stayed
// openai-first; both lists now agree since GPT dropped below Claude everywhere.
// Does NOT affect two-model cross-checks (those always use both providers
// regardless of order).
export const CLASSIFY_PROVIDER_PRIORITY = ['gemini', 'anthropic', 'openai', 'perplexity'];

// DEFAULT_CONFIG is the seed for new .aeo-tracker.json files. `init` seeds it
// from FALLBACK (lib/providers/discover.js) and never touches it again — the
// FILE VALUE THEREFORE GOES STALE the moment either tier's live discovery
// resolves to something newer at `run`/`report` time (expected: this is a
// last-resort snapshot, not a cache to keep fresh). These defaults are only
// ACTUALLY used when: (a) live discovery fails AND the config file also lacks
// a value for that tier, or (b) something reads providers.* before init has run.
//
//   model         = the search-capable model used for run queries. Discovered
//                   live every `run`/`report` via discoverModels(); this is
//                   the emergency fallback only.
//   classifyModel = the cheap classification model used for extraction,
//                   sentiment, validation, brainstorm. (Outreach drafting now
//                   uses the FLAGSHIP model — generation, not classify.) Discovered
//                   live every `run`/`report` via discoverClassifyModel();
//                   this is the emergency fallback only. Gemini's classify
//                   fallback deliberately equals its main fallback (both
//                   newest-gen flash — see discoverClassifyModel's gemini
//                   entry); the other three providers use a cheaper tier
//                   (mini/haiku/plain-sonar) than their main fallback.
export const DEFAULT_CONFIG = {
  brand: '',
  domain: '',
  // Alternate spellings of the brand the matcher should also treat as a mention,
  // e.g. ["G-Core", "GCore Labs"] for a brand stored as "Gcore". Optional — an
  // empty array (the default) reproduces brand-only matching. Hyphen/space inside
  // the brand are already tolerated automatically (lib/brand-match.js), so this is
  // for genuinely different names (sub-brands, legacy names, abbreviations).
  brandAliases: [],
  queries: ['', '', ''],
  competitors: [],
  regressionThreshold: 10,
  providers: {
    // Defaults below seed .aeo-tracker.json before discoverModels/
    // discoverClassifyModel (cmdRun/cmdReport) fetch live /v1/models. These are
    // pure fallbacks — actual model selection happens at run-time via
    // lib/providers/discover.js for BOTH tiers.
    //
    // MUST stay in sync with FALLBACK constants in lib/providers/discover.js
    // (drift catcher in test/discover.test.js verifies this).
    //   model         = main search-capable model (general MINI for OpenAI —
    //                   web search via the Responses `web_search` tool, which
    //                   bills against the mini's 500k bucket, not the legacy
    //                   `-search-api` SKU's ~6k bucket; mid for Anthropic/
    //                   Perplexity; newest-gen flash for Gemini)
    //   classifyModel = cheap-ish, tier-below-main classification model
    //                   (mini/haiku). Gemini: classify is pinned to
    //                   gemini-2.5-flash — a generation BELOW the main flash
    //                   (see discoverClassifyModel's gemini entry for why: 2.5
    //                   uses a dynamic thinkingBudget auto-scaled to the task,
    //                   whereas gemini-3.x is forced to thinkingLevel:'high'
    //                   which inflates output tokens ~5-10x — needless cost on a
    //                   short classify call). Perplexity: classify=cheap `sonar`,
    //                   main=`sonar-reasoning-pro` (decision Alex 2026-07-13, see
    //                   fetchPerplexityClassifyModel): the old `sonar-reasoning`
    //                   default was RETIRED by Perplexity, so main moved to its
    //                   successor sonar-reasoning-pro; classify drops to plain
    //                   sonar since light classification doesn't need reasoning —
    //                   same cost-split as Gemini.
    openai:     { model: 'gpt-5-mini',          classifyModel: 'gpt-4o-mini',       env: 'OPENAI_API_KEY' },
    gemini:     { model: 'gemini-3.5-flash',    classifyModel: 'gemini-2.5-flash',  env: 'GEMINI_API_KEY' },
    anthropic:  { model: 'claude-sonnet-4-6',   classifyModel: 'claude-haiku-4-5',  env: 'ANTHROPIC_API_KEY' },
    perplexity: { model: 'sonar-reasoning-pro', classifyModel: 'sonar',             env: 'PERPLEXITY_API_KEY' },
  },
};

/**
 * Apply CLI flag overrides on top of the loaded config (in-memory only —
 * the .aeo-tracker.json file is NOT rewritten). Used by `run` to let the
 * user swap models per-run without re-running `init`. Empty/undefined
 * overrides leave the config untouched.
 *
 *   aeo-platform run --openai-model gpt-5
 *   → applies overrides.openaiModel = 'gpt-5'
 *   → config.providers.openai.model becomes 'gpt-5' for this process only
 *
 * @param {Object} config           Mutated in place.
 * @param {Object} overrides
 * @param {string} [overrides.openaiModel]
 * @param {string} [overrides.geminiModel]
 * @param {string} [overrides.anthropicModel]
 * @param {string} [overrides.perplexityModel]
 * @returns {Object}                The same config object, with overrides applied.
 */
export function applyCliModelOverrides(config, overrides = {}) {
  if (!config?.providers) return config;
  const map = {
    openai:     overrides.openaiModel,
    gemini:     overrides.geminiModel,
    anthropic:  overrides.anthropicModel,
    perplexity: overrides.perplexityModel,
  };
  for (const [name, modelOverride] of Object.entries(map)) {
    if (!modelOverride) continue;
    if (!config.providers[name]) continue;  // provider not configured — skip
    config.providers[name].model = modelOverride;
  }
  return config;
}
