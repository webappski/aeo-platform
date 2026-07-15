// Tests for the MC metadata `scores()` and `perEngine()` blocks. These ship
// in the JSON brand-context the operator pastes into Mission Control and were
// drifting from `lib/report/visibility-index.js` on four axes:
//
//   - presence    counted `src` at 0.5  vs canonical 1.0
//   - rank        decay × 10            vs canonical × 15
//   - sentiment   averaged all labels   vs canonical excludes low-conf neutrals
//   - citation    `hasBrandInCitations` vs canonical canonical-citation substring
//
// `scores()` now delegates to `computeComponents` so the JSON block is byte-
// aligned with the markdown UVI table. These tests pin that contract.

import assert from 'node:assert/strict';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';
import { computeComponents, computeUVI } from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nmc-metadata.scores — byte-aligned with visibility-index');

test('scores agrees with computeComponents for a typical run', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 42,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
      { provider: 'openai', query: 'q2', mention: 'src', position: null,
        sentiment: { label: 'neutral', confidence: 'high' },
        canonicalCitations: ['https://x.com/b'] },
      { provider: 'openai', query: 'q3', mention: 'no', position: null,
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const canonical = computeComponents(summary);
  assert.equal(md.scores.presence,  canonical.presence,  'presence drift');
  assert.equal(md.scores.sentiment, canonical.sentiment, 'sentiment drift');
  assert.equal(md.scores.rank,      canonical.rank,      'rank drift');
  assert.equal(md.scores.citation,  canonical.citation,  'citation drift');
});

test('scores excludes low-confidence neutral tie-breaks (Bug 3 propagates)', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q2', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q3', mention: 'yes', position: 1,
        sentiment: { label: 'neutral', confidence: 'low' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q4', mention: 'yes', position: 1,
        sentiment: { label: 'neutral', confidence: 'low' },
        canonicalCitations: [] },
      { provider: 'openai', query: 'q5', mention: 'yes', position: 1,
        sentiment: { label: 'neutral', confidence: 'low' },
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.scores.sentiment, 100,
    'low-confidence neutral tie-breaks must NOT drag a 100/100 sentiment down to 70');
  assert.equal(md.scores.sentimentSample, 2, 'effective sample = 2 high-confidence cells');
});

test('scores returns rank null (not 50) when no cell has position data', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: null,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.scores.rank, null);
  assert.equal(md.scores.rankSample, 0);
});

test('scores returns null components when run has zero cells', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.scores.presence,  0);
  assert.equal(md.scores.sentiment, null);
  assert.equal(md.scores.rank,      null);
  // Citation MUST be 0 (not null) — share-of-cells with 0 cells is 0 by
  // construction, same as `computeComponents`. Earlier ad-hoc impl returned
  // null only here and 0 elsewhere; the JSON consumer cannot distinguish
  // those without a contract this test pins.
  assert.equal(md.scores.citation, 0);
});

test('perEngine block agrees with computeComponents per provider', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 50,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/p'] },
      { provider: 'gemini', query: 'q1', mention: 'no', position: null,
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const oai = md.perEngine.find(p => p.provider === 'openai');
  const gem = md.perEngine.find(p => p.provider === 'gemini');

  const oaiSub = computeComponents({ domain: 'x.com', results: summary.results.filter(r => r.provider === 'openai') });
  const gemSub = computeComponents({ domain: 'x.com', results: summary.results.filter(r => r.provider === 'gemini') });

  assert.equal(oai.presence,  oaiSub.presence);
  assert.equal(oai.sentiment, oaiSub.sentiment);
  assert.equal(oai.rank,      oaiSub.rank);
  assert.equal(oai.citation,  oaiSub.citation);
  assert.equal(gem.presence,  gemSub.presence);
  assert.equal(gem.sentiment, gemSub.sentiment); // null — no sentiment data
  assert.equal(gem.rank,      gemSub.rank);      // null — no position data
});

test('scores.uvi is computeUVI output even when summary.score is missing', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com',
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const expected = computeUVI(computeComponents(summary));
  assert.equal(md.scores.uvi, expected);
});

test('scores.uvi is the composite UVI, NOT the headline mention-rate score (92-vs-100 bug, 2026-07-13)', () => {
  // Regression: `scores.uvi` used `numOr(summary.score, computeUVI(...))` —
  // and `summary.score` (the headline mention-rate, mentions/total × 100) is
  // ALWAYS a finite number on real runs, so the computed UVI was dead code.
  // Real case: typelessform 2026-07-11 — 9/9 mentions → headline 100, but
  // the report's own UVI block showed 92 (sentiment 89 / rank 74 drag the
  // composite). The payload must carry the SAME UVI the report renders.
  //
  // Fixture: every cell mentioned (headline = 100) with mixed sentiment,
  // imperfect rank and a citation miss so the composite lands below 100.
  const summary = {
    date: '2026-07-11', brand: 'X', domain: 'x.com', score: 100,
    mentions: 3, total: 3,
    results: [
      { provider: 'openai', query: 'q1', mention: 'yes', position: 1,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: ['https://x.com/a'] },
      { provider: 'gemini', query: 'q1', mention: 'yes', position: 3,
        sentiment: { label: 'neutral', confidence: 'high' },
        canonicalCitations: ['https://x.com/b'] },
      { provider: 'anthropic', query: 'q1', mention: 'src', position: null,
        sentiment: { label: 'positive', confidence: 'high' },
        canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  const expected = computeUVI(computeComponents(summary));

  // Guard the fixture itself: the test is only meaningful when the composite
  // actually differs from the headline (presence 100, sentiment 83, rank 85,
  // citation 67 → UVI 86 ≠ 100).
  assert.notEqual(expected, summary.score,
    'fixture invalid — UVI must differ from the headline score for this regression to bite');

  assert.equal(md.scores.uvi, expected,
    `scores.uvi must be the computed UVI (${expected}), not summary.score (${summary.score})`);
  assert.equal(md.aggregates.score, summary.score,
    'the headline mention-rate still belongs in aggregates.score');
});

// ─── Portal report mirror: un-denied client-own data + leak guard + bug fixes ───
console.log('\nmc-metadata — portal report mirror (2026-07-06)');

test("perCell carries the client's own data (queryText / responseExcerpt / canonicalCitations)", () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [
      { provider: 'openai', query: 'q1', queryText: 'best crm for X', mention: 'no', position: null,
        citationCount: 3, canonicalCitations: ['https://a.com', 'https://b.com'],
        responseExcerpt: 'Here is what the engine said…',
        costUsd: 0.04, inputTokens: 900, outputTokens: 700, elapsedMs: 1234,
        extractionSources: ['gpt-5-mini'] },
    ],
  };
  const cell = buildMcMetadata(summary, [summary]).perCell[0];
  assert.equal(cell.queryText, 'best crm for X');
  assert.equal(cell.responseExcerpt, 'Here is what the engine said…');
  assert.deepEqual(cell.canonicalCitations, ['https://a.com', 'https://b.com']);
});

test('LEAK GUARD — cost/token/paths/outreach never reach the payload', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    sessionCostUsd: 4.21, costByModel: [{ model: 'gpt', costUsd: 4.21 }],
    outreachTemplates: [{ to: 'sam@x.com', body: 'PII pitch body' }],
    results: [
      { provider: 'openai', query: 'q1', queryText: 'q', mention: 'no', canonicalCitations: [],
        responseExcerpt: 'x', costUsd: 0.04, inputTokens: 900, outputTokens: 700,
        elapsedMs: 1234, extractionSources: ['gpt-5-mini'] },
    ],
  };
  const s = JSON.stringify(buildMcMetadata(summary, [summary]));
  for (const k of ['costUsd', 'sessionCostUsd', 'inputTokens', 'outputTokens', 'elapsedMs', 'extractionSources', 'outreachTemplates', 'costByModel']) {
    assert.equal(s.includes('"' + k + '"'), false, `deny-list key ${k} leaked`);
  }
  assert.equal(s.includes('4.21'), false, 'raw cost value leaked');
  assert.equal(s.includes('PII pitch body'), false, 'outreach PII leaked');
});

test('recommendations + ads emitted; the two emit-empty bugs (topCitationDomains, crawl.bots) fixed', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0,
    results: [{ provider: 'openai', query: 'q1', mention: 'no', canonicalCitations: [] }],
    llmActions: [{ kind: 'gap', priority: 'high', engines: ['openai'], title: 'Do X', detail: 'because Y' }],
    adsDetected: { totalCellsScanned: 3, totalCellsWithAdSignal: 1, byProvider: { gemini: 1 } },
    topDomains: [{ host: 'commonsku.com', count: 17, share: 0.05 }],
    citationClassification: { results: [{ hostname: 'commonsku.com', industry: 'Promo SaaS', onCategory: true }] },
    crawlability: {
      summary: { hasRobots: true, hasSitemap: true, totalBots: 2, allowedCount: 1, blockedCount: 1 },
      sitemap: { urlCount: 5 },
      botAccess: [{ name: 'GPTBot', label: 'GPTBot', access: 'allowed' }, { name: 'ClaudeBot', label: 'ClaudeBot', access: 'blocked' }],
    },
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.recommendations.length, 1);
  assert.equal(md.recommendations[0].title, 'Do X');
  assert.equal(md.ads.cellsWithAd, 1);
  assert.equal(md.topCitationDomains.length, 1, 'topCitationDomains sourced from topDomains');
  assert.equal(md.topCitationDomains[0].host, 'commonsku.com');
  assert.equal(md.topCitationDomains[0].share, 0.05);
  assert.equal(md.topCitationDomains[0].onCategory, true);
  assert.equal(md.crawl.bots.length, 2, 'crawl.bots sourced from botAccess');
  assert.deepEqual(md.crawl.bots.map(b => b.status), ['allowed', 'blocked']);
});

test('aggregates carry the matrix summary stats (errors / competitorMentions / citationPool)', () => {
  const summary = {
    date: '2026-05-13', brand: 'X', domain: 'x.com', score: 0, errors: 2,
    topCompetitors: [{ name: 'A', count: 5, verified: true }],
    unverifiedOnly: [{ name: 'B', count: 3 }],
    results: [
      { provider: 'openai', query: 'q1', mention: 'no', citationCount: 8, canonicalCitations: [] },
      { provider: 'gemini', query: 'q1', mention: 'no', citationCount: 4, canonicalCitations: [] },
    ],
  };
  const md = buildMcMetadata(summary, [summary]);
  assert.equal(md.aggregates.errors, 2);
  assert.equal(md.aggregates.competitorMentions, 8); // 5 verified + 3 unverified
  assert.equal(md.aggregates.citationPool, 12); // 8 + 4
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
