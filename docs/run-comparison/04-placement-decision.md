# Placement decision — no tabs, promote to hero

Written 2026-08-25, in the session opened by `HANDOFF-PROMPT-v2.md`. This
supersedes `00-STATUS.md`'s "Decisions taken that deviate from the designer's
handoff" §1 by re-examining it explicitly, as `03-visual-prominence-pivot.md`
required, instead of re-inheriting it silently.

## The question

Designer handoff (`~/Downloads/design_handoff_run_comparison/README.md`) mandates
two tabs, "Comparison" (default) and "Latest snapshot" (secondary), with the
comparison as primary content for a returning client. The 2026-08-24 session
overrode this to "no tabs, one more bento section" citing `html.js:22`
("Tab-based v0.4 layout ... removed in 0.5.0. One production layout = less
surface area to maintain"). `03-visual-prominence-pivot.md` flagged that override
as the likely root cause of the section reading as forgettable.

## Research (timeboxed, one pass)

Looked at how comparable products handle "returning-user decision instrument vs.
full-detail snapshot":

- **GA4 Compare mode** (Dec 2025 update): comparison is a toggle *inside* the
  existing report, not a separate tab/pane. Turning it on overlays the delta
  directly on the primary metrics the user is already looking at — no navigation
  away from the primary view is needed to see period-over-period movement.
- **SEO rank trackers (Semrush/Ahrefs-class tools)**: "gained/lost" positions and
  competitor movement are treated as a first-class, always-visible dashboard
  metric, not something tucked behind a secondary view — the whole point of a
  tracking dashboard is that the *change* is the headline, and the current
  snapshot is supporting detail reachable from there.

Consistent pattern across both: for a returning user, the comparison is surfaced
in-line, at the top, without requiring a click to reach it. Nobody hides the
delta behind a tab the user has to discover.

## Decision: no tabs, but promote to hero position

Two changes to what shipped 2026-08-25:

1. **No tabs.** Confirms the 2026-08-24 call, for a stronger reason than "less
   surface area to maintain": white-label delivery's primary path is Save-as-PDF
   (`00-STATUS.md`, print block notes). A hidden tab pane does not exist in a
   PDF — content the client needs is invisible unless every tab happens to be
   the one open at print time. Tabs are actively wrong for this delivery
   mechanism, not just extra maintenance surface.
2. **Promote out of bento-cell-#2-of-6 into the report's hero position.** This is
   the part the 2026-08-24 session got wrong: it kept the tabs decision but
   dropped the *reason* for it (comparison IS the primary content for a
   returning client) and let the section fall back to being one quiet card among
   six. The fix the research supports: comparison renders first, full-width,
   above the fold, in the loud visual language the mock specifies (color-coded
   segment grid, delta pill, callout cards) — not inside the existing
   `.layout` bento grid's normal-weight cell styling. The single-run snapshot
   content (existing Overview/Visibility/etc. sections) follows below, playing
   the "Latest snapshot" tab's role as supporting detail, reachable by scrolling
   instead of clicking.

This satisfies the brief's actual requirement ("for a returning client the
comparison IS the primary content", `aeo-platform-comparison-design-brief.md`)
without reintroducing the tab machinery removed in 0.5.0, and without the
print-invisibility failure mode tabs would reintroduce.

## What this means concretely

- `SECTIONS` entry for comparison moves to position 1 (before Overview) or
  becomes a distinct pre-`SECTIONS` hero block rendered outside the bento grid
  entirely — decide during implementation based on which reuses more of the
  existing rail-nav/overline machinery without fighting it. Either way it is
  visually distinct from a `.cell`: full container width, not a `span-N` bento
  cell sized like its siblings.
- On a first-run report (no comparison possible yet), nothing changes — Overview
  stays the first thing rendered, exactly as today.
- The "link the original mock" requirement (see `03-visual-prominence-pivot.md`
  req. 1) renders only on the internal report surface, not white-label — the mock
  lives at a local Downloads path on the founder's machine, which cannot appear
  in a client-facing deliverable. Flagging explicitly since the requirement said
  "top/bottom of report" without addressing white-label; resolved by omission on
  white-label rather than silently dropping it everywhere.
