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

### 2. Funnel-stage tags are a feature with no way in

**Source:** found 2026-09-21 while wiring `sectionFunnelBreakdown` into the HTML
page. The section now renders there (maintainer approved it from a sample the
same day) and its white-label wording is fixed — what remains is that nothing
can produce the data it needs.

**Scope.** `sectionFunnelBreakdown` (`lib/report/sections.js`) groups visibility
by funnel stage and renders only for cells carrying a `tag`. Tags reach a cell
from the `{q, tag}` query form in `.aeo-tracker.json`, supported by
`normalizeQueries` since v0.4. Nothing produces that form:

- `init` writes queries as plain strings (`queries: allFive.map(c => c.text)`);
- `--help` does not mention tags;
- README does not mention tags;
- zero stored runs carry one — checked across every run tree on disk.

So the section is reachable only by hand-editing the config after reading the
source. Every surface now renders it — markdown in both modes, and the HTML page
— and every surface renders it as nothing.

**Already fixed, so it does not have to be remembered later.** The blurb had two
things a white-label deliverable must not carry: it read the table for the
client ("high ToFu, zero BoFu — means AI knows your category but not why to
choose you") and named our config file. Both are now withheld under
`--white-label` from one builder, and the table itself stays in both modes. That
leak existed in the markdown white-label renderer already and had simply never
fired, because no run could trigger the section — it is closed before tags make
it reachable rather than after.

**What is left, and why it is one entry rather than a ticket saying "add tags".**
The remaining decision is how a tag gets authored, and it has a hard constraint:
`init` must stay never-fail, so it cannot grow a new required question. The
plausible routes — a rule over the query wording, an LLM label in a call `init`
already makes, or an optional prompt — differ in cost and in how wrong they can
be, and an existing config of plain strings has to keep working untouched.

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
- ✓ Tailwind palette in `sectionFunnelBreakdown` — `.share-bar[data-tone]` +
  `.rate-text[data-tone]`
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
