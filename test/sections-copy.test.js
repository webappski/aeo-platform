// Tests for copy / framing fixes in lib/report/sections.js (v0.3.2).
//
// Covers the four "marketing dressed as measurement" bugs flagged by the
// independent persona review:
//   BUG 1 — «How your score compares» fake comparison bands removed
//   BUG 2 — Engine-specific actions are data-driven (with fallback)
//   BUG 3 — «Discoverability Score» → «AI-Bot Crawl Readiness» rename
//   BUG 4 — UTM section reframed as engine-auto-tagged (not user attribution)

import assert from 'node:assert/strict';
import {
  sectionBaseline,
  sectionEngineActions,
  sectionDiscoverability,
  sectionUtmCitations,
  topCitedHostsForProvider,
  splitUtmByOrigin,
} from '../lib/report/sections.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// ─── BUG 1 ────────────────────────────────────────────────────────────────

console.log('\nBUG 1 — comparison-baseline section removed');

test('sectionBaseline returns empty string for any input (block removed)', () => {
  const snap = { score: 5, mentions: 0, total: 9, brand: 'Acme', results: [] };
  assert.equal(sectionBaseline([snap]), '');
});

test('sectionBaseline returns empty even for high scores (no comparison ever shown)', () => {
  const snap = { score: 80, mentions: 7, total: 9, brand: 'Acme', results: [] };
  assert.equal(sectionBaseline([snap]), '');
});

test('no fabricated baseline strings emitted', () => {
  // Build a low-score snapshot — under the old code this triggered the
  // «Pre-revenue brand / 6-month-old brand / Established category leader»
  // block. New code returns ''.
  const snap = { score: 2, mentions: 0, total: 9, brand: 'X', results: [] };
  const out = sectionBaseline([snap]);
  assert.ok(!out.includes('Pre-revenue brand'),       'must not emit Pre-revenue brand band');
  assert.ok(!out.includes('Established category leader'), 'must not emit category leader band');
  assert.ok(!out.includes('Rough baselines from Webappski'), 'must not emit Webappski-attributed baseline footnote');
  assert.ok(!out.includes('How your score compares'), 'must not emit comparison header');
});

// ─── BUG 2 ────────────────────────────────────────────────────────────────

console.log('\nBUG 2 — engine-specific actions are data-driven');

function buildSnapshot({ provider, citations, mention = 'yes' }) {
  return {
    brand: 'Acme',
    domain: 'acme.com',
    score: 33,
    mentions: 1,
    total: 3,
    results: [
      { provider, query: 'best alt to acme', mention, canonicalCitations: citations },
    ],
  };
}

test('topCitedHostsForProvider ranks by count and filters own domain', () => {
  const results = [
    { provider: 'openai', canonicalCitations: [
      'https://example.com/a', 'https://example.com/b',
      'https://other.org/c',
      'https://acme.com/landing',  // own domain — must be excluded
      'https://www.acme.com/x',    // own domain w/ www
    ]},
    { provider: 'gemini', canonicalCitations: ['https://example.com/g'] }, // wrong provider
  ];
  const hosts = topCitedHostsForProvider(results, 'openai', 'acme.com', 3);
  assert.deepEqual(hosts, ['example.com', 'other.org']);
});

test('topCitedHostsForProvider tolerates malformed URLs and missing fields', () => {
  const results = [
    { provider: 'openai', canonicalCitations: ['not a url', '', null, 'https://x.com/p'] },
    { provider: 'openai' }, // no canonicalCitations
  ];
  const hosts = topCitedHostsForProvider(results, 'openai', '', 3);
  assert.deepEqual(hosts, ['x.com']);
});

test('data-driven path: card mentions the actual top cited host', () => {
  const snap = buildSnapshot({
    provider: 'openai',
    citations: [
      'https://anvevoice.app/x', 'https://anvevoice.app/y',
      'https://sayfill.com/a',
      'https://agentfillai.com/b',
    ],
  });
  const out = sectionEngineActions([snap]);
  assert.ok(out.includes('## Engine-specific actions'));
  assert.ok(out.includes('anvevoice.app'),  'must mention top cited host');
  assert.ok(out.includes('sayfill.com'),    'must mention 2nd cited host');
  assert.ok(out.includes('agentfillai.com'),'must mention 3rd cited host');
  // The hardcoded G2/Capterra/PH advice must NOT fire when data is available.
  assert.ok(!out.includes('G2, Capterra, or Product Hunt'),
    'must not show generic playbook when real citations exist');
  // And must not be labelled as "no citations / generic playbook".
  assert.ok(!out.includes('No citations from ChatGPT this run'),
    'data-driven path must not show the no-citations fallback header');
});

test('fallback path: zero citations → labelled generic playbook fires', () => {
  // mention=yes but NO canonical citations whatsoever for this engine.
  const snap = buildSnapshot({ provider: 'openai', citations: [], mention: 'yes' });
  const out = sectionEngineActions([snap]);
  assert.ok(out.includes('No citations from ChatGPT this run'),
    'fallback header must announce "no citations" explicitly');
  assert.ok(out.includes('generic playbook for ChatGPT'),
    'fallback must label itself as generic playbook');
  // Generic-playbook tips are now allowed to surface (and only here).
  assert.ok(out.includes('G2, Capterra, or Product Hunt'),
    'fallback path keeps the legacy playbook bullet');
});

test('fallback path: own-domain-only citations also trigger fallback', () => {
  // ChatGPT cited only the user's own domain — after filtering nothing remains.
  const snap = buildSnapshot({
    provider: 'openai',
    citations: ['https://acme.com/x', 'https://www.acme.com/y'],
  });
  const out = sectionEngineActions([snap]);
  assert.ok(out.includes('No citations from ChatGPT this run'));
  assert.ok(!out.includes('acme.com</code> — ChatGPT already cited'),
    'must not advise pitching the user\'s own domain');
});

test('low-signal path: single cited host falls back to generic playbook', () => {
  // ChatGPT cited exactly one external host — N=1 is not enough signal for
  // «pitch this domain» advice; the labelled generic playbook is more honest.
  const snap = buildSnapshot({
    provider: 'openai',
    citations: ['https://example.com/a'],
  });
  const out = sectionEngineActions([snap]);
  assert.ok(out.includes('Only one usable cited host for ChatGPT'),
    'must use the low-signal fallback header at N=1');
  assert.ok(out.toLowerCase().includes('generic playbook for chatgpt'),
    'must show generic playbook label');
  assert.ok(out.includes('G2, Capterra, or Product Hunt'),
    'must surface the fallback bullets');
  // And must NOT surface a «Pitch example.com» bullet on the data-driven path.
  assert.ok(!out.includes('Pitch <code>example.com'),
    'must not generate a data-driven pitch line for the single host');
});

test('deny-listed hosts (github.io / w3schools / tutorialspoint) never surface', () => {
  // Citations include a generic-hosting tenant (github.io subdomain) and a
  // dead tutorial site — both must be filtered before the engine card builds
  // its recommendation list, same as sectionCanonicalSources.
  const snap = buildSnapshot({
    provider: 'openai',
    citations: [
      'https://example.com/a', 'https://example.com/b',
      'https://other.org/c',
      'https://alice.github.io/blog',   // generic dev host — denied
      'https://w3schools.com/page',     // dead tutorial — denied
      'https://tutorialspoint.com/x',   // dead tutorial — denied
    ],
  });
  const out = sectionEngineActions([snap]);
  assert.ok(!out.includes('github.io'),       'must not recommend pitching github.io tenants');
  assert.ok(!out.includes('w3schools.com'),   'must not recommend pitching w3schools.com');
  assert.ok(!out.includes('tutorialspoint.com'), 'must not recommend pitching tutorialspoint');
  assert.ok(out.includes('example.com'),      'legitimate host must still surface');
  assert.ok(out.includes('other.org'),        'legitimate host must still surface');
});

test('off-category hosts (per citation classifier) are excluded from data-driven advice', () => {
  // The disambiguation panel already flags off-category hosts as wrong-vertical
  // for the user's brand — recommending the engine «pitch them» from the
  // sibling card contradicts that warning. Exclude.
  const snap = {
    brand: 'Acme', domain: 'acme.com', score: 33, mentions: 1, total: 3,
    results: [
      { provider: 'openai', query: 'q', mention: 'yes', canonicalCitations: [
        'https://goodhost.com/a', 'https://goodhost.com/b',
        'https://anotherhost.com/c',
        'https://offcategory.example/x',  // flagged off-category below
        'https://offcategory.example/y',
      ]},
    ],
    citationClassification: {
      offCategoryDomains: [
        { hostname: 'offcategory.example', industry: 'healthcare', confidence: 'high' },
      ],
      onCategoryDomains: [
        { hostname: 'goodhost.com',    industry: 'devtools', confidence: 'high' },
        { hostname: 'anotherhost.com', industry: 'devtools', confidence: 'high' },
      ],
    },
  };
  const out = sectionEngineActions([snap]);
  assert.ok(!out.includes('offcategory.example'),
    'off-category host must not be recommended as a pitch target');
  assert.ok(out.includes('goodhost.com'),
    'on-category host must still surface');
});

test('topCitedHostsForProvider respects excludeHosts option', () => {
  const results = [
    { provider: 'openai', canonicalCitations: [
      'https://a.com/x', 'https://b.com/y', 'https://c.com/z',
    ]},
  ];
  const hosts = topCitedHostsForProvider(
    results, 'openai', '', 3, { excludeHosts: new Set(['b.com']) }
  );
  assert.deepEqual(hosts, ['a.com', 'c.com']);
});

test('topCitedHostsForProvider drops deny-listed hosts (alice.github.io, w3schools.com)', () => {
  const results = [
    { provider: 'openai', canonicalCitations: [
      'https://example.com/a',
      'https://alice.github.io/blog',
      'https://w3schools.com/tutorial',
    ]},
  ];
  const hosts = topCitedHostsForProvider(results, 'openai', '', 3);
  assert.deepEqual(hosts, ['example.com']);
});

// ─── BUG 3 ────────────────────────────────────────────────────────────────

console.log('\nBUG 3 — Discoverability Score renamed to AI-Bot Crawl Readiness');

function snapWithCrawl() {
  return {
    brand: 'Acme', domain: 'acme.com', results: [],
    crawlability: {
      summary: { hasRobots: true, hasLlmsTxt: true, hasSitemap: true, totalBots: 12, allowedCount: 12, blockedCount: 0 },
      robots:  { groups: [] },
      sitemap: { urlCount: 50 },
    },
  };
}

test('headline reads "AI-Bot Crawl Readiness", not "Discoverability Score"', () => {
  const out = sectionDiscoverability([snapWithCrawl()]);
  assert.ok(out.includes('## AI-Bot Crawl Readiness'),
    'must use new headline');
  assert.ok(!out.includes('## Discoverability Score'),
    'must not use the old over-selling headline');
});

test('caveat about off-page authority is present', () => {
  const out = sectionDiscoverability([snapWithCrawl()]);
  assert.ok(out.includes('measures TECHNICAL access'),
    'must caveat that this is technical access, not actual answer-pool inclusion');
  assert.ok(out.includes('off-page authority'),
    'must point at off-page authority as the actual visibility driver');
  assert.ok(out.includes('Authority-Source Presence'),
    'must cross-link to the authority section');
});

test('returns empty string when no crawlability data', () => {
  const out = sectionDiscoverability([{ brand: 'X', domain: 'x.com', results: [], crawlability: null }]);
  assert.equal(out, '');
});

// ─── BUG 4 ────────────────────────────────────────────────────────────────

console.log('\nBUG 4 — UTM citations reframed as engine-auto-tagged');

test('splitUtmByOrigin separates engine-auto from user-configured', () => {
  const utm = {
    totalUtmCitations: 5,
    bySource: [
      { source: 'openai', count: 3 },
      { source: 'aeo-q4',  count: 2 },
    ],
    byCampaign: [{ campaign: '(none)', count: 3 }, { campaign: 'q4', count: 2 }],
    samples: [
      { provider: 'openai', query: 'Q1', source: 'openai',  medium: '', campaign: '(none)' },
      { provider: 'openai', query: 'Q2', source: 'openai',  medium: '', campaign: '(none)' },
      { provider: 'openai', query: 'Q3', source: 'openai',  medium: '', campaign: '(none)' },
      { provider: 'gemini', query: 'Q4', source: 'aeo-q4',  medium: 'email', campaign: 'q4' },
      { provider: 'gemini', query: 'Q5', source: 'aeo-q4',  medium: 'email', campaign: 'q4' },
    ],
  };
  const { engineAuto, userConfigured } = splitUtmByOrigin(utm);
  assert.equal(engineAuto.totalCitations, 3);
  assert.equal(userConfigured.totalCitations, 2);
  assert.equal(engineAuto.bySource[0].source, 'openai');
  assert.equal(userConfigured.bySource[0].source, 'aeo-q4');
  assert.equal(userConfigured.byCampaign[0].campaign, 'q4');
});

test('splitUtmByOrigin recognises all known AI engine source names', () => {
  const utm = {
    totalUtmCitations: 6,
    bySource: ['openai','chatgpt','anthropic','claude','google','gemini','perplexity']
      .map(source => ({ source, count: 1 })),
    byCampaign: [],
    samples: ['openai','chatgpt','anthropic','claude','google','gemini','perplexity']
      .map((s, i) => ({ provider: 'openai', query: 'Q'+i, source: s, medium: '', campaign: '' })),
  };
  const { engineAuto, userConfigured } = splitUtmByOrigin(utm);
  assert.equal(userConfigured.totalCitations, 0);
  assert.equal(engineAuto.totalCitations, 7);
});

function buildUtmSnapshot(citations) {
  return {
    brand: 'Acme', domain: 'acme.com',
    results: [{ provider: 'openai', query: 'Q1', canonicalCitations: citations }],
  };
}

test('engine-auto-only UTMs render under the engine-side header, NOT as user attribution', () => {
  const out = sectionUtmCitations([buildUtmSnapshot([
    'https://acme.com/a?utm_source=openai',
    'https://acme.com/b?utm_source=openai',
    'https://acme.com/c?utm_source=openai',
  ])]);
  assert.ok(out.includes('## Engine-Auto-Tagged Citations'),
    'must use renamed top-level header');
  assert.ok(!out.includes('## UTM-Tagged Citations'),
    'must not use the old misleading header');
  assert.ok(out.includes('engine-side attribution you did NOT set'),
    'must explicitly state these UTMs were not user-set');
  assert.ok(out.includes('AI-engine-side attribution'),
    'must label engine-auto sub-section');
  assert.ok(!out.includes('Your own UTM-tagged pages cited by AI'),
    'must NOT render user-configured sub-section when none exist');
  // The framing implying user did the work must be GONE.
  assert.ok(!out.includes('If you UTM-tag pages you want AI to send traffic to'),
    'must not retain the old "your AEO attribution table" framing');
});

test('user-configured UTMs still get their own sub-section with the original framing', () => {
  const out = sectionUtmCitations([buildUtmSnapshot([
    'https://acme.com/a?utm_source=ai&utm_campaign=q4',
    'https://acme.com/b?utm_source=ai&utm_campaign=q4',
  ])]);
  assert.ok(out.includes('Your own UTM-tagged pages cited by AI'),
    'user-configured block must appear when source is not a known engine name');
  assert.ok(out.includes('AEO attribution table'),
    'original framing preserved for genuinely user-set UTMs');
});

test('mixed engine-auto + user-configured renders both sub-sections', () => {
  const out = sectionUtmCitations([buildUtmSnapshot([
    'https://acme.com/a?utm_source=openai',
    'https://acme.com/b?utm_source=ai&utm_campaign=q4',
  ])]);
  assert.ok(out.includes('AI-engine-side attribution'),       'engine block present');
  assert.ok(out.includes('Your own UTM-tagged pages cited by AI'), 'user block present');
});

test('section omitted entirely when no UTMs detected', () => {
  const out = sectionUtmCitations([buildUtmSnapshot(['https://acme.com/no-utm'])]);
  assert.equal(out, '');
});

// ─── ENGINE-FACT FRESHNESS (AP-ENGINE-FACTS-REFRESH, 2026-06-12) ────────────
//
// The fallback engine cards teach the user how each engine sources answers.
// These facts go stale (Bing API retired 2025-08; Gemini FastSearch, not full
// Search ranking; Perplexity own index). Our trump-card product must never ship
// a dead engine fact. Guard the whole class against playbook §5/§5.1/§5.2.
//
// Rendering the zero-citation fallback path surfaces ENGINE_FALLBACK_TIPS[p].why
// verbatim (sections.js: why = lowSignalNote + fb.why → <p class="ea-why">), so
// this asserts on the real module's real output — no mocks.

console.log('\nENGINE-FACT FRESHNESS — fallback why-strings vs playbook §5');

// One zero-external-citation snapshot per engine → forces the labelled fallback,
// which renders that engine's `why` string into the card.
function fallbackCardFor(provider) {
  return sectionEngineActions([buildSnapshot({ provider, citations: [], mention: 'yes' })]);
}

// REVISED 2026-08-02 (AP-DEAD-TACTIC sweep). This test used to REQUIRE the
// string «Bing dependence ended» — i.e. it pinned a claim that OpenAI's own
// documentation contradicts. `help.openai.com/en/articles/9237897-chatgpt-search`
// (verified live 2026-08-01, quoted in webappski-ops/resources/aeo/bp-refresh/
// 2026-08-01.md): «ChatGPT search partners with other search providers», and it
// names Bing and Shopify. The retired claim in the ORIGINAL copy was the older
// «grounds answers in Bing search results» framing (as if Bing were the whole
// backend); that stays banned. What replaces it is the sourced version: OpenAI's
// own crawl PLUS partner providers, one of which is Bing — which is also why a
// Bing index check is a real lever for a small site.
test('ChatGPT card states the sourced retrieval path: own crawl + partner providers', () => {
  const out = fallbackCardFor('openai');
  assert.ok(!/grounds answers in Bing/i.test(out),
    'must not ship the retired "Bing is the backend" claim');
  assert.ok(!/Bing dependence ended/i.test(out),
    'must not claim the Bing partnership is over — OpenAI still names Bing as a search partner');
  assert.ok(/OAI-SearchBot/.test(out),
    'must name OpenAI’s own crawler (the bot whose block actually costs citations)');
  assert.ok(/partner search providers/i.test(out) && /Bing/.test(out),
    'must state the partner-provider path and name Bing, per OpenAI’s help page');
});

test('no engine card revives the retired "Bing is the backend" sentence', () => {
  // Whole-suite class guard: render every engine’s fallback, concatenate, scan.
  // Naming Bing as one of OpenAI's PARTNER providers is correct and required by
  // the test above; describing ChatGPT as grounding its answers IN Bing is the
  // pre-2026 framing and stays banned.
  const all = ['openai', 'gemini', 'anthropic', 'perplexity'].map(fallbackCardFor).join('\n');
  assert.ok(!/grounds answers in Bing/i.test(all),
    'dead Bing-grounding pattern must not appear on any engine card');
});

// REVISED 2026-08-02 (AP-DEAD-TACTIC sweep). This test used to REQUIRE the
// string «FastSearch» — a retrieval-mechanism claim with no first-party source
// (it comes from antitrust-testimony reporting, repeated through SEO blogs).
// Google's own documentation says its AI answers «rely on our core Search
// ranking systems to retrieve relevant, up-to-date web pages» and issue several
// parallel queries (query fan-out), and the Gemini API reports the queries the
// model actually ran (`webSearchQueries`). The card now says that instead. The
// bullet under it also stopped advising FAQ schema, so the card must not sell
// markup as a lever anywhere.
test('Gemini card states the sourced retrieval path and sells no markup', () => {
  const out = fallbackCardFor('gemini');
  assert.ok(!/FastSearch/i.test(out),
    'must not ship the unsourced FastSearch mechanism claim');
  assert.ok(/Search index/i.test(out) && /parallel queries/i.test(out),
    'must state what Google documents: retrieval from the Search index + query fan-out');
  assert.ok(!/(add|implement)[^.\n]{0,40}(faq|schema|structured data)/i.test(out),
    'must not recommend schema markup as a visibility lever (Google: not required; Ahrefs N=1885: no uplift)');
});

test('Perplexity card reflects its own index + freshness, not generic web search', () => {
  const out = fallbackCardFor('perplexity');
  assert.ok(/PerplexityBot/.test(out),
    'must name PerplexityBot crawlability (the only door into its own index, §5)');
  assert.ok(!/real-time multi-source web search/i.test(out),
    'must drop the inaccurate "multi-source web search" framing (it runs its own index)');
});

test('Claude card hedges the Brave backend instead of stating it as fact', () => {
  const out = fallbackCardFor('anthropic');
  assert.ok(/best-evidenced/i.test(out) && /not officially confirmed/i.test(out),
    'must present Brave as best-evidenced-but-unconfirmed (playbook §5), not as bald fact');
  assert.ok(/training data/i.test(out),
    'training-data framing must remain (training-data archetype lever)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
