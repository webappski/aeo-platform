# Technical map 1 — report model, snapshots, UVI internals, diff, tests

Source: codebase exploration of `aeo-platform` v1.7.4. All line numbers verified at time of writing.

## 0. Premise correction — there is no single shared "report model"

Two different seams:

- **Markdown** gets the **raw chronological snapshots array** — `bin/aeo-tracker.js:4349`
  ```js
  const md = renderMarkdown(snapshots, rawResponses, {
    mcMetadata, noMcBlock: skipMcBlock, public: publicMode,
    whiteLabel, reportTitle: args.reportTitle, responsesPath: latestDateDir,
  });
  ```
- **HTML** gets the flattened model **and** the snapshots array — `bin/aeo-tracker.js:4385-4396`
  ```js
  const html = renderHtml(
    buildHtmlSummary(snapshots, rawResponses),
    snapshots,
    { mcMetadata, daysSinceRun, noMcBlock: skipMcBlock, ... },
  );
  ```

`renderHtml(summary, snapshots = null, opts = {})` — `lib/report/html.js:406`. It re-derives its own `latest` at `html.js:418`.

**Consequence:** a markdown section receives full history for free and derives `prev` itself (house pattern). An HTML surface sees only what `buildHtmlSummary` pre-flattens — so an HTML-visible run-over-run field needs a new key in the return literal at `bin/aeo-tracker.js:3650-3709`, **or** can be read off the `snapshots` array `renderHtml` already receives as param 2 (which `html.js:418` already does).

## 1. `buildHtmlSummary`

**File:** `bin/aeo-tracker.js`, **signature line 3489**, range 3489–3710 (return literal 3650–3709). Not exported; module-private to the CLI.

```js
3489  function buildHtmlSummary(snapshots, rawResponses) {
3490    const latest = snapshots[snapshots.length - 1];
3491    const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
```

**With exactly ONE run, `prev === null`.** Downstream consumers are defensive:
```js
3654    prevDate: prev?.date || null,
3665    scorePrev: prev?.score ?? null,
```
Per-engine (3539-3544):
```js
3539    const prevPct = prev ? (function () {
3540      const pr = (prev.results || []).filter(r => r.provider === en.provider && r.model === en.model);
3541      const h = pr.filter(r => r.mention === 'yes' || r.mention === 'src').length;
3542      return pr.length ? Math.round((h / pr.length) * 100) : null;
3543    })() : null;
3544    const delta = prevPct == null ? null : pct - prevPct;
```
Citations (3636-3641) follow the same `prev ? … : null` shape.

`prevPct` can *also* be null when `prev` exists but that (provider, model) pair was absent — the same "not comparable" guard `lib/diff.js` enforces.

Consumer: `html.js:427` — `const scoreDelta = summary.scorePrev == null ? null : summary.score - summary.scorePrev;`

**Full returned key list (3650-3709):** `meta{brand,domain,date,prevDate,runId,queryCount,providerCount,measurement,measurementShort}`, `score`, `scorePrev`, `coverage`, `trend`, `trendDates`, `queries`, `queryTexts`, `engines`, `competitors`, `sources`, `positionMatrix`, `totalCitations`, `totalCitationsPrev`, `regionCount`, `regions`, `sessionCostUsd`, `totalCostUsd`, `costBreakdown`, `costTrend`, `quotes`, `citationOnly`, `actions`, `topDomains`, `topCanonicalSources`, `crawlability`, `authorityPresence`, `adsDetected`, `outreachTemplates`, `citationClassification`, `cells`.

Only **five** keys are currently run-over-run: `meta.prevDate`, `scorePrev`, `engines[].delta`, `engines[].series`, `totalCitationsPrev`.

Full-history series (3667-3668):
```js
3667    trend: snapshots.map(s => s.score),
3668    trendDates: snapshots.map(s => s.date),
```

### `prev` is derived independently in FOUR places (converge if adding a helper)

| Location | Code | Note |
|---|---|---|
| `bin/aeo-tracker.js:3491` | `snapshots.length > 1 ? snapshots[len-2] : null` | inside `buildHtmlSummary` |
| `bin/aeo-tracker.js:4037` | same expression | in `cmdReport`, fed to `deriveActionsWithLLM(latest, prev, ...)` (declared 370) |
| `bin/aeo-tracker.js:213-224` | `readPreviousScore(domain, beforeDate)` | scans **backwards** for first snapshot with numeric `score`; does NOT stop at len-2 |
| `lib/report/sections.js:571-572` | `sectionDiff` derives its own pair | |

## 2. Snapshot discovery / sorting / loading

Storage is **domain-namespaced**: `aeo-responses/<domain-slug>/<YYYY-MM-DD>/_summary.json`, with verified fallback to legacy flat `aeo-responses/<YYYY-MM-DD>/`.

| Function | Lines | Role |
|---|---|---|
| `dateDirectoriesUnder(dir)` | 161-170 | `readdirSync` filtered by `DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/` (159) |
| `recordedLegacyDomain(date)` | 172-183 | reads flat `_summary.json` to learn its `domain` |
| `legacyDateBelongsToDomain(date, domain)` | 185-190 | canonical-identity compare, prevents cross-domain bleed |
| `responseDateDirForRead(domain, date)` | 193-198 | namespaced first, verified legacy fallback, else null |
| `responseDatesForRead(domain)` | 205-211 | **the sort site** |
| `resolveActiveDomain()` | 236+ | config domain → single on-disk namespace → fail loudly |

```js
205  function responseDatesForRead(domain) {
206    const dates = new Set(dateDirectoriesUnder(responsesDirFor(domain)));
207    for (const date of dateDirectoriesUnder(RESPONSES_ROOT)) {
208      if (legacyDateBelongsToDomain(date, domain)) dates.add(date);
209    }
210    return [...dates].sort();
211  }
```
Lexicographic sort on `YYYY-MM-DD` = chronological ascending, so `snapshots[len-1]` is newest.

**Loading** — `cmdReport` 3755-3772: loads **every** date's full `_summary.json` into `snapshots`. No truncation, no field pruning. A comparator can look back arbitrarily far for free. (~57 KB per 9-cell snapshot, dominated by `responseExcerpt` 1500 chars/cell.)

Other loaders: `cmdExport` 4781-4789 (all, try/catch per file); `cmdDiff` 4930-4935 (exactly two).

**`--for-date` truncation (3783-3799):** `snapshots.length = idx + 1; latest = snapshots[idx];` — array truncated **in place**, so any run-over-run code downstream of 3799 automatically inherits the correct historical `prev`. **This is why a comparison block must select its pair from the (possibly truncated) snapshots array, never from the newest run on disk.**

## 3. `lib/report/visibility-index.js` — exported API (532 lines)

| Export | Line | Signature |
|---|---|---|
| `usableProseRank` | 55 | `usableProseRank(pr)` → boolean |
| `perCellPresence` | 77 | `perCellPresence(r)` → number 0..1 |
| `computeComponents` | 109 | `computeComponents(latest)` |
| `computeUVI` | 216 | `computeUVI(components, weights = DEFAULT_WEIGHTS)` → 0-100 |
| `computeUVIBreakdown` | 282 | `computeUVIBreakdown(components, weights = DEFAULT_WEIGHTS)` |
| `computeDiscoverability` | 422 | `computeDiscoverability(crawlability, pageSignals)` |
| `serverRenderedAxis` | 505 | `serverRenderedAxis(pageSignals)` → `{value, note}` |

### `DEFAULT_WEIGHTS` is NOT exported

Bare `const` at line 28: presence .35, sentiment .25, rank .20, citation .20. Reachable only as a default param. To score an old run on the same weights call `computeUVI(components)` with no second arg; to read the numbers use `computeUVIBreakdown(c).rows[i].weight`.

Module-private: `SENTIMENT_VALUE` (35: positive 100 / neutral 50 / negative 0), `PROSE_RANK_DISCOUNT = 0.7` (41), `PROSE_RANK_OK_CONFIDENCE = new Set(['med','low','single-model'])` (47), `COMPONENT_META` (237), `isSignalBearingSentiment` (93).

### `computeComponents` takes a whole snapshot and reads only TWO fields

```js
109  export function computeComponents(latest) {
110    const results = (latest?.results || []).filter(r => r.mention !== 'error');
111    const total = results.length;
112
113    if (total === 0) {
117      return {
118        presence: 0, sentiment: null, rank: null, citation: 0,
119        sample: 0, sentimentSample: 0, rankSample: 0, proseRankSample: 0,
120      };
121    }
```
Touches only `latest?.results` (110) and `latest.domain` (188, inside the citation filter).

**→ Safe to call on any historical `_summary.json`.** Pure, no I/O, null-safe. `computeComponents({results: []})` is a live test case (`test/visibility-index.test.js:63`).

Return: `{presence, sentiment, rank, citation, sample, sentimentSample, rankSample, proseRankSample}`

**CRITICAL INVARIANT:** `null` means *signal absent this run*, and `computeUVI` **re-normalises the remaining weights** (216-230) rather than substituting a fallback. If run A has `rank: null` and run B has `rank: 62`, the UVI delta is **not** attributable to rank movement — the weight basis changed. `computeUVIBreakdown().weightSum` and `.excluded` (341-347) detect and label this.

`computeUVIBreakdown` output shape (verified live):
```
{ rows: [ {key,label,meaning,value,sample:{n,denominator,basis},weight,appliedWeight,contribution}, ... ],
  weightSum, rawSum, uvi, excluded: [] }
```
`sample.basis` is `'cells'` for directly-measured axes (presence, citation) and `'high-confidence cells'` / `'ranked cells'` for conditional ones — a semantic signal for classifying direct vs conditional.

Existing importers: `html.js:58`, `sections.js:5`, `mc-metadata.js:39`. Usage (`sections.js:2165-2168`):
```js
const c = computeComponents(latest);
const uvi = computeUVI(c);
const breakdown = computeUVIBreakdown(c);
```

## 4. Per-cell result shape (`summary.results[]`)

**Two write sites that must stay in sync:** API path `bin/aeo-tracker.js:2954-2997`; manual-paste path `bin/aeo-tracker.js:4601-4628`.

| Field | Type | Always? | Notes |
|---|---|---|---|
| `query` | `'Q1'…'Qn'` | yes | **join key**, positional |
| `queryText` | string | yes | |
| `provider` | `'openai'\|'gemini'\|'anthropic'\|'perplexity'` | yes | |
| `label` | string | yes | display label |
| `model` | string | yes | e.g. `gemini-3.5-flash` |
| `mode` | `'web'\|'training'` | API only | |
| `source` | `'manual-paste'` | manual only | **API cells have NO `source` field — use `r.source \|\| 'api'`** |
| `mention` | see below | yes | |
| `position` | number\|null | yes | list rank; null for prose or no match |
| `citationCount` | number | yes | |
| `canonicalCitations` | string[] | yes | |
| `competitors` | string[] | yes | **both** extractor models agreed |
| `competitorsUnverified` | string[] | conditional | one model only |
| `extractionSources` | `{primary:{model,brands[]},secondary:{...}}` | conditional | only on disagreement/error |
| `sentiment` | `{label,confidence,rationale}` | conditional | only when mention is yes/src |
| `proseRank` | `{rank,confidence,rationale}` | conditional | only when `mention==='yes' && position===null` and rank usable |
| `presence` | `{hits,n,rate,ci:{low,high,level}}` | conditional | `--samples N>1` only (`lib/sampling.js:122`) |
| `hasBrandInCitations` | boolean | yes | |
| `responseExcerpt` | string | yes | `slice(0, 1500)` |
| `responseQuality` | `'rich'\|…` | yes | |
| `elapsedMs` | number\|null | yes | null on manual |
| `error` | string | error cells | |

### `mention` — all values

`detectMention` returns exactly three (`lib/mention.js:12-24`): `'yes'` (named in answer body), `'src'` (only in a citation URL), `'no'`.
`'error'` written at exactly one site — `bin/aeo-tracker.js:3026`.
**`'missing'` is NEVER persisted** — render-time sentinel only (`bin/aeo-tracker.js:3605`, `:3530`, `lib/diff.js:23`).

→ **4 persisted values (`yes`/`src`/`no`/`error`), 1 synthesized (`missing`).** Hit-counting is uniformly `mention === 'yes' || mention === 'src'` (3521, 3536, 3541, 3170, 4659, 376).

### Design constraint

Optional fields use conditional spread (`...(x ? {k:v} : {})`) to keep JSON lean. **A comparator must distinguish "field absent" from "value changed", or older snapshots fabricate movement.** Snapshots on disk span three different field sets — use them as regression fixtures. (`aeo-responses/2026-07-11/_summary.json` has no `sentiment`, no `proseRank`, no `hasBrandInCitations`.)

### Top-level `_summary.json` keys

`date, brand, domain, score, mentions, total, errors, regressionThreshold, sessionCostUsd, costByModel, extractorMode, generatedBy, measurement, results, topCompetitors, unverifiedOnly, topCanonicalSources, topDomains, adsDetected, crawlability, pageSignals, entityGraph, llmActions, citationClassification, authorityPresence, regionContext, responseFreshness, outreachTemplates`

## 5. Existing diff logic — `lib/diff.js` (117 lines)

**One export:** `diff(summaryA, summaryB)` — A = earlier ("was"), B = later ("now"). Args are *snapshots*, not `buildHtmlSummary` output.

Returns:
```js
{
  scoreDelta,                       // (B.score ?? 0) - (A.score ?? 0)
  cellChanges: [{provider, query, was, now, mixedMethod, method}],
  newCompetitors:  [{name, count}],
  lostCompetitors: [{name, count}],
  sourcesMovement: { gained: [{url,count}], lost: [{url,count}] },
}
```

Private helpers: `listMap(list, key='name')` (3), `hasPresence(r)` (11), `isCoveredMention(m)` (23).

**Cell-level segmentation — its core value:**
- Cell key: `` `${r.query}|${r.provider}` `` (35, 44). Builds a Map from A, merges B.
- **Coverage gate (55):** `if (!isCoveredMention(cell.was) || !isCoveredMention(cell.now)) continue;` where `isCoveredMention(m) => m && m !== 'error' && m !== 'missing'`. Anti-fabrication contract: a provider added/dropped between runs produces **no** row.
- **No-change short-circuit (56):** `if (cell.was === cell.now) continue;`
- **Sampling-aware significance test (63-76):**
  ```js
  let method = 'point-estimate';
  if (hasPresence(...) && hasPresence(...)) {
    const verdict = classifyProportionChange(
      { hits: cell.wasPresence.hits, n: cell.wasPresence.n },
      { hits: cell.nowPresence.hits, n: cell.nowPresence.n },
    );
    if (verdict.classification === 'noise') continue;  // statistically indistinguishable
    method = 'distribution';
  }
  ```
  `classifyProportionChange` from `lib/stats.js:165` — Wilson CI overlap + two-proportion z. Siblings: `wilson(hits,n,z)` (60), `presenceFromCounts(hits,n,level)` (90), `twoProportionZ` (118), `ciOverlap(a,b)` (140), `DEFAULT_Z`/`DEFAULT_CONFIDENCE` (30-31).

### Gaps `diff()` does NOT cover

1. **No UVI / component comparison** — no presence/sentiment/rank/citation axis deltas.
2. No sentiment movement, no position/rank movement, no `hasBrandInCitations` movement — only `mention` enum flips.
3. **Ignores `model`.** Cell key is `query|provider`, but `buildHtmlSummary` filters engines by provider **and** model (3520). A model swap is invisible to `diff()`.
4. Competitor/source movement is presence-only — `listMap` builds `name → count` but only set-difference is used; **count deltas for survivors are computed then discarded.**
5. `positionMatrix` / `topDomains` / `crawlability` / `authorityPresence` / `topicClusters` not diffed at all.

### Duplication: cell-diff exists TWICE

`sectionDiff` (`lib/report/sections.js:562-620`) **reimplements** the logic inline instead of importing `diff()`:
```js
571    const prev = snapshots[snapshots.length - 2];
572    const curr = snapshots[snapshots.length - 1];
581    const isCovered = (r) => r && r.mention && r.mention !== 'error' && r.mention !== 'missing';
583    for (const r of curr.results) {
584      const pr = prev.results.find(p => p.query === r.query && p.provider === r.provider);
585      if (!isCovered(pr) || !isCovered(r)) continue;
586      if (pr.mention !== r.mention) {
587        const methodChanged = (pr.source || 'api') !== (r.source || 'api');
```
`lib/diff.js` is strictly richer — it has the `classifyProportionChange` branch, **`sectionDiff` does not**, so the markdown "What Changed" table still reports sampling noise as real change. `lib/diff.js` is imported only by `bin/aeo-tracker.js` (`cmdDiff`) and `test/diff.test.js`.
→ **Recommendation: extend `lib/diff.js` and refactor `sectionDiff` to import it.**

The gained/lost classifier is duplicated a third time, in the CLI (`bin/aeo-tracker.js:4958-4959`) and `sections.js:605-607`:
```js
const gained = (ch.was === 'no' || ch.was === 'missing') && (ch.now === 'yes' || ch.now === 'src');
const lost = (ch.was === 'yes' || ch.was === 'src') && (ch.now === 'no' || ch.now === 'missing');
```
Belongs in `lib/diff.js`.

### `cmdDiff` CLI — `bin/aeo-tracker.js:4876+`

Arg forms (4886-4917): `diff [dateA] [dateB]`, `--last N`, `--since DATE`, default last two.

## 6. Markdown renderer / section registration

**File:** `lib/report/markdown.js` (204 lines). Pattern: flat named exports from `sections.js`, each `section*(snapshots, ...)` → string. `renderMarkdown` builds an array of *called* sections and joins.

### THREE lists to update, not one

1. **`markdown.js:1-39`** — import block.
2. **`markdown.js:63-99`** — `renderMarkdown` full-report array. Join at line 100: `return sections.filter(s => s && s.trim()).join('\n');`
3. **`markdown.js:142-173`** — `renderWhiteLabelMarkdown` array. **A section added only to list #2 silently vanishes from `--white-label` output.**

`sectionDiff` is in both (line 80 and line 153).

Signature: `renderMarkdown(snapshots, rawResponses = {}, opts = {})` — `markdown.js:60`. `opts`: `mcMetadata`, `noMcBlock`, `whiteLabel`, `reportTitle`, `public`, `responsesPath`.

Slot (79-81):
```js
79     sectionDisambiguationWarning(snapshots),
80     sectionDiff(snapshots),
81     sectionTrend(snapshots),
```

`sections.js` is 2989 lines, ~82 exports, **no registry object** — flat exports, order lives in `markdown.js`.

**Empty-state convention:** most sections `return ''` (filtered at join). `sectionDiff` is the exception — on `snapshots.length < 2` it returns a placeholder (563-569):
```
## What Changed

_This is your first run — there's nothing to compare yet. Trends (gained/lost mentions, competitor movement) become visible starting with your second weekly run._
```
`test/report-empty-blocks.test.js` enforces `''`-suppression for `sectionTrend`/`sectionTopicClusters`/`sectionCanonicalSources` but does **not** cover `sectionDiff`. Both conventions are house-legal; placeholder is right when the reader would otherwise wonder where the comparison went.

## 7. Test style (house convention)

`test/diff.test.js` (184) and `test/visibility-index.test.js` (832) use the **hand-rolled harness**, not `node:test`.

Preamble:
```js
import assert from 'node:assert/strict';
import { ... } from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
```
Epilogue:
```js
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```
`console.log('\n<group name>')` separates groups.

**Fixtures: inline object literals, minimal — only fields under test.** No factories, no JSON files, no `beforeEach`. Local builders where a shape repeats (`test/diff.test.js:126-129`).

Representative (`test/diff.test.js:131-137`):
```js
test('overlapping CIs (3/5 → 2/5) → NOISE, no cellChange emitted', () => {
  const a = { score: 60, results: [sampled('yes', 3, 5)] };
  const b = { score: 40, results: [sampled('no', 2, 5)] };
  const d = diff(a, b);
  assert.equal(d.cellChanges.length, 0,
    `3/5 vs 2/5 overlap → sampling noise, not a regression, got ${JSON.stringify(d.cellChanges)}`);
});
```

Conventions: `assert.equal`/`assert.ok`/`assert.doesNotThrow`; **third-arg message dumps the actual value**; test names encode the *invariant*; inline `//` comments explain *why*, referencing the bug class prevented; a **MUTATION-SANITY** header block states what breaks the tests (`test/diff.test.js:116-121`).

A minority of newer files use `node --test` (`test:brand-fit`, `test:coverage-axis`, `test:fixes`, `test:e2e`, `test:replay-*`).

**Wiring: a new test file needs TWO `package.json` edits** — a `test:<name>` script, AND appending `&& npm run test:<name>` to the giant `test` chain.

## Integration points summary

| # | Location | Action |
|---|---|---|
| 1 | `lib/diff.js` `diff(A,B)` | Extend: UVI-component deltas via `computeComponents(A)/(B)`; competitor/source count deltas; sentiment/position movement. Keep `isCoveredMention` gate. |
| 2 | `lib/report/sections.js:562` `sectionDiff` | Refactor to `import { diff }` — kills duplicate + inherits noise suppression. |
| 3 | `bin/aeo-tracker.js:4958-4959` + `sections.js:605-607` | Move gained/lost classifier into `lib/diff.js`. |
| 4 | `bin/aeo-tracker.js:3650-3709` | Add key(s) for anything the **HTML** report must show. |
| 5 | `lib/report/markdown.js` × 3 lists | Register a new markdown section in import + full + white-label arrays. |
| 6 | `bin/aeo-tracker.js` 3491 / 4037 / 213 + `sections.js:571` | Four independent `prev` derivations — converge if adding a shared helper. |
| 7 | `package.json` | `test:<name>` script **and** append to the `test` chain. |

**Watch out for:** `prev === null` on first run; `model` invisible to `diff()`'s `query|provider` key; `r.source` undefined for API cells; `computeComponents` returning `null` axes changes the UVI weight basis between runs; conditional-spread fields absent in older snapshots must read as "not measured", never as "changed".
