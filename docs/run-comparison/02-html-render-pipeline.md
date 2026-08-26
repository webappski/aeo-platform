# Technical map 2 — `lib/report/html.js` + `styles.css` render pipeline

Source: codebase exploration of `aeo-platform` v1.7.4. `html.js` = 1816 lines, `styles.css` = 3569 lines.

**Upfront:** `html.js` is *not* the whole renderer. The big report body lives in `lib/report/sections.js` (144 KB, markdown-emitting), piped through `mdToHtml()` into `.md-block` panels.

## ⚠️ Tabs were deliberately REMOVED — `html.js:22`

```
 * Tab-based v0.4 layout and v0.3 monolithic scroll are removed in 0.5.0.
 * One production layout = less surface area to maintain.
```

Re-adding a tab layout goes against a documented architectural decision. Combined with the print constraint (§7), a hidden tab pane is invisible in Save-as-PDF — which is the primary client-delivery path. **Prefer a top-level section in the single scroll.**

Related house position — `sections.js:1288`: `export const TREND_MIN_RUNS = 4`, and `sectionHistoricalTrend` refuses to draw a trend below 4 runs (`sections.js:1324`), on the grounds that *"2 points connected by a line are noise"*. Align any 2-run comparison copy with that.

## 1. Entry point

`lib/report/html.js:406` — the only export:
```js
396  * @param {Object} summary    SummaryJSON (from buildHtmlSummary)
397  * @param {Object[]} [snapshots]
398  * @param {Object} [opts]
403  export function renderHtml(summary, snapshots = null, opts = {}) {
```
JSDoc is incomplete. **Actual `opts` keys read inside:** `mcMetadata`, `daysSinceRun`, `noMcBlock`, `public`, `whiteLabel`, `reportTitle`, `pkgVersion`, `repoUrl`, `bridgePricing`.

Call site — `bin/aeo-tracker.js:4385-4396`.

**For a comparison feature:** `snapshots` is the **full array of prior run objects** (`snapshots[snapshots.length - 1]` is latest — `html.js:419`). `snapshots.length > 1` is the "previous run exists" gate. `summary.meta.prevDate` / `summary.scorePrev` are non-null only when a prev run exists.

## 2. Document skeleton

One `return` of a single template literal, `html.js:1578` → `1709`:
```
1578  return `<!doctype html>
1579  <html lang="en">
1580  <head>
1583  <title>${docTitle}</title>
1584  <style>${css}</style>
1585  </head>
1586  <body>
1587  <main class="page">
```

Order inside `<main class="page">`:

| Lines | Block |
|---|---|
| 1589-1614 | `<header class="mast">` — masthead |
| 1616-1619 | `${railHtml ? '<nav class="rail" …>' : ''}` — sticky section nav |
| 1621-1671 | `<section class="hero">` |
| 1673 | `${mcBridgeMarkup}` — Mission Control bridge |
| **1675-1677** | **`<div class="layout"><div class="content">${sectionsHtml}</div></div>`** ← the 6 bento sections |
| 1679-1698 | `<footer class="colophon">` |
| 1702-1708 | `</main>` + `<script>${RENDER_INLINE_JS}${mcBridgeBootstrap}</script>` |

**CSS is fully inlined** in one `<style>` block. Assembly at `html.js:559-561`:
```js
559  let css = getFontFaceCss() + '\n' + renderCss()
560    + (mcBridgeMarkup ? bridgeCss : '')
561    + (whiteLabel ? WHITE_LABEL_CSS : '');
```
- `renderCss()` (`html.js:1813-1815`) returns `STYLES_CSS`, read **once at module load** (`html.js:1810-1811`) via `readFileSync` of `lib/report/styles.css`.
- `bridgeCss` = `lib/report/mc-bridge.css`, same mechanism (`mc-bridge.js:40`).

**Fonts:** `getFontFaceCss()` from `lib/report/fonts/index.js:47`. Three variable woff2 (Fraunces / Geist / JetBrains Mono) bundled locally, base64-inlined as `@font-face`, cached in module-level `_cached`. **No CDN.** ~170 KB per report.

## 3. Section composition

**Pattern: array-of-descriptors + `.map().join()`.** No registry, no plugin table.

**Step A — cells accumulators.** Six `const …Cells = []`, populated by `.push(\`<article class="cell span-N …">…</article>\`)` guarded by `if (data)`:

| Line | Array | Push sites |
|---|---|---|
| 601 | `heroKpiCells` | 603, 635, 664 |
| 689 | `overviewCells` | 695, 727, 764, 817 |
| 836 | `visibilityCells` | 851, 1019, 1061, 1079 |
| 1090 | `competitorsCells` | 1107, 1151 |
| 1174 | `citationsCells` | 1227, 1290, 1302 |
| 1310 | `actionsCells` | 1338 |
| 1350 | `diagnosticsCells` | 1369, … |

**Step B — `SECTIONS` descriptor array, `html.js:1497-1521`.** Two variants (white-label drops "Actions" and renumbers 01-05):
```js
1497  const SECTIONS = whiteLabel ? [
1498    { id: 'overview', num: '01', label: 'Overview', subtitle: 'where the score is heading', cells: overviewCells, emptyMsg: '…' },
      …
1508  ] : [
1509    { id: 'overview', num: '01', … },
      …
1519    { id: 'diagnostics', num: '06', label: 'Diagnostics', subtitle: 'site readiness, cost, ads', cells: diagnosticsCells },
1521  ];
```

**Step C — header + join, `html.js:1527-1558`:**
```js
1527  const sectionOverline = (idx) => { … };   // <header class="section-overline"> .so-numeral/.so-kicker/.so-question/.so-handoff
1548  const sectionPlaceholder = (msg) => `<article class="cell span-6 cell-empty">${esc(msg)}</article>`;
1551  const sectionsHtml = SECTIONS.map((s, idx) => {
1552    const overline = sectionOverline(idx);
1553    if (s.cells.length === 0) {
1554      if (!s.emptyMsg) return '';
1555      return `<section id="${s.id}" class="bento">${overline}${sectionPlaceholder(s.emptyMsg)}</section>`;
1556    }
1557    return `<section id="${s.id}" class="bento">${overline}${s.cells.join('')}</section>`;
1558  }).filter(Boolean).join('\n');
```

**Step D — rail nav derived from the same array, `html.js:1561-1564`.**

### Where to insert a new top-level block

- **A — sibling of `.layout`**, between `${mcBridgeMarkup}` (1673) and `<div class="layout">` (1675), or between `</div></div>` (1677) and `<footer>` (1679). Cleanest for a whole panel that is *not* part of the bento chain.
- **B — a 7th `SECTIONS` entry** (both branches, 1497 and 1508). Gets the numbered overline, rail link, and empty-state placeholder for free. But `num` is a hardcoded string and `.so-handoff` says "next · NN label" — inserting mid-array shifts the narrative chain.

## 4. `esc()` / escaping

Canonical helper: **`lib/svg/tokens.js:77`**, re-exported via `lib/svg/index.js:8`, imported at `html.js:51`:
```js
77  export function esc(s) {
78    return String(s == null ? '' : s)
79      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
81      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
83  }
```
Escapes `& < > "`. **Does NOT escape `'`** — never use inside single-quoted HTML attributes. 79 call sites in `html.js`.

Mandated by `CODING_STANDARDS.md:77`: every `${...}` in `html.js` pulling from `summary.*` or user input must go through `esc()`.

**Do not confuse:**
- `escMd(s)` — `sections.js:37` — escapes only `& < >` (no `"`), for strings going into *markdown* that later flows through `mdToHtml`. Explicit carve-out: do NOT use for hostnames already from `new URL().hostname`.
- `escapeHtml` / `escapeHtmlIdempotent` / `escapeAttr` / `isSafeUrl` — `markdown-to-html.js:51/56/62/65`, internal to the converter.

Also mandated (`CODING_STANDARDS.md:33`): **no backticks and no literal `${` inside HTML/CSS/JS comments** in these template-literal files.

## 5. Existing interaction machinery — reuse, don't invent

### 5a. `.matrix-toggle` — the existing segmented control (closest match to tabs)

Markup `html.js:1023-1027`:
```html
<div class="matrix-toggle" role="group" aria-label="Matrix view">
  <button type="button" aria-pressed="true">Mention</button>
  <button type="button" aria-pressed="false">Position</button>
  <button type="button" aria-pressed="false">Sentiment</button>
</div>
```
Target `html.js:1031`: `<div class="matrix-grid" data-view="mention" …>`

JS — delegated listener, `html.js:1755-1770` inside `RENDER_INLINE_JS`. **Smell:** active view derived from `btn.textContent` with a hardcoded allowlist. For new UI use `data-tab="…"` instead.

CSS `styles.css:1326-1357` — already underline-style tabs; active state is `button[aria-pressed="true"] { color: var(--editor); border-bottom-color: var(--editor); font-weight: 600; }`.

**Pure-CSS view switching via data attribute, `styles.css:1528-1530`:**
```css
.matrix-grid[data-view="mention"]   .mx-c .mx-v-mention,
.matrix-grid[data-view="position"]  .mx-c .mx-v-position,
.matrix-grid[data-view="sentiment"] .mx-c .mx-v-sentiment { display: inline-flex; }
```
Sibling-selector variant at `styles.css:1783-1785`. **This is the idiom to copy for any pane switching.**

### 5b. `.rail` — sticky top nav (CSS already calls it a tab bar)

`styles.css:770` — `/* ─── Section tab bar (sticky, prominent) ──── */`. `position: sticky; top: 0; z-index: 50; display: flex;` + `backdrop-filter: blur(6px)`, `overflow-x: auto`, animated `::before` underline (820-838), active `.rail a.active`. Markup `html.js:1616-1619`. Scroll-spy JS `html.js:1741-1753` (IntersectionObserver, `rootMargin: '-30% 0px -60% 0px'`). Mixing a real tab into it will fight the observer.

### 5c. `<details>` accordions — two established variants

- **`.mx-reveal`** — verbatim-answer accordion. Markup `html.js:936-943`; CSS `styles.css:3480-3510` (custom `▸`/`▾` via `summary::before`, `::-webkit-details-marker{display:none}`).
- **`.uvi-breakdown` / `--hero`** — "How is this calculated?" popover, built by `renderUVIBreakdownPopover()` (`sections.js:2119`); CSS `styles.css:3208-3287` and `3288-3405`.

### 5d. Inline `<script>` — exactly one, `html.js:1704-1707`

`RENDER_INLINE_JS` is a module-level template literal at `html.js:1714-1812`: ~4 IIFEs of ES5-flavoured vanilla JS, no framework, `var` in places, guards for `matchMedia`/`IntersectionObserver`:
1. Hero counter (`#heroNum`), respects `prefers-reduced-motion`.
2. Scroll-spy for `.rail a[href^="#"]`.
3. Matrix sub-toggle.
4. **Print handler, `html.js:1774-1806`** — `beforeprint`/`afterprint` + `matchMedia('print')` fallback, force-opens all `.mx-reveal`. **Any collapsible/hidden UI must register here or Save-as-PDF silently drops it.**

**Append new JS to `RENDER_INLINE_JS`. Do not add a second `<script>` tag.**

## 6. White-label handling

Flags: `bin/aeo-tracker.js:5206-5209` (`--white-label` boolean, `--report-title` string, ignored unless white-label). `bin:4323-4325`:
```js
const whiteLabel = args.whiteLabel === true;
const publicMode = args.public === true || whiteLabel;
const skipMcBlock = args.noMcBlock === true || whiteLabel;
```
Inside `renderHtml` — `html.js:417-418`.

**Every branding surface:**

| Line | Surface | Behaviour |
|---|---|---|
| 1571-1576 | `<title>` | `wlTitle = opts.reportTitle?.trim() \|\| 'AEO Visibility Snapshot — {domain} · {date}'`; non-WL uses `AEO Visibility · {brand} · {date}` |
| 1592 | Masthead wordmark | `${whiteLabel ? '' : '<div class="mast-mark">…<strong>aeo-platform</strong>…'}` |
| 1606-1613 | Masthead disclaimer | IIFE swaps "API surface (your keys)" jargon in **both** visible text and `title=` |
| 1683-1697 | Colophon | WL → `whiteLabelMethodologyText(latest)` + date/runId only; non-WL → `aeo-platform · v… · repo link` |
| 1497-1521 | `SECTIONS` | WL branch **drops the Actions section entirely**, renumbers 01-05 |
| 528 | `actionPlan` | `whiteLabel ? [] : assignDays(...)` |
| 382-392 | `whiteLabelMethodologyText(latest)` | data-derived neutral methodology note |
| 244-293 | `narrativeFor({…, whiteLabel})` | separate hero copy branch |
| 367-376 | `WHITE_LABEL_CSS` | appended only in WL: `.colophon-method`, `@page{margin:14mm}`, print rules |
| **561-568** | **comment strip** | `if (whiteLabel) css = css.replace(/\/\*[\s\S]*?\*\//g, '')` — strips **all** CSS comments so internals can't be grepped |
| **569-582** | **outreach strip** | `css.replace(/(?:^\|\n)\s*\.outreach[^{}]*\{[^}]*\}/g, '')` + empty-`@media` cleanup — **they strip by selector NAME** |
| `bin:4392-4393` | version/repo | `pkgVersion: whiteLabel ? null : …, repoUrl: whiteLabel ? '' : …` |

Per-section gating in `sections.js`: 669, 848, 885, 900, 904, 1250, 1727.

**Consequences for new work.** White-label output must survive a whole-file fingerprint scrub (stated at `html.js:562-567`). So:
- put new CSS in `styles.css` (comments auto-stripped in WL), **not** a new inline block;
- no class name or copy may read as a tool/agency tell (the `.outreach` precedent shows stripping by selector name);
- decide whether the block appears in WL at all, and gate it in **both** `SECTIONS` branches if going that route;
- keep the default report's CSS **byte-identical** when not in WL (the "R39" invariant, `html.js:365`).

`test/html-render-smoke.js` asserts on `html.split('class="hero"')[1].split('class="promote"')[0]` (lines 178, 186, 199) — reordering top-level blocks can break it.

## 7. CSS conventions in `styles.css`

**Naming:** flat, lowercase, hyphenated. **No BEM, no utility framework.** Prefixed families: `mast-*`, `hero-*`, `rail-*`, `so-*`, `cell-*`, `mx-*`, `eng-*`, `chart-*`, `colophon-*`, `uvi-*`, `md-block`, `cintel-*`.
- **Variants are extra classes on `.cell`**, not modifiers: `.cell.span-2|span-3|span-4|span-6`, `.tall`, `.dominant`, `.dominant.editor`, `.quiet`, `.inset`, `.dark`, `.cell-empty` (874-923).
- **State is data attributes, not classes:** `[data-view]`, `[data-status]`, `[data-tone]`, `[data-bucket]`, `[data-size]`, `[data-view-show]`, `[data-sentiment-scored]`, plus `[aria-pressed="true"]`. **Follow this.**
- 88 banner comments `/* ─── Name ─── */`. Key offsets: 177 masthead, 333 hero, 770 section tab bar, 853 bento, 1141 big-num, 1238 engine cards, 1316 matrix, 1847 charts, 2239 action stack, 2428 historical trend, 3168 md-block, 3208 UVI popover, 3479 print, 3480 reveal, 3533 reduced-motion, 3544 responsive.

### Design tokens — full `:root` system at `styles.css:10-146`

- **Surfaces:** `--paper` `#FBF9F4`, `--paper-2` `#F3EFE5`, `--paper-3` `#ECE5D5`, `--raised` `#FFFFFF`, `--line` `#E2DCCB`, `--line-strong` `#C8C0AB`, `--line-soft` `#EFEBDF`
- **Surface layers:** `--surface-page`, `--surface-cell`, `--surface-dominant` `#FBF6E8`, `--surface-quiet`, `--surface-inset` `#F7F2E4`, `--lede-bg`
- **Ink:** `--ink` `#1A1610`, `--ink-2` `#3D372C`, `--ink-3` `#6F6759`, `--ink-4` `#9A9385`
- **Accent (orange):** `--accent` `#B85C16`, `--accent-deep`, `--accent-soft`, `--accent-tint`, `--accent-ink`
- **Editor (blue, secondary):** `--editor` `#284B70`, `--editor-deep`, `--editor-soft`, `--editor-tint`, `--editor-ink` — comment at :46-49 says use it for **"data context"** rather than "brand action". *A comparison view is data context → use `--editor`.*
- **Clay (third):** `--clay`, `--clay-soft`, `--clay-tint`
- **Engines:** `--eng-gpt` `#2F8F66`, `--eng-gem` `#2C6BC9`, `--eng-cla` `#7C4FC9`, `--eng-perp` `#1A8A8E` (+ `-soft`)
- **Status:** `--good` `#1F7A3E`, `--bad` `#A8341E`, `--warn` `#A47214` (+ `-soft`)
- **Semantic data:** `--you` (= `--accent`), `--competitor` `#B45941`
- **Fonts:** `--display` Fraunces, `--sans` Geist, `--mono` JetBrains Mono
- **Type ramp:** `--t-display-1` 180px … `--t-display-6` 17px, `--t-overline` 10.5px, `--t-body` 14.5px, `--t-meta` 12.5px
- **Depth:** `--depth-1..3`, `--depth-edge-accent`, `--depth-edge-editor`
- **Motion:** `--motion-fast` 140ms, `--motion-base` 260ms, `--motion-slow` 520ms, `--ease-edit`, `--ease-emerge`
- **Radius:** `--r-xs` 4px, `--r-sm` 8px, `--r-md` 14px (cells), `--r-lg` 20px (hero)
- **Texture:** `--paper-grain` (inline SVG feTurbulence data-URI on `body::before`, opacity 0.045)
- **Legacy aliases (132-145)** for mc-bridge: `--bg`, `--bg-raised`, `--bg-subtle`, `--border`, `--border-strong`, `--font-mono`, `--pos`, `--neg`

**No spacing scale token exists** — paddings/gaps are hardcoded px. Don't invent one for a single feature.

### No dark mode
Zero `prefers-color-scheme` in `styles.css`. `.cell.dark` (917-925) is an inverted card variant, not a theme.

### Print block to respect — `styles.css:3512-3532`
```css
@media print {
  body { background: white; }
  body::before { display: none; }
  .rail { display: none; }
  .layout { grid-template-columns: 1fr; gap: 0; }
  .bento { grid-template-columns: 1fr 1fr; gap: 12px; }
  .cell.span-6 { grid-column: span 2; }
  .cell.span-4, .cell.span-3 { grid-column: span 2; }
  .promote, .hero { break-inside: avoid; }
  .cell { break-inside: avoid; }
  a { color: var(--ink); text-decoration: underline; }
  .mx-reveal { display: block; }
  .mx-reveal > .mx-reveal-body { display: block !important; }
  .mx-reveal-text { max-height: none; overflow: visible; }
}
```
**Any hidden pane must be force-shown here** (the `.mx-reveal` rules are the precedent), and its nav hidden like `.rail`.

Also: `styles.css:3533-3542` `@media (prefers-reduced-motion: reduce)` kills all transitions; `3545-3568` breakpoints at 1080px / 720px (plus 760px at :998, :2791).

Second print block in `html.js:369-375` (`WHITE_LABEL_CSS`), WL only.

## 8. Charts / SVG

Barrel `lib/svg/index.js`:
```js
export { heatmap, barchart, sparkline, deltaArrow, radar, combinedRadar, engineCards };
export { TOKENS, ENGINES, STATUS, trafficLight, FONT_SANS, FONT_MONO, esc } from './tokens.js';
```
Signatures:
```js
radar({ axes, size = 340 })                       // lib/svg/radar.js:15 — axes: {label,value}[], 0–100, min 3
combinedRadar({ userAxes, avgAxes, userLabel, avgLabel = 'Top-3 avg' })  // combined-radar.js:34
sparkline({ values, width = 92, height = 22, color })                     // sparkline.js:16
barchart({ items, maxBarWidth = 480, barHeight = 26, gap = 12, labelWidth = 220 })  // barchart.js:16
heatmap({ rows, cols, cells })                    // heatmap.js:16 — cells: 'yes'|'src'|'no'|'error'|'missing'
engineCards({ cards })                            // engineCards.js:21
deltaArrow({ value, size = 12 })                  // deltaArrow.js:7
```
**Caveat:** these emit standalone `<svg xmlns=…>` with **hardcoded HEX from `TOKENS`**, not CSS vars — deliberate (`tokens.js:6-9`: for markdown-embedded SVG where CSS vars don't apply). `html.js` imports only `radar` and `sparkline` (`html.js:52`); most in-HTML charts are built locally.

### The in-HTML line chart to copy: `buildTrendChart`

`html.js:324-361`, module-private:
```js
function buildTrendChart(values, dates) {
  const arr = (values || []).filter(v => typeof v === 'number');
  if (arr.length < 2) return '';
  const w = 460, h = 180, padX = 30, padY = 30;
  const min = 0;
  const max = Math.max(100, ...arr);
  …
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grids}${baseline}<path class="chart-fill" d="${fillPath}"/><path class="chart-line" d="${linePath}"/>${dots}${anno}${xAxis}</svg>`;
}
```
Called with `(summary.trend, summary.trendDates)`. Its classes — `.chart`, `.chart-grid`, `.chart-baseline`, `.chart-axis`, `.chart-axis-baseline`, `.chart-fill`, `.chart-line`, `.chart-dot`, `.chart-leader`, `.chart-anno`, `.chart-anno-num`, `.chart-anno-label` — are styled from `styles.css:1847+` and **do** use CSS custom properties. To add a second series, extend or clone it.

Also: `miniDeltaPath(values)` at `html.js:305-321` — returns `{d, last:[x,y]}` for a 60×18 hero delta sparkline (last 5 values, min-max normalised).
