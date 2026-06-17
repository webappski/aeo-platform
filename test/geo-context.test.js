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

test('lang=de wraps query IN German with localised market name', () => {
  const wrapped = wrapQueryForRegion('beste CRM 2026', REGIONS.de, 'de');
  assert.ok(wrapped.includes('Antworte auf Deutsch'));
  assert.ok(wrapped.includes('dem deutschen Markt'));
  assert.ok(wrapped.includes('beste CRM 2026'));
});

test('lang=pl wraps query IN Polish', () => {
  const wrapped = wrapQueryForRegion('najlepszy CRM', REGIONS.de, 'pl');
  assert.ok(wrapped.includes('po polsku'));
  assert.ok(wrapped.includes('najlepszy CRM'));
});

test('lang with no localised market name for the region → English market fallback (no broken sentence)', () => {
  // pl preamble exists, but LANG_MARKET.pl has no entry for the US region.
  const wrapped = wrapQueryForRegion('best CRM', REGIONS.us, 'pl');
  assert.ok(wrapped.includes('po polsku'));
  // falls back to the region's English instruction inside the Polish frame
  assert.ok(wrapped.includes('the United States market'));
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
  assert.equal(resolveRegionLang(REGIONS.at ?? REGIONS.us, ['de']), 'de');
});

test('multiple langs → region matched to its native language', () => {
  assert.equal(resolveRegionLang(REGIONS.de, ['de', 'pl']), 'de');
  assert.equal(resolveRegionLang(REGIONS.fr, ['de', 'fr']), 'fr');
});

test('multiple langs, region has no native match → first listed', () => {
  // US is natively 'en'; 'en' not in [de, pl] → first listed (de)
  assert.equal(resolveRegionLang(REGIONS.us, ['de', 'pl']), 'de');
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
