/**
 * AI-bot crawlability audit for the user's domain.
 *
 * Fetches robots.txt, /llms.txt, and /sitemap.xml from the brand's own domain
 * and reports which AI crawlers are allowed, which are blocked, and which AEO
 * discovery files are present. Pure HTTP — no LLM calls, no auth, ~3 requests.
 *
 * The "your brand isn't visible in Claude" problem is sometimes a writing problem
 * but VERY often a robots.txt problem (`Disallow: / for ClaudeBot`). This module
 * surfaces that root cause before the user spends $$$ on content production.
 *
 * Run-once-per-report. Cached in `_summary.json::crawlability` so re-running
 * `aeo-tracker report` does not re-fetch.
 */

// Bots tracked. Each entry: { name (matches User-agent header in robots.txt),
// label (display), provider (which AI engine it feeds), docs (link),
// tier (what a BLOCK on this bot actually costs — see BOT_TIER below) }
//
// AP-BOT-TIER (2026-08-02). "N bots blocked" was reported as one undifferentiated
// number and the copy said blocked engines "cannot cite you" — false for most of
// this list. Each vendor splits its crawlers into a SEARCH-INDEX bot (blocking it
// removes you from that engine's answers), a TRAINING bot (blocking it changes
// nothing about today's citations) and a USER-TRIGGERED fetcher (which generally
// does not honour robots.txt at all, so a Disallow there buys nothing). Sources,
// all first-party and verified 2026-08-01/02 in
// webappski-ops/resources/aeo/bp-refresh/2026-08-01.md:
//   - developers.openai.com/api/docs/bots — «Sites that are opted out of
//     OAI-SearchBot will not be shown in ChatGPT search answers»; GPTBot is
//     training-only; ChatGPT-User is user-initiated so «robots.txt rules may
//     not apply».
//   - docs.perplexity.ai/guides/bots — PerplexityBot «designed to surface and
//     link websites in search results on Perplexity», respects robots.txt and is
//     explicitly NOT used for model training; Perplexity-User is user-initiated.
//   - developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers
//     + .../robots-meta-tag — Google-Extended «does not impact a site's inclusion
//     in Google Search nor is it used as a ranking signal»; GoogleOther «doesn't
//     affect any specific product». The lever for AI Overviews / AI Mode is
//     Googlebot + robots.txt/noindex/nosnippet, NOT Google-Extended.
//   - support.claude.com/en/articles/8896518 — ClaudeBot is training; the bots
//     that cost visibility are Claude-SearchBot and Claude-User.
//
// KNOWN GAP (deliberate, not an oversight): `Claude-SearchBot` and `Googlebot`
// are the two citation-gating crawlers we do NOT yet probe. Adding them here
// would change the bot-axis denominator (12 → 14) and could LOWER the crawl-
// readiness score of a site that wildcard-blocks and allowlists specific bots —
// which the 2026-08-02 score change is explicitly not allowed to do. Add them in
// a release that is permitted to move scores, and say so in the changelog.
export const AI_BOTS = [
  { name: 'GPTBot',           label: 'GPTBot',           provider: 'ChatGPT',     tier: 'training', docs: 'https://developers.openai.com/api/docs/bots' },
  { name: 'OAI-SearchBot',    label: 'OAI-SearchBot',    provider: 'ChatGPT',     tier: 'search',   docs: 'https://developers.openai.com/api/docs/bots' },
  { name: 'ChatGPT-User',     label: 'ChatGPT-User',     provider: 'ChatGPT',     tier: 'user',     docs: 'https://developers.openai.com/api/docs/bots' },
  { name: 'Google-Extended',  label: 'Google-Extended',  provider: 'Gemini',      tier: 'training', docs: 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers' },
  { name: 'GoogleOther',      label: 'GoogleOther',      provider: 'Gemini',      tier: 'other',    docs: 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers' },
  { name: 'ClaudeBot',        label: 'ClaudeBot',        provider: 'Claude',      tier: 'training', docs: 'https://support.claude.com/en/articles/8896518' },
  { name: 'Claude-Web',       label: 'Claude-Web',       provider: 'Claude',      tier: 'legacy',   docs: 'https://support.claude.com/en/articles/8896518' },
  { name: 'anthropic-ai',     label: 'anthropic-ai',     provider: 'Claude',      tier: 'legacy',   docs: 'https://support.claude.com/en/articles/8896518' },
  { name: 'PerplexityBot',    label: 'PerplexityBot',    provider: 'Perplexity',  tier: 'search',   docs: 'https://docs.perplexity.ai/guides/bots' },
  { name: 'Perplexity-User',  label: 'Perplexity-User',  provider: 'Perplexity',  tier: 'user',     docs: 'https://docs.perplexity.ai/guides/bots' },
  { name: 'CCBot',            label: 'CCBot (CommonCrawl)', provider: 'training-data', tier: 'training', docs: 'https://commoncrawl.org/ccbot' },
  { name: 'Bytespider',       label: 'Bytespider',       provider: 'ByteDance/TikTok', tier: 'training', docs: 'https://bytespider.bytedance.com' },
];

/** Tier → what a robots.txt block on that bot actually costs the client. */
export const BOT_TIER = {
  search:   'blocking it removes you from that engine’s answers',
  training: 'training-corpus only — no measured effect on today’s citations',
  user:     'user-triggered fetch — generally ignores robots.txt anyway',
  other:    'not tied to any one product — no citation effect',
  legacy:   'legacy/undocumented user-agent — no citation effect',
};

/** Bots whose block genuinely costs citations, from the roster above. */
export const CITATION_GATING_BOTS = new Set(
  AI_BOTS.filter(b => b.tier === 'search').map(b => b.name),
);

/**
 * Tier for a bot record, tolerant of LEGACY SNAPSHOTS: `botAccess[]` entries
 * persisted in `_summary.json` before tiers existed carry no `tier` field, so
 * fall back to the roster by name (and to 'other' for a bot we no longer track).
 * @param {{name?:string, label?:string, tier?:string}} bot
 */
export function botTier(bot) {
  if (bot && typeof bot.tier === 'string') return bot.tier;
  const name = (bot?.name || bot?.label || '').toLowerCase();
  const known = AI_BOTS.find(b => b.name.toLowerCase() === name || b.label.toLowerCase() === name);
  return known ? known.tier : 'other';
}

/** Does a block on this bot cost citations? Legacy-snapshot tolerant. */
export function gatesCitations(bot) {
  return botTier(bot) === 'search';
}

import { fetchWithTimeout as universalFetchWithTimeout } from '../util/fetch-with-timeout.js';

const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, ...fetchInit } = opts;
  return universalFetchWithTimeout(url, { ...fetchInit, redirect: 'follow' }, {
    timeoutMs: timeoutMs || FETCH_TIMEOUT_MS,
    kind: 'site',
  });
}

/**
 * Parse robots.txt into per-user-agent rule blocks.
 * Returns { groups: [{ userAgents: [...], allow: [...], disallow: [...] }] }.
 *
 * Spec quirks handled:
 *   - Multiple consecutive `User-agent:` lines share the same rule block
 *   - Comments (`#`) are stripped
 *   - Case-insensitive matching of directive names
 *   - Empty Disallow ("Disallow:") = allow everything
 */
export function parseRobotsTxt(text) {
  if (!text || typeof text !== 'string') return { groups: [], sitemaps: [] };

  const lines = text.split(/\r?\n/);
  const groups = [];
  const sitemaps = [];

  let current = null;
  let lastWasUserAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim();
    if (!line) {
      lastWasUserAgent = false;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      if (!lastWasUserAgent || !current) {
        current = { userAgents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
      lastWasUserAgent = true;
    } else if (directive === 'allow' && current) {
      current.allow.push(value);
      lastWasUserAgent = false;
    } else if (directive === 'disallow' && current) {
      current.disallow.push(value);
      lastWasUserAgent = false;
    } else if (directive === 'sitemap') {
      sitemaps.push(value);
      lastWasUserAgent = false;
    } else {
      lastWasUserAgent = false;
    }
  }

  return { groups, sitemaps };
}

/**
 * Determine whether a given AI bot is allowed to crawl the root path.
 *
 * Returns one of:
 *   - 'allowed'    — explicit User-agent block exists, root not disallowed
 *   - 'blocked'    — explicit `Disallow: /` for this bot (or `*` covering it)
 *   - 'partial'    — disallows specific paths but root is OK
 *   - 'unspecified' — no rule at all; default-allow, but worth flagging
 *
 * Spec: User-agent matching is case-insensitive substring on bot name.
 */
export function checkBotAccess(parsed, botName) {
  if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    return 'unspecified';
  }
  const lowerBot = botName.toLowerCase();

  let matched = null;
  let wildcard = null;

  for (const group of parsed.groups) {
    for (const ua of group.userAgents) {
      const lowerUa = ua.toLowerCase().trim();
      if (lowerUa === '*') {
        wildcard = group;
      } else if (lowerUa === lowerBot || lowerUa.includes(lowerBot)) {
        matched = group;
      }
    }
  }

  const evaluate = (group) => {
    if (!group) return null;
    // Per robots.txt spec, an empty Disallow value means "no restriction"
    // and should not count as a real disallow rule.
    const realDisallows = group.disallow.filter(d => d !== '');
    if (realDisallows.includes('/')) return 'blocked';
    if (realDisallows.length === 0) return 'allowed';
    return 'partial';
  };

  return evaluate(matched) || evaluate(wildcard) || 'unspecified';
}

/**
 * Run the full crawlability audit on a domain. Returns an object that gets
 * stored verbatim in `_summary.json::crawlability` and rendered by the section.
 */
export async function auditCrawlability(domain, { fetchImpl = fetchWithTimeout } = {}) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('auditCrawlability: domain required');
  }
  const cleanDomain = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const baseUrl = `https://${cleanDomain}`;

  // robots.txt
  let robotsResult = { url: `${baseUrl}/robots.txt`, found: false, status: null, parsed: null, error: null };
  try {
    const res = await fetchImpl(robotsResult.url);
    robotsResult.status = res.status;
    if (res.ok) {
      const text = await res.text();
      robotsResult.found = true;
      robotsResult.parsed = parseRobotsTxt(text);
      robotsResult.bytes = text.length;
    }
  } catch (err) {
    robotsResult.error = err.message || String(err);
  }

  // /llms.txt — measured as a FACT, never scored and never recommended.
  // Google: «For Google Search, llms.txt isn't needed for AI Overviews, AI Mode,
  // or other generative AI Search features» (changelog 2026-06-15); a ~300k-domain
  // study across ~300k domains, reported by lumentir.com, found no relationship
  // between having the file and how often a domain is cited. No provider has
  // confirmed support.
  // We keep the probe because clients ask and because "is it there?" is cheap and
  // true — the fix on 2026-08-02 was to stop DRAWING A CONCLUSION from it.
  let llmsResult = { url: `${baseUrl}/llms.txt`, found: false, status: null, error: null };
  try {
    const res = await fetchImpl(llmsResult.url);
    llmsResult.status = res.status;
    llmsResult.found = res.ok;
    if (res.ok) llmsResult.bytes = (await res.text()).length;
  } catch (err) {
    llmsResult.error = err.message || String(err);
  }

  // sitemap.xml — fall back to robots.txt-declared sitemap if direct fetch 404s
  let sitemapResult = { url: `${baseUrl}/sitemap.xml`, found: false, status: null, error: null, urlCount: 0 };
  try {
    const res = await fetchImpl(sitemapResult.url);
    sitemapResult.status = res.status;
    if (res.ok) {
      const text = await res.text();
      sitemapResult.found = true;
      sitemapResult.urlCount = (text.match(/<loc>/g) || []).length;
    }
  } catch (err) {
    sitemapResult.error = err.message || String(err);
  }

  if (!sitemapResult.found && robotsResult.parsed?.sitemaps?.length > 0) {
    sitemapResult.declaredInRobots = robotsResult.parsed.sitemaps;
  }

  // Per-bot verdicts
  const botAccess = AI_BOTS.map(bot => ({
    ...bot,
    access: checkBotAccess(robotsResult.parsed, bot.name),
  }));

  const blocked = botAccess.filter(b => b.access === 'blocked');
  const allowed = botAccess.filter(b => b.access === 'allowed');
  const partial = botAccess.filter(b => b.access === 'partial');
  const unspecified = botAccess.filter(b => b.access === 'unspecified');
  // Citation-gating subset — the only blocks that actually cost answers
  // (AP-BOT-TIER). Reported ALONGSIDE the undifferentiated counts, which stay
  // exactly as they were so no consumer or score reading changes.
  const gating = botAccess.filter(b => gatesCitations(b));
  const gatingBlocked = gating.filter(b => b.access === 'blocked');

  return {
    domain: cleanDomain,
    ranAt: new Date().toISOString(),
    robots: robotsResult,
    llmsTxt: llmsResult,
    sitemap: sitemapResult,
    botAccess,
    summary: {
      totalBots: AI_BOTS.length,
      blockedCount: blocked.length,
      allowedCount: allowed.length,
      partialCount: partial.length,
      unspecifiedCount: unspecified.length,
      gatingTotal: gating.length,
      gatingBlockedCount: gatingBlocked.length,
      hasRobots: robotsResult.found,
      hasLlmsTxt: llmsResult.found,
      hasSitemap: sitemapResult.found,
    },
  };
}
