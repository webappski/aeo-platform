/**
 * Geographic / regional query localisation.
 *
 * Sets aeo-tracker apart from Wellows / OneGlanse / AthenaHQ — none of them
 * support multi-region runs. Implementation is a "soft" geo: we wrap each
 * query with a region-context preamble. We do not fake browser headers or
 * IP-spoof — the LLM sees the explicit region instruction and tailors its
 * answer to that market.
 *
 * Ships the markets where AI-search adoption is meaningful in 2026. The
 * AUTHORITATIVE list is the `REGIONS` map below — never restate its size in
 * prose (a hardcoded count drifts the moment a region is added; `--help` and
 * the unknown-code warning both render it via `listRegionCodes()`).
 * Adding a region = one entry in `REGIONS` + one in `REGION_NATIVE_LANG`.
 *
 * Language axis (AP-REGION-LANG-MATRIX). `--geo` alone wraps the query with an
 * ENGLISH market-instruction. That tells the model "answer for the German
 * market" but the question is still asked in English, so the model tends to
 * pull English-language sources and English competitor names. For a PL/DACH
 * beachhead that is the wrong signal: to see whether the brand surfaces the way
 * a Polish or German searcher would actually find it, the preamble must be
 * written IN the locale language so the model answers in-language and reaches
 * locale-native sources. `--lang pl,de` opts each region into a localised
 * preamble.
 *
 * HONESTY (same discipline as the API-surface disclaimer, review #3): this is
 * still soft geo. The provider APIs do NOT expose a per-request country/IP
 * geo-signal we can set — `--lang` changes the *language the question is asked
 * in* plus the market instruction, nothing more. It is "ask the question the
 * way a German searcher would phrase it", not "pretend the request came from
 * Germany". The report copy says exactly this so a reader never mistakes a
 * localised-prompt run for a true geolocated run.
 */

export const REGIONS = {
  us: { code: 'us', label: 'United States',   instruction: 'the United States market' },
  uk: { code: 'uk', label: 'United Kingdom',  instruction: 'the United Kingdom market' },
  de: { code: 'de', label: 'Germany',         instruction: 'the German market' },
  fr: { code: 'fr', label: 'France',          instruction: 'the French market' },
  es: { code: 'es', label: 'Spain',           instruction: 'the Spanish market' },
  it: { code: 'it', label: 'Italy',           instruction: 'the Italian market' },
  ca: { code: 'ca', label: 'Canada',          instruction: 'the Canadian market' },
  au: { code: 'au', label: 'Australia',       instruction: 'the Australian market' },
  in: { code: 'in', label: 'India',           instruction: 'the Indian market' },
  br: { code: 'br', label: 'Brazil',          instruction: 'the Brazilian market' },
  jp: { code: 'jp', label: 'Japan',           instruction: 'the Japanese market' },
  nl: { code: 'nl', label: 'Netherlands',     instruction: 'the Dutch market' },
  // PL + DACH beachhead (added 2026-08-27). `LANG_MARKET` already carried
  // localised market names for pl/at/ch before these entries existed, so the
  // language axis was reachable only for `de` — `--regions pl,at,ch` was
  // rejected by parseGeoFlag and the pl/at/ch translations were dead code.
  // Appended (not interleaved) so the existing code ORDER — which
  // `listRegionCodes()` renders into `--help` — stays stable.
  pl: { code: 'pl', label: 'Poland',          instruction: 'the Polish market' },
  at: { code: 'at', label: 'Austria',         instruction: 'the Austrian market' },
  ch: { code: 'ch', label: 'Switzerland',     instruction: 'the Swiss market' },
};

/**
 * Localised market-context preambles. Keyed by ISO-639-1 language code. Each is
 * a self-translation of the English template
 *   "(Answer in the context of <market>.) "
 * written IN that language, so the query the model receives reads natively.
 *
 * ── THE ONE RULE FOR THIS FILE ────────────────────────────────────────────
 * **The template supplies NO grammar for the `${market}` slot. The market
 * phrase carries its own.**
 *
 * Every template below stops at the word BEFORE the preposition and lets the
 * market phrase open with whatever its language requires. That is not a style
 * preference — it is the only shape that works across the languages we ship:
 *
 *   - fr/es/it/pt CONTRACT the preposition with the article (`de`+`le` → `du`,
 *     `di`+`il` → `del`, `de`+`o` → `do`). A template that supplied `de` and a
 *     market phrase that opened with `du` produced "de du marché suisse" — a
 *     doubled preposition, which is what this rule exists to prevent.
 *   - de INFLECTS for case (`von` + dative → `dem deutschen Markt`). No
 *     template can supply that; storing market names uninflected is impossible
 *     without a morphology engine.
 *   - pl needs NO preposition at all (`w kontekście` governs the genitive
 *     directly), and ja puts the slot FIRST (`〜の文脈で`).
 *
 * So the slot is a complete, language-specific phrase and the template frames
 * it, nothing more. When a (lang, region) pair has no translated phrase we
 * splice the region's ENGLISH `instruction`, and the language's own preposition
 * comes from `LANG_FALLBACK_PREP` so the frame stays grammatical.
 *
 * `test/geo-context.test.js` pins EVERY (lang × region) cell as a full string
 * and sweeps all of them for adjacent prepositions, so a new pair that breaks
 * this rule goes red rather than shipping a malformed prompt to a paid engine.
 *
 * Only the languages the beachhead actually needs are shipped; an unknown
 * `--lang` code degrades to English (the byte-identical `--geo` preamble) rather
 * than throwing — never-fail (AP-FAIL-BRANCHES).
 */
const LANG_PREAMBLE = {
  // English template = the exact pre-feature string, so `--lang en` (or no
  // --lang) reproduces today's `wrapQueryForRegion` byte-for-byte (R39). Its
  // `of` now arrives via LANG_FALLBACK_PREP.en — `en` has no translated market
  // phrases by design (the `code !== 'en'` guard in wrapQueryForRegion), so it
  // always takes the fallback path and the rendered string is unchanged.
  en: (market) => `(Answer in the context ${market}.) `,
  de: (market) => `(Antworte im Kontext ${market}. Antworte auf Deutsch.) `,
  pl: (market) => `(Odpowiedz w kontekście ${market}. Odpowiedz po polsku.) `,
  fr: (market) => `(Réponds dans le contexte ${market}. Réponds en français.) `,
  es: (market) => `(Responde en el contexto ${market}. Responde en español.) `,
  it: (market) => `(Rispondi nel contesto ${market}. Rispondi in italiano.) `,
  nl: (market) => `(Antwoord in de context ${market}. Antwoord in het Nederlands.) `,
  pt: (market) => `(Responda no contexto ${market}. Responda em português.) `,
  ja: (market) => `(${market}の文脈で回答してください。日本語で回答してください。) `,
};

/**
 * Localised market PHRASE per (language, region) so the German preamble names
 * the market in German ("von dem deutschen Markt") rather than splicing the
 * English "the German market" into a German sentence.
 *
 * Per the rule above, each value is a COMPLETE phrase including the preposition
 * its language needs — `pl` and `ja` carry none because their frames govern the
 * slot directly. Falls back to the region's English `instruction` (wrapped by
 * `LANG_FALLBACK_PREP`) when a pair isn't translated.
 *
 * ⚠️ DELIBERATE GERMAN ASYMMETRY: `de→de` says `von dem deutschen Markt` while
 * `de→at` / `de→ch` say `vom`. `vom` is the idiomatic contraction and is what
 * all three SHOULD say — but `de→de` is the one cell of this table that appears
 * in historical measurement runs, and changing the prompt would break
 * comparability with them (R39). The at/ch cells only became reachable on
 * 2026-08-27 (the pl/at/ch region axis), so they have no history to protect and
 * ship correct. Normalising `de→de` belongs in a release that is allowed to
 * move comparability, not here.
 */
const LANG_MARKET = {
  de: { de: 'von dem deutschen Markt', at: 'vom österreichischen Markt', ch: 'vom Schweizer Markt' },
  pl: { pl: 'rynku polskiego' },
  // `ch` appears under de/fr/it because Switzerland is officially multilingual
  // — without these a `--lang fr --regions ch` run splices the ENGLISH "the
  // Swiss market" into a French sentence (the documented graceful fallback,
  // but a measurably worse prompt for a CH-French run).
  fr: { fr: 'du marché français', ca: 'du marché canadien', ch: 'du marché suisse' },
  es: { es: 'del mercado español' },
  it: { it: 'del mercato italiano', ch: 'del mercato svizzero' },
  nl: { nl: 'van de Nederlandse markt' },
  // `pt.pt` is currently UNREACHABLE — there is no `pt` (Portugal) entry in
  // REGIONS, only `br`. Kept rather than deleted: it is a correct translation
  // that costs nothing and is ready the day Portugal is added. It is the one
  // pair the golden table in test/geo-context.test.js cannot pin, precisely
  // because no cell renders it.
  pt: { br: 'do mercado brasileiro', pt: 'do mercado português' },
  ja: { jp: '日本市場' },
};

/**
 * The preposition each language needs in front of an UNTRANSLATED (English)
 * market name — the graceful-degradation path. Empty string where the frame
 * governs the slot directly (`pl`: `w kontekście` + genitive; `ja`: the slot is
 * sentence-initial before `の`).
 *
 * This exists because the templates deliberately carry no preposition. Without
 * it, `--lang fr --regions us` would render "dans le contexte the United States
 * market" — a MISSING preposition, the mirror of the doubled one this refactor
 * removed. Every value here reproduces the pre-refactor rendering byte-for-byte.
 */
const LANG_FALLBACK_PREP = {
  en: 'of', de: 'von', pl: '', fr: 'de',
  es: 'de', it: 'di', nl: 'van', pt: 'de', ja: '',
};

/**
 * The set of language codes that have a real localised preamble. Used by the
 * flag parser to tell "unknown code" from "supported". `en` is included — it is
 * the explicit, byte-identical default.
 */
export const SUPPORTED_LANGS = new Set(Object.keys(LANG_PREAMBLE));

/**
 * Parse a comma-separated `--geo` / `--regions` flag into a list of
 * {code, label, instruction}. Unknown codes are ignored with a console warning.
 * Empty / unset → returns `{ regions: [], invalid: [] }` (consistent shape for
 * callers). `--regions` is an operator-facing alias for `--geo`; both feed this
 * one parser so there is a single source of truth for the region list.
 */
export function parseGeoFlag(value) {
  if (!value || typeof value !== 'string') return { regions: [], invalid: [] };
  const codes = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const code of codes) {
    if (!REGIONS[code]) { invalid.push(code); continue; }
    if (seen.has(code)) continue;          // dedup: --regions de,de → one DE cell axis
    seen.add(code);
    valid.push(REGIONS[code]);
  }
  return { regions: valid, invalid };
}

/**
 * Parse a comma-separated `--lang` flag into a list of supported ISO-639-1
 * codes. Unknown codes go to `invalid` (caller warns, degrades to English).
 * Empty / unset → `{ langs: [], invalid: [] }`.
 */
export function parseLangFlag(value) {
  if (!value || typeof value !== 'string') return { langs: [], invalid: [] };
  const codes = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const langs = [];
  const invalid = [];
  const seen = new Set();
  for (const code of codes) {
    if (!SUPPORTED_LANGS.has(code)) { invalid.push(code); continue; }
    if (seen.has(code)) continue;
    seen.add(code);
    langs.push(code);
  }
  return { langs, invalid };
}

/**
 * Choose the language a given region should be asked in.
 *
 * Rule: if `--lang` listed exactly one language, every region uses it (e.g.
 * `--regions de,at,ch --lang de` → all three German-speaking cells asked in
 * German). If `--lang` listed several, a region is matched to its NATIVE
 * language when that language is in the list (de→de, pl→pl, …); regions with no
 * native match in the list fall back to the FIRST listed language. With no
 * `--lang` at all the region is asked in English (byte-identical to `--geo`).
 *
 * This keeps `--lang` a PARAMETER of the existing region axis rather than a new
 * multiplication axis: N regions stay N cells, each carrying one language. That
 * is the deliberate design choice so `--regions × --lang × --samples` does not
 * blow the cell count up combinatorially — only `--regions` and `--samples`
 * multiply (and they already interleave correctly).
 *
 * @param {{code:string}} region   one REGIONS entry
 * @param {string[]} langs         parsed --lang codes (may be empty)
 * @returns {string} ISO-639-1 code; 'en' when no localisation applies
 */
export function resolveRegionLang(region, langs) {
  if (!langs || langs.length === 0) return 'en';
  if (langs.length === 1) return langs[0];
  const native = REGION_NATIVE_LANG[region?.code];
  if (native && langs.includes(native)) return native;
  return langs[0];
}

/** Native language per region — used only to match regions to a `--lang` list
 *  when several languages are requested at once.
 *
 *  A region MISSING from this map silently falls through to `langs[0]` in
 *  `resolveRegionLang`, i.e. it gets whatever language happened to be listed
 *  first. That is invisible on single-`--lang` runs (which short-circuit
 *  earlier) and only bites on multi-language runs — so every entry in REGIONS
 *  must have an entry here. `readme-schema-truth`/`geo-context` tests pin the
 *  two maps to the same key set so a future region cannot be added to one
 *  without the other. */
const REGION_NATIVE_LANG = {
  us: 'en', uk: 'en', ca: 'en', au: 'en', in: 'en',
  de: 'de', fr: 'fr', es: 'es', it: 'it', nl: 'nl', br: 'pt', jp: 'ja',
  // PL + DACH beachhead (2026-08-27). `ch` → 'de' is a DELIBERATE choice, not
  // an oversight: Switzerland is officially multilingual (de/fr/it), and this
  // map only decides which language a CH cell picks when SEVERAL languages are
  // requested at once. German is the largest CH language group, so a
  // `--lang de,fr` run reads CH as German. To measure French- or
  // Italian-speaking Switzerland, pass that language ALONE (`--lang fr`) —
  // a single `--lang` applies to every region and bypasses this map entirely.
  pl: 'pl', at: 'de', ch: 'de',
};

/**
 * Wrap a query with a region preamble. The preamble is short and unambiguous so
 * the LLM understands "answer for this market" without contaminating the actual
 * question.
 *
 * @param {string} query           the base query
 * @param {{instruction:string,code?:string}|null} region  a REGIONS entry (or null = no geo)
 * @param {string} [lang]          ISO-639-1 language for the preamble; defaults
 *                                 to 'en' → byte-identical to the pre-language
 *                                 behaviour (R39). Unknown codes degrade to 'en'.
 */
export function wrapQueryForRegion(query, region, lang = 'en') {
  if (!region) return query;
  const raw = (lang || 'en').toLowerCase();
  // Unknown code degrades to English for BOTH halves — template and fallback
  // preposition must come from the same language or the sentence breaks.
  const code = LANG_PREAMBLE[raw] ? raw : 'en';
  // Localised market phrase when we have one for this (lang, region); otherwise
  // the region's English instruction wrapped in this language's preposition
  // (graceful partial-coverage fallback). Either way the value handed to the
  // template is a COMPLETE phrase — see "THE ONE RULE FOR THIS FILE" above.
  const market = (code !== 'en' && region.code && LANG_MARKET[code]?.[region.code])
    || joinFallbackMarket(code, region.instruction);
  return `${LANG_PREAMBLE[code](market)}${query}`;
}

/**
 * Build the market phrase for an untranslated (lang, region) pair: the region's
 * English name behind the language's own preposition. Languages whose frame
 * needs no preposition (`pl`, `ja`) get the bare name.
 */
function joinFallbackMarket(code, instruction) {
  const prep = LANG_FALLBACK_PREP[code] ?? '';
  return prep ? `${prep} ${instruction}` : instruction;
}

/**
 * Available region codes for help text and validation.
 */
export function listRegionCodes() {
  return Object.keys(REGIONS).join(', ');
}

/**
 * Available language codes for help text and validation.
 */
export function listLangCodes() {
  return Object.keys(LANG_PREAMBLE).join(', ');
}
