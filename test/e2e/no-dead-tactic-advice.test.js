/**
 * Guard — the report must never again recommend a dead tactic.
 *
 * BACKGROUND (2026-08-02). The report told every client «No /llms.txt found —
 * emerging convention… Adding one (5 min) gives engines a fast-path to your key
 * facts», and the crawl-readiness score gave the file 20% of its weight, so a
 * client without it lost a fifth of the score. Google states the file «isn't
 * needed for AI Overviews, AI Mode, or other generative AI Search features»
 * (changelog 2026-06-15), a ~300,000-domain study found no correlation with
 * being cited, and no major provider has confirmed support. The same sweep
 * removed «add FAQ schema markup» (FAQ rich result gone 2026-05-07, docs
 * deleted 2026-06-15) and the copy that told clients unblocking GPTBot /
 * Google-Extended would win them citations (only OAI-SearchBot, PerplexityBot,
 * Claude-SearchBot and Googlebot gate answers).
 *
 * This test holds all three lines closed, at three levels, because the advice
 * can come back through three different doors:
 *   1. SOURCE — someone re-adds the copy to lib/ or bin/.
 *   2. RENDER — a section prints an advisory sentence built some other way.
 *   3. MODEL — `llmActions` is written by an LLM at report time, and «add an
 *      llms.txt» is a top-of-prior recommendation for any 2024-vintage AEO
 *      model. A prompt rule is not a guarantee; the mechanical filter is.
 *
 * It also pins what must NOT change: the crawlability audit still MEASURES
 * /llms.txt and the report still states the fact. The instruction was to stop
 * concluding something from it, not to stop looking.
 *
 * MUTATION-SANITY: restore the advisory sentence in
 * `lib/report/sections.js::sectionCrawlability`, or drop the
 * `withoutDeadTactics` call in html.js, and this test goes RED.
 */
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './_helpers.js';
import { sectionCrawlability, sectionDiscoverability } from '../../lib/report/sections.js';
import { renderMarkdown } from '../../lib/report/markdown.js';
import { renderHtml } from '../../lib/report/html.js';
import { buildMcMetadata } from '../../lib/report/mc-metadata.js';
import { AI_BOTS, CITATION_GATING_BOTS, botTier, gatesCitations } from '../../lib/report/crawlability-audit.js';
import { deadTacticRule, filterDeadTactics, withoutDeadTactics } from '../../lib/report/dead-tactics.js';

// ── The banned copy. Assembled from fragments so this file's own text cannot
// match the source-level grep (the self-reference trap that would make the
// guard permanently red).
const BANNED_SOURCE_STRINGS = [
  ['llmstxt', '.org'].join(''),
  ['emerging', 'convention'].join(' '),
  ['fast-path', 'to your key facts'].join(' '),
  ['Add FAQ schema', 'markup'].join(' '),
];

// Sentence shapes that count as ADVICE in rendered output, as opposed to a
// statement of fact. Deliberately verb-anchored: «llms.txt: not present» must
// survive, «add an llms.txt» must not.
const ADVICE_PATTERNS = [
  /(add|create|publish|generate|implement|set ?up|introduce|deploy)[^.\n]{0,80}llms?[-_ .]?txt/i,
  /llms?[-_ .]?txt[^.\n]{0,60}(takes|is worth|gives engines|5 min|quick win|easy win)/i,
  // The original sentence put the verb in the NEXT sentence («…summaries.
  // Adding one (5 min) gives engines…»), which a same-sentence pattern misses.
  /\b(adding|add) (one|it|this file)\b[^.\n]{0,80}(min|engine|fast|facts|visib)/i,
  /(add|implement|create)[^.\n]{0,40}(faq ?page|faq schema|how-?to schema)/i,
  /(unblock|allow|whitelist)[^.\n]{0,60}(gptbot|google-extended|ccbot|bytespider)/i,
];

function git(args, { allowNoMatch = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  } catch (err) {
    if (allowNoMatch && err.status === 1) return '';
    throw err;
  }
}

// ── Fixture: a client with NO llms.txt, a JS-shell-free homepage, one blocked
// training bot, plus LLM recommendations that push all three dead tactics.
const crawlability = {
  domain: 'testbrand.com',
  summary: {
    totalBots: 12, blockedCount: 1, allowedCount: 5, partialCount: 0, unspecifiedCount: 6,
    gatingTotal: 2, gatingBlockedCount: 0,
    hasRobots: true, hasLlmsTxt: false, hasSitemap: true,
  },
  botAccess: [
    { name: 'GPTBot', label: 'GPTBot', provider: 'ChatGPT', tier: 'training', access: 'blocked' },
    { name: 'OAI-SearchBot', label: 'OAI-SearchBot', provider: 'ChatGPT', tier: 'search', access: 'allowed' },
    { name: 'PerplexityBot', label: 'PerplexityBot', provider: 'Perplexity', tier: 'search', access: 'allowed' },
  ],
  robots: { url: 'https://testbrand.com/robots.txt', status: 200, bytes: 200 },
  sitemap: { url: 'https://testbrand.com/sitemap.xml', urlCount: 50 },
};

const pageSignals = {
  homepage: {
    ok: true, bytes: 40000,
    headings: { h1: { count: 1, samples: ['Test'] }, h2: { count: 4, samples: [] } },
    schemaOrg: { blockCount: 1, types: ['Organization'] },
    answerCapsules: { totalH2: 4, withCapsule: 2, coverage: 50 },
    faq: { schemaCount: 0, heuristicCount: 0, total: 0 },
  },
};

const DEAD_TACTIC_ACTIONS = [
  { kind: 'gap', priority: 'high', engines: [], title: 'Publish an llms.txt file', detail: 'Create /llms.txt so engines get a fast path to your key facts.' },
  { kind: 'gap', priority: 'med', engines: ['gemini'], title: 'Add FAQPage schema', detail: 'Implement FAQPage structured data on the landing page for AI Overviews.' },
  { kind: 'gap', priority: 'med', engines: ['openai'], title: 'Unblock GPTBot', detail: 'Allow GPTBot in robots.txt so ChatGPT can cite you.' },
  { kind: 'compete', priority: 'high', engines: [], title: 'Build comparison page', detail: 'Long-form page versus Competitor A.' },
];

const snapshot = {
  date: '2026-08-02', brand: 'TestBrand', domain: 'testbrand.com',
  score: 50, mentions: 1, total: 2, errors: 0,
  results: [
    { query: 'Q1', queryText: 'best test tools', provider: 'openai', label: 'ChatGPT', model: 'gpt-test', mention: 'yes', position: 1, citationCount: 1, canonicalCitations: ['https://g2.com/test'], competitors: ['Competitor A'], sentiment: { label: 'positive', confidence: 'high' } },
    { query: 'Q2', queryText: 'free alternatives', provider: 'gemini', label: 'Gemini', model: 'gemini-test', mention: 'no', position: null, citationCount: 0, canonicalCitations: [], competitors: [] },
  ],
  topCompetitors: [{ name: 'Competitor A', count: 1 }],
  topCanonicalSources: [{ url: 'https://g2.com/test', count: 1 }],
  topDomains: [{ host: 'g2.com', count: 1, share: 1 }],
  crawlability,
  pageSignals,
  llmActions: DEAD_TACTIC_ACTIONS,
};

const summary = {
  meta: { brand: 'TestBrand', domain: 'testbrand.com', date: '2026-08-02', prevDate: null, queryCount: 2, providerCount: 2, runId: 'test' },
  score: 50, scorePrev: null, trend: [50], trendDates: ['2026-08-02'],
  engines: [
    { provider: 'openai', label: 'ChatGPT', model: 'gpt-test', kind: 'gpt-test', cells: ['yes'], pct: 100, hits: 1, total: 1, citations: 1, delta: null, series: [100] },
    { provider: 'gemini', label: 'Gemini', model: 'gemini-test', kind: 'gemini-test', cells: ['no'], pct: 0, hits: 0, total: 1, citations: 0, delta: null, series: [0] },
  ],
  coverage: { yes: 1, src: 0, no: 1, error: 0, total: 2 },
  competitors: [{ name: 'Competitor A', count: 1 }],
  sources: [], quotes: [], citationOnly: [],
  actions: DEAD_TACTIC_ACTIONS,
  llmActions: DEAD_TACTIC_ACTIONS,
  positionMatrix: [],
  totalCitations: 1, totalCitationsPrev: null, regionCount: 1, regions: [],
  sessionCostUsd: 0.01, totalCostUsd: 0.01, costBreakdown: [], costTrend: [0.01],
  topDomains: snapshot.topDomains, topCanonicalSources: snapshot.topCanonicalSources,
  crawlability, pageSignals, authorityPresence: null,
  adsDetected: { totalCellsScanned: 2, totalCellsWithAdSignal: 0, byProvider: {}, samples: [] },
  outreachTemplates: [], citationClassification: null, cells: [],
  results: snapshot.results,
};

// ─── 1. SOURCE ───

test('no report source file carries the dead-tactic advice copy', () => {
  for (const banned of BANNED_SOURCE_STRINGS) {
    const hits = git(['grep', '-In', '--fixed-strings', banned, '--', 'lib', 'bin'], { allowNoMatch: true });
    assert.equal(hits, '', `dead-tactic copy "${banned}" is back in lib/ or bin/:\n${hits}`);
  }
});

// ─── 2. RENDER ───

test('the crawlability section states llms.txt as a fact and gives no advice', () => {
  const out = sectionCrawlability([snapshot]);
  assert.ok(out.includes('llms.txt'), 'the fact line must survive — we still measure the file');
  assert.ok(/not a ranking signal/.test(out), 'the fact must carry its no-verdict qualifier');
  for (const re of ADVICE_PATTERNS) {
    assert.ok(!re.test(out), `crawlability section still advises a dead tactic (${re}):\n${out}`);
  }
  for (const banned of BANNED_SOURCE_STRINGS) {
    assert.ok(!out.includes(banned), `crawlability section contains banned copy "${banned}"`);
  }
  // A blocked TRAINING bot must not be described as a lost citation.
  assert.ok(!/GPTBot[^.]*cannot cite you/i.test(out));
  assert.ok(/no citation effect|no measured effect/i.test(out), 'a blocked training bot needs its "this is not a problem" framing');
});

test('the crawl-readiness score has no llms.txt axis', () => {
  const out = sectionDiscoverability([snapshot]);
  assert.ok(!/llms/i.test(out), `llms.txt is back in the score table:\n${out}`);
  assert.ok(/content in served HTML/i.test(out), 'the replacement axis must be shown');
});

test('the full markdown report contains no dead-tactic advice', () => {
  const md = renderMarkdown([snapshot], {}, { noMcBlock: true });
  for (const re of ADVICE_PATTERNS) {
    const m = md.match(re);
    assert.equal(m, null, `markdown report advises a dead tactic: "${m && m[0]}"`);
  }
  for (const banned of BANNED_SOURCE_STRINGS) {
    assert.ok(!md.includes(banned), `markdown report contains banned copy "${banned}"`);
  }
});

// ─── 3. MODEL ───

test('LLM recommendations pushing dead tactics never reach the HTML report', () => {
  const html = renderHtml(summary, [snapshot], { noMcBlock: true });
  assert.ok(html.includes('Build comparison page'), 'the legitimate recommendation must survive the filter');
  assert.ok(!html.includes('Publish an llms.txt file'), 'an llms.txt recommendation reached the report');
  assert.ok(!html.includes('Add FAQPage schema'), 'a FAQPage recommendation reached the report');
  assert.ok(!html.includes('Unblock GPTBot'), 'an unblock-GPTBot recommendation reached the report');
  for (const re of ADVICE_PATTERNS) {
    const m = html.match(re);
    assert.equal(m, null, `HTML report advises a dead tactic: "${m && m[0]}"`);
  }
});

test('the Mission Control payload is filtered too, and still reports the file as a fact', () => {
  const mc = buildMcMetadata(summary);
  const titles = mc.recommendations.map(r => r.title);
  assert.deepEqual(titles, ['Build comparison page']);
  // The measurement itself is untouched: MC still receives hasLlmsTxt.
  assert.equal(mc.crawl.hasLlmsTxt, false);
  assert.equal('hasLlmsTxt' in mc.crawl, true, 'the fact must still be reported to Mission Control');
});

// ─── 3b. The filter must not eat legitimate recommendations ───
//
// A false drop is not a cosmetic bug: `recommendations()` filters and THEN
// takes the top 10, so a wrong drop silently reshuffles the payload that feeds
// a paid plan. These four probes come from the 2026-08-02 review, which ran
// them through the real `deadTacticRule` and found all four wrongly flagged by
// the first implementation — it tested "tactic appears anywhere" AND "verb
// appears anywhere" independently. The first probe is the sharpest: text that
// says DON'T was cut as if it said DO.
const MUST_SURVIVE = [
  // Round 2 — verb and tactic 1-15 characters apart, each pair separated by a
  // boundary character (`.`, `;`, `…`).
  'Your llms.txt is already fine as-is — no changes needed. Add a clear call-to-action to the hero section.',
  'You already have FAQPage schema in place; add more product photos to the listing.',
  'Your robots.txt correctly blocks GPTBot for training purposes; instead, allow more crawl budget for search bots.',
  'Publish a new blog post about pricing… Separately, note that llms.txt has no effect on citations.',
  // Round 3 — verb and tactic 61-101 characters apart with NO boundary
  // character between them: the range the four probes above cannot reach, and
  // the reason the 60-character cap in `GAP` is load-bearing rather than
  // leftover. Every one of these describes or REJECTS the tactic honestly, and
  // every one was falsely cut while the cap was briefly raised to 140.
  'We reviewed your directives and found nothing worth adding beyond what you already serve to the major search and answer engines today, so llms.txt stays off the list.',
  'A rival agency spent a whole quarter creating and maintaining a large hand-written manifest most people now just call llms.txt with no measurable change in citations',
  'If your team were ever tempted to start creating a machine-readable summary file at the domain root known as llms.txt, the data says do not bother',
];

// And the filter must still bite — including on phrasings the fixture above
// does not use (verb inflections, tactic-named-first).
const MUST_DROP = [
  'Consider creating a file at /llms.txt; it takes 5 minutes.',
  'An llms.txt file is worth adding for the engines.',
  'Add HowTo schema markup to the setup guide.',
  'Allow Google-Extended in robots.txt so Gemini can cite you.',
];

// ── The boundary of what this filter can do, written down as executable fact.
//
// These four ARE dead-tactic advice and the filter does NOT catch them. That is
// a decided trade (see KNOWN LIMITATION in dead-tactics.js), not a bug waiting
// to be fixed. Two causes, both load-bearing:
//
//   SENTENCE BOUNDARY — catching #1 and #2 means letting the verb→tactic gap
//   cross a full stop, which is exactly what produced the false positives in
//   MUST_SURVIVE, one of which told the client NOT to bother with the file.
//
//   LENGTH CAP — catching #3 and #4 means raising the 60-character cap in
//   `GAP`. That was tried at 140 and reverted: the last three MUST_SURVIVE
//   probes live in that range, carry no boundary character, and were all
//   falsely cut. The cap is what protects them, so it does not go up.
//
// In both cases the alternative error is worse: a miss leaves one extra card in
// a report whose own copy argues against the tactic, while a false cut silently
// deletes true text and reshuffles the top-10 that feeds a paid plan.
//
// The test below asserts these stay UNCAUGHT. If someone later widens the rule,
// it fails and forces the trade to be re-decided deliberately.
const KNOWN_MISSES = [
  // Verb in one sentence, tactic in the next.
  'We recommend adding a dedicated machine-readable file. This is commonly called llms.txt.',
  // Gap has to span a filename containing a dot.
  'Allow the crawlers you are currently disallowing in your robots.txt file, starting with GPTBot, so more AI systems can read the site.',
  // One clause, no boundary character, but verb and tactic ~100 characters apart.
  'Add a short plain-text summary of your key product facts at the root of the domain, commonly referred to as llms.txt, so models can parse it fast.',
  // Same shape, ~77 characters.
  'Implement structured question-and-answer blocks on the pricing page using the standard FAQPage schema so Google can surface them.',
];

test('legitimate recommendations that merely MENTION a dead tactic survive', () => {
  for (const text of MUST_SURVIVE) {
    const rule = deadTacticRule(text);
    assert.equal(rule, null, `false positive [${rule && rule.id}] on: "${text}"`);
  }
  // …and through the real render path, not just the predicate.
  const kept = filterDeadTactics(MUST_SURVIVE.map((detail, i) => ({ title: `Action ${i}`, detail }))).kept;
  assert.equal(kept.length, MUST_SURVIVE.length);
});

test('advice phrasings the fixture does not cover are still dropped', () => {
  for (const text of MUST_DROP) {
    assert.notEqual(deadTacticRule(text), null, `missed dead-tactic advice: "${text}"`);
  }
});

test('KNOWN MISSES — the filter’s documented blind spots stay blind on purpose', () => {
  for (const text of KNOWN_MISSES) {
    const rule = deadTacticRule(text);
    assert.equal(
      rule, null,
      `This probe is now CAUGHT [${rule && rule.id}]: "${text}"\n`
      + 'That may be an improvement — but it means the verb/tactic gap now crosses a\n'
      + 'sentence or a dotted filename, which is the axis that produced the false\n'
      + 'positives in MUST_SURVIVE. Re-run MUST_SURVIVE, decide the trade on purpose,\n'
      + 'and update both this list and the KNOWN LIMITATION note in dead-tactics.js.',
    );
  }
  // The blind spots must stay NARROW: the same advice phrased inside one
  // sentence is still caught, so this is a parser limit, not an escape hatch.
  assert.notEqual(deadTacticRule('We recommend adding a dedicated machine-readable file called llms.txt.'), null);
  assert.notEqual(deadTacticRule('Allow GPTBot so more AI systems can read the site.'), null);
});

test('a dropped recommendation is reported, not silently swallowed', () => {
  const { kept, dropped } = filterDeadTactics(DEAD_TACTIC_ACTIONS);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 3);
  for (const d of dropped) {
    assert.ok(d.ruleId && d.reason, 'each drop must carry its rule id and reason');
    assert.ok(d.action.title, 'each drop must carry the action it removed');
  }

  // …and the render path must SAY so, so an operator learns about a drop
  // without reading the source. Capture stderr around a real render.
  const lines = [];
  const realError = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    withoutDeadTactics(DEAD_TACTIC_ACTIONS, 'report HTML');
  } finally {
    console.error = realError;
  }
  assert.equal(lines.length, 3, 'every drop must produce one operator-visible line');
  assert.ok(lines.every(l => /dropped a recommendation from the report HTML/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => l.includes('Publish an llms.txt file') && l.includes('[llms-txt]')),
    'the line must name the action it removed and the rule that removed it');
});

// ─── 4. The bot tiers the advice now depends on ───

test('only search-index crawlers are marked as citation-gating', () => {
  assert.deepEqual([...CITATION_GATING_BOTS].sort(), ['OAI-SearchBot', 'PerplexityBot']);
  const training = AI_BOTS.filter(b => b.tier === 'training').map(b => b.name);
  for (const name of ['GPTBot', 'Google-Extended', 'ClaudeBot', 'CCBot', 'Bytespider']) {
    assert.ok(training.includes(name), `${name} must be tiered as training-only, not citation-gating`);
  }
  // Every bot carries a tier — an untiered bot would silently default to
  // "informational" and could hide a real block.
  for (const b of AI_BOTS) assert.ok(typeof b.tier === 'string' && b.tier.length > 0, `${b.name} has no tier`);
});

test('LEGACY SNAPSHOTS — botAccess rows written before tiers still resolve correctly', () => {
  // Every `_summary.json` on disk before 2026-08-02 carries botAccess entries
  // with no `tier` field. `botTier` must fall back to the roster by name,
  // otherwise a real OAI-SearchBot block would be reported as harmless on any
  // report regenerated from an older run.
  const legacyGating = { name: 'OAI-SearchBot', label: 'OAI-SearchBot', provider: 'ChatGPT', access: 'blocked' };
  const legacyTraining = { name: 'GPTBot', label: 'GPTBot', provider: 'ChatGPT', access: 'blocked' };
  assert.equal(botTier(legacyGating), 'search');
  assert.equal(gatesCitations(legacyGating), true);
  assert.equal(botTier(legacyTraining), 'training');
  assert.equal(gatesCitations(legacyTraining), false);
  // Matched by label too (some rows carry only the display name), and a bot we
  // no longer track fails CLOSED to "not gating" rather than throwing.
  assert.equal(botTier({ label: 'CCBot (CommonCrawl)' }), 'training');
  assert.equal(gatesCitations({ name: 'SomeFutureBot' }), false);

  // End to end: a legacy-shaped audit still produces the loud warning for the
  // gating block and the calm one for the training block.
  const legacySnapshot = {
    ...snapshot,
    crawlability: {
      ...crawlability,
      summary: { ...crawlability.summary, blockedCount: 2 },
      botAccess: [legacyGating, legacyTraining, { name: 'PerplexityBot', label: 'PerplexityBot', provider: 'Perplexity', access: 'allowed' }],
    },
  };
  const out = sectionCrawlability([legacySnapshot]);
  assert.ok(/search-index crawler.{0,40}blocked/is.test(out), 'legacy OAI-SearchBot block must still raise the loud warning');
  assert.ok(/other AI crawler/i.test(out), 'legacy GPTBot block must be reported as the informational tier');
});
