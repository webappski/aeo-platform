import assert from 'node:assert/strict';
import {
  parseGeoFlag, wrapQueryForRegion, REGIONS, listRegionCodes,
  parseLangFlag, resolveRegionLang, listLangCodes, SUPPORTED_LANGS,
} from '../lib/report/geo-context.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nparseGeoFlag');

test('parses single code', () => {
  const r = parseGeoFlag('us');
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].code, 'us');
  assert.deepEqual(r.invalid, []);
});

test('parses comma-separated codes', () => {
  const r = parseGeoFlag('us,uk,de');
  assert.equal(r.regions.length, 3);
  assert.deepEqual(r.regions.map(x => x.code), ['us', 'uk', 'de']);
});

test('case-insensitive codes', () => {
  const r = parseGeoFlag('US,De,UK');
  assert.equal(r.regions.length, 3);
});

test('whitespace tolerated', () => {
  const r = parseGeoFlag('us, uk , de');
  assert.equal(r.regions.length, 3);
});

test('unknown codes go to invalid bucket', () => {
  const r = parseGeoFlag('us,zz,de,xx');
  assert.equal(r.regions.length, 2);
  assert.deepEqual(r.invalid, ['zz', 'xx']);
});

test('empty / falsy input → consistent empty shape', () => {
  assert.deepEqual(parseGeoFlag(''),         { regions: [], invalid: [] });
  assert.deepEqual(parseGeoFlag(null),       { regions: [], invalid: [] });
  assert.deepEqual(parseGeoFlag(undefined),  { regions: [], invalid: [] });
});

test('dedups repeated region codes', () => {
  const r = parseGeoFlag('de,de,us,de');
  assert.deepEqual(r.regions.map(x => x.code), ['de', 'us']);
});

console.log('\nwrapQueryForRegion');

test('wraps query with region preamble', () => {
  const wrapped = wrapQueryForRegion('best CRM 2026', REGIONS.de);
  assert.ok(wrapped.includes('German market'));
  assert.ok(wrapped.includes('best CRM 2026'));
  assert.ok(wrapped.startsWith('('));
});

test('null region passes query through unchanged', () => {
  assert.equal(wrapQueryForRegion('best CRM', null), 'best CRM');
  assert.equal(wrapQueryForRegion('best CRM', undefined), 'best CRM');
});

// R39 invariance: with no lang (or lang='en') the wrapped string is BYTE-
// identical to the pre-language behaviour. This is the load-bearing guard that
// a default --geo run did not change.
test('R39: default lang (en) is byte-identical to pre-language preamble', () => {
  const expected = '(Answer in the context of the German market.) best CRM 2026';
  assert.equal(wrapQueryForRegion('best CRM 2026', REGIONS.de), expected);
  assert.equal(wrapQueryForRegion('best CRM 2026', REGIONS.de, 'en'), expected);
});

// R39, second load-bearing cell: `de→de` is the ONLY localised cell that
// appears in historical measurement runs, so its prompt must not drift. Pinned
// with full-string equality (it was previously guarded only by
// `.includes('dem deutschen Markt')`, which would have survived any change to
// the frame around it).
test('R39: lang=de × region=de is byte-stable (the one cell with run history)', () => {
  assert.equal(
    wrapQueryForRegion('beste CRM 2026', REGIONS.de, 'de'),
    '(Antworte im Kontext von dem deutschen Markt. Antworte auf Deutsch.) beste CRM 2026',
  );
});

test('lang=pl wraps query IN Polish', () => {
  assert.equal(
    wrapQueryForRegion('najlepszy CRM', REGIONS.de, 'pl'),
    '(Odpowiedz w kontekście the German market. Odpowiedz po polsku.) najlepszy CRM',
  );
});

test('lang with no localised market name for the region → English market fallback (no broken sentence)', () => {
  // pl preamble exists, but LANG_MARKET.pl has no entry for the US region. The
  // Polish frame governs the slot directly, so the English name is spliced bare
  // — no preposition is added, and none is missing.
  assert.equal(
    wrapQueryForRegion('best CRM', REGIONS.us, 'pl'),
    '(Odpowiedz w kontekście the United States market. Odpowiedz po polsku.) best CRM',
  );
});

test('fallback keeps the frame grammatical — the language supplies its own preposition', () => {
  // The mirror of the doubled-preposition bug: templates carry no preposition,
  // so an untranslated pair must get one from LANG_FALLBACK_PREP or the
  // sentence loses it ("dans le contexte the United States market").
  assert.equal(
    wrapQueryForRegion('meilleur CRM', REGIONS.us, 'fr'),
    '(Réponds dans le contexte de the United States market. Réponds en français.) meilleur CRM',
  );
  assert.equal(
    wrapQueryForRegion('bestes CRM', REGIONS.us, 'de'),
    '(Antworte im Kontext von the United States market. Antworte auf Deutsch.) bestes CRM',
  );
});

test('unknown lang code degrades to English preamble (never-fail)', () => {
  const wrapped = wrapQueryForRegion('best CRM', REGIONS.de, 'zz');
  assert.equal(wrapped, '(Answer in the context of the German market.) best CRM');
});

console.log('\nparseLangFlag');

test('parses supported lang codes', () => {
  const r = parseLangFlag('de,pl');
  assert.deepEqual(r.langs, ['de', 'pl']);
  assert.deepEqual(r.invalid, []);
});

test('unknown lang codes go to invalid bucket', () => {
  const r = parseLangFlag('de,zz,pl');
  assert.deepEqual(r.langs, ['de', 'pl']);
  assert.deepEqual(r.invalid, ['zz']);
});

test('lang flag dedups + empty shape', () => {
  assert.deepEqual(parseLangFlag('de,de').langs, ['de']);
  assert.deepEqual(parseLangFlag(''), { langs: [], invalid: [] });
  assert.deepEqual(parseLangFlag(null), { langs: [], invalid: [] });
});

console.log('\nresolveRegionLang');

test('no langs → English', () => {
  assert.equal(resolveRegionLang(REGIONS.de, []), 'en');
  assert.equal(resolveRegionLang(REGIONS.de, undefined), 'en');
});

test('single lang applies to every region', () => {
  assert.equal(resolveRegionLang(REGIONS.de, ['de']), 'de');
  // Was `REGIONS.at ?? REGIONS.us` — a fossil from when `at` did not exist,
  // which silently tested Germany-or-USA. `at` ships since 2026-08-27, so the
  // assertion is now unconditional and actually about Austria.
  assert.equal(resolveRegionLang(REGIONS.at, ['de']), 'de');
});

test('multiple langs → region matched to its native language', () => {
  assert.equal(resolveRegionLang(REGIONS.de, ['de', 'pl']), 'de');
  assert.equal(resolveRegionLang(REGIONS.fr, ['de', 'fr']), 'fr');
});

test('multiple langs, region has no native match → first listed', () => {
  // US is natively 'en'; 'en' not in [de, pl] → first listed (de)
  assert.equal(resolveRegionLang(REGIONS.us, ['de', 'pl']), 'de');
});

// ── PL + DACH beachhead (2026-08-27) ──────────────────────────────────────
// The bug this locks: `LANG_MARKET` shipped localised names for pl/at/ch long
// before REGIONS did, so `--regions pl,at,ch` was rejected outright and the
// translations were unreachable. Adding them to REGIONS alone is NOT enough —
// REGION_NATIVE_LANG must grow too, or a MULTI-language run silently asks the
// Austrian and Swiss cells in whatever language sorts first in `--lang`.

test('pl/at/ch are real regions with their own market instruction', () => {
  for (const [code, label] of [['pl', 'Poland'], ['at', 'Austria'], ['ch', 'Switzerland']]) {
    const r = parseGeoFlag(code);
    assert.equal(r.regions.length, 1, `--regions ${code} must parse`);
    assert.deepEqual(r.invalid, [], `--regions ${code} must not land in the invalid bucket`);
    assert.equal(r.regions[0].label, label);
  }
});

test('multi-lang run asks AT and CH in German, PL in Polish (not langs[0])', () => {
  // The discriminating case. With --lang pl,de listed in THAT order, a region
  // missing from REGION_NATIVE_LANG falls through to langs[0] = 'pl' — i.e.
  // the Austrian and Swiss cells would be asked in Polish.
  assert.equal(resolveRegionLang(REGIONS.pl, ['pl', 'de']), 'pl');
  assert.equal(resolveRegionLang(REGIONS.at, ['pl', 'de']), 'de', 'Austria must be asked in German');
  assert.equal(resolveRegionLang(REGIONS.ch, ['pl', 'de']), 'de', 'Switzerland must be asked in German');
});

test('GUARD — every REGIONS code has a REGION_NATIVE_LANG entry', () => {
  // REGION_NATIVE_LANG is module-private, so this probes it behaviourally: a
  // region that HAS a native entry resolves to that entry regardless of the
  // ORDER of the --lang list; a region MISSING from the map resolves to
  // langs[0] and therefore changes answer when the list is rotated.
  const all = [...SUPPORTED_LANGS];
  const rotated = [...all.slice(1), all[0]];
  for (const code of Object.keys(REGIONS)) {
    const a = resolveRegionLang(REGIONS[code], all);
    const b = resolveRegionLang(REGIONS[code], rotated);
    assert.equal(
      a, b,
      `region "${code}" resolves to a different language depending on --lang ORDER ` +
      `(${a} vs ${b}) — it is missing from REGION_NATIVE_LANG and falls through to langs[0]`,
    );
  }
});

// ── GOLDEN TABLE — every (lang × region) cell, as a full string ───────────
//
// WHY full strings and not `.includes()`. The assertions that used to live here
// were `.includes('du marché suisse')`, which passed happily on the string the
// tool actually shipped: "(Réponds dans le contexte DE DU marché suisse. …)" —
// a doubled preposition (`de` from the template + `du` = `de`+`le` from the
// market phrase). Substring assertions cannot see the words AROUND the needle,
// which is exactly where prompt grammar lives. Every assertion below compares
// the whole rendered preamble.
//
// WHY exhaustive. The refactor that fixed the doubled preposition established
// one rule — the template supplies no grammar, the market phrase carries its
// own — and a rule with no mechanical guard is re-broken by the next
// (lang, region) pair somebody adds. The sweep below renders ALL
// |SUPPORTED_LANGS| × |REGIONS| cells and demands a golden line for each, so:
//   - adding a LANG_MARKET phrase without a golden entry → RED (the cell no
//     longer matches its language's fallback shape),
//   - adding a language without a golden entry → RED (missing GOLDEN_FALLBACK),
//   - changing any template → RED across that whole language.
//
// A blanket "no doubled preposition" regex was considered and rejected on its
// own: `von dem` is CORRECT at de→de and R39-protected, so a pattern loose
// enough to catch `de du` false-positives on the one cell that must not move.
// The sweep at the end pairs the golden table with a tokenised adjacency check
// whose per-language token sets exclude articles, which catches the class
// without an allowlist.

// One hand-written line per language, using a region that has NO localised
// market phrase. Pins the template AND the fallback preposition together.
const GOLDEN_FALLBACK = {
  en: { region: 'de', expect: '(Answer in the context of the German market.) Q' },
  de: { region: 'fr', expect: '(Antworte im Kontext von the French market. Antworte auf Deutsch.) Q' },
  pl: { region: 'de', expect: '(Odpowiedz w kontekście the German market. Odpowiedz po polsku.) Q' },
  fr: { region: 'de', expect: '(Réponds dans le contexte de the German market. Réponds en français.) Q' },
  es: { region: 'de', expect: '(Responde en el contexto de the German market. Responde en español.) Q' },
  it: { region: 'de', expect: '(Rispondi nel contesto di the German market. Rispondi in italiano.) Q' },
  nl: { region: 'de', expect: '(Antwoord in de context van the German market. Antwoord in het Nederlands.) Q' },
  pt: { region: 'de', expect: '(Responda no contexto de the German market. Responda em português.) Q' },
  ja: { region: 'de', expect: '(the German marketの文脈で回答してください。日本語で回答してください。) Q' },
};

// Every (lang, region) pair that HAS a localised market phrase. `en` has none
// by design — wrapQueryForRegion's `code !== 'en'` guard sends it down the
// fallback path, which is what keeps `--geo` byte-identical (R39).
//
// `pt→pt` is absent because Portugal is not a REGION (only `br` is), so the
// translation LANG_MARKET.pt.pt is unreachable and no cell renders it.
const GOLDEN_TRANSLATED = {
  // ⚠️ de→de keeps `von dem` (R39 — the only cell with historical runs);
  // de→at / de→ch are new in 2026-08-27 and ship the idiomatic `vom`.
  'de|de': '(Antworte im Kontext von dem deutschen Markt. Antworte auf Deutsch.) Q',
  'de|at': '(Antworte im Kontext vom österreichischen Markt. Antworte auf Deutsch.) Q',
  'de|ch': '(Antworte im Kontext vom Schweizer Markt. Antworte auf Deutsch.) Q',
  'pl|pl': '(Odpowiedz w kontekście rynku polskiego. Odpowiedz po polsku.) Q',
  'fr|fr': '(Réponds dans le contexte du marché français. Réponds en français.) Q',
  'fr|ca': '(Réponds dans le contexte du marché canadien. Réponds en français.) Q',
  'fr|ch': '(Réponds dans le contexte du marché suisse. Réponds en français.) Q',
  'es|es': '(Responde en el contexto del mercado español. Responde en español.) Q',
  'it|it': '(Rispondi nel contesto del mercato italiano. Rispondi in italiano.) Q',
  'it|ch': '(Rispondi nel contesto del mercato svizzero. Rispondi in italiano.) Q',
  'nl|nl': '(Antwoord in de context van de Nederlandse markt. Antwoord in het Nederlands.) Q',
  'pt|br': '(Responda no contexto do mercado brasileiro. Responda em português.) Q',
  'ja|jp': '(日本市場の文脈で回答してください。日本語で回答してください。) Q',
};

test('GOLDEN — every (lang × region) cell renders its exact expected preamble', () => {
  let checked = 0;
  for (const lang of [...SUPPORTED_LANGS]) {
    const ref = GOLDEN_FALLBACK[lang];
    assert.ok(
      ref,
      `language "${lang}" is supported but has no GOLDEN_FALLBACK line — write the ` +
      `rendered preamble out by hand and READ it before adding a language`,
    );
    assert.ok(
      !(`${lang}|${ref.region}` in GOLDEN_TRANSLATED),
      `GOLDEN_FALLBACK.${lang} must reference an UNTRANSLATED region, but ` +
      `"${lang}|${ref.region}" has a localised market phrase`,
    );
    for (const code of Object.keys(REGIONS)) {
      const actual = wrapQueryForRegion('Q', REGIONS[code], lang);
      const key = `${lang}|${code}`;
      const expected = key in GOLDEN_TRANSLATED
        ? GOLDEN_TRANSLATED[key]
        // Untranslated: the language's golden fallback with this region's
        // English name swapped in. Derived from a HAND-WRITTEN string, not from
        // the module, so it is a real assertion and not a tautology.
        : ref.expect.replace(REGIONS[ref.region].instruction, REGIONS[code].instruction);
      assert.equal(
        actual, expected,
        `cell ${key} drifted.\n      expected: ${expected}\n      actual:   ${actual}`,
      );
      checked++;
    }
  }
  assert.equal(checked, SUPPORTED_LANGS.size * Object.keys(REGIONS).length,
    'the sweep must cover every language × region cell');
});

// Per-language preposition tokens (contractions included, ARTICLES excluded —
// `dem` is an article, which is why `von dem` at de→de does not trip this).
// `pl` and `ja` are empty: their frames govern the market slot directly.
const PREPOSITION_TOKENS = {
  en: ['of'],
  de: ['von', 'vom'],
  pl: [],
  fr: ['de', 'du', 'des'],
  es: ['de', 'del'],
  it: ['di', 'del', 'della', 'dei', 'delle', 'dello', 'degli'],
  nl: ['van'],
  pt: ['de', 'do', 'da', 'dos', 'das'],
  ja: [],
};

test('GUARD — no cell renders two prepositions in a row (the "de du marché" class)', () => {
  for (const lang of [...SUPPORTED_LANGS]) {
    const preps = new Set(PREPOSITION_TOKENS[lang] ?? []);
    if (preps.size === 0) continue;
    for (const code of Object.keys(REGIONS)) {
      // Empty query → the rendered string IS the preamble.
      const preamble = wrapQueryForRegion('', REGIONS[code], lang);
      const words = preamble
        .split(/\s+/)
        .map(w => w.replace(/^[(«"']+|[).,;:!?»"']+$/g, ''))
        .filter(Boolean);
      for (let i = 0; i + 1 < words.length; i++) {
        assert.ok(
          !(preps.has(words[i]) && preps.has(words[i + 1])),
          `cell ${lang}|${code} renders a doubled preposition ` +
          `"${words[i]} ${words[i + 1]}" — the template and the market phrase are ` +
          `both supplying grammar for the same slot: ${preamble}`,
        );
      }
    }
  }
});

console.log('\nlistLangCodes / SUPPORTED_LANGS');

test('lists supported lang codes incl en, de, pl', () => {
  const codes = listLangCodes();
  assert.ok(codes.includes('en'));
  assert.ok(codes.includes('de'));
  assert.ok(codes.includes('pl'));
  assert.ok(SUPPORTED_LANGS.has('de'));
  assert.ok(!SUPPORTED_LANGS.has('zz'));
});

console.log('\nlistRegionCodes');

test('returns comma-separated code list', () => {
  const codes = listRegionCodes();
  assert.ok(codes.includes('us'));
  assert.ok(codes.includes('uk'));
  assert.ok(codes.includes('de'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
