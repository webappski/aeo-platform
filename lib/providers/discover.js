// Dynamic model discovery — queries each provider's /v1/models endpoint
// and returns the single best CURRENT search-capable model per provider.
//
// Selection policy (per AEO-tracker contract: mid + thinking + web search):
//   openai      — GENERAL chat model (mini preferred), web search attached at
//                 call time via the Responses-API `web_search` tool, NOT the
//                 legacy `-search-api` SKU. Rationale: the search SKU has its
//                 own tiny per-model TPM bucket (~6k on tier 1 — proven by a
//                 live x-ratelimit header), whereas a general mini shares the
//                 500k bucket (~83× headroom). See lib/providers/openai.js.
//                 Falls back to flagship only if the account lists no mini.
//   anthropic   — latest claude-sonnet (mid by name; opus is 5-10× more expensive
//                 with similar AEO-detection quality).
//   gemini      — version-sorted, prefer flash (mid) over pro (flagship);
//                 stable > preview. Preview-only newest-gen → fallback to
//                 previous-gen stable (preview models deprecate unpredictably).
//   perplexity  — main: sonar-reasoning-pro preferred (successor of the retired
//                 sonar-reasoning), fallback sonar-pro. classify: cheap plain
//                 sonar (light classification needs no reasoning).
//
// Returns { models: string[]|null, authError: boolean } per provider. cmdRun
// uses authError to skip provider entirely on 401/403; null with authError=false
// triggers fallback to cfg.model.

import { fetchWithTimeout } from '../util/fetch-with-timeout.js';

// Discovery is a lightweight GET to /v1/models (small JSON, cold-start TLS
// + handshake fits in seconds). Default 10s; env-tunable for slow ISPs.
const DISCOVERY_TIMEOUT_MS =
  Number.isFinite(+process.env.AEO_DISCOVERY_TIMEOUT_MS) && +process.env.AEO_DISCOVERY_TIMEOUT_MS > 1000
    ? +process.env.AEO_DISCOVERY_TIMEOUT_MS
    : 10_000;

// ─── FALLBACK (when discovery fails / cfg.model also absent) ────────────────
// FALLBACK invariant: each main MUST be a verified-existing model (no bleeding-
// edge speculative IDs). Selection rules в fetcher'е aim for "best mid+thinking
// +search"; FALLBACK is the safe baseline когда discovery failed. Two concepts:
// discovery → best, fallback → guaranteed alive.
//
// MUST stay in sync with DEFAULT_CONFIG.providers in lib/config.js (drift
// catcher in test/discover.test.js verifies). Gemini's classify == main
// deliberately (see the NOTE above fetchGeminiModels / CLASSIFY_FETCHERS.gemini).
// mains bumped 2026-09-01 to the newest generation each vendor actually serves
// (verified live on the operator key that day: gpt-5.6-luna / gemini-3.7-flash
// both present in /v1/models). Rule the bump follows — and the rule the live
// selectors below implement — is "newest generation, cheapest tier inside it"
// (founder ruling 2026-09-01). A FALLBACK frozen a generation back would hand a
// discovery-less run the same stale instrument this release exists to retire.
export const FALLBACK = {
  openai:     { main: 'gpt-5.6-luna',        classify: 'gpt-5-nano' },
  anthropic:  { main: 'claude-sonnet-5',      classify: 'claude-haiku-4-5' },
  gemini:     { main: 'gemini-3.7-flash',   classify: 'gemini-3.1-flash-lite' },
  perplexity: { main: 'sonar-reasoning-pro', classify: 'sonar' },
};

// ─── Error helpers ──────────────────────────────────────────────────────────

function authThrow(status) {
  const err = new Error(`auth: ${status}`);
  err.authError = true;
  throw err;
}

/**
 * One GET against a provider's model catalogue, with this module's shared error
 * mapping (401/403 → authError, everything else → thrown status). Every fetcher
 * below — main tier, classify tier, and the raw-id lister — goes through it, so
 * a change to the auth contract can't apply to some of them and not others.
 * @param {string} url
 * @param {Record<string,string>} headers
 * @returns {Promise<Object>} parsed JSON body
 */
async function fetchCatalogue(url, headers) {
  const res = await fetchWithTimeout(url, { headers }, { timeoutMs: DISCOVERY_TIMEOUT_MS });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) authThrow(res.status);
    throw new Error(`${res.status}`);
  }
  return res.json();
}

function debugLog(provider, rawCount, filteredCount, sortedTop3, picked, note = '') {
  if (process.env.AEO_DEBUG_DISCOVERY !== '1') return;
  process.stderr.write(
    `  [discover-debug] ${provider}: raw=${rawCount}, filtered=${filteredCount}, top3=[${sortedTop3.join(', ')}], picked=${picked || '<none>'}${note ? `, ${note}` : ''}\n`,
  );
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────
//
// Selection rules (revised 2026-09-01 — GENERATION decides first, cheap tier
// decides inside it; web search is a TOOL, not a model SKU):
//   - GENERAL chat models only. EXCLUDE:
//       · search   — legacy `-search-api`/`-search-preview` SKUs (tiny ~6k TPM
//                    bucket; web search is attached via the Responses tool now).
//       · audio / realtime / image / tts / transcribe / embedding — non-text.
//       · codex / chat-latest — specialised / non-deterministic aliases.
//       · pro      — expensive AND low-throughput (gpt-5.5-pro = 30k TPM).
//   - GENERATION FIRST. The newest generation present on the key IS the pool;
//     the cheap-tier preference then chooses within it. Cheapness may never
//     cost a generation.
//     WHY THIS REPLACED "mini required": the rule used to be
//         const minis = filtered.filter(isMini);
//         const pool  = minis.length > 0 ? minis : filtered;
//     — a filter, applied BEFORE the generation sort. OpenAI's 5.6 line dropped
//     size suffixes for names (sol / terra / luna), so nothing in the newest
//     generation matched `-mini`, the whole generation fell out of the pool,
//     and the picker sat on gpt-5.4-mini — two generations behind — while
//     reporting a healthy discovery. That is not a cost decision, it is a
//     measurement taken on an instrument the world has stopped using: on
//     2026-08-13 the same brand, questions and day scored 3/3 on one OpenAI SKU
//     and 1/3 on another. Founder ruling 2026-09-01: "надо брать последние
//     модели… последняя модель, но дешёвая модификация".
//   - CHEAP TIER WITHIN that generation, by MAIN_CHEAP_TIER order (below).
//   - No id is hardcoded as the answer: the catalogue comes live from
//     /v1/models and the rule walks itself to the newest generation, so a new
//     OpenAI release needs no code change. MAIN_CHEAP_TIER is a preference
//     HINT, not a gate — and when the newest generation matches none of it, the
//     fetcher says so on stderr instead of quietly taking whatever sorts first.
//     That line is how the next naming change gets noticed in one run rather
//     than in three months of drifting numbers.
//   - Final tiebreaks inside the generation: undated > dated (stable pointer
//     over snapshot), then shortest id, then lexical — deterministic, so two
//     runs on the same catalogue can never disagree.
//
// Ordered cheapest-usable-first. `mini` and `lite` are the cross-vendor size
// conventions; `luna` / `terra` are OpenAI's 5.6 named tiers (luna $0.20/$1.20,
// terra $2/$12, sol $5/$30 — flagship, deliberately absent so it can only ever
// win as the no-hint fallback). `nano` sits below terra because it IS a real
// general model and the ruling says cheapest, but above nothing else: it is the
// classify tier (fetchOpenAIClassifyModel), so a generation that ships mini or
// luna keeps main and classify on separate rungs.
const MAIN_CHEAP_TIER = [
  /(^|-)mini(-|$)/i,
  /(^|-)luna(-|$)/i,
  /(^|-)lite(-|$)/i,
  /(^|-)nano(-|$)/i,
  /(^|-)terra(-|$)/i,
];

/** Position in MAIN_CHEAP_TIER, or its length when the id matches no hint. */
function cheapTierRank(id) {
  const i = MAIN_CHEAP_TIER.findIndex((re) => re.test(id));
  return i === -1 ? MAIN_CHEAP_TIER.length : i;
}

async function fetchOpenAIModels(apiKey, baseURL = 'https://api.openai.com') {
  const { data } = await fetchCatalogue(`${baseURL}/v1/models`, { Authorization: `Bearer ${apiKey}` });
  const ids = (data || []).map(m => m.id).filter(Boolean);
  // Non-general / non-text / low-throughput ids the web_search tool can't (or
  // shouldn't) run on. `(^|-)pro(-|$)` matches -pro and -pro-<date>, not "prod".
  const EXCLUDE = /search|audio|realtime|image|tts|transcribe|embedding|codex|chat-latest|(^|-)pro(-|$)/i;
  const filtered = ids.filter(id => /^gpt-/i.test(id) && !EXCLUDE.test(id));
  // Generation via parseFloat so minor versions order correctly (5.6 > 5.4 > 5).
  const gen = (id) => parseFloat(id.match(/^gpt-(\d+\.?\d*)/i)?.[1] || '0');
  const isDated = (id) => /-\d{4}-\d{2}-\d{2}$/.test(id);
  // The newest generation IS the pool. Nothing below may remove it.
  const maxGen = filtered.reduce((m, id) => Math.max(m, gen(id)), 0);
  const pool = filtered.filter(id => gen(id) === maxGen);
  const sorted = pool.slice().sort((a, b) =>
    (cheapTierRank(a) - cheapTierRank(b))
    || ((isDated(a) ? 1 : 0) - (isDated(b) ? 1 : 0))
    || (a.length - b.length)
    || a.localeCompare(b));
  // Loud whenever the pick is NOT a recognised cheap tier — including a
  // generation that ships exactly one candidate. A pool of one looks like
  // "there was no choice to get wrong", but it is the day-one flagship-only
  // release: nothing is mispicked, and the operator is silently paying flagship
  // rates against a founder ruling that the default is the cheap tier. Silence
  // there is the expensive kind.
  if (sorted.length > 0 && cheapTierRank(sorted[0]) === MAIN_CHEAP_TIER.length) {
    process.stderr.write(
      `  [discover-warn] openai: generation ${maxGen} ships no recognised cheap tier `
      + `(${pool.join(', ')}) — picked ${sorted[0]}, which may be the flagship and priced like one. `
      + `Add the new cheap-variant marker to MAIN_CHEAP_TIER in lib/providers/discover.js, `
      + `or pin a model with --openai-model.\n`,
    );
  }
  debugLog('openai', ids.length, filtered.length, sorted.slice(0, 3), sorted[0], `newest-gen=${maxGen} (${pool.length} candidates)`);
  return sorted.length > 0 ? [sorted[0]] : null;
}

// ─── OpenAI classify tier ────────────────────────────────────────────────────
//
// Selection rules:
//   - NON-search only — classify tasks don't browse the web, and search variants
//     carry a per-request fee (see pricing.js `perRequest`) that's wasted here.
//   - Generation preference: one gen BEHIND the newest search-capable gen (the
//     anchor main resolves to) — classify trails main by design. If nothing
//     classify-eligible exists in that generation, fall back to the newest
//     generation that IS classify-eligible.
//   - mini is REQUIRED within the target generation (not just preferred) —
//     classify must land on the cheap tier, not just tiebreak toward it. Only
//     falls back to non-mini if the target generation ships no mini variant.
//   - undated > dated, same as main.
async function fetchOpenAIClassifyModel(apiKey, baseURL = 'https://api.openai.com') {
  const { data } = await fetchCatalogue(`${baseURL}/v1/models`, { Authorization: `Bearer ${apiKey}` });
  const ids = (data || []).map(m => m.id).filter(Boolean);
  const gen = (id) => {
    const m = id.match(/^gpt-(\d+)/);
    return m ? Number(m[1]) : 0;
  };
  const isMini = (id) => /-mini[-_]/i.test(id) || /-mini$/i.test(id);
  const isDated = (id) => /-\d{4}-\d{2}-\d{2}$/.test(id);
  const isSearch = (id) => id.includes('search');
  const isAvOrRt = (id) => id.includes('audio') || id.includes('realtime');

  const searchIds = ids.filter(id => isSearch(id) && !isAvOrRt(id));
  const newestSearchGen = searchIds.reduce((mx, id) => Math.max(mx, gen(id)), 0);

  const classifyCandidates = ids.filter(id => !isSearch(id) && !isAvOrRt(id) && gen(id) > 0);
  const sortForClassify = (list) => list.slice().sort((a, b) =>
    (isDated(a) ? 1 : 0) - (isDated(b) ? 1 : 0));  // undated > dated

  let pool = newestSearchGen > 0
    ? classifyCandidates.filter(id => gen(id) === newestSearchGen - 1)
    : [];
  if (pool.length === 0) {
    const newestClassifyGen = classifyCandidates.reduce((mx, id) => Math.max(mx, gen(id)), 0);
    pool = classifyCandidates.filter(id => gen(id) === newestClassifyGen);
  }
  // mini is required, not a tiebreaker — only accept non-mini if this
  // generation's pool ships no mini variant at all.
  const miniPool = pool.filter(isMini);
  if (miniPool.length > 0) pool = miniPool;
  const sorted = sortForClassify(pool);
  debugLog('openai-classify', ids.length, pool.length, sorted.slice(0, 3), sorted[0]);
  return sorted.length > 0 ? [sorted[0]] : null;
}

// ─── Anthropic ──────────────────────────────────────────────────────────────
//
// Selection rules:
//   - Only sonnet (mid by name; opus is too expensive for weekly tracking).
//   - Skip dated snapshots (8-digit YYYYMMDD or hyphenated YYYY-MM-DD).
//   - Sort chain (defensive against API shape changes):
//     (1) created_at desc — provider-provided ground truth.
//     (2) Date-in-id extraction — if API stops returning created_at,
//         match `/-(\d{4})-(\d{2})-(\d{2})/` and sort by extracted date.
//     (3) id lex desc — last-resort fallback.
//
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const anthropicHeaders = (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });

// Anthropic uses two naming conventions historically (`claude-sonnet-4-6`
// semver-like vs dated `claude-sonnet-2026-04-19`). Sort chain handles both;
// if naming changes again — extend chain, not replace.
// Shared by the sonnet (main) and haiku (classify) fetchers — both need the
// exact same defensive 3-step recency sort over Anthropic's /v1/models rows.
// Extracted so the chain can't drift between the two call sites.
function sortClaudeByRecency(candidates) {
  const extractDateFromId = (id) => {
    const m = id.match(/-(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}` : '';
  };
  return candidates.slice().sort((a, b) => {
    // (1) created_at — primary.
    if (a.created_at && b.created_at) {
      return b.created_at > a.created_at ? 1 : -1;
    }
    // (2) date-in-id fallback.
    const dA = extractDateFromId(a.id);
    const dB = extractDateFromId(b.id);
    if (dA && dB) return dB.localeCompare(dA);
    // (3) lex desc — last resort.
    return b.id.localeCompare(a.id);
  });
}

// Generation extractor for family-first Claude ids (`claude-<family>-<gen>...`).
// Returns null when the id doesn't follow that shape (defensive — never throws).
function claudeGen(id) {
  const m = /^claude-[a-z]+-(\d+)/i.exec(id || '');
  return m ? Number(m[1]) : null;
}

async function fetchAnthropicModels(apiKey) {
  const { data } = await fetchCatalogue(ANTHROPIC_MODELS_URL, anthropicHeaders(apiKey));
  const candidates = (data || []).filter(m =>
    /claude.*sonnet/i.test(m.id) &&
    !/\d{8}$/.test(m.id) &&
    !/-\d{4}-\d{2}-\d{2}$/.test(m.id),
  );
  const sorted = sortClaudeByRecency(candidates);
  debugLog('anthropic', (data || []).length, candidates.length, sorted.slice(0, 3).map(m => m.id), sorted[0]?.id);
  return sorted.length > 0 ? [sorted[0].id] : null;
}

// ─── Anthropic classify tier ─────────────────────────────────────────────────
//
// Selection rules:
//   - haiku family only (not sonnet — classify wants the cheap tier).
//   - Same dated-snapshot exclusion + recency sort as the sonnet fetcher above.
//   - Generation preference: one gen BEHIND the newest sonnet (classify trails
//     main by design — stability/cost over bleeding-edge). If no haiku exists
//     in that exact generation (haiku and sonnet don't always ship in lockstep),
//     fall back to the newest haiku available, whatever its generation.
async function fetchAnthropicClassifyModel(apiKey) {
  const { data } = await fetchCatalogue(ANTHROPIC_MODELS_URL, anthropicHeaders(apiKey));
  const all = data || [];
  const notDatedSnapshot = (m) => !/\d{8}$/.test(m.id) && !/-\d{4}-\d{2}-\d{2}$/.test(m.id);

  const sonnetCandidates = all.filter(m => /claude.*sonnet/i.test(m.id) && notDatedSnapshot(m));
  const haikuCandidates = all.filter(m => /claude.*haiku/i.test(m.id) && notDatedSnapshot(m));

  const newestSonnet = sortClaudeByRecency(sonnetCandidates)[0];
  const targetGen = newestSonnet ? claudeGen(newestSonnet.id) : null;

  let pool = targetGen != null
    ? haikuCandidates.filter(m => claudeGen(m.id) === targetGen - 1)
    : [];
  if (pool.length === 0) pool = haikuCandidates;  // no haiku one gen behind sonnet — take newest haiku overall

  const sorted = sortClaudeByRecency(pool);
  debugLog('anthropic-classify', all.length, pool.length, sorted.slice(0, 3).map(m => m.id), sorted[0]?.id);
  return sorted.length > 0 ? [sorted[0].id] : null;
}

const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const geminiHeaders = (apiKey) => ({ 'x-goog-api-key': apiKey });

// ─── Gemini ─────────────────────────────────────────────────────────────────
//
// Selection rules (future-proof — works for any gen-N without code changes):
//   - Filter ANY `^gemini-` (not hardcoded gen filter).
//   - Skip lite/embedding/aqa/exp/thinking-experimental — non-chat or unstable.
//   - Flash is REQUIRED, not a tiebreaker (decision Alex, 2026-07-08) — filtered
//     BEFORE the version sort, so a newer-generation pro-only release can never
//     outrank an older flash release. Only falls back to the full (non-flash)
//     pool if literally no flash variant exists at all.
//   - Sort within that pool:
//     (1) Numerical version desc — extracts via parseFloat. Auto-orders
//         3.1 > 3.0 > 2.5 > 4.0 in future without code update.
//         Note: if Google switches to date-naming (`gemini-2027-04`), parseFloat
//         will return 2027 — treated as "newest" by luck. Re-evaluate if naming
//         convention shifts again.
//     (2) Stable > preview — preview deprecate unpredictably.
//     (3) Non-pro > pro — only matters in the no-flash fallback pool.
//   - Preview-only newest-gen guard: if top pick is preview AND any non-preview
//     exists in previous gen — switch to previous-gen stable.
async function fetchGeminiModels(apiKey) {
  // API key in `x-goog-api-key` header — see lib/providers/gemini.js for
  // the reasoning (URL-based keys leak through proxy logs / redirects).
  const { models } = await fetchCatalogue(GEMINI_MODELS_URL, geminiHeaders(apiKey));
  const all = (models || []).filter(m => {
    const id = (m.name || '').replace(/^models\//, '');
    return (
      m.supportedGenerationMethods?.includes('generateContent') &&
      /^gemini-/i.test(id) &&
      !id.includes('embedding') &&
      !id.includes('lite') &&
      !id.includes('aqa') &&
      !id.includes('thinking-experimental') &&
      !id.includes('exp')
    );
  }).map(m => m.name.replace(/^models\//, ''));

  const ver = (id) => parseFloat(id.match(/gemini-(\d+\.?\d*)/i)?.[1] || '0');
  const isPreview = (id) => /-preview/i.test(id);
  const isFlash = (id) => /flash/i.test(id);
  const isPro = (id) => /\bpro\b/i.test(id);

  // Flash required, not a tiebreaker — only fall back to the full pool
  // (allowing pro) if no flash variant exists at all, across any generation.
  const flashOnly = all.filter(isFlash);
  const pool = flashOnly.length > 0 ? flashOnly : all;

  const sorted = pool.slice().sort((a, b) => {
    const dVer = ver(b) - ver(a);
    if (dVer !== 0) return dVer;
    const dPreview = (isPreview(a) ? 1 : 0) - (isPreview(b) ? 1 : 0);
    if (dPreview !== 0) return dPreview;
    const aIsPro = isPro(a), bIsPro = isPro(b);
    if (aIsPro !== bIsPro) return aIsPro ? 1 : -1;
    return 0;
  });

  let picked = sorted[0];
  // Preview-only newest-gen guard: if top is preview, check if any non-preview
  // exists in any previous gen. If yes, switch to that stable model.
  if (picked && isPreview(picked)) {
    const newestVer = ver(picked);
    const previousStable = sorted.find(id => !isPreview(id) && ver(id) < newestVer);
    if (previousStable) picked = previousStable;
  }
  debugLog('gemini', (models || []).length, all.length, sorted.slice(0, 3), picked);
  return picked ? [picked] : null;
}
// Gemini CLASSIFY fetcher — deliberately the cheapest live flash-LITE tier,
// not the main flash.
//
// Decision (Alex, 2026-07-12) — REVISED from the 2026-07-07 "classify == main"
// choice. That earlier call assumed the price gap to a previous-gen flash was
// "fractions of a cent". It isn't: gemini.js forces thinkingLevel:'high' on any
// gemini-3.x, which multiplies OUTPUT token volume ~5-10x. Originally pinned to
// gemini-2.5-flash (non-lite), which got a dynamic thinkingBudget instead of
// forced-high — but Google retired the ENTIRE 2.5 generation for new API
// access (confirmed live 2026-08-13: both gemini-2.5-flash and
// gemini-2.5-flash-lite 404 "no longer available to new users", despite still
// being LISTED by /v1beta/models — this is why discovery couldn't self-detect
// the breakage and why this fetcher can no longer rely on "still in the
// catalogue" as a liveness proof for that generation).
// REVISED AGAIN (2026-08-13): with the dynamic-budget escape gone, every live
// gemini-3.x model eats the forced-high multiplier equally, so the only lever
// left is base $/token — and gemini-3.1-flash-lite ($0.25/$1.50 per 1M) is
// CHEAPER than the newer gemini-3.5-flash-lite ($0.30/$2.50), so this
// deliberately does NOT version-sort like fetchGeminiModels; it targets the
// specific cheap id (already anticipated in FALLBACK/pricing.js/rate-limits.js).
// Returns non-null whenever gemini-3.1-flash-lite is in the catalogue so it
// OVERRIDES a stale classifyModel baked into a user's config; null falls
// through to cfg/FALLBACK ('gemini-3.1-flash-lite').
async function fetchGeminiClassifyModel(apiKey) {
  const { models } = await fetchCatalogue(GEMINI_MODELS_URL, geminiHeaders(apiKey));
  // 3.1-flash-lite tier only: excludes preview/image/tts side-models and the
  // usual unstable variants.
  const pool = (models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => (m.name || '').replace(/^models\//, ''))
    .filter(id =>
      /^gemini-3\.1-flash-lite/i.test(id) &&
      !/-preview/i.test(id) &&
      !/-image/i.test(id) &&
      !/-tts/i.test(id) &&
      !id.includes('exp')
    );
  // Prefer the stable bare alias; else the shortest id (least-suffixed = most stable).
  const picked = pool.includes('gemini-3.1-flash-lite')
    ? 'gemini-3.1-flash-lite'
    : pool.slice().sort((a, b) => a.length - b.length)[0];
  debugLog('gemini-classify', (models || []).length, pool.length, pool.slice(0, 3), picked);
  return picked ? [picked] : null;
}

// ─── Perplexity ─────────────────────────────────────────────────────────────
//
const PERPLEXITY_MODELS_URL = 'https://api.perplexity.ai/models';

// Perplexity's /models endpoint is unreliable historically (sometimes 404s,
// sometimes returns abbreviated list). Try it; fallback to preference chain:
// sonar-reasoning-pro > sonar-pro. (The old `sonar-reasoning` was retired by
// Perplexity ~Dec 2025 — sonar-reasoning-pro is its reasoning-tier successor.)
async function fetchPerplexityModels(apiKey) {
  const PREFERENCE = ['sonar-reasoning-pro', 'sonar-pro'];
  try {
    {
      const json = await fetchCatalogue(PERPLEXITY_MODELS_URL, { Authorization: `Bearer ${apiKey}` });
      const ids = (json.data || json.models || []).map(m => m.id || m).filter(Boolean);
      // Pick first preference that exists in API response.
      for (const pref of PREFERENCE) {
        if (ids.includes(pref)) {
          debugLog('perplexity', ids.length, ids.length, ids.slice(0, 3), pref);
          return [pref];
        }
      }
      // None of preferred — fall back to any sonar variant.
      const anySonar = ids.find(id => /sonar/i.test(id));
      if (anySonar) {
        debugLog('perplexity', ids.length, 1, [anySonar], anySonar);
        return [anySonar];
      }
    }
  } catch (err) {
    if (err?.authError) throw err;  // bubble auth — caller handles
    // Other errors — fall through.
  }
  // /models endpoint failed or empty — use preference chain blindly.
  debugLog('perplexity', 0, 0, [], 'sonar-reasoning-pro (chain fallback)');
  return ['sonar-reasoning-pro'];
}

// ─── Perplexity classify tier ────────────────────────────────────────────────
//
// Decision (Alex, 2026-07-13) — REVISED from the 2026-07-08 "classify == main"
// choice. That choice pinned classify to `sonar-reasoning`, which Perplexity has
// since RETIRED. Rather than promote classify to the pricier reasoning-pro tier,
// we drop it to plain `sonar` ($1/$1): the classify tasks are short structured
// classification that don't need reasoning, so this is the cheap tier — the same
// cost-split we apply to Gemini (main gets reasoning, classify doesn't). Main
// keeps the reasoning tier (sonar-reasoning-pro, see fetchPerplexityModels).
// Same live-try + blind-fallback pattern as the main fetcher above.
async function fetchPerplexityClassifyModel(apiKey) {
  const PREFERENCE = ['sonar', 'sonar-pro'];
  try {
    {
      const json = await fetchCatalogue(PERPLEXITY_MODELS_URL, { Authorization: `Bearer ${apiKey}` });
      const ids = (json.data || json.models || []).map(m => m.id || m).filter(Boolean);
      for (const pref of PREFERENCE) {
        if (ids.includes(pref)) {
          debugLog('perplexity-classify', ids.length, ids.length, ids.slice(0, 3), pref);
          return [pref];
        }
      }
      // None of preferred — fall back to any sonar variant at all.
      const anySonar = ids.find(id => /sonar/i.test(id));
      if (anySonar) {
        debugLog('perplexity-classify', ids.length, 1, [anySonar], anySonar);
        return [anySonar];
      }
    }
  } catch (err) {
    if (err?.authError) throw err;  // bubble auth — caller handles
    // Other errors — fall through.
  }
  // /models endpoint failed or empty — use preference chain blindly.
  debugLog('perplexity-classify', 0, 0, [], 'sonar (chain fallback)');
  return ['sonar'];
}

// ─── Raw catalogue listing ──────────────────────────────────────────────────
//
// The UNFILTERED id list, for the one question the tier fetchers cannot answer:
// "does the model the operator explicitly asked for still exist on this key?"
// It must not reuse the selection filters — `gpt-5-search-api` is EXCLUDEd from
// the main pool on purpose and is still a legitimate `--openai-model` pin (it is
// exactly the id an operator re-measures an old month on). Filtering here would
// reject the pin as non-existent, which is the same silent-substitution defect
// wearing a different hat.
const CATALOGUE_IDS = {
  openai: async (apiKey, baseURL = 'https://api.openai.com') =>
    ((await fetchCatalogue(`${baseURL}/v1/models`, { Authorization: `Bearer ${apiKey}` })).data || [])
      .map(m => m.id).filter(Boolean),
  anthropic: async (apiKey) =>
    ((await fetchCatalogue(ANTHROPIC_MODELS_URL, anthropicHeaders(apiKey))).data || [])
      .map(m => m.id).filter(Boolean),
  gemini: async (apiKey) =>
    ((await fetchCatalogue(GEMINI_MODELS_URL, geminiHeaders(apiKey))).models || [])
      .map(m => (m.name || '').replace(/^models\//, '')).filter(Boolean),
  perplexity: async (apiKey) => {
    const json = await fetchCatalogue(PERPLEXITY_MODELS_URL, { Authorization: `Bearer ${apiKey}` });
    return (json.data || json.models || []).map(m => m.id || m).filter(Boolean);
  },
};

/**
 * Every model id this key can see, unfiltered — or null when the provider's
 * catalogue could not be read.
 *
 * `ids: null` is NOT "the model is gone". Perplexity's /models 404s routinely
 * and any provider can be unreachable; a caller validating a pin must treat
 * null as "unknown, proceed" and only ever refuse on a list that came back and
 * did not contain the id.
 *
 * @param {string} provider
 * @param {string} apiKey
 * @param {string} [baseURL]
 * @returns {Promise<{ids: string[]|null, authError: boolean}>}
 */
export async function listModelIds(provider, apiKey, baseURL) {
  const fn = CATALOGUE_IDS[provider];
  if (!fn) return { ids: null, authError: false };
  try {
    return { ids: await fn(apiKey, baseURL), authError: false };
  } catch (err) {
    return { ids: null, authError: err?.authError === true };
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────

const FETCHERS = {
  openai:     fetchOpenAIModels,
  anthropic:  fetchAnthropicModels,
  gemini:     fetchGeminiModels,
  perplexity: fetchPerplexityModels,
};

/**
 * Discover current main model(s) for the given provider.
 *
 * Contract change vs main branch (was: Promise<string[]|null>).
 * Single internal caller (bin/aeo-tracker.js cmdRun) — safe to evolve.
 *
 * @param {string} provider
 * @param {string} apiKey
 * @param {string} [baseURL]
 * @param {Object} [opts]
 * @param {boolean} [opts.quiet=false]  suppress the always-on [discover-warn]
 *        stderr line. The init key-probe sets this: on an offline init the
 *        "response shape might've changed" wording is misleading (the real
 *        cause is no network), so the probe prints its own honest line instead
 *        (fail-branch I-8). Has no effect on the live `run` path.
 * @returns {Promise<{models: string[]|null, authError: boolean}>}
 *   - authError=true means 401/403 from /v1/models → skip provider entirely.
 *   - models=null with authError=false means network/5xx/other → caller falls
 *     back to cfg.model from .aeo-tracker.json.
 */
export async function discoverModels(provider, apiKey, baseURL, opts = {}) {
  const fn = FETCHERS[provider];
  if (!fn) return { models: null, authError: false };
  try {
    const models = await fn(apiKey, baseURL);
    return { models, authError: false };
  } catch (err) {
    // Always-on warning for non-auth failures — provider response shape might've
    // changed (renamed field, removed property). Maintainer should see this
    // immediately, not wait for user reports. Suppressed for the init probe
    // (opts.quiet) where the message would mislead on an offline machine.
    if (!err?.authError && !opts.quiet) {
      process.stderr.write(`  [discover-warn] ${provider}: ${err?.message || err}\n`);
    }
    return { models: null, authError: err?.authError === true };
  }
}

// CLASSIFY_FETCHERS mirrors FETCHERS above, one entry per provider, but selects
// the cheap classification-tier model instead of the main answer-tier model.
// Every provider (including Gemini, as of 2026-07-12 — see fetchGeminiClassifyModel)
// gets its own dedicated classify fetcher that trails a tier/generation below main.
const CLASSIFY_FETCHERS = {
  openai:     fetchOpenAIClassifyModel,
  anthropic:  fetchAnthropicClassifyModel,
  gemini:     fetchGeminiClassifyModel,
  perplexity: fetchPerplexityClassifyModel,
};

/**
 * Discover current CLASSIFY model(s) for the given provider — the cheap tier
 * used for extraction/sentiment/validation/outreach, as opposed to
 * `discoverModels` (main answer tier). Same contract, same error mapping;
 * kept as a sibling function rather than a `tier` param on `discoverModels` so
 * the two call sites (main vs classify resolution in cmdRun/cmdReport) stay
 * textually distinct and can't accidentally swap tiers.
 *
 * FALLBACK.classify (lib/config.js DEFAULT_CONFIG mirrors it) is the last-resort
 * value ONLY when this returns models=null AND the caller's config file also has
 * no classifyModel — exactly the same three-rung chain (discover → cfg → hardcode)
 * that main model resolution already uses. Before this function existed, classify
 * had NO live discovery at all — cfg/hardcode was the only source, permanently.
 *
 * @param {string} provider
 * @param {string} apiKey
 * @param {string} [baseURL]
 * @param {Object} [opts]
 * @param {boolean} [opts.quiet=false]  see discoverModels — same suppression contract.
 * @returns {Promise<{models: string[]|null, authError: boolean}>}
 */
export async function discoverClassifyModel(provider, apiKey, baseURL, opts = {}) {
  const fn = CLASSIFY_FETCHERS[provider];
  if (!fn) return { models: null, authError: false };
  try {
    const models = await fn(apiKey, baseURL);
    return { models, authError: false };
  } catch (err) {
    if (!err?.authError && !opts.quiet) {
      process.stderr.write(`  [discover-warn] ${provider} (classify): ${err?.message || err}\n`);
    }
    return { models: null, authError: err?.authError === true };
  }
}

/**
 * Which model actually runs a classify task, for callers OUTSIDE the per-run
 * discovery loop in cmdRun.
 *
 * `cmdRun` rediscovers both tiers live and overrides the config. The report
 * path did not: it read `providerCfg.classifyModel` from .aeo-tracker.json
 * verbatim, so a model retired AFTER a project's config was written failed on
 * every report from then on — and failed silently, because the classification
 * result is only persisted on success, so each run simply retried and shipped
 * a report with no citation classification in it.
 *
 * That is not hypothetical: Google retired the whole gemini-2.5 generation for
 * new API access on 2026-08-13 while still LISTING it in /v1beta/models, and
 * seven local configs — four of them paying/pilot clients — still pinned
 * `gemini-2.5-flash` here. Fixing those files fixes today; this function is
 * what stops the next retirement from doing the same thing.
 *
 * Order: live discovery (the Gemini branch of it is written specifically to
 * override a stale config pin), then the config pin, then the shipped
 * FALLBACK. Never throws and never blocks: an offline report still classifies
 * with whatever the config names, exactly as before.
 *
 * @param {string} provider
 * @param {{classifyModel?: string, model?: string, env?: string, baseURL?: string}} cfg
 * @param {{env?: Object, discoverFn?: Function}} [opts] — injectable for tests,
 *        which must never reach the network (a working classify model turns
 *        the report step into a real billed call).
 * @returns {Promise<string|undefined>}
 */
export async function resolveClassifyModel(provider, cfg, opts = {}) {
  const env = opts.env || process.env;
  const discoverFn = opts.discoverFn || discoverClassifyModel;
  const pinned = cfg?.classifyModel || cfg?.model || FALLBACK[provider]?.classify;
  const apiKey = cfg?.env ? env[cfg.env] : env[`${String(provider).toUpperCase()}_API_KEY`];
  if (!apiKey) return pinned;
  try {
    const { models } = await discoverFn(provider, apiKey, cfg?.baseURL, { quiet: true });
    return (models && models[0]) || pinned;
  } catch {
    return pinned;
  }
}
