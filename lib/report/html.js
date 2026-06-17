/**
 * Single-file HTML report renderer — v0.5 "editorial bento" layout.
 *
 * The HTML is self-contained:
 *   - Three variable woff2 fonts (Fraunces / Geist / JetBrains Mono) embedded
 *     as base64 — no CDN dependency, works offline / via email / printed.
 *   - All CSS inline (one `<style>` block).
 *   - Vanilla JS for hero counter + scroll-spy + matrix sub-toggle (~3KB).
 *
 * Structure:
 *   1. Masthead (logo + brand title + run meta + engine pills)
 *   2. Sticky rail (scroll-spy outline of the 6 sections)
 *   3. Hero (dominant UVI number + narrative + 3 KPIs + ghost background)
 *   4. Promote (bridge-card + sponsor-card, side-by-side)
 *   5. Six bento sections (Overview / Visibility / Competitors / Citations /
 *      Actions / Diagnostics) — each is a 6-column grid of `.cell.span-N`
 *   6. Footer reprise CTA
 *   7. Colophon
 *
 * Cells without data DON'T render — bento auto-flow re-collapses around gaps.
 *
 * Tab-based v0.4 layout and v0.3 monolithic scroll are removed in 0.5.0.
 * One production layout = less surface area to maintain.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TOKENS, ENGINES, esc,
  radar, sparkline,
} from '../svg/index.js';
import {
  sectionSentiment,
  sectionDomainShareOfVoice,
  sectionHistoricalTrend,
  // Kept for re-enable when domain-type classifier lands — see html.js:367.
  sectionOutreachTemplates,
  sectionCompetitorRadar,
  competitorRadarHtml,
  sectionCrawlability,
  sectionDomainCategories,
  sectionFunnelBreakdown,
  sectionActionableGaps,
  sectionGeoComparison,
  sectionUnifiedVisibilityIndex,
  sectionDiscoverability,
  sectionTopicClusters,
  sectionAuthorityPresence,
  sectionAdsDetection,
  sectionUtmCitations,
  renderUVIBreakdownPopover,
  TREND_MIN_RUNS,
  TOPIC_CLUSTER_MIN,
} from './sections.js';
import { mdToHtml } from './markdown-to-html.js';
import { computeComponents, computeUVI, computeUVIBreakdown, computeDiscoverability } from './visibility-index.js';
import { categorizeDomain, aggregateByCategory } from './domain-category.js';
import { clusterQueries } from './topic-cluster.js';
import { aggregateUtmCitations } from './utm-tracker.js';
import { REGIONS } from './geo-context.js';
import { bridgeCss, bridgeMarkup, bridgeJs } from './mc-bridge.js';
import { getFontFaceCss } from './fonts/index.js';

// ─── Constants ──────────────────────────────────────────────────────────────

// UVI score → Emerging/Building/Strong/Dominant bucket. Same thresholds the
// hero animation lands on; the bucket label appears next to the big number.
const BUCKETS = [
  { max: 25,  label: 'Emerging' },
  { max: 50,  label: 'Building' },
  { max: 75,  label: 'Strong' },
  { max: 101, label: 'Dominant' },
];

// Provider slug → CSS variable (--eng-gpt etc.) used as the first link in
// the engine-color fallback chain. Unknown providers fall through to --ink-3.
const ENGINE_VAR = {
  openai:     '--eng-gpt',
  gemini:     '--eng-gem',
  anthropic:  '--eng-cla',
  perplexity: '--eng-perp',
};

// Provider slug → 3-letter mnemonic used in masthead engine pills.
// Anonymous coloured dots fail the «what am I looking at?» test on a static
// printable report. The 3-letter slug carries identity without taking room.
const ENGINE_SLUG = {
  openai:     'gpt',
  gemini:     'gem',
  anthropic:  'cla',
  perplexity: 'perp',
};

// Domain-category slugs that count as "listicle-style" sources (publishers
// that ship ranked-list articles AI engines love to cite).
const LISTICLE_SLUGS = new Set(['review', 'agency', 'blog', 'qna']);

// ─── Small utilities ────────────────────────────────────────────────────────

function stripParens(s) {
  return String(s).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

function shortenUrl(u) {
  return String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function parseSrcUrl(u) {
  try {
    const url = new URL(String(u));
    return {
      domain: url.hostname.replace(/^www\./, ''),
      path: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''),
    };
  } catch {
    return { domain: String(u).replace(/^https?:\/\//, '').split('/')[0], path: '' };
  }
}

function pickBucket(score) {
  for (const b of BUCKETS) if (score < b.max) return b.label;
  return 'Dominant';
}

function isListicle(host) {
  return LISTICLE_SLUGS.has(categorizeDomain(host).slug);
}

/**
 * Compute reach of a competitor across the latest run — engines that named
 * them, distinct queries they appeared in. Replaces the "cited as authority
 * on listicles" hardcoded suffix that claimed authority status without ever
 * verifying it. Returns null when the competitor isn't found at all.
 *
 * Counts only VERIFIED competitors (`r.competitors`) — the unverified bucket
 * is single-model signal and feeds the Top-Competitor hero KPI as
 * «Named on 2 of 3 engines» fact. Mixing the dashed-tier in there double-counts
 * the same brand at a tier where the renderer otherwise refuses to act on it
 * (Actionable Gaps soft-pitches, radar mention count is verified-only).
 */
function competitorReach(latest, competitorName) {
  if (!latest || !competitorName) return null;
  const lc = String(competitorName).toLowerCase();
  const results = latest.results || [];
  const allProviders = [...new Set(results.map(r => r.provider))];
  const allQueries  = [...new Set(results.map(r => r.query))];
  const enginesNaming = new Set();
  const queriesNaming = new Set();
  for (const r of results) {
    const verified = (r.competitors || []);
    if (verified.some(c => String(c).toLowerCase() === lc)) {
      enginesNaming.add(r.provider);
      queriesNaming.add(r.query);
    }
  }
  if (enginesNaming.size === 0) return null;
  return {
    engineCount:  enginesNaming.size,
    totalEngines: allProviders.length,
    queryCount:   queriesNaming.size,
    totalQueries: allQueries.length,
  };
}

/**
 * For each engine compute (citations, mentions); pick the engine with the
 * HIGHEST citations among those with the LOWEST mentions. That's where the
 * lift is most accessible — AI cites your domain there but isn't yet naming
 * the brand. Returns null when no engine has any citations.
 */
function closestToMention(engines) {
  const candidates = (engines || []).filter(e => (e.citations || 0) > 0);
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const m = (a.hits || 0) - (b.hits || 0);
    if (m !== 0) return m;
    return (b.citations || 0) - (a.citations || 0);
  });
  return sorted[0];
}

/**
 * 3-tier day-label assignment for action plan rows.
 *
 *   Tier 1 — Day-range labels (`Day 1–2`, `Day 3–5`, ...) when priority
 *            distribution lets us slot actions across a real week.
 *   Tier 2 — Week labels (`Week 1`, `Week 2`) when ≥4 actions get crowded
 *            into Day 1–2 — that's a skew that day-precision fakes signal
 *            we don't have. Honest fallback.
 *   Tier 3 — Hide the chip entirely (`day: null`). Triggered when even
 *            week distribution is degenerate (all priorities identical or
 *            actions array < 2). Renderers should skip the chip when
 *            day === null instead of displaying an empty `DAY` label.
 */
function assignDays(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  if (actions.length === 1) return [{ ...actions[0], day: null }];
  const allSamePriority = actions.every(a => a.priority === actions[0].priority);
  if (allSamePriority) {
    // Degenerate — every action has the same priority, no signal for time-slotting.
    return actions.map(a => ({ ...a, day: null }));
  }
  const SLOTS = [
    { day: 'Day 1–2', match: a => a.priority === 'high' },
    { day: 'Day 3–5', match: a => a.priority === 'med' },
    { day: 'Day 5',   match: a => a.priority === 'med' },
    { day: 'Day 7',   match: a => a.priority === 'low' },
  ];
  const slotted = actions.map((a, idx) => {
    let label = SLOTS.find(s => s.match(a))?.day;
    if (!label) label = `Day ${Math.min(7, idx + 1)}`;
    return { ...a, day: label };
  });
  const day12 = slotted.filter(a => a.day === 'Day 1–2').length;
  if (day12 >= 4 && actions.length >= 5) {
    return actions.map((a, idx) => ({ ...a, day: `Week ${Math.min(3, Math.floor(idx / 2) + 1)}` }));
  }
  return slotted;
}

/**
 * Hero narrative text — context-aware single sentence. Logic per INTEGRATION §3a.
 *
 * Wording rules (v0.6+):
 *   • The phrase «cited X times» is BANNED here. The total own-domain URL
 *     citation count (`totalCitations`) and the «cited-but-not-named» cell
 *     count (`coverage.src`) measure DIFFERENT things, and the legacy copy
 *     conflated them — readers read «cited 0 times» as «we have 0 citations»
 *     even when the domain appeared in citation pools across many named cells.
 *   • Use `cited` (= `coverage.src`) — number of cells where domain WAS in
 *     the citation pool but brand name was NOT spoken (the lift-opportunity
 *     metric). Call this out as «citation without naming» so the semantic
 *     stays unambiguous.
 *
 * @param {Object} opts
 * @param {Object} opts.coverage         — { yes, src, no, error, total }
 * @param {number} opts.cited            — coverage.src (cells cited but not named)
 * @param {Object} opts.topComp          — top competitor object
 * @param {Object} opts.citationsLeader  — closest-to-mention engine
 */
function narrativeFor({ coverage, cited, topComp, citationsLeader }) {
  const total = coverage.total || 0;
  const named = coverage.yes || 0;
  const srcCells = cited || 0;
  const ratio = total > 0 ? named / total : 0;
  // True invisibility — neither named nor cited in any cell. Likely
  // robots.txt blocking or all queries errored.
  if (named === 0 && srcCells === 0) {
    return `AI engines didn't name <b>or</b> cite you in any of the <b>${total}</b> answers this run. Start with crawlability — make sure AI bots can read your site.`;
  }
  // Cited but never named — the lift target. Engines DO know your domain
  // (returning URLs in citations) but haven't promoted you to a named brand.
  if (named === 0 && srcCells > 0) {
    if (citationsLeader) {
      return `Cited in <b>${srcCells} of ${total}</b> answers without being named — <b>${esc(stripParens(citationsLeader.label))}</b> picks up your domain most often, that's the engine to pitch first to convert citations into named mentions.`;
    }
    return `Cited in <b>${srcCells} of ${total}</b> answers without being named. The lift: turn citations into mentions — your domain is in the source pool, just not yet promoted to a named brand.`;
  }
  // Tail line about lift opportunities, appended when srcCells > 0. When = 0
  // we surface that as success state instead of «0 cites» (which read as a
  // failure in the legacy copy).
  const liftLine = srcCells > 0
    ? ` Additionally, your domain was cited in <b>${srcCells} cell${srcCells === 1 ? '' : 's'}</b> without your brand being named — a lift opportunity to convert those into named mentions.`
    : ` Your domain was always cited alongside the brand name — no «citation without naming» lift cases this run.`;
  // Named in some answers but trailing — common gap-narrowing scenario.
  if (ratio < 0.30 && topComp) {
    return `Named in <b>${named} of ${total}</b> answers. Closing the gap: <b>${esc(topComp.name)}</b> was named ${topComp.count}× more than you across the same queries.${liftLine}`;
  }
  // Healthy presence.
  return `Named in <b>${named} of ${total}</b> answers. You're in the consideration set — push for first-position mentions next.${liftLine}`;
}

function daysBetween(isoDate, today = new Date()) {
  if (!isoDate) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const ms = today.getTime() - d.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

// SVG path for a 60×18 mini-trend line in the hero delta chip.
// Normalises the last 5 score values to fit the box.
function miniDeltaPath(values) {
  const arr = (values || []).slice(-5).filter(v => typeof v === 'number');
  if (arr.length < 2) return null;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const range = max - min || 1;
  const w = 60, h = 18, pad = 2;
  const step = (w - pad * 2) / (arr.length - 1);
  const pts = arr.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  return { d, last: pts[pts.length - 1] };
}

// SVG path for an in-cell line chart of the score history (Section 01 cell).
// Returns the markup for axes, fill, line, dots, and an annotation on the latest point.
function buildTrendChart(values, dates) {
  const arr = (values || []).filter(v => typeof v === 'number');
  if (arr.length < 2) return '';
  const w = 460, h = 180, padX = 30, padY = 30;
  const min = 0;
  const max = Math.max(100, ...arr);
  const step = (w - padX * 2) / (arr.length - 1);
  const yOf = v => padY + (1 - (v - min) / (max - min)) * (h - padY * 2 - 20);
  const pts = arr.map((v, i) => [padX + i * step, yOf(v)]);
  const last = pts[pts.length - 1];
  const lastVal = arr[arr.length - 1];
  const dateLabels = (dates || []).slice(-arr.length);
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const fillPath = `${linePath} L ${last[0].toFixed(1)} ${h - padY} L ${pts[0][0].toFixed(1)} ${h - padY} Z`;
  // Baseline 0 gets its own class — when line sits at zero, this is the only
  // visible reference. 25/50/75 are quiet grid lines for secondary context.
  const baselineY = yOf(0).toFixed(1);
  const baseline = `<line class="chart-baseline" x1="0" y1="${baselineY}" x2="${w}" y2="${baselineY}"/><text class="chart-axis chart-axis-baseline" x="0" y="${(parseFloat(baselineY) - 5).toFixed(1)}">0</text>`;
  const grids = [25, 50, 75].map(g => {
    const y = yOf(g).toFixed(1);
    return `<line class="chart-grid" x1="0" y1="${y}" x2="${w}" y2="${y}"/><text class="chart-axis" x="0" y="${(parseFloat(y) - 5).toFixed(1)}">${g}</text>`;
  }).join('');
  const dots = pts.map((p, i) =>
    `<circle class="chart-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === pts.length - 1 ? 4 : 3}"/>`,
  ).join('');
  const xAxis = dateLabels.map((d, i) => {
    const x = pts[i][0].toFixed(1);
    const anchor = i === 0 ? 'start' : i === dateLabels.length - 1 ? 'end' : 'middle';
    const short = (d || '').slice(5); // MM-DD
    return `<text class="chart-axis" x="${x}" y="${h - 5}" text-anchor="${anchor}">${esc(short)}</text>`;
  }).join('');
  // Annotation: accent on the value, mono on "this run" — value is the
  // takeaway, label is context. tspan lets us style the two parts separately
  // inside a single SVG text element.
  const annoY = Math.max(20, last[1] - 50).toFixed(1);
  const anno = `<line class="chart-leader" x1="${last[0].toFixed(1)}" y1="${last[1].toFixed(1)}" x2="${last[0].toFixed(1)}" y2="${annoY}"/><text class="chart-anno" x="${(last[0] - 5).toFixed(1)}" y="${(parseFloat(annoY) - 5).toFixed(1)}" text-anchor="end"><tspan class="chart-anno-num">${lastVal}</tspan> <tspan class="chart-anno-label">· this run</tspan></text>`;
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grids}${baseline}<path class="chart-fill" d="${fillPath}"/><path class="chart-line" d="${linePath}"/>${dots}${anno}${xAxis}</svg>`;
}

// ─── Main renderer ──────────────────────────────────────────────────────────

/**
 * Render the AEO HTML report (v0.5 editorial bento layout).
 *
 * @param {Object} summary    SummaryJSON (from buildHtmlSummary)
 * @param {Object[]} [snapshots]
 * @param {Object} [opts]
 * @param {Object} [opts.mcMetadata]      pre-built metadata payload for the bridge
 * @param {number} [opts.daysSinceRun]    age of the latest run in days
 * @param {boolean} [opts.noMcBlock]      skip the MC bridge entirely
 */
export function renderHtml(summary, snapshots = null, opts = {}) {
  // Public-proof mode (--public): omit cost/token telemetry + source-path
  // footnotes so a HOSTED proof report is leak-free by construction (no manual
  // scrub). See resources memory feedback_aeo_platform_report_leaks_cost_and_source_paths.
  const publicMode = opts.public === true;
  const latest = snapshots && snapshots.length ? snapshots[snapshots.length - 1] : null;

  // ── Hero data ──
  let uviScore = summary.score;
  if (latest) {
    try { uviScore = computeUVI(computeComponents(latest)); }
    catch { uviScore = summary.score; }
  }
  const bucket = pickBucket(uviScore);
  const scoreDelta = summary.scorePrev == null ? null : summary.score - summary.scorePrev;
  const totalCitations = summary.totalCitations ?? (summary.engines || []).reduce((s, e) => s + (e.citations || 0), 0);
  const citationsDelta = summary.totalCitationsPrev == null ? null : totalCitations - summary.totalCitationsPrev;
  // Stable tie-break: when multiple competitors share the same mention count,
  // pick the alphabetically-first by name (deterministic, no flip between runs).
  // Earlier code took `find(!accent)` which depended on insertion order — that
  // could make «Siege Media» edge out «First Page Sage» on a tied count just
  // because compList came back in upstream order.
  const topComp = (summary.competitors || [])
    .filter(c => !c.accent)
    .slice()
    .sort((a, b) => {
      if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
      return String(a.name || '').localeCompare(String(b.name || ''));
    })[0] || null;
  const closest = closestToMention(summary.engines || []);
  const miniDelta = miniDeltaPath(summary.trend || []);

  const narrative = narrativeFor({
    coverage: summary.coverage || {},
    cited: (summary.coverage && summary.coverage.src) || 0,
    topComp,
    citationsLeader: closest,
  });

  // Hero «How is this calculated?» popover — uses the SAME breakdown function
  // as the markdown UVI section so the per-axis numbers, weights, and re-norm
  // banner stay consistent across both surfaces. The hero variant uses the
  // shorter summary label «How is this calculated?» (no parenthetical
  // «click to expand») to fit the dense hero header. The full long-form
  // table is identical — single source of truth lives in
  // visibility-index.js → computeUVIBreakdown.
  const heroUVIPopover = (() => {
    if (!latest) return '';
    try {
      const breakdown = computeUVIBreakdown(computeComponents(latest));
      return renderUVIBreakdownPopover(breakdown, {
        variant: 'hero',
        summaryText: 'How is this calculated?',
        public: publicMode,
      });
    } catch {
      return '';
    }
  })();

  // ── Markdown sections (used as embedded markdown panels in some cells) ──
  const wrapMd = (md) => (md && md.trim()) ? `<div class="md-block">${mdToHtml(md)}</div>` : '';
  const sectionsRaw = snapshots ? {
    sentiment:  sectionSentiment(snapshots),
    funnel:     sectionFunnelBreakdown(snapshots),
    geo:        sectionGeoComparison(snapshots),
    utm:        sectionUtmCitations(snapshots),
    ads:        sectionAdsDetection(snapshots),
    // Outreach drafts disabled — pitches competitors (scrunch.io, minonta.com
    // etc.) instead of only publishers. Re-enable once domain-type classifier
    // (publisher / competitor / community) lands. See memory:
    // project_outreach_pitches_to_competitors.md
    outreach:   null, // sectionOutreachTemplates(snapshots),
    authority:  sectionAuthorityPresence(snapshots),
    uvi:        sectionUnifiedVisibilityIndex(snapshots, publicMode),
  } : {};
  const S = Object.fromEntries(Object.entries(sectionsRaw).map(([k, md]) => [k, wrapMd(md)]));

  // ── Topic clusters (computed on the fly for the Overview cell) ──
  const clusters = latest ? clusterQueries(latest).filter(c => c.topic !== 'uncategorised').slice(0, 4) : [];

  // ── Listicle pitch KPI (Overview cell) ──
  const top4Domains = (summary.topDomains || []).slice(0, 4);
  const listicleCount = top4Domains.filter(d => isListicle(d.host)).length;

  // ── Domain categories (Citations cell) ──
  const categories = aggregateByCategory(summary.topDomains || []).slice(0, 6);

  // ── Action plan (Actions cell) — heuristic day labels ──
  const actionPlan = assignDays(summary.actions || []);

  // ── Site readiness (Diagnostics cell) ──
  const discover = computeDiscoverability(summary.crawlability);
  const crawlSummary = summary.crawlability?.summary;

  // ── Cost breakdown (Diagnostics cell) — exclude classify-tier rows ──
  const ENGINE_LABELS_MATCH = ['ChatGPT', 'Gemini', 'Claude', 'Perplexity'];
  const engineCosts = (summary.costBreakdown || []).filter(c => ENGINE_LABELS_MATCH.includes(c.label));

  // ── UTM citations (Diagnostics cell) ──
  const utmAgg = latest ? aggregateUtmCitations(latest.results || [], summary.meta.domain) : null;

  // ── MC bridge (single-state v8 visual, lives between sections and footer) ──
  // The legacy 5-state interactive flow was removed; CTA inside the bridge now
  // redirects users to the demo + waitlist on webappski.com directly.
  // Engine list for bridge headline — formatted as "X, Y & Z" so the copy
  // adapts to whatever providers ran this report (used to read «ChatGPT,
  // Claude & Gemini» hardcoded). Falls through to the original trio when
  // engines list is missing/empty.
  const engineLabels = (summary.engines || [])
    .map(e => stripParens(e.label))
    .filter(Boolean);
  const engineListText = engineLabels.length >= 2
    ? engineLabels.slice(0, -1).join(', ') + ' & ' + engineLabels[engineLabels.length - 1]
    : engineLabels.length === 1
      ? engineLabels[0]
      : 'ChatGPT, Claude & Gemini';

  const mcBridgeMarkup = (!opts.noMcBlock && opts.mcMetadata)
    ? bridgeMarkup({
        brand: summary.meta?.brand || '',
        domain: summary.meta?.domain || '',
        queryCount: opts.mcMetadata.aggregates?.totalQueries || 0,
        metadata: opts.mcMetadata,
        engineListText,
        pricing: opts.bridgePricing,
      })
    : '';
  const mcBridgeBootstrap = (!opts.noMcBlock && opts.mcMetadata)
    ? bridgeJs(opts.mcMetadata, {
        queryCount: opts.mcMetadata.aggregates?.totalQueries || 0,
        daysSinceRun: Number(opts.daysSinceRun) || 0,
      })
    : '';

  // ── CSS bundle ──
  const css = getFontFaceCss() + '\n' + renderCss() + (mcBridgeMarkup ? bridgeCss : '');

  // ────────────────────── HTML assembly ──────────────────────
  // Each section builds its cells conditionally — empty data = cell omitted.

  // Engine pills next to the masthead — coloured dot + 3-letter slug.
  // A bare dot is anonymous on a printed report; the slug carries the
  // engine identity. Both share --c so dot colour and slug colour match.
  const enginePills = (summary.engines || [])
    .map(e => {
      const slug = ENGINE_SLUG[e.provider] || e.provider;
      const cssVar = ENGINE_VAR[e.provider] || '--ink-3';
      return `<span class="eng-pill" style="--c: var(${cssVar}, var(--ink-3))" title="${esc(e.label)}"><i class="eng-pill-dot"></i><span class="eng-pill-name">${esc(slug)}</span></span>`;
    })
    .join('');

  // Hero KPIs.
  const heroKpiCells = [];
  // KPI 1 — mention rate
  heroKpiCells.push(`
    <div class="hero-kpi">
      <span class="hero-kpi-label">Mention rate</span>
      <div class="hero-kpi-row">
        <span class="hero-kpi-num">${summary.coverage.yes}</span>
        <span class="hero-kpi-num-sub">/ ${summary.coverage.total} cells</span>
      </div>
      <span class="hero-kpi-context">${summary.coverage.yes === 0
        ? 'No engine named you. <b>Citation pickup</b> is the unlock.'
        : `Mentioned by ${summary.coverage.yes} of ${summary.coverage.total} cells.`}</span>
    </div>`);
  // KPI 2 — Lift opportunities (cells cited but not named).
  // Renamed from «Citations earned» in v0.6: the old label implied a count of
  // ALL citations, but the underlying counter was domain-URL-hits across all
  // cells (including named ones) — and the «No citations yet — fix
  // robots.txt» subtitle gave wrong advice when the count was zero only
  // because every cited cell ALSO named the brand (a success state).
  // The new card uses `coverage.src` — cells where the domain WAS in the
  // citation pool but the brand name was NOT spoken. That's the actionable
  // «turn cite into mention» metric.
  const liftCount = (summary.coverage && summary.coverage.src) || 0;
  const liftContext = liftCount === 0
    ? '<span class="hero-kpi-context">No lift opportunities this run — every cell that cited your domain also named your brand. That\'s the success state.</span>'
    : closest
      ? `<span class="hero-kpi-context" style="--c: var(${ENGINE_VAR[closest.provider] || '--ink-3'}, var(--ink-3))">${liftCount} cell${liftCount === 1 ? '' : 's'} cited your domain without naming your brand — pitch <span class="e">${esc(stripParens(closest.label))}</span> first to convert.</span>`
      : `<span class="hero-kpi-context">${liftCount} cell${liftCount === 1 ? '' : 's'} cited your domain without naming your brand. Pitch those publishers to get named, not just cited.</span>`;
  heroKpiCells.push(`
    <div class="hero-kpi">
      <span class="hero-kpi-label">Lift opportunities</span>
      <div class="hero-kpi-row">
        <span class="hero-kpi-num">${liftCount}</span>
        <span class="hero-kpi-num-sub">cited, not named</span>
      </div>
      ${liftContext}
    </div>`);
  // KPI 3 — top competitor. Context line is reach-based (engines naming +
  // queries naming), computed from latest results — replaces the v0.5 «cited
  // as authority on listicles» claim that was hardcoded regardless of data.
  if (topComp) {
    const latestForReach = snapshots ? snapshots[snapshots.length - 1] : null;
    const reach = competitorReach(latestForReach, topComp.name);
    let reachLine;
    // Drop the «N of M queries» fraction — total query count is already
    // visible in Mention rate KPI above. Two-fraction line («1 of 3 engines
    // · 2 of 3 queries») read as «1 of 3 of 3» mash. Now: engines keep
    // their «of total» for context («which engines»), queries are a flat
    // count («across N queries»).
    if (reach && reach.engineCount === reach.totalEngines && reach.totalEngines > 0) {
      reachLine = `Named by <b>all ${reach.totalEngines} engines</b>, across <b>${reach.queryCount}</b> quer${reach.queryCount === 1 ? 'y' : 'ies'}`;
    } else if (reach) {
      reachLine = `Named on <b>${reach.engineCount} of ${reach.totalEngines}</b> engine${reach.totalEngines !== 1 ? 's' : ''}, across <b>${reach.queryCount}</b> quer${reach.queryCount === 1 ? 'y' : 'ies'}`;
    } else {
      reachLine = `<b>${topComp.count} mention${topComp.count !== 1 ? 's' : ''}</b> across this run`;
    }
    heroKpiCells.push(`
      <div class="hero-kpi">
        <span class="hero-kpi-label">Top competitor</span>
        <div class="hero-kpi-row">
          <span class="hero-kpi-num" style="font-size: 22px; line-height: 1.2; font-family: var(--display)">${esc(topComp.name)}</span>
        </div>
        <span class="hero-kpi-context">${reachLine}</span>
      </div>`);
  }

  const deltaLine = (() => {
    if (scoreDelta == null) return '<span class="hero-delta">▪ Baseline</span>';
    const cls = scoreDelta > 0 ? 'pos' : scoreDelta < 0 ? 'neg' : '';
    const arr = scoreDelta > 0 ? '▲' : scoreDelta < 0 ? '▼' : '→';
    const sign = scoreDelta > 0 ? '+ ' : scoreDelta < 0 ? '' : '';
    const miniSvg = miniDelta
      ? `<svg class="hero-delta-mini" viewBox="0 0 60 18" preserveAspectRatio="none" aria-hidden="true">
           <path d="${miniDelta.d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
           <circle cx="${miniDelta.last[0].toFixed(1)}" cy="${miniDelta.last[1].toFixed(1)}" r="2" fill="currentColor"/>
         </svg>`
      : '';
    return `<div class="hero-delta ${cls}"><span class="hero-delta-arrow">${arr}</span><span>${sign}${Math.abs(scoreDelta)} pts</span>${miniSvg}<span style="color: var(--ink-3); font-weight: 400;">vs last run</span></div>`;
  })();

  // ── Section 01 — Overview ──
  const overviewCells = [];
  // Trend chart — suppressed below TREND_MIN_RUNS so a 2-point line doesn't
  // read as a trend. Replaced with a muted «available from week N» cell so
  // the reader sees the block is staged, not silently missing.
  if (summary.trend.length < TREND_MIN_RUNS) {
    const runCount = summary.trend.length;
    overviewCells.push(`
      <article class="cell span-4 tall quiet">
        <div class="cell-head"><span class="cell-label">Trend · ${runCount} run${runCount !== 1 ? 's' : ''}</span></div>
        <h3 class="cell-title">Trend chart available from week ${TREND_MIN_RUNS}</h3>
        <p class="cell-sub">Currently ${runCount} of ${TREND_MIN_RUNS} runs collected. A line through 2-3 points is statistical noise — the chart unlocks after week ${TREND_MIN_RUNS}.</p>
      </article>`);
  } else if (summary.trend.length >= 2) {
    const trendChart = buildTrendChart(summary.trend, summary.trendDates || []);
    // Title + subtitle branch on three axes: delta sign, max value (zero
    // baseline detection), and run count. «Score is steady» reads as «we're
    // holding» — true only when max > 0 AND delta = 0. At pure-zero we say
    // «Flat at zero» so the reader knows this is bottom-baseline, not stable.
    // The delta here is first-vs-last across the whole trend window — NOT
    // scoreDelta (vs previous run, hero panel). This panel's copy says
    // «across N runs», so a last-step dip must not be presented as the
    // multi-run trend (100→83 once printed as «Down 17 points across 6 runs»
    // while the window was up 50).
    const trendNums = summary.trend.filter(v => typeof v === 'number');
    const trendMax = Math.max(0, ...trendNums);
    const allZero = trendMax === 0;
    const runCount = summary.trend.length;
    const windowDelta = trendNums.length >= 2 ? trendNums[trendNums.length - 1] - trendNums[0] : null;
    const trendTitle = windowDelta > 0 ? 'Score is climbing'
      : windowDelta < 0 ? 'Score slipping'
      : allZero ? 'Flat at zero'
      : 'Score is steady';
    const lift = windowDelta != null
      ? windowDelta > 0 ? `Up ${windowDelta} points across ${runCount} runs.`
        : windowDelta < 0 ? `Down ${Math.abs(windowDelta)} points across ${runCount} runs.`
        : allZero ? `All ${runCount} runs at 0%. No movement to compare yet — earn a first mention to start the trend.`
        : `Holding at ${trendMax}% across ${runCount} runs.`
      : '';
    overviewCells.push(`
      <article class="cell span-4 tall dominant">
        <div class="cell-head"><span class="cell-label">Trend · ${runCount} runs</span></div>
        <h3 class="cell-title">${trendTitle}</h3>
        <p class="cell-sub">${esc(lift)}</p>
        <div class="cell-body">${trendChart}</div>
      </article>`);
  }
  // Listicle pitches KPI — subtitle now branches on whether the brand has any
  // mention/citation footprint, instead of asserting «brand isn't on any of
  // them» without verification. We can't web-scrape those listicle pages from
  // here; the honest signal is what the AI answers themselves told us.
  if (top4Domains.length > 0) {
    const named = summary.coverage?.yes || 0;
    const cited = summary.coverage?.src || 0;
    const ratio = listicleCount / top4Domains.length;
    // Title reflects the listicle density of the citation pool. The big-num
    // already shows the raw fraction; the title gives the qualitative read.
    let listicleTitle;
    if (ratio === 0)         listicleTitle = 'No listicles in pool';
    else if (ratio >= 0.75)  listicleTitle = 'Listicle-dominated pool';
    else if (ratio >= 0.5)   listicleTitle = 'Half the pool is listicles';
    else if (ratio >= 0.25)  listicleTitle = 'Some listicles cited';
    else                     listicleTitle = 'Few listicles cited';
    let listicleSub;
    if (named > 0) {
      listicleSub = `${listicleCount} of ${top4Domains.length} cited domains are listicles. You're already named in ${named} answer${named !== 1 ? 's' : ''} — push for inclusion in the listicle pool too.`;
    } else if (cited > 0) {
      listicleSub = `${listicleCount} of ${top4Domains.length} cited domains are listicles. AI cites your URL but doesn't yet rank you on them — outreach is the lift.`;
    } else {
      listicleSub = `${listicleCount} of ${top4Domains.length} cited domains are listicles. ${esc(summary.meta.brand)} isn't in AI's source pool yet — pitching for a listicle slot is the fastest path in.`;
    }
    overviewCells.push(`
      <article class="cell span-2 tall quiet">
        <div class="cell-head"><span class="cell-label">Top gap</span></div>
        <h3 class="cell-title">${esc(listicleTitle)}</h3>
        <p class="cell-sub" style="margin-bottom: 12px;">${listicleSub}</p>
        <div class="ratio ${listicleCount === 0 ? 'bad' : listicleCount >= 3 ? 'good' : 'warn'}" style="margin-top: auto;">
          <span class="ratio-main">${listicleCount}</span>
          <span class="ratio-stack">
            <span class="ratio-denom">of ${top4Domains.length}</span>
            <span class="ratio-context">listicle slot${top4Domains.length !== 1 ? 's' : ''}</span>
          </span>
        </div>
      </article>`);
  }
  // Topic clusters — suppressed below TOPIC_CLUSTER_MIN: a single cluster is
  // the whole brand, two clusters are noise-prone. Below the threshold the
  // section is hidden in the markdown report too (sectionTopicClusters).
  if (clusters.length >= TOPIC_CLUSTER_MIN) {
    // Normalize bar width vs. top-cluster rate so the leader fills the
    // track and weaker clusters read as fractions. Raw rate (0-2%) is
    // visually identical to zero. Floor of 8% keeps every row visible.
    const maxRate = clusters.reduce((m, c) => Math.max(m, c.rate || 0), 0) || 1;
    const leadRate = clusters.reduce((m, c) => (c.rate || 0) > m ? (c.rate || 0) : m, 0);
    const rows = clusters.map(cl => {
      const ratio = maxRate > 0 ? (cl.rate / maxRate) : 0;
      const norm = Math.max(8, Math.round(ratio * 100));
      const isLead = (cl.rate || 0) === leadRate && leadRate > 0;
      return `<div class="cluster-row${isLead ? ' lead' : ''}" style="--w-norm: ${norm}%;">
        <div class="cluster-bar-wrap">
          <span class="cluster-name">${esc(cl.topic)}</span>
          <div class="cluster-bar"></div>
        </div>
        <span class="cluster-pct">${cl.rate}<small>%</small></span>
      </div>`;
    }).join('');
    const allZero = clusters.every(c => c.rate === 0);
    // Title reflects the actual visibility shape: dominant cluster, even
    // spread, or completely absent. Static «Cluster visibility» didn't tell
    // the reader anything they couldn't see in the bar chart.
    let clusterTitle;
    if (allZero) {
      clusterTitle = 'No cluster cracked yet';
    } else if (clusters.length === 1) {
      clusterTitle = `${clusters[0].topic} — sole cluster`;
    } else {
      const sorted = [...clusters].sort((a, b) => (b.rate || 0) - (a.rate || 0));
      const top = sorted[0];
      const second = sorted[1];
      const gap = (top.rate || 0) - (second?.rate || 0);
      if (gap >= 25) clusterTitle = `${esc(top.topic)} dominates`;
      else if (gap >= 10) clusterTitle = `${esc(top.topic)} leads`;
      else clusterTitle = 'Even spread across clusters';
    }
    overviewCells.push(`
      <article class="cell span-3 quiet">
        <div class="cell-head"><span class="cell-label">Topic clusters</span></div>
        <h3 class="cell-title">${clusterTitle}</h3>
        <p class="cell-sub">${clusters.length} query cluster${clusters.length !== 1 ? 's' : ''} grouped by shared keywords.</p>
        <div class="cell-body" style="margin-top: 8px;">
          <div style="width: 100%; display: flex; flex-direction: column; gap: 8px;">${rows}</div>
        </div>
      </article>`);
  }
  // (v0.3.1) "Top 3 gaps preview" card removed from Overview.
  // Reason: the heuristic (top-3 by raw citation count, n=1 sample) suggested
  // pitching domains that were classified as direct competitors elsewhere in
  // the same report — a recommendation that's actively wrong, not just noisy.
  // Citation-gap analysis lives in `04 / Citations` (Domain share of voice +
  // by-category breakdown) where category classification + larger sample
  // produce something a senior AEO would actually act on.

  // ── Section 02 — Visibility ──
  const visibilityCells = [];
  // Per-engine cards
  if ((summary.engines || []).length > 0) {
    const cards = summary.engines.map(e => {
      const colorVar = ENGINE_VAR[e.provider] || '--ink-3';
      return `<div class="eng-card" style="--c: var(${colorVar}, var(--ink-3)); --w: ${e.pct}%">
        <div class="eng-card-head">
          <span class="eng-name">${esc(stripParens(e.label))}</span>
          <span class="eng-model">${esc(e.model)}</span>
        </div>
        <div class="eng-pct">${e.pct}<sup>%</sup></div>
        <div class="eng-bar"></div>
        <div class="eng-meta"><span>Hits ${e.hits} / ${e.total}</span><span>${e.citations} citations</span></div>
      </div>`;
    }).join('');
    visibilityCells.push(`
      <article class="cell span-6 quiet">
        <div class="cell-head"><span class="cell-label">Per-engine visibility <span class="merge">absorbs Coverage shape</span></span></div>
        <h3 class="cell-title">${summary.coverage.yes === 0 ? 'Cited but never named' : `Named in ${summary.coverage.yes}/${summary.coverage.total} cells`}</h3>
        <p class="cell-sub">${summary.coverage.yes === 0
          ? 'Engines see your domain in citations; none surface your brand by name in answers yet.'
          : 'Per-engine breakdown — bar shows mention rate, footnote shows citation count.'}</p>
        <div class="cell-body" style="display: block;"><div class="eng-row">${cards}</div></div>
      </article>`);
  }
  // Query × engine matrix
  if (summary.positionMatrix && summary.positionMatrix.length > 0) {
    // Aggregate counts across all cells — feeds the headline summary bar
    // above the grid so the reader gets the takeaway in one sentence
    // before scanning rows.
    const mxAgg = { named: 0, cited: 0, competitor: 0, empty: 0, error: 0, totalCites: 0, totalComps: 0, totalCells: 0, ourCiteCells: 0 };
    summary.positionMatrix.forEach(row => {
      row.columns.forEach(col => {
        mxAgg.totalCells++;
        mxAgg.totalCites += (col.citationCount || 0);
        const named = (col.competitors || []).filter(c => c && c.name);
        mxAgg.totalComps += named.length;
        if (col.mention === 'yes') mxAgg.named++;
        else if (col.mention === 'src') mxAgg.cited++;
        else if (col.mention === 'error') mxAgg.error++;
        else if (named.length > 0) mxAgg.competitor++;
        else mxAgg.empty++;
        // Cells where our domain surfaced in the citation pool. Each
        // src/yes cell contributes at least one ours-cite; per-URL
        // ownership isn't tracked in summary, so this is a lower-bound
        // count of cells, not URL count.
        if (col.mention === 'src' || col.mention === 'yes') mxAgg.ourCiteCells++;
      });
    });
    const mxYours = mxAgg.named + mxAgg.cited;

    const headerCells = (summary.engines || []).map(e =>
      `<div class="mx-h eng" style="--c: var(${ENGINE_VAR[e.provider] || '--ink-3'}, var(--ink-3))">${esc(stripParens(e.label))}</div>`,
    ).join('');
    const rows = summary.positionMatrix.map((row, rowIndex) => {
      const qLabel = `Q${rowIndex + 1}`;
      const qText = row.query || '';
      const rowNamed = row.columns.filter(c => c.mention === 'yes' || c.mention === 'src').length;
      const rowTotal = row.columns.length;
      // Each cell carries three view-spans (.mx-v-mention / -position / -sentiment).
      // CSS shows whichever the parent .matrix-grid[data-view] selects so the
      // Mention/Position/Sentiment toggle actually swaps content, not just chrome.
      const sentTone = (s) => s === 'positive' ? 'pos' : s === 'negative' ? 'neg' : 'flat';
      const sentGlyph = (s) => s === 'pos' ? '●' : s === 'neg' ? '●' : s === 'flat' ? '●' : '○';
      const cells = row.columns.map(col => {
        const status = col.mention;
        const posTxt = (typeof col.position === 'number' && col.position > 0) ? `#${col.position}` : null;
        const sLabel = col.sentiment?.label || null;
        const sTone  = sLabel ? sentTone(sLabel) : 'missing';
        const sBlock = sLabel
          ? `<span class="mx-v mx-v-sentiment" data-tone="${sTone}" aria-label="${esc(sLabel)}"><span class="mx-sent-dot">${sentGlyph(sTone)}</span><span class="mx-sent-label">${esc(sLabel)}</span></span>`
          : `<span class="mx-v mx-v-sentiment" data-tone="missing" aria-label="unscored"><span class="mx-sent-dot">${sentGlyph('missing')}</span><span class="mx-sent-label">unscored</span></span>`;
        if (status === 'yes') {
          return `<div class="mx-c yes" data-status="named">
            <span class="mx-v mx-v-mention"><span class="mx-marker">▮</span><span class="mx-label">named</span></span>
            <span class="mx-v mx-v-position">${posTxt ? `<span class="mx-pos">${posTxt}</span>` : `<span class="mx-status">no rank</span>`}</span>
            ${sBlock}
          </div>`;
        }
        if (status === 'src') {
          return `<div class="mx-c cited" data-status="cited">
            <span class="mx-v mx-v-mention"><span class="mx-marker">◐</span><span class="mx-label">cited</span></span>
            <span class="mx-v mx-v-position">${posTxt ? `<span class="mx-pos">${posTxt}</span>` : `<span class="mx-status">no rank</span>`}</span>
            ${sBlock}
          </div>`;
        }
        if (status === 'error') {
          // Generic message — keep verbose error reason in DOM (data-detail) for
          // diagnostics but show readers a clean "unavailable" pill. Persona
          // research: verbose billing/quota errors read as unprofessional in
          // a conversion surface.
          const detail = col.errorMessage
            ? String(col.errorMessage).slice(0, 240)
            : 'engine returned an error for this query';
          return `<div class="mx-c err" data-status="error" title="Engine unavailable for this query — re-run later" tabindex="0" aria-label="Engine unavailable for this query" data-detail="${esc(detail)}">
            <span class="mx-v mx-v-mention"><span class="mx-marker">✕</span><span class="mx-label">error</span></span>
            <span class="mx-v mx-v-position"><span class="mx-status">retry run</span></span>
            <span class="mx-v mx-v-sentiment"><span class="mx-sent-dot">✕</span><span class="mx-sent-label">n/a</span></span>
          </div>`;
        }
        // mention='no' — engine answered but didn't name us. Surface the
        // most informative scrap we have: top competitor named in this cell.
        // The verbose `no mention` label used to dominate the cell visually
        // and repeat 6+ times across the grid — pure noise. Cell now reads
        // as: marker glyph + (competitor chip OR pool ratio) only. The
        // status is encoded via cell background tone + glyph; legend
        // explains the colour scheme.
        const comps = (col.competitors || []).filter(c => c && c.name);
        const topCompName = comps[0]?.name || '';
        const moreCount = comps.length > 1 ? (comps.length - 1) : 0;
        const poolSize = col.citationCount || 0;
        const poolHint = poolSize > 0 ? `0 / ${poolSize} cited` : '';
        const compNamed = Boolean(topCompName);
        const tooltip = comps.length > 0
          ? `Engine answered. Named instead: ${comps.map(c => c.name).join(', ')}${poolHint ? ` · ${poolHint}` : ''}`
          : (poolSize > 0 ? `Engine answered citing ${poolSize} source${poolSize !== 1 ? 's' : ''} but named no brands; none of those sources are yours.` : 'Engine answered. No brands named.');
        const noStatus = compNamed ? 'competitor' : 'empty';
        const mentionInner = compNamed
          ? `<span class="mx-marker">↳</span><span class="mx-comp"><span class="mx-comp-prefix">vs</span><span class="mx-comp-name">${esc(topCompName)}</span>${moreCount > 0 ? `<sup class="mx-comp-more">+${moreCount}</sup>` : ''}</span>`
          : poolHint
            ? `<span class="mx-marker">○</span><span class="mx-comp"><span class="mx-comp-name">${esc(poolHint)}</span></span>`
            : `<span class="mx-marker">○</span><span class="mx-label">clean</span>`;
        return `<div class="mx-c no" data-status="${noStatus}" title="${esc(tooltip)}">
          <span class="mx-v mx-v-mention">${mentionInner}</span>
          <span class="mx-v mx-v-position">${poolHint ? `<span class="mx-status">${esc(poolHint)}</span>` : `<span class="mx-status">no rank</span>`}</span>
          <span class="mx-v mx-v-sentiment"><span class="mx-sent-dot">○</span><span class="mx-sent-label">n/a</span></span>
        </div>`;
      }).join('');
      // Per-row roll-up: «X / N» named-or-cited fraction. Tone reflects the
      // ratio: any hits → accent (good signal in this row), zero hits → muted.
      const rowTone = rowNamed > 0 ? 'good' : 'muted';
      const rowTotalCell = `<div class="mx-c mx-c-total" data-tone="${rowTone}"><span class="mx-row-num">${rowNamed}</span><span class="mx-row-den">/ ${rowTotal}</span></div>`;
      return `<div class="mx-q"><span class="qpre">${esc(qLabel)}</span><span class="qrest">${esc(qText)}</span></div>${cells}${rowTotalCell}`;
    }).join('');

    // Summary bar — one-line aggregate so the reader gets a takeaway before
    // scanning rows. Stats hidden when zero (e.g. no competitor mentions →
    // don't surface a 0-count stat that adds no signal).
    const summaryStats = [
      `<span class="mx-sum-stat" data-tone="${mxYours > 0 ? 'good' : 'muted'}"><strong class="mx-sum-num">${mxYours}</strong><span class="mx-sum-denom">/ ${mxAgg.totalCells}</span><span class="mx-sum-label">${mxYours === 1 ? 'cell' : 'cells'} with your brand</span></span>`,
      mxAgg.totalComps > 0 ? `<span class="mx-sum-stat" data-tone="editor"><strong class="mx-sum-num">${mxAgg.totalComps}</strong><span class="mx-sum-label">competitor mention${mxAgg.totalComps === 1 ? '' : 's'} logged</span></span>` : '',
      mxAgg.totalCites > 0 ? `<span class="mx-sum-stat" data-tone="${mxAgg.ourCiteCells > 0 ? 'good' : 'muted'}"><strong class="mx-sum-num">${mxAgg.totalCites}</strong><span class="mx-sum-label">URLs in citation pool${mxAgg.ourCiteCells > 0 ? ` · yours in ${mxAgg.ourCiteCells} cell${mxAgg.ourCiteCells === 1 ? '' : 's'}` : ''}</span></span>` : '',
      mxAgg.error > 0 ? `<span class="mx-sum-stat" data-tone="bad"><strong class="mx-sum-num">${mxAgg.error}</strong><span class="mx-sum-label">engine error${mxAgg.error === 1 ? '' : 's'}</span></span>` : '',
    ].filter(Boolean).join('');

    visibilityCells.push(`
      <article class="cell span-6 dominant editor">
        <div class="cell-head">
          <span class="cell-label">Query × engine matrix <span class="merge">heatmap + position + sentiment</span></span>
          <div class="matrix-toggle" role="group" aria-label="Matrix view">
            <button type="button" aria-pressed="true">Mention</button>
            <button type="button" aria-pressed="false">Position</button>
            <button type="button" aria-pressed="false">Sentiment</button>
          </div>
        </div>
        <p class="cell-sub" style="margin: 0;">Each cell is one AI answer. Status badge tells you what the engine did with your brand.</p>
        <div class="mx-summary" aria-label="Matrix totals">${summaryStats}</div>
        <div class="matrix-grid" data-view="mention" data-sentiment-scored="${summary.positionMatrix.flatMap(r => r.columns).filter(c => c.sentiment && c.sentiment.label).length}" style="--cols: ${(summary.engines || []).length || 3}">
          <div class="mx-h">Query</div>${headerCells}<div class="mx-h mx-h-total">row Σ</div>
          ${rows}
        </div>
        <div class="mx-sentiment-empty" aria-live="polite">
          <span class="mx-empty-glyph" aria-hidden="true">○</span>
          <strong class="mx-empty-title">No sentiment data this run</strong>
          <p class="mx-empty-body">Sentiment is computed only when AI names the brand in its answer. This run: 0 named cells → nothing to classify. Earn a mention first — see Citations and Actions below.</p>
        </div>
        <div class="mx-legend" data-view-show="mention" aria-label="Mention view legend">
          <span class="mx-leg" data-status="named"><span class="mx-leg-swatch"></span><span class="mx-leg-text">named — brand surfaced</span></span>
          <span class="mx-leg" data-status="cited"><span class="mx-leg-swatch"></span><span class="mx-leg-text">cited — brand sourced</span></span>
          <span class="mx-leg" data-status="competitor"><span class="mx-leg-swatch"></span><span class="mx-leg-text">no mention — competitor named</span></span>
          <span class="mx-leg" data-status="empty"><span class="mx-leg-swatch"></span><span class="mx-leg-text">no mention — clean blank</span></span>
          <span class="mx-leg" data-status="error"><span class="mx-leg-swatch"></span><span class="mx-leg-text">error — engine unavailable</span></span>
        </div>
        <div class="mx-legend" data-view-show="position" aria-label="Position view legend">
          <span class="mx-leg-caption">Position view shows <strong>brand rank #N</strong> when AI named you, or <strong>0 / N cited</strong> showing your share of the citation pool.</span>
        </div>
        <div class="mx-legend" data-view-show="sentiment" aria-label="Sentiment view legend">
          <span class="mx-leg-caption">Sentiment view classifies how AI framed your brand: <strong style="color:var(--good)">● positive</strong> · <strong style="color:var(--ink-3)">● neutral</strong> · <strong style="color:var(--bad)">● negative</strong>. Only computed for named/cited cells.</span>
        </div>
      </article>`);
  }
  // Geo (only if multi-region)
  if (summary.regionCount > 1 && S.geo) {
    visibilityCells.push(`
      <article class="cell span-6 quiet">
        <div class="cell-head"><span class="cell-label">By region · ${summary.regionCount} markets</span></div>
        ${S.geo}
      </article>`);
  }
  // Verbatim quotes (only if populated — currently always empty until v0.5.1 wires it up)
  if ((summary.quotes || []).length > 0) {
    const quotesHtml = summary.quotes.map(q => {
      const en = ENGINES[q.provider] || { label: q.provider, code: '??', color: TOKENS.ink };
      return `<figure class="quote">
        <div class="quote-meta">
          <span class="engine-tag" style="--eng:${en.color}">${esc(en.code)} ${esc(en.label)}</span>
          <span class="quote-query">${esc(q.query)}</span>
        </div>
        <blockquote>${esc(q.text)}</blockquote>
      </figure>`;
    }).join('');
    visibilityCells.push(`
      <article class="cell span-6 quiet">
        <div class="cell-head"><span class="cell-label">Verbatim mentions</span></div>
        <h3 class="cell-title">What AI actually said</h3>
        <div class="quotes">${quotesHtml}</div>
      </article>`);
  }

  // ── Section 03 — Competitors ──
  // Same stable tie-break as the hero KPI: count DESC, name ASC. Keeps the
  // ranked list visually consistent with whoever the hero highlights.
  const competitorsCells = [];
  const realComps = (summary.competitors || [])
    .filter(c => !c.accent)
    .slice()
    .sort((a, b) => {
      if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  if (realComps.length > 0) {
    const maxCount = realComps[0]?.count || 1;
    const items = realComps.slice(0, 8).map((c, i) => {
      const w = Math.max(8, Math.round((c.count / maxCount) * 100));
      const lead = i === 0 ? ' lead' : '';
      return `<li class="comp-li${lead}"><span class="comp-rank">${String(i + 1).padStart(2, '0')}</span><span class="comp-name">${esc(c.name)}</span><span class="comp-bar" style="--w: ${w}%"></span><span class="comp-count">${c.count}<small>×</small></span></li>`;
    }).join('');
    const totalMentions = realComps.reduce((s, c) => s + c.count, 0);
    const top3Sum = realComps.slice(0, 3).reduce((s, c) => s + c.count, 0);
    competitorsCells.push(`
      <article class="cell span-3 quiet">
        <div class="cell-head"><span class="cell-label">Most-named brands</span></div>
        <h3 class="cell-title">${esc(realComps[0].name)} leads</h3>
        <p class="cell-sub">${realComps.length} distinct competitors named. Top 3 collected ${top3Sum} of ${totalMentions} mentions.</p>
        <ol class="comp-list">${items}</ol>
      </article>`);
  }
  // Combined radar — single SVG with brand polygon overlaid on top-3 avg.
  // Headline branches off the gap between user and avg total: behind on
  // every axis vs leading vs mixed.
  const radarData = snapshots ? competitorRadarHtml(snapshots) : null;
  if (radarData) {
    const u = radarData.userAxes;
    const a = radarData.avgAxes;
    const axisDefs = [
      { key: 'presence',  label: 'Presence'  },
      { key: 'mentions',  label: 'Mentions'  },
      { key: 'rank',      label: 'Rank'      },
      { key: 'sentiment', label: 'Sentiment' },
    ];
    const behindCount = axisDefs.filter(({ key }) => (u[key] || 0) < (a[key] || 0)).length;
    const aheadCount  = axisDefs.filter(({ key }) => (u[key] || 0) > (a[key] || 0)).length;
    let radarTitle;
    if (behindCount === 4) radarTitle = 'Behind on every axis';
    else if (aheadCount === 4) radarTitle = 'Ahead on every axis';
    else if (behindCount > aheadCount) radarTitle = `Behind on ${behindCount} of 4 axes`;
    else if (aheadCount > behindCount) radarTitle = `Ahead on ${aheadCount} of 4 axes`;
    else radarTitle = 'Mixed vs top-3 avg';
    // Mini stats table — gives the reader explicit numbers next to the chart
    // so two near-identical polygons don't read as «зачем график вообще».
    const statRows = axisDefs.map(({ key, label }) => {
      const uv = Math.round(u[key] || 0);
      const av = Math.round(a[key] || 0);
      const d = uv - av;
      const sign = d > 0 ? '+' : '';
      const tone = d > 0 ? 'pos' : (d < 0 ? 'neg' : 'flat');
      return `<div class="radar-row">
        <span class="radar-axis">${label}</span>
        <span class="radar-num">${uv}</span>
        <span class="radar-num radar-num-avg">${av}</span>
        <span class="radar-delta ${tone}">${d === 0 ? '=' : `${sign}${d}`}</span>
      </div>`;
    }).join('');
    competitorsCells.push(`
      <article class="cell span-3 tall dominant">
        <div class="cell-head">
          <span class="cell-label">4-axis radar</span>
        </div>
        <h3 class="cell-title">${esc(radarTitle)}</h3>
        <p class="cell-sub">Each axis 0–100. Larger polygon = stronger signal; your shape outside the top-3 reference = ahead, inside = behind.</p>
        <div class="cell-body" style="display:block;">
          ${radarData.svg}
          <div class="radar-stats" role="table" aria-label="Per-axis values: you vs top-3 average">
            <div class="radar-row radar-head" role="row">
              <span>Axis</span>
              <span>You</span>
              <span>Top-3</span>
              <span>Δ</span>
            </div>
            ${statRows}
          </div>
        </div>
      </article>`);
  }

  // ── Section 04 — Citations ──
  const citationsCells = [];
  if ((summary.topDomains || []).length > 0) {
    const top6 = summary.topDomains.slice(0, 6);
    const ownDomain = summary.meta.domain;
    // Normalize bar width relative to top-1 share so the leader fills the
    // visible track and every other row reads as a fraction of it. Raw share
    // (2-8%) is invisible at full-width scale. --w-raw kept for the label.
    // --w-norm gets a min floor of 6% so even microscopic rows have a sliver
    // of bar to draw attention to the count beside them.
    const topShare = top6[0]?.share || 1;
    const rows = top6.map(d => {
      const isOwn = d.host === ownDomain;
      const raw = (d.share * 100).toFixed(0);
      const ratio = topShare > 0 ? (d.share / topShare) : 0;
      const norm = Math.max(6, Math.round(ratio * 100));
      return `<div class="dom-row${isOwn ? ' owned' : ''}" style="--w-norm: ${norm}%; --w-raw: ${raw}%;">
        <div class="dom-bar-wrap"><span class="dom-name"${isOwn ? ' style="color: var(--accent);"' : ''}>${esc(d.host)}</span><div class="dom-bar"></div></div>
        <span class="dom-pct"${isOwn ? ' style="color: var(--accent);"' : ''}>${raw}%</span>
      </div>`;
    }).join('');
    const own = (summary.topDomains || []).find(d => d.host === ownDomain);
    const hasOwn = !!own;
    const ownRow = hasOwn ? '' : `<div class="dom-row owned" style="--w-norm: 6%; --w-raw: 0%;">
      <div class="dom-bar-wrap"><span class="dom-name" style="color: var(--accent);">${esc(ownDomain)}</span><div class="dom-bar"></div></div>
      <span class="dom-pct" style="color: var(--accent);">0%</span>
    </div>`;
    // Title reflects the actual concentration of the citation pool: own
    // domain present? top-1 dominates? Or even spread? Static «Pitch the top 3»
    // always read the same regardless of whether you're already on the list
    // or not.
    const topDomainsList = summary.topDomains;
    const top1Share = topDomainsList[0]?.share || 0;
    const top3Sum = topDomainsList.slice(0, 3).reduce((s, d) => s + (d.share || 0), 0);
    let domainTitle;
    if (hasOwn) {
      domainTitle = `${esc(ownDomain)} is in the pool — defend it`;
    } else if (top1Share >= 0.30) {
      domainTitle = `${esc(topDomainsList[0].host)} carries the pool`;
    } else if (top3Sum >= 0.60) {
      domainTitle = `Pitch the top 3 first`;
    } else {
      domainTitle = `Citations spread across ${topDomainsList.length} domains`;
    }
    citationsCells.push(`
      <article class="cell span-4 dominant editor">
        <div class="cell-head"><span class="cell-label">Domain share of voice</span><span class="cell-action cell-action--info">All ${summary.topDomains.length} domains</span></div>
        <h3 class="cell-title">${domainTitle}</h3>
        <p class="cell-sub">These publishers feed AI most of the category citations. ${hasOwn ? 'You\'re in the list — defend it.' : `${esc(ownDomain)} isn't on any of them.`}</p>
        <div class="cell-body" style="display: block;">${rows}${ownRow}</div>
      </article>`);
  }
  if (categories.length > 0) {
    // Normalize category bars vs top-category share so the leader fills
    // the track and weaker categories read as fractions. Same pattern as
    // Domain SOV / Topic clusters. Lead category gets accent-tint row.
    const maxCatShare = categories[0]?.share || 1;
    const rows = categories.map((c, i) => {
      const ratio = maxCatShare > 0 ? (c.share / maxCatShare) : 0;
      const norm = Math.max(8, Math.round(ratio * 100));
      const pct = Math.round((c.share || 0) * 100);
      const lead = i === 0 ? ' lead' : '';
      return `<div class="cat-row${lead}" style="--w-norm: ${norm}%;">
        <span class="cat-name">${esc(c.label)}</span>
        <div class="cat-bar"></div>
        <span class="cat-pct">${pct}<small>%</small></span>
      </div>`;
    }).join('');
    const top = categories[0];
    const topPct = Math.round((top.share || 0) * 100);
    // Title tone shifts on concentration. Static «Other dominate» also had a
    // grammar bug — singular subject took plural verb. Fixed: "leads" /
    // "dominates" / "Mixed across N categories" depending on shape.
    let categoryTitle;
    if (categories.length === 1) {
      categoryTitle = `Only ${esc(top.label)} cited`;
    } else if ((top.share || 0) >= 0.5) {
      categoryTitle = `${esc(top.label)} dominates`;
    } else if ((top.share || 0) >= 0.3) {
      categoryTitle = `${esc(top.label)} leads`;
    } else {
      categoryTitle = `Mixed across ${categories.length} categories`;
    }
    // Subtitle now reports the concentration so the reader sees the
    // actionable angle without reading rows by themselves.
    let categorySub;
    if (categories.length === 1) {
      categorySub = `Single category in the citation pool — concentrate outreach there.`;
    } else if ((top.share || 0) >= 0.5) {
      categorySub = `${esc(top.label)} carries ${topPct}% of citations — that's where the lift compounds.`;
    } else if ((top.share || 0) >= 0.3) {
      categorySub = `${esc(top.label)} leads at ${topPct}%; lower tiers each need a different outreach play.`;
    } else {
      categorySub = `Citations split across ${categories.length} categories — diversified outreach beats single-channel pushes.`;
    }
    citationsCells.push(`
      <article class="cell span-2 quiet">
        <div class="cell-head"><span class="cell-label">By category</span></div>
        <h3 class="cell-title">${categoryTitle}</h3>
        <p class="cell-sub">${categorySub}</p>
        <div class="cell-body" style="display: block;">${rows}</div>
      </article>`);
  }
  // Renders only when outreach generation is re-enabled at html.js:367.
  // Currently S.outreach is null because pitch generation includes competitor
  // domains alongside publishers; restore when classifier ships.
  if (S.outreach) {
    citationsCells.push(`
      <article class="cell span-6">
        <div class="cell-head"><span class="cell-label">Outreach drafts <span class="merge">${(summary.outreachTemplates || []).length} top domains</span></span></div>
        ${S.outreach}
      </article>`);
  }

  // ── Section 05 — Actions ──
  const actionsCells = [];
  if (actionPlan.length > 0) {
    const actKindLabel = { gap: 'Outreach', defend: 'Defend', compete: 'Content', win: 'Listings' };
    const actPrioLabel = { high: 'High', med: 'Med', low: 'Low' };
    const actPrioClass = { high: 'high', med: '', low: '' };
    const rows = actionPlan.map((a, i) => {
      const cls = actPrioClass[a.priority] || '';
      const prioText = actPrioLabel[a.priority] || a.priority;
      const kindText = actKindLabel[a.kind] || a.kind;
      // Day chip hidden entirely when assignDays returned null (skewed
      // distribution — would be misleading to fake a number).
      const dayChip = a.day ? `<span class="day">${esc(a.day)}</span>` : '';
      return `<div class="act-row" data-prio="${esc(a.priority || 'med')}">
        <span class="act-num">${String(i + 1).padStart(2, '0')}</span>
        <div class="act-body">
          <h4 class="act-title">${esc(a.title)}</h4>
          <p class="act-detail">${esc(a.detail)}</p>
          <div class="act-meta">
            ${dayChip}
            <span class="act-kind">${esc(kindText)}</span>
          </div>
        </div>
        <span class="act-prio ${cls}" data-prio="${esc(a.priority || 'med')}">
          <span class="act-prio-dot" aria-hidden="true"></span>
          <span class="act-prio-label">${esc(prioText)}</span>
        </span>
      </div>`;
    }).join('');
    actionsCells.push(`
      <article class="cell span-6 dominant">
        <div class="cell-head">
          <span class="cell-label">Recommended actions <span class="merge">absorbs Actionable Gaps</span></span>
        </div>
        <h3 class="cell-title">${actionPlan.length} ordered moves</h3>
        <p class="cell-sub">Prioritised by visibility-gap impact. Day labels are heuristic — adjust to your week.</p>
        <div class="act">${rows}</div>
      </article>`);
  }

  // ── Section 06 — Diagnostics ──
  const diagnosticsCells = [];
  // Site readiness
  if (discover && crawlSummary) {
    const score = discover.score;
    const tone = score >= 70 ? 'good' : score >= 40 ? 'warn' : 'bad';
    const robotsBytes = summary.crawlability?.robots?.bytes;
    const sitemapUrls = summary.crawlability?.sitemap?.urlCount;
    const total = crawlSummary.totalBots || 0;
    const notBlocked = total - (crawlSummary.blockedCount || 0);
    diagnosticsCells.push(`
      <article class="cell span-3 dominant">
        <div class="cell-head"><span class="cell-label">Site readiness <span class="merge">crawlability + AI-bot crawl readiness + llms.txt</span></span></div>
        <h3 class="cell-title">${score >= 70 ? 'Fully crawlable' : score >= 40 ? 'Partially crawlable' : 'Blocked'}</h3>
        <div class="big-num ${tone}" data-size="64">${score}<small>/100</small></div>
        <div class="cell-body" style="display: block; margin-top: 16px;">
          <div class="ready-row"><span class="label"><span class="ck${crawlSummary.hasRobots ? '' : ' bad'}">${crawlSummary.hasRobots ? '✓' : '✕'}</span>robots.txt</span><span class="meta">${robotsBytes ? `${robotsBytes} bytes` : 'missing'}</span></div>
          <div class="ready-row"><span class="label"><span class="ck${crawlSummary.hasLlmsTxt ? '' : ' warn'}">${crawlSummary.hasLlmsTxt ? '✓' : '!'}</span>llms.txt</span><span class="meta">${crawlSummary.hasLlmsTxt ? 'present' : 'missing'}</span></div>
          <div class="ready-row"><span class="label"><span class="ck${crawlSummary.hasSitemap ? '' : ' bad'}">${crawlSummary.hasSitemap ? '✓' : '✕'}</span>sitemap.xml</span><span class="meta">${sitemapUrls ? `${sitemapUrls} URLs` : 'missing'}</span></div>
          <div class="ready-row"><span class="label"><span class="ck${notBlocked === total ? '' : ' warn'}">${notBlocked === total ? '✓' : '!'}</span>${notBlocked} / ${total} AI crawlers</span><span class="meta">${notBlocked === total ? 'all allowed' : `${total - notBlocked} blocked`}</span></div>
        </div>
      </article>`);
  }
  // Authority presence
  if (S.authority) {
    diagnosticsCells.push(`
      <article class="cell span-3">
        <div class="cell-head"><span class="cell-label">Authority presence</span></div>
        ${S.authority}
      </article>`);
  }
  // Cost — suppressed entirely in --public mode (publishing our own per-run
  // API spend is a pricing liability against the paid tier on the same page).
  if (engineCosts.length > 0 && !publicMode) {
    const sessionCost = summary.sessionCostUsd || 0;
    const totalTokens = engineCosts.reduce((s, c) => s + (c.inputTokens || 0) + (c.outputTokens || 0), 0);
    const rows = engineCosts.map((c, i) => {
      const provVar = ENGINE_VAR[c.provider] || '--ink-3';
      const last = i === engineCosts.length - 1 ? ' is-last' : '';
      return `<div class="cost-row${last}">
        <span class="cost-eng" style="--c: var(${provVar}, var(--ink-3))">${esc(c.label)}</span>
        <span class="cost-usd">$${(c.costUsd || 0).toFixed(2)}</span>
      </div>`;
    }).join('');
    diagnosticsCells.push(`
      <article class="cell span-2 quiet">
        <div class="cell-head"><span class="cell-label">Session cost</span></div>
        <h3 class="cell-title">$${sessionCost.toFixed(2)} / run</h3>
        <p class="cell-sub">${(totalTokens / 1000).toFixed(0)}k tokens · ${engineCosts.length} engine${engineCosts.length !== 1 ? 's' : ''}</p>
        <div class="cell-body" style="display: block; margin-top: 12px;">${rows}</div>
      </article>`);
  }
  // Geo indicator. Title surfaces the actual region label (or "Untargeted"
  // when no --geo was set — engines answered without geographic priming).
  // Static «US only» was a false claim: a default run isn't pinned to US,
  // it's just untargeted prompts AI engines happen to answer with their
  // own implicit defaults.
  const geoRegions = summary.regions || [];
  let geoTitle;
  let geoSub;
  const geoTone = summary.regionCount > 1 ? 'good' : (geoRegions.length === 1 ? 'warm' : 'muted');
  if (summary.regionCount > 1) {
    geoTitle = `${summary.regionCount} regions`;
    geoSub = `Run priced ${summary.regionCount}× — multi-region context active.`;
  } else if (geoRegions.length === 1 && REGIONS[geoRegions[0]]) {
    geoTitle = REGIONS[geoRegions[0]].label;
    geoSub = `Single-region run pinned to ${REGIONS[geoRegions[0]].label}. Add more codes to <code class="inline-flag">--geo</code> for comparative context.`;
  } else {
    geoTitle = 'Untargeted';
    geoSub = `No region context this run — AI engines answered with their own implicit defaults. Add <code class="inline-flag">--geo=us,uk,de</code> for pinned regional context.`;
  }
  diagnosticsCells.push(`
    <article class="cell span-2 quiet" data-tone="${geoTone}">
      <div class="cell-head"><span class="cell-label">Geo</span></div>
      <h3 class="cell-title">${esc(geoTitle)}</h3>
      <p class="cell-sub">${geoSub}</p>
      <div class="ratio geo-ratio" data-tone="${geoTone}" style="margin-top: auto;">
        <span class="ratio-main">${summary.regionCount}</span>
        <span class="ratio-stack">
          <span class="ratio-denom">region${summary.regionCount !== 1 ? 's' : ''}</span>
          <span class="ratio-context">${summary.regionCount > 1 ? 'multi-region' : geoRegions.length === 1 ? 'single-region' : 'untargeted'}</span>
        </span>
      </div>
    </article>`);
  // AI ads
  if (summary.adsDetected) {
    const ads = summary.adsDetected;
    const hasAds = (ads.totalCellsWithAdSignal || 0) > 0;
    diagnosticsCells.push(`
      <article class="cell span-2 quiet">
        <div class="cell-head"><span class="cell-label">AI ads detected</span></div>
        <h3 class="cell-title">${hasAds ? 'Sponsored slots seen' : 'Clean'}</h3>
        <p class="cell-sub">${hasAds
          ? `${ads.totalCellsWithAdSignal} cell${ads.totalCellsWithAdSignal !== 1 ? 's' : ''} contained sponsored markers.`
          : 'No sponsored slots in answers about your category this run.'}</p>
        <div class="big-num ${hasAds ? 'warn' : 'good'}" data-size="36" style="margin-top: auto;">${ads.totalCellsWithAdSignal || 0}<small> ad${ads.totalCellsWithAdSignal === 1 ? '' : 's'}</small></div>
      </article>`);
  }
  // UTM
  if (utmAgg) {
    const hasUtm = utmAgg.totalUtmCitations > 0;
    // Two distinct states: configured-with-hits (show count) vs.
    // not-configured (show explicit empty-state with hint card). Dash-as-empty
    // («—» in muted ink-3) was an anti-pattern — it read as «broken data»
    // rather than «not set up yet, here's how».
    if (hasUtm) {
      diagnosticsCells.push(`
        <article class="cell span-2 quiet">
          <div class="cell-head"><span class="cell-label">UTM citations</span></div>
          <h3 class="cell-title">${utmAgg.totalUtmCitations} tagged hit${utmAgg.totalUtmCitations !== 1 ? 's' : ''}</h3>
          <p class="cell-sub">AI traffic with UTM attribution.</p>
          <div class="big-num utm-num" data-size="36">${utmAgg.totalUtmCitations}</div>
        </article>`);
    } else {
      diagnosticsCells.push(`
        <article class="cell span-2 quiet utm-empty">
          <div class="cell-head"><span class="cell-label">UTM citations</span></div>
          <h3 class="cell-title">Not configured</h3>
          <p class="cell-sub">Tag outbound links so AI traffic shows up in your analytics.</p>
          <div class="empty-callout">
            <span class="empty-callout-tag">how</span>
            <code class="empty-callout-code">?utm_source=ai&amp;utm_medium=chatgpt</code>
          </div>
        </article>`);
    }
  }

  // ── Section spec — single source of truth ──
  // One array drives: section ordering, rail navigation, section overlines
  // (chapter intros), and the next-section handoff arrow. Reordering this
  // array reorders the report consistently; handoff derives the next id/num
  // automatically so it never goes out of sync.
  const SECTIONS = [
    { id: 'overview',    num: '01', label: 'Overview',    subtitle: 'where the score is heading',           cells: overviewCells,
      emptyMsg: 'Overview lights up after run #2 — historical trend and topic clusters need ≥2 snapshots to compare.' },
    { id: 'visibility',  num: '02', label: 'Visibility',  subtitle: 'per engine, by query',                 cells: visibilityCells,
      emptyMsg: 'No visibility data this run.' },
    { id: 'competitors', num: '03', label: 'Competitors', subtitle: 'who AI named instead',                 cells: competitorsCells,
      emptyMsg: 'No competitors detected — AI engines either didn\'t name brands in their answers, or all queries errored.' },
    { id: 'citations',   num: '04', label: 'Citations',   subtitle: 'who AI cites about your category',     cells: citationsCells,
      emptyMsg: 'No citations earned this run. Domains aren\'t in AI engines\' source pools yet — citation pickup is the unlock. Run aeo-platform run weekly to track this.' },
    { id: 'actions',     num: '05', label: 'Actions',     subtitle: 'what to ship this week',               cells: actionsCells,
      emptyMsg: 'Action plan generates after the LLM-recommendations pass during aeo-platform report. Re-run report --html to populate.' },
    { id: 'diagnostics', num: '06', label: 'Diagnostics', subtitle: 'site readiness, cost, ads',            cells: diagnosticsCells,
      emptyMsg: 'Diagnostic data populates during aeo-platform report — re-run to fetch crawlability, authority, and cost cells.' },
  ];

  // ── Section header — editorial overline ──
  // span-6 overline: oversized serif numeral on the left, kicker + question
  // on the centre, hand-off arrow to the next section on the right. Reads
  // as a chapter intro in print, replacing the bare dashed strip from v0.5.
  const sectionOverline = (idx) => {
    const s = SECTIONS[idx];
    const nextS = SECTIONS[idx + 1];
    const handoff = nextS
      ? `next · ${nextS.num} ${nextS.label.toLowerCase()}`
      : 'end of report';
    return `<header class="section-overline">
      <span class="so-numeral">${esc(s.num)}</span>
      <span class="so-body">
        <span class="so-kicker">${esc(s.label)}</span>
        ${s.subtitle ? `<h2 class="so-question">${esc(s.subtitle)}</h2>` : ''}
      </span>
      <span class="so-handoff">${esc(handoff)}</span>
    </header>`;
  };

  // ── Render each section ──
  // Empty sections still render their numbered header + a single placeholder
  // cell. This keeps the rail nav numbering continuous (01-06 with no holes)
  // — a missing «04» between «03» and «05» reads as a broken build, not as
  // «no data». Placeholder explains why the section is empty + how to fill it.
  const sectionPlaceholder = (msg) =>
    `<article class="cell span-6 cell-empty">${esc(msg)}</article>`;

  const sectionsHtml = SECTIONS.map((s, idx) => {
    const overline = sectionOverline(idx);
    if (s.cells.length === 0) {
      if (!s.emptyMsg) return '';
      return `<section id="${s.id}" class="bento">${overline}${sectionPlaceholder(s.emptyMsg)}</section>`;
    }
    return `<section id="${s.id}" class="bento">${overline}${s.cells.join('')}</section>`;
  }).filter(Boolean).join('\n');

  // ── Rail nav (only sections that actually rendered) ──
  const railLinks = SECTIONS.filter(s => s.cells.length > 0);
  const railHtml = railLinks.map((s, i) =>
    `<a href="#${s.id}"${i === 0 ? ' class="active"' : ''}><span class="rail-num">${s.num}</span> ${esc(s.label)}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AEO Visibility · ${esc(summary.meta.brand)} · ${esc(summary.meta.date)}</title>
<style>${css}</style>
</head>
<body>
<main class="page">

  <header class="mast">
    <div class="mast-tools">
      <div class="mast-mark"><span class="mast-mark-dot" aria-hidden="true"></span><strong>aeo-platform</strong>${opts.pkgVersion ? `<span class="mast-mark-ver">v${esc(opts.pkgVersion)}</span>` : ''}</div>
      <dl class="mast-meta">
        <div><dt>Run</dt><dd>${esc(summary.meta.date)}</dd></div>
        <div><dt>vs</dt><dd>${esc(summary.meta.prevDate || '—')}</dd></div>
        <div><dt>Queries</dt><dd>${summary.meta.queryCount}</dd></div>
      </dl>
      <div class="mast-engines" title="Engines surveyed this run">${enginePills}</div>
    </div>
    <div class="mast-headline">
      <h1 class="mast-title">${esc(summary.meta.brand)}</h1>
      <span class="mast-domain">${esc(summary.meta.domain)}</span>
    </div>
    ${(summary.meta.measurementShort || summary.meta.measurement?.disclaimer) ? `<p class="mast-disclaimer" title="${esc(summary.meta.measurement?.disclaimer || '')}">${esc(summary.meta.measurementShort || summary.meta.measurement?.disclaimer)}</p>` : ''}
  </header>

  ${railHtml ? `<nav class="rail" aria-label="Section outline">
    <span class="rail-label">Sections</span>
    ${railHtml}
  </nav>` : ''}

  <section class="hero" aria-label="Headline visibility score">
    <div class="hero-ghost" aria-hidden="true">
      <svg viewBox="0 0 600 200" preserveAspectRatio="none">
        <defs>
          <linearGradient id="ghostGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#B85C16" stop-opacity="0.28"/>
            <stop offset="1" stop-color="#B85C16" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="M0 180 L0 160 L150 158 L300 145 L450 110 L600 60 L600 200 L0 200 Z" fill="url(#ghostGrad)"/>
        <path d="M0 160 L150 158 L300 145 L450 110 L600 60" fill="none" stroke="#B85C16" stroke-opacity="0.7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <g fill="#B85C16" opacity="0.7">
          <circle cx="0"   cy="160" r="2.5"/>
          <circle cx="150" cy="158" r="2.5"/>
          <circle cx="300" cy="145" r="2.5"/>
          <circle cx="450" cy="110" r="2.5"/>
          <circle cx="600" cy="60"  r="3.5"/>
        </g>
      </svg>
    </div>

    <div class="hero-main">
      <div class="hero-kicker">
        <span class="hero-kicker-label">Unified Visibility Index</span>
      </div>
      <div class="hero-num-wrap">
        <span class="hero-num" id="heroNum">${uviScore}</span>
        <span class="hero-num-frac">/ 100</span>
        <span class="hero-bucket" data-bucket="${esc(bucket).toLowerCase()}">
          <span class="hero-bucket-bar" aria-hidden="true"></span>
          <span class="hero-bucket-label">${esc(bucket)}</span>
        </span>
      </div>
      ${heroUVIPopover}
      <p class="hero-narrative" data-drop="${(() => {
        // Drop cap on first letter is editorial-magazine signature, but it
        // breaks short all-caps abbreviations: «AI engines didn't…» renders
        // as «A I engines» (the giant A floats off, eye reads it as a
        // separate letter). Disable drop cap when the first word is a 2-4
        // letter all-caps token (AI, UX, CTO, FAQ, B2B etc.).
        const stripped = String(narrative).replace(/<[^>]+>/g, '').trim();
        const firstWord = stripped.split(/\s+/)[0] || '';
        return /^[A-Z]{2,4}\b/.test(firstWord) ? 'false' : 'true';
      })()}">${narrative}</p>
      ${deltaLine}
    </div>

    ${heroKpiCells.length > 0
      ? `<aside class="hero-side" aria-label="Supporting metrics">${heroKpiCells.join('')}</aside>`
      : ''}
  </section>

  ${mcBridgeMarkup}

  <div class="layout"><div class="content">
    ${sectionsHtml}
  </div></div>

  <footer class="colophon">
    <div class="colophon-ornament" aria-hidden="true">
      <span class="colophon-rule"></span>
      <span class="colophon-glyph">§</span>
      <span class="colophon-rule"></span>
    </div>
    <div class="colophon-meta">
      <span><strong>aeo-platform</strong></span>
      ${opts.pkgVersion ? `<span class="dot">·</span><span>v${esc(opts.pkgVersion)}</span>` : ''}
      <span class="dot">·</span>
      ${opts.repoUrl ? `<a href="${esc(opts.repoUrl)}">open source · zero deps</a>` : `<span>open source · zero deps</span>`}
      <span class="dot">·</span>
      <span>${esc(summary.meta.date)}</span>
      <span class="dot">·</span>
      <span class="colophon-runid">${esc(summary.meta.runId)}</span>
    </div>
  </footer>

</main>

<script>
${RENDER_INLINE_JS}
${mcBridgeBootstrap}
</script>
</body>
</html>`;
}

// ─── Inline JS (hero counter + scroll-spy + matrix sub-toggle) ─────────────

const RENDER_INLINE_JS = `
/* Hero number counter — counts 0 → target on first paint, with reduced-motion guard */
(function () {
  var el = document.getElementById('heroNum');
  if (!el) return;
  var target = parseInt(el.textContent, 10);
  if (!Number.isFinite(target)) { el.classList.add('is-ready'); return; }
  el.classList.add('is-ready');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.textContent = '0';
  var start = performance.now();
  var dur = 900;
  var ease = function (t) { return 1 - Math.pow(1 - t, 3); };
  function tick(now) {
    var t = Math.min(1, (now - start) / dur);
    el.textContent = String(Math.round(target * ease(t)));
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = String(target);
  }
  requestAnimationFrame(tick);
  setTimeout(function () { el.textContent = String(target); }, dur + 200);
})();

/* Scroll-spy for outline rail — IntersectionObserver picks active section */
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.rail a[href^="#"]'));
  var sections = links.map(function (a) { return document.querySelector(a.getAttribute('href')); }).filter(Boolean);
  if (!sections.length || typeof IntersectionObserver === 'undefined') return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        var id = '#' + e.target.id;
        links.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === id); });
      }
    });
  }, { rootMargin: '-30% 0px -60% 0px' });
  sections.forEach(function (s) { io.observe(s); });
})();

/* Matrix sub-toggle (Mention/Position/Sentiment) — flips data-view on the
   grid; CSS shows whichever per-cell .mx-v-{view} span matches. */
document.querySelectorAll('.matrix-toggle').forEach(function (group) {
  group.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    Array.prototype.slice.call(group.querySelectorAll('button')).forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    btn.setAttribute('aria-pressed', 'true');
    var view = (btn.textContent || '').trim().toLowerCase();
    if (view !== 'mention' && view !== 'position' && view !== 'sentiment') return;
    var section = btn.closest('article') || btn.closest('section');
    var grid = section ? section.querySelector('.matrix-grid') : null;
    if (grid) grid.setAttribute('data-view', view);
  });
});
`;

// ─── CSS ───────────────────────────────────────────────────────────────────

// Editorial token system + cell/matrix/section styles live in styles.css
// (single source of truth, ~2660 lines). Read once at module load — the
// renderHtml() function is hot-pathed during cmdReport, so synchronous
// read is fine.
//
// Why file-not-template: the v0.5 renderer embedded all CSS inside one
// huge backtick template literal. Backticks inside CSS comments (e.g.
// `--geo` mentioned in a code-style comment) silently closed the outer
// template and were parsed as JS — bit us twice. Moving CSS to a real
// .css file removes the bug class entirely and gives IDE CSS support.
const STYLES_CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'styles.css');
const STYLES_CSS = readFileSync(STYLES_CSS_PATH, 'utf-8');

function renderCss() {
  return STYLES_CSS;
}

