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
  // e.g. ["A-Core", "Acore Labs"] for a brand stored as "Acore". Optional — an
  // empty array (the default) reproduces brand-only matching. Hyphen/space inside
  // the brand are already tolerated automatically (lib/brand-match.js), so this is
  // for genuinely different names (sub-brands, legacy names, abbreviations).
  brandAliases: [],
  queries: ['', '', ''],
  competitors: [],
  regressionThreshold: 10,
  // AP-MENTION-ROLE-VENDOR-VS-SOURCE — classify WHY each mention happened:
  // named as a supplier the asker could engage, or named as the author of a
  // ranking about rivals (see lib/report/mention-role.js for the three real
  // cells that motivated it). Adds one classify-tier call per mentioned cell —
  // $0.0045–0.015 for a run with 11–25 mentions — so it is OFF by default and
  // switched on per project, deliberately, by whoever pays for the run. With
  // it off every published number is what it was before the field existed.
  classifyMentionRole: false,
  providers: {
    // Defaults below seed .aeo-tracker.json before discoverModels/
    // discoverClassifyModel (cmdRun/cmdReport) fetch live /v1/models. These are
    // pure fallbacks — actual model selection happens at run-time via
    // lib/providers/discover.js for BOTH tiers.
    //
    // MUST stay in sync with FALLBACK constants in lib/providers/discover.js
    // (drift catcher in test/discover.test.js verifies this).
    //   model         = main search-capable model (for OpenAI: the CHEAPEST TIER
    //                   OF THE NEWEST GENERATION — gpt-5.6-luna as of 2026-09-01,
    //                   since the 5.6 line replaced size suffixes with names, so
    //                   "the mini" no longer exists; web search via the Responses
    //                   `web_search` tool, which bills against the general 500k
    //                   bucket, not the legacy `-search-api` SKU's ~6k bucket;
    //                   mid for Anthropic/Perplexity; newest-gen flash for Gemini)
    //   classifyModel = cheap-ish, tier-below-main classification model
    //                   (nano/mini/haiku). Gemini: classify was pinned to
    //                   gemini-2.5-flash (dynamic thinkingBudget, cheaper than
    //                   gemini-3.x's forced thinkingLevel:'high') until Google
    //                   retired the entire 2.5 generation for new API access
    //                   (confirmed live 2026-08-13 — 404 "no longer available
    //                   to new users" on both gemini-2.5-flash AND
    //                   gemini-2.5-flash-lite, despite still being LISTED by
    //                   /v1beta/models, which is why discovery didn't self-detect
    //                   it). Classify now pins to gemini-3.1-flash-lite — still
    //                   forced thinkingLevel:'high' (gemini.js), but flash-lite's
    //                   base rate ($0.25/$1.50 per 1M vs 2.5-flash's $0.30/$2.50)
    //                   keeps the absolute cost trivial on short classify calls
    //                   even with the ~5-10x output-token inflation. OpenAI
    //                   classify moved to gpt-5-nano
    //                   (2026-07-14 bump — nano is a tier below the mini main).
    //                   Perplexity: classify=cheap `sonar`,
    //                   main=`sonar-reasoning-pro` (decision Alex 2026-07-13, see
    //                   fetchPerplexityClassifyModel): the old `sonar-reasoning`
    //                   default was RETIRED by Perplexity, so main moved to its
    //                   successor sonar-reasoning-pro; classify drops to plain
    //                   sonar since light classification doesn't need reasoning —
    //                   same cost-split as Gemini. Anthropic main = claude-sonnet-5
    //                   (2026-07-14 bump).
    //                   2026-09-01 bump: openai main gpt-5-mini → gpt-5.6-luna
    //                   and gemini main gemini-3.5-flash → gemini-3.7-flash —
    //                   both verified present on a live key that day. Seeding a
    //                   generation-old id would hand a discovery-less run the
    //                   exact stale instrument the selector rewrite retires.
    //                   2026-09-08 bump: gemini main gemini-3.7-flash →
    //                   gemini-3.8-flash, verified present on a live key that
    //                   day (discoverModels('gemini', ...) returned exactly
    //                   ['gemini-3.8-flash']). OpenAI stays gpt-5.6-luna —
    //                   generation 6 shipped (gpt-6-astra) but with no
    //                   recognised cheap tier and flagship pricing ($10/$50 per
    //                   1M); see AEO_OPENAI_MODEL_PIN in bin/aeo-tracker.js.
    //                   2026-10-27 (AP-7): openai main AND classify → gpt-6-luna.
    //                   The rule is "newest family, cheap tier inside it" and
    //                   generation 6.1 ships `gpt-6.1-sol` only, so the tier of
    //                   family 6 is gpt-6-luna (the id OpenAI's deprecations page
    //                   names as the replacement for its retiring cheap ids).
    //                   `gpt-5-nano`, the old classify default, is retired by
    //                   OpenAI on 2026-12-11 and was the first paid call of every
    //                   new user's `init`.
    openai:     { model: 'gpt-6-luna',          classifyModel: 'gpt-6-luna',        env: 'OPENAI_API_KEY' },
    gemini:     { model: 'gemini-3.8-flash',    classifyModel: 'gemini-3.1-flash-lite', env: 'GEMINI_API_KEY' },
    anthropic:  { model: 'claude-sonnet-5',     classifyModel: 'claude-haiku-4-5',  env: 'ANTHROPIC_API_KEY' },
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
  for (const [name, modelOverride] of Object.entries(cliModelPins(overrides))) {
    if (!config.providers[name]) continue;  // provider not configured — skip
    config.providers[name].model = modelOverride;
  }
  return config;
}

/**
 * The models the OPERATOR explicitly demanded on this command line, as
 * `{ provider: modelId }`.
 *
 * WHY THIS IS SEPARATE FROM applyCliModelOverrides
 * ------------------------------------------------
 * Writing the flag into `config.providers[name].model` makes it indistinguishable
 * from a value that merely sat in `.aeo-tracker.json` — and by the time live
 * discovery has run, "the config happened to say this" and "the user typed this"
 * must be answered differently. Discovery legitimately overrides the former (it
 * exists to walk a stale config forward); it must never override the latter.
 *
 * That collapse is exactly how `--openai-model` came to be a no-op: the run loop
 * read `r.models ?? r.cfg.model`, so a successful discovery consumed the `??`
 * and the flag only ever applied when discovery had FAILED — while `--help`
 * promised "Override providers.openai.model for this run". A documented flag
 * that silently does nothing costs a paid run to discover.
 *
 * @param {Object} overrides  Same shape applyCliModelOverrides takes.
 * @returns {Record<string, string>}  Only providers with a non-empty flag.
 */
export function cliModelPins(overrides = {}) {
  const map = {
    openai:     overrides.openaiModel,
    gemini:     overrides.geminiModel,
    anthropic:  overrides.anthropicModel,
    perplexity: overrides.perplexityModel,
  };
  return Object.fromEntries(Object.entries(map).filter(([, m]) => !!m));
}

/**
 * The classify-tier models the OPERATOR explicitly demanded, as
 * `{ provider: modelId }`. Only OpenAI has one (`--openai-classify-model`):
 * it is the only provider whose classify discovery chose among ids that were not
 * all chat models. Kept as its own map — a classify pin must never be mistaken
 * for a main pin (they feed different decisions and different refusals).
 *
 * @param {Object} overrides
 * @returns {Record<string, string>}
 */
export function cliClassifyPins(overrides = {}) {
  const map = { openai: overrides.openaiClassifyModel };
  // A string only: with `strict: false` a flag typed without a value arrives as
  // the boolean `true`, which must not become the model id "true".
  return Object.fromEntries(Object.entries(map).filter(([, m]) => typeof m === 'string' && m.trim() !== ''));
}

/**
 * Which model a provider runs this cycle, and where that decision came from.
 *
 * The whole precedence question in one pure place, so the run loop stays a thin
 * caller and the rule is testable without a network or a paid call (the house
 * pattern `lib/providers/model-drift.js` already follows).
 *
 * Order — an explicit CLI pin, then live discovery, then the config file:
 *   cli-pin    the operator named it; nothing may substitute for it silently
 *   discovery  the live catalogue's current best (this is what walks a stale
 *              config forward, and why it must not outrank the pin)
 *   config     `.aeo-tracker.json`, when discovery could not answer
 *
 * ONE exception to "discovery outranks config", added 2026-10-13: when
 * discovery answered but its pick is not a recognised cheap tier
 * (`discoveryUnsafe` — the newest generation shipped only a flagship, e.g.
 * generation 6.1 = `gpt-6.1-sol` alone), the pick is not taken. The run then
 * uses, in order:
 *   last-run   the model this project's previous run asked for (the instrument
 *              the series was measured on — and the one a comparison needs)
 *   config     `.aeo-tracker.json`
 *   none       → `refused: 'no-cheap-tier'`; the caller stops BEFORE any paid
 *              call and tells the operator to pass `--<provider>-model`.
 * The last run is ahead of the config because they disagree in practice: a
 * config written at `init` freezes the model of that day (one live project's
 * config names the legacy `gpt-5-search-api`, its last three runs ran
 * `gpt-6-luna`).
 *
 * `lastRunModel` and `cfgModel` are only consulted in the unsafe case, and the
 * CALLER must hand them in already checked against the key's own catalogue — a
 * model the key no longer lists is not a fallback, it is a different failure.
 *
 * @param {Object} params
 * @param {string|null} [params.pinnedModel]  From `cliModelPins`.
 * @param {string[]|null} [params.discovered] `discoverModels().models`.
 * @param {boolean} [params.discoveryUnsafe]  `discoverModels().selection.cheapTier === false`.
 * @param {string|null} [params.lastRunModel] The previous run's requested model, catalogue-checked.
 * @param {string|null} [params.cfgModel]     `.aeo-tracker.json` providers.<n>.model.
 * @param {string[]} [params.rejectedIds]     The ids of the generation that was turned down
 *        (`selection.pool`). A CONFIG model among them is not taken: "the config says the
 *        flagship" is not a deliberate choice when the config was written before the
 *        generation had a flagship-only release — it would run on the id this branch exists
 *        to keep out, under a label saying it was kept out. A LAST-RUN model among them IS
 *        taken (an earlier run was pinned to it on purpose: that is the "previous model" the
 *        card allows), and the result says so (`isRejectedPick`) so the log can name the
 *        model that is actually sent — never "not taken" for a model that was.
 * @returns {{models: string[]|null, source: 'cli-pin'|'discovery'|'last-run'|'config'|'none', refused?: 'no-cheap-tier', isRejectedPick?: boolean, configIsRejectedPick?: boolean}}
 */
export function resolveRunModels({
  pinnedModel = null, discovered = null, discoveryUnsafe = false, lastRunModel = null, cfgModel = null, rejectedIds = [],
} = {}) {
  if (pinnedModel) return { models: [pinnedModel], source: 'cli-pin' };
  if (discoveryUnsafe && Array.isArray(discovered) && discovered.length > 0) {
    if (lastRunModel) {
      return { models: [lastRunModel], source: 'last-run', ...(rejectedIds.includes(lastRunModel) ? { isRejectedPick: true } : {}) };
    }
    if (cfgModel && !rejectedIds.includes(cfgModel)) return { models: [cfgModel], source: 'config' };
    return { models: null, source: 'none', refused: 'no-cheap-tier', ...(cfgModel ? { configIsRejectedPick: true } : {}) };
  }
  if (Array.isArray(discovered) && discovered.length > 0) return { models: discovered, source: 'discovery' };
  if (cfgModel) return { models: [cfgModel], source: 'config' };
  return { models: null, source: 'none' };
}

/**
 * The classify (extraction / sentiment / validation) model a provider runs this
 * cycle. Same shape of decision as resolveRunModels, for the cheap tier.
 *
 * Order: an explicit `--<provider>-classify-model` pin, then live discovery
 * (when it found a recognised cheap tier), then the config's `classifyModel`,
 * then the shipped FALLBACK.
 *
 * `catalogueKnown` is the line between two different silences. Discovery that
 * could not READ the catalogue (network, 5xx) leaves the old chain untouched —
 * config, then FALLBACK, unchecked, exactly as before. Discovery that READ it
 * and found nothing usable (empty pool, or no recognised cheap tier) can check
 * config/FALLBACK against the key's own list — and when neither is there it
 * says so (`refused`) instead of taking a flagship or a non-chat model: the
 * extractor is called once per cell, so a wrong one is paid for 240 times.
 *
 * @param {Object} params
 * @param {string|null} [params.pinnedModel]
 * @param {string[]|null} [params.discovered]   `discoverClassifyModel().models`
 * @param {{cheapTier?: boolean, catalogueIds?: string[]}|null} [params.selection]
 *        `discoverClassifyModel().selection` — present only when the catalogue was read.
 * @param {string|null} [params.cfgModel]       `providers.<n>.classifyModel`
 * @param {string|null} [params.fallbackModel]  shipped FALLBACK[<n>].classify
 * @param {(id: string) => boolean} [params.isUsable]  chat-capable check for candidates
 * @returns {{model: string|null, source: 'cli-pin'|'discovery'|'config'|'fallback'|'none', refused?: 'no-usable-classify-model', rejected?: string[]}}
 */
export function resolveClassifyChoice({
  pinnedModel = null, discovered = null, selection = null, cfgModel = null, fallbackModel = null,
  isUsable = () => true,
} = {}) {
  if (pinnedModel) return { model: pinnedModel, source: 'cli-pin' };
  const catalogueKnown = !!selection && Array.isArray(selection.catalogueIds);
  const discoveredPick = Array.isArray(discovered) && discovered.length > 0 ? discovered[0] : null;
  if (discoveredPick && !(selection && selection.cheapTier === false)) {
    return { model: discoveredPick, source: 'discovery' };
  }
  if (!catalogueKnown) {
    // Could not read the catalogue: nothing to check against — the old chain.
    if (cfgModel) return { model: cfgModel, source: 'config' };
    if (fallbackModel) return { model: fallbackModel, source: 'fallback' };
    return { model: null, source: 'none' };
  }
  const listed = new Set(selection.catalogueIds);
  const usable = (id) => !!id && listed.has(id) && isUsable(id);
  if (usable(cfgModel)) return { model: cfgModel, source: 'config' };
  if (usable(fallbackModel)) return { model: fallbackModel, source: 'fallback' };
  // Ids the key DOES list but the filter turned down (a config `classifyModel`
  // naming a text-to-speech model): the refusal says so, instead of claiming
  // the key lists nothing.
  const rejected = [cfgModel, fallbackModel].filter((id, i, a) => id && listed.has(id) && !isUsable(id) && a.indexOf(id) === i);
  return { model: null, source: 'none', refused: 'no-usable-classify-model', rejected };
}

/**
 * The model a provider was ASKED for in a finished run — read from that run's
 * `_summary.json`, newest cell first. `requestedModel` is the id the operator's
 * run named (provenance, 2026-09-01); older summaries carry only `model`, which
 * has always meant "requested". Training-data cells are skipped: their model id
 * is derived from the search id by suffix stripping, not asked for.
 *
 * @param {{results?: Array<Object>}} summary
 * @param {string} provider
 * @returns {string|null}
 */
export function lastRunModelFromSummary(summary, provider) {
  for (const cell of summary?.results || []) {
    if (!cell || cell.provider !== provider) continue;
    if (cell.mode && cell.mode !== 'web') continue;
    const id = cell.requestedModel || cell.model;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}
