/**
 * Phase 3 part 1 — language-aware intent classification.
 *
 * Classifies a query string into one of: commercial, informational, vertical,
 * problem, comparison, or null (unclassified).
 *
 * Primary source of intent is the brainstorm LLM's own tagging — this function
 * is a VERIFIER that either confirms or reclassifies based on linguistic
 * patterns. For unsupported languages, returns null so the caller falls back
 * to the LLM's original tag.
 *
 * TWO THINGS TO KNOW BEFORE EDITING A PATTERN.
 *
 * 1. The `lang` that arrives here is the RAW `<html lang>` attribute of the
 *    measured site (lib/init/fetch-site.js → research.js). Real pages write
 *    `pl-PL`, `de-DE`, `en-US`, sometimes `PL` or `en_GB`. This table is keyed
 *    by base subtag, so every one of those used to miss, the classifier never
 *    ran, and the caller silently kept the brainstorm tag — which is always
 *    `commercial`, because brainstorm.js narrowed INTENT_BUCKETS to that one
 *    bucket. Measured 2026-09-21 across the 14 baskets on disk: under any
 *    region-tagged form, 284 of 284 questions classified as null. Hence
 *    `normalizeLang`, applied by BOTH entry points — `reconcileIntent` decides
 *    "is this language supported" on its own and would otherwise still bail.
 *
 * 2. `\b` is ASCII-only in JavaScript, even under the `u` flag: `\w` is
 *    `[A-Za-z0-9_]`, so `/\bлучший\b/` and `/\bnajlepszą\b` never match a real
 *    word. Patterns that must span non-ASCII letters use `(?<!\p{L})…(?!\p{L})`
 *    with the `u` flag instead. The older ASCII-anchored patterns are left as
 *    they are: each begins and ends on an ASCII letter, where `\b` is correct.
 *
 * Patterns are matched against a whole query, so they are written to be precise
 * rather than greedy — a false positive mislabels a paying client's question in
 * a document they read.
 */

/**
 * Base subtag of a BCP-47-ish language attribute, lower-cased.
 *
 * `pl-PL` → `pl`, `en_GB` → `en`, `PL` → `pl`, ` de ` → `de`, missing → `''`.
 * Deliberately not exhaustive BCP-47 parsing: the only job is to turn what a
 * page actually declares into the key this table uses.
 *
 * NOTE: normalisation happens HERE, not at the source in fetch-site.js. The raw
 * attribute is also interpolated into the brainstorm prompt
 * (`LANGUAGE: ${site.lang}`), and changing what an LLM prompt says is a change
 * that has to be measured against main on its own terms — a different job from
 * fixing a lookup key.
 *
 * @param {string} [lang]
 * @returns {string} base subtag, or '' when there is nothing usable
 */
export function normalizeLang(lang) {
  if (typeof lang !== 'string') return '';
  return lang.trim().toLowerCase().split(/[-_]/)[0] || '';
}

const INTENT_PATTERNS = {
  en: {
    comparison:    /\b(vs|versus|alternative to|compared to|better than|cheaper than|instead of)\b/i,
    problem:       /\b(how to fix|solve|stop|avoid|replace|get rid of|troubleshoot)\b/i,
    commercial:    /\b(best|top|leading|most popular|review|compare|pricing|buy|purchase|choose)\b/i,
    informational: /\b(how to|how do|what is|what are|guide to|tutorial|introduction to|explained|learn)\b/i,
    vertical:      /\bfor\s+(saas|enterprise|startups?|agencies|small businesses|b2b|b2c|healthcare|fintech|ecommerce|education|hospitality|legal|manufacturing|marketers?|developers?|founders?)\b/i,
  },
  pl: {
    comparison:    /\b(vs\.?|kontra|porównanie|lepsze niż|zamiast|alternatywa dla)\b/i,
    problem:       /\b(jak rozwiązać|jak naprawić|jak uniknąć|jak zastąpić|problem z)\b/i,
    // Polish inflects the superlative through seven cases and three genders, and
    // the form a buyer actually types is the one that agrees with the noun:
    // "najlepsza agencja", "najlepszą platformę", "najlepszej firmy". Only the
    // masculine and neuter nominative were listed, so real client baskets —
    // where "najlepsza agencja …" is the commonest shape there is — fell through
    // to null. `najlepsz\p{L}*` covers the whole paradigm (no other Polish word
    // starts with that stem); `najlepsi` is the masculine-personal plural, which
    // does not share it. Prices are enumerated rather than stemmed: `cen\p{L}*`
    // would swallow "centrum", "centrala", "cenzura".
    commercial:    /(?<!\p{L})(?:najlepsz\p{L}*|najlepsi|top|ranking|polecan\p{L}*|cena|ceny|cenę|cennik|ile kosztuje|kup|kupić|wybierz|wybrać)(?!\p{L})/iu,
    informational: /\b(jak\s|co to jest|czym jest|poradnik|przewodnik|wprowadzenie do|instrukcja)\b/i,
    vertical:      /\b(dla\s+(saas|firm|startupów|agencji|małych firm|b2b|healthcare|fintech|ecommerce|edukacji))\b/i,
  },
  de: {
    comparison:    /\b(vs\.?|versus|vergleich|besser als|alternative zu|statt)\b/i,
    problem:       /\b(wie löst man|wie behebt|probleme mit|fehler beheben|ersetzen)\b/i,
    // Same gap as Polish, smaller paradigm: `bestes`, `besten` and `bestem`
    // were missing, and `besten` is the form that appears in the most common
    // German buying phrase there is ("die besten Tools für …"). Enumerated, not
    // stemmed — `best\p{L}*` would match "bestellen", "bestätigen", "Bestand".
    // The trailing boundary is what keeps `kosten` from firing on "kostenlos",
    // which means free and is the opposite signal.
    commercial:    /(?<!\p{L})(?:beste|bester|bestes|besten|bestem|top|empfehlenswert|preis|preise|preisliste|was kostet|kosten|kaufen|auswählen)(?!\p{L})/iu,
    informational: /\b(wie\s|was ist|was sind|anleitung|einführung in|tutorial)\b/i,
    vertical:      /\b(für\s+(saas|unternehmen|startups?|agenturen|kleine unternehmen|b2b|healthcare|fintech))\b/i,
  },
  // Russian had no entry at all, so `reconcileIntent` reported
  // `lang-unsupported` for every Russian site and kept the brainstorm tag.
  // Written Unicode-safe from the first character: `\b` cannot delimit Cyrillic
  // (see the header note), so an entry copied in the older ASCII style would
  // have matched nothing and looked like "Russian queries are just unclassified".
  //
  // Measured against the baskets on disk (2026-09-21): 32 of 284 questions are
  // Russian — including our own webappski basket — and 22 of those now carry a
  // class (17 commercial, 5 vertical). The 10 that stay null carry no buying or
  // comparison marker at all ("агентство, занимающееся видимостью бренда в AI"),
  // which is the right answer, not a missing form.
  ru: {
    comparison:    /(?<!\p{L})(?:vs\.?|против|сравнение|сравнить|лучше чем|вместо|альтернатива|аналог|аналоги)(?!\p{L})/iu,
    problem:       /(?<!\p{L})(?:как исправить|как решить|как убрать|как заменить|как избавиться|проблема с|не работает)(?!\p{L})/iu,
    // `лучш\p{L}*` spans лучший / лучшая / лучшее / лучшие / лучших / лучшую /
    // лучшим. Prices enumerated for the same reason as Polish: `цен\p{L}*`
    // would take "ценность" and "цензура".
    commercial:    /(?<!\p{L})(?:лучш\p{L}*|топ|рейтинг|цена|цены|цену|стоимость|сколько стоит|купить|выбрать)(?!\p{L})/iu,
    informational: /(?<!\p{L})(?:что такое|чем отличается|руководство|инструкция|гайд|введение в|как работает)(?!\p{L})/iu,
    vertical:      /(?<!\p{L})для\s+(?:saas|бизнеса|малого бизнеса|стартапов|агентств|b2b|b2c|интернет-магазинов|клиник|юристов|маркетологов|разработчиков)(?!\p{L})/iu,
  },
};

// ─── Which language is THIS question written in? ────────────────────────────
//
// The site declares one language; a basket is built per MARKET and routinely
// mixes them. Measured on the baskets on disk 2026-09-21: webappka carries 30
// Polish, 15 English and 5 Russian questions in one basket, and the site
// declares `lang="en"` — so every Polish and Russian question was read with
// English patterns, matched nothing, and fell back to the brainstorm tag. The
// site language answers "who is this report for", not "what language is this
// sentence".
//
// Deliberately conservative, and it never guesses: evidence or fall back. No
// dependency, no network, no statistics — a letter that exists in exactly one
// of the languages we support, or a function word that does. Ambiguous or
// unmarked input returns the fallback (the site language), which is exactly the
// behaviour that existed before, so this can only add classification, never
// take it away from a question that was already being read correctly.

/** Letters that exist in exactly ONE of our supported languages. */
const SCRIPT_MARKS = [
  // Cyrillic block — no other supported language uses it, so it decides alone.
  { lang: 'ru', re: /[Ѐ-ӿ]/ },
  // Polish diacritics. `ó` is included: German writes `ö`, Russian is Cyrillic
  // and English has none, so within this set it is unambiguous.
  { lang: 'pl', re: /[ąćęłńóśźż]/i },
  // German umlauts + eszett. Disjoint from the Polish set above.
  { lang: 'de', re: /[äöüß]/i },
];

/**
 * Function words for the case the diacritics miss — a real one, not a
 * hypothetical: "ile kosztuje agencja Answer Engine Optimization w Polsce" is
 * plain ASCII from end to end. Each term is checked against the other supported
 * languages before being listed here; anything that also reads as English
 * ("top", "ranking", "firm") is left out on purpose, because a false positive
 * sends an English question to a foreign pattern set.
 */
const LANG_WORDS = {
  pl: /(?<!\p{L})(?:dla|jak|czy|ile|kosztuje|najlepsz\p{L}*|najlepsi|agencj\p{L}*|polecan\p{L}*|cennik|konsultanci|narzedzia)(?!\p{L})/iu,
  de: /(?<!\p{L})(?:agentur|anbieter|werkzeug\p{L}*|kostet|vergleich|empfehlung|sichtbarkeit|unternehmen|beste[nrs]?)(?!\p{L})/iu,
};

/**
 * The language a single question is written in.
 *
 * @param {string} text            the question
 * @param {string} [fallbackLang]  site language, used when the question carries
 *                                 no decisive evidence — NOT 'en', because the
 *                                 site language is the better prior and is what
 *                                 the pipeline used before this existed
 * @returns {string} a base subtag; never throws, always returns something
 */
export function detectQueryLang(text, fallbackLang = 'en') {
  const fallback = normalizeLang(fallbackLang) || 'en';
  if (!text || typeof text !== 'string') return fallback;

  const byScript = SCRIPT_MARKS.filter(m => m.re.test(text)).map(m => m.lang);
  // One script marker decides. Two means a mixed or mis-typed string (a Polish
  // word beside a German one), where any pick would be a guess — fall back.
  if (byScript.length === 1) return byScript[0];
  if (byScript.length > 1) return fallback;

  const byWord = Object.entries(LANG_WORDS).filter(([, re]) => re.test(text)).map(([l]) => l);
  if (byWord.length === 1) return byWord[0];

  return fallback;
}

// Language-priority order for tie-breaking — comparison before problem before commercial etc.
// Ensures "alternative to X for startups" classifies as comparison (most specific) not vertical.
const PRIORITY_ORDER = ['comparison', 'problem', 'commercial', 'informational', 'vertical'];

/**
 * Classify a query into an intent bucket.
 *
 * @param {string} text
 * @param {string} [lang='en']  ISO 639-1 code; unsupported languages return null
 * @returns {string|null}       one of the intent bucket names, or null
 */
export function classifyIntent(text, lang = 'en') {
  if (!text || typeof text !== 'string') return null;
  const patterns = INTENT_PATTERNS[normalizeLang(lang)];
  if (!patterns) return null; // caller falls back to LLM's brainstorm tag

  for (const intent of PRIORITY_ORDER) {
    const re = patterns[intent];
    if (re && re.test(text)) return intent;
  }
  return null;
}

/**
 * Annotate a candidate with both its brainstorm-assigned intent and our
 * classifier's verdict. When they disagree, prefer the classifier for supported
 * languages, keep the brainstorm tag otherwise.
 */
export function reconcileIntent(cand, lang = 'en') {
  // Normalise ONCE here and pass the base subtag down. This function keeps its
  // own idea of "supported", so normalising only inside classifyIntent would
  // leave a `pl-PL` site classified correctly and then thrown away on the
  // `lang-unsupported` branch below — a half fix that a test asserting on
  // classifyIntent alone would call green.
  // `lang` is the SITE language — the fallback, not the verdict. Which language
  // a given question is written in is decided per question (detectQueryLang),
  // because a basket is built per market and mixes them. A question with no
  // decisive evidence falls back to the site language, which is what this
  // function used for every question before, so nothing that already classified
  // correctly can stop doing so.
  const siteLang = normalizeLang(lang);
  const queryLang = detectQueryLang(cand.text, siteLang);
  const classified = classifyIntent(cand.text, queryLang);
  const brainstormIntent = cand.intent;
  const supportedLang = INTENT_PATTERNS[queryLang] !== undefined;

  if (!supportedLang) {
    return { ...cand, intentFinal: brainstormIntent, intentAgreement: 'lang-unsupported', intentLang: queryLang };
  }
  if (classified === brainstormIntent) {
    return { ...cand, intentFinal: classified, intentAgreement: 'match', intentLang: queryLang };
  }
  if (classified === null) {
    return { ...cand, intentFinal: brainstormIntent, intentAgreement: 'classifier-unsure', intentLang: queryLang };
  }
  return { ...cand, intentFinal: classified, intentAgreement: 'reclassified', intentOriginal: brainstormIntent, intentLang: queryLang };
}

export { INTENT_PATTERNS };
