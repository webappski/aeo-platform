# Run Comparison — build status & resume point

**2026-08-25: feature complete.** Orchestrator, HTML section, markdown section,
and the pre-declare-done scrub check (all four "Next steps" items from the
2026-08-24 pause) are done, tested, and verified against real data. Nothing is
committed — working tree only, per standing instruction (branch `master`).

## Goal

When a brand has 2+ runs, the report should answer on its own: is visibility up or down,
which lever moved it, where exactly ground was lost/held/gained/never held, who replaced
the brand where it dropped out, and what to do next. Client-facing deliverable — no
engineering language anywhere in rendered output.

## Done (working tree, all tests green — `npm test` exits 0)

| File | State |
|---|---|
| `lib/report/comparison-segments.js` | ✅ complete (from the 2026-08-24 session) |
| `lib/report/comparison-drivers.js` | ✅ complete (from the 2026-08-24 session) |
| `lib/report/run-comparison.js` (276 lines) | ✅ new — orchestrator, see below |
| `lib/report/sections.js` | ✅ modified — `sectionRunComparison` + 7 private `rc*` helpers added, inserted between `sectionDiff` and `sectionTrend` |
| `lib/report/markdown.js` | ✅ modified — `sectionRunComparison` registered in all 3 required lists (import, `renderMarkdown`, `renderWhiteLabelMarkdown`), right after `sectionDiff` in both arrays |
| `lib/report/html.js` | ✅ modified — new `SECTIONS` entry `{ id: 'comparison', num: '02', label: 'Run Comparison' }`, inserted right after Overview in both branches; everything after it renumbered |
| `lib/report/styles.css` | ✅ modified — one new rule `.cell-badge[data-tone="editor"]` (mirrors the existing good/bad/warn variants); one print-block addition `#comparison .cell { break-inside: auto; }` |
| `test/run-comparison.test.js` | ✅ new — 12 tests, orchestrator model |
| `test/section-run-comparison.test.js` | ✅ new — 7 tests, markdown copy layer (stable-state heuristic, plural agreement, query grouping, jargon scrub) |
| `package.json` | ✅ both new modules in `test:imports`; both new test files get `test:*` scripts + slots in the `test` chain (right after `test:comparison-drivers`) |

42/42 tests across the four Run Comparison files pass (10 + 13 + 12 + 7). Full
project `npm test` (the entire chain, ~101+ files) exits 0 — no regressions.

### What the two modules do

**`comparison-segments.js`** — splits every query×engine cell of a run pair into
`lost` / `held` / `gained` / `never` / `indeterminate`.

- `never` is deliberately its own segment: it is an absence, not a regression, and is
  usually the largest bucket. Collapsing it into "lost" is the easiest way to make a
  comparison report lie.
- `indeterminate` guards against a real incident: a run whose secondary extractor was
  broken produced six `error` cells; naively those read as six fresh losses.
- `cellKey` is `query::provider` — model is deliberately excluded, because providers
  hot-swap model versions between runs and keying on model reports every swap as a loss.
  (Matches `lib/diff.js`, which keys `query|provider` for the same reason.)
- `isIndeterminate` treats `error` and `missing` as not-comparable — identical to
  `isCoveredMention` at `lib/diff.js:23`.
- `findBlankQueries` lists queries with zero mentions in **both** runs plus the verified
  competitors occupying them. Only dual-model verified competitors are used.

**`comparison-drivers.js`** — causal decomposition of the index movement.

The core insight, and the reason this module exists: **the four UVI components are not
four independent levers.** Presence and Citation are measured across every cell;
Sentiment and Rank are averaged **only over cells where the brand appears**. So when the
brand drops out of answers, the conditional averages move on their own — the population
changed, not the surviving answers.

Every conditional component is split into:
- `likeForLike` — movement among cells present in both runs. A **real** signal.
- `compositionalDelta` — movement caused purely by which cells entered/left.
- `gainDrag` — newly gained cells that pulled the average down just by arriving.

`summarizeDrivers()` sets `allMovementIsCompositional` when the directly-measured
components moved and no conditional component shows a like-for-like change.

## Verified against real data (Gcore, 2026-06-17 → 2026-08-24)

`computeComponents` reproduces exactly: `28/100/43/6 → UVI 45` and `17/83/23/0 → UVI 31`.

Decomposition on that pair:
- Sentiment 100 → 83 read as the **largest** contributor (−4.25) in the designer's mock.
- **like-for-like delta = 0.0** — no surviving answer changed tone at all.
- The entire movement is one newly-gained Claude mention that was neutral/factual.
  The brand broke into a third engine — a win — and the index scored it as its worst decline.
- Rank: **zero cells were ranked in both runs** → like-for-like undefined, wholly compositional.
- Citation 6 → 0: the single citing cell (Q1×Gemini) was among the 4 lost.

Counterfactual: without that gained mention, UVI would read **33**, not 31. Gaining a
mention lowered the headline by 2 points. This is captured as a regression test in
`test/comparison-drivers.test.js`.

Segments for that pair: **4 lost, 1 held, 2 gained, 11 never, 0 indeterminate.**

## What landed this session (2026-08-25)

1. **`lib/report/run-comparison.js`** — orchestrator, `buildRunComparison(snapshots)`.
   Returns `null` below 2 runs; otherwise the pair is always `snapshots[len-2]` /
   `snapshots[len-1]` (correct under `--for-date` truncation — never a lookup against
   the newest run on disk). Returns
   `{ prevDate, currDate, uvi:{prev,curr,delta}, weightBasis:{changed,axes}, segments,
   counts, components, driverSummary, replacements, blankQueries }`.
   - `kind` (direct/conditional) per component is read off `computeUVIBreakdown().rows[].sample.basis`
     (`'cells'` = direct), not hardcoded.
   - Sentiment extractor **replicates** `computeComponents`'s private `isSignalBearingSentiment`
     gate (excludes `confidence:'failed'|'empty'` and the `low`+`neutral` tie-break) — without
     this, a tie-break cell averages into `likeForLike` as a fabricated 50 that the reported
     `prevValue`/`currValue` never included. Caught by an advisor review before it shipped.
   - **Weight-basis caveat, made load-bearing, not just detected:** when the measured-axis
     set differs between the two runs, `contributionDelta` is nulled on **every** axis (not
     just the shifted one — re-normalisation changes every axis's `appliedWeight`), so
     `summarizeDrivers` degrades to "no clear driver" instead of asserting a polluted causal
     claim. `weightBasis.changed` on the model is what the copy layer's caveat sentence reads.
   - `counts` is a **faithful mirror of `segments.*.length`** — a noisy `--samples N` flip
     (`isNoise: true`) stays counted in `counts.lost`/`counts.gained`; `counts.noiseSuppressed`
     surfaces the flagged count separately. Deliberately NOT subtracted — annotation is the
     orchestrator's job, suppression is a rendering policy (advisor caught an earlier draft
     that silently disagreed with `segments.*.length`).
   - Competitor substitution (`newEntrants`/`droppedOut`) computed per lost cell;
     `replacements` rolls up "who's filling the gap" across all of them, most-frequent first.
   - Verified end-to-end against the real Gcore pair (`~/Projects/autopro-service/aeo-responses/{2026-06-17,2026-08-24}/_summary.json`):
     reproduces UVI 45→31, segments 4/1/2/11/0, sentiment like-for-like delta 0.0,
     `driverSummary.allMovementIsCompositional === true` — exactly the reference values below.

2. **`sectionRunComparison(snapshots)`** in `sections.js` — the copy layer.
   Tone contract enforced (verified by a jargon-scrub regression test): no "cell",
   "extractor", "pipeline", "conditional", "compositional", "bug", "fixed", no model
   names. Leads with the causal narrative (where you appeared vs. anything getting
   worse), not a ranked list of four raw deltas. Weight-basis caveat, when present, is
   the LAST line of the body — never a badge next to the headline number.
   - Segment counts render via the **existing** `.cell-badge[data-tone]` component
     (already used by `sectionCompetitorIntelligence`/`sectionSentiment`) — lost→`bad`,
     held/gained→`good`, never→`editor` (new CSS variant, added to `styles.css`
     mirroring the existing good/bad/warn rules). No inline styles, no new hex.
   - "Stable" (calm "held steady") message fires only when `counts.lost === 0 &&
     counts.gained === 0 && !driverSummary.hasGenuineConditionalChange &&
     !weightBasis.changed` — NOT a naive `uvi.delta === 0` check, which would either
     miss real held-cell tone/rank movement or misfire on rounding noise. (First draft
     had the naive version; advisor caught it before it shipped.)
   - "Newly gained" groups by question so a mention landing on two engines for the
     same question reads as one item ("... on Gemini and Claude"), not two repeated lines.
   - Gain-drag narrative pluralises off the actual distinct cell count (`rcGainDragSubject`),
     not the number of axes touched — "a newly gained mention on Claude" (singular,
     names the engine) vs "2 newly gained mentions" (plural, when the drag comes from
     two different cells).

3. **HTML integration** — `sectionRunComparison` wired through the existing
   `sectionsRaw`/`wrapMd`/`S.*` idiom already used for `sectionUnifiedVisibilityIndex`
   etc. (`html.js:476-493`), NOT hand-built cells. Placed as a **new top-level `SECTIONS`
   entry** (not a sibling-of-`.layout` block, not tabs): `{ id: 'comparison', num: '02',
   label: 'Run Comparison', subtitle: 'what moved since last run, and why' }`, inserted
   right after Overview. Gets the numbered overline, rail-nav link, and empty-state
   placeholder mechanism for free — no hand-rolled infrastructure. **Section numbering
   shifted**: Overview stays 01; everything that used to be 02-06 (default) / 02-05
   (white-label) is now one higher. `sectionOverline`'s "next · NN label" handoff text is
   derived from the array itself, so this needed zero manual per-entry text updates.
   - Print: `.cell.span-6` + `.cell { break-inside: avoid }` (existing rule) would force
     this section's long single cell (headline + narrative + two tables + a list) onto
     one unbreakable box in Save-as-PDF. Added a scoped override,
     `#comparison .cell { break-inside: auto; }`, inside the existing `@media print`
     block — every other bento cell is short enough that `avoid` stays correct.

4. **Markdown registration** — `sectionRunComparison` added to all 3 required lists in
   `markdown.js` (import block, `renderMarkdown` array, `renderWhiteLabelMarkdown`
   array), positioned right after `sectionDiff` in both arrays (same "compare two runs"
   family; `sectionDiff` was already in both lists).

5. **Scrub check — done, against the real pair, both directions:**
   - Rendered a real report via `node bin/aeo-tracker.js report --white-label --no-open
     --no-authority --no-entity-graph --no-page-signals --no-pricing` from
     `~/Projects/autopro-service` (all optional fetch-heavy fields were already cached
     on both snapshots — zero live network/LLM calls; `args.whiteLabel` also
     unconditionally skips the paid `deriveActionsWithLLM` call, confirmed by reading
     `bin/aeo-tracker.js:4017`).
   - Mandated grep against the **rendered HTML** (not source):
     `grep -Eaic 'aeo-platform|@?webappski|mission control|mc-bridge|lib/[a-z]|session.?cost|generated by [a-z]|outreach|guest post|push for' report.html` → **0**.
   - Confirmed rail nav / section ids render in the new order (`01 Overview, 02 Run
     Comparison, 03 Visibility, 04 Competitors, 05 Citations, 06 Diagnostics` in
     white-label); confirmed the `data-tone="editor"` badge and its new CSS rule are
     both present in the inlined `<style>` block of the output HTML.

## Not done / deliberately out of scope this session

- **No CHANGELOG entry, no commit.** Working tree only — matches the explicit
  instruction ("Ничего не коммить без явной просьбы — ветка master"). Whoever commits
  this should add the CHANGELOG entry the "Decisions taken" section below asks for.
- **Global `aeo-platform` npm package still v1.5.0** (repo is v1.7.4). Flagged as
  optional cleanup in the original handoff; not touched — reinstalling a global package
  is a side-effecting action outside this session's scope.
- **`sectionDiff`/`sectionRunComparison` overlap not consolidated.** Both sections
  still coexist (adjacent in the report) rather than `sectionDiff` being refactored to
  import `lib/diff.js` per `01-report-model-and-uvi.md`'s "Duplication: cell-diff exists
  TWICE" finding — that refactor was already scoped as separate, pre-existing tech debt,
  not part of this feature.

## Decisions taken that deviate from the designer's handoff

Both are deliberate; note them in the CHANGELOG so the designer isn't surprised.

1. **No tabs.** `html.js:22` documents that the tab layout was removed in 0.5.0
   ("One production layout = less surface area to maintain"). A hidden tab pane is also
   invisible in Save-as-PDF, which is the primary client-delivery path. The comparison
   becomes a top-level section in the existing scroll instead.

2. **"What moved" is restructured**, against the handoff's "do not paraphrase headlines".
   The mock ranks the four components by |Δ| and concludes *"The decline is spread evenly
   across presence, sentiment and rank — no single lever explains it on its own."* On the
   real data that is the opposite of true: one root event explains all four, and leading
   with Sentiment would send a manager to commission reputation work against a tone problem
   that does not exist. Replaced with a causal split: directly-measured drivers first,
   conditional consequences second.

3. **No 2-point line chart.** `sections.js:1288` sets `TREND_MIN_RUNS = 4` on the stated
   grounds that "2 points connected by a line are noise". The mock's hero plots 2 points.
   Show the pair as before/after; let the line appear from run 4.

Also worth flagging to the designer: the mock's per-element inline styles and raw hex
(`#FF4D4F`, `#23AB0B`, `#1685D7`) cannot be ported verbatim — `test/design-lint.test.js`
hard-fails on inline `font-size` in `html.js`, and the house system has tokens for exactly
these roles (`--bad`, `--good`, `--editor`, `--warn`). Semantic mapping:
lost → `--bad`, held/gained → `--good`, never-present → `--editor` (the token comment at
`styles.css:46-49` reserves `--editor` for "data context", which is precisely this).

## Reference docs in this folder

- `01-report-model-and-uvi.md` — report model, snapshot loading, `visibility-index` API,
  per-cell shape, existing `lib/diff.js`, markdown section registration, test conventions.
- `02-html-render-pipeline.md` — `renderHtml` entry point, document skeleton, section
  composition, `esc()`, existing toggle/accordion machinery, white-label surfaces,
  design tokens, print block, chart helpers.

## Environment note

The globally installed `aeo-platform` is **v1.5.0** while this repo is **v1.7.4**. The repo
already contains the fix for the dead `gemini-2.5-flash` classify tier
(commit `df0de5a`, now `gemini-3.1-flash-lite`) that was hit manually during the Gcore run.
Worth reinstalling the global package from this source.

---

# SUPERSEDED IN PART — 2026-08-25, full-report loud redesign

The founder-approved full-report redesign (`AEO Report - Full Report Loud.dc.html`)
landed on top of this work. Trend became a property of **every** section rather than
a chapter of its own, so the placement decision recorded above changed. Nothing here
was deleted silently; this note records what was kept and what was replaced.

## Kept, unchanged — these are the data layer

| Module | Why it survived |
|---|---|
| `lib/report/comparison-segments.js` | The aggregate lost/held/gained/never split. Its binary `PRESENT_MENTIONS` (`yes` + `src`) is what the presence arithmetic depends on and must not change. |
| `lib/report/comparison-drivers.js` | The like-for-like / compositional / gain-drag decomposition. Nothing in the new design reproduces it. |
| `lib/report/run-comparison.js` | `buildRunComparison()` returns exactly the model the redesigned Overview needs (`uvi`, `segments`, `counts`, `components`, `driverSummary`, `weightBasis`, `replacements`). It is now called from `html.js` as the data source for the Overview blocks, and still from `sectionRunComparison`. |
| `sectionRunComparison()` in `sections.js` | Still registered in **markdown** (both surfaces). The markdown report keeps the causal narrative; only its HTML rendering changed. |
| All 42 tests across the four files | Unmodified and still green. |

## Replaced — rendering only

* **The standalone `comparison` HTML section is gone.** Its `SECTIONS` entry and the
  `comparisonCells` array were removed from `html.js`; the model it displayed now feeds
  the Overview blocks "The change this run", "Score over time" and "What moved the index".
  Section numbering shifts back down by one (Overview 01, Visibility 02, …).
* **The `#comparison .cell { break-inside: auto }` print rule** became the selector-neutral
  `.cell[data-paginate]`, applied to whichever cell is long enough to need it.

## Why a per-cell state ladder exists alongside `comparison-segments.js`

`segmentCells()` answers "how many cells changed hands" and treats a cited-only answer as
present — correct at that altitude, and load-bearing for the presence count. The
answer-by-answer section answers a narrower question per row, where "cited as a source" and
"named in the prose" are visibly different outcomes and a citation converting into a naming
is the single best thing that can happen. That finer ladder lives in
`lib/report/answer-history.js`; neither module should be rewritten into the other.

## New modules

`lib/report/trend-model.js` (significance, noise test, degradation ladder, coverage gate),
`lib/report/answer-history.js` (per-answer record), `lib/report/run-metrics.js` (the metric
set both surfaces read), `lib/report/loud.js` (render components). Tests:
`test/trend-model.test.js`, `test/answer-history.test.js`, `test/loud-components.test.js`,
`test/loud-degradation-ladder.test.js` — all registered in the `npm test` chain.

## Three deviations from the designer's handoff, recorded above, and where they stand now

1. **No tabs** — still true, and now also mandated by the redesign's own print constraints.
2. **"What moved" is causal, not a ranked list of four deltas** — still true; the redesigned
   Overview keeps the causal framing and adds the fixed-weight axis table beside it.
3. **No 2-point line chart** — now expressed as the degradation ladder: shapes appear at
   run 3, not run 4. The old `TREND_MIN_RUNS = 4` constant still guards the legacy bento
   placeholder cell; the ladder's own `SHAPES_MIN_RUNS = 3` governs the new blocks.
