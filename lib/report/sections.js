import { heatmap, barchart, sparkline, deltaArrow, radar, combinedRadar } from '../svg/index.js';
import { extractQuotes } from './extract-quotes.js';
import { sentimentToScore } from './sentiment-classify.js';
import { aggregateByCategory } from './domain-category.js';
import { computeComponents, computeUVI, computeUVIBreakdown, computeDiscoverability } from './visibility-index.js';
import { clusterQueries } from './topic-cluster.js';
import { aggregateUtmCitations } from './utm-tracker.js';
import { isOwnDomain } from './own-domain.js';

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

${escMd(latest.domain)} · ${period} · generated ${generated}
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
    why: 'ChatGPT grounds answers in Bing search results. Review platforms and community Q&A are its highest-weight sources.',
    tips: [
      'Get listed on G2, Capterra, or Product Hunt — ChatGPT cites review platforms heavily',
      'Answer questions on Reddit and Quora with your tool mentioned by name',
      'Publish a comparison post (Your Tool vs Alternatives) on your blog or Medium',
    ],
  },
  gemini: {
    why: 'Gemini grounds responses in Google Search results. Domain authority and structured data carry more weight here than on other engines.',
    tips: [
      'Earn citations from high-DR sites Google already indexes for your keywords',
      'Add FAQ schema markup to your landing page (Gemini follows Google\u2019s structured data signals)',
      'Get featured in a roundup post on any high-authority tech blog or newsletter',
    ],
  },
  anthropic: {
    why: 'Claude uses training data (web crawl + curated sources) and Brave search. Developer ecosystems and product launch pages are over-represented in its training corpus.',
    tips: [
      'Publish on npm or create a GitHub repo \u2014 Claude\u2019s training data over-represents dev ecosystems',
      'Write a detailed post on dev.to or Medium: "How I built X with [Your Tool]"',
      'Launch on Product Hunt \u2014 PH pages are in Claude\u2019s training corpus',
    ],
  },
  perplexity: {
    why: 'Perplexity runs real-time multi-source web search. Freshness and breadth of coverage matter more than authority.',
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

export function sectionCompetitors(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const tracked = latest.topCompetitors || [];
  if (tracked.length === 0) return '';

  // Build YOU row first (accent), then competitors, sorted desc
  const you = { label: `YOU (${escMd(latest.brand)})`, value: latest.mentions || 0, accent: true };
  const compItems = tracked.slice(0, 8).map(c => ({ label: escMd(c.name), value: c.count }));
  const items = [you, ...compItems];

  return `## Competitors vs you

_Your brand's mention count vs each tracked competitor, counted across all checks this run. If a competitor dominates here, that's where AI-engine mindshare sits — invest your content/PR budget in closing the gap._

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

export function sectionCanonicalSources(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const sources = latest.topCanonicalSources || [];
  if (sources.length === 0) return '';

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
    return `## Where to get mentioned

_No high-authority outreach targets surfaced this run._
`;
  }

  const rows = grouped.map(g => {
    const meta = TYPE_META[g.type] || TYPE_META['blog'];
    const industry = industryByHost.get(g.host) || meta.label;
    return `| \`${escMd(g.host)}\` | ${meta.label} | ${escMd(industry)} | ${meta.action} |`;
  }).join('\n');

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

export function sectionDomainShareOfVoice(snapshots) {
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

  return `## Where AI Engines Get Their Answers — Domain Share of Voice

_The publishers AI cites when describing your category. Pitching the top 3 is the highest-leverage AEO move surfaced by the data — see "Outreach templates" section below for ready-to-send drafts._

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
export function sectionCrawlability(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const audit = latest.crawlability;
  if (!audit || !audit.botAccess) return '';

  const s = audit.summary;
  const fileCheck = (label, found, extra = '') => {
    const icon = found ? '✅' : '❌';
    const tone = found ? 'good' : 'bad';
    return `<span class="file-check" data-tone="${tone}">${icon} ${label}</span>${extra ? ` <span class="file-check-meta">${extra}</span>` : ''}`;
  };

  const fileLine = [
    fileCheck('robots.txt', s.hasRobots, audit.robots.bytes ? `(${audit.robots.bytes} bytes)` : ''),
    fileCheck('llms.txt',   s.hasLlmsTxt),
    fileCheck('sitemap.xml', s.hasSitemap, audit.sitemap.urlCount ? `(${audit.sitemap.urlCount} URLs)` : ''),
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

  let warning = '';
  if (s.blockedCount > 0) {
    const blockedNames = audit.botAccess.filter(b => b.access === 'blocked').map(b => b.label).join(', ');
    warning = `\n> ⚠️ **${s.blockedCount} bot${s.blockedCount !== 1 ? 's' : ''} blocked by robots.txt** — ${blockedNames}. These engines cannot crawl your site, so they cannot cite you. Fix in your \`robots.txt\` before content investment.\n`;
  }
  if (!s.hasLlmsTxt) {
    warning += `\n> 💡 No \`/llms.txt\` found — emerging convention for LLM-friendly summaries. Adding one (5 min) gives engines a fast-path to your key facts. See [llmstxt.org](https://llmstxt.org).\n`;
  }

  return `## AI-Bot Crawlability Audit

_${fileLine}_
${warning}
| AI Engine | Bots & Access |
|---|---|
${rows}

_Source: \`${audit.robots.url}\` (HTTP ${audit.robots.status ?? 'n/a'}). Re-audit on every \`aeo-platform report\`._
`;
}

// ─── Section: Domain Category Breakdown (NEW v0.4) ───
//
// Aggregates topDomains by static-rule classification (Reviews / Forums /
// News / Reference / etc.) into a single table. Each category includes a
// "what to do" hint that tells the user the outreach modality for that
// bucket — pitching G2 (review) is a different play than pitching Reddit
// (forum) or Wikipedia (reference).

export function sectionDomainCategories(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const topDomains = latest.topDomains;
  if (!Array.isArray(topDomains) || topDomains.length === 0) return '';

  const categories = aggregateByCategory(topDomains);
  if (categories.length === 0) return '';

  const rows = categories.map(cat => {
    const pct = (cat.share * 100).toFixed(1);
    const examples = cat.domains.slice(0, 3).map(d => escMd(d.host)).join(', ');
    const more = cat.domains.length > 3 ? ` <span class="dom-more">+${cat.domains.length - 3} more</span>` : '';
    return `| ${cat.icon} **${escMd(cat.label)}** | ${cat.count} | ${pct}% | ${examples}${more} | ${escMd(cat.why)} |`;
  }).join('\n');

  return `## Citation Source Breakdown — by Category

_How AI gets its answers about your category. Each row maps to a different outreach play — reviews and forums need very different tactics._

| Category | Citations | Share | Top examples | Outreach move |
|---|---:|---:|---|---|
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
  // Pick the first external host (skip the user's own domain and any
  // deny-listed host like github.io / vercel.app / teamtreehouse.com — those
  // have no editor to pitch). Without the deny-list step the «Get listed on»
  // copy recommended outreach to tenant containers in the May-2026 dogfood
  // run on typelessform.com.
  const topDomainHost = (topDomains.find(d =>
    d && !isOwnDomain(d.host, latest.domain) && !isDenyListedOutreachHost(d.host)
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

  return `## Visibility by Region

_Multi-region run with \`--geo\`. Each query was wrapped with a region-context preamble and sent to every engine — the LLM tailored its competitor list to that market. ${totalHits}/${totalCells} cells across ${regions.length} regions._

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

  return `<details class="uvi-breakdown${variantClass}"><summary><span class="uvi-info-icon" aria-hidden="true">&#9432;</span> <span class="uvi-info-label">${summaryText}</span></summary>
<div class="uvi-breakdown-body">
${renormBanner}
<table class="uvi-breakdown-table"><thead><tr><th>Component</th><th class="uvi-num">Value</th><th class="uvi-num">Weight applied</th><th class="uvi-num">Contribution</th></tr></thead><tbody>
${rows}
</tbody></table>
${sumLine}
<p class="uvi-formula-note">Formula: <code>UVI = Σ(value × applied_weight) / Σ(applied_weight)</code>, where applied weights are re-normalised over the measured components only. Math lives in <code>lib/report/visibility-index.js → computeUVIBreakdown()</code>.</p>
</div>
</details>`;
}

export function sectionUnifiedVisibilityIndex(snapshots) {
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
  const rankHint = (c.rankSample || 0) > 0
    ? `avg position strength when listed · n=${c.rankSample}`
    : 'avg position strength when listed';

  const rows = [
    componentRow('Presence',  c.presence,  0.35, 'share of cells where brand was mentioned'),
    componentRow('Sentiment', c.sentiment, 0.25, sentimentHint),
    componentRow('Rank',      c.rank,      0.20, rankHint),
    componentRow('Citation',  c.citation,  0.20, 'share of cells with brand domain in citations'),
  ].join('\n');

  const popover = renderUVIBreakdownPopover(breakdown);

  return `## Unified Visibility Index (UVI)

<div class="score-block">
<div class="score-block-label">Unified Visibility Index</div>
<div class="score-block-num" data-tone="${tone}">${uvi}<span class="score-block-frac"> / 100</span></div>
<div class="score-block-verdict" data-tone="${tone}">${verdict}</div>
<div class="score-block-meta">Composite of 4 signals · sample size ${c.sample} cell${c.sample !== 1 ? 's' : ''}</div>
</div>

${popover}

| Component | Score | Weight | | Meaning |
|---|---:|---:|---|---|
${rows}

_The UVI is a transparent composite — weights are defined in \`lib/report/visibility-index.js\`. Use the per-component scores to spot which dimension dragged the index down: low **Presence** → invest in citations, low **Sentiment** → PR work, low **Rank** → competitor displacement, low **Citation** → site-level discoverability._
`;
}

// ─── Section: AI-Bot Crawl Readiness (NEW v0.5, renamed in v0.3.2) ───
//
// Composite score derived from crawlability audit data. No extra fetches —
// summarises TECHNICAL access (robots.txt, AI-bot allowlist, sitemap.xml,
// llms.txt) for AI crawlers. Previously labelled «Discoverability Score»,
// which oversold what the signal actually measures: a 100/100 here means
// AI bots CAN crawl the site, not that AI engines DO cite it. Actual
// answer-pool inclusion depends on off-page authority (Wikipedia / Reddit /
// review platforms) — see «Authority-Source Presence» elsewhere in the
// report.

export function sectionDiscoverability(snapshots) {
  const latest = snapshots[snapshots.length - 1];
  const result = computeDiscoverability(latest?.crawlability);
  if (!result) return '';

  const tone = result.score >= 70 ? 'good' : result.score >= 40 ? 'warn' : 'bad';
  const rows = Object.entries(result.breakdown).map(([key, b]) => {
    const t = b.value >= 60 ? 'good' : b.value >= 25 ? 'warn' : 'bad';
    return `| **${key}** | <span class="rate-text" data-tone="${t}">${b.value}/100</span> | ${(b.weight * 100).toFixed(0)}% | ${b.note} |`;
  }).join('\n');

  return `## AI-Bot Crawl Readiness

<div class="score-block score-block-row">
<div class="score-block-num" data-tone="${tone}">${result.score}<span class="score-block-frac">/100</span></div>
<div class="score-block-body">
<div class="score-block-body-title">Technical access for AI crawlers</div>
<div class="score-block-body-note">Derived from robots.txt, AI bot access matrix, sitemap.xml, and /llms.txt presence — no extra HTTP requests beyond the crawlability audit.</div>
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

  if (ads.totalCellsWithAdSignal === 0) {
    return `## AI Ads / Sponsored-Content Detection

_${ads.totalCellsScanned} cell${ads.totalCellsScanned !== 1 ? 's' : ''} scanned for sponsored markers and ad-network citations — none found this run. As AI engines roll out ad inventory, this section will surface paid placements automatically._
`;
  }

  const providerRows = Object.entries(ads.byProvider)
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

export function sectionFooter(snapshots, lang = 'en') {
  const latest = snapshots[snapshots.length - 1];
  // Whitelist lang to the 4 webappski.com locales — mirrors sectionMcMetadataMd.
  // Prevents XSS/404 from raw config values interpolating into the footer URL.
  const ALLOWED_LANGS = new Set(['en', 'de', 'ru', 'pl']);
  const safeLang = ALLOWED_LANGS.has(lang) ? lang : 'en';
  return `---

### Need help getting cited by AI answer engines?

**[Webappski](https://webappski.com/${safeLang}/aeo-services)** is the AEO agency behind \`aeo-platform\`. We run weekly audits like this one, implement the kinds of actions this report recommends (third-party placements, comparison pages, authority building), and publish what we learn openly at [webappski.com/blog](https://webappski.com/${safeLang}/posts/aeo-visibility-challenge-week-1). If you want a second opinion on your numbers — or help turning them around — [talk to us](https://webappski.com/${safeLang}/aeo-services).

---

_Generated by aeo-platform. Raw responses: \`aeo-responses/${escMd(latest.date)}/\`. Re-run: \`aeo-platform report\`._
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

Copy the JSON below and paste it into your project page at [webappski.com/${lang}/aeo-mission-control](https://webappski.com/${lang}/aeo-mission-control). Webappski generates a personalised 30-mission AEO plan (≈1–3 hours per mission, work at your pace) grounded in this exact data — turnaround 1-3 business days during the founder-only beta. Your raw responses, queries, and API spend stay on your machine. Only the metadata in this block is uploaded.${groundingNote}

\`\`\`json
${json}
\`\`\`

> 💡 Open the HTML report (\`aeo-platform report --html\`) for an interactive **Generate metadata** button with one-click clipboard copy.
`;
}
