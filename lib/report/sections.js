import { heatmap, barchart, sparkline, deltaArrow, radar, combinedRadar } from '../svg/index.js';
import { extractQuotes } from './extract-quotes.js';
import { sentimentToScore } from './sentiment-classify.js';
import { aggregateByCategory } from './domain-category.js';
import { computeComponents, computeUVI, computeUVIBreakdown, computeDiscoverability } from './visibility-index.js';
import { buildRunComparison } from './run-comparison.js';
import {
  buildRunMetrics, headlineMover, buildVerdictHeadline, buildLiftOpportunity,
  buildLiftNarrative,
} from './run-metrics.js';
import { trendCapabilities, coverageAllowsDelta, SHAPES_MIN_RUNS } from './trend-model.js';
import { buildAnswerHistory, headlineCell } from './answer-history.js';
import { KIND_CONDITIONAL } from './comparison-drivers.js';
import { clusterQueries } from './topic-cluster.js';
import { aggregateUtmCitations } from './utm-tracker.js';
import { isOwnDomain } from './own-domain.js';
import { botTier, gatesCitations, BOT_TIER } from './crawlability-audit.js';
import { deriveProductLines } from '../init/research/product-lines.js';
import { wilson } from '../stats.js';
import { sanitizeForFilename } from '../util/safe-filename.js';
import { domainStorageSlug } from '../util/domain-storage.js';

const PROVIDER_LABELS = {
  openai: 'ChatGPT',
  gemini: 'Gemini',
  anthropic: 'Claude',
  perplexity: 'Perplexity',
};

export function providerLabel(p) {
  return PROVIDER_LABELS[p] || p;
}

/**
 * Escape HTML-significant characters in user/LLM/3rd-party strings before they
 * are interpolated into markdown sections that may be piped through mdToHtml.
 * mdToHtml deliberately passes raw `<` through (so sections can embed inline
 * <span>, <details>, inline SVG), so any unescaped attacker-controlled string
 * would XSS. CODING_STANDARDS.md mandates escaping user data in HTML.
 *
 * Use for: brand, queryText, competitor names, sentiment.rationale, outreach
 * template fields, Wikipedia/Reddit content. Do NOT use for hostnames already
 * derived from new URL().hostname (those are URL-spec-clean).
 */
export function escMd(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Truncate URL keeping hostname visible; drop `https://` prefix because the
 * SVG label column is ~180px wide — the scheme eats budget without adding info.
 * Result like "aeodirectory.com/aeo/det…" fits and stays parseable.
 */
function shortenUrlKeepHost(u, maxLen = 30) {
  if (!u) return u;
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '');
    const tail = url.pathname === '/' ? '' : (url.pathname + url.search);
    const combined = host + tail;
    if (combined.length <= maxLen) return combined;
    if (host.length >= maxLen - 2) return host.slice(0, maxLen - 1) + '…';
    const budget = maxLen - host.length - 1; // reserve 1 char for ellipsis
    return host + tail.slice(0, budget) + '…';
  } catch {
    // Malformed URL (no protocol, invalid host, etc.) — gracefully degrade
    // to a raw-string truncation. Display path only; we never use the
    // unparsed value for routing. Logging would be noise — these come from
    // LLM-extracted citations and a few per run are expected.
    return u.length > maxLen ? u.slice(0, maxLen - 1) + '…' : u;
  }
}

/** Per-provider hit ratio. Returns { hits, total, rate }. */
function providerStats(results, provider) {
  const rs = results.filter(r => r.provider === provider && r.mention !== 'error');
  const hits = rs.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  return { hits, total: rs.length, rate: rs.length > 0 ? hits / rs.length : 0 };
}

// ─── Section: Header (with corner score badge — P9) ───

/**
 * Map score to traffic-light status: color + emoji + label + actionable verb.
 */
export function trafficLight(score) {
  if (typeof score !== 'number') return { emoji: '⚪', color: '#94a3b8', label: 'NO DATA', verb: 'run first audit' };
  if (score === 0)   return { emoji: '🔴', color: '#ef4444', label: 'INVISIBLE', verb: 'establish presence' };
  if (score < 25)    return { emoji: '🟠', color: '#f97316', label: 'EMERGING',  verb: 'broaden coverage' };
  if (score < 60)    return { emoji: '🟡', color: '#eab308', label: 'PRESENT',   verb: 'deepen authority' };
  return { emoji: '🟢', color: '#10b981', label: 'STRONG',    verb: 'defend position' };
}

export function sectionHeader(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const first = snapshots[0];
  const generated = new Date().toISOString().slice(0, 10);
  const period = snapshots.length > 1
    ? `${first.date} → ${latest.date} (${snapshots.length} runs)`
    : `${latest.date} (first run)`;
  const tl = trafficLight(latest.score);

  return `# ${tl.emoji} ${latest.score}% · AEO Report — ${escMd(latest.brand)}

${escMd(latest.domain)} · ${period} · generated ${generated}${latest.generatedBy ? ` · ${escMd(latest.generatedBy)}` : ''}
`;
}

// ─── Section: Hero card (P1) — scanner-friendly headline ───

/**
 * The single most important block in the report. Appears above Summary and
 * all tables. Uses emoji traffic light + big score + plain-English subtext +
 * inline "what to do this week" hook.
 *
 * Designed to convey {status, trend, action} in one scannable eye-fixation.
 */
export function sectionHero(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const tl = trafficLight(latest.score);

  const scoreDelta = prev ? latest.score - prev.score : null;
  const trendMarker = scoreDelta === null
    ? '▪ BASELINE'
    : scoreDelta > 0 ? `▲ +${scoreDelta}pp vs ${prev.date}`
    : scoreDelta < 0 ? `▼ ${scoreDelta}pp vs ${prev.date}`
    : '▪ no change';

  return `## ${tl.emoji} Your AEO visibility — ${tl.label}

# ${latest.score}%

${trendMarker} · **${latest.mentions} of ${latest.total} checks returned a mention**

> Focus this week: **${tl.verb}**. See actionable steps at the bottom of this report.
`;
}

// ─── Section: Comparison baseline (P10) — REMOVED in v0.3.2 ───
//
// Previously rendered «How your score compares» with three fabricated bands
// (0–15% / 20–45% / 60–85%) attributed to «Webappski's own weekly audits and
// client work» — no documented sample size, no list of brands, no methodology.
// That was an anchoring device, not measurement. The honest framing is: track
// yourself week-over-week. The hero already shows trend; this section added
// fake external comparison on top.
//
// Kept as a no-op export so `markdown.js`'s import list and section pipeline
// stay structurally identical (filtered out by the `s && s.trim()` step).

export function sectionBaseline(_snapshots) {
  return '';
}

// ─── Section: Executive Summary (plain-English abstract) ───

export function sectionExecutiveSummary(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const { mentions, total, brand } = latest;
  const providers = [...new Set(latest.results.map(r => r.provider))];
  const stats = providers.map(p => ({ p, ...providerStats(latest.results, p) }));
  const visible = stats.filter(s => s.hits > 0);
  const invisible = stats.filter(s => s.hits === 0);
  const strongest = [...visible].sort((a, b) => b.rate - a.rate)[0];

  let narrative;

  const safeBrand = escMd(brand);

  if (mentions === 0) {
    narrative =
      `**${safeBrand}** is **not mentioned** by any of the ${providers.length} AI engine${providers.length === 1 ? '' : 's'} tested. ` +
      `All ${total} checks returned zero mentions — AI engines cite other products in your category instead (see "Tracked Competitors" below).`;
    if (snapshots.length === 1) {
      narrative += `\n\nThis is common for new brands or brands without established AEO presence. It's your **baseline**, not a failure.`;
    }
  } else if (visible.length === providers.length) {
    narrative =
      `**${safeBrand}** is mentioned across **all ${providers.length} AI engines** tested (${mentions} of ${total} checks). ` +
      `You have broad AI visibility — the focus shifts to position improvements and competitor pressure (see sections below).`;
  } else {
    const visStr = visible.map(s => `${providerLabel(s.p)} (${s.hits}/${s.total})`).join(', ');
    const invStr = invisible.map(s => providerLabel(s.p)).join(', ');
    narrative =
      `**${safeBrand}** is visible on **${visStr}** but **invisible on ${invStr}** (${mentions} of ${total} checks). ` +
      `Your strongest channel is **${providerLabel(strongest.p)}** (${strongest.hits}/${strongest.total}). ` +
      `The gap between engines points to engine-specific differences in training data and web-search source pools.`;
  }

  return `## Summary — ${safeBrand}'s AI Visibility

${narrative}
`;
}

// ─── Section: Key Metrics — score cards (HTML, rendered by marked.js) ───

export function sectionKeyMetrics(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const tl = trafficLight(latest.score);
  const scoreDelta = prev ? latest.score - prev.score : null;
  const overallDelta = scoreDelta !== null
    ? (scoreDelta > 0 ? `▲ +${scoreDelta}pp` : scoreDelta < 0 ? `▼ ${scoreDelta}pp` : '▪ no change')
    : '▪ baseline';

  function card(label, value, sub, delta, color) {
    return `<div class="sc" style="border-top:4px solid ${color}"><div class="sc-lbl">${label}</div><div class="sc-val" style="color:${color}">${value}</div><div class="sc-sub">${sub}</div><div class="sc-delta">${delta}</div></div>`;
  }

  const cards = [card('Overall', `${latest.score}%`, tl.label, overallDelta, tl.color)];

  for (const p of providers) {
    const { hits, total, rate } = providerStats(latest.results, p);
    if (total === 0) continue;
    const pct = Math.round(rate * 100);
    const ptl = trafficLight(pct);
    // Per-provider delta. Only computed when prev measured this provider at
    // least once (ps.total > 0). When prev didn't include the provider at
    // all — config changed between runs — render «new this run», NOT a
    // fabricated −Npp delta. Mixed-method runs (api ↔ manual-paste between
    // runs) get an explicit «n/a (method changed)» so the reader doesn't
    // compare apples to oranges.
    let pDelta = '▪ baseline';
    if (prev) {
      const ps = providerStats(prev.results, p);
      if (ps.total === 0) {
        pDelta = '▪ new this run';
      } else {
        const prevSources = new Set(prev.results.filter(r => r.provider === p).map(r => r.source || 'api'));
        const currSources = new Set(latest.results.filter(r => r.provider === p).map(r => r.source || 'api'));
        const methodChanged = [...prevSources].some(s => !currSources.has(s))
          || [...currSources].some(s => !prevSources.has(s));
        const prevPct = Math.round(ps.rate * 100);
        const d = pct - prevPct;
        const arrow = d > 0 ? `▲ +${d}pp` : d < 0 ? `▼ ${d}pp` : '▪ no change';
        pDelta = methodChanged ? `${arrow} (method changed)` : arrow;
      }
    }
    cards.push(card(providerLabel(p), `${hits}/${total}`, `${pct}% hit rate`, pDelta, ptl.color));
  }

  return `## Key Metrics

<div class="score-cards">${cards.join('')}</div>
`;
}

// ─── Section: Engine Radar (P2) ───

/**
 * Per-engine hit-rate in a single radar visualisation. Reveals shape of
 * visibility: balanced (similar across engines), skewed (one engine dominates),
 * or zero (empty polygon).
 */
export function sectionEngineRadar(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];
  if (providers.length < 3) return ''; // Radar needs 3+ axes

  const axes = providers.map(p => {
    const s = providerStats(latest.results, p);
    return { label: providerLabel(p), value: Math.round(s.rate * 100) };
  });

  return `## Engine coverage at a glance

_Each axis is one AI engine; the further out the polygon stretches, the more queries the engine mentions your brand for. A tiny polygon or red-dotted axis means "invisible to that engine" — that's your gap._

${radar({ axes })}
`;
}

// ─── Section: AI × Query Matrix (with intro) ───

export function sectionMatrix(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const queries = [...new Set(latest.results.map(r => r.query))].sort();
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const rows = providers.map(providerLabel);
  const cells = providers.map(p => queries.map(q => {
    const r = latest.results.find(x => x.provider === p && x.query === q);
    return r ? r.mention : 'missing';
  }));

  return `## AI × Query Matrix — ${latest.date}

| | | |
|---|---|---|
| 🟢 **YES** | your brand appeared in the answer text | strong signal |
| 🟡 **SRC** | your brand was only in cited sources | weak signal |
| 🔴 **NO** | not mentioned anywhere | gap |
| ⬜ **—** | not tested / provider skipped | no data |

${heatmap({ rows, cols: queries, cells })}
`;
}

// ─── Section: Engine-specific actions (per-engine HTML cards) ───
//
// Each card is grounded in THIS run's actual citation data — the top 3
// domains that engine actually cited for the user's queries. The hardcoded
// playbook (G2 / Capterra / Product Hunt / dev.to / npm / etc.) was invented
// advice that often contradicted the data: a real run on typelessform.com
// showed ChatGPT citing competitor product pages, not review platforms. The
// generic playbook survives only as a FALLBACK for engines that earned zero
// citations this run, and is explicitly labelled as such.

const ENGINE_META = {
  openai:     { name: 'ChatGPT',    color: '#10a37f', icon: '🤖' },
  gemini:     { name: 'Gemini',     color: '#4285f4', icon: '✦' },
  anthropic:  { name: 'Claude',     color: '#d97757', icon: '◆' },
  perplexity: { name: 'Perplexity', color: '#5046e4', icon: '⊕' },
};

const ENGINE_FALLBACK_TIPS = {
  openai: {
    // OpenAI's own help page (help.openai.com/en/articles/9237897-chatgpt-search,
    // verified live 2026-08-01): «ChatGPT search partners with other search
    // providers», and it names Bing and Shopify. The previous copy here claimed
    // «Bing dependence ended Aug 2025» — a wrong fact about an engine, shipped
    // to clients, which also hid the cheapest real lever for a small site.
    why: 'ChatGPT search runs OpenAI’s own crawl (OAI-SearchBot) on top of partner search providers — OpenAI names Bing and Shopify — so being indexed in Bing is a genuine way in. Its citations spread thin across many domains rather than concentrating in a few.',
    tips: [
      'Check that your pages are indexed in Bing (Bing Webmaster Tools) — ChatGPT rewrites your query for partner providers, and OpenAI names Bing as one',
      'Get listed on G2, Capterra, or Product Hunt — ChatGPT cites review platforms heavily',
      'Answer questions on Reddit and Quora with your tool mentioned by name',
      'Publish a comparison post (Your Tool vs Alternatives) on your blog or Medium',
    ],
  },
  gemini: {
    // AP-DEAD-TACTIC-SCHEMA (2026-08-02): this card used to advise «add FAQ
    // schema markup». Google removed the FAQ rich result from Search results on
    // 2026-05-07 and deleted its documentation on 2026-06-15, and states
    // outright that «structured data isn't required for generative AI search,
    // and there's no special schema.org markup you need to add». The only
    // controlled measurement (Ahrefs, 1,885 pages that added JSON-LD vs ~4,000
    // controls, 2026-05-11) found no citation uplift on any platform and −4.6%
    // in AI Overviews. Existing markup is fine and we never tell anyone to
    // remove it — it is simply not a visibility lever, so we stop selling it as
    // one. The old «FastSearch» mechanism claim went with it: it has no
    // first-party source, while Google documents plainly that its AI answers
    // retrieve through core Search ranking.
    why: 'Google’s AI answers retrieve from the ordinary Search index and fan one question out into several parallel queries. Google states there are «no additional requirements to appear in AI Overviews or AI Mode» and no AI-specific markup to add — so ordinary indexation and a clear answer on the page are the entry ticket.',
    tips: [
      'Earn citations from high-DR sites Google already indexes for your keywords',
      'Keep the page indexed and snippet-eligible \u2014 `noindex` / `nosnippet` also removes it from AI Overviews and AI Mode',
      'Get featured in a roundup post on any high-authority tech blog or newsletter',
    ],
  },
  anthropic: {
    why: 'Claude leans on training data (web crawl + curated sources), with Brave the best-evidenced search backend (not officially confirmed). Developer ecosystems and product launch pages are over-represented in its training corpus.',
    tips: [
      'Publish on npm or create a GitHub repo \u2014 Claude\u2019s training data over-represents dev ecosystems',
      'Write a detailed post on dev.to or Medium: "How I built X with [Your Tool]"',
      'Launch on Product Hunt \u2014 PH pages are in Claude\u2019s training corpus',
    ],
  },
  perplexity: {
    why: 'Perplexity runs its own ~200B-URL index and ranks sub-document passages, with publish date as a first-class signal. Crawlability (PerplexityBot) and freshness matter more than domain authority.',
    tips: [
      'Publish fresh content weekly — Perplexity prioritises recency over domain authority',
      'Post answers on Reddit and Quora threads about your category (Perplexity indexes them in real time)',
      'Submit to niche directories and link aggregators in your vertical',
    ],
  },
};

/**
 * Return the top-N most-cited canonical hostnames for a given provider in
 * this run, filtering out the user's own domain (so we don't tell them
 * "get cited by yourself") AND the shared outreach deny-list (generic
 * developer-hosting tenants, dead tutorial sites) AND any hosts the citation
 * classifier flagged as off-category for the user's vertical. Hosts in
 * descending citation-count order; ties broken alphabetically for
 * determinism in tests.
 *
 * @param {Object[]} results  latest.results
 * @param {string} provider   provider key (openai / gemini / anthropic / perplexity)
 * @param {string} ownDomain  user's brand domain (lower-case, no protocol)
 * @param {number} limit      how many hosts to keep (default 3)
 * @param {Object} [opts]
 * @param {Set<string>} [opts.excludeHosts]  exact hostnames to drop (off-category
 *                                           verdicts from the citation classifier).
 *                                           Same hostname canonicalisation used here
 *                                           (lower-case, leading `www.` stripped).
 * @returns {string[]}        ordered list of hostnames
 */
export function topCitedHostsForProvider(results, provider, ownDomain, limit = 3, opts = {}) {
  const own = (ownDomain || '').toLowerCase().replace(/^www\./, '');
  const excludeHosts = opts.excludeHosts instanceof Set ? opts.excludeHosts : new Set();
  const counts = new Map();
  for (const r of (results || [])) {
    if (r.provider !== provider) continue;
    for (const url of (r.canonicalCitations || [])) {
      let host;
      try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
      catch { continue; }
      if (!host) continue;
      if (own && (host === own || host.endsWith(`.${own}`))) continue;
      // Same deny-list as sectionCanonicalSources. Without this filter the
      // per-engine «Pitch <host>» card recommends outreach to alice.github.io
      // / vercel.app tenant containers — the exact failure mode the
      // canonical-sources fix already removed. Keep the two surfaces aligned.
      if (isDenyListedOutreachHost(host)) continue;
      // Off-category verdicts from the citation classifier — pitching a host
      // the classifier already flagged «wrong vertical for your brand» is the
      // same mistake the disambiguation-warning section surfaces; do not
      // recommend pitching it from a sibling section.
      if (excludeHosts.has(host)) continue;
      counts.set(host, (counts.get(host) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([host]) => host);
}

/**
 * Minimum number of distinct cited hosts (after own-domain / deny-list /
 * off-category filters) required before the engine-actions card switches to
 * the data-driven path. With a single cited host, "pitch this domain — the
 * engine cited it" is dressed-up noise — the engine cited 1 page, which can
 * be anything. The clearly-labelled generic playbook fallback is more honest
 * at N=1 and stays consistent with the «no citations this run» messaging.
 */
export const ENGINE_ACTIONS_DATA_DRIVEN_MIN_HOSTS = 2;

export function sectionEngineActions(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];
  const stats = providers.map(p => ({ p, ...providerStats(latest.results, p) })).filter(s => s.total > 0);

  // Off-category exclude set from the citation classifier. When the classifier
  // flagged a host as wrong-vertical for the user's brand, recommending the
  // engine «pitch a mention there» contradicts the sibling disambiguation
  // warning. Empty set when no classification was run — falls through to the
  // own-domain + deny-list filters only.
  const offCategoryExclude = new Set(
    (latest.citationClassification?.offCategoryDomains || [])
      .map(d => String(d.hostname || '').toLowerCase().replace(/^www\./, ''))
      .filter(Boolean)
  );

  const cardsHtml = stats.map(s => {
    const meta = ENGINE_META[s.p];
    if (!meta) return '';
    const pct = Math.round(s.rate * 100);
    const tl = trafficLight(pct);
    const badge = `<span class="ea-badge" style="background:${tl.color}20;color:${tl.color}">${tl.label} ${pct}%</span>`;
    const urgent = s.hits === 0 ? ' ea-card--urgent' : '';

    const topHosts = topCitedHostsForProvider(
      latest.results, s.p, latest.domain, 3, { excludeHosts: offCategoryExclude }
    );
    let why;
    let tipsList;

    if (topHosts.length >= ENGINE_ACTIONS_DATA_DRIVEN_MIN_HOSTS) {
      // Data-driven path — actual citation data for this engine this run.
      // Requires ≥2 distinct hosts (after filters) before issuing «pitch
      // these» — a single host is too low-signal to ground advice on.
      const hostsHtml = topHosts.map(h => `<code>${escMd(h)}</code>`).join(', ');
      why = `${meta.name} cited ${hostsHtml} most for your queries this run. Earning a mention on these would lift coverage directly — they are already in ${meta.name}'s answer pool for your category.`;
      tipsList = topHosts.map(h =>
        `<li>Pitch <code>${escMd(h)}</code> — ${meta.name} already cited it for your queries; a mention there feeds straight into the answer pool.</li>`
      ).join('');
    } else {
      // Fallback — generic playbook, clearly labelled as not data-driven.
      // Fires when an engine had zero usable cited hosts this run (the «no
      // citations» case) AND when only 1 host survived filters (too low-
      // signal to be evidence-based advice).
      const fb = ENGINE_FALLBACK_TIPS[s.p];
      if (!fb) return '';
      const lowSignalNote = topHosts.length === 1
        ? `<strong>Only one usable cited host for ${meta.name} this run — too low-signal to ground advice on. Generic playbook for ${meta.name} below:</strong> `
        : `<strong>No citations from ${meta.name} this run — generic playbook for ${meta.name} below:</strong> `;
      why = `${lowSignalNote}${fb.why}`;
      tipsList = fb.tips.map(t => `<li>${t}</li>`).join('');
    }

    return `<div class="ea-card${urgent}" style="border-left:4px solid ${meta.color}"><div class="ea-header"><span class="ea-icon">${meta.icon}</span><span class="ea-name">${meta.name}</span>${badge}</div><p class="ea-why">${why}</p><ul class="ea-tips">${tipsList}</ul></div>`;
  }).filter(Boolean).join('');

  if (!cardsHtml) return '';

  return `## Engine-specific actions

_Each card is grounded in this run's actual citation data — the domains that engine pulled from for your queries. When an engine earned zero (or only one) usable citations, a generic playbook is shown instead and labelled as such._

<div class="engine-actions">${cardsHtml}</div>
`;
}

// ─── Section: Visibility Breakdown (per-engine plain-English) ───

export function sectionVisibilityBreakdown(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const rows = providers.map(p => {
    const { hits, total, rate } = providerStats(latest.results, p);
    let label, verdict;
    if (total === 0) {
      label = '❓'; verdict = 'not tested';
    } else if (rate >= 0.66) {
      label = '✅'; verdict = `strong (${hits}/${total})`;
    } else if (rate >= 0.34) {
      label = '⚠️'; verdict = `partial (${hits}/${total})`;
    } else if (rate > 0) {
      label = '⚠️'; verdict = `weak (${hits}/${total})`;
    } else {
      label = '❌'; verdict = `invisible (0/${total})`;
    }
    return `| ${label} | **${providerLabel(p)}** | ${verdict} |`;
  });

  return `## Where AI Engines Stand on Your Brand

| | Engine | Status |
|---|---|---|
${rows.join('\n')}

_Read this as the first "so what" of the report. **✅ Strong** = consistent citations; **⚠️ Partial/Weak** = visibility exists but inconsistent, likely fixable with targeted content; **❌ Invisible** = the engine has no reason to know about you yet — typically means you need citations on sources the engine trusts._
`;
}

// ─── Section: Verbatim Quotes ───

export function sectionVerbatimQuotes(snapshots, rawResponses) {
  const latest = snapshots[snapshots.length - 1];
  const blocks = [];

  for (const r of latest.results) {
    if (r.mention === 'no' || r.mention === 'error') continue;
    const key = `${r.query}|${r.provider}`;
    const raw = rawResponses?.[key];
    if (!raw) continue;

    const { snippets, citationOnly } = extractQuotes(raw, latest.brand, latest.domain, r.canonicalCitations || []);

    if (snippets.length > 0) {
      blocks.push(`**${providerLabel(r.provider)}, ${escMd(r.query)}:**\n> "${escMd(snippets[0])}"`);
    } else if (citationOnly) {
      blocks.push(`**${providerLabel(r.provider)}, ${escMd(r.query)} — citation only:**\n> Brand appears only as a source URL in the answer:\n> \`${escMd(citationOnly)}\``);
    }
    if (blocks.length >= 6) break;
  }

  if (blocks.length === 0) return '';
  return `## What AI Engines Actually Said

_The exact sentences AI engines generated that mention your brand. These are your current "AI snippets" — what a user actually reads when they ask about your category. Quote-worthy snippets make strong social content._

${blocks.join('\n\n')}
`;
}

// ─── Section: Diff ───

export function sectionDiff(snapshots) {
  if (snapshots.length < 2) {
    return `## What Changed

_This is your first run — there's nothing to compare yet. Trends (gained/lost mentions, competitor movement) become visible starting with your second weekly run._
`;
  }

  const prev = snapshots[snapshots.length - 2];
  const curr = snapshots[snapshots.length - 1];

  // Only emit a change row when BOTH runs measured this (provider, query).
  // A cell that's «missing → yes» (provider added between runs) or
  // «yes → missing» (provider removed) is NOT a real change — it's a
  // configuration difference and was producing fabricated regressions
  // («Perplexity Q1 was: yes → now: no» when Perplexity wasn't even in the
  // previous run). Mixed-method cells (api ↔ manual-paste) still produce a
  // row but are tagged so the reader can interpret with care.
  const changes = [];
  const isCovered = (r) => r && r.mention && r.mention !== 'error' && r.mention !== 'missing';

  for (const r of curr.results) {
    const pr = prev.results.find(p => p.query === r.query && p.provider === r.provider);
    if (!isCovered(pr) || !isCovered(r)) continue; // skip absent-in-one-side
    if (pr.mention !== r.mention) {
      const methodChanged = (pr.source || 'api') !== (r.source || 'api');
      changes.push({
        provider: r.provider, query: r.query,
        was: pr.mention, now: r.mention,
        note: methodChanged ? `mixed-method (${pr.source || 'api'} → ${r.source || 'api'})` : '',
      });
    }
  }

  if (changes.length === 0) {
    return `## What Changed (${prev.date} → ${curr.date})

_No cell changes between runs — stable visibility for this cycle. Cells covered by only one of the two runs (provider added/dropped, manual-paste introduced/removed) are excluded — those are configuration changes, not visibility movement._
`;
  }

  const rows = changes.map(ch => {
    const gained = (ch.was === 'no' || ch.was === 'missing') && (ch.now === 'yes' || ch.now === 'src');
    const lost = (ch.was === 'yes' || ch.was === 'src') && (ch.now === 'no' || ch.now === 'missing');
    const sign = gained ? 1 : lost ? -1 : 0;
    const noteCell = ch.note ? ` _${ch.note}_` : '';
    return `| ${deltaArrow({ value: sign })} | ${providerLabel(ch.provider)} | ${ch.query} | ${ch.was} | ${ch.now}${noteCell} |`;
  });

  return `## What Changed (${prev.date} → ${curr.date})

| Δ | Provider | Query | Was | Now |
|---|---|---|---|---|
${rows.join('\n')}

_Only cells covered by BOTH runs are listed. Cells added or removed by config changes between runs are excluded._
`;
}

// ─── Section: Run Comparison ───
//
// WHY THIS SECTION IS SEPARATE FROM sectionDiff
// sectionDiff answers «which cells flipped». A client acting on a report
// needs the next layer up: is the headline number's movement a REAL signal or
// an artefact of which answers happened to be measured (see comparison-
// drivers.js), who is occupying the ground that was lost, and where the brand
// has never held ground at all (never present != regression — see
// comparison-segments.js). buildRunComparison() (run-comparison.js) is the
// single source of truth for all of that; this section only formats it.
//
// TONE CONTRACT — this is a document a non-technical reader acts on:
//   - no internal vocabulary («cell», «extractor», «pipeline», «conditional»,
//     «compositional», sample basis, model names) reaches the rendered copy;
//   - the causal narrative leads, not a ranked list of four raw component
//     deltas (a flat ranking picked the WRONG lever on the real run that
//     motivated this feature — see comparison-drivers.js's file header);
//   - the weight-basis caveat, when it applies, is a plain sentence at the
//     BOTTOM, never a badge next to the headline number.
//
// Segment colour mapping follows 00-STATUS.md's token decision: lost -> --bad,
// held/gained -> --good, never-present -> --editor, via the existing
// `.cell-badge[data-tone]` component (sectionCompetitorIntelligence/
// sectionSentiment already use it) — no new inline styles or hex.

const RC_AXIS_LABEL = {
  presence: 'how often you’re mentioned',
  sentiment: 'how positively you’re described',
  rank: 'how prominently you’re placed',
  citation: 'how often your site is directly cited',
};

const rcBadge = (label, tone) => `<span class="cell-badge" data-tone="${tone}">${label}</span>`;

function rcHeadline(model) {
  const { prev, curr, delta } = model.uvi;
  const arrow = deltaArrow({ value: delta, size: 14 });
  const deltaText = delta > 0 ? `up ${delta} points` : delta < 0 ? `down ${Math.abs(delta)} points` : 'unchanged';
  // mdToHtml treats a line starting with `<` as a raw-HTML block and skips
  // inline processing (bold/italic) for the WHOLE line - so the arrow can't
  // lead the paragraph, or "**45**" renders as literal asterisks instead of
  // bold. Text first, icon last; processInline still passes the trailing raw
  // <svg> through untouched (it never escapes < / >).
  return `Your visibility index moved from **${prev}** to **${curr}** — **${deltaText}** ${arrow}`;
}

/**
 * The causal headline sentence — the reason this whole feature exists. Leads
 * with WHERE the brand appeared before falling back to a ranked list, because
 * a flat "biggest mover" ranking put tone at the top of a real report where
 * the true cause was one newly gained, neutrally-worded mention.
 */
/**
 * Name who dragged a conditional axis down when a gain is the whole story.
 * Pluralises off the ACTUAL number of distinct cells involved (not the number
 * of axes they touched) — a single new mention can drag both Sentiment and
 * Rank at once, and the copy must not read "mentions" (plural) for that.
 */
function rcGainDragSubject(flaggedComponents) {
  const drags = flaggedComponents.flatMap((c) => c.decomposition.gainDrag);
  const uniqueCells = new Map(drags.map((d) => [d.key, d]));
  if (uniqueCells.size === 1) {
    const only = [...uniqueCells.values()][0];
    return { subject: `A newly gained mention on ${escMd(only.label)}`, verb: 'entering it' };
  }
  return { subject: `${uniqueCells.size} newly gained mentions`, verb: 'entering' };
}

function rcDriverNarrative(model) {
  const { driverSummary, weightBasis, components } = model;
  if (weightBasis.changed) {
    return '_The two runs measured different things this time (see note below), so we can’t point to a single cause with confidence yet._';
  }
  if (driverSummary.allMovementIsCompositional) {
    const flagged = components.filter((c) => (c.decomposition?.gainDrag || []).length > 0);
    if (flagged.length > 0) {
      const names = flagged.map((c) => RC_AXIS_LABEL[c.key]).join(' and ');
      const { subject, verb } = rcGainDragSubject(flagged);
      return `This shift is about **where** you appeared, not about anything getting worse. ${subject} dragged ${names} down in the average simply by ${verb} — even though gaining ground is a win, not a loss.`;
    }
    return 'This is explained entirely by **where** you appeared this run compared to last time — not by any answer getting better or worse.';
  }
  if (driverSummary.hasGenuineConditionalChange) {
    const moved = components.filter(
      (c) => c.kind === KIND_CONDITIONAL && (c.decomposition?.likeForLike?.delta || 0) !== 0,
    );
    const parts = moved.map((c) => {
      const dir = c.decomposition.likeForLike.delta > 0 ? 'improved' : 'declined';
      return `${RC_AXIS_LABEL[c.key]} ${dir} among the answers you kept`;
    });
    return parts.length ? `${parts.join('; ')}.` : '';
  }
  return '';
}

function rcSegmentBadges(model) {
  const { counts } = model;
  return [
    rcBadge(`${counts.lost} lost`, 'bad'),
    rcBadge(`${counts.held} held`, 'good'),
    rcBadge(`${counts.gained} gained`, 'good'),
    rcBadge(`${counts.never} never held`, 'editor'),
  ].join(' ');
}

/**
 * "Newly gained" rollup, grouped by question so a mention that landed on
 * several engines for the SAME question reads as one item ("... on Gemini
 * and Claude"), not one repeated line per engine.
 */
function rcGainedLine(model) {
  const rows = model.segments.gained;
  if (rows.length === 0) return '';
  const byQuery = new Map();
  for (const e of rows) {
    if (!byQuery.has(e.queryText)) byQuery.set(e.queryText, []);
    byQuery.get(e.queryText).push(providerLabel(e.provider));
  }
  const items = [...byQuery.entries()]
    .map(([queryText, engines]) => `${escMd(queryText)} on ${joinWithAnd(engines)}`)
    .join('; ');
  return `_Newly gained: ${items}._`;
}

/** "a" / "a and b" / "a, b and c" — the small English list-join every rc* copy helper needs. */
function joinWithAnd(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function rcLostBlock(model) {
  const rows = model.segments.lost;
  if (rows.length === 0) return '';
  const lines = rows.map((entry) => {
    const who = entry.competitorShift.newEntrants.length
      ? entry.competitorShift.newEntrants.map(escMd).join(', ')
      : '_none named_';
    const flag = entry.isNoise ? ' _(too close to call — not enough samples to confirm)_' : '';
    return `| ${escMd(entry.queryText)} | ${providerLabel(entry.provider)} | ${who}${flag} |`;
  });
  return `**Where you lost ground:**

| Question | Engine | Who appeared instead |
|---|---|---|
${lines.join('\n')}
`;
}

function rcReplacementsLine(model) {
  if (model.replacements.length === 0) return '';
  const top = model.replacements.slice(0, 5).map((r) => `**${escMd(r.name)}** (${r.count})`).join(', ');
  return `_Most frequently filling the gap: ${top}._`;
}

function rcBlankQueriesBlock(model) {
  const blanks = model.blankQueries;
  if (blanks.length === 0) return '';
  const lines = blanks.map((b) => {
    const who = b.occupiedBy.length
      ? b.occupiedBy.slice(0, 4).map(escMd).join(', ')
      : '_no competitor named either_';
    return `- **${escMd(b.queryText)}** — you’ve never appeared here; currently answered with ${who}`;
  });
  return `**Ground you’ve never held:**

${lines.join('\n')}
`;
}

function rcWeightBasisCaveat(model) {
  if (!model.weightBasis.changed) return '';
  const names = model.weightBasis.axes.map((k) => RC_AXIS_LABEL[k]).join(' and ');
  return `_A note on this comparison: one of the two runs could measure ${names} and the other couldn’t, ` +
    `so that part of the index isn’t directly comparable between the two dates — everything else above is._`;
}

export function sectionRunComparison(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    return `## Run Comparison

_This is your first run — there's nothing to compare yet. A run-over-run comparison becomes available starting with your second run._
`;
  }
  const model = buildRunComparison(snapshots);
  if (!model) return '';

  // "Nothing changed hands" is the right signal for the calm message, not a
  // literal delta===0 check — a held cell's tone or rank can genuinely move
  // (or the weight basis can shift) while lost/gained both stay at zero, and
  // that IS worth reporting, not smoothing over. Only skip the full body when
  // no cell changed presence AND no held-cell axis moved for real AND the
  // measurement basis is unchanged between the two runs.
  const stable = model.counts.lost === 0 && model.counts.gained === 0
    && !model.driverSummary.hasGenuineConditionalChange
    && !model.weightBasis.changed;
  if (stable) {
    return `## Run Comparison (${model.prevDate} → ${model.currDate})

_No material change since the last run — visibility held steady across every tracked question and engine._
`;
  }

  const body = [
    rcHeadline(model),
    rcDriverNarrative(model),
    rcSegmentBadges(model),
    rcGainedLine(model),
    rcLostBlock(model),
    rcReplacementsLine(model),
    rcBlankQueriesBlock(model),
    rcWeightBasisCaveat(model),
  ].filter((part) => part && part.trim()).join('\n\n');

  return `## Run Comparison (${model.prevDate} → ${model.currDate})

${body}
`;
}


// ─── Section: Trend per Query ───

export function sectionTrend(snapshots) {
  // P8 — sparklines need enough runs to read as a trend, not as noise.
  // Below TREND_MIN_RUNS the chart is statistical theatre — show the
  // muted «available from week N» placeholder instead of fake confidence.
  if (!Array.isArray(snapshots) || snapshots.length < TREND_MIN_RUNS) {
    return trendNotYetPlaceholder(snapshots?.length || 0);
  }

  const queries = [...new Set(snapshots.flatMap(s => s.results.map(r => r.query)))].sort();
  const latest = snapshots[snapshots.length - 1];

  const lines = queries.map(q => {
    const values = snapshots.map(s => {
      const rs = s.results.filter(r => r.query === q && r.mention !== 'error');
      if (rs.length === 0) return null;
      const hits = rs.filter(r => r.mention === 'yes' || r.mention === 'src').length;
      return Math.round((hits / rs.length) * 100);
    });
    const sp = sparkline({ values });
    const qText = latest.results.find(r => r.query === q)?.queryText || q;
    return `- ${sp} **${escMd(q)}:** ${escMd(qText)}`;
  });

  return `## Trend per Query

_Each sparkline shows how often AI engines mentioned your brand for that query over the tracked period. Up = gaining visibility, flat = stable, down = losing ground._

${lines.join('\n')}
`;
}

// ─── Section: Tracked Competitors ───

export function sectionCompetitors(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  const tracked = latest.topCompetitors || [];
  if (tracked.length === 0) return '';

  // Build YOU row first (accent), then competitors, sorted desc
  const you = { label: `YOU (${escMd(latest.brand)})`, value: latest.mentions || 0, accent: true };
  const compItems = tracked.slice(0, 8).map(c => ({ label: escMd(c.name), value: c.count }));
  const items = [you, ...compItems];

  // White-label: keep the comparison barchart (pure statistic) but drop the
  // «invest your content/PR budget in closing the gap» advisory clause. Same
  // {whiteLabel} gating pattern as the citation sections.
  const sub = opts.whiteLabel
    ? `The brand's mention count vs each tracked competitor, counted across all checks this run.`
    : `Your brand's mention count vs each tracked competitor, counted across all checks this run. If a competitor dominates here, that's where AI-engine mindshare sits — invest your content/PR budget in closing the gap.`;

  return `## Competitors vs you

_${sub}_

${barchart({ items })}
`;
}

// ─── Section: Canonical Sources ───

/**
 * Heuristic URL-type classification. Returns short tag for display.
 */
function classifyUrlType(url) {
  const u = String(url).toLowerCase();
  // Malformed URL falls back to the lowercased raw string — classification
  // still pattern-matches against the same hostname-shaped substring.
  const h = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return u; } })();
  if (/g2\.com|capterra\.com|producthunt\.com|trustradius\.com|getapp\.com|trustpilot\.com|softwareadvice\.com/.test(h)) return 'review-platform';
  if (/reddit\.com|news\.ycombinator|quora\.com|stackoverflow\.com/.test(h)) return 'community';
  if (/wikipedia\.org/.test(h)) return 'encyclopedia';
  if (/linkedin\.com/.test(h)) return 'social';
  if (/youtube\.com|youtu\.be/.test(h)) return 'video';
  if (/github\.com/.test(h)) return 'code';
  if (/directory|catalog|listings?/.test(u)) return 'directory';
  if (/\/blog|\/posts?|\/articles?|medium\.com|substack\.com|dev\.to/.test(u)) return 'blog';
  if (/reuters\.|bloomberg\.|wired\.|techcrunch\.|forbes\./.test(h)) return 'news';
  if (/agency|consultancy|studio/.test(h)) return 'agency';
  return 'blog';
}

const TYPE_META = {
  'review-platform': { label: 'Review platform', action: 'Create or claim your listing' },
  'community':       { label: 'Community',        action: 'Engage in relevant threads' },
  'encyclopedia':    { label: 'Encyclopedia',     action: 'Add your tool to comparison pages' },
  'directory':       { label: 'Directory',        action: 'Submit your product' },
  'blog':            { label: 'Blog / agency',    action: 'Pitch a mention or guest post' },
  'agency':          { label: 'Agency',           action: 'Pitch a case study or mention' },
  'news':            { label: 'News',             action: 'Pitch a story or press release' },
  'social':          { label: 'Social',           action: 'Engage and post relevant content' },
  'video':           { label: 'Video',            action: 'Pitch a demo or interview' },
  'code':            { label: 'Code / OSS',       action: 'Contribute or open an issue' },
};

/**
 * Hosts (or host suffixes — leading dot = wildcard subdomain) that are never
 * plausible outreach targets. Three failure modes surfaced in dogfood runs on
 * typelessform.com:
 *
 *   1. Generic developer-hosting domains (github.io, vercel.app, …) — these
 *      are tenant containers for arbitrary user sites, not publications.
 *      «Pitch a mention» on github.io has no editor to email.
 *   2. Long-dead tutorial sites (teamtreehouse, w3schools, tutorialspoint) —
 *      the author has no way to add a brand recommendation; the citation is
 *      AI hallucinating reference value out of decade-old content.
 *   3. The BARE APEX of a developer-hosting domain (github.io, vercel.app
 *      with no subdomain). Originally the wildcard `.github.io` was scoped
 *      to subdomains only, on the theory that the apex would never appear
 *      in real citations. The May-2026 typelessform.com dogfood run proved
 *      otherwise: an LLM hallucinated a bare `github.io` citation and the
 *      «Where to get mentioned» table rendered «Pitch a mention or guest
 *      post on github.io» — a domain with zero editorial surface. Both the
 *      wildcard AND the bare form must be denied per provider.
 *
 * Single named constant keeps tuning trivial when new low-quality hosts
 * appear in real-run citation pools.
 */
export const OUTREACH_HOST_DENY_LIST = [
  // Generic developer/static hosting — tenant containers, not publications.
  // Each provider has TWO entries: the `.host` wildcard (subdomains, the
  // normal citation shape `alice.github.io`) and the bare apex (the
  // hallucinated shape `github.io`). The apex itself is never a real
  // outreach target — these are platforms, not publications.
  '.github.io',     'github.io',
  '.github.com',    // github.com bare is a legitimate outreach target
                    // (repos, READMEs, awesome-lists) — do NOT add bare.
  '.gitlab.io',     'gitlab.io',
  '.netlify.app',   'netlify.app',
  '.vercel.app',    'vercel.app',
  '.glitch.me',     'glitch.me',
  '.pages.dev',     'pages.dev',
  '.web.app',       'web.app',
  '.firebaseapp.com', 'firebaseapp.com',
  // Tutorial sites — no editorial path for brand recommendations
  'teamtreehouse.com',
  'w3schools.com',
  'tutorialspoint.com',
];

/**
 * Returns true when `host` matches any entry in the deny-list. Suffixes
 * starting with `.` match subdomains (e.g. `.github.io` matches
 * `alice.github.io`, but not `github.io` bare — bare apex is covered by
 * a separate explicit entry where appropriate). Exact matches handle the
 * tutorial-site and bare-apex cases.
 *
 * Defensive normalisation: lowercases, strips a trailing dot (the
 * DNS-root form `github.io.` that some extractors leak) and strips a
 * leading `www.` (the apex-redirect form `www.github.io`).
 *
 * @param {string} host  hostname — case and `www.`/trailing-dot insensitive
 * @returns {boolean}
 */
export function isDenyListedOutreachHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!h) return false;
  for (const entry of OUTREACH_HOST_DENY_LIST) {
    if (entry.startsWith('.')) {
      if (h.endsWith(entry)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Build a Set of competitor-OWNED hostnames from a snapshot, so the
 * «Actionable Gaps» outreach copy never tells the user to pitch a DIRECT
 * COMPETITOR's own site to «add you alongside» — surfaced in the 2026-06-11
 * webappski first-client run («Pitch aeoengine.ai to add webappski alongside
 * get-ryze.ai» — aeoengine.ai is itself a competitor from the same row).
 *
 * The deny-list (isDenyListedOutreachHost) only covers generic tenant hosts;
 * competitor domains are run-specific, so they come from
 * `latest.competitorPricing[].domain` (already derived this run). Hosts are
 * normalised (lowercased, www-stripped) and apex-only so a subdomain citation
 * still matches the competitor apex.
 *
 * Pure — exported for unit-tests.
 *
 * @param {object} latest  snapshot
 * @returns {Set<string>}  normalised competitor apex hostnames
 */
export function competitorOwnedHosts(latest) {
  const out = new Set();
  const cp = Array.isArray(latest?.competitorPricing) ? latest.competitorPricing : [];
  for (const c of cp) {
    const raw = typeof c?.domain === 'string' ? c.domain : '';
    if (!raw) continue;
    let h = raw.toLowerCase().trim();
    try { h = new URL(h.includes('://') ? h : `https://${h}`).hostname; } catch { /* keep raw */ }
    h = h.replace(/\.$/, '').replace(/^www\./, '');
    if (h) out.add(h);
  }
  return out;
}

/**
 * True when `host` equals or is a subdomain of any competitor-owned apex.
 * @param {string} host
 * @param {Set<string>} competitorHosts  from competitorOwnedHosts()
 */
export function isCompetitorOwnedHost(host, competitorHosts) {
  if (!host || !competitorHosts || competitorHosts.size === 0) return false;
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (competitorHosts.has(h)) return true;
  for (const apex of competitorHosts) {
    if (h.endsWith(`.${apex}`)) return true;
  }
  return false;
}

export function sectionCanonicalSources(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  const sources = latest.topCanonicalSources || [];
  if (sources.length === 0) return '';

  // White-label client snapshots are statistics-only: this section is reduced to
  // a citation-source table (site · type · about) with the «Your action» pitch
  // column removed and the «Where to get mentioned» / «fastest path to AEO
  // visibility … guest post» recommendation copy neutralised. The measured data
  // (which domains the engines cite for this category) is preserved — only the
  // outreach instruction is dropped. Same {whiteLabel} gating as sectionCrawlability.
  const whiteLabel = opts.whiteLabel === true;

  const hasClassification = latest.citationClassification != null;
  const onCategoryHosts = hasClassification
    ? new Set((latest.citationClassification?.onCategoryDomains || []).map(d => d.hostname))
    : null;
  const industryByHost = new Map(
    (latest.citationClassification?.onCategoryDomains || []).map(d => [d.hostname, d.industry])
  );

  // Group by hostname, filter to on-category only when classification available.
  // Also strip the user's own domain (and any subdomain of it) so the
  // recommendation table never tells the user to «pitch a mention or guest
  // post» on their own site — surfaced in the May-2026 dogfood run on
  // typelessform.com (see lib/report/own-domain.js).
  const byHost = new Map();
  for (const s of sources) {
    try {
      const host = new URL(s.url).hostname.replace(/^www\./, '');
      if (isOwnDomain(host, latest.domain)) continue;
      // Strip generic developer-hosting domains and dead tutorial sites — see
      // OUTREACH_HOST_DENY_LIST docs above. Surfaced May-2026 in the
      // typelessform.com dogfood run (github.io / teamtreehouse.com both
      // appeared in citations but have no editorial path for outreach).
      if (isDenyListedOutreachHost(host)) continue;
      if (hasClassification && !onCategoryHosts.has(host)) continue;
      const existing = byHost.get(host) || { host, total: 0, type: classifyUrlType(s.url) };
      existing.total += s.count;
      byHost.set(host, existing);
    } catch { /* malformed URL — skip */ }
  }

  const grouped = [...byHost.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  if (grouped.length === 0) {
    if (whiteLabel) {
      return `## Citation Sources

_No high-authority sources surfaced for this category this run._
`;
    }
    return `## Where to get mentioned

_No high-authority outreach targets surfaced this run._
`;
  }

  const rows = grouped.map(g => {
    const meta = TYPE_META[g.type] || TYPE_META['blog'];
    const industry = industryByHost.get(g.host) || meta.label;
    const action = whiteLabel ? '' : ` ${meta.action} |`;
    return `| \`${escMd(g.host)}\` | ${meta.label} | ${escMd(industry)} |${action}`;
  }).join('\n');

  if (whiteLabel) {
    return `## Citation Sources

_The sites AI engines cite when answering queries in your category, ranked by citation volume._

| Site | Type | About |
|---|---|---|
${rows}
`;
  }

  return `## Where to get mentioned

_AI engines cite these sites when answering queries in your category. Getting mentioned here is the fastest path to AEO visibility — one mention on a high-trust site propagates across all engines that rely on it._

| Site | Type | About | Your action |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Next Steps (actionable) ───

export function sectionNextSteps(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const providers = [...new Set(latest.results.map(r => r.provider))];
  const stats = providers.map(p => ({ p, ...providerStats(latest.results, p) }));
  const invisible = stats.filter(s => s.hits === 0 && s.total > 0);
  const partial = stats.filter(s => s.hits > 0 && s.hits < s.total);
  const topSrc = latest.topCanonicalSources?.[0];
  const topCompetitor = latest.topCompetitors?.[0];

  // P6 — short, scannable, checkbox-friendly. Each step = {label, why, estimate}
  const steps = [];

  if (invisible.length > 0) {
    steps.push({
      label: `Target invisible engines (${invisible.map(s => providerLabel(s.p)).join(', ')})`,
      why: 'Different engines pull from different source pools — need one citation on the relevant pool per engine',
      estimate: '~2h research',
    });
  }
  if (partial.length > 0) {
    steps.push({
      label: `Fill query gaps on ${partial.map(s => providerLabel(s.p)).join(', ')}`,
      why: 'You\'re mentioned on some queries but not others — map failing queries to content gaps',
      estimate: '~1h audit',
    });
  }
  if (topSrc) {
    // Malformed URL: fall back to raw url string for the host comparison.
    // Off-host classification then misses a few edge cases, which is the
    // intended behaviour — we'd rather suggest a low-priority outreach
    // step than crash the section.
    const host = (() => { try { return new URL(topSrc.url).hostname.replace(/^www\./, ''); } catch { return topSrc.url; } })();
    const offHosts = new Set((latest.citationClassification?.offCategoryDomains || []).map(d => d.hostname));
    // Suppress the «pitch top source» step when the top source is the user's
    // own domain — the May-2026 dogfood run produced a self-pitch suggestion
    // because the brand's own canonical pages were the most-cited source.
    // Also suppress when the host is on OUTREACH_HOST_DENY_LIST (github.io
    // tenant container, teamtreehouse.com tutorial site, etc.) — there is no
    // editor to pitch on those hosts, see sectionCanonicalSources.
    if (!offHosts.has(host) && !isOwnDomain(host, latest.domain) && !isDenyListedOutreachHost(host)) {
      steps.push({
        label: `Pitch a guest post / mention on \`${escMd(host)}\``,
        why: `AI engines cite it ${topSrc.count}× for your queries — single mention propagates to multiple engines`,
        estimate: '~30min outreach',
      });
    }
  }
  if (topCompetitor && topCompetitor.count >= 2) {
    steps.push({
      label: `Reverse-engineer ${escMd(topCompetitor.name)}'s citation footprint`,
      why: `Appears in ${topCompetitor.count}/${latest.total} of your checks — where AI cites them, it could cite you`,
      estimate: '~1h research',
    });
  }
  if (snapshots.length === 1) {
    steps.push({
      label: 'Re-run `aeo-platform run` next week',
      why: 'One snapshot is a baseline, not a trend. Week-over-week diff is where the tool becomes actionable',
      estimate: '~2min',
    });
  }

  if (steps.length === 0) return '';

  const checkboxes = steps.map(s =>
    `- [ ] **${s.label}** — ${s.estimate}\n      _${s.why}_`
  ).join('\n');

  return `## Actions this week

_Copy-paste into Todoist / Linear / your tracker of choice. Ordered by impact; pick 1–2 if you're time-constrained._

${checkboxes}
`;
}

// ─── Section: Disambiguation Warning (P4) ───

/**
 * Minimum share of cited domains that must be flagged off-category for the
 * warning to fire. Below 30%, the «mismatch» is statistically more likely to
 * be one or two acronym-collision domains in an otherwise correct vertical,
 * not a systematic targeting error.
 */
const INDUSTRY_MISMATCH_OFF_SHARE_THRESHOLD = 0.30;

/**
 * Minimum share of off-category verdicts that must carry `confidence: high`.
 *
 * Bug surfaced May 2026 (typelessform.com dogfood run): the classifier
 * mis-tagged real in-category competitors (sayfill.com, agentfillai.com) as
 * UNKNOWN with low confidence, and the panel fired anyway — blaming the AI
 * engines for the classifier's own miss. Requiring 70% of off-category
 * verdicts to be high-confidence suppresses the warning when the classifier
 * is guessing, while still firing when it is genuinely confident the cited
 * vertical is wrong.
 */
const INDUSTRY_MISMATCH_CONFIDENCE_THRESHOLD = 0.70;

/**
 * Reads precomputed LLM citation classification from snapshot.citationClassification.
 *
 * Fires only when BOTH:
 *   (a) ≥ 30% of cited domains are flagged off-category (systematic, not noise)
 *   (b) ≥ 70% of those off-category verdicts have `confidence: high` (classifier
 *       is sure, not guessing) — see threshold JSDoc above for the dogfood
 *       incident that motivated this guard.
 *
 * Classification is computed once in cmdReport via classifyCitations() and cached
 * in _summary.json — this function is pure sync and costs $0 on subsequent runs.
 */
export function sectionDisambiguationWarning(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  if (!latest) return '';

  const classification = latest.citationClassification;
  if (!classification || !Array.isArray(classification.offCategoryDomains)) return '';

  const off = classification.offCategoryDomains;
  const on = Array.isArray(classification.onCategoryDomains) ? classification.onCategoryDomains : [];
  const total = off.length + on.length;
  if (total === 0) return '';

  // Threshold (a): systematic off-category share, not one-off acronym collisions.
  const offShare = off.length / total;
  if (offShare < INDUSTRY_MISMATCH_OFF_SHARE_THRESHOLD) return '';

  // Threshold (b): classifier itself must be confident about the off-category
  // verdicts. Low-confidence verdicts are the failure mode that pollutes the
  // diagnosis (classifier guess, not actual vertical mismatch).
  const highConf = off.filter(d => d && d.confidence === 'high').length;
  const confShare = highConf / off.length;
  if (confShare < INDUSTRY_MISMATCH_CONFIDENCE_THRESHOLD) return '';

  const offList = off
    .map(d => `- \`${escMd(d.hostname)}\` — ${escMd(d.industry)}`)
    .join('\n');

  const count = off.length;

  return `## ⚠ Industry mismatch detected in AI citations

**${count} of ${total} cited domains belong to a different industry** (LLM classifier, high confidence on every entry below):

${offList}

These were cited in answers to your queries — typically a sign that an ambiguous term in the query set is being read in the wrong vertical (e.g. "AEO" matches both Answer Engine Optimization and EU customs certification).

Fix: regenerate the query set with an explicit disambiguating category. The \`--replace-queries\` flag forks history (forgets the old query basket); use \`--add-queries\` instead if you want to preserve historical trend data.

\`\`\`
aeo-platform init --queries-only --replace-queries --category="<your category> — NOT <the wrong industry>"
\`\`\`

Example category: \`"Answer Engine Optimization services — NOT customs/Authorized Economic Operator"\`
`;
}

// ─── Section: Competitor Intelligence — full query × engine matrix ───

export function sectionCompetitorIntelligence(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const queries = [...new Set(latest.results.map(r => r.query))].sort();
  const providers = [...new Set(latest.results.map(r => r.provider))];

  if (providers.length === 0 || queries.length === 0) return '';

  // Count total gaps to decide whether section is worth showing
  let totalGaps = 0;
  const matrix = queries.map(q => {
    const firstR = latest.results.find(r => r.query === q);
    const qText = firstR?.queryText || q;
    return {
      query: q,
      short: qText,
      full: qText,
      cells: providers.map(p => {
        const r = latest.results.find(x => x.query === q && x.provider === p);
        if (!r || r.mention === 'error') return { status: 'missing', competitors: [] };
        const cited = (r.competitors || []).slice(0, 4);
        if (r.mention !== 'yes' && r.mention !== 'src') totalGaps++;
        return { status: r.mention, competitors: cited };
      }),
    };
  });

  // tone-driven badge via .cell-badge[data-tone]. Replaces v0.3 inline
  // Tailwind hex (#dcfce7/#15803d/#fef9c3/#854d0e/#fee2e2/#b91c1c/#f1f5f9/
  // #94a3b8) with report tokens. Markup binds to CSS in styles.css.
  const badge = (content, tone) =>
    `<span class="cell-badge" data-tone="${tone}">${content}</span>`;

  const engineHeaders = providers.map(p =>
    `<th>${providerLabel(p)}</th>`
  ).join('');

  const tableRows = matrix.map(row => {
    const cells = row.cells.map(cell => {
      let content;
      if (cell.status === 'yes') {
        content = badge('✓ YOU', 'good');
      } else if (cell.status === 'src') {
        content = badge('SRC', 'warn');
      } else if (cell.status === 'missing' || cell.status === 'error') {
        content = badge('—', 'muted');
      } else if (cell.competitors.length === 0) {
        content = badge('❌', 'bad');
      } else {
        const comps = cell.competitors
          .map(c => `<span class="cintel-comp">${escMd(c)}</span>`)
          .join(' ');
        content = `<div>${badge('❌', 'bad')}</div><div class="cintel-comps">${comps}</div>`;
      }
      return `<td class="cintel-cell" data-status="${cell.status}">${content}</td>`;
    }).join('');

    return `<tr><td class="cintel-query">${escMd(row.short)}</td>${cells}</tr>`;
  }).join('');

  const gapNote = totalGaps > 0
    ? `_${totalGaps} gap${totalGaps !== 1 ? 's' : ''} found — red cells show who AI cited instead of you._`
    : '_Your brand appeared in all tested queries._';

  return `## Competitor Intelligence

${gapNote}

<div class="cintel-table-wrap"><table class="cintel-table"><thead><tr><th>Query</th>${engineHeaders}</tr></thead><tbody>${tableRows}</tbody></table></div>
`;
}

// ─── Section: Brand Sentiment (NEW v0.3) ───
//
// Renders how each AI engine portrays the brand: positive / neutral / negative.
// Pulls r.sentiment from results — populated by classifySentimentWithTwoModels.
// Cells without sentiment (mention=no/error) are dashed out.

// Sentiment label → tone + glyph. Tone drives colour via
// `.cell-badge[data-tone="..."]` so palette decisions live in the editorial
// token system (replaces v0.3 inline Tailwind hex for fg/bg).
const SENTIMENT_BADGE = {
  positive: { tone: 'good',  icon: '👍', label: 'Positive' },
  neutral:  { tone: 'muted', icon: '◌',  label: 'Neutral'  },
  negative: { tone: 'bad',   icon: '👎', label: 'Negative' },
};

export function sectionSentiment(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const withSentiment = latest.results.filter(r => r.sentiment && r.sentiment.label);
  if (withSentiment.length === 0) return '';

  const counts = { positive: 0, neutral: 0, negative: 0 };
  for (const r of withSentiment) counts[r.sentiment.label] = (counts[r.sentiment.label] || 0) + 1;
  const total = withSentiment.length;

  const summary = ['positive', 'neutral', 'negative']
    .filter(k => counts[k] > 0)
    .map(k => `${SENTIMENT_BADGE[k].icon} **${counts[k]}** ${SENTIMENT_BADGE[k].label.toLowerCase()}`)
    .join(' · ');

  const rows = withSentiment.map(r => {
    const b = SENTIMENT_BADGE[r.sentiment.label] || SENTIMENT_BADGE.neutral;
    const conf = r.sentiment.confidence === 'high' ? ''
      : ` <span class="sent-conf">(${escMd(r.sentiment.confidence)})</span>`;
    const badge = `<span class="cell-badge" data-tone="${b.tone}">${b.icon} ${b.label}</span>${conf}`;
    const rationale = escMd(r.sentiment.rationale || '').replace(/\|/g, '\\|');
    return `| ${providerLabel(r.provider)} | ${escMd(r.query)} | ${badge} | ${rationale} |`;
  }).join('\n');

  return `## How AI Engines Portray Your Brand

_${summary} across ${total} mention${total !== 1 ? 's' : ''}. Sentiment is cross-checked by two classifier models — disagreements degrade to "neutral" with a low-confidence flag._

| Engine | Query | Sentiment | Why |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Domain Share-of-Voice (NEW v0.3) ───
//
// Aggregates canonicalCitations by hostname → table of domains with their
// share of total citations. This is the "outreach map" — which publishers
// actually drive AI visibility in your category.

export function sectionDomainShareOfVoice(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  let domains = latest.topDomains;

  // Backwards-compat: compute on the fly for older _summary.json files.
  if (!Array.isArray(domains) || domains.length === 0) {
    const hostMap = {};
    let total = 0;
    for (const r of latest.results || []) {
      for (const url of (r.canonicalCitations || [])) {
        try {
          const host = new URL(url).hostname.replace(/^www\./, '');
          hostMap[host] = (hostMap[host] || 0) + 1;
          total++;
        } catch { /* skip */ }
      }
    }
    domains = Object.entries(hostMap)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([host, count]) => ({ host, count, share: total > 0 ? count / total : 0 }));
  }

  if (!domains || domains.length === 0) return '';

  const top = domains.slice(0, 10);
  const maxCount = top[0]?.count || 1;
  const rows = top.map(d => {
    const pct = (d.share * 100).toFixed(1);
    const barWidth = Math.round((d.count / maxCount) * 100);
    const bar = `<span class="share-bar" style="--bar-w:${barWidth}%"></span>`;
    return `| **${escMd(d.host)}** | ${d.count} | ${pct}% | ${bar} |`;
  }).join('\n');

  // White-label client snapshots are statistics-only: the subheading drops the
  // outreach-recommendation copy AND the dangling «see Outreach templates below»
  // cross-reference (that section is removed in white-label — a visible link to a
  // cut section is itself a «something was redacted here» tell). Same {whiteLabel}
  // gating pattern as sectionCrawlability.
  const sub = opts.whiteLabel
    ? `The publishers AI engines cite when describing your category, ranked by share of total citations.`
    : `The publishers AI cites when describing your category. Pitching the top 3 is the highest-leverage AEO move surfaced by the data — see "Outreach templates" section below for ready-to-send drafts.`;

  return `## Where AI Engines Get Their Answers — Domain Share of Voice

_${sub}_

| Domain | Citations | Share | |
|---|---:|---:|---|
${rows}
`;
}

// ─── Section: Historical 8-week Trend (NEW v0.3) ───
//
// Multi-snapshot visibility line. Always renders if ≥2 snapshots exist; for
// ≥8 it shows the last 8 (one per weekly cadence). Same sparkline primitive
// as per-query trend, but at full hero width.

// Window for the trend block — keeps the chart legible regardless of how
// many historical snapshots the user accumulates. Latest run is always
// at the right edge.
const TREND_WINDOW = 8;
const TREND_MIN_POINTS = 2;
const TREND_SPARK_WIDTH = 480;
const TREND_SPARK_HEIGHT = 80;

/**
 * Minimum number of weekly runs before trend visualisations become
 * statistically meaningful. README documents «trend visualisations become
 * meaningful from week 4» — at <4 runs the line connects 2-3 points of
 * potentially-different provider sets, dressing noise as a trend. Below
 * this threshold both `sectionHistoricalTrend` and `sectionTrend`
 * (per-query sparklines) suppress themselves and emit a single muted
 * «available from week 4» placeholder. Tunable in one place when the
 * cadence changes.
 */
export const TREND_MIN_RUNS = 4;

/**
 * Compose the «not enough runs yet» placeholder used by both the trend
 * chart and the per-query sparkline blocks. Returns one muted markdown
 * line so the report makes the suppression visible instead of silently
 * hiding the section.
 *
 * @param {number} runCount  current number of snapshots
 * @returns {string} muted markdown line
 */
function trendNotYetPlaceholder(runCount) {
  return `_Trend chart available from week ${TREND_MIN_RUNS} — currently ${runCount} of ${TREND_MIN_RUNS} runs collected._\n`;
}

/**
 * Renders the multi-snapshot visibility trend block (sparkline + per-run tick row).
 *
 * Reads `snapshots[].score` over the last `TREND_WINDOW` runs. Returns ''
 * when fewer than `TREND_MIN_POINTS` numeric scores are available — comparing
 * a 1-run trend would mislead. Tick row shows `MM-DD` date + score per run.
 *
 * Markup binds to `.trend-block` / `.trend-delta[data-tone]` / `.trend-tick`
 * CSS classes in renderCss() so colour and spacing live in the editorial
 * token system. Replaces v0.3 inline-styled slate hex values.
 *
 * @param {Array} snapshots — chronological run snapshots; needs ≥2 with
 *   numeric `score` for the section to render.
 * @returns {string} markdown+HTML string, or '' when too few data points.
 */
export function sectionHistoricalTrend(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < TREND_MIN_POINTS) return '';
  // Suppress the visualisation when run count is below the «meaningful trend»
  // threshold (see TREND_MIN_RUNS). 2 points connected by a line are noise,
  // especially when prior runs had a different provider set. Show one muted
  // status line instead so the reader knows the block exists but is staged.
  if (snapshots.length < TREND_MIN_RUNS) return trendNotYetPlaceholder(snapshots.length);

  const recent = snapshots.slice(-TREND_WINDOW);
  const values = recent.map(s => typeof s.score === 'number' ? s.score : null);
  const present = values.filter(v => v !== null);
  if (present.length < TREND_MIN_POINTS) return '';

  const spark = sparkline({ values, width: TREND_SPARK_WIDTH, height: TREND_SPARK_HEIGHT });
  const first = present[0];
  const last = present[present.length - 1];
  const delta = last - first;
  const arrow = delta > 0 ? `↑ +${delta}` : delta < 0 ? `↓ ${delta}` : '→ flat';
  const trendTone = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'flat';

  const dateRange = `${recent[0].date} → ${recent[recent.length - 1].date}`;
  const tickRow = recent
    .map(s => `<td class="trend-tick">${(s.date || '').slice(5)}<br/><strong class="trend-tick-val">${s.score ?? '—'}%</strong></td>`)
    .join('');

  return `## Visibility Trend — last ${recent.length} run${recent.length !== 1 ? 's' : ''}

_${dateRange} · <span class="trend-delta" data-tone="${trendTone}">${arrow} pts</span> overall. Each tick = one weekly run._

<div class="trend-block">
${spark}
<table class="trend-ticks"><tr>${tickRow}</tr></table>
</div>
`;
}

// ─── Section: Outreach Email Templates (NEW v0.3) ───
//
// Renders the LLM-generated outreach emails for the top-3 cited domains.
// Source field is latest.outreachTemplates — populated by generateOutreachTemplates
// during cmdReport. Cached, so re-running `aeo-tracker report` doesn't re-spend.

/**
 * Renders ready-to-send outreach drafts for top-cited publishers.
 *
 * Reads `snapshots[-1].outreachTemplates` (LLM-generated cache populated
 * by generateOutreachTemplates during cmdReport). Returns an empty string
 * when no templates are available — caller must tolerate '' as a valid
 * «no section» signal.
 *
 * Output format: markdown heading + per-template `<article class="outreach-item">`
 * blocks. Markup binds to `.outreach-*` CSS classes in renderCss() so styling
 * lives in the editorial token system, not inline (anti-pattern fixed
 * 2026-05; see Tech Debt for remaining legacy MD-generators that still
 * inline-style with Tailwind hex).
 *
 * Security: LLM fields (host/subject/body/why) are third-party-controlled
 * (competitor-extraction context), so every interpolation passes through
 * escMd() before reaching HTML.
 *
 * @param {Array} snapshots — chronological run snapshots; last element
 *   carries `outreachTemplates: Array<{host, subject, body, why?}>`.
 * @returns {string} markdown+HTML string, or '' when no templates exist.
 */
export function sectionOutreachTemplates(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const templates = latest.outreachTemplates;
  if (!Array.isArray(templates) || templates.length === 0) return '';

  // LLM-generated fields (host/subject/body/why) are escaped before HTML
  // interpolation — they originate from competitor-extraction context which
  // includes 3rd-party text, so a literal `<script>` could otherwise leak in.
  // Markup binds to .outreach-* CSS classes defined in renderCss() — no
  // inline styles, so every token (paper, line, accent-tint, --display
  // serif) lives in the report's design system.
  const blocks = templates.map((t, i) => {
    const subject = escMd(String(t.subject || '').replace(/\n/g, ' '));
    const body = escMd(String(t.body || '')).replace(/\n/g, '<br/>');
    const why = t.why
      ? `<div class="outreach-why"><span class="outreach-why-tag">why this domain</span><span class="outreach-why-text">${escMd(t.why)}</span></div>`
      : '';
    return `<article class="outreach-item">
  <header class="outreach-head">
    <span class="outreach-num">${String(i + 1).padStart(2, '0')}</span>
    <span class="outreach-host">${escMd(t.host)}</span>
  </header>
  <div class="outreach-field outreach-subject"><span class="outreach-field-label">subject</span><span class="outreach-field-value">${subject}</span></div>
  <div class="outreach-body">${body}</div>
  ${why}
</article>`;
  }).join('\n');

  return `## Outreach Email Templates — top-${templates.length} domains

_Ready-to-send pitches for the publishers AI cites most. Personalise the article reference before sending — these are starting drafts, not finished emails. Generated once per report run and cached._

${blocks}
`;
}

// ─── Section: Competitor Radar (NEW v0.3) ───
//
// 4-axis radar (presence, sentiment, rank-strength, mentions) for the user's
// brand vs top-3 competitors. Uses the existing radar() SVG primitive.
// Variant A (chosen): 4 small radars side-by-side — single radar with 4 polygons
// is hard to parse on mobile.

// Radar rank axis: a brand named at position #1 scores 100, each subsequent
// position decays by RANK_DECAY_PER_POSITION. Chosen so the curve lands
// within the radar's [0, 100] scale across realistic ranks (1–7): #1=100,
// #2=85, #3=70, #4=55, #5=40, #6=25, #7=10, #8+=0. Linear (not log) so the
// chart stays readable for non-specialist readers.
const RANK_DECAY_PER_POSITION = 15;

// Radar mention axis: each named/cited hit contributes
// MENTION_SCORE_PER_HIT, capped at 100. 5+ mentions in a run = full bar.
// Tuned against typical run sizes (3-engine × 3-query = 9 cells), where 5
// hits represents «consistently named», not «one lucky hit».
const MENTION_SCORE_PER_HIT = 20;

// Radar sentiment axis fallback for unscored cells: 50 = neutral mid-bar
// (radar polygon doesn't collapse to centre on missing sentiment).
const SENTIMENT_NEUTRAL_FALLBACK = 50;

/**
 * Compute the four radar-axis scores (presence, sentiment, rank, mentions)
 * for a given brand across the latest run.
 *
 * Score ranges: each axis 0–100. `presence` = fraction of engines that
 * named the brand at least once. `sentiment` = mean sentiment score across
 * positive/neutral/negative tags (50 when unscored). `rank` = mean rank
 * decay (see RANK_DECAY_PER_POSITION). `mentions` = capped hit count (see
 * MENTION_SCORE_PER_HIT). Pure function — safe to memoize per (latest, brand).
 *
 * @param {object} latest — last snapshot in `snapshots` array.
 * @param {string} brandName — exact brand name (case-insensitive match).
 * @returns {{name, presence, sentiment, rank, mentions, rawMentions}}.
 */
function radarStatsForBrand(latest, brandName) {
  const results = latest.results || [];
  const providers = [...new Set(results.map(r => r.provider))];
  const total = providers.length || 1;

  let presenceCount = 0;
  let sentimentSum = 0; let sentimentN = 0;
  let rankSum = 0;     let rankN = 0;
  let mentionTotal = 0;

  const isUserBrand = (latest.brand || '').toLowerCase() === brandName.toLowerCase();

  for (const p of providers) {
    const cells = results.filter(r => r.provider === p);
    let mentioned = false;
    for (const r of cells) {
      if (isUserBrand) {
        if (r.mention === 'yes' || r.mention === 'src') {
          mentioned = true;
          mentionTotal++;
          if (r.sentiment?.label) {
            sentimentSum += sentimentToScore(r.sentiment.label);
            sentimentN++;
          }
          if (typeof r.position === 'number' && r.position > 0) {
            rankSum += Math.max(0, 100 - (r.position - 1) * RANK_DECAY_PER_POSITION);
            rankN++;
          }
        }
      } else {
        const allCompetitors = [...(r.competitors || []), ...(r.competitorsUnverified || [])];
        if (allCompetitors.some(c => c.toLowerCase() === brandName.toLowerCase())) {
          mentioned = true;
          mentionTotal++;
        }
      }
    }
    if (mentioned) presenceCount++;
  }

  const presence = (presenceCount / total) * 100;
  const sentiment = sentimentN > 0 ? sentimentSum / sentimentN : SENTIMENT_NEUTRAL_FALLBACK;
  const rank = rankN > 0 ? rankSum / rankN : (mentionTotal > 0 ? SENTIMENT_NEUTRAL_FALLBACK : 0);
  const mentionScore = Math.min(100, mentionTotal * MENTION_SCORE_PER_HIT);

  return {
    name: brandName,
    presence: Math.round(presence),
    sentiment: Math.round(sentiment),
    rank: Math.round(rank),
    mentions: Math.round(mentionScore),
    rawMentions: mentionTotal,
  };
}

export function sectionCompetitorRadar(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const topCompetitors = (latest.topCompetitors || []).slice(0, 3);
  if (topCompetitors.length === 0) return '';

  const userStats = radarStatsForBrand(latest, latest.brand);
  const competitorStats = topCompetitors.map(c => radarStatsForBrand(latest, c.name));

  // Authoritative mention count per entity. Competitors pull from VERIFIED
  // topCompetitors[i].count (both extractor models agreed) so the radar card
  // label agrees with the bar chart and _summary.json. radarStats counted
  // unverified hits too — produced e.g. 5 mentions on the radar where the
  // canonical bar chart showed 4. README also promises unverified entries
  // get a dashed badge: radar-card-meta--unverified is that dashed variant.
  const _topByKey = (latest.topCompetitors || []).reduce((m, c) => {
    m.set(String(c.name || '').toLowerCase(), c);
    return m;
  }, new Map());
  const radarMentionMeta = (s, isUser) => {
    if (isUser) return { count: s.rawMentions, className: 'radar-card-meta', unverifiedNote: '' };
    const entry = _topByKey.get(String(s.name || '').toLowerCase());
    const count = entry && typeof entry.count === 'number' ? entry.count : s.rawMentions;
    const isVerified = !entry || entry.verified !== false;
    return {
      count,
      className: isVerified ? 'radar-card-meta' : 'radar-card-meta radar-card-meta--unverified',
      unverifiedNote: isVerified ? '' : ' <span class="radar-card-unverified" title="Only one extractor model agreed — weaker signal">?</span>',
    };
  };

  // radar() SVG primitive paints its polygon with #f59e0b (amber) by default
  // — we override with currentColor so the surrounding .radar-card[data-tone]
  // (which sets color via --editor / --ink-4 token) propagates into the SVG.
  // Replaces v0.3 inline Tailwind hex (#4f46e5/#94a3b8/#eef2ff/#f8fafc/
  // #e2e8f0/#0f172a/#64748b) with report tokens via .radar-* classes.
  const buildRadar = (s, isUser) => {
    // Mentions axis: keep the polygon paint aligned with the «N mentions»
    // card label. radarStatsForBrand counts both verified AND unverified
    // hits in rawMentions — for a competitor seen 4× verified + 1× unverified
    // the polygon would have painted 5 (= 100) while the card label said 4
    // (= 80). Recompute from the authoritative count so the two surfaces
    // never disagree by a tier. User row keeps its rawMentions (own brand
    // never goes through the extractor's verification pool).
    const meta = radarMentionMeta(s, isUser);
    const mentionsValue = isUser
      ? s.mentions
      : Math.min(100, (typeof meta.count === 'number' ? meta.count : 0) * MENTION_SCORE_PER_HIT);
    const axes = [
      { label: 'Presence', value: s.presence },
      { label: 'Sentiment', value: s.sentiment },
      { label: 'Rank', value: s.rank },
      { label: 'Mentions', value: mentionsValue },
    ];
    const tone = isUser ? 'you' : 'competitor';
    const svgRaw = radar({ axes, size: 220 });
    const svg = svgRaw.replace(
      'fill="#f59e0b" fill-opacity="0.18" stroke="#f59e0b"',
      'fill="currentColor" fill-opacity="0.18" stroke="currentColor"',
    );
    return `<div class="radar-card" data-tone="${tone}">
<div class="radar-card-name">${isUser ? '★ ' : ''}${escMd(s.name)}</div>
<div class="${radarMentionMeta(s, isUser).className}">${radarMentionMeta(s, isUser).count} mention${radarMentionMeta(s, isUser).count !== 1 ? 's' : ''}${radarMentionMeta(s, isUser).unverifiedNote}</div>
${svg}
</div>`;
  };

  const cards = [userStats, ...competitorStats].map((s, i) => buildRadar(s, i === 0)).join('');

  return `## Brand vs Top-3 Competitors — 4-axis Radar

_Each axis is normalised 0–100. **Presence** = share of engines that mention the brand. **Sentiment** = average tone (50 = neutral). **Rank** = average position strength when listed (higher = earlier). **Mentions** = total mention count, capped at 100._

<div class="radar-grid">
${cards}
</div>
`;
}

/**
 * HTML-only combined radar — single SVG with brand polygon overlaid on
 * top-3-competitor average. Returns raw SVG markup ready to embed inside a
 * .cell-body in the v0.5 bento layout. Markdown report keeps using
 * sectionCompetitorRadar() above for its 2×2 grid form.
 *
 * Top-3 avg formula: per-axis arithmetic mean of the top-3 competitors by
 * mentions count. If <3 competitors are present, average over whatever exists
 * (no zero-padding).
 *
 * @param {Array} snapshots
 * @returns {{svg: string, brand: string, axes: object} | null}
 */
export function competitorRadarHtml(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const topCompetitors = (latest.topCompetitors || []).slice(0, 3);
  if (topCompetitors.length === 0) return null;

  const userAxes = radarStatsForBrand(latest, latest.brand);
  const competitorAxesList = topCompetitors.map(c => radarStatsForBrand(latest, c.name));
  const avg = (key) =>
    competitorAxesList.reduce((s, c) => s + (c[key] || 0), 0) / competitorAxesList.length;
  const avgAxes = {
    presence: Math.round(avg('presence')),
    mentions: Math.round(avg('mentions')),
    rank: Math.round(avg('rank')),
    sentiment: Math.round(avg('sentiment')),
  };

  const svg = combinedRadar({
    userAxes,
    avgAxes,
    userLabel: latest.brand,
    avgLabel: competitorAxesList.length === 3 ? 'Top-3 avg' : `Top-${competitorAxesList.length} avg`,
  });
  return { svg, brand: latest.brand, userAxes, avgAxes };
}

// ─── Section: Crawlability Audit (NEW v0.4) ───
//
// Renders robots.txt + /llms.txt + sitemap.xml status plus per-bot access
// matrix. Source: latest.crawlability — populated by auditCrawlability() in
// cmdReport. The "blocked" rows are surfaced loud because they often explain
// "Claude doesn't see me" mysteries cheaper than any content audit can.

// Access state → tone + glyph + label. Tone drives the colour via
// `.crawl-badge[data-tone="..."]` CSS in renderCss(), so colour decisions
// live in the editorial token system, not in this lookup table.
const ACCESS_BADGE = {
  allowed:     { tone: 'good',  icon: '✓', label: 'Allowed' },
  blocked:     { tone: 'bad',   icon: '✗', label: 'Blocked' },
  partial:     { tone: 'warn',  icon: '◐', label: 'Partial' },
  unspecified: { tone: 'muted', icon: '—', label: 'Unspecified' },
};

/**
 * Renders the AI-Bot Crawlability Audit section (robots.txt / llms.txt /
 * sitemap.xml status + per-bot allow/block matrix grouped by provider).
 *
 * Reads `snapshots[-1].crawlability` populated by auditCrawlability() in
 * cmdReport. Returns '' when no audit has been performed (e.g. --no-crawl
 * flag or pre-v0.3 snapshot).
 *
 * Markup uses `.file-check[data-tone]` for the three site-config status
 * spans and `.crawl-badge[data-tone]` for the per-bot access pills.
 * Replaces v0.3 inline-styled Tailwind hex (#15803d / #b91c1c / #854d0e /
 * #dcfce7 / #fee2e2 / #fef9c3 / #f1f5f9 / #64748b) with report tokens.
 *
 * @param {Array} snapshots — chronological runs; last must carry
 *   `crawlability: { summary, botAccess, robots, sitemap }`.
 * @returns {string} markdown+HTML string, or '' when no crawl audit.
 */
export function sectionCrawlability(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  const audit = latest.crawlability;
  if (!audit || !audit.botAccess) return '';

  const s = audit.summary;
  const fileCheck = (label, found, extra = '') => {
    const icon = found ? '✅' : '❌';
    const tone = found ? 'good' : 'bad';
    return `<span class="file-check" data-tone="${tone}">${icon} ${label}</span>${extra ? ` <span class="file-check-meta">${extra}</span>` : ''}`;
  };
  // AP-DEAD-TACTIC-LLMSTXT — llms.txt is reported as a FACT with no verdict
  // glyph and no tone: it is neither a pass nor a fail. Google states it is not
  // needed for AI Overviews / AI Mode, a ~300k-domain study found no correlation
  // with citation, and no provider has confirmed support — so a red ❌ next to
  // it was the report scoring a client against a convention that does nothing.
  const factCheck = (label, meta) =>
    `<span class="file-check">· ${label}</span> <span class="file-check-meta">${meta}</span>`;

  const fileLine = [
    fileCheck('robots.txt', s.hasRobots, audit.robots.bytes ? `(${audit.robots.bytes} bytes)` : ''),
    fileCheck('sitemap.xml', s.hasSitemap, audit.sitemap.urlCount ? `(${audit.sitemap.urlCount} URLs)` : ''),
    factCheck('llms.txt', `${s.hasLlmsTxt ? 'present' : 'not present'} (not a ranking signal)`),
  ].join(' &nbsp;·&nbsp; ');

  // Group by provider for cleaner reading
  const byProvider = {};
  for (const bot of audit.botAccess) {
    if (!byProvider[bot.provider]) byProvider[bot.provider] = [];
    byProvider[bot.provider].push(bot);
  }

  const rows = Object.entries(byProvider).map(([provider, bots]) => {
    const cells = bots.map(b => {
      const a = ACCESS_BADGE[b.access] || ACCESS_BADGE.unspecified;
      return `<span class="crawl-badge" data-tone="${a.tone}">${a.icon} ${b.label}</span>`;
    }).join('');
    return `| **${provider}** | ${cells} |`;
  }).join('\n');

  // AP-BOT-TIER — a blocked bot is NOT automatically a lost citation. Only the
  // search-index crawlers gate answers; the training and user-triggered ones do
  // not, and telling a client to unblock those bills them for work with no
  // effect on visibility. The two tiers therefore get two different messages,
  // and the informational one is not framed as a problem.
  const blockedBots = audit.botAccess.filter(b => b.access === 'blocked');
  const blockedGating = blockedBots.filter(b => gatesCitations(b));
  const blockedOther  = blockedBots.filter(b => !gatesCitations(b));
  const gatingNames = audit.botAccess.filter(b => gatesCitations(b)).map(b => b.label);

  let warning = '';
  if (blockedGating.length > 0) {
    const names = blockedGating.map(b => b.label).join(', ');
    warning += `\n> ⚠️ **${blockedGating.length} search-index crawler${blockedGating.length !== 1 ? 's' : ''} blocked by robots.txt** — ${names}. These are the crawlers that build the indexes AI answers are drawn from, so a block here keeps you out of those answers. Fix in your \`robots.txt\` before any content investment.\n`;
  }
  if (blockedOther.length > 0) {
    const names = blockedOther.map(b => `${b.label} (${BOT_TIER[botTier(b)] || 'no citation effect'})`).join('; ');
    warning += `\n> ℹ️ **${blockedOther.length} other AI crawler${blockedOther.length !== 1 ? 's' : ''} blocked** — ${names}. Blocking these is a policy choice about training and scraping, not a visibility problem: unblocking them has no measured effect on whether AI answers cite you. No action needed unless you want to be in training data.\n`;
  }

  // The coverage-limit sentence names what OUR audit does not probe — a
  // statement about the tool, so it is dropped from a white-label client
  // snapshot the same way the outreach copy is in sectionDomainCategories. The
  // tier fact itself is about the engines, not us, so it stays in both modes.
  const gatingNote = gatingNames.length === 0 ? '' : (
    `The crawlers that gate citations in this matrix are **${gatingNames.join('** and **')}**; the rest feed model training or user-triggered fetches.`
    + (opts.whiteLabel ? '' : ` Claude's \`Claude-SearchBot\` and Google's \`Googlebot\` also gate citations but are not probed by this audit yet — check them by hand in your \`robots.txt\`.`)
  );

  return `## AI-Bot Crawlability Audit

_${fileLine}_
${warning}
| AI Engine | Bots & Access |
|---|---|
${rows}

${gatingNote ? `_${gatingNote}_\n` : ''}
_Source: \`${audit.robots.url}\` (HTTP ${audit.robots.status ?? 'n/a'}).${opts.whiteLabel ? '' : ' Re-audit on every `aeo-platform report`.'}_
`;
}

// ─── Section: Domain Category Breakdown (NEW v0.4) ───
//
// Aggregates topDomains by static-rule classification (Reviews / Forums /
// News / Reference / etc.) into a single table. Each category includes a
// "what to do" hint that tells the user the outreach modality for that
// bucket — pitching G2 (review) is a different play than pitching Reddit
// (forum) or Wikipedia (reference).

export function sectionDomainCategories(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  const topDomains = latest.topDomains;
  if (!Array.isArray(topDomains) || topDomains.length === 0) return '';

  const categories = aggregateByCategory(topDomains);
  if (categories.length === 0) return '';

  // White-label: drop the «Outreach move» column (its per-row `cat.why` is an
  // outreach playbook) and neutralise the subheading. The category-share
  // statistic stays intact — only the action copy is removed. Same {whiteLabel}
  // gating pattern as sectionCrawlability.
  const whiteLabel = opts.whiteLabel === true;

  const rows = categories.map(cat => {
    const pct = (cat.share * 100).toFixed(1);
    const examples = cat.domains.slice(0, 3).map(d => escMd(d.host)).join(', ');
    const more = cat.domains.length > 3 ? ` <span class="dom-more">+${cat.domains.length - 3} more</span>` : '';
    const action = whiteLabel ? '' : ` ${escMd(cat.why)} |`;
    return `| ${cat.icon} **${escMd(cat.label)}** | ${cat.count} | ${pct}% | ${examples}${more} |${action}`;
  }).join('\n');

  const sub = whiteLabel
    ? `How AI engines source their answers about your category, grouped by the kind of site cited.`
    : `How AI gets its answers about your category. Each row maps to a different outreach play — reviews and forums need very different tactics.`;
  const header = whiteLabel
    ? `| Category | Citations | Share | Top examples |\n|---|---:|---:|---|`
    : `| Category | Citations | Share | Top examples | Outreach move |\n|---|---:|---:|---|---|`;

  return `## Citation Source Breakdown — by Category

_${sub}_

${header}
${rows}
`;
}

// ─── Section: Funnel / Intent Breakdown (NEW v0.4) ───
//
// Visibility aggregated by user-defined query tags from .aeo-tracker.json.
// Tags are arbitrary — common useful sets: ToFu/MoFu/BoFu funnel stages,
// "comparison/howto/vendor-listing" intents, regions, languages.
// Hidden when no tags are defined — zero impact on existing configs.

export function sectionFunnelBreakdown(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const tagged = (latest.results || []).filter(r => !!r.tag);
  if (tagged.length === 0) return '';

  const byTag = new Map();
  for (const r of tagged) {
    if (!byTag.has(r.tag)) byTag.set(r.tag, { tag: r.tag, total: 0, mentions: 0, errors: 0 });
    const bucket = byTag.get(r.tag);
    bucket.total++;
    if (r.mention === 'yes' || r.mention === 'src') bucket.mentions++;
    if (r.mention === 'error') bucket.errors++;
  }

  const sorted = Array.from(byTag.values()).sort((a, b) => {
    const aRate = a.total > 0 ? a.mentions / a.total : 0;
    const bRate = b.total > 0 ? b.mentions / b.total : 0;
    return bRate - aRate;
  });

  const rows = sorted.map(t => {
    const rate = t.total > 0 ? Math.round((t.mentions / t.total) * 100) : 0;
    const tone = rate >= 60 ? 'good' : rate >= 25 ? 'warn' : 'bad';
    const verdict = rate >= 60 ? 'strong' : rate >= 25 ? 'present' : rate > 0 ? 'emerging' : 'invisible';
    const barW = Math.max(2, rate);
    const bar = `<span class="share-bar" data-tone="${tone}" style="--bar-w:${barW}%"></span>`;
    return `| **${escMd(t.tag)}** | ${t.mentions}/${t.total} | <span class="rate-text" data-tone="${tone}">${rate}%</span> ${verdict} | ${bar} |`;
  }).join('\n');

  return `## Visibility by Funnel Stage / Intent Tag

_Visibility split across the tags you defined in \`.aeo-tracker.json\`. A common pattern: high ToFu, zero BoFu — means AI knows your category but not why to choose you._

| Tag | Hits | Rate | |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Actionable Gap Matrix (NEW v0.4) ───
//
// For every cell where the brand was NOT mentioned but competitors were,
// surface a one-line concrete action. Cross-references topDomains so the
// recommendation references real publishers from this run, not generic advice.

export function sectionActionableGaps(snapshots, opts = {}) {
  const latest = snapshots[snapshots.length - 1];
  const results = latest.results || [];
  const topDomains = Array.isArray(latest.topDomains) ? latest.topDomains : [];
  // Competitor-owned hosts (fail-branch #10): never recommend pitching a
  // direct competitor's own site to «add you alongside» a rival.
  const competitorHosts = competitorOwnedHosts(latest);
  // Pick the first external host (skip the user's own domain, deny-listed
  // tenant hosts like github.io / vercel.app, AND competitor-owned domains —
  // those have no incentive to add you). Without the deny-list step the «Get
  // listed on» copy recommended outreach to tenant containers (May-2026
  // typelessform.com run); without the competitor filter it pitched
  // aeoengine.ai (2026-06-11 webappski run).
  const topDomainHost = (topDomains.find(d =>
    d && !isOwnDomain(d.host, latest.domain) && !isDenyListedOutreachHost(d.host)
      && !isCompetitorOwnedHost(d.host, competitorHosts)
  ) || {}).host;

  // Split per-cell into verified vs unverified buckets. Verified drives the
  // strong «Pitch X alongside Y» action; unverified-only cells get softened
  // wording — the May-2026 typelessform.com Q2/Gemini cell flagged Amazon /
  // Walmart / Starbucks (retailers mentioned as customers, not competitors).
  // gpt-5.4-mini classified them as competitors; gemini-2.5-flash returned
  // empty — cross-check splits them into the unverified bucket as designed,
  // but the renderer previously upgraded them to a bold-red «Pitch vellis.
  // financial to add typelessform alongside Amazon» action.
  const gaps = results.filter(r => {
    if (r.mention === 'yes' || r.mention === 'src') return false;
    if (r.mention === 'error') return false;
    const verified   = (r.competitors           || []);
    const unverified = (r.competitorsUnverified || []);
    // Cells with zero verified AND zero unverified carry no displacement
    // signal — exclude entirely (the previous code already filtered comps=0,
    // this just keeps the predicate explicit alongside the bucket split below).
    return verified.length + unverified.length > 0;
  });

  if (gaps.length === 0) return '';

  // Pick top N most actionable: prefer cells with most VERIFIED competitors
  // (clearest displacement target), tie-break on total. Unverified-only cells
  // remain eligible but sort lower so the strong rows always surface first.
  // `opts.limit` lets callers (e.g. Overview tab) request a smaller slice
  // (top-3 preview).
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 8;
  const prioritised = gaps
    .map(r => {
      const verified   = (r.competitors           || []);
      const unverified = (r.competitorsUnverified || []);
      return { r, verified, unverified, weight: verified.length * 100 + unverified.length };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);

  const rows = prioritised.map(({ r, verified, unverified }) => {
    const unverifiedOnly = verified.length === 0 && unverified.length > 0;
    const topComp = verified[0] || unverified[0];
    // First non-own, non-deny-listed citation host. Pitching the user's own
    // domain to add themselves «alongside ${competitor}» is a self-pitch
    // (4-of-6 broken rows in the May-2026 typelessform.com dogfood run), and
    // pitching alice.github.io / vercel.app tenant containers has no editor
    // to email (same deny-list as sectionCanonicalSources).
    const cellHost = (() => {
      const urls = r.canonicalCitations || [];
      for (const u of urls) {
        try {
          const h = new URL(u).hostname.replace(/^www\./, '');
          if (isOwnDomain(h, latest.domain)) continue;
          if (isDenyListedOutreachHost(h)) continue;
          // fail-branch #10: a competitor's own cited URL is not an outreach
          // target — pitching them to «add you alongside» a rival is absurd.
          if (isCompetitorOwnedHost(h, competitorHosts)) continue;
          return h;
        } catch { /* skip */ }
      }
      return null;
    })();

    const safeBrand = escMd(latest.brand);
    const safeQuery = escMd((r.queryText || r.query).slice(0, 50));
    const safeQueryShort = escMd((r.queryText || r.query).slice(0, 40));
    const safeTopComp = escMd(topComp);

    let action;
    if (unverifiedOnly) {
      // Do not recommend an outreach move on a single-model signal — but be
      // honest about WHY it is single-model. In single-key mode there is no
      // second extractor at all; implying a model disagreement («the other
      // returned empty… picked up in error») would falsely read as noise.
      action = latest.extractorMode === 'single'
        ? `Verify independently — single-key mode ran ONE extractor model, so these competitor names carry no cross-model confirmation (not necessarily wrong). Add a second API key (OpenAI or Gemini) to enable verification.`
        : `Cross-check this cell — only one extractor model flagged competitors here, the other returned empty. Likely retailers / customers / unrelated brands picked up in error.`;
    } else if (cellHost) {
      action = `Pitch **${escMd(cellHost)}** to add ${safeBrand} alongside ${safeTopComp}`;
    } else if (topDomainHost) {
      action = `Get listed on **${escMd(topDomainHost)}** (top citation source overall) for "${safeQuery}..."`;
    } else {
      action = `Publish a comparison page: "${safeBrand} vs ${safeTopComp}" targeting "${safeQueryShort}..."`;
    }

    // Render verified competitors with the normal solid `data-tone="bad"`
    // chip; render unverified competitors with the dashed variant promised
    // by the README («dashed ? badges = only one model agreed (weaker
    // signal, surfaced honestly)»). `data-unverified` switches the chip to
    // a dashed border + muted tone via the cell-badge CSS rule.
    const verifiedBadges = verified
      .map(c => `<span class="cell-badge" data-tone="bad">${escMd(c)}</span>`);
    const unverifiedBadges = unverified
      .map(c => `<span class="cell-badge" data-tone="bad" data-unverified="1" title="Only one extractor model agreed — weaker signal">${escMd(c)} <span class="cell-badge-mark">?</span></span>`);
    const compsBadge = [...verifiedBadges, ...unverifiedBadges].slice(0, 3).join(' ');

    return `| ${escMd(r.query)} | ${providerLabel(r.provider)} | ${compsBadge} | ${action} |`;
  }).join('\n');

  return `## Actionable Gaps — what to fix this week

_Top ${prioritised.length} cells where competitors are cited but you aren't. Each row is one outreach or content move tied to a real domain or competitor surfaced by this run._

| Query | Engine | Cited instead | What to do |
|---|---|---|---|
${rows}
`;
}

// ─── Section: Geographic Comparison (NEW v0.4) ───
//
// When --geo flag was used at run time, results carry a `region` field. Show
// visibility per region, broken down by engine. Highlights "you're strong in
// US but invisible in DE" patterns that single-region runs would miss.

export function sectionGeoComparison(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const results = latest.results || [];
  const withRegion = results.filter(r => !!r.region);
  if (withRegion.length === 0) return '';

  const regions = [...new Set(withRegion.map(r => r.region))].sort();
  const providers = [...new Set(withRegion.map(r => r.provider))];

  const cellRate = (region, provider) => {
    const cells = withRegion.filter(r => r.region === region && r.provider === provider && r.mention !== 'error');
    if (cells.length === 0) return null;
    const hits = cells.filter(r => r.mention === 'yes' || r.mention === 'src').length;
    return { hits, total: cells.length, rate: Math.round((hits / cells.length) * 100) };
  };

  const headerCells = providers.map(p => `<th class="geo-th-engine">${providerLabel(p)}</th>`).join('');

  const rows = regions.map(region => {
    const sample = withRegion.find(r => r.region === region);
    const label = escMd(sample?.regionLabel || region.toUpperCase());
    const cells = providers.map(p => {
      const stat = cellRate(region, p);
      if (!stat) return `<td class="geo-empty">—</td>`;
      const tone = stat.rate >= 60 ? 'good' : stat.rate >= 25 ? 'warn' : stat.rate > 0 ? 'bad' : 'muted';
      return `<td class="geo-cell" data-tone="${tone}">${stat.rate}%<span class="geo-cell-frac">${stat.hits}/${stat.total}</span></td>`;
    }).join('');
    return `<tr><td class="geo-region">${label}</td>${cells}</tr>`;
  }).join('');

  const totalCells = withRegion.length;
  const totalHits = withRegion.filter(r => r.mention === 'yes' || r.mention === 'src').length;

  // AP-REGION-LANG-MATRIX — when `--lang` localised the prompts, name the
  // languages and state plainly that this is soft geo (prompt language, not a
  // real per-request geo/IP signal) so the reader never over-reads the table.
  const langsUsed = [...new Set(withRegion.map(r => r.lang).filter(Boolean))].sort();
  const langNote = langsUsed.length > 0
    ? ` Prompts for these regions were asked in their locale language (${langsUsed.join(', ')}) so engines reached locale-native sources — this localises the prompt language, not a geolocated request (provider APIs expose no per-request geo signal).`
    : '';

  return `## Visibility by Region

_Multi-region run with \`--regions\`. Each query was wrapped with a region-context preamble and sent to every engine — the LLM tailored its competitor list to that market.${langNote} ${totalHits}/${totalCells} cells across ${regions.length} regions._

<div class="geo-table-wrap"><table class="geo-table"><thead><tr><th class="geo-th-region">Region</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>

_Use this to find geographic blind spots — strong in US but invisible in DE typically means a localised content / partnerships gap._
`;
}

// ─── Section: Unified Visibility Index (NEW v0.5) ───
//
// Single 0-100 score combining presence, sentiment, rank-strength and citation
// share with documented weights. Inspired by Rankability's SPI but open —
// every component is shown alongside the composite so the user can see what
// dragged the index down.

/**
 * Format a sample-size string for the breakdown popover. Sentiment uses a
 * "n=X high-confidence cells (of Y total)" wording because its denominator
 * differs from presence/citation. Rank similarly shows ranked-cells over
 * total. Presence/citation are denominated over all non-error cells.
 */
function formatSample(row) {
  const { n, denominator, basis } = row.sample;
  if (denominator === 0) return 'no cells';
  if (row.key === 'sentiment') {
    if (n === 0) return `0 high-confidence cells (of ${denominator})`;
    return `n=${n} high-confidence cell${n === 1 ? '' : 's'} (of ${denominator})`;
  }
  if (row.key === 'rank') {
    if (n === 0) return `0 ranked cells (of ${denominator})`;
    return `n=${n} ranked cell${n === 1 ? '' : 's'} (of ${denominator})`;
  }
  return `${n}/${denominator} ${basis}`;
}

/**
 * Render the (ⓘ) help-popover that explains the EXACT calculation backing the
 * UVI score for this run. Uses native `<details>`/`<summary>` so the popover
 * is keyboard-accessible by default, requires zero JS, and survives copy-paste
 * into other markdown renderers. Click or focus + Enter to expand.
 *
 * Mirrors what `computeUVIBreakdown` produces — same numbers, no separate
 * hard-coded copy. If the formula changes the popover follows automatically.
 *
 * `opts.variant`     — optional class suffix (e.g. 'hero') appended as
 *                      `.uvi-breakdown--{variant}` so styles can adapt to the
 *                      surrounding container (dark hero vs paper-on-md-block).
 * `opts.summaryText` — override the summary label. Default «How is this
 *                      calculated? (click to expand)» fits the dedicated UVI
 *                      section; the hero uses a shorter form.
 */
export function renderUVIBreakdownPopover(breakdown, opts = {}) {
  const variantClass = opts.variant ? ` uvi-breakdown--${opts.variant}` : '';
  const summaryText = opts.summaryText || 'How is this calculated? (click to expand)';
  const fmtPct = (w) => `${(w * 100).toFixed(2).replace(/\.?0+$/, '')}%`;

  const rows = breakdown.rows.map(r => {
    if (r.value === null) {
      return `<tr><td><strong>${r.label}</strong><div class="uvi-meaning">${r.meaning}</div></td>` +
             `<td class="uvi-num">—<div class="uvi-sub">not measured this run</div></td>` +
             `<td class="uvi-num">${(r.weight * 100).toFixed(0)}%<div class="uvi-sub">redistributed</div></td>` +
             `<td class="uvi-num">—</td></tr>`;
    }
    const applied = fmtPct(r.appliedWeight);
    const appliedSub = r.appliedWeight !== r.weight
      ? `<div class="uvi-sub">re-normalised from ${(r.weight * 100).toFixed(0)}%</div>`
      : '';
    const contribution = r.contribution.toFixed(2);
    return `<tr><td><strong>${r.label}</strong><div class="uvi-meaning">${r.meaning}</div></td>` +
           `<td class="uvi-num">${r.value}<div class="uvi-sub">${formatSample(r)}</div></td>` +
           `<td class="uvi-num">${applied}${appliedSub}</td>` +
           `<td class="uvi-num">${contribution}</td></tr>`;
  }).join('');

  // Re-normalisation banner — the single biggest source of the «why is UVI
  // higher than my hit-rate?» confusion. Spell out every excluded axis and
  // the new applied weight for the others so the math is reproducible by
  // hand from this popover alone. We use `<strong>` (not markdown `**…**`)
  // because GitHub and our own markdown-to-html.js do NOT process markdown
  // syntax inside raw HTML blocks like <details>.
  let renormBanner = '';
  if (breakdown.excluded.length > 0) {
    const excludedList = breakdown.excluded
      .map(k => {
        const meta = breakdown.rows.find(r => r.key === k);
        return `<strong>${meta.label}</strong> (${(meta.weight * 100).toFixed(0)}% weight)`;
      })
      .join(', ');
    const redistTo = breakdown.rows
      .filter(r => r.value !== null)
      .map(r => `${r.label} ${(r.weight * 100).toFixed(0)}% → ${fmtPct(r.appliedWeight)}`)
      .join(', ');
    renormBanner = `<p class="uvi-renorm">${excludedList} not measured this run — its weight is redistributed proportionally across the other components (${redistTo}).</p>`;
  }

  const sumLine = breakdown.weightSum > 0
    ? `<p class="uvi-sum">Sum of contributions = <strong>${breakdown.rawSum.toFixed(2)}</strong> · weights applied = <strong>${fmtPct(breakdown.weightSum)}</strong> · <strong>${breakdown.rawSum.toFixed(2)} / ${breakdown.weightSum.toFixed(2)} = ${breakdown.uvi}</strong> UVI.</p>`
    : `<p class="uvi-sum">No measured components this run — UVI defaults to 0.</p>`;

  // The formula stays in every mode; only the source-path provenance (lib/…)
  // is dropped under --public so a hosted proof report leaks no internal paths.
  const formulaNote = opts.public === true
    ? `<p class="uvi-formula-note">Formula: <code>UVI = Σ(value × applied_weight) / Σ(applied_weight)</code>, where applied weights are re-normalised over the measured components only.</p>`
    : `<p class="uvi-formula-note">Formula: <code>UVI = Σ(value × applied_weight) / Σ(applied_weight)</code>, where applied weights are re-normalised over the measured components only. Math lives in <code>lib/report/visibility-index.js → computeUVIBreakdown()</code>.</p>`;

  return `<details class="uvi-breakdown${variantClass}"><summary><span class="uvi-info-icon" aria-hidden="true">&#9432;</span> <span class="uvi-info-label">${summaryText}</span></summary>
<div class="uvi-breakdown-body">
${renormBanner}
<table class="uvi-breakdown-table"><thead><tr><th>Component</th><th class="uvi-num">Value</th><th class="uvi-num">Weight applied</th><th class="uvi-num">Contribution</th></tr></thead><tbody>
${rows}
</tbody></table>
${sumLine}
${formulaNote}
</div>
</details>`;
}

/**
 * AP-MEASURE-SAMPLING-CI — build the Presence-axis hint for a SAMPLED run.
 *
 * Pools every sampled cell's hits/n into one aggregate Wilson interval and
 * renders «share of cells where brand was mentioned · 12/15 trials · 95% CI
 * [62%, 96%]». Returns null when no cell carries a `presence` object (single-
 * shot / legacy run) so the caller keeps the plain hint and the render stays
 * byte-identical.
 *
 * @param {object} latest a `_summary.json`-shaped snapshot
 * @returns {string|null}
 */
function sampledPresenceHint(latest) {
  const cells = (latest?.results || []).filter(
    r => r.mention !== 'error' && r.presence && typeof r.presence.n === 'number' && r.presence.n > 0,
  );
  if (cells.length === 0) return null;
  let hits = 0;
  let n = 0;
  let level = 0.95;
  for (const r of cells) {
    hits += r.presence.hits || 0;
    n += r.presence.n || 0;
    if (r.presence.ci && typeof r.presence.ci.level === 'number') level = r.presence.ci.level;
  }
  if (n === 0) return null;
  const w = wilson(hits, n);
  const lvl = Math.round(level * 100);
  return `share of cells where brand was mentioned · ${hits}/${n} trials · ${lvl}% CI [${Math.round(w.low * 100)}%, ${Math.round(w.high * 100)}%]`;
}

export function sectionUnifiedVisibilityIndex(snapshots, publicMode = false) {
  const latest = snapshots[snapshots.length - 1];
  if (!latest || !latest.results || latest.results.length === 0) return '';

  const c = computeComponents(latest);
  const uvi = computeUVI(c);
  const breakdown = computeUVIBreakdown(c);

  const tone = uvi >= 70 ? 'good' : uvi >= 40 ? 'warn' : uvi > 0 ? 'bad' : 'muted';
  const verdict = uvi >= 70 ? 'STRONG' : uvi >= 40 ? 'PRESENT' : uvi > 0 ? 'EMERGING' : 'INVISIBLE';

  const componentRow = (label, value, weight, hint) => {
    // Null = signal absent this run (e.g. no rank/no signal-bearing sentiment).
    // Render «— (not measured this run)» so the reader sees an explicit gap
    // rather than a 0 that could be confused with "measured and zero".
    if (value === null || value === undefined) {
      return `| **${label}** | <span class="rate-text" data-tone="muted">—</span> | ${(weight * 100).toFixed(0)}% | <span class="share-bar" data-tone="muted" style="--bar-w:2%"></span> | ${hint} (not measured this run) |`;
    }
    const t = value >= 60 ? 'good' : value >= 25 ? 'warn' : value > 0 ? 'bad' : 'muted';
    const barW = Math.max(2, value);
    return `| **${label}** | <span class="rate-text" data-tone="${t}">${value}/100</span> | ${(weight * 100).toFixed(0)}% | <span class="share-bar" data-tone="${t}" style="--bar-w:${barW}%"></span> | ${hint} |`;
  };

  // Sentiment hint surfaces the effective sample size so a 70/100 backed by
  // n=2 high-confidence cells reads honestly. n=0 is rendered by componentRow
  // as the muted «not measured this run» variant.
  const sentimentHint = (c.sentimentSample || 0) > 0
    ? `avg tone (50 = neutral) · n=${c.sentimentSample} high-confidence cell${c.sentimentSample === 1 ? '' : 's'}`
    : 'avg tone (50 = neutral)';
  // AP-PROSE-RANK — when some ranked cells came from PROSE ordinals (softer,
  // LLM-extracted, down-weighted) rather than explicit list positions, say so
  // in the hint so a reader knows part of the rank axis is the weaker signal.
  // proseRankSample=0 → string is byte-identical to the pre-feature hint (R39).
  const proseN = c.proseRankSample || 0;
  const rankHint = (c.rankSample || 0) > 0
    ? `avg position strength when listed · n=${c.rankSample}`
      + (proseN > 0 ? ` (incl. ${proseN} from prose, lower confidence)` : '')
    : 'avg position strength when listed';

  // AP-MEASURE-SAMPLING-CI — when the run sampled cells (each carries a
  // `presence` object), surface the aggregate trial count + a pooled Wilson CI
  // on the presence axis so a 67/100 backed by 2-of-3 trials reads honestly.
  // Single-shot runs have no presence objects → presenceHint stays the plain
  // string and the render is byte-identical to before (R39).
  const presenceHint = sampledPresenceHint(latest) || 'share of cells where brand was mentioned';

  const rows = [
    componentRow('Presence',  c.presence,  0.35, presenceHint),
    componentRow('Sentiment', c.sentiment, 0.25, sentimentHint),
    componentRow('Rank',      c.rank,      0.20, rankHint),
    componentRow('Citation',  c.citation,  0.20, 'share of cells with brand domain in citations'),
  ].join('\n');

  const popover = renderUVIBreakdownPopover(breakdown, { public: publicMode });

  // --public drops the source-path provenance ("weights are defined in
  // `lib/…`") while keeping the interpretive guidance — leak-free hosted proof.
  const weightsNote = publicMode
    ? `_The UVI is a transparent composite. Use the per-component scores to spot which dimension dragged the index down: low **Presence** → invest in citations, low **Sentiment** → PR work, low **Rank** → competitor displacement, low **Citation** → site-level discoverability._`
    : `_The UVI is a transparent composite — weights are defined in \`lib/report/visibility-index.js\`. Use the per-component scores to spot which dimension dragged the index down: low **Presence** → invest in citations, low **Sentiment** → PR work, low **Rank** → competitor displacement, low **Citation** → site-level discoverability._`;

  return `## Unified Visibility Index (UVI)

<div class="score-block">
<div class="score-block-label">Unified Visibility Index</div>
<div class="score-block-num" data-tone="${tone}">${uvi}<span class="score-block-frac"> / 100</span></div>
<div class="score-block-verdict" data-tone="${tone}">${verdict}</div>
<div class="score-block-meta">Composite of 4 signals · sample size ${c.sample} cell${c.sample !== 1 ? 's' : ''}${latest.sampling?.samples > 1 ? ` · ${latest.sampling.samples} trials/cell` : ''}</div>
</div>

${popover}

| Component | Score | Weight | | Meaning |
|---|---:|---:|---|---|
${rows}

${weightsNote}
`;
}

// ─── Section: Score Representativeness (AP-FIX-SCORE-SEGMENT) ───
//
// Gcore root-cause 2026-06-17: «Score: 0%» was rendered as a hard fact with no
// context for how representative the basket was. A headline of 0% (or any
// number) means very different things at n=3 cells vs n=39, and on a basket
// that touches 1 of a brand's 6 product lines vs all 6. This section adds
// CONTEXT around the headline — it never recomputes or restates the score, and
// the UVI math in visibility-index.js is untouched.
//
// Three additive blocks, each emitted only when its data exists:
//   1. Small-N warning      — when too few non-error cells to generalise.
//   2. Coverage line        — «basket covers X of N product lines» (reuses
//                             deriveProductLines on the own-domain headings the
//                             report already caches in pageSignals).
//   3. Fit segmentation     — core vs adjacent/aspirational hit-rate, ONLY when
//                             results carry a brandFit label (see wiring note
//                             below). Absent that label the block is skipped —
//                             never fabricated.

/**
 * Threshold below which a basket is too small to read the headline as
 * representative. 9 = the default 3-query × 3-engine grid: at or below it, one
 * cell flipping moves the headline >11pp, so «0%» / «100%» are noise-dominated.
 * Above it the warning is suppressed (the basket is wide enough to generalise,
 * modulo coverage — which the coverage line covers separately).
 */
export const SMALL_N_CELL_THRESHOLD = 9;

/**
 * Adapt the report's cached `pageSignals` ({ h1: { samples }, h2: { samples } })
 * into the `{ h1: [], h2: [] }` shape deriveProductLines expects. Pure. Returns
 * null when no headings were captured — the caller then omits the coverage line
 * rather than claiming «0 of 0 lines».
 */
export function productLinesFromPageSignals(pageSignals) {
  if (!pageSignals) return null;
  const h2 = Array.isArray(pageSignals?.h2?.samples) ? pageSignals.h2.samples : [];
  const h1 = Array.isArray(pageSignals?.h1?.samples) ? pageSignals.h1.samples : [];
  if (h2.length === 0 && h1.length === 0) return null;
  const derived = deriveProductLines({ h1, h2 });
  return derived.degraded ? null : derived;
}

/**
 * Tokenise a query the same way brand-fit.js does (token overlap, not naive
 * substring) so the coverage measure matches the classifier's own semantics.
 * Local copy keeps this section dependency-light and the import surface small;
 * kept in lockstep with brand-fit.js STOPWORDS by intent (drift is caught by
 * the shared coverage test).
 */
const COVERAGE_STOPWORDS = new Set([
  'for', 'the', 'and', 'with', 'best', 'top', 'tools', 'tool', 'services',
  'service', 'platform', 'platforms', 'software', 'solution', 'solutions',
  'company', 'companies', 'vendor', 'vendors', 'provider', 'providers',
  'a', 'an', 'of', 'in', 'to', 'your', 'how', 'what', '2025', '2026', '2027',
]);

function coverageTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(t => t.length >= 3 && !COVERAGE_STOPWORDS.has(t));
}

/**
 * How many of the brand's product lines the active query basket touches, by
 * token overlap. Pure. `lines` from deriveProductLines, `queryTexts` the unique
 * query strings this run. Returns { covered, total } — the numerator/denominator
 * for the coverage line. total===0 → caller omits the line.
 */
export function coverageOfProductLines(lines, queryTexts) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (list.length === 0) return { covered: 0, total: 0 };
  const qTokenSets = (Array.isArray(queryTexts) ? queryTexts : []).map(q => new Set(coverageTokens(q)));
  let covered = 0;
  for (const line of list) {
    const lTokens = coverageTokens(line);
    const hit = lTokens.length > 0 && qTokenSets.some(qs => lTokens.some(t => qs.has(t)));
    if (hit) covered++;
  }
  return { covered, total: list.length };
}

/**
 * Aggregate hit-rate per brand-fit bucket from `results[].brandFit`. Pure.
 * Returns { core, adjacent, aspirational, unknown } where each present bucket is
 * { total, mentions, rate } — and absent buckets are omitted. Empty object when
 * no result carries a brandFit label (the un-wired default — see section note).
 */
export function segmentByBrandFit(results) {
  const rows = (Array.isArray(results) ? results : []).filter(r => r && r.mention !== 'error' && typeof r.brandFit === 'string' && r.brandFit);
  if (rows.length === 0) return {};
  const acc = {};
  for (const r of rows) {
    const key = r.brandFit.toLowerCase();
    if (!acc[key]) acc[key] = { total: 0, mentions: 0 };
    acc[key].total++;
    if (r.mention === 'yes' || r.mention === 'src') acc[key].mentions++;
  }
  for (const k of Object.keys(acc)) {
    acc[k].rate = acc[k].total > 0 ? Math.round((acc[k].mentions / acc[k].total) * 100) : 0;
  }
  return acc;
}

export function sectionScoreRepresentativeness(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  if (!latest || !Array.isArray(latest.results) || latest.results.length === 0) return '';

  const cells = latest.results.filter(r => r.mention !== 'error');
  const n = cells.length;
  if (n === 0) return '';

  const blocks = [];

  // ── Block 1: small-N representativeness warning ──
  // The headline reads very differently at n=9 (one flip = ~11pp) than at n=39.
  // Below the threshold, label the score as a low-confidence reading, not a fact.
  if (n <= SMALL_N_CELL_THRESHOLD) {
    blocks.push(
      `> **Small sample — read the headline as a signal, not a verdict.** This run measured **${n} cell${n === 1 ? '' : 's'}** ` +
      `(queries × engines). At this size a single answer flipping moves the headline by roughly ${Math.round(100 / n)}pp, ` +
      `so a very high or very low score can be an artefact of the basket. Widen the basket (more queries / more engines) for a reading you can trust over time.`
    );
  }

  // ── Block 2: product-line coverage ──
  // «The basket covers X of N product lines the brand actually sells.» Low
  // coverage is the Gcore failure mode: a 0% that only ever asked about lines
  // the brand is weak in. Reuses deriveProductLines via the own-domain headings
  // the report already cached (pageSignals); silent when headings unavailable.
  const lines = productLinesFromPageSignals(latest.pageSignals);
  if (lines && lines.lines.length > 0) {
    const queryTexts = [...new Set(latest.results.map(r => r.queryText || r.query).filter(Boolean))];
    const { covered, total } = coverageOfProductLines(lines.lines, queryTexts);
    if (total > 0) {
      const pct = Math.round((covered / total) * 100);
      const tone = pct >= 60 ? 'good' : pct >= 25 ? 'warn' : 'bad';
      const verdict = covered === total ? 'full coverage' : covered === 0 ? 'no overlap' : `${pct}% of lines`;
      blocks.push(
        `**Basket coverage:** your queries touch **${covered} of ${total}** product line${total === 1 ? '' : 's'} ` +
        `we detected on \`${escMd(latest.domain || 'your site')}\` (<span class="rate-text" data-tone="${tone}">${verdict}</span>). ` +
        (covered < total
          ? `Lines no query asks about can't score — a low headline may reflect basket coverage, not invisibility. Detected lines: ${lines.lines.slice(0, 8).map(l => `\`${escMd(l)}\``).join(', ')}.`
          : `Every detected line is represented in the basket.`)
      );
    }
  }

  // ── Block 3: core vs aspirational segmentation ──
  // Only renders when results carry a brandFit label. WIRING (AP-SEGMENT-LIVE,
  // now LIVE): init classifies each selected query's brand-fit and
  // `attachBrandFit` (lib/config/queries-normalize.js) stamps the label onto the
  // saved basket; `run` reads it back via normalizeQueries and the result-attach
  // in bin/aeo-tracker.js (queryBrandFits) copies it onto each cell — so this
  // block wakes whenever the active basket carries fit labels. It stays
  // GRACEFULLY DORMANT (skipped, never fabricated) on the two back-compat paths:
  // a legacy string-only basket where nothing was classified (attachBrandFit
  // leaves those entries bare strings), and any pre-AP-SEGMENT-LIVE _summary.json
  // whose cells predate the brandFit field.
  const seg = segmentByBrandFit(latest.results);
  const segKeys = Object.keys(seg);
  if (segKeys.length > 0) {
    const ORDER = ['core', 'adjacent', 'aspirational', 'unknown'];
    const LABELS = {
      core: 'Core (brand sells this)',
      adjacent: 'Adjacent (plausible-but-secondary)',
      aspirational: 'Aspirational (not a core player)',
      unknown: 'Unknown (not classified)',
    };
    const ordered = ORDER.filter(k => seg[k]);
    const rows = ordered.map(k => {
      const b = seg[k];
      const tone = b.rate >= 60 ? 'good' : b.rate >= 25 ? 'warn' : b.rate > 0 ? 'bad' : 'muted';
      const barW = Math.max(2, b.rate);
      const bar = `<span class="share-bar" data-tone="${tone}" style="--bar-w:${barW}%"></span>`;
      return `| **${LABELS[k]}** | ${b.mentions}/${b.total} | <span class="rate-text" data-tone="${tone}">${b.rate}%</span> | ${bar} |`;
    }).join('\n');
    const coreNote = seg.core
      ? `Your **core** hit-rate is the number that matters most — it measures visibility where the brand genuinely competes. `
      : `No core-fit queries in this basket — the headline is dominated by adjacent/aspirational ground. `;
    blocks.push(
      `**Score by brand-capability fit:**\n\n` +
      `| Fit | Hits | Rate | |\n|---|---|---|---|\n${rows}\n\n` +
      `${coreNote}A low headline driven by aspirational rows is expected, not a regression.`
    );
  }

  if (blocks.length === 0) return '';

  return `## How representative is this score?

_Context for the headline above — none of this changes the score, it tells you how much weight to put on it._

${blocks.join('\n\n')}
`;
}

// ─── Section: AI-Bot Crawl Readiness (NEW v0.5, renamed in v0.3.2) ───
//
// Composite score derived from crawlability audit data plus the cached
// page-signals crawl. No extra fetches — summarises TECHNICAL access
// (robots.txt, AI-bot allowlist, sitemap.xml, content served in HTML) for AI
// crawlers. Previously labelled «Discoverability Score», which oversold what
// the signal actually measures: a 100/100 here means AI bots CAN crawl the
// site, not that AI engines DO cite it. Actual answer-pool inclusion depends on
// off-page authority (Wikipedia / Reddit / review platforms) — see
// «Authority-Source Presence» elsewhere in the report.
//
// AP-DEAD-TACTIC-LLMSTXT (2026-08-02): the fourth axis was «/llms.txt present»
// at 20%. It is gone from the score — rationale and the non-regression
// arithmetic live next to the weights in visibility-index.js.

const READINESS_AXIS_LABELS = {
  robots: 'robots.txt',
  bots: 'AI-bot access',
  sitemap: 'sitemap.xml',
  serverRendered: 'content in served HTML',
};

export function sectionDiscoverability(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const result = computeDiscoverability(latest?.crawlability, latest?.pageSignals);
  if (!result) return '';

  const tone = result.score >= 70 ? 'good' : result.score >= 40 ? 'warn' : 'bad';
  const rows = Object.entries(result.breakdown).map(([key, b]) => {
    const label = READINESS_AXIS_LABELS[key] || key;
    // An unmeasured axis (value null) is shown as «not measured», never as 0 —
    // and its weight column shows «—» because the weight was redistributed
    // across the axes that WERE measured (same contract as the UVI section).
    if (b.value === null) {
      return `| **${label}** | <span class="rate-text" data-tone="muted">not measured</span> | — | ${b.note} |`;
    }
    const t = b.value >= 60 ? 'good' : b.value >= 25 ? 'warn' : 'bad';
    const shownWeight = b.appliedWeight ?? b.weight;
    return `| **${label}** | <span class="rate-text" data-tone="${t}">${b.value}/100</span> | ${(shownWeight * 100).toFixed(0)}% | ${b.note} |`;
  }).join('\n');

  return `## AI-Bot Crawl Readiness

<div class="score-block score-block-row">
<div class="score-block-num" data-tone="${tone}">${result.score}<span class="score-block-frac">/100</span></div>
<div class="score-block-body">
<div class="score-block-body-title">Technical access for AI crawlers</div>
<div class="score-block-body-note">Derived from robots.txt, the AI bot access matrix, sitemap.xml, and whether your homepage content arrives in the served HTML — no extra HTTP requests beyond the audit.</div>
</div>
</div>

_This measures TECHNICAL access for AI crawlers. Actual visibility in AI answers depends on off-page authority (Wikipedia / Reddit / review platforms) — see «Authority-Source Presence» below._

| Signal | Score | Weight | Note |
|---|---:|---:|---|
${rows}
`;
}

// ─── Section: Topic Clusters (NEW v0.5) ───
//
// Groups queries by shared content words → per-cluster visibility. Surfer's
// "Topical Map" framing made open and free. AEO is a cluster game, not a
// query game — fixing one query fixes the cluster.

/**
 * Minimum number of topic clusters before the section renders meaningfully.
 * A single cluster covering 100% of queries is by definition not a cluster —
 * it's the whole brand. Two clusters can still be a coincidence of shared
 * words. The framing only carries weight at ≥3, where the reader can
 * actually compare visibility across groups.
 */
export const TOPIC_CLUSTER_MIN = 3;

export function sectionTopicClusters(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const clusters = clusterQueries(latest);
  if (clusters.length === 0) return '';
  if (clusters.length === 1 && clusters[0].topic === 'uncategorised') return '';
  // A single cluster is the whole brand, not a cluster. Two clusters are
  // noise-prone. Suppress the section below TOPIC_CLUSTER_MIN — data still
  // ships in `_summary.json::topics` for export consumers / MC metadata.
  if (clusters.length < TOPIC_CLUSTER_MIN) return '';

  const rows = clusters.map(cl => {
    const t = cl.rate >= 60 ? 'good' : cl.rate >= 25 ? 'warn' : cl.rate > 0 ? 'bad' : 'muted';
    const exampleQueries = cl.queries.slice(0, 3).map(q => `<code>${escMd(q.text.slice(0, 50)).replace(/\|/g, '\\|')}${q.text.length > 50 ? '…' : ''}</code>`).join(' · ');
    return `| **${escMd(cl.topic)}** | ${cl.queries.length} | <span class="rate-text" data-tone="${t}">${cl.rate}%</span> (${cl.hits}/${cl.total}) | ${exampleQueries} |`;
  }).join('\n');

  return `## Topical Visibility Clusters

_Queries grouped by shared content words → visibility at the cluster level. AEO is a cluster game: fixing one query usually fixes the whole topic. Cluster keys are the most-frequent shared word across each group._

| Topic | Queries | Visibility | Examples |
|---|---:|---|---|
${rows}
`;
}

// ─── Section: Authority Presence (NEW v0.6) ───
//
// Wikipedia + Reddit presence. Off-page signals AI engines weight heavily.
// Free public APIs, cached in _summary.json::authorityPresence.

/**
 * Renders the Authority-Source Presence cell (Wikipedia + Reddit status).
 *
 * Reads `snapshots[-1].authorityPresence` (free-API scan, cached). Returns
 * '' when scan didn't run (e.g. report --no-authority flag).
 *
 * Output uses `.auth-badge[data-tone="good|warn|bad"]` CSS classes so badge
 * colours bind to report tokens (--good / --warn / --bad). Replaces v0.5
 * inline Tailwind hex (#fef9c3 / #dcfce7 / #fee2e2) which outshone the
 * warm-paper system.
 *
 * Security: Wikipedia extract is third-party text — passed through escMd()
 * before HTML interpolation.
 *
 * @param {Array} snapshots — chronological runs; last element carries
 *   `authorityPresence: { wikipedia, reddit }` shape.
 * @returns {string} markdown+HTML string, or '' when no authority data.
 */
/**
 * Per-source row builders. Each returns `{ label, badge, detail, tips }`
 * for the table. Adding a new source = adding one builder here. The
 * orchestrator already returns an additive shape — new sources appear
 * as extra keys (e.g. `ap.hn`, `ap.devto`) and only render if present.
 */
const SOURCE_BUILDERS = {
  wikipedia: (src, profile) => {
    if (!src) return null;
    const badge = src.found
      ? (src.isDisambiguation
          ? `<span class="auth-badge" data-tone="warn">⚠ Disambiguation page</span>`
          : `<span class="auth-badge" data-tone="good">✓ Article exists</span>`)
      : `<span class="auth-badge" data-tone="bad">✗ No article</span>`;
    const link = src.found
      ? `[View on Wikipedia](${src.pageUrl})`
      : `[Create one](${src.queryUrl || 'https://en.wikipedia.org/wiki/Wikipedia:Your_first_article'})`;
    const extract = src.found && src.extract
      ? `<br/><span class="auth-extract">"${escMd(src.extract)}…"</span>`
      : '';
    const tips = [];
    // Wikipedia "earn coverage" advice is not actionable for dev-tools —
    // a CLI/SDK rarely meets WP:NCORP notability. The caveat note above
    // the table already explains why the ✗ is expected for this segment;
    // surfacing the tip too is noise. Disambiguation tip stays because it's
    // a real fixable problem regardless of segment.
    if (!src.found && profile?.type !== 'dev-tool') {
      tips.push('No Wikipedia article — earn coverage in 3+ independent reliable sources first, then a third party can create one (you cannot create your own per WP:COI).');
    }
    if (src.isDisambiguation) tips.push('Wikipedia entry is a disambiguation — your brand competes for the term. Earn enough notability to claim the primary topic.');
    return { label: 'Wikipedia', badge, detail: `${link}${extract}`, tips };
  },

  reddit: (src, profile) => {
    if (!src) return null;
    const badge = src.found
      ? `<span class="auth-badge" data-tone="good">✓ ${src.mentionCount}${src.capped ? '+' : ''} posts</span>`
      : `<span class="auth-badge" data-tone="bad">✗ Not discussed</span>`;
    const detail = (src.topSubs || []).map(s => `<code>r/${escMd(s.name)}</code> (${s.count})`).join(' · ')
      || '<span class="auth-empty">No discussion yet — see hints below</span>';
    // Reddit advice is segment-specific. Dev-tools should hit r/programming /
    // r/webdev / r/devops; consumer brands their category subs. The generic
    // "find subreddits in your category" wording works for both — keep tip
    // even for dev-tool because it's still actionable (unlike Wikipedia for
    // dev-tools).
    const tips = src.found
      ? []
      : ['No Reddit discussion — find subreddits in your category (search bar) and answer questions with verifiable expertise. Do not spam.'];
    return { label: 'Reddit', badge, detail, tips };
  },

  github: (src) => {
    if (!src) return null;
    const tips = [];
    let badge, detail;
    if (src.found && src.topRepo) {
      const r = src.topRepo;
      // Tone: "good" only when there's real traction (≥10 stars OR a namesake
      // repo). A 0-star non-namesake side project is a weak signal — surface
      // it as "warn" so the row reads honestly.
      const hasTraction = (r.stars >= 10) || r.namesake;
      const tone = hasTraction ? 'good' : 'warn';
      const flagshipNote = r.namesake ? ' · flagship' : '';
      badge = `<span class="auth-badge" data-tone="${tone}">${tone === 'good' ? '✓' : '◐'} ${r.stars} ★ · ${r.forks} forks${flagshipNote}</span>`;
      detail = `[${escMd(r.fullName)}](${r.url})${r.description ? `<br/><span class="auth-extract">"${escMd(r.description)}…"</span>` : ''}`;
      // If we couldn't find the namesake repo, hint that the org has activity
      // but no flagship — the actionable next step is ranking up the brand's
      // primary repo.
      if (!r.namesake && r.stars < 10) {
        tips.push('GitHub org exists but the flagship repo isn\'t earning stars yet. Pin the brand\'s primary repo (rename to match the brand if needed) and seed it with a strong README + demo.');
      }
    } else if (src.found) {
      badge = `<span class="auth-badge" data-tone="warn">◐ org exists, no repos</span>`;
      detail = `[${escMd(src.owner)}](${src.ownerUrl})`;
      tips.push('GitHub org exists but no public repos — ship the brand\'s flagship project as open-source. AI engines weight GitHub stars as authority for dev-tool brands.');
    } else {
      badge = `<span class="auth-badge" data-tone="bad">✗ No org found</span>`;
      detail = '<span class="auth-empty">Reserve the org name; ship a public repo for AI engines to index.</span>';
      tips.push('No GitHub org under the brand slug — reserve it (free) and publish a public repo. AI engines weight GitHub presence heavily for dev-tool brands.');
    }
    if (src.error && /rate-limited/i.test(src.error)) {
      tips.push('GitHub API rate-limited unauthenticated (60/h). Set GITHUB_TOKEN env var for 5000/h.');
    }
    return { label: 'GitHub', badge, detail, tips };
  },
};

// Stable order so a dev-tool report reads: GitHub (primary) → Wikipedia →
// Reddit (rarely populated for this segment). For default profile the wiki
// remains first.
function sourceOrder(profileType) {
  if (profileType === 'dev-tool') return ['github', 'wikipedia', 'reddit'];
  return ['wikipedia', 'reddit', 'github'];
}

export function sectionAuthorityPresence(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const ap = latest.authorityPresence;
  if (!ap) return '';

  // Profile may be absent on cached snapshots from before the additive
  // upgrade. Fall back to legacy display (wiki+reddit only) — never crash
  // on missing fields. New shape: `ap.profile = {type, extras, caveat}`.
  const profile = ap.profile || { type: 'default', extras: [], caveat: '' };

  // Build rows for every present source in stable order.
  const order = sourceOrder(profile.type);
  const rows = [];
  const allTips = [];
  for (const key of order) {
    const build = SOURCE_BUILDERS[key];
    if (!build) continue;
    const built = build(ap[key], profile);
    if (!built) continue;
    rows.push(`| **${built.label}** | ${built.badge} | ${built.detail} |`);
    allTips.push(...built.tips);
  }

  // Profile caveat — a one-liner sitting just above the table that frames
  // why some rows look "bad" for a segment (e.g. dev tools rarely have
  // Wikipedia articles, so the ✗ is not a real authority gap).
  //
  // Only render when the framing is actually relevant: for dev-tool the
  // caveat helps explain wiki/reddit ✗ — but if wiki OR reddit found, the
  // caveat reads as a false statement («rarely populated» while staring
  // at the populated row). Suppress in that case.
  const wikiFound  = ap.wikipedia && ap.wikipedia.found;
  const redditFound= ap.reddit    && ap.reddit.found;
  const caveatStillRelevant = profile.caveat && !wikiFound && !redditFound;
  const caveat = caveatStillRelevant
    ? `\n\n<p class="auth-caveat">${escMd(profile.caveat)}</p>`
    : '';

  // Tips rendered static (no <details>) so the section stays consistent
  // with the rest of the 2026 editorial report. Each source contributes
  // its own tips; the orchestrator collects them in source order.
  let advisory = '';
  if (allTips.length > 0) {
    // Plain `<li>` (no emoji bullet) — editorial 2026 lets typography carry
    // the visual weight via .auth-advisory-head + .auth-tips list-style
    // tokens. The 💡-prefix from v0.5 read as 2022 «friendly tutorial».
    const tipItems = allTips.map(t => `<li>${t}</li>`).join('');
    advisory = `\n<div class="auth-advisory"><h4 class="auth-advisory-head">Why this matters · ${allTips.length} hint${allTips.length !== 1 ? 's' : ''}</h4><ul class="auth-tips">${tipItems}</ul></div>\n`;
  }

  return `## Authority-Source Presence

_Off-page signals AI engines weight heavily — they're part of the ground-truth corpus most LLMs trained on._${caveat}

| Source | Status | Detail |
|---|---|---|
${rows.join('\n')}
${advisory}`;
}

// ─── Section: AI Ads Detection (NEW v0.6) ───
//
// Heuristic disclosure scan. Flags responses that include sponsored markers
// or ad-network citations. Precision-over-recall — false positives undermine
// the signal, so we only count what's explicitly disclosed.

/**
 * Renders the AI Ads / Sponsored-Content Detection section.
 *
 * Reads `snapshots[-1].adsDetected` (heuristic scan output). Returns '' when
 * the scan didn't run. When 0 ad signals found, renders a «scanned, clean»
 * stanza; when ≥1, renders a per-provider summary + up to 5 sample blocks
 * via `.ads-sample` CSS class (warn-tinted, report tokens).
 *
 * Sample-block markup replaces v0.5 inline Tailwind palette (#fef9c3
 * + #854d0e + #1e293b) — see Tech Debt entry.
 *
 * Security: snippet content originates from LLM responses; escMd() applied.
 *
 * @param {Array} snapshots — chronological runs; last carries `adsDetected`.
 * @returns {string} markdown+HTML string, or '' when no ads-scan data.
 */
export function sectionAdsDetection(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const ads = latest.adsDetected;
  if (!ads) return '';

  // Never-fail guard (AP-ALLNO-RENDER-CRASH). A fully-invisible 0% run — the
  // reader who needs this report most — used to crash the whole report here:
  // a present-but-shapeless `adsDetected` (empty object, an array, or a partial
  // record from an interrupted/older-schema run) has no numeric counters, so
  // `totalCellsWithAdSignal === 0` was false and `Object.entries(ads.byProvider)`
  // threw on the undefined map. Treat any non-conforming shape as "scan did not
  // produce a usable signal map" and degrade to the honest "scanned, clean"
  // stanza instead of throwing. The well-formed path (a real byProvider object
  // with a positive signal count) is untouched (R39).
  const scanned = Number(ads.totalCellsScanned) || 0;
  const byProvider = ads.byProvider;
  const hasUsableSignal = ads.totalCellsWithAdSignal > 0
    && byProvider != null
    && typeof byProvider === 'object'
    && !Array.isArray(byProvider);

  if (!hasUsableSignal) {
    return `## AI Ads / Sponsored-Content Detection

_${scanned} cell${scanned !== 1 ? 's' : ''} scanned for sponsored markers and ad-network citations — none found this run. As AI engines roll out ad inventory, this section will surface paid placements automatically._
`;
  }

  const providerRows = Object.entries(byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([p, count]) => `| ${providerLabel(p)} | ${count} cell${count !== 1 ? 's' : ''} |`)
    .join('\n');

  // Ad-sample blocks — bound to .ads-sample CSS class (report tokens).
  // Replaces v0.5 inline Tailwind (#fef9c3 yellow + #854d0e + #1e293b)
  // with --warn-soft / --warn / --ink-2 so samples sit in the warm-paper
  // system instead of looking like an embedded Notion callout.
  const sampleBlocks = (ads.samples || []).slice(0, 5).map(s => {
    const snip = escMd(s.snippet || '');
    return `<div class="ads-sample">
  <div class="ads-sample-meta">${providerLabel(s.provider)} · ${escMd(s.query)} · <code class="ads-sample-kind">${escMd(s.kind)}</code></div>
  <div class="ads-sample-snip">"${snip}"</div>
</div>`;
  }).join('');

  return `## AI Ads / Sponsored-Content Detection

_${ads.totalCellsWithAdSignal} of ${ads.totalCellsScanned} cells contained an ad signal — sponsored markers in the response text or ad-network citations. As AI engines roll out commercial inventory, distinguishing paid from organic citations becomes critical._

| Engine | Cells with ad signal |
|---|---|
${providerRows}

${sampleBlocks}
`;
}

// ─── Section: UTM Citation Tracker (NEW v0.6, reframed in v0.3.2) ───
//
// Surfaces UTM-tagged URLs from the user's own domain when AI engines cite
// them. Critically: AI engines like OpenAI auto-append `utm_source=openai`
// to outbound citation URLs. The previous wording implied the user had
// configured those UTMs and was reaping AEO attribution — false. This
// section now distinguishes:
//   • engine-auto-tagged sources (openai / anthropic / google / perplexity /
//     gemini / claude / chatgpt) — engine-side attribution the user didn't
//     set; useful for matching GA4 sessions to AI-engine referrals
//   • user-configured sources — anything else, kept as a separate sub-table
//     with the original framing
// Empty (no UTMs detected anywhere) → section omitted.

// Provider-name utm_source values known to be auto-appended by AI engines.
// Matched case-insensitively against bare utm_source. Keep narrow — anything
// here implies "the user did not configure this".
const ENGINE_AUTO_UTM_SOURCES = new Set([
  'openai', 'chatgpt',
  'anthropic', 'claude',
  'google', 'gemini',
  'perplexity',
]);

/**
 * Partition UTM rows / samples into engine-auto vs user-configured by
 * inspecting the `utm_source` value against the known AI-engine list.
 * Pure helper — exported for tests.
 *
 * @param {ReturnType<typeof aggregateUtmCitations>} utm
 * @returns {{ engineAuto: object, userConfigured: object }}
 */
export function splitUtmByOrigin(utm) {
  const isEngine = (src) => ENGINE_AUTO_UTM_SOURCES.has(String(src || '').toLowerCase());
  const engineAuto = {
    bySource:   utm.bySource.filter(s => isEngine(s.source)),
    byCampaign: [],
    samples:    utm.samples.filter(s => isEngine(s.source)),
  };
  const userConfigured = {
    bySource:   utm.bySource.filter(s => !isEngine(s.source)),
    byCampaign: [],
    samples:    utm.samples.filter(s => !isEngine(s.source)),
  };
  // Recompute byCampaign from the post-split samples so engine-side campaigns
  // don't bleed into the user-configured table (and vice-versa).
  const tally = (arr) => {
    const m = new Map();
    for (const s of arr) {
      const k = s.campaign || '(none)';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([campaign, count]) => ({ campaign, count }));
  };
  engineAuto.byCampaign     = tally(engineAuto.samples);
  userConfigured.byCampaign = tally(userConfigured.samples);
  engineAuto.totalCitations     = engineAuto.bySource.reduce((s, r) => s + r.count, 0);
  userConfigured.totalCitations = userConfigured.bySource.reduce((s, r) => s + r.count, 0);
  return { engineAuto, userConfigured };
}

export function sectionUtmCitations(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const utm = aggregateUtmCitations(latest.results, latest.domain);
  if (utm.totalUtmCitations === 0) return '';

  const { engineAuto, userConfigured } = splitUtmByOrigin(utm);

  const renderTable = (rows, headerKey, valueLabel) => {
    if (!rows.length) return `_No data._`;
    const body = rows.map(r => `| ${escMd(r[headerKey])} | ${r.count} |`).join('\n');
    return `| ${valueLabel} | Citations |\n|---|---:|\n${body}`;
  };

  const renderSamples = (samples) => {
    if (!samples.length) return '_No sample cells._';
    const body = samples.map(s =>
      `| ${providerLabel(s.provider)} | ${escMd(s.query)} | ${escMd(s.source) || '—'} | ${escMd(s.medium) || '—'} | ${escMd(s.campaign) || '—'} |`
    ).join('\n');
    return `| Engine | Query | Source | Medium | Campaign |\n|---|---|---|---|---|\n${body}`;
  };

  const blocks = [];

  if (engineAuto.totalCitations > 0) {
    const sourcesPretty = engineAuto.bySource
      .map(r => `\`utm_source=${r.source}\``)
      .join(', ');
    blocks.push(`### AI-engine-side attribution (auto-tagged)

_${engineAuto.totalCitations} citation${engineAuto.totalCitations !== 1 ? 's' : ''} to your domain ${engineAuto.totalCitations === 1 ? 'was' : 'were'} tagged by AI engines with their own \`utm_source\` parameter (${sourcesPretty}, e.g. OpenAI auto-appends \`utm_source=openai\`). This is engine-side attribution you did NOT set — useful for matching GA4 sessions to AI-engine referrals, not a sign that your UTM-tagging strategy is working._

#### By source
${renderTable(engineAuto.bySource, 'source', 'utm_source')}

#### By campaign
${renderTable(engineAuto.byCampaign, 'campaign', 'utm_campaign')}

#### Sample cells
${renderSamples(engineAuto.samples)}`);
  }

  if (userConfigured.totalCitations > 0) {
    blocks.push(`### Your own UTM-tagged pages cited by AI

_${userConfigured.totalCitations} citation${userConfigured.totalCitations !== 1 ? 's' : ''} on your own domain carried UTM parameters you configured. This is your AEO attribution table — pair with GA4 acquisition reports to close the loop._

#### By source
${renderTable(userConfigured.bySource, 'source', 'utm_source')}

#### By campaign
${renderTable(userConfigured.byCampaign, 'campaign', 'utm_campaign')}

#### Sample cells
${renderSamples(userConfigured.samples)}`);
  }

  if (!blocks.length) return '';

  return `## Engine-Auto-Tagged Citations

_AI engines (notably OpenAI) auto-append \`utm_source=openai\`-style parameters to outbound citation URLs. Those tagged URLs are surfaced below as engine-side attribution — they are NOT UTMs you configured. User-configured UTMs (if any) get their own sub-section._

${blocks.join('\n\n')}
`;
}

// ─── Section: Footer ───

export function sectionFooter(snapshots, lang = 'en', responsesPath = null) {
  const latest = snapshots[snapshots.length - 1];
  // Whitelist lang to the 4 webappski.com locales — mirrors sectionMcMetadataMd.
  // Prevents XSS/404 from raw config values interpolating into the footer URL.
  const ALLOWED_LANGS = new Set(['en', 'de', 'ru', 'pl']);
  const safeLang = ALLOWED_LANGS.has(lang) ? lang : 'en';
  const rawPath = responsesPath
    || `aeo-responses/${domainStorageSlug(latest.domain || '')}/${latest.date}`;
  return `---

### Need help getting cited by AI answer engines?

**[Webappski](https://webappski.com/${safeLang}/aeo-services)** is the AEO agency behind \`aeo-platform\`. We run weekly audits like this one, implement the kinds of actions this report recommends (third-party placements, comparison pages, authority building), and publish what we learn openly at [webappski.com/blog](https://webappski.com/${safeLang}/posts/aeo-visibility-challenge-week-1). If you want a second opinion on your numbers — or help turning them around — [talk to us](https://webappski.com/${safeLang}/aeo-services).

---

_Generated by aeo-platform. Raw responses: \`${escMd(rawPath)}/\`. Re-run: \`aeo-platform report\`._
`;
}

// ─── Section: AEO Mission Control bridge (markdown) ───
//
// Renders a "Generate metadata" section for the markdown report. Markdown
// can't have buttons / modals — so this is a static section with the JSON
// payload embedded in a fenced ```json block. Terminal users can `cat` /
// `grep` the report and copy the JSON manually. The HTML report renders an
// interactive bridge (see lib/report/mc-bridge.js).
//
// @param {Object[]} snapshots
// @param {Object} metadata     pre-built metadata payload (see mc-metadata.js)
// @returns {string} markdown
export function sectionMcMetadataMd(snapshots, metadata) {
  if (!metadata) return '';
  const queries = metadata.aggregates?.totalQueries ?? 0;
  const groundingNote = queries < 7
    ? `\n_⚠ Only ${queries} queries this run — for full plan grounding, expand additively: \`aeo-platform init --queries=10 --add-queries\`._`
    : queries < 10
    ? `\n_${queries} queries — enough to draft a plan; ≥10 unlocks full per-engine confidence._`
    : '';

  // Whitelist lang to the 4 webappski.com locales — closes both XSS surface
  // (raw .aeo-tracker.json values would otherwise interpolate into markdown link)
  // and 404 risk for unrouted langs (e.g. 'fr' → no /fr/ route on webappski.com).
  const ALLOWED_LANGS = new Set(['en', 'de', 'ru', 'pl']);
  const langRaw = metadata.identity?.lang;
  const lang = ALLOWED_LANGS.has(langRaw) ? langRaw : 'en';
  const json = JSON.stringify(metadata, null, 2);

  return `---

## Generate metadata for AEO Mission Control

Copy the JSON below and paste it into your project page at [webappski.com/${lang}/aeo-mission-control](https://webappski.com/${lang}/aeo-mission-control). Webappski generates a personalised 30-mission AEO plan (≈1–3 hours per mission, work at your pace) grounded in this exact data — turnaround 1-3 business days. Your raw responses, queries, and API spend stay on your machine. Only the metadata in this block is uploaded.${groundingNote}

\`\`\`json
${json}
\`\`\`

> 💡 Open the HTML report (\`aeo-platform report --html\`) for an interactive **Generate metadata** button with one-click clipboard copy.
`;
}

/**
 * The run verdict — the markdown surface's half of the loud register.
 *
 * The visual redesign does not translate to markdown: there is no colour, no
 * SVG and no card. The REGISTER does, and it is the part that carries meaning:
 *   * a conclusion sentence before any number,
 *   * one templated "where to act" line, never silently omitted,
 *   * coverage printed in place of a delta the record cannot support.
 *
 * Every figure is read from `buildRunMetrics`, the same module the HTML report
 * reads, so the two surfaces cannot disagree about what moved.
 *
 * The snapshots carry every figure this section needs — the per-run score
 * series and the domain are both derivable from them. `opts` carries only the
 * white-label gate, the same shape the neighbouring sections take
 * (`sectionCompetitors`, `sectionDomainShareOfVoice`, `sectionDomainCategories`,
 * `sectionCanonicalSources`, `sectionCrawlability`): a client snapshot drops
 * the one advisory sub-clause and keeps the statistics, rather than the whole
 * section losing copy the internal report should have.
 *
 * @param {Object[]} snapshots Ordered oldest -> newest.
 * @param {Object} [opts]
 * @param {boolean} [opts.whiteLabel] statistics-only client snapshot: drop the
 *        advisory half of the lift note (the HTML twin withholds the whole
 *        lift KPI card in the same mode).
 * @returns {string} markdown, or '' when there is nothing to conclude from.
 */
export function sectionRunVerdict(snapshots, opts = {}) {
  const whiteLabel = opts.whiteLabel === true;
  const snaps = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  if (snaps.length === 0) return '';
  const latest = snaps[snaps.length - 1];
  const summary = {
    trend: snaps.map(s => (Number.isFinite(s.score) ? s.score : null)),
    meta: {
      domain: latest.domain || '',
      prevDate: snaps.length > 1 ? snaps[snaps.length - 2].date : null,
    },
  };
  const runCount = snaps.length;
  const caps = trendCapabilities(runCount);
  const M = buildRunMetrics(summary, snaps);
  const history = buildAnswerHistory(snaps);
  const changed = headlineCell(history.cells);
  const prevDate = summary.meta?.prevDate || null;

  // Headline: the conclusion, then the number. Which conclusion, in which
  // words, is decided ONCE in run-metrics.js and shared with the HTML report —
  // this surface only drops the emphasis markup it has no way to render.
  const verdict = buildVerdictHeadline({
    index: M.index, changedCell: changed, fallbackScore: latest.score,
  });
  const headline = verdict.segments.map(seg => seg.text).join('');

  const lines = [`## The run in one page`, '', `**${escMd(headline)}**`, ''];

  // Supporting figures, each with its delta only where the record supports one.
  const fig = (metric, denom) => {
    const suffix = denom ? ` of ${denom}` : metric.unit === 'points' ? '%' : '';
    const value = metric.current == null ? '—' : `${metric.current}${suffix}`;
    const delta = caps.chips && metric.deltaPrev != null
      ? ` (${metric.chipText.replace('▲', 'up').replace('▼', 'down').replace('–', 'no change,')} vs ${escMd(prevDate || 'the previous run')})`
      : '';
    return `- **${escMd(metric.label)}:** ${value}${delta}`;
  };
  lines.push(fig(M.index, 100));
  lines.push(fig(M.presence, history.cells.length));
  lines.push(`- **Engines naming you everywhere:** ${M.engines.now.full} of ${M.engines.now.total}`);
  lines.push(fig(M.competitors));
  if (M.capsules.current != null) lines.push(fig(M.capsules));
  // The lift aggregate, from the same module the HTML hero reads: the figure,
  // then what it counts, then — in the internal report only — what to do about
  // it. Both halves come from `buildLiftNarrative`, the same call the HTML
  // hero KPI makes, so the surfaces state one sentence about one number.
  //
  // The advisory half is the only part a white-label snapshot withholds; the
  // statistics stay, because a client deliverable that silently loses a figure
  // reads as a broken report rather than as a withheld recommendation. (The
  // HTML twin withholds its whole lift KPI card instead — it is a card built
  // around the advice, with no statistics-only form to fall back to.)
  const lift = buildLiftOpportunity(latest);
  const liftNote = buildLiftNarrative(lift);
  lines.push(`- **Cited without being named:** ${lift.cited} of ${lift.total}`);
  lines.push('');
  lines.push(`_${whiteLabel ? liftNote.stat : `${liftNote.stat} ${liftNote.advisory}`}_`);
  lines.push('');

  // What the record cannot support — stated, not omitted.
  const shortCoverage = [];
  try {
    const currRows = computeUVIBreakdown(computeComponents(latest)).rows || [];
    const prevRows = snaps.length > 1
      ? (computeUVIBreakdown(computeComponents(snaps[snaps.length - 2])).rows || [])
      : [];
    const prevByKey = new Map(prevRows.map(r => [r.key, r]));
    for (const row of currRows) {
      if (row.sample?.basis === 'cells') continue;
      const cover = coverageAllowsDelta(row.sample, prevByKey.get(row.key)?.sample);
      if (!cover.allowed) {
        shortCoverage.push(`${row.label || row.key} (reported on ${row.sample?.n ?? 0} of ${row.sample?.denominator ?? 0} answers)`);
      }
    }
  } catch { /* breakdown unavailable — the caveat simply does not print */ }
  if (shortCoverage.length) {
    lines.push(`_${escMd(shortCoverage.join('; '))} — reported on too few answers this run, or on a population that moved too much between runs, to carry a change figure. The coverage is printed instead of a delta rather than implying movement the data cannot support._`);
    lines.push('');
  }

  // Where to act — always present, including when the answer is "nowhere yet".
  const mover = caps.whereToAct
    ? headlineMover(M, [], prevDate)
    : { text: `Movement is not called until run ${SHAPES_MIN_RUNS}. With ${runCount} run${runCount === 1 ? '' : 's'} on record this report states what is true today rather than what is trending.` };
  lines.push(`**Where to act.** ${escMd(mover.text)}`);
  lines.push('');
  return lines.join('\n');
}
