# Pivot — Run Comparison must scream, and must think in N runs, not 2

Written 2026-08-25, at the end of the session that shipped the "feature complete"
state recorded in `00-STATUS.md`. That work is NOT wasted — the data/logic layer is
solid and reusable — but the presentation is wrong and the scope was too narrow.
Read this file after `00-STATUS.md`; it supersedes that file's placement decision.

## What went wrong, plainly

The shipped `sectionRunComparison` is data-correct (verified against the real Gcore
pair) but visually it reads as "fine, nothing urgent" — it's the 2nd of 6 quiet
bento sections, plain text with a few badges, easy to scroll past. A non-technical
manager should look at this report and instantly see "we are losing ground here,
press here." That instant read is missing.

**Root cause, found by re-reading the original designer handoff
(`~/Downloads/design_handoff_run_comparison/`) after the fact:** it already answered
this exact question, explicitly, as a first-class decision:

> Placement decision (already made — implement as-is): Two tabs, "Comparison"
> (default/primary) and "Latest snapshot" (secondary)... For a returning client
> (2+ runs), the comparison IS the primary content.
> — `README.md`, "Placement decision"

The 2026-08-24 session (before this one) explicitly overrode that, citing
`html.js:22`'s comment that tabs were removed in 0.5.0 ("one production layout =
less surface area to maintain"). That's a real, documented engineering constraint —
but it was resolved in the direction of "keep the codebase simple" instead of "make
the client-decision-instrument obvious," and the design brief is unambiguous about
which one should win:

> This view is not a "what changed" readout. It is a decision-making instrument.
> — `aeo-platform-comparison-design-brief.md`, "The analytical job"

This session (2026-08-25) inherited that already-made deviation from `00-STATUS.md`
and continued building on top of it without re-checking it against the original
brief. That's the mistake to not repeat.

## The second thing: this was scoped too narrowly from the start

The design brief already asked for N-run thinking, not just prev-vs-current:

> Over time — "Are we trending the right way?" Design for N runs, not 2. After 6+
> monthly runs this should read as a trend, and the 2-run case should feel like a
> natural instance of that general design, not a special case that gets rebuilt later.
> — same brief, "The analytical job"

What shipped only computes and shows **the pair** (`snapshots[len-2]` vs
`snapshots[len-1]`). There is no "vs your first run," no "here's the overall
trajectory across all N runs," no per-question trend. The founder's read on this,
2026-08-25: a single point-in-time number (UVI 31) means very little on its own —
what a returning user actually wants is *where am I headed*, checked against both
the immediately preceding run and the very first baseline run.

## Requirements for the next session (verbatim intent, organized)

1. **Visual prominence, not just correct data.** Recreate the loudness of the
   original mock — color-coded segment grid (lost=red/held+gained=green/never=blue,
   NOT collapsed into one grey "meh" treatment), a delta pill next to the headline
   number, distinct callout cards for "never part of the conversation" and "all
   visibility concentrated in one place" findings, priority-labeled action cards.
   Exact colors/type/spacing/copy are all specified in
   `~/Downloads/design_handoff_run_comparison/README.md` (fully self-contained —
   don't need to open the broken `.dc.html` prototype to get exact values from it).

2. **Placement: resolve the tabs-vs-single-scroll tension for real, don't just
   re-litigate it once and move on.** Either bring back some form of primary/
   secondary view switching (the "removed in 0.5.0" constraint needs to be weighed
   against "the client can't find the one thing that matters"), or find a way to
   make a single-scroll section carry the same instant-read weight (e.g. it becomes
   the hero, not bento cell #2 of 6). The founder does not have a fixed answer here —
   research how comparable products solve "returning-user decision instrument vs.
   full-detail snapshot" (period-over-period dashboards, SEO/rank trackers, analytics
   tools) before deciding. This research was intentionally NOT done in this session
   (context budget) — do it in the new one.

3. **N-run dynamics, not just the latest pair.** The UVI (and ideally per-question
   visibility) should read against: (a) the immediately previous run, (b) the very
   first run ever recorded for this brand, and (c) the overall trajectory across all
   runs to date. `run-comparison.js`'s current `buildRunComparison(snapshots)` only
   uses `snapshots[len-2]`/`snapshots[len-1]` — this needs a sibling/extension that
   takes the FULL array and produces a first-run baseline + trend summary alongside
   the pairwise comparison it already does well. The existing pairwise logic
   (segments/drivers/noise-suppression/weight-basis-caveat) stays valid and should be
   reused, not rebuilt — it's tested and verified against real data.

4. **Always on, everywhere, no settings.** This must render automatically on EVERY
   report once 2+ runs exist for that domain — white-label and internal alike. No
   CLI flag, no opt-in. (The current code already does this correctly for
   `sectionRunComparison`'s markdown/HTML wiring — this requirement is really about
   not accidentally gating whatever N-run/prominent version replaces it. Flag it
   explicitly here so it isn't lost.)

5. **This is understood to be the first slice of a larger redesign.** The founder's
   longer-term intent is to move the whole AEO Platform report to the Webappski
   design system shown in the mock (Montserrat/mono-for-numbers, the `#F77300`
   accent, the semantic red/green/blue segment colors) — but NOT in this pass. Scope
   the next session to Run Comparison specifically; note the larger redesign as a
   known future direction so it isn't a surprise later, but don't attempt it now.

## What to reuse as-is (don't rebuild)

- `lib/report/comparison-segments.js`, `lib/report/comparison-drivers.js`,
  `lib/report/run-comparison.js` — the pairwise data/logic layer. Verified against
  real Gcore data (UVI 45→31, segments 4/1/2/11/0, sentiment like-for-like delta
  0.0). 42 passing tests across these + their test files.
- The jargon/tone contract (no "cell"/"extractor"/"pipeline"/"bug"/"fixed"/model
  names) — this was correct and matches the original brief's "Audience and tone"
  section verbatim. Keep enforcing it in whatever replaces the copy layer.
- `#comparison .cell { break-inside: auto; }` print-CSS fix, and the general lesson
  behind it: `mdToHtml` treats any line starting with `<` as raw HTML and skips
  ALL inline markdown processing for that line (bold, italic) — bit this session
  once already (the headline's `**45**` rendered as literal asterisks until the
  `<svg>` icon was moved to the end of the line instead of the start). Whatever new
  renderer gets built, watch for this again if it reuses `mdToHtml`.

## What to discard / reconsider

- `sectionRunComparison`'s current presentation (plain paragraphs + `.cell-badge`
  pills inside a single bento cell) — visually too quiet for a decision instrument.
  Keep the COPY LOGIC (driver narrative, stable-state heuristic, gain-drag
  pluralisation, query-grouping) as reference for tone even if the markup around it
  is rebuilt from scratch in a louder visual language.
- The "no tabs" decision in `00-STATUS.md` — re-examine, don't just inherit.
- The 2-run-only scope — extend to N-run per requirement 3 above.

## Reference files (read in this order in the new session)

1. This file.
2. `~/Downloads/design_handoff_run_comparison/README.md` — exact colors, type,
   spacing, copy, the tabs/placement decision and its reasoning, how it scales to N.
3. `~/Downloads/design_handoff_run_comparison/aeo-platform-comparison-design-brief.md`
   — the original product brief (the "analytical job", audience/tone, the N-run
   requirement, in the words that framed the mock).
4. `~/Downloads/design_handoff_run_comparison/gcore-aeo-run-data.json` /
   `.md` — real reference data, including a precomputed `comparison` block.
5. `00-STATUS.md` — what shipped 2026-08-25 (data layer + first presentation pass),
   including the "Decisions taken that deviate from the designer's handoff" section
   this file is directly pushing back on.
6. `01-report-model-and-uvi.md`, `02-html-render-pipeline.md` — still-valid
   technical maps of snapshot loading, the UVI API, `html.js`'s render pipeline,
   white-label surfaces, design tokens, the print block.

## Explicit next steps

1. Research best-practice UX patterns for period-over-period / trend reporting in
   analytics-style products (this was intentionally deferred to keep this session's
   context budget for the write-up, not because it isn't wanted).
2. Decide placement (tabs-back vs. single-scroll-hero vs. something else) with that
   research + the constraints above, and write the reasoning down — the original
   brief explicitly asked for a justified decision, not a default.
3. Extend the data layer for N-run trend (first-run baseline, full trajectory)
   alongside the existing, tested pairwise comparison.
4. Redesign the presentation for visual prominence, recreating the mock's specific
   colors/type/spacing/copy per its README, adapted to whatever placement is chosen.
5. Confirm always-on behavior (every report, 2+ runs, no settings) holds for
   whatever replaces the current wiring.
6. Get the founder's visual sign-off before considering this done — the whole
   reason this pivot happened is that "tests pass" was not sufficient signal that
   the feature actually works for a human reader.
