/**
 * Entity-graph verification — checks that the brand's cross-platform
 * `sameAs` chain actually reciprocates.
 *
 * Step 1: Read brand homepage, extract all URLs from Schema.org `sameAs`
 *         arrays inside `<script type="application/ld+json">` blocks
 *         (Organization, Person, ProfessionalService).
 * Step 2: For each external URL in `sameAs`, fetch that platform page and
 *         check if it links back to the brand domain.
 * Step 3: Classify each edge:
 *           - 'reciprocates'   — both directions exist (strongest entity-graph signal)
 *           - 'one-way'        — brand → platform exists, platform → brand missing
 *           - 'unreachable'    — fetch failed (404, timeout, blocked)
 *           - 'verified-host'  — platform doesn't expose user-controlled HTML (e.g. LinkedIn
 *             requires login; npm shows package metadata in HTML, hard to verify back-link)
 *
 * Why this matters: Google KG + Perplexity entity resolution require
 * BIDIRECTIONAL `sameAs` to confirm identity. A one-way chain (we claim X is
 * us, but X doesn't confirm) is treated as unverified by AI engines.
 *
 * v1 limit: only verifies external URLs already declared in own homepage's
 * `sameAs`. Doesn't suggest missing platforms — that's plan generator's job.
 */

const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'aeo-platform (https://github.com/webappski/aeo-platform)';
const HTML_FETCH_BYTES_CAP = 1.5 * 1024 * 1024;

// Platforms with known auth-walls or bot-blockers — we mark these as
// 'verified-host' (presence in our sameAs is the signal; reverse-link check
// would require a logged-in browser session we don't have).
const AUTH_WALL_HOSTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'medium.com', // requires Membership for some pages
]);

import { fetchWithTimeout as universalFetchWithTimeout } from '../util/fetch-with-timeout.js';

async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs, ...fetchInit } = opts;
  return universalFetchWithTimeout(url, {
    ...fetchInit,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*', ...(opts.headers || {}) },
  }, { timeoutMs: timeoutMs || FETCH_TIMEOUT_MS, kind: 'site' });
}

/**
 * Extract sameAs URLs from all JSON-LD blocks in the HTML. Returns a flat,
 * deduplicated array of strings.
 *
 * Handles: Organization, Person, ProfessionalService, Corporation, plus
 * @graph-nested variants. Also handles `@type` as array.
 */
export function extractSameAs(html) {
  const result = new Set();
  if (!html || typeof html !== 'string') return [];

  const blockRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }

    const items = Array.isArray(parsed) ? parsed
      : (Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed]);

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const sa = item.sameAs;
      if (!sa) continue;
      const arr = Array.isArray(sa) ? sa : [sa];
      for (const url of arr) {
        if (typeof url === 'string' && /^https?:\/\//.test(url)) {
          result.add(url);
        }
      }
    }
  }

  return Array.from(result);
}

/**
 * Categorise a sameAs URL by platform. Returns a stable platform name used in
 * the output for grouping. Unknown hosts return the bare domain.
 */
export function categorizePlatform(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return 'unknown'; }

  if (host.endsWith('linkedin.com')) return 'linkedin';
  if (host.endsWith('github.com')) return 'github';
  if (host.endsWith('npmjs.com') || host.endsWith('npmjs.org')) return 'npm';
  if (host.endsWith('producthunt.com')) return 'producthunt';
  if (host.endsWith('crunchbase.com')) return 'crunchbase';
  if (host.endsWith('alternativeto.net')) return 'alternativeto';
  if (host.endsWith('saashub.com')) return 'saashub';
  if (host.endsWith('g2.com')) return 'g2';
  if (host.endsWith('capterra.com')) return 'capterra';
  if (host.endsWith('wikidata.org') || host.endsWith('wikipedia.org')) return 'wikidata';
  if (host.endsWith('twitter.com') || host.endsWith('x.com')) return 'x';
  if (host.endsWith('facebook.com')) return 'facebook';
  if (host.endsWith('youtube.com')) return 'youtube';
  if (host.endsWith('medium.com')) return 'medium';
  if (host.endsWith('dev.to')) return 'devto';
  if (host.endsWith('indiehackers.com')) return 'indiehackers';
  if (host.endsWith('hackernoon.com')) return 'hackernoon';
  if (host.endsWith('stackoverflow.com')) return 'stackoverflow';
  return host;
}

/**
 * Verify one sameAs edge: fetch the external URL and check if its HTML
 * contains a link back to the brand domain.
 *
 * Returns:
 *   {
 *     url, platform, host,
 *     status: 'reciprocates' | 'one-way' | 'unreachable' | 'verified-host' | 'broken-link',
 *     httpStatus, error,
 *     confidence: 'high' | 'med' | 'low',
 *   }
 */
export async function verifyEdge(sameAsUrl, brandDomain, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetchWithTimeout;
  let host;
  try { host = new URL(sameAsUrl).hostname.toLowerCase().replace(/^www\./, ''); }
  catch {
    return { url: sameAsUrl, platform: 'unknown', host: null, status: 'broken-link',
      httpStatus: null, error: 'invalid-url', confidence: 'high' };
  }

  const platform = categorizePlatform(sameAsUrl);

  // Auth-wall platforms — can't verify back-link without logged-in session.
  // Mark as 'verified-host' (we trust the sameAs declaration since the host
  // is identifiable; bidirectional verification is N/A here).
  if (AUTH_WALL_HOSTS.has(host)) {
    return { url: sameAsUrl, platform, host, status: 'verified-host',
      httpStatus: null, error: null, confidence: 'med' };
  }

  let res;
  try {
    res = await fetchImpl(sameAsUrl);
  } catch (err) {
    return { url: sameAsUrl, platform, host, status: 'unreachable',
      httpStatus: null, error: err.message || String(err), confidence: 'high' };
  }
  if (!res.ok) {
    return { url: sameAsUrl, platform, host, status: 'unreachable',
      httpStatus: res.status, error: `HTTP ${res.status}`, confidence: 'high' };
  }

  let body;
  try {
    const raw = await res.text();
    body = raw.length > HTML_FETCH_BYTES_CAP ? raw.slice(0, HTML_FETCH_BYTES_CAP) : raw;
  } catch (err) {
    return { url: sameAsUrl, platform, host, status: 'unreachable',
      httpStatus: res.status, error: `body: ${err.message || String(err)}`, confidence: 'high' };
  }

  // Reciprocity check — does the platform page contain a link to brand domain?
  // Match `href="https://brandDomain"` or `href="//brandDomain"` or any URL
  // containing the bare domain in a context that looks like a link or text.
  const bareBrand = brandDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const reciprocates = bareBrand && (
    new RegExp(`href=["']https?://(?:www\\.)?${escapeRegExp(bareBrand)}(?:/|"|'|\\?)`, 'i').test(body)
    || new RegExp(`href=["']//(?:www\\.)?${escapeRegExp(bareBrand)}(?:/|"|'|\\?)`, 'i').test(body)
    || new RegExp(`>\\s*(?:https?://)?(?:www\\.)?${escapeRegExp(bareBrand)}\\s*<`, 'i').test(body)
  );

  return {
    url: sameAsUrl,
    platform,
    host,
    status: reciprocates ? 'reciprocates' : 'one-way',
    httpStatus: res.status,
    error: null,
    confidence: reciprocates ? 'high' : 'med',
  };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Top-level entry: fetch own homepage, extract sameAs, verify each edge in
 * parallel. Returns:
 *   {
 *     domain, ranAt, sameAsCount,
 *     edges: [...verifyEdge results],
 *     summary: {
 *       reciprocates: N, oneWay: N, unreachable: N, verifiedHost: N, brokenLink: N,
 *       reciprocityRate: 0-100,
 *     }
 *   }
 *
 * Operates ENTIRELY on data already fetched (homepage HTML passed in or
 * fetched fresh). Does not require an LLM.
 */
export async function checkEntityGraph(domain, opts = {}) {
  if (!domain || typeof domain !== 'string') {
    return { domain, ok: false, error: 'no domain' };
  }
  const fetchImpl = opts.fetchImpl || fetchWithTimeout;
  const scheme = opts.scheme || 'https';
  const path = opts.path || '/';
  const homeUrl = `${scheme}://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}${path}`;

  // Allow caller to pass pre-fetched HTML (e.g. reuse from page-signals run)
  let html = opts.homepageHtml;
  if (!html) {
    let res;
    try { res = await fetchImpl(homeUrl); }
    catch (err) {
      return { domain, ok: false, error: `home: ${err.message || String(err)}`, url: homeUrl };
    }
    if (!res.ok) {
      return { domain, ok: false, error: `home HTTP ${res.status}`, url: homeUrl };
    }
    try {
      const raw = await res.text();
      html = raw.length > HTML_FETCH_BYTES_CAP ? raw.slice(0, HTML_FETCH_BYTES_CAP) : raw;
    } catch (err) {
      return { domain, ok: false, error: `home body: ${err.message || String(err)}`, url: homeUrl };
    }
  }

  const sameAsUrls = extractSameAs(html);
  if (sameAsUrls.length === 0) {
    return {
      domain, ok: true, ranAt: new Date().toISOString(),
      sameAsCount: 0, edges: [],
      summary: { reciprocates: 0, oneWay: 0, unreachable: 0, verifiedHost: 0, brokenLink: 0, reciprocityRate: 0 },
    };
  }

  const edges = await Promise.all(sameAsUrls.map(u => verifyEdge(u, domain, { fetchImpl })));
  const summary = summariseEdges(edges);

  return {
    domain,
    ok: true,
    ranAt: new Date().toISOString(),
    sameAsCount: sameAsUrls.length,
    edges,
    summary,
  };
}

// Human-readable label + UI tone for a per-edge `status`. Single source of
// truth for every report renderer that displays entityGraph edges, so the
// 5 statuses verifyEdge can return (kebab-case strings, not the camelCase
// keys summariseEdges uses for its aggregate counts) never collapse into an
// unlabelled default.
export function describeEdgeStatus(status) {
  switch (status) {
    case 'reciprocates': return { label: 'Reciprocates', tone: 'good' };
    case 'verified-host': return { label: 'Verified host', tone: 'good' };
    case 'one-way': return { label: 'One-way', tone: 'warn' };
    case 'unreachable': return { label: 'Unreachable', tone: 'bad' };
    case 'broken-link': return { label: 'Broken link', tone: 'bad' };
    default: return { label: 'Not verified', tone: 'warn' };
  }
}

function summariseEdges(edges) {
  const s = { reciprocates: 0, oneWay: 0, unreachable: 0, verifiedHost: 0, brokenLink: 0, reciprocityRate: 0 };
  for (const e of edges) {
    if (e.status === 'reciprocates') s.reciprocates++;
    else if (e.status === 'one-way') s.oneWay++;
    else if (e.status === 'unreachable') s.unreachable++;
    else if (e.status === 'verified-host') s.verifiedHost++;
    else if (e.status === 'broken-link') s.brokenLink++;
  }
  // Reciprocity rate considers reciprocates + verified-host as positive
  // (verified-host is best we can do for auth-walled platforms)
  const positive = s.reciprocates + s.verifiedHost;
  s.reciprocityRate = edges.length === 0 ? 0 : Math.round((positive / edges.length) * 100);
  return s;
}
