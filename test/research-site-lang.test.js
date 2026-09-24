/**
 * The site language, as a page actually writes it, through the whole research
 * pipeline — brainstorm → filter → classify → score — with the brainstorm call
 * replaced by a fixed answer. Offline, zero paid calls.
 *
 * Two defects of one family, both invisible as errors:
 *
 *   1. score.js compared the raw `<html lang>` with `=== 'en'`. Pages write
 *      `en-US`, `en-GB`, `EN`; every one of those skipped the −20 penalty for a
 *      non-Latin candidate on an English site, so a Cyrillic query brainstormed
 *      by mistake competed for the top-3 at full score.
 *
 *   2. The per-question language detector knew Polish, German and Russian by
 *      evidence and English only as the ABSENCE of evidence. On a Polish or
 *      German site an English question therefore fell back to the site language
 *      and met the Polish pattern set, where "how to fix" is not a problem query
 *      and "for startups" is not a vertical one.
 *
 * Why the pipeline and not only the functions: the language reaches score.js
 * and reconcileIntent through research.js, which hands both of them the raw
 * `site.lang`. A test on the function alone would stay green if the caller
 * normalised for one and not the other.
 */
import assert from 'node:assert/strict';
import { research } from '../lib/init/research/research.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const CYRILLIC = 'лучшие агентства answer engine optimization';

function brainstormAnswer(queries) {
  return {
    providerCall: async () => ({ text: JSON.stringify({ commercial: queries }) }),
    apiKey: 'offline', model: 'offline', label: 'offline',
  };
}

async function runWith(lang, queries) {
  const result = await research({
    brand: 'Examplebrand',
    domain: 'examplebrand.test',
    site: { lang, title: 'Examplebrand', h1: '', h2: [], description: '' },
    category: 'answer engine optimization consulting',
    primary: brainstormAnswer(queries),
    // No validator → no validation or simulation phase: the pipeline stops at
    // what this file is about (classify + score) and makes no further calls.
  });
  return result.candidates;
}

const ENGLISH_BASKET = [
  'best answer engine optimization agencies 2026',
  'answer engine optimization consultants for B2B startups',
  'top generative engine optimization services',
  'answer engine optimization consulting firms compared',
  CYRILLIC,
];

console.log('\nscore.js — the English-site penalty reads the base subtag');

for (const lang of ['en', 'en-US', 'en_GB', 'EN']) {
  await test(`site lang "${lang}": a Cyrillic candidate is penalised and ranks last`, async () => {
    const cands = await runWith(lang, ENGLISH_BASKET);
    const cyr = cands.find(c => c.text === CYRILLIC);
    assert.ok(cyr, 'the Cyrillic candidate survives the filter — the penalty is the only thing that ranks it');
    assert.ok(cyr.scoreReasons.includes('-20 non-ASCII on English site'),
      `expected the non-ASCII penalty, got: ${cyr.scoreReasons.join(', ')}`);
    assert.equal(cands[cands.length - 1].text, CYRILLIC, 'and it sorts below every English candidate');
  });
}

await test('CONTROL — a non-English site does not apply the English-site penalty', async () => {
  for (const lang of ['pl-PL', 'ru', 'de-DE']) {
    const cands = await runWith(lang, ENGLISH_BASKET);
    const cyr = cands.find(c => c.text === CYRILLIC);
    assert.ok(!cyr.scoreReasons.includes('-20 non-ASCII on English site'), `${lang} must not penalise`);
  }
});

console.log('\nreconcileIntent — an English question on a Polish site is read as English');

const MIXED_PL_BASKET = [
  'how to fix AI search visibility for my startup',
  'answer engine optimization consultants for B2B startups',
  'najlepsze agencje answer engine optimization',
  'najlepsze narzędzia answer engine optimization for SaaS',
  'ile kosztuje agencja answer engine optimization w Polsce',
];

await test('site "pl-PL": English questions get English intent classes', async () => {
  const cands = await runWith('pl-PL', MIXED_PL_BASKET);
  const intentOf = t => cands.find(c => c.text === t)?.intent;
  // Before: no Polish pattern matches → the brainstorm tag, always commercial.
  assert.equal(intentOf('how to fix AI search visibility for my startup'), 'problem');
  assert.equal(intentOf('answer engine optimization consultants for B2B startups'), 'vertical');
});

await test('CONTROL — Polish questions on the same site stay Polish, even with an English word inside', async () => {
  const cands = await runWith('pl-PL', MIXED_PL_BASKET);
  const intentOf = t => cands.find(c => c.text === t)?.intent;
  assert.equal(intentOf('najlepsze agencje answer engine optimization'), 'commercial');
  // "for" is English evidence, the diacritic is Polish evidence — Polish wins,
  // English never decides against another language.
  assert.equal(intentOf('najlepsze narzędzia answer engine optimization for SaaS'), 'commercial');
  assert.equal(intentOf('ile kosztuje agencja answer engine optimization w Polsce'), 'commercial');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
