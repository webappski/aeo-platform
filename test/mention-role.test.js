// AP-MENTION-ROLE-VENDOR-VS-SOURCE — a naming counted as visibility must say
// WHICH naming it was: a supplier the asker could engage, or the author of a
// ranking about rivals.
//
// THE THREE REAL CELLS. From the run of 2026-09-16, recorded verbatim in the
// board card `AP-MENTION-ROLE-VENDOR-VS-SOURCE` (read there, not re-read from
// the raw run files — those live in another session's working tree):
//
//   Q36 (DE) — the answer lists four suppliers (First Principle Impact,
//     NobleJackal, UnFoldMart, IQONEX) and then: «Webappski – listet in einem
//     aktuellen DACH-Ranking mehrere AEO-Agenturen mit SaaS-Fokus». Listed, but
//     as the party that PUBLISHED the ranking about the four.
//   Q8, Q29 (PL) — our article `agencje-aeo-w-polsce-cytowane-przez-ai-2026`
//     stands among the sources beside widoczni.com and goodfirms, as material
//     ABOUT OTHERS; the recommendation is Whites.
//
// All three scored `mention: 'yes'` — formally right, and the opposite of what
// the measurement is for.
//
// WHAT THIS TEST PROVES AND WHAT IT DOES NOT. It drives the real prompt
// builder, the real parser, the real two-model merge and the real field/report
// wiring, with FAKE providers standing in for the network — the same pattern
// test/e2e/run-manual-prose-rank-persist.test.js uses. It therefore proves the
// PLUMBING and the SHAPE: that an agreed verdict is stored, that a
// disagreement degrades to `unknown` instead of a guess, that an unclassified
// run prints no split. It does NOT prove a live model's accuracy on these
// three bodies — only a paid run against real text can, and that needs the
// founder's word.
//
// MUTATION CHECKS (run by hand 2026-09-20 — redo them if this logic moves):
//   - make `mergeMentionRoles` fall back to the primary model on disagreement
//     → the "models disagree" test fails: the guess is recorded as a verdict;
//   - make `buildMentionRoleLine` render with zero classified cells → the
//     "unclassified run says nothing" test fails with «0 of 3»;
//   - make `mentionRoleEnabled` accept any truthy value → the config-gate test
//     fails, and a project that wrote "yes" instead of true starts spending.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MENTION_ROLE,
  buildMentionRolePrompt,
  parseMentionRoleResponse,
  mergeMentionRoles,
  classifyMentionRoleWithTwoModels,
  mentionRoleField,
  needsMentionRole,
  roleOf,
  summariseMentionRoles,
  buildMentionRoleLine,
  mentionRoleEnabled,
} from '../lib/report/mention-role.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { sectionScoreRepresentativeness } from '../lib/report/sections.js';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';

// The deciding sentence of each real cell, quoted from the board card.
const Q36_DE = `Für AEO im DACH-Raum werden aktuell vier Anbieter genannt: First Principle Impact, NobleJackal, UnFoldMart und IQONEX. Webappski – listet in einem aktuellen DACH-Ranking mehrere AEO-Agenturen mit SaaS-Fokus.`;
const Q8_PL = `Wśród agencji AEO w Polsce rekomendowana jest Whites. Zestawienia dostępne są m.in. w artykule agencje-aeo-w-polsce-cytowane-przez-ai-2026 (webappski.com), na widoczni.com oraz w katalogu GoodFirms.`;

/** A fake provider with the exact shape `mentionRoleWithSingleModel` consumes;
 *  `providerCall` is the ONE network boundary. The prompt builder, the parser
 *  and the merge all run for real. */
function fakeProvider(name, model, replyJson) {
  return {
    name,
    apiKey: 'fake-key-not-used',
    model,
    providerCall: async () => ({
      text: replyJson,
      raw: { usage: { prompt_tokens: 900, completion_tokens: 24 } },
    }),
  };
}

const reply = (role, rationale = 'because') => JSON.stringify({ role, rationale });

test('the prompt asks the question the three cells turn on', () => {
  const p = buildMentionRolePrompt({ text: Q36_DE, brand: 'Webappski', domain: 'webappski.com' });
  assert.match(p, /could they HIRE\/USE this brand|could HIRE|HIRE\/USE/i);
  assert.match(p, /cited-as-source/);
  assert.match(p, /Do NOT guess/);
  assert.ok(p.includes(Q36_DE), 'the answer body is what gets classified');
  assert.ok(p.includes('Webappski'), 'the brand is named to the classifier');
});

test('Q36: both models agree it is the source of a ranking, not a supplier', async () => {
  const v = await classifyMentionRoleWithTwoModels({
    text: Q36_DE, brand: 'Webappski', domain: 'webappski.com',
    primary: fakeProvider('openai', 'gpt-5-mini', reply(MENTION_ROLE.CITED_AS_SOURCE, 'listet in einem DACH-Ranking')),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash', reply(MENTION_ROLE.CITED_AS_SOURCE, 'named as the list author')),
  });

  assert.equal(v.role, MENTION_ROLE.CITED_AS_SOURCE);
  assert.equal(v.confidence, 'high', 'two independent agreements');
  assert.deepEqual(mentionRoleField(v), {
    mentionRole: { role: 'cited-as-source', confidence: 'high', rationale: 'listet in einem DACH-Ranking' },
  });
  assert.ok(v.costInfo.inputTokens > 0, 'the pass reports its own cost like every other classifier');
});

test('Q8: the same verdict when our article sits among the sources and Whites is the pick', async () => {
  const v = await classifyMentionRoleWithTwoModels({
    text: Q8_PL, brand: 'Webappski', domain: 'webappski.com',
    primary: fakeProvider('openai', 'gpt-5-mini', reply(MENTION_ROLE.CITED_AS_SOURCE)),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash', reply(MENTION_ROLE.CITED_AS_SOURCE)),
  });
  assert.equal(v.role, MENTION_ROLE.CITED_AS_SOURCE);
  assert.equal(roleOf({ mention: 'yes', ...mentionRoleField(v) }), MENTION_ROLE.CITED_AS_SOURCE);
});

test('models disagree — the verdict is unknown, never the more flattering guess', async () => {
  const v = await classifyMentionRoleWithTwoModels({
    text: Q36_DE, brand: 'Webappski', domain: 'webappski.com',
    primary: fakeProvider('openai', 'gpt-5-mini', reply(MENTION_ROLE.RECOMMENDED)),
    secondary: fakeProvider('gemini', 'gemini-2.5-flash', reply(MENTION_ROLE.CITED_AS_SOURCE)),
  });

  assert.equal(v.role, MENTION_ROLE.UNKNOWN);
  assert.equal(v.confidence, 'low');
  assert.match(v.rationale, /disagreed/);
  assert.deepEqual(v.sources, { primary: 'recommended', secondary: 'cited-as-source' });
  assert.deepEqual(mentionRoleField(v), {}, 'an unknown role is stored as no field at all');
});

test('an unrecognised label is unknown, not the nearest known role', () => {
  assert.equal(parseMentionRoleResponse(reply('vendor')).role, MENTION_ROLE.UNKNOWN);
  assert.equal(parseMentionRoleResponse(reply('author')).role, MENTION_ROLE.UNKNOWN);
  assert.equal(parseMentionRoleResponse('```json\n{"role":"recommended"}\n```').role, MENTION_ROLE.RECOMMENDED);
  assert.throws(() => parseMentionRoleResponse('not json at all'), /no \{\.\.\.\} block/);
});

test('one model down — the survivor is recorded, and labelled as one model', () => {
  const merged = mergeMentionRoles(
    { ok: true, role: MENTION_ROLE.CITED_AS_SOURCE, rationale: 'list author' },
    { ok: false, role: null, error: 'timeout' },
  );
  assert.equal(merged.role, MENTION_ROLE.CITED_AS_SOURCE);
  assert.equal(merged.confidence, 'single-model');
  assert.equal(mergeMentionRoles({ ok: false }, { ok: false }), null, 'both down → no field');
});

test('the pass is asked for only where there is a mention to explain', () => {
  assert.equal(needsMentionRole('yes'), true);
  assert.equal(needsMentionRole('src'), true);
  assert.equal(needsMentionRole('no'), false);
  assert.equal(needsMentionRole('error'), false);
  assert.equal(needsMentionRole('missing'), false);
});

test('the pass costs money, so it is off until a config says otherwise', () => {
  assert.equal(mentionRoleEnabled(undefined), false, 'no config at all → off');
  assert.equal(mentionRoleEnabled({}), false, 'a config that never heard of it → off');
  assert.equal(mentionRoleEnabled({ classifyMentionRole: false }), false);
  assert.equal(mentionRoleEnabled({ classifyMentionRole: true }), true);
  // Truthy is not the same as on: a value nobody recognises must not start
  // spending on the operator's behalf.
  assert.equal(mentionRoleEnabled({ classifyMentionRole: 'yes' }), false);
  assert.equal(mentionRoleEnabled({ classifyMentionRole: 1 }), false);

  // And the shipped default is off, so `init` never seeds a spending project.
  assert.equal(DEFAULT_CONFIG.classifyMentionRole, false);
  assert.equal(mentionRoleEnabled(DEFAULT_CONFIG), false);
});

// ─── The number the report publishes ────────────────────────────────────────

const withRole = (query, role) => ({
  query, queryText: `question ${query}`, provider: 'openai', mention: 'yes',
  position: null, canonicalCitations: [],
  ...(role ? { mentionRole: { role, confidence: 'high', rationale: 'x' } } : {}),
});

test('the run of 2026-09-16 splits: three named cells, one a supplier, two the source', () => {
  const results = [
    withRole('Q1', MENTION_ROLE.RECOMMENDED),
    withRole('Q8', MENTION_ROLE.CITED_AS_SOURCE),
    withRole('Q36', MENTION_ROLE.CITED_AS_SOURCE),
    { query: 'Q2', provider: 'openai', mention: 'no', canonicalCitations: [] },
  ];

  const s = summariseMentionRoles(results);
  assert.equal(s.mentions, 3, 'the misses are not in this split');
  assert.equal(s.recommended, 1);
  assert.equal(s.citedAsSource, 2);
  assert.equal(s.unknown, 0);

  assert.equal(s.singleModel, 0, 'all three rest on two agreeing models');

  const line = buildMentionRoleLine(results);
  assert.match(line, /Named is not recommended/);
  assert.match(line, /\*\*1 of 3\*\* named you as a supplier/);
  assert.match(line, /2 cited you as the SOURCE/);
  assert.match(line, /pointing the buyer elsewhere/);
  assert.match(line, /two independent models agreed on/, 'the line states what the split rests on');
  assert.match(line, /left unclassified rather than guessed/);
});

test('a verdict from one surviving model is counted, and the line says so', () => {
  const results = [
    withRole('Q1', MENTION_ROLE.RECOMMENDED),
    { ...withRole('Q8', MENTION_ROLE.CITED_AS_SOURCE),
      mentionRole: { role: MENTION_ROLE.CITED_AS_SOURCE, confidence: 'single-model', rationale: 'x' } },
    withRole('Q36', MENTION_ROLE.CITED_AS_SOURCE),
  ];
  const s = summariseMentionRoles(results);
  assert.equal(s.classified, 3);
  assert.equal(s.citedAsSource, 2, 'a single-model verdict still places the cell');
  assert.equal(s.singleModel, 1);

  const line = buildMentionRoleLine(results);
  assert.match(line, /except 1 where one model failed and the other's reading stands alone/,
    'a weaker verdict must not be published as if two models had agreed');
});

test('an unclassified run says nothing rather than «0 recommended»', () => {
  const results = [withRole('Q1', null), withRole('Q8', null), withRole('Q36', null)];
  const s = summariseMentionRoles(results);
  assert.equal(s.mentions, 3);
  assert.equal(s.classified, 0);
  assert.equal(s.unknown, 3);
  assert.equal(buildMentionRoleLine(results), null,
    'a run that never classified roles must not read as a run where nobody recommended us');

  const md = sectionScoreRepresentativeness([{ date: '2026-09-16', domain: 'webappski.com', results }]);
  assert.doesNotMatch(md, /Named is not recommended/);
  assert.doesNotMatch(md, /0 of 3/);
});

test('a partly-classified run says how many it could not classify', () => {
  const results = [
    withRole('Q1', MENTION_ROLE.RECOMMENDED),
    withRole('Q8', MENTION_ROLE.CITED_AS_SOURCE),
    withRole('Q36', null),
  ];
  const line = buildMentionRoleLine(results);
  assert.match(line, /1 could not be classified and are counted in none of the above/);

  const md = sectionScoreRepresentativeness([{ date: '2026-09-16', domain: 'webappski.com', results }]);
  assert.match(md, /Named is not recommended/, 'the split reaches the report surface');
});

test('the portal payload carries the role, and omits it when unclassified', () => {
  const classified = buildMcMetadata({
    date: '2026-09-16', brand: 'Webappski', domain: 'webappski.com',
    results: [withRole('Q36', MENTION_ROLE.CITED_AS_SOURCE)],
  });
  assert.deepEqual(classified.perCell[0].mentionRole, { role: 'cited-as-source', confidence: 'high' });
  assert.equal(classified.perCell[0].mention, 'yes', 'the mention axis itself is untouched');

  const unclassified = buildMcMetadata({
    date: '2026-09-16', brand: 'Webappski', domain: 'webappski.com',
    results: [withRole('Q36', null)],
  });
  assert.equal('mentionRole' in unclassified.perCell[0], false);
});
