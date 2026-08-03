import assert from 'node:assert/strict';
import { computeComponents, computeUVI, computeUVIBreakdown, computeDiscoverability, perCellPresence, usableProseRank } from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ncomputeComponents');

test('all-mentions-positive perfect run', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive' }, canonicalCitations: ['https://acme.com/x'] },
      { mention: 'yes', position: 1, sentiment: { label: 'positive' }, canonicalCitations: ['https://acme.com/y'] },
    ],
  });
  assert.equal(c.presence, 100);
  assert.equal(c.sentiment, 100);
  assert.equal(c.rank, 100);
  assert.equal(c.citation, 100);
});

test('zero mentions yields no-signal: presence/citation 0, sentiment/rank null', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'no', position: null, canonicalCitations: [] },
      { mention: 'no', position: null, canonicalCitations: [] },
    ],
  });
  assert.equal(c.presence, 0);
  // sentiment/rank are null (signal absent) — not 50, not 0. A 0 reading
  // would let them be averaged into the UVI weighted sum at full weight,
  // which is what produced phantom-neutral inflation in earlier versions.
  assert.equal(c.sentiment, null);
  assert.equal(c.rank, null);
  assert.equal(c.citation, 0);
});

test('error cells excluded from sample', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, canonicalCitations: [] },
      { mention: 'error' },
    ],
  });
  assert.equal(c.sample, 1);
  assert.equal(c.presence, 100);
});

test('rank degrades with position', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [{ mention: 'yes', position: 5, canonicalCitations: [] }],
  });
  // 100 - (5-1)*15 = 40
  assert.equal(c.rank, 40);
});

test('empty results → presence 0, sentiment/rank null (no signal)', () => {
  const c = computeComponents({ results: [] });
  assert.equal(c.presence, 0);
  assert.equal(c.sentiment, null); // null = absent signal; not 0, not phantom-neutral 50
  assert.equal(c.rank, null);
  assert.equal(computeUVI(c), 0); // weightSum collapses to 0 when all components null/0
});

// ─── BUG 2 — rank null when never measured ───

test('rank: all-null position cells → rank null (excluded from UVI)', () => {
  const c = computeComponents({
    domain: 'acme.com',
    results: [
      { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://acme.com/x'] },
      { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://acme.com/y'] },
    ],
  });
  // No cell has a numeric position → rank null, NOT a 50 fallback.
  assert.equal(c.rank, null);
  assert.equal(c.rankSample, 0);
  // UVI re-normalises remaining weights. presence + sentiment + citation
  // (0.35 + 0.25 + 0.20 = 0.80) → re-weighted to 1.0 →
  // (100*0.35 + 100*0.25 + 100*0.20) / 0.80 = 100.
  assert.equal(computeUVI(c), 100);
});

test('rank: mixed null/numeric positions use only numeric cells', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1,    canonicalCitations: [] },
      { mention: 'yes', position: null, canonicalCitations: [] },
      { mention: 'yes', position: 3,    canonicalCitations: [] },
    ],
  });
  // (100 + 70) / 2 = 85
  assert.equal(c.rank, 85);
  assert.equal(c.rankSample, 2);
});

// ─── BUG 3 — sentiment: low-confidence neutrals excluded ───

test('sentiment: low-confidence neutral tie-breaks excluded from composite', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: [] },
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: [] },
      { mention: 'yes', position: 2, sentiment: { label: 'neutral',  confidence: 'low'  }, canonicalCitations: [] },
      { mention: 'yes', position: 2, sentiment: { label: 'neutral',  confidence: 'low'  }, canonicalCitations: [] },
      { mention: 'yes', position: 2, sentiment: { label: 'neutral',  confidence: 'low'  }, canonicalCitations: [] },
    ],
  });
  // Only the 2 high-confidence positives count → 100/100, n=2. Without the
  // exclusion the 3 fake neutrals would drag this to (200+150)/5 = 70.
  assert.equal(c.sentiment, 100);
  assert.equal(c.sentimentSample, 2);
});

test('sentiment: all low-conf-neutral → sentiment null, UVI re-weights', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'neutral', confidence: 'low' }, canonicalCitations: [] },
      { mention: 'yes', position: 1, sentiment: { label: 'neutral', confidence: 'low' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.sentiment, null);
  assert.equal(c.sentimentSample, 0);
  // presence=100, rank=100, citation=0 — sentiment excluded.
  // (100*0.35 + 100*0.20 + 0*0.20) / 0.75 = 73.33 → 73.
  assert.equal(computeUVI(c), 73);
});

test('sentiment: failed/empty confidence treated as no-signal', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'neutral',  confidence: 'failed' }, canonicalCitations: [] },
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high'   }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.sentiment, 100);
  assert.equal(c.sentimentSample, 1);
});

test('sentiment: low-confidence positive (not neutral) kept as signal', () => {
  // Low-confidence + non-neutral label means one model said positive and the
  // other failed — single-model fallback, NOT a tie-break. Still real signal.
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'single-model' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.sentiment, 100);
  assert.equal(c.sentimentSample, 1);
});

// ─── citation axis: registrable-domain match, NOT raw substring (AP-CITATION-ETLD1) ───
// Regression guard for review #8: the citation axis used `url.includes(domain)`,
// which let look-alike hosts (`gcore.com.evil.com`, `notgcore.com.evil.com`,
// `xgcore.com`) count as brand citations and inflate the citation component.

test('citation: subdomain of brand domain counts (blog.gcore.com)', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://blog.gcore.com/post'] }],
  });
  assert.equal(c.citation, 100);
});

test('citation: bare brand domain counts (gcore.com)', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://gcore.com/'] }],
  });
  assert.equal(c.citation, 100);
});

test('citation: brand domain with utm query counts (gcore.com/x?utm)', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://gcore.com/x?utm_source=chatgpt'] }],
  });
  assert.equal(c.citation, 100);
});

test('citation: suffix-spoof does NOT count (gcore.com.evil.com)', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://gcore.com.evil.com/x'] }],
  });
  // Under the old substring match this was 100 — a false brand citation.
  assert.equal(c.citation, 0);
});

test('citation: prefix-then-suffix spoof does NOT count (notgcore.com.evil.com)', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://notgcore.com.evil.com/x'] }],
  });
  assert.equal(c.citation, 0);
});

test('citation: prefix look-alike host does NOT count (xgcore.com)', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://xgcore.com/x'] }],
  });
  assert.equal(c.citation, 0);
});

test('citation: real + spoof in one cell → cell counts once via the real one', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [{ mention: 'no', position: null, canonicalCitations: ['https://gcore.com.evil.com/x', 'https://gcore.com/real'] }],
  });
  assert.equal(c.citation, 100);
});

test('citation: spoof-only across two cells → citation axis 0, not 100', () => {
  const c = computeComponents({
    domain: 'gcore.com',
    results: [
      { mention: 'no', position: null, canonicalCitations: ['https://gcore.com.evil.com/a'] },
      { mention: 'no', position: null, canonicalCitations: ['https://xgcore.com/b'] },
    ],
  });
  assert.equal(c.citation, 0);
});

console.log('\ncomputeUVI');

test('weighted sum of components', () => {
  const c = { presence: 100, sentiment: 100, rank: 100, citation: 100, sample: 5 };
  assert.equal(computeUVI(c), 100);
});

test('zero-everything → 0', () => {
  const c = { presence: 0, sentiment: 0, rank: 0, citation: 0, sample: 5 };
  assert.equal(computeUVI(c), 0);
});

test('mixed components → weighted result', () => {
  const c = { presence: 80, sentiment: 60, rank: 40, citation: 20, sample: 5 };
  // 80*0.35 + 60*0.25 + 40*0.20 + 20*0.20 = 28 + 15 + 8 + 4 = 55
  assert.equal(computeUVI(c), 55);
});

test('custom weights respected', () => {
  const c = { presence: 100, sentiment: 0, rank: 0, citation: 0, sample: 5 };
  assert.equal(computeUVI(c, { presence: 1, sentiment: 0, rank: 0, citation: 0 }), 100);
});

console.log('\ncomputeUVIBreakdown');

test('breakdown: typelessform real-run example (presence 42, sentiment 100/n=2, rank null, citation 42) → UVI 60 with correct per-axis trace', () => {
  // This mirrors the exact run the user pasted in feedback: 5/12 mentions,
  // 2 high-confidence positives, no measurable rank, 5/12 citations.
  const components = {
    presence: 42, sentiment: 100, rank: null, citation: 42,
    sample: 12, sentimentSample: 2, rankSample: 0,
  };
  const b = computeUVIBreakdown(components);

  assert.equal(b.uvi, 60, 'composite UVI matches computeUVI()');
  assert.equal(b.uvi, computeUVI(components), 'breakdown UVI agrees with computeUVI()');
  assert.deepEqual(b.excluded, ['rank'], 'rank flagged as excluded');

  // weightSum = 0.35 + 0.25 + 0.20 = 0.80 (rank's 0.20 dropped).
  assert.ok(Math.abs(b.weightSum - 0.80) < 1e-9, `weightSum=${b.weightSum}`);
  // rawSum = 42*0.35 + 100*0.25 + 42*0.20 = 14.7 + 25 + 8.4 = 48.1.
  assert.ok(Math.abs(b.rawSum - 48.1) < 1e-9, `rawSum=${b.rawSum}`);
  // 48.1 / 0.80 = 60.125 → 60.

  const byKey = Object.fromEntries(b.rows.map(r => [r.key, r]));

  // Presence: weight 0.35 → applied 0.35/0.80 = 0.4375; contribution 42*0.4375 = 18.375
  assert.equal(byKey.presence.value, 42);
  assert.ok(Math.abs(byKey.presence.appliedWeight - 0.4375) < 1e-9);
  assert.ok(Math.abs(byKey.presence.contribution - 18.375) < 1e-9);
  assert.equal(byKey.presence.sample.n, 12);
  assert.equal(byKey.presence.sample.denominator, 12);
  assert.equal(byKey.presence.meaning, 'share of cells where brand was mentioned');

  // Sentiment: sample is n=2 high-confidence cells out of 12 — DIFFERENT
  // denominator from presence. Applied weight 0.25/0.80 = 0.3125.
  assert.equal(byKey.sentiment.value, 100);
  assert.equal(byKey.sentiment.sample.n, 2, 'sentiment n must reflect high-confidence cells, not total cells');
  assert.equal(byKey.sentiment.sample.denominator, 12);
  assert.ok(byKey.sentiment.sample.basis.includes('high-confidence'));
  assert.ok(Math.abs(byKey.sentiment.appliedWeight - 0.3125) < 1e-9);
  assert.ok(Math.abs(byKey.sentiment.contribution - 31.25) < 1e-9);

  // Rank: excluded — null value, null applied weight, null contribution.
  // The user-visible meaning string still renders (the popover row still
  // shows what the axis means, with «not measured this run»).
  assert.equal(byKey.rank.value, null);
  assert.equal(byKey.rank.appliedWeight, null);
  assert.equal(byKey.rank.contribution, null);
  assert.equal(byKey.rank.weight, 0.20, 'original weight is preserved for the popover «redistributed» note');
  assert.equal(byKey.rank.sample.n, 0);

  // Citation: applied 0.20/0.80 = 0.25; contribution 42*0.25 = 10.5
  assert.equal(byKey.citation.value, 42);
  assert.ok(Math.abs(byKey.citation.appliedWeight - 0.25) < 1e-9);
  assert.ok(Math.abs(byKey.citation.contribution - 10.5) < 1e-9);

  // Sanity — contributions sum to the rawSum / weightSum value (= UVI before rounding).
  const sumContribs = b.rows
    .filter(r => r.contribution !== null)
    .reduce((s, r) => s + r.contribution, 0);
  assert.ok(Math.abs(sumContribs - 60.125) < 1e-9, `sum of contributions = ${sumContribs}`);
});

test('breakdown: all components measured → no re-normalisation, applied = default weight', () => {
  const components = {
    presence: 80, sentiment: 60, rank: 40, citation: 20,
    sample: 10, sentimentSample: 10, rankSample: 10,
  };
  const b = computeUVIBreakdown(components);
  assert.deepEqual(b.excluded, []);
  // Full coverage → weightSum = 1.0 → applied weight = original weight.
  assert.ok(Math.abs(b.weightSum - 1.0) < 1e-9);
  for (const r of b.rows) {
    assert.ok(Math.abs(r.appliedWeight - r.weight) < 1e-9, `${r.key}: applied=${r.appliedWeight} vs weight=${r.weight}`);
  }
  assert.equal(b.uvi, computeUVI(components));
});

test('breakdown: all-null → uvi 0, empty rows excluded, no division-by-zero', () => {
  const components = { presence: 0, sentiment: null, rank: null, citation: 0, sample: 0, sentimentSample: 0, rankSample: 0 };
  // presence=0 / citation=0 ARE measured (zero is a real reading), only
  // sentiment/rank are excluded. weightSum = 0.55.
  const b = computeUVIBreakdown(components);
  assert.deepEqual(b.excluded, ['sentiment', 'rank']);
  assert.ok(Math.abs(b.weightSum - 0.55) < 1e-9);
  assert.equal(b.rawSum, 0);
  assert.equal(b.uvi, 0);
});

test('breakdown: zero-weight edge — every component null → weightSum 0, uvi 0, no NaN', () => {
  const components = { presence: null, sentiment: null, rank: null, citation: null, sample: 0, sentimentSample: 0, rankSample: 0 };
  const b = computeUVIBreakdown(components);
  assert.equal(b.weightSum, 0);
  assert.equal(b.rawSum, 0);
  assert.equal(b.uvi, 0);
  for (const r of b.rows) {
    assert.equal(r.appliedWeight, null);
    assert.equal(r.contribution, null);
  }
});

test('breakdown: per-axis meanings exposed for popover (verbatim strings)', () => {
  const components = { presence: 50, sentiment: 50, rank: 50, citation: 50, sample: 4, sentimentSample: 4, rankSample: 4 };
  const b = computeUVIBreakdown(components);
  const m = Object.fromEntries(b.rows.map(r => [r.key, r.meaning]));
  // These exact strings must match the existing UVI summary table — the
  // popover is a richer view of the same row, not a parallel copy.
  assert.equal(m.presence,  'share of cells where brand was mentioned');
  assert.equal(m.sentiment, 'avg tone (50 = neutral)');
  assert.equal(m.rank,      'avg position strength when listed');
  assert.equal(m.citation,  'share of cells with brand domain in citations');
});

// ─── Integration — sectionUnifiedVisibilityIndex renders popover ───

console.log('\nsectionUnifiedVisibilityIndex — popover');

const { sectionUnifiedVisibilityIndex } = await import('../lib/report/sections.js');

test('popover: rendered for the typelessform run with re-normalisation banner', () => {
  // Synthesise 12 cells matching the user's real example:
  //   - 5 cells with mention=yes, no position, high-confidence positive (2 of them) + 3 single-model
  //   - 5 cells with brand domain in citations (mixed with above; we cite from the 5 mentioned)
  //   - 7 cells without mention or citation
  // → presence 42, citation 42, sentiment 100 (n=2 high-confidence), rank null
  const yesCells = [
    { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://typelessform.com/a'] },
    { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://typelessform.com/b'] },
    { mention: 'yes', position: null, sentiment: { label: 'positive', confidence: 'single-model-disabled' }, canonicalCitations: ['https://typelessform.com/c'] },
    { mention: 'yes', position: null, sentiment: { label: 'neutral', confidence: 'low' }, canonicalCitations: ['https://typelessform.com/d'] },
    { mention: 'yes', position: null, sentiment: { label: 'neutral', confidence: 'low' }, canonicalCitations: ['https://typelessform.com/e'] },
  ];
  const noCells = Array.from({ length: 7 }, () => ({ mention: 'no', position: null, canonicalCitations: [] }));
  const latest = { domain: 'typelessform.com', results: [...yesCells, ...noCells] };

  // Sanity-check the math before asserting the rendered output.
  const c = computeComponents(latest);
  assert.equal(c.presence, 42, `presence=${c.presence}`);
  assert.equal(c.citation, 42, `citation=${c.citation}`);
  assert.equal(c.rank, null);
  assert.equal(c.sample, 12);
  // 2 high-conf positives + 1 single-model positive count as signal-bearing
  // (only low-conf neutral tie-breaks are filtered). 3 cells averaged = 100.
  assert.equal(c.sentiment, 100, `sentiment=${c.sentiment}`);
  assert.equal(c.sentimentSample, 3, `sentimentSample=${c.sentimentSample}`);

  const md = sectionUnifiedVisibilityIndex([latest]);

  // Popover element present, keyboard-accessible (native <details>/<summary>).
  assert.ok(md.includes('<details class="uvi-breakdown">'), 'popover <details> rendered');
  assert.ok(md.includes('<summary>'), 'summary present (keyboard-toggleable)');
  assert.ok(md.includes('How is this calculated?'), 'help-icon label rendered');
  assert.ok(md.includes('&#9432;') || md.includes('ⓘ'), 'info icon rendered');

  // Re-normalisation banner — the headline UX fix.
  assert.ok(md.includes('Rank'), 'rank named in popover');
  assert.ok(md.includes('not measured this run'), 'not-measured-this-run wording present');
  assert.ok(md.includes('redistributed'), 'redistribution wording present');
  // The applied weights for the surviving axes must show the new percentages.
  assert.ok(md.includes('43.75%'), 'presence applied weight rendered (0.35/0.80)');
  assert.ok(md.includes('31.25%'), 'sentiment applied weight rendered (0.25/0.80)');
  assert.ok(md.includes('25%'), 'citation applied weight rendered (0.20/0.80)');

  // Sample sizes — presence/citation denominated over total cells, sentiment
  // over high-confidence cells only. They MUST stay distinct.
  assert.ok(/12\/12 cells/.test(md), 'presence sample as N/total cells');
  assert.ok(/high-confidence cell/.test(md), 'sentiment sample labelled high-confidence');

  // Per-axis meanings replayed inside the popover (so reader sees a richer
  // version of the summary table, not a parallel copy).
  assert.ok(md.includes('share of cells where brand was mentioned'));
  assert.ok(md.includes('avg tone (50 = neutral)'));
  assert.ok(md.includes('share of cells with brand domain in citations'));
});

test('popover: no re-normalisation banner when all components measured', () => {
  const latest = {
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://a.com/x'] },
      { mention: 'yes', position: 2, sentiment: { label: 'positive', confidence: 'high' }, canonicalCitations: ['https://a.com/y'] },
    ],
  };
  const md = sectionUnifiedVisibilityIndex([latest]);
  assert.ok(md.includes('<details class="uvi-breakdown">'));
  // Banner only appears when something is excluded.
  assert.ok(!md.includes('not measured this run'), 'no redistribution banner when full coverage');
});

console.log('\ncomputeDiscoverability');

// A page-signals object that PASSES the server-rendered axis, and one that
// fails it. `checkPageSignals` nests under `.homepage`; both shapes are
// accepted by serverRenderedAxis, and the nested one is what snapshots carry.
const ssrPass = { homepage: { ok: true, bytes: 42000, headings: { h1: { count: 1 }, h2: { count: 6 } }, schemaOrg: { blockCount: 2 }, answerCapsules: { withCapsule: 3 } } };
const ssrShell = { homepage: { ok: true, bytes: 900, headings: { h1: { count: 0 }, h2: { count: 0 } }, schemaOrg: { blockCount: 0 }, answerCapsules: { withCapsule: 0 } } };
const ssrBlocked = { homepage: { ok: false, status: 403, error: 'HTTP 403' } };

test('full readiness → 100 (robots + bots + sitemap + server-rendered)', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: true, hasLlmsTxt: false, hasSitemap: true },
    sitemap: { urlCount: 40 },
  }, ssrPass);
  assert.equal(r.score, 100);
});

test('robots missing → drops by 30 points', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: false, hasLlmsTxt: true, hasSitemap: true },
    sitemap: { urlCount: 40 },
  }, ssrPass);
  // 0*0.30 + 100*0.25 + 100*0.25 + 100*0.20 = 70
  assert.equal(r.score, 70);
});

test('all bots blocked → bot share component is 0', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 12, allowedCount: 0, hasRobots: true, hasLlmsTxt: true, hasSitemap: true },
    sitemap: { urlCount: 40 },
  }, ssrPass);
  // 100*0.30 + 0*0.25 + 100*0.25 + 100*0.20 = 75
  assert.equal(r.score, 75);
});

test('null crawlability → null result', () => {
  assert.equal(computeDiscoverability(null), null);
  assert.equal(computeDiscoverability({}), null);
});

// ─── AP-DEAD-TACTIC-LLMSTXT ───
//
// llms.txt no longer appears in the score at all, and the axis that took its
// 20% is "content served in HTML". These tests pin BOTH halves: that the file's
// presence is inert, and that the replacement behaves.
//
// MUTATION-SANITY: put `llmsTxtScore * 0.20` back into computeDiscoverability
// (or give hasLlmsTxt any weight) → the inertness test below goes RED.

test('llms.txt has NO axis and NO effect on the score', () => {
  const base = { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: true, hasSitemap: true };
  const withFile = computeDiscoverability({ summary: { ...base, hasLlmsTxt: true }, sitemap: { urlCount: 9 } }, ssrPass);
  const without  = computeDiscoverability({ summary: { ...base, hasLlmsTxt: false }, sitemap: { urlCount: 9 } }, ssrPass);
  assert.equal(withFile.score, without.score, 'llms.txt presence must not move the score');
  assert.equal(withFile.breakdown.llmsTxt, undefined, 'no llmsTxt row may exist in the breakdown');
  assert.equal(
    JSON.stringify(withFile.breakdown).toLowerCase().includes('llms'), false,
    'the breakdown must not mention llms.txt at all',
  );
});

test('server-rendered axis: pass / JS-shell / unmeasured', () => {
  const summary = { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: true, hasLlmsTxt: false, hasSitemap: true };
  const crawl = { summary, sitemap: { urlCount: 9 } };

  assert.equal(computeDiscoverability(crawl, ssrPass).score, 100);
  // Shell → loses the whole 20-point axis, keeps the rest.
  assert.equal(computeDiscoverability(crawl, ssrShell).score, 80);
  // A blocked page fetch is NOT evidence of a shell: axis null, weights
  // re-normalise over the measured 80% → 80/0.80 = 100.
  const blocked = computeDiscoverability(crawl, ssrBlocked);
  assert.equal(blocked.breakdown.serverRendered.value, null);
  assert.equal(blocked.score, 100);
  // Same for a caller that passes no page signals at all (legacy snapshots).
  assert.equal(computeDiscoverability(crawl).breakdown.serverRendered.value, null);
  assert.equal(computeDiscoverability(crawl).score, 100);
  // A body that blew past the 2MB read cap and showed no headings in the part
  // we DID read is unmeasured, not a shell — we only saw a slice of it.
  const truncatedShell = { homepage: { ...ssrShell.homepage, bytes: 3_000_000, truncated: true } };
  assert.equal(computeDiscoverability(crawl, truncatedShell).breakdown.serverRendered.value, null);
});

test('unmeasured axis re-normalises rather than scoring 0', () => {
  // robots present, all bots blocked, no sitemap, no page signals:
  // measured weight = 0.80, raw = 30 → 30/0.80 = 37.5 → 38.
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 12, allowedCount: 0, hasRobots: true, hasLlmsTxt: false, hasSitemap: false },
    sitemap: {},
  });
  assert.equal(r.weightSum, 0.80);
  assert.equal(r.score, 38);
  // appliedWeight is what renderers show, so the weight column still sums to 100%.
  const applied = Object.values(r.breakdown).map(b => b.appliedWeight).filter(w => w !== null);
  assert.equal(Math.round(applied.reduce((a, b) => a + b, 0) * 100), 100);
});

test('sitemap axis credits a robots-declared sitemap and flags an empty one', () => {
  const summary = { totalBots: 12, blockedCount: 0, allowedCount: 12, hasRobots: true, hasLlmsTxt: false, hasSitemap: false };
  const declared = computeDiscoverability(
    { summary, sitemap: { urlCount: 0, declaredInRobots: ['https://x.com/sitemap_index.xml'] } }, ssrPass);
  assert.equal(declared.breakdown.sitemap.value, 70, 'declared-in-robots sitemap used to score a flat 0');
  assert.ok(declared.breakdown.sitemap.note.includes('declared in robots.txt'));

  const empty = computeDiscoverability(
    { summary: { ...summary, hasSitemap: true }, sitemap: { urlCount: 0 } }, ssrPass);
  assert.equal(empty.breakdown.sitemap.value, 100, 'an empty sitemap is flagged in the note, never docked');
  assert.ok(empty.breakdown.sitemap.note.includes('no <loc>'));
});

test('breakdown notes are descriptive', () => {
  const r = computeDiscoverability({
    summary: { totalBots: 12, blockedCount: 3, allowedCount: 9, hasRobots: true, hasLlmsTxt: false, hasSitemap: true },
    sitemap: { urlCount: 12 },
  }, ssrPass);
  assert.ok(r.breakdown.bots.note.includes('9/12'));
  assert.ok(r.breakdown.serverRendered.note.includes('served HTML'));
});

// ─── Non-regression guarantee, enumerated over every reachable state ───
//
// The founder constraint on the 2026-08-02 re-weighting: no client may score
// LOWER than the old formula would have given them, other things equal. That is
// provably impossible to satisfy for EVERY state (see the arithmetic in
// visibility-index.js), so the guarantee is conditional — and this test pins
// exactly which conditions hold, so nobody has to trust the changelog prose.
//
// MUTATION-SANITY: change any surviving weight (e.g. robots 0.30 → 0.28, or
// serverRendered 0.20 → 0.15) and the sweep below goes RED.

const OLD_WEIGHTS = { robots: 0.30, bots: 0.25, sitemap: 0.25, llmsTxt: 0.20 };
function oldScore({ hasRobots, botShare, hasSitemap, hasLlmsTxt }) {
  return Math.round(
    (hasRobots ? 100 : 0) * OLD_WEIGHTS.robots
    + botShare * 100 * OLD_WEIGHTS.bots
    + (hasSitemap ? 100 : 0) * OLD_WEIGHTS.sitemap
    + (hasLlmsTxt ? 100 : 0) * OLD_WEIGHTS.llmsTxt,
  );
}

/** Every reachable input combination. `hasRobots:false` forces botShare 1:
 *  with no robots.txt there are no rules, so every bot reads `unspecified`
 *  and none counts as blocked — the state (robots 0, bots < 1) cannot occur.
 *
 *  The sitemap dimension is not a boolean in production — all four live shapes
 *  are swept, including the two the axis treats specially (a sitemap declared
 *  in robots.txt but not served, and a reachable sitemap with no <loc> rows),
 *  because both of those are where the "credit only, never dock" rule could be
 *  broken by a future edit. */
const SITEMAP_SHAPES = [
  ['served',       { hasSitemap: true,  sitemap: { urlCount: 20 } }],
  ['served-empty', { hasSitemap: true,  sitemap: { urlCount: 0 } }],
  ['declared',     { hasSitemap: false, sitemap: { urlCount: 0, declaredInRobots: ['https://x.com/sitemap_index.xml'] } }],
  ['absent',       { hasSitemap: false, sitemap: {} }],
];

function* reachableStates() {
  for (const hasRobots of [true, false]) {
    for (const botShare of hasRobots ? [0, 0.5, 1] : [1]) {
      for (const [sitemapName, sitemapShape] of SITEMAP_SHAPES) {
        for (const hasLlmsTxt of [true, false]) {
          for (const [ssrName, ssr] of [['pass', ssrPass], ['shell', ssrShell], ['unmeasured', undefined]]) {
            yield {
              hasRobots, botShare, hasLlmsTxt, ssrName, ssr,
              sitemapName, sitemapShape,
              // The OLD formula only knew "present or not".
              hasSitemap: sitemapShape.hasSitemap,
            };
          }
        }
      }
    }
  }
}

function newScore(st) {
  const totalBots = 12;
  return computeDiscoverability({
    summary: {
      totalBots,
      blockedCount: Math.round(totalBots * (1 - st.botShare)),
      hasRobots: st.hasRobots,
      hasLlmsTxt: st.hasLlmsTxt,
      hasSitemap: st.sitemapShape.hasSitemap,
    },
    sitemap: st.sitemapShape.sitemap,
  }, st.ssr).score;
}

test('GUARANTEE 1 — server-rendered content: nobody scores lower than the old formula', () => {
  const losers = [];
  for (const st of reachableStates()) {
    if (st.ssrName !== 'pass') continue;
    const before = oldScore(st);
    const after = newScore(st);
    if (after < before) losers.push(`${JSON.stringify(st.ssr ? { ...st, ssr: st.ssrName } : st)} ${before} → ${after}`);
  }
  assert.deepEqual(losers, [], `states that regressed:\n${losers.join('\n')}`);
});

test('GUARANTEE 2 — clients without llms.txt never score lower, whatever the SSR verdict', () => {
  const losers = [];
  for (const st of reachableStates()) {
    if (st.hasLlmsTxt) continue;
    const before = oldScore(st);
    const after = newScore(st);
    if (after < before) losers.push(`${st.ssrName} robots=${st.hasRobots} bots=${st.botShare} sitemap=${st.hasSitemap}: ${before} → ${after}`);
  }
  assert.deepEqual(losers, [], `states that regressed:\n${losers.join('\n')}`);
});

test('EXCEPTION SET — every regression is an llms.txt holder, bounded by 20 points', () => {
  const regressions = [];
  for (const st of reachableStates()) {
    const delta = newScore(st) - oldScore(st);
    if (delta < 0) regressions.push({ ...st, ssr: st.ssrName, delta });
  }
  // Only two shapes may appear, and both are documented in CHANGELOG.md.
  for (const r of regressions) {
    assert.equal(r.hasLlmsTxt, true, `a client WITHOUT llms.txt regressed: ${JSON.stringify(r)}`);
    assert.ok(r.ssr === 'shell' || r.ssr === 'unmeasured', `unexpected regression shape: ${JSON.stringify(r)}`);
    assert.ok(r.delta >= -20, `regression deeper than the documented 20-point bound: ${JSON.stringify(r)}`);
    if (r.ssr === 'unmeasured') {
      assert.ok(r.delta >= -14, `unmeasured-axis regression deeper than the documented 13.75: ${JSON.stringify(r)}`);
    }
  }
  // And the sweep must actually exercise them — a guarantee nobody can trip is
  // not a guarantee, it is a typo in the state generator.
  assert.ok(regressions.length > 0, 'expected the enumerated exception cases to occur');
});

// ─── AP-MEASURE-SAMPLING-CI — presence boolean→fraction invariance ───
//
// perCellPresence is the ONE switch between the legacy boolean presence and the
// sampled fractional presence. The R39 contract: a run with NO presence objects
// (default samples=1 / every legacy snapshot) must yield byte-identical presence
// to the pre-feature math.
//
// MUTATION-SANITY: make perCellPresence return r.presence.rate ?? (boolean) for
// EVERY cell, or return the rate even when absent → the single-shot identity
// test below goes RED (an undefined rate would poison the sum to NaN).

console.log('\nperCellPresence — boolean/fraction switch');

test('single-shot cell (no presence field) → boolean 1/0', () => {
  assert.equal(perCellPresence({ mention: 'yes' }), 1);
  assert.equal(perCellPresence({ mention: 'src' }), 1);
  assert.equal(perCellPresence({ mention: 'no' }), 0);
  assert.equal(perCellPresence({ mention: 'no', presence: undefined }), 0);
});

test('sampled cell contributes its fractional rate', () => {
  assert.equal(perCellPresence({ mention: 'yes', presence: { rate: 0.6, hits: 3, n: 5 } }), 0.6);
  assert.equal(perCellPresence({ mention: 'no', presence: { rate: 0, hits: 0, n: 5 } }), 0);
});

test('R39 INVARIANT — boolean run [y,n,y] gives presence 67 (unchanged)', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', canonicalCitations: [] },
      { mention: 'no',  canonicalCitations: [] },
      { mention: 'yes', canonicalCitations: [] },
    ],
  });
  // 2/3 → 66.67 → round 67. Identical to the pre-feature formula.
  assert.equal(c.presence, 67);
});

test('sampled run — fractional presence weighted across cells', () => {
  // Two cells: 2/3 trials hit (0.6667) and 1/3 trials hit (0.3333).
  // mean = (0.6667 + 0.3333) / 2 = 0.5 → presence 50.
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', presence: { rate: 2 / 3, hits: 2, n: 3 }, canonicalCitations: [] },
      { mention: 'no',  presence: { rate: 1 / 3, hits: 1, n: 3 }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.presence, 50);
});

test('mixed sampled + single-shot cells both contribute correctly', () => {
  // single-shot 'yes' = 1.0; sampled 0.5; sampled 0.0 → mean = 1.5/3 = 0.5 → 50.
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', canonicalCitations: [] },                                   // boolean 1
      { mention: 'yes', presence: { rate: 0.5, hits: 1, n: 2 }, canonicalCitations: [] }, // 0.5
      { mention: 'no',  presence: { rate: 0,   hits: 0, n: 2 }, canonicalCitations: [] }, // 0
    ],
  });
  assert.equal(c.presence, 50);
});

// ─── AP-PROSE-RANK — prose ordinals fold into the rank axis (down-weighted) ───
//
// rank-strength(pos) = 100 - (pos-1)*15  → pos1=100, pos2=85, pos3=70
// prose contribution = rank-strength × PROSE_RANK_DISCOUNT (0.7)
//   prose#1 = 70, prose#2 = 59.5
console.log('\nAP-PROSE-RANK rank axis');

test('R39: records with NO proseRank field → rank byte-identical to pre-feature', () => {
  // One list-rank cell at position 2 → rank 85, no prose anywhere.
  const c = computeComponents({
    domain: 'a.com',
    results: [{ mention: 'yes', position: 2, canonicalCitations: [] }],
  });
  assert.equal(c.rank, 85);
  assert.equal(c.rankSample, 1);
  assert.equal(c.proseRankSample, 0);
});

test('prose-rank fills the axis where list-rank was null', () => {
  // No list positions at all; one prose mention ranked #1 (med confidence).
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: null, proseRank: { rank: 1, confidence: 'med' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.rank, 70);          // 100 * 0.7
  assert.equal(c.rankSample, 1);
  assert.equal(c.proseRankSample, 1);
});

test('list-rank and prose-rank average together; list cell NOT double-counted', () => {
  // list #1 (=100) + prose #2 (=85*0.7=59.5) → mean = 79.75 → round 80, n=2
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, canonicalCitations: [] },
      { mention: 'yes', position: null, proseRank: { rank: 2, confidence: 'med' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.rank, 80);
  assert.equal(c.rankSample, 2);
  assert.equal(c.proseRankSample, 1);
});

test('a cell with BOTH a list position and a (stray) proseRank counts ONCE as list', () => {
  // list #1 = 100. The proseRank on the SAME cell must be ignored (list wins).
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: 1, proseRank: { rank: 5, confidence: 'med' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.rank, 100);         // not dragged down by the stray prose #5
  assert.equal(c.rankSample, 1);
  assert.equal(c.proseRankSample, 0);
});

test('prose-rank with null rank or sub-floor confidence does NOT contribute', () => {
  const c = computeComponents({
    domain: 'a.com',
    results: [
      { mention: 'yes', position: null, proseRank: { rank: null, confidence: 'none' }, canonicalCitations: [] },
      { mention: 'yes', position: null, proseRank: { rank: 2, confidence: 'failed' }, canonicalCitations: [] },
    ],
  });
  assert.equal(c.rank, null);        // nothing usable → axis absent, not fabricated
  assert.equal(c.rankSample, 0);
  assert.equal(c.proseRankSample, 0);
});

test('prose discount makes a prose #1 weaker than a list #1', () => {
  const listC = computeComponents({ domain: 'a.com', results: [{ mention: 'yes', position: 1, canonicalCitations: [] }] });
  const proseC = computeComponents({ domain: 'a.com', results: [{ mention: 'yes', position: null, proseRank: { rank: 1, confidence: 'med' }, canonicalCitations: [] }] });
  assert.ok(proseC.rank < listC.rank, `prose #1 (${proseC.rank}) must be < list #1 (${listC.rank})`);
});

console.log('\nusableProseRank');

test('usableProseRank gate: rank≥1 + ok confidence', () => {
  assert.equal(usableProseRank({ rank: 1, confidence: 'med' }), true);
  assert.equal(usableProseRank({ rank: 3, confidence: 'low' }), true);
  assert.equal(usableProseRank({ rank: 2, confidence: 'single-model' }), true);
  assert.equal(usableProseRank({ rank: null, confidence: 'med' }), false);
  assert.equal(usableProseRank({ rank: 2, confidence: 'none' }), false);
  assert.equal(usableProseRank({ rank: 2, confidence: 'failed' }), false);
  assert.equal(usableProseRank(undefined), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
