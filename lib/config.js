export const CONFIG_FILE = '.aeo-tracker.json';

// Priority order for picking primary/validator providers in the research pipeline.
// Required providers (OpenAI + Gemini per README contract) come first so init
// doesn't pick an optional provider as primary — a mismatch that caused a 0.2.2
// user to hit a crash when Anthropic (priority #1 pre-0.2.2) had empty billing.
// Retry loop in bin/aeo-tracker.js walks this list on billing/auth/rate errors.
// Perplexity stays last (optional, search-only) — included so cmdRun discovery
// iterates ALL configured providers, not just the research-eligible three.
export const PROVIDER_PRIORITY = ['openai', 'gemini', 'anthropic', 'perplexity'];

// DEFAULT_CONFIG is the seed for new .aeo-tracker.json files. The init wizard
// overwrites providers.*.model and providers.*.classifyModel with values
// discovered + chosen by the user. These defaults are only used when init
// can't reach the provider's /models API (offline / down) or when something
// reads providers.* before init has run.
//
//   model         = the search-capable model used for run queries (user picks)
//   classifyModel = the cheap classification model used for extraction,
//                   sentiment, validation, brainstorm, outreach (auto-picked
//                   in init wizard, mid-tier of newest generation)
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
    // Defaults below seed .aeo-tracker.json before discoverModels (cmdRun) is
    // able to fetch live /v1/models. These are pure fallbacks — actual model
    // selection happens at run-time via discoverModels in lib/providers/discover.js.
    //
    // MUST stay in sync with FALLBACK constants in lib/providers/discover.js
    // (drift catcher in test/discover.test.js verifies this).
    //   model         = main search-capable model (flagship preferred for OpenAI;
    //                   mid for Anthropic/Gemini/Perplexity)
    //   classifyModel = cheap non-search model for extraction/sentiment/validation
    openai:     { model: 'gpt-5-search-api',  classifyModel: 'gpt-5-nano',         env: 'OPENAI_API_KEY' },
    gemini:     { model: 'gemini-3.5-flash',  classifyModel: 'gemini-2.5-flash',   env: 'GEMINI_API_KEY' },
    anthropic:  { model: 'claude-sonnet-5',   classifyModel: 'claude-haiku-4-5',   env: 'ANTHROPIC_API_KEY' },
    perplexity: { model: 'sonar-reasoning',   classifyModel: 'sonar',              env: 'PERPLEXITY_API_KEY' },
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
