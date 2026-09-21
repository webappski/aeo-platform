/**
 * Intent classification — language tag handling and the morphological forms a
 * real buyer types.
 *
 * Why this file exists. Three defects lived here undetected because nothing
 * tested the module at all, and all three are the same shape: a pattern that cannot
 * match, failing silently as "unclassified" rather than as an error.
 *
 *   1. The table is keyed by base subtag (`pl`), but the `lang` handed to it is
 *      the raw `<html lang>` attribute of the measured site — `pl-PL`, `de-DE`,
 *      `en-US`, sometimes `PL`. Every one of those missed, so the classifier
 *      never ran; the caller then kept the brainstorm tag, which is always
 *      `commercial`. Measured over the 14 baskets on disk: under any
 *      region-tagged form, 284 of 284 questions classified as null.
 *
 *   2. Polish and German list the superlative in one or two of its forms, and a
 *      buyer types the one that agrees with the noun. "najlepsza agencja" — the
 *      commonest shape in real Polish baskets — matched nothing.
 *
 *   3. A basket is built per MARKET and mixes languages; the site declares one,
 *      and every question was read under it. On disk, webappka holds 30 Polish,
 *      15 English and 5 Russian questions while the site declares `lang="en"`,
 *      so three questions in four were read with the wrong pattern set.
 *
 * And a fourth that would have been introduced writing the Russian set: `\b` is
 * ASCII-only in JavaScript, so `/\bлучший\b/` never matches. A Cyrillic pattern
 * in the older style would have been dead on arrival and looked like "Russian
 * queries are simply unclassified".
 *
 * The forms table below is the point of the file: it fails per FORM, naming the
 * one that regressed, instead of asserting one sentence per language.
 */
import assert from 'node:assert/strict';
import {
  classifyIntent, reconcileIntent, normalizeLang, detectQueryLang, INTENT_PATTERNS,
} from '../lib/init/research/classify-intent.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nnormalizeLang');

for (const [input, expected] of [
  ['pl', 'pl'], ['pl-PL', 'pl'], ['PL', 'pl'], ['en_GB', 'en'], ['  de-DE  ', 'de'],
  ['ru-RU', 'ru'], ['zh-Hans-CN', 'zh'], ['', ''], [undefined, ''], [null, ''], [42, ''],
]) {
  test(`normalizeLang(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
    assert.equal(normalizeLang(input), expected);
  });
}

console.log('\nlanguage tag — a real <html lang> must reach the patterns');

// The exact regression: same sentence, tag written the way pages actually write
// it. Every one of these was null before.
for (const tag of ['pl', 'pl-PL', 'PL', 'pl_PL', ' pl-pl ']) {
  test(`classifyIntent under lang=${JSON.stringify(tag)} classifies a Polish query`, () => {
    assert.equal(classifyIntent('najlepsza agencja AEO w Polsce', tag), 'commercial');
  });
}

test('reconcileIntent normalises too — not just classifyIntent', () => {
  // The half fix that a classifyIntent-only assertion would call green:
  // reconcileIntent decides "supported language" on its own, so leaving it
  // unnormalised keeps the correct classification and then discards it.
  const r = reconcileIntent({ text: 'porównanie narzędzi AEO', intent: 'commercial' }, 'pl-PL');
  assert.equal(r.intentFinal, 'comparison', 'region-tagged Polish must be reclassified, not passed through');
  assert.equal(r.intentAgreement, 'reclassified');
  assert.notEqual(r.intentAgreement, 'lang-unsupported');
});

test('a genuinely unsupported language still falls back to the brainstorm tag', () => {
  const r = reconcileIntent({ text: 'melhores agências de AEO', intent: 'commercial' }, 'pt-BR');
  assert.equal(r.intentAgreement, 'lang-unsupported');
  assert.equal(r.intentFinal, 'commercial');
});

console.log('\nforms — the superlative and price shapes a buyer actually types');

// [lang, query, expected intent]. A form that regresses names itself.
const FORMS = [
  // Polish superlative, across gender/case. Only najlepsze/najlepszy worked.
  ['pl', 'najlepsze narzędzia AEO', 'commercial'],
  ['pl', 'najlepszy tracker widoczności AI', 'commercial'],
  ['pl', 'najlepsza agencja AEO', 'commercial'],
  ['pl', 'wybieram najlepszą platformę AEO', 'commercial'],
  ['pl', 'ranking najlepszej agencji AEO', 'commercial'],
  ['pl', 'lista najlepszych agencji AEO', 'commercial'],
  ['pl', 'najlepsi konsultanci AEO', 'commercial'],
  ['pl', 'polecani konsultanci AEO', 'commercial'],
  // Polish price shapes.
  ['pl', 'ile kosztuje agencja AEO', 'commercial'],
  ['pl', 'cennik usług AEO', 'commercial'],
  ['pl', 'cena audytu AEO', 'commercial'],
  // German superlative, all four endings.
  ['de', 'beste AEO Agentur', 'commercial'],
  ['de', 'bester AEO Anbieter', 'commercial'],
  ['de', 'bestes AEO Tool', 'commercial'],
  ['de', 'die besten AEO Tools', 'commercial'],
  ['de', 'mit bestem Ergebnis kaufen', 'commercial'],
  ['de', 'was kostet eine AEO Agentur', 'commercial'],
  // Russian — the set that did not exist.
  ['ru', 'лучший сервис AEO', 'commercial'],
  ['ru', 'лучшая агентство AEO', 'commercial'],
  ['ru', 'лучшее агентство AEO', 'commercial'],
  ['ru', 'лучшие инструменты AEO', 'commercial'],
  ['ru', 'рейтинг лучших агентств AEO', 'commercial'],
  ['ru', 'сколько стоит AEO продвижение', 'commercial'],
  ['ru', 'сравнение сервисов AEO', 'comparison'],
  ['ru', 'AEO сервис вместо SEO агентства', 'comparison'],
  ['ru', 'как исправить видимость в нейросетях', 'problem'],
  ['ru', 'что такое answer engine optimization', 'informational'],
  ['ru', 'AEO сервис для стартапов', 'vertical'],
];

for (const [lang, query, expected] of FORMS) {
  test(`[${lang}] ${query} → ${expected}`, () => {
    assert.equal(classifyIntent(query, lang), expected);
  });
}

console.log('\nprecision — the boundary has to refuse near-misses');

// Each of these is a word that CONTAINS a listed term. Matching them would
// mislabel a paying client's question, and the stemmed alternatives are exactly
// where that risk lives.
const NON_MATCHES = [
  ['de', 'AEO Tool kostenlos testen', 'commercial', '"kostenlos" means free — the opposite of a price signal'],
  ['de', 'AEO Report bestellen', 'commercial', '"bestellen" is not a superlative'],
  ['pl', 'centrum obsługi AEO', 'commercial', '"centrum" is not "cena"'],
  ['ru', 'ценность AEO для бренда', 'commercial', '"ценность" is value, not price'],
];
for (const [lang, query, mustNotBe, why] of NON_MATCHES) {
  test(`[${lang}] ${query} is NOT ${mustNotBe} — ${why}`, () => {
    assert.notEqual(classifyIntent(query, lang), mustNotBe);
  });
}

console.log('\nCyrillic patterns must actually be able to match');

test('every Russian pattern matches at least one Russian string', () => {
  // Guards the \b trap wholesale: a Cyrillic pattern written ASCII-style is
  // syntactically fine and matches nothing, which reads downstream as "these
  // queries are unclassified" rather than as a broken pattern.
  const probes = {
    comparison: 'сравнение сервисов',
    problem: 'как исправить это',
    commercial: 'лучшие сервисы',
    informational: 'что такое это',
    vertical: 'сервис для стартапов',
  };
  for (const [intent, re] of Object.entries(INTENT_PATTERNS.ru)) {
    assert.ok(re.test(probes[intent]), `ru.${intent} matched nothing — check \\b vs \\p{L}`);
  }
});

console.log('\npriority order is unchanged by the widening');

test('a query that is both superlative and vertical stays commercial', () => {
  // PRIORITY_ORDER puts commercial above vertical, so widening the superlative
  // moves some "best X for Y" queries from vertical to commercial. That is the
  // existing rule applied consistently — English has always behaved this way —
  // and it is pinned here so the move is a decision, not a surprise.
  assert.equal(classifyIntent('best CRM for startups', 'en'), 'commercial');
  assert.equal(classifyIntent('najlepsza agencja dla małych firm', 'pl'), 'commercial');
});

console.log('\ndetectQueryLang — a basket mixes languages, the site declares one');

// The defect this closes: a basket is built per MARKET, the site declares one
// language, and every question was read under it. Measured on the baskets on
// disk — webappka carries 30 Polish, 15 English and 5 Russian questions while
// the site declares `lang="en"`, so 3 questions in 4 were read with the wrong
// pattern set and fell back to the brainstorm tag.

const DETECT = [
  // [query, site language (fallback), expected]
  ['лучшие агентства AEO 2026', 'en', 'ru', 'Cyrillic decides alone'],
  ['najlepsza agencja widoczności AI', 'en', 'pl', 'Polish diacritics'],
  ['beste AEO Agentur für SaaS', 'en', 'de', 'German umlaut'],
  ['porównanie narzędzi AEO', 'en', 'pl', 'ó is Polish within this set — German writes ö'],
  // The case diacritics cannot catch: plain ASCII Polish. This exact question
  // is in a live client basket.
  ['ile kosztuje agencja Answer Engine Optimization w Polsce', 'en', 'pl', 'function words, no diacritic in sight'],
  ['Answer Engine Optimization Agentur Deutschland', 'en', 'de', 'German function word, no umlaut'],
  // No evidence → the SITE language, which is what the pipeline used for every
  // question before this existed. Never 'en' by default.
  ['AEO monitoring platform', 'pl', 'pl', 'no evidence falls back to the site, not to English'],
  ['best AEO agencies 2026', 'en', 'en', 'English is the absence of evidence, not a word list'],
  // A guess would be worse than the fallback.
  ['najlepsza Agentur für widoczności', 'en', 'en', 'two scripts at once is ambiguous — fall back, do not pick'],
];

for (const [query, site, expected, why] of DETECT) {
  test(`detectQueryLang [site=${site}] "${query.slice(0, 44)}" → ${expected} (${why})`, () => {
    assert.equal(detectQueryLang(query, site), expected);
  });
}

test('detectQueryLang is never-fail', () => {
  // It runs inside init, which must not throw on a hand-edited config.
  for (const junk of [null, undefined, '', 42, {}, [], '   ', '!!! ???']) {
    assert.equal(typeof detectQueryLang(junk, 'pl'), 'string');
  }
  assert.equal(detectQueryLang(null, 'de-DE'), 'de', 'the fallback is normalised too');
  assert.equal(detectQueryLang('   ', undefined), 'en', 'no fallback at all still returns something usable');
});

test('English terms that look foreign are NOT claimed by a word list', () => {
  // The risk the word lists carry: a term shared with English sends an English
  // question to a foreign pattern set. "top" and "ranking" are Polish words too
  // and are deliberately absent from the detector for exactly this reason.
  assert.equal(detectQueryLang('top ranking AEO tools', 'en'), 'en');
  assert.equal(detectQueryLang('best AEO platform for firms', 'en'), 'en');
});

console.log('\nreconcileIntent classifies per question, not per site');

test('a Polish question in an English-declaring basket is read as Polish', () => {
  // Before: site lang 'en' → English patterns → no match → brainstorm tag.
  const r = reconcileIntent(
    { text: 'agencja answer engine optimization w Polsce dla B2B SaaS', intent: 'commercial' },
    'en',
  );
  assert.equal(r.intentLang, 'pl', 'the question is Polish regardless of what the site declares');
  assert.equal(r.intentFinal, 'vertical', 'and reading it as Polish is what makes it classifiable');
});

test('a Russian question in an English-declaring basket is read as Russian', () => {
  const r = reconcileIntent(
    { text: 'лучшие агентства Answer Engine Optimization 2026', intent: 'commercial' },
    'en',
  );
  assert.equal(r.intentLang, 'ru');
  assert.equal(r.intentFinal, 'commercial');
  assert.equal(r.intentAgreement, 'match');
});

test('CONTROL — a question in the site language is untouched by detection', () => {
  // The guarantee that makes this change safe: a single-language basket cannot
  // move. Verified over the real baskets on disk (2026-09-21) — every
  // monolingual one reported zero changed classifications AND zero changed
  // tags; only the four mixed baskets moved.
  for (const [text, site, expected] of [
    ['best AEO agencies 2026', 'en', 'commercial'],
    ['najlepsza agencja AEO', 'pl', 'commercial'],
    ['porównanie narzędzi AEO', 'pl', 'comparison'],
  ]) {
    const r = reconcileIntent({ text, intent: 'commercial' }, site);
    assert.equal(r.intentLang, site, `${text} must stay on the site language`);
    assert.equal(r.intentFinal, expected);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
