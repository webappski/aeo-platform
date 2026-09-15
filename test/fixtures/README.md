# Test fixtures

This directory holds two kinds of fixtures:

1. **Top-level files** (`q2-gemini-unverified-retailers.json`, `gemini-q2-voice-checkout-excerpt.txt`) — historical real-response pins for specific parser/extractor regressions. Documented inline where they're consumed.
2. **Sub-directories** — synthetic snapshots and inputs used by the E2E CLI suite under `test/e2e/`.

## Sub-directory inventory (E2E)

| Path | Purpose |
|---|---|
| `aeo-responses/stable/` | Healthy replay snapshot — 9 raw provider responses (3 queries × 3 providers) + `_summary.json`. `TestBrand` is mentioned in some cells, not in others — produces a non-trivial score. Ships BOTH `q{N}-openai-gpt-5-search-api.json` (historical provenance) AND `q{N}-openai-gpt-5.json` (byte-identical copy — see "OpenAI model-name duplicates" below). |
| `aeo-responses/regression/` | Same raw files as `stable/`, but `_summary.json.score` bumped to 80 to simulate a baseline that a fresh run (producing 50) regresses against. Same gpt-5 duplicate convention. |
| `aeo-responses/all-invisible/` | 9 raw responses with the brand name scrubbed — competitors only. Drives the "score 0, all-no" path (exit 2). Same gpt-5 duplicate convention. |
| `aeo-responses/all-errored/` | Historical variant from Phase 1. **DEPRECATED** for the exit-3 contract — see `malformed/` below. Retained for reference; new tests should not depend on it. |
| `aeo-responses/malformed/` | 3 files containing literally invalid JSON (`not-json-at-all`). Drives the canonical exit-code-3 path: `_tryReplay` (`bin/aeo-tracker.js:295-310`) swallows the SyntaxError, returns null, caller falls through to live `provider.call(...)`, fake `OPENAI_API_KEY` returns 401 (or `--network none` returns DNS error — either way the per-cell catch fires), `mention='error'` for every cell, `errors === results.length` → exit 3. Trace verified in Phase 0 manual gate 2026-05-20. |
| `manual-paste/` | `q1.txt` / `q2.txt` / `q3.txt` — plausible AI-engine outputs in the format a user would paste from a browser-only engine (Perplexity Pro, Claude.ai, etc). |
| `diff-pair/` | `yesterday-summary.json` / `today-summary.json` — minimal `_summary` pair (score 40 → 50) for the `diff` command. |
| `access-logs/sample.log` | ≥50 lines of Combined Log Format mixing AI bot UAs (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bytespider, Applebot) with human UAs (Mozilla / Safari / Chrome / Firefox / mobile). Drives `lib/report/log-parser.js`. |

## OpenAI model-name duplicates (gpt-5-search-api vs gpt-5)

Each healthy variant (`stable/`, `regression/`, `all-invisible/`) ships TWO byte-identical copies of every OpenAI fixture file:

- `q{N}-openai-gpt-5-search-api.json` — historical filename, matches founder's production model selection.
- `q{N}-openai-gpt-5.json` — byte-identical duplicate, lets the E2E suite configure `providers.openai.model = "gpt-5"` without triggering the scheduler's 60 s/test pacing stall.

**Why both:** `lib/util/scheduler.js::planSchedule` paces any model with TPM ≤ 6000 across 60 s windows. `gpt-5-search-api` is 6 k TPM (`lib/providers/rate-limits.js:18`); `gpt-5` is 90 k TPM (line 21). Phase 2 first attempt configured `gpt-5-search-api` in tests → every 3-query test stalled 60 s under the scheduler even in replay mode (PITFALLS 2026-05-19 entry 5). The byte-identical duplicate lets tests configure `gpt-5` while keeping the original-name fixture available for any future smoke pass that wants to recreate production conditions.

**Why byte-identical and not a separate response shape:** `_extractFromRaw` (`bin/aeo-tracker.js:257-293`) reads only `choices[0].message.content` and `annotations[].url_citation.url` — it ignores the `model` field inside the JSON body. So the same bytes work under either filename.

When you need to regenerate either name, regen both with `cp`. Keep them in lockstep.

## Provenance

- **Initial seed (2026-05-19):** synthetic. The real `aeo-responses/2026-05-13/` snapshot was ~250 KB total — 10× over the ≤50 KB budget for the E2E tree. Synthetic fixtures match the shape contracts in `bin/aeo-tracker.js::_extractFromRaw` (openai: `choices[0].message.content` + `annotations[].url_citation.url`; anthropic: `content[].text` + `content[].type === 'web_search_tool_result'`; gemini: `candidates[0].content.parts[].text` + `groundingMetadata.groundingChunks[].web.uri`).
- **Brand:** `TestBrand` / `testbrand.com` everywhere. Never a real brand — keeps these fixtures portable across owner audits.
- **Competitors:** `CompetitorA` / `CompetitorB`. Deliberately generic.

## Size budget

E2E fixture tree must stay ≤50 KB total (plan acceptance A). Run:

```bash
du -ch test/fixtures/aeo-responses test/fixtures/manual-paste test/fixtures/diff-pair test/fixtures/access-logs | tail -1
```

If over budget, trim raw responses — never trim `_summary.json` (downstream consumers read several keys).

## Regen instructions

These are static — they should not drift with real engine output changes (they're not pinning real engine behavior). Edit by hand. Keep `_extractFromRaw` shape requirements in mind when editing raw response files.

## What NOT to ship

The `test/` directory is excluded from the npm tarball by `package.json::files` (whitelist `bin/`, `lib/`, `examples/`, `README.md`, `CHANGELOG.md`, `LICENSE`). Verified by `npm run test:pack-files`.

---

## Historical top-level fixtures

The next section preserved verbatim from the prior README for the two top-level real-response files.

### When to rotate (historical pins)

Re-capture fixtures when any of these is true:

1. **Calendar drift** — fixtures older than ~6 weeks. Engine output style changes with model updates; stale fixtures test yesterday's behavior.
2. **New provider added** — capture a sample response from the new engine.
3. **Model upgrade** — provider bumped to a new model version.

### What NOT to do

- Don't hand-edit historical-pin fixture files to make tests pass — if an engine changed output, the fixture should reflect it. (This rule does NOT apply to the synthetic E2E sub-directories above.)
- Don't commit fixtures with PII or API keys — verify before copying.

---

## Real-run projections — `run-2026-08-27.trimmed.json`, `run-2026-08-31.trimmed.json`

Added 2026-09-15 with MEAS-1/2/3 (honest report). Unlike everything above, these
are **not synthetic**: they are projections of two real `_summary.json` files
from the webappski basket, kept because the comparison defect they pin was
produced by exactly this pair and a synthetic stand-in would prove nothing about
it.

- **Source:** `~/Projects/webappka/aeo-responses/webappski.com/{2026-08-27,2026-08-31}/_summary.json`
  (the same 08-31 file also exists byte-identically in a second tree — that fork
  is what `basketManifest.runRoot` exists to make visible). Each file records its
  own `_provenance`.
- **Reduction:** `results[]` keeps only `query, queryText, queryId, provider,
  model, mention, presence, trials, market` — every field `lib/score.js` and
  `lib/diff.js` read. Answer text, citations, competitors and costs are dropped,
  which is what keeps them small and keeps a client's answers out of the npm
  tarball.
- **Why they are load-bearing:** `test/honest-comparison.test.js` asserts that
  the 08-31 run still re-scores to the 13 it published, and that the 08-27 →
  08-31 pair yields 31 comparable questions, 19 with no baseline and 25 retired
  — so no overall score delta is reportable, only a like-for-like one.
- **Regenerate (never hand-edit):**

```bash
node scripts/trim-run-fixture.mjs <path-to>/_summary.json run-YYYY-MM-DD.trimmed
```

The published headline travels inside `_provenance.publishedHeadline` and is
asserted by the tests, so a bad regeneration fails loudly instead of quietly
moving a historical number.
