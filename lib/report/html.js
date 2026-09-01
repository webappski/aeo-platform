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
  radar,
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
  TOPIC_CLUSTER_MIN,
} from './sections.js';
import { mdToHtml } from './markdown-to-html.js';
import { buildAxisModel } from './axis-model.js';
import { computeComponents, computeUVI, computeUVIBreakdown, computeDiscoverability } from './visibility-index.js';
import { withoutDeadTactics } from './dead-tactics.js';
import { categorizeDomain, aggregateByCategory } from './domain-category.js';
import { clusterQueries } from './topic-cluster.js';
import { aggregateUtmCitations } from './utm-tracker.js';
import { REGIONS } from './geo-context.js';
import { bridgeCss, bridgeMarkup, bridgeJs } from './mc-bridge.js';
import { getFontFaceCss } from './fonts/index.js';
import { buildRunComparison } from './run-comparison.js';
import {
  buildAnswerHistory, groupByQuestion, headlineCell,
  isVisible, VERDICT, ST_NAMED, ST_CITED, ST_ABSENT,
} from './answer-history.js';
import {
  buildMetric, trendCapabilities, whereToAct as whereToActLine,
  coverageAllowsDelta, chipTone, formatDelta, round1,
  significanceFloor, expectedCellCount, isPartialRun, SHAPES_MIN_RUNS,
} from './trend-model.js';
import * as L from './loud.js';
import * as EG from './entity-graph.js';
import {
  buildRunMetrics, headlineMover, totalCitationCount, hostCitationCounts,
  buildVerdictHeadline, buildLiftOpportunity, buildLiftNarrative,
} from './run-metrics.js';

// ─── Constants ──────────────────────────────────────────────────────────────


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


function isListicle(host) {
  return LISTICLE_SLUGS.has(categorizeDomain(host).slug);
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


function daysBetween(isoDate, today = new Date()) {
  if (!isoDate) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const ms = today.getTime() - d.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}



// White-label-only style: the colophon methodology note + print rules so the
// reader can "Save as PDF" from the browser with clean margins and no clipped
// backgrounds (headless-free PDF path). Appended ONLY in white-label mode, so
// the default report's CSS is byte-identical (R39).
const WHITE_LABEL_CSS = `
.colophon-method { max-width: 60ch; margin: 0 auto 12px; font-size: 12px; line-height: 1.5; color: var(--ink-3, #6b6b6b); text-align: center; }
@page { margin: 14mm; }
@media print {
  html, body { background: #fff; }
  .rail { display: none; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cell, .bento, .hero, .section-overline { break-inside: avoid; }
}
`;

// ─── White-label methodology note ────────────────────────────────────────────
// Plain-text (esc'd at the call site), derived from the data — never hardcoded —
// so it stays true for any brand/basket. Honest by construction: states this is
// a single point-in-time snapshot with no confidence intervals.
function whiteLabelMethodologyText(latest) {
  const results = (latest && Array.isArray(latest.results)) ? latest.results : [];
  const queryCount = new Set(results.map(r => r.queryText || r.query)).size;
  const engineCount = new Set(results.map(r => r.provider)).size;
  const q = `${queryCount} buyer-intent quer${queryCount === 1 ? 'y' : 'ies'}`;
  const e = `${engineCount} AI engine${engineCount === 1 ? '' : 's'}`;
  return `Methodology: ${q} × ${e}, single snapshot on ${latest ? latest.date : ''}. `
    + 'Each engine was queried through its own answer API; a brand counts as '
    + '"mentioned" when it appears in the engine\'s answer. One point-in-time '
    + 'reading, not a longitudinal study — no confidence intervals are implied.';
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
  //
  // White-label client snapshot (--white-label) is a SUPERSET of public: on top
  // of the cost/footnote suppression it removes every tool/agency fingerprint
  // (masthead mark, colophon, version, repo link), the recommendation block, and
  // the Mission-Control bridge (the bridge is dropped upstream via noMcBlock).
  // The remaining statistics render in the same layout under a neutral title.
  const whiteLabel = opts.whiteLabel === true;
  const publicMode = opts.public === true || whiteLabel;
  const latest = snapshots && snapshots.length ? snapshots[snapshots.length - 1] : null;

  // ── Shared run figures ──
  // The headline index is NOT recomputed from today's component code against
  // an old snapshot: that answers "what would that run score under today's
  // rules", which is a different question and would put a different number in
  // the hero than on the chart. The stored per-run score is the one series the
  // hero, the chart and every chip read.
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
  // White-label client snapshots are statistics-only: the recommendation block
  // is removed (empty plan → the Actions section renders nothing).
  // Dead-tactic filter (AP-DEAD-TACTIC-LLMSTXT): `summary.actions` is
  // LLM-written, and a cached snapshot can carry advice the prompt now forbids.
  // Filtering at RENDER means old reports regenerate clean too. Drops are
  // announced on stderr by `withoutDeadTactics` — never silent.
  const actionPlan = whiteLabel ? [] : assignDays(withoutDeadTactics(summary.actions, 'report HTML'));

  // ── Site readiness (Diagnostics cell) ──
  // pageSignals feeds the server-rendered axis that replaced the llms.txt axis
  // (AP-DEAD-TACTIC-LLMSTXT). Absent → the axis is null and weights
  // re-normalise, so old snapshots still render a score.
  const discover = computeDiscoverability(summary.crawlability, summary.pageSignals);
  const crawlSummary = summary.crawlability?.summary;

  // ── Cost breakdown (Diagnostics cell) — exclude classify-tier rows ──
  const ENGINE_LABELS_MATCH = ['ChatGPT', 'Gemini', 'Claude', 'Perplexity'];
  const engineCosts = (summary.costBreakdown || []).filter(c => ENGINE_LABELS_MATCH.includes(c.label));

  // ── UTM citations (Diagnostics cell) ──
  const utmAgg = latest ? aggregateUtmCitations(latest.results || [], summary.meta.domain) : null;

  // ── MC bridge (single-state v8 visual, lives between sections and footer) ──
  // The legacy 5-state interactive flow was removed; CTA inside the bridge now
  // redirects users to the request-invoice page on webappski.com directly.
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
  let css = getFontFaceCss() + '\n' + renderCss()
    + (mcBridgeMarkup ? bridgeCss : '')
    + (whiteLabel ? WHITE_LABEL_CSS : '');
  // White-label: strip ALL CSS comments. The shared stylesheet carries inert
  // `/* … mc-bridge … */` authoring comments (and could grow more tool-named
  // ones); they never render, but they are still text in the file and would
  // trip a fingerprint scrub of the deliverable. Removing comments is safe
  // (comments are non-functional) and closes the leak class for any future
  // comment, not just today's two. Default report keeps its comments (R39).
  if (whiteLabel) css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // White-label: strip the dead `.outreach-*` rule blocks. The outreach-drafts
  // section never renders here (it is dropped from the white-label SECTIONS list
  // — and is globally disabled today), so these rules are unreachable. They are
  // still the literal text «.outreach-…» in the stylesheet, which a whole-file
  // `/outreach/i` fingerprint scrub of the deliverable would flag. Same reasoning
  // as the comment-strip above: remove inert text that has no render but reads as
  // a tell. Selector-anchored so only `.outreach…` rules (incl. the media-query
  // override block) are removed; every other rule is untouched. Default report
  // keeps the full stylesheet (R39).
  if (whiteLabel) {
    css = css.replace(/(?:^|\n)\s*\.outreach[^{}]*\{[^}]*\}/g, '');
    // The outreach block has a `@media (max-width: 760px) { .outreach-… }`
    // override; stripping its only rules leaves an empty media query. Collapse
    // any now-empty `@media … { }` so the white-label stylesheet stays clean.
    css = css.replace(/@media[^{]*\{\s*\}/g, '');
  }

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

  // ══════════════════════════════════════════════════════════════════════
  // LOUD REGISTER — models
  //
  // Everything below is derived. No sentence in the loud blocks is written
  // against one client's data: each is a template filled from the models
  // here, so the same generator on a clean run renders a calm report.
  // ══════════════════════════════════════════════════════════════════════
  const snaps = snapshots || [];
  // The ladder keys on the longer of the two histories the caller supplies.
  // `summary.trend` is the authoritative per-run score series and is what the
  // chart plots; `snapshots` is what the per-answer record walks. They match
  // in the normal pipeline, and taking the max means neither a trend-only nor
  // a snapshots-only caller silently loses its shape.
  const runCount = Math.max(snaps.length, (summary.trend || []).length);
  const caps = trendCapabilities(runCount);
  const prevSnapshot = runCount > 1 ? snaps[runCount - 2] : null;
  const expectedCells = expectedCellCount(snaps);
  const partialFlags = snaps.map(s => isPartialRun(s, expectedCells));
  const comparison = runCount > 1 ? buildRunComparison(snaps) : null;
  const history = buildAnswerHistory(snaps);
  const questionGroups = groupByQuestion(history.cells);
  const changedCell = headlineCell(history.cells);
  const runDates = summary.trendDates || snaps.map(s => s.date);
  const MIN_ALIAS_STEM = 6;
  // Every citation this run emitted, across all hosts — the correct
  // denominator for a share. `summary.totalCitations` counts only the
  // citations pointing at the brand's own domain and would make its share
  // read as 100%.
  const citationsAllHosts = totalCitationCount(latest) || 0;
  const hostCounts = hostCitationCounts(latest);
  // Rival brand -> the domain it owns, as classified during the run. Without
  // it a rival's share cannot be looked up at all, and printing "not a cited
  // host" for every rival would assert an absence the report never checked.
  const competitorDomain = new Map(
    (latest?.competitorPricing || [])
      .filter(c => c && c.name && typeof c.domain === 'string' && c.domain.trim())
      .map(c => [c.name, c.domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]]),
  );

  // Every movement figure the report quotes comes from one place, shared with
  // the markdown surface so the two cannot disagree about what changed.
  const M = buildRunMetrics(summary, snaps);
  const indexMetric = M.index;
  const presenceMetric = M.presence;
  const competitorMetric = M.competitors;
  const ownCitationMetric = M.ownCitations;
  const hostMetric = M.hosts;
  const capsuleMetric = M.capsules;
  const enginesNow = M.engines.now;
  const enginesPrev = M.engines.prev;
  // The headline verdict and the lift aggregate are both built from the shared
  // module, so the markdown report cannot state a different conclusion or a
  // different count from this one.
  const verdictModel = buildVerdictHeadline({
    index: indexMetric, changedCell, fallbackScore: summary.score,
  });
  const lift = buildLiftOpportunity(latest);

  // The four weighted axes, run by run. Presence and Citation are measured
  // across every answer; Rank and Sentiment only across the answers that
  // carry them, which is why each row is gated on coverage before it is
  // allowed to state a delta. The derivation lives in `axis-model.js` because
  // the Mission Control payload ships the same axes to the customer portal —
  // one decision, two renderings.
  const axisData = buildAxisModel(snaps);
  const axisModel = {
    metrics: axisData.metrics,
    shortCoverage: axisData.shortCoverage,
    rows: axisData.rows.map((row) => ({
      label: row.label,
      weight: row.weight,
      valueText: row.valueText,
      fillPct: row.fillPct,
      muted: row.muted,
      chipHtml: !caps.chips
        ? ''
        : row.coverAllowed && row.delta != null
          ? L.chip(formatDelta(row.delta, 'pp'), chipTone(row.delta, 'points', true))
          : L.chip(row.coverReason === 'coverage-shift' ? 'coverage moved' : 'too few to score', 'quiet'),
    })),
  };

  const capsules = latest?.pageSignals?.homepage?.answerCapsules || null;
  const entityGraph = latest?.entityGraph || null;
  const freshness = latest?.responseFreshness?.aggregate || null;
  const regionAgg = latest?.regionContext?.aggregate || null;
  const ads = latest?.adsDetected || null;

  const chipFor = (metric) => caps.chips && metric.deltaPrev != null
    ? L.chip(metric.chipText, metric.tone)
    : '';
  const dateLabel = (d) => String(d || '');

  // ── Competitor alias detection ────────────────────────────────────────
  //
  // Minimum collapsed-name length before a name may seed an alias group. Short
  // stems ("vform", "voice") would group unrelated tools on a category word.
  // Names that share their leading word arrive from the extraction step as
  // separate rivals ("AnveVoice" / "Anve Voice Forms"). This SURFACES the
  // grouping and never merges the counts: merging on a prefix would fuse two
  // genuinely different companies the first time a category shares a word.
  const aliasGroups = (() => {
    const collapse = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const comps = (latest?.topCompetitors || [])
      .filter(c => c && c.name && collapse(c.name).length >= MIN_ALIAS_STEM)
      .map(c => ({ ...c, flat: collapse(c.name) }));
    // Group when one name's collapsed form is a PREFIX of another's
    // ("anvevoice" of "anvevoiceforms"). A shared leading WORD would fuse
    // "Form2Agent" with "FormStack"; prefix containment on the whole name is
    // the narrowest rule that still catches a brand naming itself two ways.
    const used = new Set();
    const groups = [];
    const byLength = comps.slice().sort((a, b) => a.flat.length - b.flat.length);
    for (const seed of byLength) {
      if (used.has(seed.name)) continue;
      const members = comps.filter(c => c.flat.startsWith(seed.flat));
      if (members.length < 2) continue;
      members.forEach(m => used.add(m.name));
      // Cited hosts that share the same stem — the third face of the same
      // operation, and the reason the raw counts understate it.
      const hostLabel = (d) => collapse(String(d.host || '').split('.')[0]);
      const groupedHosts = new Set();
      const hosts = (summary.topDomains || [])
        .filter((d) => {
          const match = hostLabel(d).startsWith(seed.flat.slice(0, MIN_ALIAS_STEM));
          if (match) groupedHosts.add(d.host);
          return match;
        })
        .map(d => ({ host: d.host, count: d.count || 0 }));

      // ── Hosts the grouping rule deliberately does NOT reach ──
      // The rule above is narrow on purpose: it matches on the first
      // MIN_ALIAS_STEM characters of a whole name, so it never fuses two
      // companies that merely share a category word. The cost of that
      // narrowness is real — a host built from the SHORT brand word plus a
      // different suffix ("<brand>forms.com" beside "<brand>voice.app") is
      // not matched, and never appears in the disclosure prose at all.
      //
      // The brand word is derived from the group's own names, never guessed:
      // it is the shortest prefix that (a) ends on a word boundary inside one
      // of the names and (b) every name in the group starts with. Because it
      // is by construction shorter than the grouping stem, any host it reaches
      // that the stem did not is exactly the partial-stem case. A token that
      // also opens a rival OUTSIDE this group is a category word rather than a
      // brand word, and is dropped — that is the false-positive this guard
      // exists for.
      const brandToken = (() => {
        const candidates = new Set();
        for (const m of members) {
          const words = String(m.name).split(/[^A-Za-z0-9]+/).filter(Boolean);
          let acc = '';
          for (const w of words) {
            acc += collapse(w);
            if (acc) candidates.add(acc);
          }
        }
        const shared = [...candidates]
          .filter(tok => members.every(m => m.flat.startsWith(tok)))
          .sort((a, b) => a.length - b.length)[0] || '';
        if (!shared || shared.length >= MIN_ALIAS_STEM) return '';
        const outsiders = comps.filter(c => !members.includes(c));
        if (outsiders.some(c => c.flat.startsWith(shared))) return '';
        return shared;
      })();
      const partialHosts = brandToken
        ? (summary.topDomains || [])
          .filter(d => !groupedHosts.has(d.host) && hostLabel(d).startsWith(brandToken))
          .map(d => ({ host: d.host, count: d.count || 0 }))
        : [];

      groups.push({
        stem: seed.flat,
        names: members.map(m => m.name),
        combined: members.reduce((sum, m) => sum + (m.count || 0), 0),
        hosts,
        brandToken,
        partialHosts,
      });
    }
    return groups;
  })();

  /**
   * The name a reader would use for an alias group: the shortest of its names.
   * Taking `names[0]` would take whichever name the extraction step happened to
   * emit first, and truncating that to its first word turns a multi-word name
   * ("Anve Voice Forms") into a fragment ("Anve") that names nothing.
   * @param {Array<string>} names
   * @returns {string}
   */
  const shortestName = (names) => (names || [])
    .slice()
    .sort((a, b) => String(a).length - String(b).length || String(a).localeCompare(String(b)))[0] || '';

  // ── Section 01 — Overview ──
  const overviewCells = [];
  // The dated index chart now leads the section as a loud block (see
  // `overviewLead` below) — it is the same series, given the room the design
  // asks for. This bento cell would be the same chart twice, so it is
  // suppressed whenever the loud block renders it; below the ladder's shape
  // threshold the staged «available from run N» placeholder still shows, so
  // a young account sees that the block exists and is waiting for data.
  // Gated on the ladder's own threshold, not on the legacy TREND_MIN_RUNS
  // constant: at three runs the loud chart renders, and a cell announcing
  // "chart available from run 4" beside a drawn chart is a contradiction the
  // reader has to resolve.
  if (!caps.shapes) {
    const runs = summary.trend.length;
    overviewCells.push(`
      <article class="cell span-4 tall quiet">
        <div class="cell-head"><span class="cell-label">Trend · ${runs} run${runs !== 1 ? 's' : ''}</span></div>
        <h3 class="cell-title">Trend chart available from run ${SHAPES_MIN_RUNS}</h3>
        <p class="cell-sub">Currently ${runs} of ${SHAPES_MIN_RUNS} runs collected. A line through two points is a delta, not a trend — the chart unlocks at run ${SHAPES_MIN_RUNS}.</p>
      </article>`);
  }
  // Listicle pitches KPI — subtitle now branches on whether the brand has any
  // mention/citation footprint, instead of asserting «brand isn't on any of
  // them» without verification. We can't web-scrape those listicle pages from
  // here; the honest signal is what the AI answers themselves told us.
  //
  // The cell is labelled «Top gap» and every subtitle branch is recommendation
  // copy («push for inclusion», «outreach is the lift», «pitching … is the
  // fastest path in»). White-label drops the whole cell — statistics-only — so
  // no advisory fragment can leak regardless of which branch the data hits.
  if (!whiteLabel && top4Domains.length > 0) {
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
  // How the index is calculated — the per-axis table, the weights, the
  // re-normalisation banner and the formula.
  //
  // Until the 2026-08 redesign this content existed ONLY inside the hero's
  // «How is this calculated?» popover. A popover is invisible in Save-as-PDF,
  // which is the client-delivery path, so the report's own methodology was
  // missing from the deliverable. Rendering the markdown section — the same
  // computeUVIBreakdown output, single source of truth with the markdown
  // report — puts it on the page permanently instead. `publicMode` already
  // strips the internal source path from this section.
  if (S.uvi) {
    overviewCells.push(`
      <article class="cell span-6 quiet" data-paginate>
        <div class="cell-head"><span class="cell-label">How the index is calculated</span></div>
        ${S.uvi}
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
        <div class="eng-bar"><i></i></div>
        <div class="eng-meta"><span>Hits ${e.hits} / ${e.total}</span><span>${e.citations} citations</span></div>
      </div>`;
    }).join('');
    // The headline states THIS run's result, so it has to tell apart the two
    // ways of scoring zero. "Cited but never named" used to fire on any
    // coverage.yes === 0, including a run where the domain was never cited
    // either — i.e. a paid deliverable telling a client their site is a
    // source when no engine sourced it once. Caught on merchpilot.ai's real
    // 2026-08-31 run: 27 cells, all `no`, 0 of our URLs in a 175-URL pool,
    // headline "Cited but never named". Three states now, not two.
    const engNamed = summary.coverage.yes > 0;
    const engCited = (summary.coverage.src || 0) > 0;
    const engHeadline = engNamed
      ? `Named in ${summary.coverage.yes}/${summary.coverage.total} cells`
      : engCited
        ? 'Cited but never named'
        : 'Neither named nor cited';
    const engFinding = engNamed
      ? ''
      : engCited
        ? ' This run: engines see your domain in citations; none surface your brand by name yet.'
        : ' This run: no engine named your brand, and none of the sources they cited were yours.';
    // Eyebrow and sub copy match the portal's report-v2 card verbatim — they
    // define the two words the whole block turns on ("named" vs "cited") for
    // a reader who has never seen an AEO report. The h3 stays DYNAMIC (the
    // portal's is a static string): it is the one line that states this run's
    // actual result. When nothing was named the sub keeps the definition and
    // appends the run-specific finding rather than replacing it.
    visibilityCells.push(`
      <article class="cell span-6 quiet">
        <div class="cell-head"><span class="cell-label">Per-engine visibility <span class="merge">mention rate + citations</span></span></div>
        <h3 class="cell-title">${engHeadline}</h3>
        <p class="cell-sub">Every engine got the same questions. &ldquo;Named&rdquo; = your brand appears in the answer; &ldquo;citations&rdquo; = your domain appears in sources.${engFinding}</p>
        <div class="cell-body" style="display: block;"><div class="eng-grid">${cards}</div></div>
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

    // ── "No sentiment data this run" panel ────────────────────────────────
    // Computed ONCE here and used twice below: for the CSS gate on the grid
    // (`data-sentiment-scored="0"` hides the grid and reveals the panel) and
    // for the panel's own copy. Those two used to be independent — the
    // attribute counted sentiment labels live, while the copy hardcoded the
    // string "0 named cells". So the panel published a number it had never
    // measured, and the wrong noun with it: sentiment is classified for
    // `mention === 'yes' || mention === 'src'` (bin/aeo-tracker.js:2864 live
    // path, :4554 run-manual path) — named OR cited — exactly as the
    // sentiment-view legend further down already states. Deriving both from
    // one source is the point: a hardcoded count cannot drift from its gate.
    const mxSentimentScored = summary.positionMatrix
      .flatMap(r => r.columns)
      .filter(c => c.sentiment && c.sentiment.label).length;
    // Two honest reasons the panel can show, and they are not the same story:
    // nobody mentioned you at all, vs. you were mentioned but no label came
    // back (classification skipped, e.g. under --replay, or unavailable).
    const mxSentimentEmptyBody = mxYours === 0
      ? 'Sentiment is only classified for cells where AI named or cited your brand. '
        + 'This run: 0 such cells → nothing to classify. Earn a mention first — '
        + 'see Citations and Actions below.'
      : `Sentiment is only classified for cells where AI named or cited your brand. `
        + `This run: ${mxYours} such cell${mxYours === 1 ? '' : 's'}, but no sentiment `
        + `label came back for ${mxYours === 1 ? 'it' : 'any of them'} → nothing to classify.`;

    const headerCells = (summary.engines || []).map(e =>
      `<div class="mx-h eng" style="--c: var(${ENGINE_VAR[e.provider] || '--ink-3'}, var(--ink-3))">${esc(stripParens(e.label))}</div>`,
    ).join('');
    // Click-to-reveal verbatim answers — collected while mapping cells, rendered
    // as a single accordion BELOW the grid (a `<details>` cannot live inside the
    // CSS grid without consuming a column / breaking layout, so the reveal is a
    // sibling block keyed Q{n} · engine). The full answer is the measured fact —
    // shown in BOTH default and white-label (it carries no tool fingerprint /
    // agency voice; advisory words inside it are the engine's own words, not ours).
    const revealItems = [];
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

        // ── Verbatim reveal for THIS cell ──
        // Prefer the FULL answer (responseFull, from the raw q{N}-{provider} file);
        // fall back to the truncated responseExcerpt when no raw file is on disk;
        // render nothing for this cell when the engine errored / never answered
        // (no text to show). Graceful — a cell with no captured answer is simply
        // omitted from the accordion and never throws. status='missing'/'error'
        // are skipped so the reveal only lists cells the reader can actually read.
        const fullText = (typeof col.responseFull === 'string' && col.responseFull.trim())
          ? col.responseFull
          : (typeof col.responseExcerpt === 'string' && col.responseExcerpt.trim())
            ? col.responseExcerpt
            : null;
        if (fullText && status !== 'missing' && status !== 'error') {
          const engLabel = stripParens(col.label || col.provider || '');
          // Badge word + tone follow the portal's four-tone reveal-badge.
          // The row is headed by the QUERY ITSELF, not "Q3": the reader is
          // scanning for a question they recognise, and an index means
          // nothing outside the grid above. `excerpt` is ours and stays —
          // it is the honest marker that this is a truncated answer, which
          // the portal has no equivalent for.
          const badge = status === 'yes' ? 'named'
            : status === 'src' ? 'cited'
              : 'absent';
          const badgeWord = badge === 'named' ? 'Named' : badge === 'cited' ? 'Cited' : 'Absent';
          const isExcerpt = !(typeof col.responseFull === 'string' && col.responseFull.trim());
          revealItems.push(
            `<details class="reveal">`
            + `<summary class="reveal-summary">`
            + `<span class="reveal-q">${esc(qText)}</span>`
            + `<span class="reveal-provider">${esc(engLabel)}</span>`
            + `${isExcerpt ? '<span class="reveal-trunc">excerpt</span>' : ''}`
            + `<span class="reveal-badge ${badge}">${badgeWord}</span></summary>`
            + `<div class="reveal-excerpt">${esc(fullText)}</div>`
            + `</details>`,
          );
        }
        // Cell contents follow the portal's report-v2 grid: a glyph, not a
        // word. The verbose "▮ named" / "◐ cited" pairs repeated on every
        // hit and turned the grid into a wall of type; status is already
        // carried by the cell's own fill, and the legend below decodes it.
        // Class names are the portal's (named/cited/absent/err/competitor/
        // empty) so one stylesheet describes both surfaces.
        if (status === 'yes') {
          return `<div class="mx-c named" data-status="named">
            <span class="mx-v mx-v-mention">✓</span>
            <span class="mx-v mx-v-position">${posTxt ? `<span class="mx-pos">${posTxt}</span>` : '✓'}</span>
            ${sBlock}
          </div>`;
        }
        if (status === 'src') {
          return `<div class="mx-c cited" data-status="cited">
            <span class="mx-v mx-v-mention">cite</span>
            <span class="mx-v mx-v-position">${posTxt ? `<span class="mx-pos">${posTxt}</span>` : 'cite'}</span>
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
            <span class="mx-v mx-v-mention"><span>err</span></span>
            <span class="mx-v mx-v-position"><span>err</span></span>
            <span class="mx-v mx-v-sentiment"><span>err</span></span>
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
        // Three distinct no-mention states, each with its own class so the
        // legend below can decode all of them honestly:
        //   competitor — engine named someone else  → "↳ vs X +N"
        //   empty      — engine cited N sources, none yours → "○ 0 / N cited"
        //   absent     — engine named nobody, cited nothing → a quiet "·"
        // The ↳ and ○ glyphs come from CSS ::before (as in the portal), NOT
        // from this markup — emitting them here too would double them.
        const noStatus = compNamed ? 'competitor' : (poolHint ? 'empty' : 'absent');
        const mentionInner = compNamed
          ? `<span class="mx-comp"><span class="mx-comp-prefix">vs</span><span class="mx-comp-name">${esc(topCompName)}</span>${moreCount > 0 ? `<sup class="mx-comp-more">+${moreCount}</sup>` : ''}</span>`
          : poolHint
            ? `<span class="mx-cited-share">${esc(poolHint)}</span>`
            : '';
        const posInner = poolHint ? `<span class="mx-cited-share">${esc(poolHint)}</span>` : '';
        return `<div class="mx-c ${noStatus}" data-status="${noStatus}" title="${esc(tooltip)}">
          <span class="mx-v mx-v-mention">${mentionInner}</span>
          <span class="mx-v mx-v-position">${posInner}</span>
          <span class="mx-v mx-v-sentiment"></span>
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

    // Plain .quiet, like the other two blocks. It used to carry
    // `.dominant.editor`, whose blue wash sat under every cell and turned
    // the orange fills muddy, the accent-wash "cite" tile grey, and the
    // legend swatches invisible. In the portal all three blocks are the
    // same white card; the matrix earns attention from its own heat, not
    // from a tinted container.
    visibilityCells.push(`
      <article class="cell span-6 quiet">
        <div class="cell-head">
          <span class="cell-label">Query × engine matrix <span class="merge">heatmap + position + sentiment</span></span>
          <div class="matrix-toggle" role="group" aria-label="Matrix view">
            <button type="button" aria-pressed="true">Mention</button>
            <button type="button" aria-pressed="false">Position</button>
            <button type="button" aria-pressed="false">Sentiment</button>
          </div>
        </div>
        <p class="cell-sub" style="margin: 0;">Each cell is one AI answer. Colour and glyph tell you what the engine did with your brand.</p>
        <div class="mx-summary" aria-label="Matrix totals">${summaryStats}</div>
        <div class="matrix" data-view="mention" data-sentiment-scored="${mxSentimentScored}">
          <div class="matrix-grid" data-view="mention" style="--cols: ${(summary.engines || []).length || 3}">
            <div class="mx-h">Query</div>${headerCells}<div class="mx-h mx-h-total">row Σ</div>
            ${rows}
          </div>
        </div>
        <div class="mx-sentiment-empty" aria-live="polite">
          <span class="mx-empty-glyph" aria-hidden="true">○</span>
          <strong class="mx-empty-title">No sentiment data this run</strong>
          <p class="mx-empty-body">${mxSentimentEmptyBody}</p>
        </div>
        <div class="mx-legend matrix-legend" data-view-show="mention" aria-label="Mention view legend">
          <span class="lg" data-status="named"><span class="sw">✓</span>Named in answer</span>
          <span class="lg" data-status="cited"><span class="sw"></span>Cited in sources only</span>
          <span class="lg" data-status="competitor"><span class="sw">↳</span>Competitor named instead</span>
          <span class="lg" data-status="empty"><span class="sw">○</span>Sources cited, none yours</span>
          <span class="lg" data-status="absent"><span class="sw">·</span>No brands, no sources</span>
          <span class="lg" data-status="error"><span class="sw"></span>Engine unavailable</span>
        </div>
        <div class="mx-legend matrix-legend" data-view-show="position" aria-label="Position view legend">
          <span class="mx-leg-caption">Position view shows <strong>brand rank #N</strong> when AI named you, or <strong>0 / N cited</strong> showing your share of the citation pool.</span>
        </div>
        <div class="mx-legend matrix-legend" data-view-show="sentiment" aria-label="Sentiment view legend">
          <span class="mx-leg-caption">Sentiment view classifies how AI framed your brand: <strong style="color:var(--success-color)">● positive</strong> · <strong style="color:var(--ink-3)">● neutral</strong> · <strong style="color:var(--error-color-strong)">● negative</strong>. Only computed for named/cited cells.</span>
        </div>
      </article>`);

    // Verbatim answers — its OWN card, as in the portal. It used to hang off
    // the bottom of the matrix card with a single lead-in line and no heading
    // of its own, which buried the one section a client actually quotes back
    // at you. Same reveal rows, promoted to a peer of the matrix.
    if (revealItems.length > 0) {
      // Folded shut. Every answer is a row and every row is a paragraph of
      // engine prose, so unfolded this block is the longest thing in the
      // report — a wall a reader scrolls past rather than reads. The heading
      // and the sub stay visible, so the block still announces itself; only
      // the rows wait for a click. The count lives in the summary, which is
      // what tells the reader whether the click is worth it.
      visibilityCells.push(`
      <article class="cell span-6 quiet">
        <div class="cell-head"><span class="cell-label">Verbatim answers</span></div>
        <h3 class="cell-title">What each engine actually said</h3>
        <p class="cell-sub">Point-in-time excerpts from this run&rsquo;s answers. AI phrasing varies between runs.</p>
        ${L.fold({
          show: `Show all ${revealItems.length} answer${revealItems.length === 1 ? '' : 's'}`,
          hide: 'Hide answers',
          tag: 'Evidence',
          meta: 'read exactly how an engine worded its answer',
          bodyHtml: `<div aria-label="Full engine answers">
          ${revealItems.join('\n          ')}
        </div>`,
        })}
      </article>`);
    }
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
    // White-label: the title/sub are descriptive statistics only — no «Pitch the
    // top 3» / «defend it» recommendation copy (advisory verbs break the
    // self-made-tool legend). Gate the WHOLE assignment in one place so removing
    // the `if (whiteLabel)` reopens the leak for every branch (mutation-clean).
    let domainTitle, domainSub;
    if (whiteLabel) {
      domainTitle = `Citations span ${topDomainsList.length} domain${topDomainsList.length === 1 ? '' : 's'}`;
      domainSub = `These publishers supply most of the category citations.${hasOwn ? ` ${esc(ownDomain)} is in the pool.` : ` ${esc(ownDomain)} is not in the pool.`}`;
    } else {
      if (hasOwn) {
        domainTitle = `${esc(ownDomain)} is in the pool — defend it`;
      } else if (top1Share >= 0.30) {
        domainTitle = `${esc(topDomainsList[0].host)} carries the pool`;
      } else if (top3Sum >= 0.60) {
        domainTitle = `Pitch the top 3 first`;
      } else {
        domainTitle = `Citations spread across ${topDomainsList.length} domains`;
      }
      domainSub = `These publishers feed AI most of the category citations. ${hasOwn ? 'You\'re in the list — defend it.' : `${esc(ownDomain)} isn't on any of them.`}`;
    }
    citationsCells.push(`
      <article class="cell span-4 dominant editor">
        <div class="cell-head"><span class="cell-label">Domain share of voice</span><span class="cell-action cell-action--info">All ${summary.topDomains.length} domains</span></div>
        <h3 class="cell-title">${domainTitle}</h3>
        <p class="cell-sub">${domainSub}</p>
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
    // Subtitle reports the concentration. White-label keeps the statistic but
    // drops the «concentrate outreach / lift compounds / outreach play» advisory
    // tail. Gate the whole assignment (mutation-clean: pull `if (whiteLabel)` →
    // leak returns for every branch).
    let categorySub;
    if (whiteLabel) {
      if (categories.length === 1) {
        categorySub = `A single category accounts for the entire citation pool.`;
      } else if ((top.share || 0) >= 0.5) {
        categorySub = `${esc(top.label)} carries ${topPct}% of citations.`;
      } else if ((top.share || 0) >= 0.3) {
        categorySub = `${esc(top.label)} leads at ${topPct}%, with the remainder spread across other categories.`;
      } else {
        categorySub = `Citations are split across ${categories.length} categories with no single leader.`;
      }
    } else if (categories.length === 1) {
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
    // Server-rendered axis — the signal that replaced llms.txt in the score.
    // Rendered only when it was actually measured (null = page-signals crawl
    // absent or blocked), so the cell never implies a verdict we do not have.
    const ssr = discover.breakdown.serverRendered;
    const ssrRow = ssr && ssr.value !== null
      ? `<div class="ready-row"><span class="label"><span class="ck${ssr.value >= 100 ? '' : ' bad'}">${ssr.value >= 100 ? '✓' : '✕'}</span>content in served HTML</span><span class="meta">${ssr.value >= 100 ? 'server-rendered' : 'looks JS-rendered'}</span></div>`
      : '';
    // llms.txt — FACT row, muted, no verdict glyph: it does not feed the score
    // and is not a recommendation (AP-DEAD-TACTIC-LLMSTXT).
    const llmsFactRow = `<div class="ready-row"><span class="label"><span class="ck muted">·</span>llms.txt</span><span class="meta">${crawlSummary.hasLlmsTxt ? 'present' : 'not present'} · not a ranking signal</span></div>`;
    diagnosticsCells.push(`
      <article class="cell span-3 dominant">
        <div class="cell-head"><span class="cell-label">Site readiness <span class="merge">robots.txt + AI-bot access + sitemap + served HTML</span></span></div>
        <h3 class="cell-title">${score >= 70 ? 'Fully crawlable' : score >= 40 ? 'Partially crawlable' : 'Blocked'}</h3>
        <div class="big-num ${tone}" data-size="64">${score}<small>/100</small></div>
        <div class="cell-body" style="display: block; margin-top: 16px;">
          <div class="ready-row"><span class="label"><span class="ck${crawlSummary.hasRobots ? '' : ' bad'}">${crawlSummary.hasRobots ? '✓' : '✕'}</span>robots.txt</span><span class="meta">${robotsBytes ? `${robotsBytes} bytes` : 'missing'}</span></div>
          <div class="ready-row"><span class="label"><span class="ck${crawlSummary.hasSitemap ? '' : ' bad'}">${crawlSummary.hasSitemap ? '✓' : '✕'}</span>sitemap.xml</span><span class="meta">${sitemapUrls ? `${sitemapUrls} URLs` : 'missing'}</span></div>
          <div class="ready-row"><span class="label"><span class="ck${notBlocked === total ? '' : ' warn'}">${notBlocked === total ? '✓' : '!'}</span>${notBlocked} / ${total} AI crawlers</span><span class="meta">${notBlocked === total ? 'all allowed' : `${total - notBlocked} blocked`}</span></div>
          ${ssrRow}
          ${llmsFactRow}
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

  // ══════════════════════════════════════════════════════════════════════
  // LOUD REGISTER — section leads
  //
  // Each section opens on a conclusion and closes on one "Where to act"
  // line. Loudness is decided by the data, never by which section we are
  // in: a check gets an alert card only when it trips. On a run where the
  // same check is clean, the same code renders a table.
  // ══════════════════════════════════════════════════════════════════════

  /** One "Where to act" bar from a list of candidate metrics. */
  const actBar = (metrics, meta) => {
    if (!caps.whereToAct) {
      return L.whereToAct({
        textHtml: esc(`Movement is not called until run ${SHAPES_MIN_RUNS} — with ${runCount} run${runCount === 1 ? '' : 's'} on record there is no range to judge a change against yet.`),
        meta,
      });
    }
    const { text } = whereToActLine(metrics, summary.meta.prevDate);
    return L.whereToAct({ textHtml: esc(text), meta });
  };

  // ── Overview lead ─────────────────────────────────────────────────────
  const overviewLead = (() => {
    const blocks = [];

    // (a) The one answer that explains the run. Only rendered when a cell
    //     actually changed hands — on a stable run this block is absent and
    //     the section opens on the chart instead.
    if (changedCell && caps.chips) {
      const lost = changedCell.verdict === VERDICT.LOST;
      const engine = stripParens(changedCell.label);
      const weight = 0.35; // Presence weight, fixed by the index definition.
      const cellShare = history.cells.length ? round1(100 / history.cells.length) : 0;
      const indexCost = round1(cellShare * weight);
      const costHtml = lost
        ? `One answer of ${history.cells.length} is <b class="lr-num">${cellShare} pp</b> of Presence, weighted at ${Math.round(weight * 100)}% — <b class="lr-num lr-verdict-bad">−${indexCost}</b> of the index. The index moved ${indexMetric.deltaPrev > 0 ? '+' : '−'}${Math.abs(indexMetric.deltaPrev ?? 0)}. The rest is not attributable from this run's record: the run stores one index number, not the four axis values behind it.`
        : `One answer of ${history.cells.length} is <b class="lr-num">${cellShare} pp</b> of Presence, weighted at ${Math.round(weight * 100)}% — worth <b class="lr-num">${indexCost}</b> of the index.`;
      blocks.push(L.alertCard({
        tone: lost ? 'bad' : 'good',
        kicker: 'The change this run',
        title: lost
          ? `${engine} stopped naming you on one question`
          : `${engine} started naming you on one question`,
        bodyHtml: `Asked <b class="lr-strong">${esc(changedCell.queryText)}</b> on ${esc(summary.meta.date)}, ${esc(engine)} ${lost ? 'named other tools and did not name you' : 'named you'}. ${esc(changedCell.record)}`,
        extraHtml: [
          caps.shapes
            ? `<div class="lr-alert-figure-wrap">${L.eyebrow(`${engine} on this question, run by run`)}${L.runStrip(changedCell.states, history.runs)}</div>`
            : '',
          `<div class="lr-grid-2">
            ${L.insetCard({ label: 'What it cost', bodyHtml: costHtml })}
            ${L.insetCard({
              label: lost ? 'Who was named instead' : 'What it took',
              bodyHtml: changedCell.competitors.length
                ? `${esc(changedCell.competitors.join(', '))} appear in this answer where you do not. Their pages are what the engine had to work with on this question.`
                : 'No rival was named in this answer either — the engine answered the question without recommending any tool, which is a content gap rather than a competitor problem.',
            })}
          </div>`,
        ].join(''),
        footHtml: changedCell.textDrift
          ? esc(`This question was reworded during the record; runs before ${changedCell.textDrift.settledAt || 'the change'} asked a different wording of the same tracked slot.`)
          : '',
      }));
    }

    // (b) Score over time.
    if (caps.shapes && (summary.trend || []).length >= 2) {
      const partialNote = (() => {
        if (!partialFlags.some(Boolean)) return '';
        // Collapse consecutive partial runs that carried the same answer
        // count into one row — repeating near-identical sentences per run
        // (the previous design) buries the one fact that matters (how many
        // answers each stretch measured) in a wall of restated prose.
        const groups = [];
        partialFlags.forEach((p, i) => {
          if (!p) return;
          const count = snaps[i]?.results?.length ?? 0;
          const prevGroup = groups[groups.length - 1];
          if (prevGroup && prevGroup.end === i - 1 && prevGroup.count === count) prevGroup.end = i;
          else groups.push({ start: i, end: i, count });
        });
        const rows = groups.map((g) => {
          const runLabel = g.start === g.end ? `Run ${g.start + 1}` : `Runs ${g.start + 1}-${g.end + 1}`;
          return `<tr><td>${esc(runLabel)}</td><td>${esc(`${g.count} of ${expectedCells} answers`)}</td></tr>`;
        }).join('');
        return `<p class="lr-note">Runs marked <b class="lr-strong">partial</b> on the chart measured fewer than ${esc(String(expectedCells))} answers — their score is marked but not comparable to a full run.</p>
          <table class="lr-mono-table"><thead><tr><th>Run</th><th>Coverage</th></tr></thead><tbody>${rows}</tbody></table>`;
      })();
      const days = (() => {
        const a = Date.parse(runDates[0]);
        const b = Date.parse(runDates[runDates.length - 1]);
        return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
      })();
      const spanText = `${runCount} runs${days != null ? `, ${days} days` : ''}`;
      const baseline = caps.baselineCaption && indexMetric.deltaFirst != null
        ? `<p class="lr-body-lg">${indexMetric.deltaFirst >= 0 ? 'Up' : 'Down'} <b class="${indexMetric.deltaFirst >= 0 ? 'lr-verdict-good' : 'lr-verdict-bad'}">${Math.abs(indexMetric.deltaFirst)} points</b> since day 1.</p>`
        : '';
      blocks.push(`<div class="lr-card">
        <div class="lr-chart-split">
          <div>
            ${L.eyebrow('Score over time')}
            <h3 class="lr-h3">${esc(spanText)}</h3>
            <p class="lr-body-lg">${esc(`${indexMetric.first} to ${indexMetric.current}. The shape carries the whole record, so the only number in the text is the one that changed this run.`)}</p>
            ${baseline}
            <div class="lr-chart-chip">${caps.chips ? L.chip(indexMetric.chipText, indexMetric.tone, { size: 'lg' }) : ''}<span class="lr-body">${esc(summary.meta.prevDate ? `vs ${summary.meta.prevDate}` : '')}</span></div>
            ${partialNote}
          </div>
          ${L.indexChart({ values: summary.trend, dates: runDates, partial: partialFlags, labelEvery: caps.labelEvery })}
        </div>
      </div>`);
    }

    // (c) What moved the index — the four weighted axes, and an explicit
    //     statement where the record cannot support a delta.
    if (axisModel.rows.length) {
      const short = axisModel.shortCoverage;
      const axisNote = short.length
        ? `Presence and Citation are counted across every answer. ${short.join(' and ')} ${short.length === 1 ? 'is' : 'are'} only reported on the answers that carry ${short.length === 1 ? 'it' : 'them'} this run, and that population moved enough between runs that a delta would describe the population rather than your visibility — so ${short.length === 1 ? 'it prints' : 'they print'} coverage instead.`
        : 'Every axis is reported on enough answers this run to carry a delta.';
      // The headline index is the score the RUN recorded; the axes beside it
      // are recomputed from the same answers by today's code. Those can differ
      // when the scoring rules change between runs, and two numbers a reader
      // can see at once must never differ without an explanation.
      const recomputed = (() => {
        try { return computeUVI(computeComponents(latest)); } catch { return null; }
      })();
      const driftNote = (recomputed != null && indexMetric.current != null && recomputed !== indexMetric.current)
        ? `<p class="lr-note">${esc(`The headline index of ${indexMetric.current} is the score this run recorded on ${summary.meta.date}, and it is what the chart and every comparison above use — one consistent series. Re-scoring the same answers with the current rules gives ${recomputed}. The gap means the scoring rules changed since this run was measured; the recorded score is kept so the history stays comparable with itself.`)}</p>`
        : '';
      blocks.push(`<div class="lr-card">
        ${L.eyebrow('Four axes, fixed weights')}
        <h3 class="lr-h3">What moved the index</h3>
        ${L.axisTable(axisModel.rows)}
        <p class="lr-note">${esc(axisNote)} Each bar is that axis's own score out of 100 — or, where the axis prints coverage, the share of answers it was reported on. The percentage beside each name is its fixed weight in the index, which never changes.</p>
        ${driftNote}
      </div>`);
    }

    blocks.push(actBar([...axisModel.metrics, indexMetric, presenceMetric], `floor ${significanceFloor('points').toFixed(1)} pt on 0-100 axes · 1 unit on counts · ${axisModel.metrics.length} of ${axisModel.rows.length} axes reportable`));
    return blocks.join('');
  })();

  // ── Visibility tail — the question-by-question record ─────────────────
  // This used to OPEN the section, above the three blocks a reader actually
  // scans. It is the evidence layer: one card per question, one row per
  // engine, each row carrying its two deltas and its whole history. Real
  // substance — but substance reached for AFTER the run's verdict, not
  // before it. Founder ruling 2026-09-01: the questions carry meaning "only
  // for someone who wants to read into it, and most people don't", so they
  // move behind the per-engine card, the matrix and the verbatim answers.
  //
  // It is also FOLDED SHUT. Its rows stay `open` inside the fold — that part
  // of loud.js's contract is unchanged — but the fold itself is closed, so on
  // screen the section ends at a one-line summary instead of nine cards. That
  // is only safe because the inline print handler below opens every `.fold`
  // (and every `.reveal`) before the PDF is drawn: a closed <details> cannot
  // be opened by CSS, so narrowing that selector would delete this whole
  // block from the client's copy.
  const visibilityDetail = (() => {
    if (!questionGroups.length) return '';
    const head = `<div class="lr-subsec">
      ${L.eyebrow('Question by question')}
      <h3 class="lr-h3">The record behind every answer</h3>
      <p class="lr-sec-intro">${esc('One card per question, one row per engine. Each row states its verdict in words, then carries the two deltas and the whole run history behind it. Open it to check a specific question, or to see how one answer has moved across runs.')}</p>
    </div>`;
    const cards = questionGroups
      .map(group => L.answerCard({ group, caps, runMeta: history.runs }))
      .join('');
    const body = L.fold({
      show: `Show the record for all ${questionGroups.length} question${questionGroups.length === 1 ? '' : 's'}`,
      hide: 'Hide the record',
      tag: 'Evidence',
      meta: 'trace why one question keeps failing',
      bodyHtml: cards,
    });
    // The act bar stays OUTSIDE the fold. Every other section closes its LEAD
    // with it, i.e. above its bento; visibility now closes the whole section
    // with it instead — deliberate, not a side effect of the move: here it
    // reads as the closing line of everything above it. Folding it away would
    // hide the one sentence that says where to act.
    return head + body + actBar([presenceMetric], 'count metrics: 1-unit floor · no noise test');
  })();

  // ── Competitors lead ──────────────────────────────────────────────────
  const competitorsLead = (() => {
    const comps = (latest?.topCompetitors || []).filter(c => c && c.name);
    if (!comps.length) return '';
    const totalCells = history.cells.length || 1;
    const top = comps[0];
    const ties = comps.filter(c => (c.count || 0) === (top.count || 0));
    const yours = presenceMetric.current ?? 0;
    const verdict = `No competitor is named more than <b class="lr-strong">${top.count} time${top.count === 1 ? '' : 's'} of ${totalCells}</b> — you appear in ${yours}. `
      + (ties.length > 1 ? `${esc(ties.map(c => c.name).join(', '))} tie at ${top.count}. ` : '')
      + (aliasGroups.length
        ? `The pattern to watch is not one dominant rival but <b class="lr-strong">${esc(shortestName(aliasGroups[0].names))}, which the engines name under ${aliasGroups[0].names.length} different names</b>.`
        : 'The field is fragmented rather than led by one rival.');

    const kpis = [
      L.kpiCard({
        label: 'Tools named besides you',
        value: comps.length,
        chipHtml: caps.chips && competitorMetric.deltaPrev != null
          ? L.chip(competitorMetric.chipText, chipTone(competitorMetric.deltaPrev, 'count', false))
          : '',
      }),
      L.kpiCard({
        label: 'Most-named rival',
        value: top.count,
        denom: `/ ${totalCells}`,
        note: esc(top.name),
      }),
      L.kpiCard({
        label: 'Answers you appear in',
        value: yours,
        denom: `/ ${totalCells}`,
        chipHtml: chipFor(presenceMetric),
      }),
    ];

    // Share of the run's citations, per rival host. Rivals without a cited
    // host print "no domain" rather than a zero bar that reads as a measured
    // zero.
    const totalCites = citationsAllHosts || 1;
    const ownHost = String(summary.meta.domain || '').replace(/^www\./, '').toLowerCase();
    const maxShare = Math.max(1, ...hostCounts.values());
    const rows = [
      {
        nameHtml: `${L.engineDot('own')}${esc(summary.meta.brand)}<span class="lr-tag">you</span>`,
        count: `${yours} / ${totalCells}`,
        fillPct: ((hostCounts.get(ownHost) || 0) / maxShare) * 100,
        share: `${round1(((hostCounts.get(ownHost) || 0) / totalCites) * 100)}%`,
        chipHtml: chipFor(presenceMetric),
        note: presenceMetric.deltaPrev == null ? 'First run on record'
          : presenceMetric.deltaPrev < 0 ? `Lost ${Math.abs(presenceMetric.deltaPrev)} answer${Math.abs(presenceMetric.deltaPrev) === 1 ? '' : 's'} this run`
          : presenceMetric.deltaPrev > 0 ? `Gained ${presenceMetric.deltaPrev} answer${presenceMetric.deltaPrev === 1 ? '' : 's'} this run`
          : 'Unchanged this run',
        you: true,
      },
      ...comps.slice(0, 6).map((c) => {
        const prevCount = ((prevSnapshot?.topCompetitors || []).find(p => p.name === c.name) || {}).count ?? null;
        const d = prevCount == null ? null : (c.count || 0) - prevCount;
        // Three distinct states, and they must not be collapsed: the rival's
        // domain is cited N times; the rival's domain is known and was cited
        // zero times; the run never established which domain the rival owns,
        // in which case the report says so rather than asserting an absence.
        const host = competitorDomain.get(c.name) || null;
        const cited = host ? (hostCounts.get(host) || 0) : null;
        const share = cited == null ? 'domain not identified'
          : cited === 0 ? 'not cited this run'
          : `${round1((cited / totalCites) * 100)}%`;
        return {
          nameHtml: `${L.engineDot('rival')}${esc(c.name)}${prevCount == null ? '<span class="lr-tag">new</span>' : ''}`,
          count: `${c.count} / ${totalCells}`,
          fillPct: cited ? (cited / maxShare) * 100 : 0,
          share,
          chipHtml: caps.chips
            ? L.chip(d == null ? `▲ ${c.count}` : formatDelta(d, ''), chipTone(d == null ? c.count : d, 'count', false))
            : '',
          colorKey: 'rival',
          note: cited
            ? `${esc(host)} cited ${cited} time${cited === 1 ? '' : 's'}`
            : prevCount == null ? 'Named for the first time'
            : d === 0 ? 'Named as often as last run'
            : d > 0 ? 'Named more often than last run'
            : 'Named less often than last run',
        };
      }),
    ];

    const aliasCard = (() => {
      if (!aliasGroups.length) return '';
      const g = aliasGroups[0];
      const hostText = g.hosts.length
        ? ` The cited host${g.hosts.length === 1 ? '' : 's'} ${esc(g.hosts.map(h => `${h.host} (${h.count} citation${h.count === 1 ? '' : 's'})`).join(', '))} share${g.hosts.length === 1 ? 's' : ''} the same stem, which is where the rest of their footprint is.`
        : '';
      const combinedShare = g.hosts.reduce((sum, h) => sum + h.count, 0);
      // Hosts the grouping rule cannot reach are named here rather than left
      // out of the disclosure entirely. The claim is deliberately weak — "worth
      // checking", not "the same company" — because the rule that failed to
      // group them is the same rule that keeps two unrelated companies apart,
      // and it is right to keep it.
      const partialText = g.partialHosts.length
        ? ` One further cited host, ${esc(g.partialHosts.map(h => `${h.host} (${h.count} citation${h.count === 1 ? '' : 's'})`).join(', '))}, shares only the leading “${esc(g.brandToken)}” with these names — too little for the grouping rule, which matches on ${MIN_ALIAS_STEM} characters of a whole name. It is counted separately above and is worth one manual check for the same ownership.`
        : '';
      return L.alertCard({
        tone: 'warn',
        kicker: 'Counting artefact',
        title: `One competitor may be counted as ${g.names.length}`,
        bodyHtml: `${esc(g.names.map(n => `“${n}”`).join(' and '))} are counted as separate rivals because the extraction step reads them as different names. Counted separately they look like ${g.names.length} small rivals; as one operation they are named ${g.combined} time${g.combined === 1 ? '' : 's'} of ${totalCells}.${hostText}${combinedShare ? ` That is ${round1((combinedShare / totalCites) * 100)}% of everything cited this run.` : ''}${partialText} The table above deliberately does <b class="lr-strong">not</b> merge them: merging on a shared stem would fuse two genuinely different companies the first time a category shares one. Confirming the alias is an extraction-step fix, not a reporting one.`,
      });
    })();

    return `<div class="lr-card">
        <p class="lr-lede">${verdict}</p>
        <div class="lr-grid-3">${kpis.join('')}</div>
      </div>
      <div class="lr-card">
        <div class="lr-card-head">
          <span class="lr-head-titles">
            ${L.eyebrow('Named, and how much of the cited space they hold')}
            <h3 class="lr-h3">${esc(`${comps.length + 1} tools in the answers this run`)}</h3>
          </span>
          <span class="lr-head-meta">${esc(`share = portion of the ${citationsAllHosts} citations this run`)}</span>
        </div>
        ${L.shareTable(rows)}
      </div>
      ${aliasCard}
      ${actBar([competitorMetric, presenceMetric], 'verified names only · unverified extractions excluded')}`;
  })();

  // ── Citations lead ────────────────────────────────────────────────────
  const citationsLead = (() => {
    const domains = (summary.topDomains || []).slice(0, 5);
    if (!domains.length) return '';
    const ownHost = String(summary.meta.domain || '').replace(/^www\./, '').toLowerCase();
    const totalCites = citationsAllHosts || 1;
    const ownRow = domains.find(d => String(d.host || '').toLowerCase() === ownHost);
    const leader = domains[0];
    const youLead = leader && String(leader.host || '').toLowerCase() === ownHost;
    const maxCount = Math.max(1, ...domains.map(d => d.count || 0));
    const rows = domains.map((d) => {
      const host = String(d.host || '').toLowerCase();
      const isOwn = host === ownHost;
      const prevCount = ((prevSnapshot?.topDomains || []).find(p => String(p.host || '').toLowerCase() === host) || {}).count ?? null;
      const delta = prevCount == null ? null : (d.count || 0) - prevCount;
      return {
        nameHtml: `<span class="lr-host">${esc(d.host)}</span>${isOwn ? '<span class="lr-tag">yours</span>' : prevCount == null ? '<span class="lr-tag">new</span>' : ''}`,
        count: `${d.count} · ${round1(((d.count || 0) / totalCites) * 100)}%`,
        fillPct: ((d.count || 0) / maxCount) * 100,
        share: '',
        chipHtml: caps.chips
          ? L.chip(delta == null ? `▲ ${d.count}` : formatDelta(delta, ''), chipTone(delta == null ? (isOwn ? d.count : -d.count) : (isOwn ? delta : -delta), 'count', true))
          : '',
        colorKey: isOwn ? undefined : 'rival',
        note: isOwn ? 'Your own pages' : prevCount == null ? 'New host this run' : delta === 0 ? 'Flat' : delta > 0 ? 'Cited more than last run' : 'Cited less than last run',
        you: isOwn,
      };
    });

    const graphAlert = (() => {
      const summaryEg = entityGraph?.summary;
      if (!summaryEg || !Number.isFinite(summaryEg.reciprocityRate) || summaryEg.reciprocityRate >= 100) return '';
      // 'verified-host' is a POSITIVE signal (summariseEdges counts it toward
      // reciprocityRate, same as 'reciprocates' — see entity-graph.js) for
      // auth-walled platforms we can't reverse-check. It must NOT be counted
      // as "broken", named in the "returns X" sentence, or picked as the
      // "fix this" code sample — a verified LinkedIn/Medium page is not a
      // bug to fix. Only genuinely negative edges belong in `broken`.
      const broken = (entityGraph.edges || []).filter(e => e.status !== 'reciprocates' && e.status !== 'verified-host');
      if (!broken.length) return '';
      const first = broken[0];
      const tiles = (entityGraph.edges || []).map(e => {
        const desc = EG.describeEdgeStatus(e.status);
        return L.statusTile({ name: e.host || e.platform || 'link', status: desc.label, tone: desc.tone });
      }).join('');
      return L.alertCard({
        tone: 'warn',
        kicker: 'Fixable in one line',
        title: `${broken.length} of your ${entityGraph.sameAsCount} identity links ${broken.length === 1 ? 'does' : 'do'} not resolve`,
        bodyHtml: `Your schema declares ${entityGraph.sameAsCount} identity links. ${summaryEg.reciprocates + summaryEg.verifiedHost} resolve or are confirmed by their host; ${broken.length === 1 ? 'the other returns' : 'the others return'} ${esc(broken.map(b => b.error || EG.describeEdgeStatus(b.status).label).join(', '))} to a crawler, so your entity graph reciprocates at ${summaryEg.reciprocityRate}% instead of 100%. This is the cheapest authority signal on the board: point the link at a URL a crawler can actually read.`,
        extraHtml: `<div class="lr-alert-code">"sameAs": ["${esc(first.url)}"] → ${esc(first.error || EG.describeEdgeStatus(first.status).label)}</div><div class="lr-tiles">${tiles}</div>`,
      });
    })();

    return `<div class="lr-card">
        <p class="lr-lede">Across ${history.cells.length} answers the engines cited ${citationsAllHosts} sources from ${hostMetric.current ?? domains.length} hosts. <b class="lr-strong">${esc(String(ownRow?.host || summary.meta.domain))} is cited ${ownRow?.count ?? 0} time${(ownRow?.count ?? 0) === 1 ? '' : 's'}</b> — ${round1(((ownRow?.count || 0) / totalCites) * 100)}% of everything cited${youLead ? ', more than any other host in the category' : ''}.</p>
        ${L.shareTable(rows)}
        ${hostMetric.deltaPrev != null && hostMetric.deltaPrev !== 0
          ? `<p class="lr-note">${esc(`The cited pool ${hostMetric.deltaPrev < 0 ? 'narrowed' : 'widened'} from ${hostMetric.prev} hosts to ${hostMetric.current}. Engines are citing a ${hostMetric.deltaPrev < 0 ? 'narrower' : 'wider'} set, which changes how much a single new host is worth this run.`)}</p>`
          : ''}
      </div>
      ${graphAlert}
      ${actBar([ownCitationMetric, hostMetric], 'counts: 1-unit floor')}`;
  })();

  // ── Diagnostics lead ──────────────────────────────────────────────────
  const diagnosticsLead = (() => {
    const blocks = [];

    // LOUD only when coverage is actually short. On a site whose sections all
    // carry a quotable answer this same code path renders nothing.
    if (capsules && Number.isFinite(capsules.coverage) && capsules.totalH2 > 0 && capsules.coverage < 50) {
      const bare = capsules.totalH2 - capsules.withCapsule;
      const wordRange = (() => {
        const words = (capsules.samples || []).map(s => s.paraWords).filter(Number.isFinite);
        if (!words.length) return null;
        return { lo: Math.min(...words), hi: Math.max(...words) };
      })();
      blocks.push(L.alertCard({
        tone: 'bad',
        kicker: 'Quotable content',
        title: `${capsules.withCapsule} of ${capsules.totalH2} homepage sections carries an answer capsule`,
        bodyHtml: `${bare} of your ${capsules.totalH2} H2 sections ${wordRange ? `are followed by ${wordRange.lo} to ${wordRange.hi} words` : 'carry no self-contained paragraph'} — too short for an engine to lift as a complete answer.${capsuleMetric.prev != null ? ` Coverage was ${capsuleMetric.prev}% on ${esc(summary.meta.prevDate)} and is ${capsules.coverage}% now.` : ''} Every section that names a capability needs two to four sentences under it that stand on their own, because that is the unit an engine quotes.`,
        extraHtml: `<div class="lr-alert-figure">
          ${L.eyebrow('Capsule coverage')}
          <span class="lr-figure-num">${capsules.coverage}%<small> · ${capsules.withCapsule} of ${capsules.totalH2}</small></span>
          ${chipFor(capsuleMetric)}
        </div>`,
      }));
    }

    // Crawl access — a table precisely because nothing is blocking.
    const crawlRobots = latest?.crawlability?.robots?.parsed?.groups || [];
    const botGroups = crawlRobots.filter(g => (g.userAgents || []).some(ua => ua !== '*'));
    if (botGroups.length) {
      const blocked = botGroups.filter(g => (g.disallow || []).includes('/'));
      const shown = botGroups.slice(0, 4);
      blocks.push(`<div class="lr-card">
        <div class="lr-card-head">
          <span class="lr-head-titles">
            ${L.eyebrow('Crawl access')}
            <h3 class="lr-h3">${esc(blocked.length === 0
              ? `All ${botGroups.length} named AI crawlers are allowed`
              : `${blocked.length} of ${botGroups.length} named AI crawlers are blocked`)}</h3>
          </span>
        </div>
        <div class="lr-tiles">${shown.map(g => L.statusTile({
          name: (g.userAgents || [])[0] || 'crawler',
          status: (g.disallow || []).includes('/') ? 'Blocked' : 'Allowed',
          tone: (g.disallow || []).includes('/') ? 'bad' : 'good',
        })).join('')}</div>
        <p class="lr-note">${esc(`${botGroups.length - shown.length > 0 ? `Plus ${botGroups.length - shown.length} further AI agents. ` : ''}${blocked.length === 0 ? 'Nothing here is blocking an engine — which is why this is a table and not a headline.' : 'A blocked crawler cannot see the site at all; this is the first thing to fix.'}`)}</p>
      </div>`);
    }

    // Conditional context — rendered because the checks ran, coloured only
    // where something tripped.
    const quiet = [];
    if (ads && Number.isFinite(ads.totalCellsScanned)) {
      quiet.push(L.quietCard({
        label: 'Sponsored placements',
        title: ads.totalCellsWithAdSignal > 0 ? 'Ad signal detected' : 'None detected',
        body: `${ads.totalCellsScanned} answers scanned, ${ads.totalCellsWithAdSignal === 0 ? 'no ad signal on any of them' : `${ads.totalCellsWithAdSignal} carrying an ad signal`}.`,
        badge: `${ads.totalCellsWithAdSignal} of ${ads.totalCellsScanned}`,
        badgeTone: ads.totalCellsWithAdSignal > 0 ? 'warn' : 'quiet',
      }));
    }
    if (freshness?.counts) {
      const f = freshness.counts;
      quiet.push(L.quietCard({
        label: 'Answer freshness',
        title: f.stale === 0 ? `All ${f.total} answers fresh` : `${f.stale} of ${f.total} answers stale`,
        body: f.stale === 0
          ? 'Every engine ran a live web search rather than answering from training data, so this run reflects the site as it stands today.'
          : 'Some engines answered from training data rather than a live search, so those answers describe an older version of the site.',
        badge: `${f.fresh} of ${f.total}`,
        badgeTone: f.stale === 0 ? 'good' : 'warn',
      }));
    }
    if (regionAgg) {
      const per = regionAgg.perRegion || {};
      const names = Object.keys(per);
      quiet.push(L.quietCard({
        label: 'Region signals',
        title: names.length === 0 ? 'No regional signal'
          : names.length === 1 ? `Reads as ${names[0]}`
          : 'Weak and split',
        body: names.length === 0
          ? 'No engine gave a regional hint this run.'
          : `${names.length} region${names.length === 1 ? '' : 's'} hinted at — ${names.map(k => `${k} from ${per[k]} signal${per[k] === 1 ? '' : 's'}`).join(', ')}. Recorded rather than interpreted.`,
        badge: regionAgg.confidence === 'high' ? 'high confidence' : regionAgg.confidence === 'med' ? 'medium confidence' : 'low confidence',
        badgeTone: 'quiet',
      }));
    }
    if (quiet.length) blocks.push(`<div class="lr-grid-3">${quiet.join('')}</div>`);

    // Only this section's own checks are candidates. Offering a Citations
    // metric here would let one section's finding be reported as another's.
    blocks.push(actBar([capsuleMetric], `floor ${significanceFloor('points').toFixed(1)} pt on 0-100 axes`));

    // The measurement disclaimer, verbatim from the run record, closes the
    // last client-facing section.
    const disclaimer = summary.meta.measurement?.disclaimer;
    if (disclaimer) blocks.push(`<p class="lr-disclaimer">${esc(disclaimer)}</p>`);
    return blocks.join('');
  })();

  // ── Actions lead ─────────────────────────────────────────────────────
  // Founder ruling 2026-08-29: Actions ships in the client deliverable — it
  // is the deliberate lure toward the paid plan, not internal-only. Only the
  // white-label (statistics-only, agency-facing) variant drops the section
  // entirely, via `whiteLabelExcluded` below — unrelated to this lead text.
  const actionsLead = '';

  // ── Section spec — single source of truth ──
  // One array drives: section ordering, rail navigation, section overlines
  // (chapter intros), and the next-section handoff arrow. Reordering this
  // array reorders the report consistently; handoff derives the next id/num
  // automatically so it never goes out of sync.
  // White-label drops the Actions section entirely (statistics-only deliverable)
  // and uses neutral empty-state copy — the default empty messages name the tool
  // ("Run aeo-platform run…", "Re-run report --html…"), which would leak through
  // an empty section's placeholder. Numbers are recomputed so the rail stays
  // continuous (no "05" hole between 04 and what would be 06).
  // Section verdict titles. Every one is derived from this run's numbers, so
  // a section that finds nothing says so instead of borrowing last month's
  // conclusion.
  const lostCells = history.cells.filter(c => c.verdict === VERDICT.LOST).length;
  const gainedCells = history.cells.filter(c => c.verdict === VERDICT.GAINED).length;
  const totalCells = history.cells.length;
  const compCount = (latest?.topCompetitors || []).length;
  const overviewTitle = indexMetric.deltaPrev == null
    ? `${indexMetric.current} of 100 on the first run`
    : indexMetric.deltaPrev < 0
      ? `Down ${Math.abs(indexMetric.deltaPrev)} points${lostCells ? ` on ${lostCells} answer${lostCells === 1 ? '' : 's'}` : ''}`
      : indexMetric.deltaPrev > 0
        ? `Up ${indexMetric.deltaPrev} points${gainedCells ? ` on ${gainedCells} answer${gainedCells === 1 ? '' : 's'}` : ''}`
        : `Holding at ${indexMetric.current} of 100`;
  const visibilityTitle = totalCells === 0
    ? 'No answers measured this run'
    : lostCells > 0
      ? `${presenceMetric.current} answers name or cite you, ${lostCells} stopped`
      : gainedCells > 0
        ? `${presenceMetric.current} answers name or cite you, ${gainedCells} new`
        : `${presenceMetric.current} of ${totalCells} answers name or cite you`;
  const competitorsTitle = competitorMetric.deltaPrev == null
    ? `${compCount} rival tool${compCount === 1 ? '' : 's'} named alongside you`
    : competitorMetric.deltaPrev > 0
      ? `The field widened: ${compCount} tools named where ${competitorMetric.prev} were named last run`
      : competitorMetric.deltaPrev < 0
        ? `The field narrowed: ${compCount} tools named where ${competitorMetric.prev} were named last run`
        : `The same ${compCount} rival tools, named again`;
  const citationsTitle = (() => {
    const own = String(summary.meta.domain || '').replace(/^www\./, '').toLowerCase();
    const leader = (summary.topDomains || [])[0];
    if (!leader) return 'No sources cited this run';
    return String(leader.host || '').toLowerCase() === own
      ? 'You are the most-cited source in your own category'
      : `${leader.host} is cited more than you in your own category`;
  })();
  const diagnosticsTitle = (() => {
    const parts = [];
    const robots = latest?.crawlability?.robots?.parsed?.groups || [];
    const named = robots.filter(g => (g.userAgents || []).some(ua => ua !== '*'));
    const blocked = named.filter(g => (g.disallow || []).includes('/'));
    if (named.length) parts.push(blocked.length === 0 ? 'Crawling is clean' : `${blocked.length} AI crawlers are blocked`);
    if (capsules && Number.isFinite(capsules.coverage)) {
      parts.push(capsules.coverage < 50 ? 'Your homepage answers almost nothing' : 'Your homepage answers in quotable units');
    }
    return parts.length ? parts.join('. ') + '.' : 'Site readiness checks ran';
  })();

  // ── Section spec — single source of truth ──
  // One array drives: section ordering, rail navigation, the numbered section
  // header, the loud lead block, the bento cells that follow it, and an
  // optional `tail` — a loud block rendered BELOW the bento, for material a
  // reader reaches for after the scan blocks rather than before them.
  // Visibility is the only current user (its question-by-question record).
  //
  // The standalone "Run Comparison" section is gone as of the 2026-08 loud
  // redesign: trend is now a property of every section rather than a chapter
  // of its own. Its MODEL (buildRunComparison) is still what Overview reads —
  // the module was kept and only its rendering replaced. The markdown report
  // still carries sectionRunComparison, reading the same model, so the two
  // surfaces cannot disagree about what moved.
  //
  // White-label drops the Actions section entirely (statistics-only deliverable)
  // and uses neutral empty-state copy — the default empty messages name the tool
  // ("Run aeo-platform run…", "Re-run report --html…"), which would leak through
  // an empty section's placeholder. Numbers are recomputed so the rail stays
  // continuous (no "05" hole between 04 and what would be 06).
  const SECTION_SPECS = [
    { id: 'overview',    label: 'Overview',    kicker: 'Overview · what changed this run',        title: overviewTitle,
      meta: summary.meta.prevDate ? `run of ${summary.meta.date} · compared with ${summary.meta.prevDate}` : `run of ${summary.meta.date} · first run`,
      lead: overviewLead, cells: overviewCells,
      emptyMsg: 'Overview lights up after the second run — trend and topic clusters need at least two snapshots to compare.' },
    { id: 'visibility',  label: 'Visibility',  kicker: 'Visibility · per engine, by question',    title: visibilityTitle,
      meta: `${questionGroups.length} questions × ${enginesNow.total} engines · ${runCount} run${runCount === 1 ? '' : 's'}`,
      cells: visibilityCells, tail: visibilityDetail,
      emptyMsg: 'No visibility data this run.' },
    { id: 'competitors', label: 'Competitors', kicker: 'Competitors · who AI named instead',      title: competitorsTitle,
      meta: `${totalCells} answers · verified names only`,
      lead: competitorsLead, cells: competitorsCells,
      emptyMsg: 'No competitors detected — the AI engines did not name other brands in their answers this run.' },
    { id: 'citations',   label: 'Citations',   kicker: 'Citations · who AI cites about your category', title: citationsTitle,
      meta: `${citationsAllHosts} citations · ${hostMetric.current ?? 0} hosts`,
      lead: citationsLead, cells: citationsCells,
      emptyMsg: 'No citations earned this run — the domain is not yet in the engines\' source pools.' },
    { id: 'diagnostics', label: 'Diagnostics', kicker: 'Diagnostics · site readiness',            title: diagnosticsTitle,
      meta: 'robots · sitemap · page signals',
      lead: diagnosticsLead, cells: diagnosticsCells,
      emptyMsg: 'No diagnostic data this run.' },
    { id: 'actions',     label: 'Actions',     kicker: 'Actions · what to ship next',             title: `${actionPlan.length} move${actionPlan.length === 1 ? '' : 's'}, in cost order`,
      meta: `what to ship next · run of ${summary.meta.date}`,
      lead: actionsLead, cells: actionsCells, whiteLabelExcluded: true,
      emptyMsg: 'No action items this run — the recommendations pass did not surface anything new.' },
  ];
  // Actions ships in the client deliverable (founder ruling 2026-08-29). Only
  // the statistics-only white-label variant excludes it.
  const SECTIONS = SECTION_SPECS
    .filter(s => !(whiteLabel && s.whiteLabelExcluded))
    .map((s, i) => ({ ...s, num: String(i + 1).padStart(2, '0') }));

  // ── Render each section ──
  // Empty sections still render their numbered header. This keeps the rail
  // numbering continuous — a missing «04» between «03» and «05» reads as a
  // broken build, not as «no data».
  const sectionPlaceholder = (msg) =>
    `<article class="cell span-6 cell-empty">${esc(msg)}</article>`;

  const sectionsHtml = SECTIONS.map((s) => {
    const head = L.sectionHead({ num: s.num, kicker: s.kicker, title: s.title, meta: s.meta, tone: s.tone });
    // The placeholder is suppressed by a lead OR a tail. Visibility's
    // substance moved into the tail, and its two sources can diverge —
    // `cells` come from this run's positionMatrix, `tail` from the answer
    // history across snapshots — so a partial run can leave cells empty
    // while the record is fully populated. Keying only on `lead` would
    // print "No visibility data this run." directly above that record.
    const body = s.cells.length === 0
      ? ((s.lead || s.tail) ? '' : (s.emptyMsg ? `<div class="bento">${sectionPlaceholder(s.emptyMsg)}</div>` : ''))
      : `<div class="bento">${s.cells.join('')}</div>`;
    if (!s.lead && !s.tail && !body) return '';
    return `<section id="${s.id}" class="lr-section">${head}${s.lead || ''}${body}${s.tail || ''}</section>`;
  }).filter(Boolean).join('\n');

  // ── Rail nav (only sections that actually rendered) ──
  // A section now renders when it has a loud lead, a tail, or bento cells —
  // the loud blocks are the section's substance, so keying the rail on cells
  // alone would hide a fully-populated section from the outline.
  const railLinks = SECTIONS.filter(s => s.lead || s.tail || s.cells.length > 0);
  const railHtml = railLinks.map((s, i) =>
    `<a href="#${s.id}"${i === 0 ? ' class="active"' : ''}><span class="rail-num">${s.num}</span> ${esc(s.label)}</a>`,
  ).join('');

  // ── Verdict hero ──────────────────────────────────────────────────────
  // The conclusion first, the number second. Below the ladder's chip
  // threshold (run 1) the headline states the score rather than a change,
  // because there is nothing yet to have changed from.
  const verdictHeroHtml = (() => {
    const kicker = `Run ${runCount} · ${summary.meta.date}${runCount > 1 ? ` · ${runCount} runs on record` : ' · first run'}`;
    // The verdict's BRANCHING is shared with the markdown surface (see
    // buildVerdictHeadline); this surface only decides that the closing clause
    // is emphasised.
    const headline = verdictModel.segments
      .map(seg => (seg.emphasis ? `<em>${esc(seg.text)}</em>` : esc(seg.text)))
      .join('');
    const lede = (() => {
      const parts = [];
      parts.push(`${esc(summary.meta.brand)} scored <b class="lr-strong">${indexMetric.current ?? summary.score} of 100</b> on ${esc(summary.meta.date)}`);
      if (indexMetric.deltaPrev != null) {
        parts.push(` — ${Math.abs(indexMetric.deltaPrev)} point${Math.abs(indexMetric.deltaPrev) === 1 ? '' : 's'} ${indexMetric.deltaPrev < 0 ? 'below' : indexMetric.deltaPrev > 0 ? 'above' : 'level with'} the ${esc(summary.meta.prevDate)} run`);
      }
      if (caps.baselineCaption && indexMetric.deltaFirst != null && indexMetric.deltaFirst !== 0) {
        parts.push(`, ${Math.abs(indexMetric.deltaFirst)} ${indexMetric.deltaFirst > 0 ? 'above' : 'below'} the first run on ${esc(runDates[0])}`);
      }
      parts.push(`. ${presenceMetric.current} of ${totalCells} answers name or cite you.`);
      if (changedCell) parts.push(` ${esc(changedCell.record)}`);
      return parts.join('');
    })();
    const kpis = [
      L.kpiCard({
        label: 'Visibility index',
        value: indexMetric.current ?? summary.score,
        denom: '/ 100',
        chipHtml: chipFor(indexMetric),
        noteHtml: caps.baselineCaption && indexMetric.deltaFirst != null
          ? `${indexMetric.deltaFirst >= 0 ? 'Up' : 'Down'} <b class="${indexMetric.deltaFirst >= 0 ? 'lr-verdict-good' : 'lr-verdict-bad'}">${Math.abs(indexMetric.deltaFirst)} points</b> since day 1`
          : '',
      }),
      L.kpiCard({
        label: 'Answers naming or citing you',
        value: presenceMetric.current ?? 0,
        denom: `/ ${totalCells}`,
        chipHtml: chipFor(presenceMetric),
        note: `${questionGroups.length} question${questionGroups.length === 1 ? '' : 's'} × ${enginesNow.total} engine${enginesNow.total === 1 ? '' : 's'}`,
      }),
      L.kpiCard({
        label: 'Engines naming you everywhere',
        value: enginesNow.full,
        denom: `/ ${enginesNow.total}`,
        chipHtml: caps.chips && enginesPrev.full != null && enginesNow.full !== enginesPrev.full
          ? L.chip(formatDelta(enginesNow.full - enginesPrev.full, ''), chipTone(enginesNow.full - enginesPrev.full, 'count', true))
          : '',
        note: enginesNow.full === enginesNow.total
          ? 'Every engine names you on every question'
          : `${enginesNow.total - enginesNow.full} engine${enginesNow.total - enginesNow.full === 1 ? '' : 's'} still ${enginesNow.total - enginesNow.full === 1 ? 'has' : 'have'} a gap`,
      }),
    ];
    // ── Lift opportunities — the aggregate the per-answer pills cannot state ──
    // Each answer row already carries its own "Cited, not named" pill. What the
    // pills cannot say is HOW BIG the condition is across the run, or what to
    // do about it — so the roll-up and its one actionable sentence sit here,
    // with the other headline figures.
    //
    // The note is advisory copy, which is exactly what a white-label snapshot
    // must not carry (it ships under the legend of a self-made statistics
    // tool). The whole card is therefore withheld from white-label, the same
    // gate the pre-redesign KPI carried.
    //
    // Wording comes from `buildLiftNarrative` — the same two halves the
    // markdown run verdict composes (sections.js sectionRunVerdict), so the
    // two surfaces cannot end up describing the same figure in two different
    // sentences. This card always renders the full note, because it only
    // renders at all when the report is NOT white-label.
    if (!whiteLabel) {
      const liftNote = buildLiftNarrative(lift);
      kpis.push(L.kpiCard({
        label: 'Lift opportunities',
        value: lift.cited,
        denom: `/ ${lift.total}`,
        note: `${liftNote.stat} ${liftNote.advisory}`,
      }));
    }
    return L.verdictHero({ kicker, headlineHtml: headline, ledeHtml: lede, kpis });
  })();

  // ── One page: one conclusion per section ──────────────────────────────
  const onePageHtml = (() => {
    const rows = SECTIONS
      .filter(s => s.lead || s.cells.length > 0)
      .map(s => ({
        num: s.num,
        label: s.label,
        href: `#${s.id}`,
        sentence: s.title,
        chipHtml: (() => {
          if (!caps.chips) return '';
          if (s.id === 'overview')    return chipFor(indexMetric);
          if (s.id === 'visibility')  return chipFor(presenceMetric);
          if (s.id === 'competitors') return competitorMetric.deltaPrev != null
            ? L.chip(competitorMetric.chipText, chipTone(competitorMetric.deltaPrev, 'count', false)) : '';
          if (s.id === 'citations')   return chipFor(ownCitationMetric);
          if (s.id === 'diagnostics') return chipFor(capsuleMetric);
          return '';
        })(),
      }));
    if (!rows.length) return '';
    // The one-page mover explains the HEADLINE number, so its candidates are
    // the index and the things the index is made of. Ranking every section's
    // metric against each other here would let an incidental count out-shout
    // the reason the score moved.
    const mover = caps.whereToAct
      ? headlineMover(M, axisModel.metrics, summary.meta.prevDate)
      : { text: `Movement is not called until run ${SHAPES_MIN_RUNS}. With ${runCount} run${runCount === 1 ? '' : 's'} on record this report states what is true today rather than what is trending.`, metric: null };
    return L.onePage({
      title: `${rows.length} finding${rows.length === 1 ? '' : 's'}, one per section`,
      meta: summary.meta.prevDate
        ? `run of ${summary.meta.date} · compared with ${summary.meta.prevDate}`
        : `run of ${summary.meta.date} · first run on record`,
      rows,
      moverHtml: `<b class="lr-strong">${esc(mover.text)}</b> Everything below is the detail behind these ${rows.length} lines, in the same order.`,
    });
  })();

  // ── White-label header / colophon ──
  // Neutral, parameterizable title (no tool name). The masthead "mark" (the
  // «aeo-platform» wordmark + version) and the colophon's tool name + repo link
  // are the tool fingerprint — withhold them for a client snapshot, leaving a
  // plain date + run-id colophon.
  const wlTitle = (typeof opts.reportTitle === 'string' && opts.reportTitle.trim())
    ? opts.reportTitle.trim()
    : `AEO Visibility Snapshot — ${summary.meta.domain} · ${summary.meta.date}`;
  const docTitle = whiteLabel
    ? esc(wlTitle)
    : `AEO Visibility · ${esc(summary.meta.brand)} · ${esc(summary.meta.date)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${docTitle}</title>
<style>${css}</style>
</head>
<body>
<main class="page">

  <header class="mast">
    <div class="mast-tools">
      ${whiteLabel ? '' : `<div class="mast-mark"><span class="mast-mark-dot" aria-hidden="true"></span><strong>aeo-platform</strong>${opts.pkgVersion ? `<span class="mast-mark-ver">v${esc(opts.pkgVersion)}</span>` : ''}</div>`}
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
    ${(() => {
      // White-label: the shared disclaimer reads "API surface (your keys)", which is
      // (a) internal jargon to an external reader and (b) an overclaim once a manual
      // engine (Claude) is mixed in. Render an accurate, recipient-neutral scope note
      // instead — for BOTH the visible text and the title, so "your keys" never lingers
      // in the tooltip. The default report keeps the precise shared disclaimer unchanged.
      const wl = 'Each engine was asked the same buyer questions directly — a repeatable snapshot, not the consumer chat apps. Google AI Overviews and Microsoft Copilot are not included.';
      const text  = whiteLabel ? wl : (summary.meta.measurementShort || summary.meta.measurement?.disclaimer);
      const title = whiteLabel ? wl : (summary.meta.measurement?.disclaimer || '');
      return text ? `<p class="mast-disclaimer" title="${esc(title)}">${esc(text)}</p>` : '';
    })()}
  </header>

  ${railHtml ? `<nav class="rail" aria-label="Section outline">
    <span class="rail-label">Sections</span>
    ${railHtml}
  </nav>` : ''}

  ${verdictHeroHtml}

  ${onePageHtml}

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
    ${whiteLabel ? `<p class="colophon-method">${esc(whiteLabelMethodologyText(latest))}</p>
    <div class="colophon-meta">
      <span>${esc(summary.meta.date)}</span>
      <span class="dot">·</span>
      <span class="colophon-runid">${esc(summary.meta.runId)}</span>
    </div>` : `<div class="colophon-meta">
      <span><strong>aeo-platform</strong></span>
      ${opts.pkgVersion ? `<span class="dot">·</span><span>v${esc(opts.pkgVersion)}</span>` : ''}
      <span class="dot">·</span>
      ${opts.repoUrl ? `<a href="${esc(opts.repoUrl)}">open source · zero deps</a>` : `<span>open source · zero deps</span>`}
      <span class="dot">·</span>
      <span>${esc(summary.meta.date)}</span>
      <span class="dot">·</span>
      <span class="colophon-runid">${esc(summary.meta.runId)}</span>
    </div>`}
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
    /* Mirror onto the scroll wrapper too. The legend and the sentiment
       empty-state are siblings of .matrix, not of .matrix-grid, so they can
       only be selected from an attribute that lives on .matrix itself —
       plain sibling combinators, no :has() dependency. */
    var wrap = section ? section.querySelector('.matrix') : null;
    if (wrap) wrap.setAttribute('data-view', view);
  });
});

/* Print/PDF: expand EVERY collapsed disclosure so Save-as-PDF captures the
   whole deliverable. Two levels are collapsed on screen — '.fold' wraps the
   verbatim answers and the per-question record, '.reveal' is one answer row
   inside the first of them — and BOTH must be in this selector: an outer
   closed <details> prints nothing in some engines even when its children
   carry 'open', and a closed <details> cannot be opened by CSS at all. Narrow
   this selector and the client's PDF silently loses those blocks, with no
   visible symptom on screen.

   Toggle the native open attribute — the reliable cross-engine way to expand
   a details element; restore the on-screen collapsed state afterwards so the
   live page is unchanged. Capture and restore walk ONE list by index, so the
   selector can be widened safely; splitting it into two arrays would not be.
   Falls back silently if matchMedia/print events are unavailable (older
   engines just print whatever is currently open). */
(function () {
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal, .fold'));
  if (!reveals.length) return;
  var prevOpen = [];
  function expandAll() {
    prevOpen = reveals.map(function (d) { return d.open; });
    reveals.forEach(function (d) { d.open = true; });
  }
  function restoreAll() {
    reveals.forEach(function (d, i) { d.open = prevOpen[i]; });
  }
  window.addEventListener('beforeprint', expandAll);
  window.addEventListener('afterprint', restoreAll);
  /* Safari/WebKit historically lacked beforeprint — hook matchMedia('print'). */
  if (window.matchMedia) {
    var mql = window.matchMedia('print');
    var onChange = function (m) { (m.matches ? expandAll : restoreAll)(); };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
  }
})();
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

