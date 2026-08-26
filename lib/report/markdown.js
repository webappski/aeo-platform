import {
  escMd,
  sectionHeader,
  sectionHero,
  sectionBaseline,
  sectionExecutiveSummary,
  sectionKeyMetrics,
  sectionEngineRadar,
  sectionMatrix,
  sectionEngineActions,
  sectionVerbatimQuotes,
  sectionSentiment,
  sectionDiff,
  sectionRunComparison,
  sectionRunVerdict,
  sectionTrend,
  sectionHistoricalTrend,
  sectionCompetitors,
  sectionCompetitorRadar,
  sectionCompetitorIntelligence,
  sectionActionableGaps,
  sectionCanonicalSources,
  sectionDomainShareOfVoice,
  sectionDomainCategories,
  sectionFunnelBreakdown,
  sectionCrawlability,
  sectionDiscoverability,
  sectionGeoComparison,
  sectionTopicClusters,
  sectionUnifiedVisibilityIndex,
  sectionScoreRepresentativeness,
  sectionAuthorityPresence,
  sectionAdsDetection,
  sectionUtmCitations,
  // Kept for re-enable when domain-type classifier lands — see markdown.js:84.
  sectionOutreachTemplates,
  sectionDisambiguationWarning,
  sectionNextSteps,
  sectionFooter,
  sectionMcMetadataMd,
} from './sections.js';
import { extractOpenAIResponse } from '../providers/openai.js';

/**
 * Compose the full report markdown from ordered snapshots and raw responses.
 *
 * snapshots[last].citationClassification (if present) is used by
 * sectionDisambiguationWarning — set by cmdReport after classifyCitations().
 *
 * @param {Object[]} snapshots   array of _summary.json objects, chronological
 * @param {Object} rawResponses  map { "<query>|<provider>": "full response text" }
 * @param {Object} [opts]
 * @param {Object} [opts.mcMetadata]    pre-built MC metadata payload (mc-metadata.js)
 * @param {boolean} [opts.noMcBlock]    if true, skip the MC metadata section
 * @param {boolean} [opts.whiteLabel]   if true, statistics-only client snapshot:
 *                                       drop the Webappski footer, the recommendation
 *                                       / action / outreach blocks, and the MC block;
 *                                       append a neutral methodology note instead.
 * @param {string}  [opts.reportTitle]  neutral title for the white-label header
 * @returns {string} markdown document
 */
export function renderMarkdown(snapshots, rawResponses = {}, opts = {}) {
  const whiteLabel = opts.whiteLabel === true;
  if (whiteLabel) return renderWhiteLabelMarkdown(snapshots, rawResponses, opts);
  const sections = [
    sectionHeader(snapshots),
    sectionHero(snapshots),                   // P1 — traffic light + big number
    sectionRunVerdict(snapshots), // 2026-08 — the loud register on the markdown surface (whiteLabel defaults false: the lift note keeps its advisory half here)
    sectionUnifiedVisibilityIndex(snapshots, opts.public === true), // v0.5 — composite UVI score
    sectionScoreRepresentativeness(snapshots), // AP-FIX-SCORE-SEGMENT — small-N + coverage + fit context for the headline
    sectionBaseline(snapshots),               // P10 — "is 0% bad?" context
    sectionHistoricalTrend(snapshots),        // v0.3 — 8-week visibility line
    sectionNextSteps(snapshots),              // P6 — actions checklist (top for scanners)
    sectionExecutiveSummary(snapshots),       // plain-English
    sectionKeyMetrics(snapshots),             // score cards (HTML)
    sectionEngineRadar(snapshots),            // P2 — radar chart
    sectionMatrix(snapshots),                 // P7 — heatmap with icon legend
    sectionEngineActions(snapshots),          // per-engine action cards (HTML)
    sectionVerbatimQuotes(snapshots, rawResponses),
    sectionSentiment(snapshots),              // v0.3 — brand portrayal table
    sectionFunnelBreakdown(snapshots),        // v0.4 — visibility per intent tag
    sectionDisambiguationWarning(snapshots),
    sectionDiff(snapshots),
    sectionRunComparison(snapshots),
    sectionTrend(snapshots),                  // P8 — sparklines / first-run placeholder
    sectionCompetitors(snapshots),            // P3 — barchart with YOU row accent
    sectionCompetitorRadar(snapshots),        // v0.3 — 4-axis radar vs top-3
    sectionCompetitorIntelligence(snapshots), // gap table: who wins your missing queries
    sectionActionableGaps(snapshots),         // v0.4 — concrete what-to-do per gap
    sectionDomainShareOfVoice(snapshots),     // v0.3 — domain-level citation table
    sectionDomainCategories(snapshots),       // v0.4 — by-category share + outreach hint
    sectionCanonicalSources(snapshots),       // P5 — where to get mentioned
    sectionCrawlability(snapshots),           // v0.4 — robots.txt + bot access matrix
    sectionDiscoverability(snapshots),        // v0.5 — composite of crawlability inputs
    sectionAuthorityPresence(snapshots),      // v0.6 — Wikipedia + Reddit presence
    sectionTopicClusters(snapshots),          // v0.5 — visibility per topic cluster
    sectionGeoComparison(snapshots),          // v0.4 — region × engine when --geo used
    sectionUtmCitations(snapshots),           // v0.6 — own-domain UTM-tagged citations
    sectionAdsDetection(snapshots),           // v0.6 — sponsored content / ad-network detection
    // sectionOutreachTemplates(snapshots),      // v0.3 — disabled: pitches competitors, not just publishers (see memory: project_outreach_pitches_to_competitors.md)
    sectionFooter(snapshots, opts.mcMetadata?.identity?.lang, opts.responsesPath),
    !opts.noMcBlock ? sectionMcMetadataMd(snapshots, opts.mcMetadata) : '', // v0.7 — AEO MC metadata payload
  ];
  return sections.filter(s => s && s.trim()).join('\n');
}

/**
 * Build the neutral methodology footer for a white-label snapshot. Derives the
 * query / engine counts from the data — never hardcoded — so the sentence stays
 * true for any brand or basket. Honest by construction: it states this is a
 * single snapshot with no confidence intervals, and does not claim statistics
 * it doesn't have.
 *
 * @param {Object} latest  the newest _summary.json snapshot
 * @returns {string} markdown footer
 */
export function whiteLabelMethodology(latest) {
  // Null-guard symmetric with the HTML twin whiteLabelMethodologyText: tolerate a
  // missing/empty snapshot rather than throwing on latest.results.
  const results = (latest && Array.isArray(latest.results)) ? latest.results : [];
  const queryCount = new Set(results.map(r => r.queryText || r.query)).size;
  const engineCount = new Set(results.map(r => r.provider)).size;
  const q = `${queryCount} buyer-intent quer${queryCount === 1 ? 'y' : 'ies'}`;
  const e = `${engineCount} AI engine${engineCount === 1 ? '' : 's'}`;
  return `---

_Methodology: ${q} × ${e}, single snapshot on ${escMd(latest ? latest.date : '')}. ` +
    `Each engine was queried through its own answer API; a brand counts as ` +
    `"mentioned" when it appears in the engine's answer. This is one point-in-time ` +
    `reading, not a longitudinal study — no confidence intervals are implied._
`;
}

/**
 * White-label client snapshot: statistics only, in the standard layout, with a
 * neutral header + methodology footer. Drops the tool/agency fingerprint, the
 * recommendation / action / outreach blocks, and the MC block. Composed from the
 * SAME statistic sections as the full report — so the numbers can never diverge.
 */
function renderWhiteLabelMarkdown(snapshots, rawResponses, opts) {
  const latest = snapshots[snapshots.length - 1];
  const title = (typeof opts.reportTitle === 'string' && opts.reportTitle.trim())
    ? opts.reportTitle.trim()
    : `AEO Visibility Snapshot — ${escMd(latest.domain)} · ${escMd(latest.date)}`;

  const sections = [
    `# ${title}\n`,
    sectionHero(snapshots),                    // headline score + plain-English status
    sectionRunVerdict(snapshots, { whiteLabel: true }), // 2026-08 — loud register, statistics only: drops the lift note's advisory half
    sectionUnifiedVisibilityIndex(snapshots, true), // public=true → no source-path footnotes
    sectionScoreRepresentativeness(snapshots), // small-N / coverage context
    sectionKeyMetrics(snapshots),
    sectionEngineRadar(snapshots),
    sectionMatrix(snapshots),                  // query × engine heatmap
    sectionVerbatimQuotes(snapshots, rawResponses),
    sectionSentiment(snapshots),
    sectionFunnelBreakdown(snapshots),
    sectionDiff(snapshots),
    sectionRunComparison(snapshots),
    sectionTrend(snapshots),
    sectionCompetitors(snapshots, { whiteLabel: true }), // barchart only — drops the «invest … closing the gap» clause
    sectionCompetitorRadar(snapshots),
    sectionCompetitorIntelligence(snapshots),
    sectionDomainShareOfVoice(snapshots, { whiteLabel: true }), // drops «Pitching the top 3 …» + dangling Outreach-templates link
    sectionDomainCategories(snapshots, { whiteLabel: true }),   // drops the «Outreach move» column + per-row playbook
    sectionCanonicalSources(snapshots, { whiteLabel: true }),   // statistics-only «Citation Sources» — no «Your action» pitch column
    sectionCrawlability(snapshots, { whiteLabel: true }), // drops the tool-name re-audit footnote at source
    sectionDiscoverability(snapshots),
    sectionAuthorityPresence(snapshots),       // Wikipedia / authority presence
    sectionTopicClusters(snapshots),
    sectionGeoComparison(snapshots),
    sectionUtmCitations(snapshots),
    sectionAdsDetection(snapshots),
    // Intentionally dropped for a client snapshot: sectionHeader (tool name in
    // generatedBy), sectionNextSteps / sectionEngineActions / sectionActionableGaps
    // (recommendation + outreach blocks), sectionFooter (Webappski + "Generated by
    // aeo-platform"), sectionMcMetadataMd (Mission-Control bridge).
    whiteLabelMethodology(latest),
  ];
  // Every section above is fingerprint- and recommendation-free AT SOURCE: the
  // three citation sections + sectionCrawlability + sectionRunVerdict are each
  // passed { whiteLabel: true }, and the agency / action / outreach / MC
  // sections are not in the list at all. No post-render scrub pass — a regex that strips an
  // already-fixed string is a false-confidence no-op, and it would mask a future
  // leak instead of forcing the fix at source. The leak-guard E2E proves clean.
  return sections.filter(s => s && s.trim()).join('\n');
}

/**
 * Extract plain text from a saved raw API response based on provider shape.
 * Used by the report command when loading historical raw JSON files.
 */
export function parseRawResponse(provider, raw) {
  if (!raw) return '';
  if (provider === 'openai') {
    // Shared extractor — handles both Responses-API (output[]) and legacy
    // Chat-Completions (choices[]) cache shapes. See lib/providers/openai.js.
    return extractOpenAIResponse(raw).text;
  }
  if (provider === 'perplexity') {
    return raw.choices?.[0]?.message?.content || '';
  }
  if (provider === 'gemini') {
    return (raw.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
  }
  if (provider === 'anthropic') {
    return (raw.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}
