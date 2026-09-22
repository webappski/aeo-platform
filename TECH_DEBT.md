# Tech Debt — aeo-tracker

Tracked deviations from `CODING_STANDARDS.md`. Each entry: source, scope, why it isn't fixed yet, what makes the fix safe to attempt.

The `npm run test:design-lint` job surfaces design-system regressions automatically — soft-warns for items listed here, hard-fails for new violations in cleaned-up files.

## Active items

### 1. File sizes above 300-line default

Allowed exceptions per `CODING_STANDARDS.md`:

| File | Lines (approx.) | Status |
|---|---|---|
| `bin/aeo-tracker.js` | 3300+ | Active debt — CLI entry, decomposition planned |
| `lib/report/html.js` | ~1380 | Reduced from 3900+ via CSS extract (2026-05) |
| `lib/report/sections.js` | 1800+ | Active debt — palette/font-size cleanup done (2026-05); only file-size split remaining |
| `lib/report/mc-bridge.js` | ~395 | Reduced from 2340+ via CSS extract (2026-05) |

**Status of html.js / mc-bridge.js:** below 1500 lines, no longer
hot-pathed for inline-CSS concerns. CSS bodies live in dedicated `.css`
files (read via `readFileSync` at module load) — Node ESM still bundles
them as zero-deps (no runtime npm packages), the IDE gets proper CSS
highlighting, and the backtick-in-CSS-comment bug class is eliminated.

**Still-active large files:**
- `bin/aeo-tracker.js` — CLI orchestration; the obvious split is per-command
  modules under `lib/cli/`. Untouched in this pass.
- `lib/report/sections.js` — markdown section renderers. Splitting per
  function is feasible but each function is small (≤50 lines); the file
  is large because there are 30+ functions in one place.

---

### 2. ~~Funnel-stage tags are a feature with no way in~~ — RESOLVED 1.16.0

**Closed 2026-09-21** (`c985265`). The way in existed all along and was being
discarded: `init` classifies every question it selects
(`lib/init/research/classify-intent.js`) and threw the verdict away, so the
by-tag section — shipped in v0.4 — had never rendered in any run anywhere.

The authoring question the entry left open answered itself once that was seen.
No new prompt, no new call, no new required question, so `init` stays never-fail:
both config writers now stamp the class they already computed, via
`stampQueryAxes` (`lib/config/queries-normalize.js`). Keyed by query TEXT, not
position — validator-recovery substitutes a blocked question by text, after which
the positional intent array describes a basket that no longer exists. A question
the classifier declined to place stays a bare string, so a config of plain
strings is byte-identical to what earlier versions wrote and runs untouched.

One thing changed beyond wiring: the section no longer claims to measure a
funnel. What we compute is the intent of each question
(`comparison` / `problem` / `commercial` / `informational` / `vertical`), and the
default blurb went further and read a "high ToFu, zero BoFu" story out of it.
Mapping intents onto a funnel model is a judgement about someone's market;
printing it beside real percentages presents that judgement as measurement
(maintainer ruling, same day). Heading, card label, both blurbs, the run's
terminal line and three comments inlined into the client HTML via `styles.css`
now say what they count.

**Known limit, not debt:** `brainstorm.js` narrowed `INTENT_BUCKETS` to
`['commercial']` on purpose, so across the 14 configs on disk (284 questions) the
breakdown skews heavily commercial — roughly a fifth of a basket lands in
`vertical` / `informational` / `comparison`. The section earns its place on that
fifth. The Polish superlative gap noted here when this entry was written
(`najlepsza`, the feminine form real client baskets use, matched nothing) was
closed later in the SAME release by `e52893a`, together with the language-tag
and Cyrillic-boundary defects found alongside it — see the 1.16.0 changelog.

## Recently resolved (2026-05 editorial redesign)

- ✓ Tailwind palette in `sectionOutreachTemplates` — moved to `.outreach-*` CSS
- ✓ Tailwind palette in `sectionAuthorityPresence` — moved to `.auth-badge[data-tone]`
- ✓ Tailwind palette in `sectionAdsDetection` — moved to `.ads-sample` CSS
- ✓ Tailwind palette in `sectionHistoricalTrend` — moved to `.trend-*` CSS
- ✓ Tailwind palette in `sectionCrawlability` — moved to `.crawl-badge[data-tone]` /
  `.file-check[data-tone]`, ACCESS_BADGE reduced to `{tone, icon, label}`
- ✓ Tailwind palette in `sectionCompetitorIntelligence` — moved to `.cintel-*` /
  `.cell-badge[data-tone]` CSS; gradient header swapped for `--editor` token
- ✓ Tailwind palette in `sectionSentiment` — SENTIMENT_BADGE reduced to
  `{tone, icon, label}`; badge bound via `.cell-badge[data-tone]`; confidence
  flag → `.sent-conf`
- ✓ Tailwind palette in `sectionDomainShareOfVoice` — `.share-bar` primitive
  with `--bar-w` width hook
- ✓ Tailwind palette in `sectionCompetitorRadar` — `.radar-grid` / `.radar-card`
  / `.radar-card-name` / `.radar-card-meta` driven by `data-tone="you|competitor"`,
  radar SVG inherits via `currentColor`
- ✓ Tailwind palette in `sectionDomainCategories` — muted "+N more" via `.dom-more`
- ✓ Tailwind palette in the intent breakdown (`sectionFunnelBreakdown`) —
  `.share-bar[data-tone]` + `.rate-text[data-tone]`
- ✓ Tailwind palette in `sectionActionableGaps` — competitor chips use
  `.cell-badge[data-tone="bad"]`
- ✓ Tailwind palette in `sectionGeoComparison` — `.geo-table` / `.geo-cell[data-tone]`
- ✓ Tailwind palette in `sectionUnifiedVisibilityIndex` — `.score-block` hero
  + `.share-bar[data-tone]` rows
- ✓ Tailwind palette in `sectionDiscoverability` — `.score-block.score-block-row`
  variant + `.score-block-body-*`
- ✓ Tailwind palette in `sectionTopicClusters` — `.rate-text[data-tone]`
- ✓ All inline `style="font-size:..."` in legacy MD-generation functions
  removed; tips list bound to `.auth-tips`. `npm run test:design-lint`
  reports 16/16 passing, 0 soft-warn.
- ✓ `lib/report/html.js` shrunk from 3900+ to ~1380 lines — CSS body
  extracted to `lib/report/styles.css`
- ✓ `lib/report/mc-bridge.js` shrunk from 2340+ to ~395 lines — CSS body
  extracted to `lib/report/mc-bridge.css`
- ✓ Backtick-in-CSS-comment bug class eliminated — CSS no longer lives in
  a template literal, so the parser never sees it as JS
- ✓ Bridge card own colour tokens — now inherits report `:root`
- ✓ `<details>` collapsible Outreach drafts — rendered static
- ✓ Two backtick-inside-CSS-comment bugs — `test/design-lint.test.js` now guards
- ✓ Magic numbers in `radarStatsForBrand` — named as `RANK_DECAY_PER_POSITION`,
  `MENTION_SCORE_PER_HIT`, `SENTIMENT_NEUTRAL_FALLBACK`
- ✓ Silent `catch {}` blocks — annotated with intent comments (no behaviour change)
- ✓ JSDoc added to `sectionOutreachTemplates`, `sectionAuthorityPresence`,
  `sectionAdsDetection`
- ✓ Border-radius tokens consolidated — `--r-xs` / `--r-sm` / `--r-md` / `--r-lg`
- ✓ Inline `font-size` in cell HTML (cost row, big-num) — moved to CSS classes
  and `data-size` attribute
