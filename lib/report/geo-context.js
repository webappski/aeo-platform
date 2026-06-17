/**
 * Geographic / regional query localisation.
 *
 * Sets aeo-tracker apart from Wellows / OneGlanse / AthenaHQ — none of them
 * support multi-region runs. Implementation is a "soft" geo: we wrap each
 * query with a region-context preamble. We do not fake browser headers or
 * IP-spoof — the LLM sees the explicit region instruction and tailors its
 * answer to that market.
 *
 * Supports the 8 markets where AI-search adoption is meaningful in 2026.
 * Adding a region = one entry in REGIONS map.
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
};

/**
 * Localised market-context preambles. Keyed by ISO-639-1 language code. Each is
 * a self-translation of the English template
 *   "(Answer in the context of <market>.) "
 * written IN that language, so the query the model receives reads natively. The
 * `{market}` token is replaced with a localised market name (see LANG_MARKET).
 *
 * Only the languages the beachhead actually needs are shipped; an unknown
 * `--lang` code degrades to English (the byte-identical `--geo` preamble) rather
 * than throwing — never-fail (AP-FAIL-BRANCHES).
 */
const LANG_PREAMBLE = {
  // English template = the exact pre-feature string, so `--lang en` (or no
  // --lang) reproduces today's `wrapQueryForRegion` byte-for-byte (R39).
  en: (market) => `(Answer in the context of ${market}.) `,
  de: (market) => `(Antworte im Kontext von ${market}. Antworte auf Deutsch.) `,
  pl: (market) => `(Odpowiedz w kontekście ${market}. Odpowiedz po polsku.) `,
  fr: (market) => `(Réponds dans le contexte de ${market}. Réponds en français.) `,
  es: (market) => `(Responde en el contexto de ${market}. Responde en español.) `,
  it: (market) => `(Rispondi nel contesto di ${market}. Rispondi in italiano.) `,
  nl: (market) => `(Antwoord in de context van ${market}. Antwoord in het Nederlands.) `,
  pt: (market) => `(Responda no contexto de ${market}. Responda em português.) `,
  ja: (market) => `(${market}の文脈で回答してください。日本語で回答してください。) `,
};

/**
 * Localised market NAME per (language, region) so the German preamble names the
 * market in German ("dem deutschen Markt") rather than splicing the English
 * "the German market" into a German sentence. Falls back to the region's
 * English `instruction` when a (lang, region) pair isn't translated — partial
 * coverage degrades gracefully instead of producing a broken sentence.
 */
const LANG_MARKET = {
  de: { de: 'dem deutschen Markt', at: 'dem österreichischen Markt', ch: 'dem Schweizer Markt' },
  pl: { pl: 'rynku polskiego' },
  fr: { fr: 'du marché français', ca: 'du marché canadien' },
  es: { es: 'del mercado español' },
  it: { it: 'del mercato italiano' },
  nl: { nl: 'de Nederlandse markt' },
  pt: { br: 'do mercado brasileiro', pt: 'do mercado português' },
  ja: { jp: '日本市場' },
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
 *  when several languages are requested at once. */
const REGION_NATIVE_LANG = {
  us: 'en', uk: 'en', ca: 'en', au: 'en', in: 'en',
  de: 'de', fr: 'fr', es: 'es', it: 'it', nl: 'nl', br: 'pt', jp: 'ja',
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
  const code = (lang || 'en').toLowerCase();
  const tmpl = LANG_PREAMBLE[code] || LANG_PREAMBLE.en;
  // Localised market name when we have one for this (lang, region); otherwise
  // the region's English instruction (graceful partial-coverage fallback).
  const market = (code !== 'en' && region.code && LANG_MARKET[code]?.[region.code])
    || region.instruction;
  return `${tmpl(market)}${query}`;
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
