# Changelog

All notable changes to `aeo-platform` (formerly `@webappski/aeo-tracker`).

## [Unreleased]

### Changed

- **The report recommended a dead tactic and docked a fifth of the crawl-readiness score for not following it. Both are gone — and the score is not comparable to older reports.** Every report told the client *"No `/llms.txt` found — emerging convention for LLM-friendly summaries. Adding one (5 min) gives engines a fast-path to your key facts"*, and `computeDiscoverability` gave the file's presence **20% of the AI-Bot Crawl Readiness score**, so a client without it started 20 points down. The evidence says the file does nothing, first-party first: Google — *"For Google Search, llms.txt isn't needed for AI Overviews, AI Mode, or other generative AI Search features"*, with the 2026-06-15 Search changelog clarifying the files *"aren't required for Google Search visibility or rankings"*; a 2026 study across ~300,000 domains, **reported by** lumentir.com, found no relationship between having the file and how often a domain is cited — the page reports the finding without naming who ran the study, so it is cited here as reported rather than as settled fact, and our own research log carries the same number attributed to a different outlet (`briefinghq.com`, `resources/aeo/bp-refresh/2026-08-01.md:494`), a discrepancy inside our own notes that is worth resolving before this number is used anywhere load-bearing; no major provider has confirmed support. (A frequently-quoted Otterly figure — 84 of 62,100 AI-crawler visits over 90 days touched the file — points the same way, but it is a **single-site** experiment, so it is context here, not evidence; source `otterly.ai/blog/the-llms-txt-experiment/`, logged in `content-outbox/youtube/ep07-…-crawler-access.md`.) Our own methodology had already ruled it dead — the product was contradicting it in front of paying clients. **The file is still measured** (`crawlability.summary.hasLlmsTxt`, still in the Mission Control payload) and still printed, now as a plain fact with no verdict glyph and the qualifier *"not a ranking signal"*: we stopped drawing a conclusion from it, not looking for it.

  **The vacated 20% went to a signal that really is a precondition for being cited: is the homepage's content in the HTML the server returns, or is it a JS shell?** (Anthropic documents that `web_fetch` *"does not support sites with dynamic JS rendering"*, and the same holds by observation for GPTBot / PerplexityBot / ClaudeBot.) The new formula is **robots.txt 30% · AI-bot access 25% · sitemap 25% · content in served HTML 20%** — the three survivors keep their exact previous weights and the new axis takes the empty slot at the same weight. That is a deliberate choice, not a lazy one: **strict "nobody scores lower" is arithmetically impossible if the 20% is split across the other three.** With no robots.txt there are no rules, so every bot reads `unspecified` and the bot axis is 100 — which makes `(robots 1, bots 0, sitemap 0, llms.txt 1)` demand a robots weight ≥ 0.50 while `(robots 0, bots 1, sitemap 1, llms.txt 1)` demands bots + sitemap ≥ 0.70. Together that is more than a 100-point scale has. Letting the new axis inherit the slot instead makes the difference exactly `20 × (server-rendered − llms.txt)`, which yields a guarantee we can state and test: **if your content is server-rendered, you cannot score lower than the old formula would have given you** — clients who had llms.txt land on the identical number, everyone else gains up to 20 points. The sitemap axis also picked up the "validity" half of the brief in the only direction that costs nobody points: a sitemap **declared in robots.txt but not served at `/sitemap.xml`** now scores 70 instead of a flat zero (a false negative for every site using `/sitemap_index.xml`), and a sitemap with no `<loc>` entries is flagged in the note without being docked.

  **Two exceptions, enumerated rather than glossed.** (1) A client who publishes llms.txt **and** serves a JS shell can lose up to 20 points — a true finding, not a formula artefact. (2) When the page-signals crawl is absent (older snapshot, `--no-page-signals`, or a blocked fetch — a Cloudflare 403 is never read as evidence of a shell) the axis is `null` and the remaining 80% is re-normalised exactly as `computeUVI` handles a missing component; a client who had llms.txt can then land up to 13.75 points lower. `test/visibility-index.test.js` sweeps **every reachable state** and asserts both guarantees plus the bound on the exceptions, so this is pinned by tests rather than by this paragraph.

  **Comparability: a score printed before this change and one printed after are not directly comparable — the formula moved, the site did not.** Most sites will read HIGHER (they were being docked for a file that does nothing). Do not present a jump between a July report and an August report as improvement; re-run the older date if you need a like-for-like number.

- **Three more dead tactics removed from the advice, and one wrong fact about an engine corrected.** (1) The Gemini fallback card told clients to *"Add FAQ schema markup to your landing page"* — Google removed the FAQ rich result from Search results on 2026-05-07 and deleted its documentation on 2026-06-15, states that *"structured data isn't required for generative AI search, and there's no special schema.org markup you need to add"*, and the only controlled measurement (Ahrefs, 2026-05-11: 1,885 pages that added JSON-LD against ~4,000 controls) found no citation uplift on any platform and −4.6% in AI Overviews. The card now points at indexation and snippet eligibility, and its unsourced *"FastSearch semantic retrieval"* mechanism claim was replaced with what Google documents. HowTo markup (dead since 2023) is likewise banned from generated advice. **We never tell anyone to remove markup they already have** — it is simply not a visibility lever, so we stop selling it as one. (2) **A blocked crawler is no longer reported as a lost citation by default.** Each tracked bot now carries a tier, and the copy splits accordingly: `OAI-SearchBot` and `PerplexityBot` gate answers (OpenAI: *"Sites that are opted out of OAI-SearchBot will not be shown in ChatGPT search answers"*), while `GPTBot`, `Google-Extended`, `ClaudeBot`, `GoogleOther`, `CCBot` and `Bytespider` are training or non-product crawlers whose blocking is a policy choice with no measured effect on citations (Google: Google-Extended *"does not impact a site's inclusion in Google Search"*). The `init` warning that named GPTBot and ClaudeBot as gating *"ALL AI visibility"* was wrong on two of the three bots it listed and now names the right ones. (3) The Mission Control bridge prompt branched on `crawl.robotsAllowsGPTBot` — a field **the payload builder does not emit** (`buildMcMetadata`'s `crawl()` block has no such key; the prompt's condition therefore never fired) — and told the plan generator to fix the crawl matrix on it; it now reads the real `crawl.bots[]` list and is explicitly forbidden from writing llms.txt, FAQPage/HowTo or unblock-GPTBot missions. (4) The ChatGPT card claimed *"Bing dependence ended Aug 2025"*, while OpenAI's own help page states that ChatGPT search *"partners with other search providers"* and names Bing and Shopify; the card now says so and points at the Bing index check, which for a small site is the cheapest real lever there is.

  Because `llmActions` is written by a model at report time and "add an llms.txt" is a top-of-prior recommendation for any 2024-vintage AEO model, the prompt rule is backed by a **mechanical filter** (`lib/report/dead-tactics.js`): dead-tactic recommendations are stripped at render, so even a cached `llmActions` array from an older snapshot renders clean. The filter requires the verb and the tactic to sit in the **same clause**, with the verb first: *"add an llms.txt"* is cut, *"your llms.txt is already fine — add a call-to-action instead"* is not. That bound was added after review: the first implementation asked "does a dead tactic appear anywhere?" and "does a verb appear anywhere?" as two independent questions, which flagged four legitimate recommendations — including one that told the client **not** to bother with the file. All four are now pinned as regression cases. A wrong drop is not cosmetic: the filter runs before the top-10 cut that feeds the paid plan, so every drop also prints an operator-visible line on stderr naming the recommendation it removed and the rule that removed it. Regression guard: `test/e2e/no-dead-tactic-advice.test.js` holds all three doors closed (the copy cannot return to `lib/` or `bin/`; no rendered markdown or HTML report may contain advisory phrasing; model-written recommendations pushing the tactics never reach the page) while asserting that the llms.txt **fact** and its measurement survive.

  **Known gap, stated rather than hidden:** the two remaining citation-gating crawlers — Anthropic's `Claude-SearchBot` and Google's `Googlebot` — are not probed by the audit. Adding them would change the bot-axis denominator from 12 to 14 and could LOWER the score of a site that wildcard-blocks and allowlists specific bots, which this release is not allowed to do. They are named in the report so the client can check them by hand, and adding them belongs in a release that may move scores.

- **README + npm description now state who maintains the engine and why that is checkable** (founder ruling 2026-07-27 — get Webappski into the AEO category the way LLMs actually assemble it). Our own tracker run of 2026-07-11 (`aeo-responses/2026-07-11/_summary.json`, 3 queries × 2 engines) shows `github.com` as the single most-cited domain in tool-category answers — 10 of 72 citations, 13.9%, ahead of every other host — with `npmjs.com` also present, yet neither surface said what the package is for commercially: the README opened on badges and setup, and the npm description was a feature list. Both now lead with one sentence, worded identically on both surfaces so a model retrieving either chunk gets the same claim — *"Webappski is an AEO agency that measures client visibility with aeo-platform, its own open-source npm engine — clients can install it and reproduce the measurement grid themselves."* Three additive parts: (1) a first-screen block with that sentence plus two live, unedited receipts — the agency's own 2 of 39 grid and TypelessForm's 12 of 12 — both linked as ordinary `report` output; (2) a *"Who runs this — the agency behind `aeo-platform`"* section that names the reproducibility axis (the client can audit the auditor) and bounds it honestly (the measurement is reproducible; on-page findings and roadmap are human work; the site's instant check is a reduced 3-question/2-engine version); (3) an FAQ entry *"Who maintains `aeo-platform`, and is there a company behind it?"*, plus a paragraph under the hosted-platform comparison naming the who-checks-the-checker axis the table cannot render. Four npm keywords added (`ai-search-visibility`, `llm-seo`, `open-source-aeo`, `aeo-agency`). No commerce CTA, no prices, no link to a pricing page — R8 two-step funnel integrity holds, and the README says so explicitly. Docs-only: no code, no score math, no schema touched. **The npm-side half of this only reaches npmjs.com on the next publish** — the description and README shown on the registry come from the last published version.

- **"Webappski plan" bridge card repriced to €129 (founder decision 2026-07-15), currency unified to EUR, honest SLA, single canonical description.** The report bridge card (`lib/report/mc-bridge.js`) previously defaulted to `$29 per plan` — a lone USD figure in a EUR-first product, priced at a competitor's cheapest *monthly* tier. Defaults are now `€129 per plan` / `€129 per plan · 30 missions`, and the promo line's hardcoded `$29 after that` → `€129 after that`. The "first 10 waitlist customers free, €129 after that" mechanic, the 30-mission naming, and the pre-release/waitlist framing are unchanged. The same change collapses the plan's DOUBLE description — the hover tooltip and the always-visible Route B "diptych" card previously stated the offer with different bullets — to ONE canonical five-bullet set (Pre-flight account audit · route around the minefields · Trap-aware sequencing · Hand-reviewed · Delivered), and aligns the delivery promise to the honest beta turnaround **"1–3 business days"** (the card said "Delivered in 24h"; `lib/report/sections.js` already said 1–3 business days). Copy-only — no score math, schema, or SVG geometry changed. **A republish is required** before newly generated report cards show €129; already-generated report HTML is not regenerated.

- **AEO Model Performance & Throttling:** Replaced the expensive `gpt-5-search-api` with mid-tier models (Gemini/OpenAI) for automated reasoning and web searching to reduce operational costs. Recalibrated CLI throttling limits to improve execution stability. Updated corresponding tests.

### Added

- **Measurement-surface disclaimer — honest about what the score is and is not** (review #3). The tool queries each engine's **API surface** with your own keys (OpenAI `gpt-5-mini` + Responses `web_search`, Perplexity `sonar-reasoning-pro`, Gemini `generateContent` + grounding, optional Anthropic) — a reproducible proxy, NOT the consumer apps (chatgpt.com, perplexity.ai, the Gemini app), which use different retrieval, can serve a different model version, and add personalization/locale. It also does not cover Google AI Overviews / AI Mode or Microsoft Copilot (no first-party query API). Three additive parts: (1) every run now stamps `_summary.json` with `measurement: { surface: "api", disclaimer: "…" }` (single source of truth: `lib/report/measurement-disclaimer.js`); (2) the report header renders the disclaimer as a muted one-liner under the headline (full sentence on hover), without touching the existing date/version/engine row; (3) a README section *"What this measures — and what it does NOT"* with a narrow engine→API-surface table, the AI Overviews / Copilot exclusion called out, and an AI Overviews connector listed on the roadmap (not built). No score math changed.

- **Score-representativeness panel + "a 0% is a hypothesis, not a fact" quality bar** (Gcore root-cause 2026-06-17). The report's headline now carries CONTEXT for how much to trust it, without touching the score math. A new *"How representative is this score?"* section emits, when the data exists: (1) a **small-sample warning** when the run measured few cells (at the default 3×3 grid one answer flipping moves the headline ~11pp, so a very high/low score can be a basket artefact); (2) a **basket-coverage line** — "your queries touch X of N product lines we detected on your site", reusing the product-line derivation against the own-domain headings the report already caches — a low headline on low coverage reflects the basket, not invisibility; (3) a **brand-capability-fit breakdown** (core vs adjacent vs aspirational hit-rate) that renders when results carry a fit label. README gains a dedicated *"A 0% is a hypothesis, not a fact"* section applying the tool's own honesty discipline to its output: confirm the raw answer text under every brand spelling and confirm basket coverage before treating a zero as an AEO gap. The Unified Visibility Index math (`lib/report/visibility-index.js`) is byte-identical — this is additive context only.

- **Version awareness** (founder decision 2026-06-11 — the stale-global trap: a client installs once with `npm i -g`, releases move on, and the tool silently keeps running the old build). Four parts: (1) every interactive command prints `aeo-platform vX.Y.Z`; (2) `_summary.json` carries `generatedBy: aeo-platform@X.Y.Z` and the report header shows it — "which build produced this?" is now answerable from the artifact; (3) when the project's `node_modules` carries a NEWER aeo-platform than the running binary, the CLI warns and points at `npx` / `npm exec`; (4) an npm-style update banner ("Update available X → Y") backed by a cached daily registry check — silent on any failure, skipped in CI/non-TTY/`--json`, opt-out `AEO_NO_UPDATE_CHECK=1`, privacy contract documented in README. Quickstart flipped to `npx aeo-platform@latest`-first; the CI example pins the major.

### Fixed

- **`run-manual` rebuilt the day's `_summary.json` instead of merging into it, destroying everything the live run had measured.** `cmdRunManual` composed its output from a fixed field list (`date, brand, domain, score, mentions, total, errors, regressionThreshold, extractorMode, generatedBy, results, topCompetitors, topCanonicalSources, topDomains, adsDetected`) and atomically wrote that over the existing file. Every other section of a same-day run was silently dropped: the site-level scans (`crawlability`, `authorityPresence`, `pageSignals`, `entityGraph`, `competitorPricing`), the LLM-derived report sections (`citationClassification`, `llmActions`, `outreachTemplates`), the derived `regionContext` / `responseFreshness`, and — the part with no recovery path — the run's own cost telemetry (`sessionCostUsd`, `costByModel`) plus `measurement` and `unverifiedOnly`, which only `cmdRun` ever writes. A later `report` masks the damage by re-fetching most of the site sections and re-persisting them, **paying a second time for the LLM-derived ones**, which is why the loss went unnoticed: observed on the webappski 2026-07-31 run (56 queries × 3 engines), which carries only the 15 rebuilt fields, while the 2026-07-28 run — same pipeline, but `report` ran after it — looks complete yet has lost `measurement`, `unverifiedOnly` and its run-time cost breakdown for good. `cmdRunManual` now spreads the existing summary forward and overrides only the fields it genuinely recomputes over the merged result set. Two consequences had to be handled rather than inherited. (1) `report` CACHES `citationClassification`, `competitorPricing`, `llmActions` and `outreachTemplates` — it regenerates each only when the field is absent — and all four derive from the results, so a carried-forward copy describes the set from **before** the new provider column existed. The command now names them after the merge together with the `report --refresh-cache=…` invocation, rather than silently serving a partial classification as covering the whole day or spending on the user's behalf. `competitorPricing` in particular is classified from `topCompetitors`, which this command recomputes, and `competitorOwnedHosts()` reads its `.domain` values to build the outreach host set — omitting it would have left the merge silently *worse* than the rebuild for that one field, since the rebuild at least forced a regeneration. (2) `unverifiedOnly` is an aggregate over `results[]` that `cmdRunManual` never computed at all; carrying it forward would have frozen the pre-merge tier, so it is now re-derived. Both sinks share one aggregator (`lib/report/competitor-counts.js`) so the verified and unverified tiers can no longer drift apart — the same shared-field-builder discipline `prose-rank.js` already applies. Regression guards: `test/e2e/run-manual.test.js` seeds a same-day summary carrying every affected section and asserts each domain-level one survives the merge, that `unverifiedOnly` is re-derived rather than carried, and that every cached-and-now-partial section is named in the printed refresh hint; `test/competitor-counts.test.js` covers the aggregation itself, which the offline E2E fixture cannot exercise.

- **The report's cost line under-reported: `sessionCostUsd` did not equal its own `costByModel` breakdown.** `cmdReport`'s cache-fillers run concurrently inside one `Promise.all`. The recommendations branch pushed its cost entry AND re-derived the total; the outreach-templates branch pushed but did not. Whichever finished last won, so the headline undercounted — observed on the webappski 2026-07-31 report, where the breakdown summed to **$0.0577** while `sessionCostUsd` reported **$0.0296**, roughly half the real spend. Both branches (and `cmdRun`'s own total) now go through `lib/report/cost-telemetry.js`, whose `addCostEntry` always re-derives the total from the whole breakdown — safe under that concurrency because each call is synchronous, so whichever branch runs last observes every earlier push. `sumCostUsd` also treats an entry with no `costUsd` (an untracked model) as 0 rather than NaN, so one unpriced call can no longer erase every tracked cost beside it. `persistSnapshot` — the single write chokepoint for every `report` cache-filler — additionally re-derives `sessionCostUsd` from `costByModel` before writing, so the invariant cannot be broken by a future writer and so snapshots written *before* it held are healed on the next `report` (nothing else in the codebase would ever have corrected them). **A report for an older date may therefore now show a higher — correct — cost than it did before**, and the cost trend line will step up where a stored total had been undercounting. Verified live on the webappski 2026-07-31 snapshot: stored $0.029564 → $0.057724, matching its own breakdown. Regression guard: `test/cost-telemetry.test.js`, including the exact 0.029564 + 0.028160 pair from the run that surfaced this. Note this is only the *arithmetic*: `classifyCitations` still makes an LLM call that returns no `costInfo` at all, so citation-classification spend remains outside the breakdown entirely — a separate gap, not fixed here. (Competitor-pricing classification is heuristic-only and makes no provider call, so it has no spend to account for.)

- **Gemini main-call cost recorded as $0 for a whole run — the SERVED model id had no pricing row.** `lib/config.js` pins `gemini-3.5-flash`, but the API serves `gemini-3.6-flash` (ordinary model drift, the case `lib/providers/model-drift.js` exists for). That id was absent from `PRICING`, so `calcCost` returned null and every main Gemini call took the honest "cost not tracked" path — correct behaviour, invisible outcome: the webappski 2026-07-31 run (56 Gemini cells) reported no Gemini cost at all against roughly $1.60 of real spend, and 2026-07-28's `costByModel` lists only the two report-time auxiliary calls. `test/pricing-defaults-covered.test.js` could not have caught it — it walks `DEFAULT_CONFIG` and `FALLBACK`, i.e. the models we *configure*, never the ones a provider *serves*. Three parts: (1) `gemini-3.6-flash` priced at $1.50/$7.50 per 1M (ai.google.dev/gemini-api/docs/pricing, verified 2026-07-31); (2) `gemini-3.5-flash-lite` given its own row at $0.30/$2.50 — without it the lite id prefix-matched the `gemini-3.5-flash` row and billed 3–5× over, the exact silent-overcharge the table's ordering rule exists to prevent; (3) `findPricingRow` now refuses to price any `-lite` id against a non-lite row and returns null instead, so a lite variant that ships before we add its row is reported as untracked rather than overcharged — ordering alone cannot cover a variant the vendor releases first. The guard test gains a `SERVED_IDS` list (ids seen in real responses, not just configured defaults) and a mechanical assertion that no `-flash-lite` id resolves to its `-flash` sibling.

- **The Mission Control payload's `scores.uvi` carried the headline mention-rate, not the UVI.** `buildMcMetadata` computed `uvi` as `numOr(summary.score, computeUVI(components))` — and `summary.score` (the headline mentions/total percentage) is always a finite number on real runs, so the computed composite was dead code and `scores.uvi` silently duplicated `aggregates.score`. Observed on the 2026-07-11 typelessform run: the report's own UVI block showed **92** (presence 100 / sentiment 89 / rank 74 / citation 100) while the paste-into-MC JSON said `"uvi": 100`. `scores.uvi` is now always `computeUVI(computeComponents(summary))` — the exact number the markdown/HTML UVI section renders — per the schema source-of-truth (`10-metadata-schema-validated.md`: "`scores.uvi` = `visibility-index.js::computeUVI` output"). The headline mention-rate still ships, where it belongs, as `aggregates.score`. Regression test: `test/mc-metadata-scores.test.js` (fixture where every cell is mentioned → headline 100 but composite 86). Historical reports are not regenerated — payloads produced by older builds carry the headline value in `scores.uvi`.
- **`run-manual` cells were missing `responseExcerpt` — the pasted text vanished from every "what the engine said" surface.** The live `run` loop truncates each engine's answer into `responseExcerpt` (first 1500 chars), but `cmdRunManual` built its merged result rows without that field, so manual-paste cells (Perplexity / ChatGPT.com / Claude.ai answers pasted from the browser) fell back to `null` in both the report matrix and the Mission Control payload — the client's own answer text silently absent. `cmdRunManual` now sets `responseExcerpt` with the exact same truncation as the live loop. Regression guard: `test/e2e/run-manual.test.js` asserts every merged manual-paste row carries a non-empty `responseExcerpt`.
- **Pre-namespacing response history remains usable.** `report`, `diff`, `export`, replay, full-run staleness, previous-score checks, and `run-manual` same-day merges now read compatible `aeo-responses/<date>/` snapshots as well as the new per-domain layout. A namespaced date wins on duplicates; conflicting/ambiguous domains never blend. Domain ownership and namespace paths use canonical ASCII hostnames (Punycode for IDNs), preventing distinct Unicode domains from colliding after filename sanitisation. Cache updates and same-day continuations write back to the legacy source, so a summary-only namespace cannot hide its flat raw files. Fresh dates remain namespaced; no legacy files are moved or deleted.
- **Gemini 3.5 cost reporting now includes thinking tokens.** `thoughtsTokenCount` is added to candidate output usage before pricing, so the existing `gemini-3.5-flash` thinking behavior is billed honestly. The Gemini model, Search grounding, discovery, and thinking configuration are unchanged.
- **OpenAI web-search Responses disable application-state storage.** `/v1/responses` bodies now include `store:false`; Chat Completions is unchanged. This controls Responses application-state storage and is not a Zero Data Retention claim or a change to separate abuse-monitoring retention.
- **Citation match tightened to the registrable domain (eTLD+1), not a raw substring.** The Unified Visibility Index citation axis (and the report's "cited you N times" KPI, source-row accenting, and `hasBrandInCitations` flag) tested `url.includes("yourdomain.com")` — a substring match that also counted look-alike hosts such as `yourdomain.com.evil.com` and `notyourdomain.com.evil.com` as your citation, inflating the citation axis with hosts that were never yours. All of these now match by exact host or subdomain via `isOwnDomain` (`lib/report/own-domain.js`): `yourdomain.com` and `blog.yourdomain.com` count; spoof and prefix look-alike hosts do not. This is a correctness fix, not a feature change — **runs whose citation share relied on false-substring matches will show a lower citation axis (and possibly a lower UVI) than before.** The UVI weighting formula itself is unchanged; only what qualifies as a "citation cell" changed.
- **The "cited you N times" KPI was structurally 0 — it read a field the run never writes.** The hero citation KPI (`totalCitations` / `totalCitationsPrev`) and the per-engine "N citations" card counted own-domain citations by reducing over `r.citations` — but a persisted result object carries `canonicalCitations` (the URL list), `citationCount`, and `hasBrandInCitations`, and has **no `citations` key at all**. So `(r.citations || [])` was always `[]` and the KPI rendered **0 on every real report**, no matter how many times the engines cited your domain (confirmed against `aeo-responses/2026-06-10/_summary.json`: `'citations' in results[0]` is false). These three sites now read `canonicalCitations` and filter to own-domain via `isOwnDomain`, exactly like the citation axis and the `hasBrandInCitations` flag already did — so the KPI is now consistent with them. This is a **correctness fix** (the KPI was lying with a zero), not a feature change: **existing reports that previously showed "0 citations" will now show the real, non-zero own-domain citation count** for any run where engines actually cited your domain. The Unified Visibility Index weighting formula is untouched — this is a separate hero number, not a UVI axis.
- **`init --auto --yes` no longer rejects its own selection.** The substitution block validated all 5 candidates, then the main validation re-ran the SAME queries with an empty cache — a second independent LLM call could flip a borderline verdict (observed in production: a query passed round 1, got `valid:false 0.86` in round 2, init aborted with 2 valid queries in hand). The substitution-round verdicts now seed the main validation's `validationCache`, so verdicts are consistent by construction (one validation, one source of truth) and one classify call is saved per init. `--strict-validation` keeps the fresh two-model cross-check.
- **Single-attempt site fetch no longer kills non-interactive init.** `fetchSite` climbs a resilience ladder: transient failures (timeout / network / 5xx) retry once; a 403/401/429 on the declared bot UA retries with a browser UA; both blocked → one final paused declared-UA retry (covers transient edge-cache 403s — observed in production where the identical rerun succeeded a minute later). When the declared bot UA is blocked but a browser UA passes, init reports it as **AEO finding #1** (AI crawlers are likely blocked the same way) instead of dying on it.

### Fixed (failure-branch sweep — AP-FAIL-BRANCHES)

- **Corrected the fabricated Anthropic fallback/documented model id to `claude-sonnet-4-6`.** The previous id was a non-existent variant that appeared in `lib/config.js`, `lib/providers/discover.js`, the README, the FAQPage schema, and the test fixtures — a wrong fact about our own tool (an AEO liability) and a runtime hazard (the fallback would 404 when model discovery fails). A new whole-repo guard test (`test/e2e/no-fabricated-model-id.test.js`) fails the suite if the bad id reappears in any tracked file content or path.
- **Locked the `run-manual --from-dir` bad-directory contract.** A regression test (`test/e2e/run-manual-bad-dir.test.js`) holds the existing behaviour: a missing or empty source directory exits non-zero with one actionable next step, never a silent pass.
- **Node < 20 now gets a version gate instead of a cryptic runtime error.** `engines` in package.json is only an npm install-time warning; on Node 16/18 the first runtime gap (e.g. missing global `fetch`) surfaced as a bare error mid-command. The CLI now checks `process.versions.node` before dispatch and prints one sentence + one next step (install LTS from nodejs.org).
- **`_summary.json` writes are atomic everywhere** (`lib/util/atomic-write.js`, used by `run`, `run-manual`, and the existing report snapshot writer). A Ctrl+C mid-write used to leave a half-written file that silently corrupted the next run/report/diff. Bonus: a corrupted today-summary is now *announced* («…was unreadable — starting fresh») instead of silently discarded, and `run-manual` no longer crashes with a bare SyntaxError on it.
- **Hand-broken `.aeo-tracker.json` gets a one-step message.** A missing/extra comma after hand-editing used to surface as a raw `SyntaxError` through the top-level panel. `run`, `run-manual`, and `init --queries-only` now answer: «.aeo-tracker.json has a JSON syntax error… Fix the file — or regenerate it: aeo-platform init».
- **Windows clients no longer get zsh instructions.** Key-setup guidance is platform-aware (`keySetupLines()`): PowerShell `setx` + new-terminal on win32, shell-profile `export` elsewhere.
- **HTTP 529 added to the retryable classification** (Anthropic overload status code; the `overloaded` keyword was already matched, the bare numeric code was not).
- **The report no longer crashes on a fully-invisible 0% run.** A run where every cell is `mention:'no'` — the reader who needs the report most, the prime consulting lead — could throw mid-render instead of producing the report, when the persisted `adsDetected` block was present but shapeless (an interrupted run or an older schema persists an empty object or a partial record with no numeric counters). The ads-detection section's `totalCellsWithAdSignal === 0` short-circuit was skipped on that shape and it then called `Object.entries(...)` on the undefined provider map. The section now treats any non-conforming `adsDetected` shape as "scan produced no usable signal" and degrades to the honest "scanned, clean" stanza, so the whole report renders and the 0% brand gets a real "0% — here's why and what to do" instead of a crash. A well-formed ad signal still renders the per-engine table unchanged. Regression coverage in `test/fail-branch-guards.test.js`.

### Added

- **Single-key mode** (founder decision 2026-06-11). The hard OpenAI+Gemini wall at init turned away every client with one key before their first taste. Now ANY one research-capable key (OpenAI, Gemini, or Anthropic) is enough to start: query validation and competitor extraction run single-model, competitor mentions are explicitly marked *unverified* (no second model to cross-check), and the CLI says so up front with an upgrade hint. Zero research-capable keys remains the only hard stop — one plain message with platform-aware setup lines. Two keys stay the recommended (and unchanged) path; README/FAQ/JSON-LD updated from "mandatory" to "recommended + single-key minimum".

- **One-round candidate top-up with rejection feedback** (`lib/init/research/topup.js`). When fewer than 3 of the 5 brainstormed candidates pass validation, init runs ONE extra brainstorm round with the previous round's rejection reasons fed back as negative guidance (they were previously computed, printed, and thrown away), validates only the genuinely new texts, and merges passing ones into the pool. Bounded: one round, then the recovery panel fires as before.
- **llm-rejected queries are now auto-recoverable with VERIFIED substitutes.** The old blanket "llm blocker → panel" rule threw away validated alternatives while aborting the whole init. A substitute is verified when its own verdict is `valid:true` + `retrieval-triggered` (`isVerifiedSubstitute`); legacy pool entries without a `valid` field fail closed. Static (acronym) blockers remain terminal.
- **Category compression** (`lib/init/clean-category.js`). `inferCategory()`'s title+meta marketing sentence is compressed to a 2-5 word noun phrase via one tiny classify-tier call — a cleaner brainstorm anchor that also survives the recovery panel's ≤4-word category-filler guard. Falls back to the raw string on any failure.
- **`--auto` degrades gracefully when the site is unreachable**: with `--category` given, init proceeds from brand + domain + category (with a precision warning) instead of aborting; without `--category`, the abort now prints ONE copy-paste next command instead of a wall of options.

### Changed

- **Validator calibration: adjacent-market commercial queries are VALID** (founder decision 2026-06-11). A broader-category query inside the brand's own target vertical (e.g. "best appointment scheduling services for salons" for a salon-configurable conversational booking widget) measures exactly the citation arena the brand competes in. The industry-fit prompt now rejects only wrong-INDUSTRY interpretations, never queries that are merely broader than the brand's product class.

- **`PASTE_PROMPT` rewritten for non-expert readers** (`lib/report/mc-bridge.js`). The paste-into-AI plan prompt now targets a solo founder / "vibe-coder" with zero SEO background: it mandates plain language with every technical term glossed in parentheses on first use, and switches the output from a terse 6-column table to a two-tier format — a short 30-row overview table for tracking **plus** a detailed card per mission (What & why / numbered How steps / Done-when / Time). External-platform missions (Reddit, Hacker News, Product Hunt, Wikidata) must now carry an "Only if:" eligibility line. No CLI / library behaviour change — only the generated plan prompt's wording and required output shape.

## [1.1.4] — 2026-06-06

### Added

- **`## Comparison vs open-source AEO trackers` section in README.** Names geo-aeo-tracker (danishashko) as the closest open-source peer and highlights the paste-into-AI 30-mission plan generator as the structural differentiator.

### Removed

- **`[skip-tests]` commit-message bypass in `.githooks/pre-commit`** and `--no-verify` advice in hook block messages. Founder decision 2026-06-06: tests always run — no skip path for any change type, including docs.

### Fixed

- **Lang-aware footer URLs** (`lib/report/sections.js`, `lib/report/markdown.js`). `sectionFooter` now accepts a `lang` parameter and whitelists it against the 4 webappski.com locales (`en/de/ru/pl`), preventing wrong-locale 404s or unsafe config value interpolation in footer links.
- **`--manual` recovery callout** (`lib/init/validator-recovery.js`). Added a prominent "→ Stuck? Option N below is the reliable fallback — no LLM needed, always works." line at the top of the recovery panel, surfacing the `--manual` escape hatch before the operator reads through the full option list.

## [1.1.3] — 2026-05-25

**Docs-only AEO enrichment release.** Adds answer-capsule paragraphs under every README H2, extends FAQPage schema with 2 new Q/A, promotes the Diagnosis line from blockquote to `### H3` for URL-anchorability, and adds `exampleOfWork` on the SoftwareApplication schema linking both sample plans. Ships pre-commit + pre-push git hooks (`.githooks/`, zero new dependencies). Commits `package-lock.json` for reproducible installs. No CLI / library behaviour changes — `aeo-responses/2026-05-18/_summary.json` data already shipped in 1.1.2 is unchanged.

### Added

- **Answer capsules under every README H2** (Multi-engine coverage / AI-bot crawlability audit / Authority signals / UVI methodology). 40–60 word bolded paragraphs that LLM extractors can grab without parsing the surrounding prose.
- **`### Diagnosis` H3** (was `> Diagnosis` blockquote). Now URL-anchorable as `#diagnosis`; LLMs treat H3s as canonical answer-units. Source `_summary.json` path now in an HTML comment so any future reader can trace the numbers.
- **FAQPage schema extended with 2 new Q/A:** *"What is the UVI (Unified Visibility Index) score?"* + *"What does an aeo-platform output file look like?"* — the two questions a developer needs answered before they install.
- **`exampleOfWork` property on the SoftwareApplication schema** linking to both worked-example sample plans (typelessform.com at UVI 42% and the bare-site brand at 0%). Schema.org `exampleOfWork` is consumed by Google's structured-data graph and helps AI engines surface a CLI tool's actual output, not just its description.
- **Pre-commit + pre-push hooks in `.githooks/`** — run `npm test` automatically on commit / push. Pre-push runs the suite a second time on `main` / `master` for a determinism (flake-detection) check. Zero new dependencies (no Husky / `lint-staged` / `simple-git-hooks`); vanilla bash that runs on macOS and Linux. Auto-installed via `npm install` `postinstall` script (sets `git config core.hooksPath .githooks`; `|| true` so it no-ops in non-git environments like CI containers / Docker).
- Bypass tags: `git commit --no-verify` / `git push --no-verify` OR `[skip-tests]` in the commit message — for typo / doc-only / comment-only changes that don't touch product code.
- **`package-lock.json` now committed** — npm-recommended for reproducible builds across CI / clones / contributors. Does NOT contradict zero runtime deps: `dependencies: {}` still empty, lockfile is metadata. `npm install` on fresh clone now deterministic.
- **`README.md` schema.org `softwareVersion` synced to 1.1.3** + `datePublished` bumped to 2026-05-25. Schema block is consumed by AI crawlers; stale version misrepresents the package.

### Notes on pre-commit tier choice

Pre-commit runs the **full** `npm test` chain (~60 mocked test scripts, ~14-20s wallclock). All tests are local mocked (no live API calls, no costs). This fits industry-standard pre-commit tier (≤30s). No split into `test:fast` is needed — the full suite is fast enough thanks to the zero-dep + mocked design.

## [1.1.1] — 2026-05-20

**Replay mode now skips extractor + sentiment LLM calls too.** 1.1.0 made `--replay` skip live `/v1/models` discovery and the main `provider.call`, but `extractWithTwoModels` + `classifySentimentWithTwoModels` still fired against live OpenAI + Gemini classify endpoints inside the per-cell loop. Under `--network none` (Docker, air-gapped CI) those calls retried DNS errors as transient and hung for the full 30-retry budget. Closes the «lingering caveat» documented in 1.1.0 Notes.

### Fixed

- **`bin/aeo-tracker.js` per-cell loop (~lines 2089–2135, ~26 LOC).** Wrapped `extractWithTwoModels` + `classifySentimentWithTwoModels` Promise.all in `if (!replaySrcDate)`. Under `--replay`, `extraction` resolves to empty shapes (`verified: []`, `unverified: []`, `sources.{primary,secondary}.{model:'', brands:[]}`, zero costInfo) and `sentiment` to `null`. Downstream code at lines 2111–2173 already handles these shapes — `storeSources` evaluates false on empty unverified + no errors, sentiment is already null-guarded.

### Verified

- macOS `npm test` — 21 pass / 1 skip / 0 fail × 3 consecutive runs (regression-clean).
- Docker `node:22-alpine --network none` — 19 pass / 1 skip / 2 fail (was 11 pass / 10 fail before 1.1.1). Remaining 2 failures (P0-13 `run-manual perplexity`, P0-9 `malformed-fixtures exit 3`) share a **different root cause** — the retry classifier in `provider.call` / `extractWithTwoModels` (run-manual path, line 3313) treats DNS-unreachable as transient. Out of scope for 1.1.1; tracked for follow-up.

### Notes

- The second extractor call site at `bin/aeo-tracker.js:3313` (`run-manual` subcommand) is **deliberately not wrapped.** run-manual's whole product purpose is extracting competitors from pasted text — replay-skip semantics don't apply there.

## [1.1.0] — 2026-05-20

**Replay mode is now fully offline.** Prior to 1.1.0, `aeo-platform run --replay` still hit `/v1/models` discovery before falling into the replay seam — which meant fake / missing API keys produced `authError=true` → all providers skipped → exit 1 before any cached response could be read. Users running `--replay` for offline analysis, CI environments without secrets, or air-gapped machines were blocked. Fixed structurally by wrapping the discovery block in `if (!replaySrcDate)`: when `--replay [--replay-from=DATE]` is active, the CLI skips live model discovery entirely and uses `cfg.model` from `.aeo-tracker.json` directly — `_tryReplay` reads cached responses keyed by that model name.

### Added

- **Replay mode requires zero API keys.** `OPENAI_API_KEY` / `GEMINI_API_KEY` / etc. no longer needed when `--replay` is set. CI pipelines can replay cached snapshots without secret management.
- `test/replay-skips-discovery.test.js` — pins the new behavior: replay run with fake keys must NOT call /v1/models, must NOT print «No API keys found», must exit successfully when replay data is valid.

### Fixed

- **`bin/aeo-tracker.js` `cmdRun` restructure (~46 LOC).** `replaySrcDate` resolution moved before the discovery block. When replay is active, builds `activeProviders` directly from `providerConfig` (no auth check, no HTTP). Live mode (no `--replay`) path unchanged. Eliminates the «discovery 401 → skip provider → exit 1» dead-end that made replay unusable with anything but real keys.

### Notes

- **Lingering caveat (not blocker, not fixed in this release):** the per-cell run loop still invokes `extractWithTwoModels` and `classifySentimentWithTwoModels` against live OpenAI + Gemini classify endpoints — replay does NOT yet skip extraction/sentiment LLM calls. Replay with fake keys reaches the replay seam (cache reads succeed) but then errors per-cell during extraction → exit 3, not exit 0. Real keys still required for full clean exit-0 replay. Tracked in `webappski-ops/resources/aeo-platform/PITFALLS.md`.

### Internal

- Phase 0 manual P0-9 verification (test-design-audit methodology) caught the pre-1.1.0 «exit 1 in replay» dead-end before any test code was written. Both v1 audit and v2 re-audit had signed off without verifying the prerequisite — the manual pre-write gate was the catch.

## [1.0.8] — 2026-05-18

**Validator honesty part 2.** 1.0.7 dogfood revealed three connected contradictions in a single recovery-panel render: header claimed «5 of 5 commercial candidates passed», yet recovery fired anyway with blocked queries labelled «non-commercial (search_behavior: retrieval-triggered)» — a contradiction in one line, because retrieval-triggered IS commercial. Real reason was a confidence-threshold gate that rejected `valid:true` queries with confidence < 0.7. This is the same class of bug we fought in 1.0.4 → 1.0.5 → 1.0.6 → 1.0.7: substitution block and main validation using different rules. Closed structurally.

### Fixed

- **Trust `valid:true` LLM verdict; remove confidence-threshold blocking.** `lib/init/research/run-validation.js:186` changed from `!valid || confidence < CONFIDENCE_THRESHOLD` to `!valid`. Real commercial queries routinely score 0.6–0.7 (LLM accounts for alternate meanings); hard threshold rejected good queries. `CONFIDENCE_THRESHOLD` remains defined for prompt guidance + cache audit, no longer applied as a block rule.
- **Substitution uses the SAME rules as main validation.** `bin/aeo-tracker.js` substitution PASS in both main path (~1362) and queries-only path (~817) now checks `verdict.valid === true && verdict.search_behavior === RETRIEVAL`. Pre-1.0.8 only `search_behavior` was checked, allowing `valid:false` queries to slip past substitution and get rejected by main validation downstream. Same-class regression closed across 1.0.4 → 1.0.7 finally fixed structurally.
- **Recovery panel label shows the REAL block reason.** `lib/init/validator-recovery.js` now branches: `valid:false` → «LLM rejected: <reason>», `search_behavior !== retrieval` → «non-commercial», static `message` → message verbatim, else → fallback. Order matters: `valid:false` wins over `search_behavior` (1.0.7 had reverse order, producing the «non-commercial (retrieval-triggered)» contradiction).
- **Recovery panel header shows both counts honestly.** «X of 5 commercial-OK, Y blocked by LLM verdict» when `commercialPassingCount` threaded from cmdInit. Legacy fallback («N query/queries blocked by validator») for paths that don't have the count (e.g. `--keywords` mode).

### Added

- `test/recovery-honest-reason.test.js` (7 cases) — explicit regression guard for the 1.0.7 «non-commercial (retrieval-triggered)» contradiction. Covers `valid:false`, parametric, mixed, static-issue, and the defensive fallback.
- `test/recovery-honest-header.test.js` (5 cases) — header text honesty: both counts shown, legacy fallback, 1.0.7 regression guard.
- `test/silent-substitute.test.js` extended (Cases 6–7) — `valid:false + retrieval` correctly FAILS substitution; `valid:true + low confidence` PASSES (trust-valid rule).

### Internal

- Plan went through REV 1 (APPROVED WITH NITS — 4 minor): dead-branch removal in header, fail-closed comment for missing `valid` field in legacy cache, mirror-rules update in test scaffold, CHANGELOG documentation.
- cli-walkthrough skill probe added (mental): substitution and main validation MUST apply identical criteria. The whole 1.0.4–1.0.7 saga was this single class of bug.

## [1.0.7] — 2026-05-18

**OpenAI search-variant hotfix + live-rows UX clarity.** 1.0.6 cannot complete a single `run` with `gpt-5-search-api` (the default OpenAI model) — every cell fails with HTTP 400 "Unrecognized request argument supplied: reasoning_effort". Plus operators have no signal of what `firing` / `60s pacing` means or how to abort.

### Fixed

- **`SUPPORTS_REASONING_EFFORT` whitelist** in `lib/providers/openai.js` now excludes any model ID containing `search`. Search-variant models (`gpt-5-search-api`, `gpt-5-mini-search-api`, `gpt-4o-search-preview`, and future `gpt-N-search` / `oN-search`) are stripped-down RAG-tuned and reject `reasoning_effort` with HTTP 400. The previous whitelist passed all `gpt-5*` models indiscriminately. Every OpenAI cell now completes on a 1.0.6-style config.
- **`test/openai.test.js` rewritten** — two existing tests (`gpt-5-search-api` and `gpt-6-search-api` future-proof) codified the bug as correct behaviour (asserted `reasoning_effort` should be in the body). Now assert the field is dropped at the gate. Plus 2 new tests for `gpt-5-mini-search-api` (drop) and `gpt-6` non-search (still includes).

### Changed (UX)

- **Live-rows status labels rewritten** for operator clarity. `firing…` → `calling provider API (network in-flight)`. `60s pacing` → `TPM rate-limit — 60s until token-bucket refill`. Cooldown message includes `post-429 backoff` context.
- **Live countdown** during `cooldown` / `ledger-wait` states. Operator sees seconds tick down in real time (`60s → 59s → 58s …`) instead of a static label that looks frozen. Computed from absolute `deadlineMs` so it's drift-immune if the render loop falls behind.
- **Abort hint** added at top of live region: `(running N cells across M providers — press Ctrl+C to abort cleanly)` (TTY mode only). SIGINT handler already cleans cursor; this just documents the affordance.

### Added

- `test/live-rows-countdown.test.js` (5 cases) — synthesises cooldown/ledger-wait events, asserts the countdown ticks tick by tick and stale countdowns clear on transition back to `running`/`done`/`error`.
- SIGINT handler in `lib/util/live-rows.js` now flushes buffered token-cost logs (gated on `AEO_LOG_TOKENS=1`) before exit so they aren't lost on Ctrl+C.

### Internal

- Plan went through Step 2 REV 1 (REVISION — fictional `buildOpenAIRequestBody` reference; `update()` drops arbitrary fields; SIGINT didn't flush logBuffer) → REV 2 (APPROVED). cli-walkthrough Pass 4 from 1.0.6 surfaced 11 latent issues for 1.0.7 backlog; 3 of them remain queued (config validation in cmdRun, --keywords comma escape, --replay schema-version).

## [1.0.6] — 2026-05-18

**Commercial-only pipeline with silent substitution.** Retires the 4-bucket query generation (commercial / problem / vertical / comparison) in favour of a focused commercial-only pipeline that over-generates (5 candidates for 3 slots), validates all 5 at init time, and silently substitutes failing queries with passing spares. The recovery panel fires ONLY when fewer than 3 of 5 commercial candidates survive validation — the genuine impossibility case. Closes the entire trust-failure class that recurred from 1.0.2 through 1.0.5 (recovery panel suggesting commands that the CLI itself rejected): the upstream cause (mixed-intent queries blocked by the downstream commercial-only validator) is removed rather than patched around.

### Fixed

- **Recovery panel no longer suggests rejected commands.** The dogfood failure mode from 1.0.5 (`voice form widget versus conversational form builder` rendered as `(validated)` by Fix A, then re-blocked as `search_behavior: mixed` when copied into `--keywords`) is now impossible by construction: every query in the pool is commercial-intent by design, and all 5 are validated at init through both validator stages. The substitution block silently swaps any top-3 failure with the highest-score passing spare. Operator sees only the final 3 commercial queries; recovery panel is the genuine last resort.

### Changed (architecture)

- **`lib/init/research/brainstorm.js`** — `INTENT_BUCKETS = ['commercial']` (was the 4-bucket model). Brainstorm prompt rewritten to ask for 5 commercial vendor-listing queries in one LLM call. Output shape preserves `buckets.problem/vertical/comparison` as empty arrays for backward-compatibility with consumers that destructure by bucket name. `TARGET_TOTAL_MIN = 5` (was implicit 10).
- **`lib/init/research/select.js`** — `selectTopThree` now picks top-3 by score from the validated commercial pool. Dropped `REQUIRED_INTENTS`, `FALLBACK_CHAIN`, `verticalDominance` (intent-diversity logic was vacuous with all-commercial input).
- **`lib/init/research/research.js:94`** — filter threshold lowered from `< 6` to `< 3` (5-candidate brainstorm output, not the legacy 20-candidate). Removed `checkVerticalDiversity` call (emitted spurious warning when `vertical` no longer in `INTENT_BUCKETS`).
- **`bin/aeo-tracker.js::cmdInit`** — replaced 1.0.4 Fix A pool-validation + 1.0.5 top-up with a single silent-substitution block that validates all 5 candidates through both stages, splits passing/failing, and swaps top-3 failures with passing spares. Same logic mirrored in the `--queries-only` branch.
- **`lib/init/validator-recovery.js`** — recovery panel header now reads "Cannot auto-recover — only X of 5 commercial candidates passed validation" when `commercialPassingCount` is threaded from cmdInit. Legacy wording when the param is absent (`--keywords` mode).

### Removed

- **`lib/init/research/pool-topup.js`** — 1.0.5 top-up module made obsolete by over-generation. Deleted along with `test/pool-topup.test.js` and the `test:pool-topup` script.

### Added

- **`test/brainstorm-commercial-only.test.js`** (9 cases) — negative-regression guard asserting `INTENT_BUCKETS === ['commercial']`, `flat.every(c => c.intent === 'commercial')`, prompt asks for commercial only, and output preserves empty non-commercial buckets for backward-compat.
- **`test/silent-substitute.test.js`** (5 cases) — exercises substitution logic: all 5 pass → unchanged, 1 fails → swap with first spare, 2 fail → swap both, 3 fail → no substitution (recovery panel fires), empty verdicts → graceful degrade.

### Internal

- Architectural rule saved as `memory/project_commercial_only_over_generate.md`: AEO query archetypes are commercial-intent category-based queries, exclusively. Generates 5 (3 needed + 2 spares), validates all, silent-substitutes from spares, surfaces recovery panel only on genuine impossibility (<3 of 5 pass).
- Plan at `docs/plans/1.0.6-commercial-only-over-generate.md` went through REV 1 (REVISION NEEDED — 9 architect remarks incl. 2 BLOCKERs: `research.js:94` threshold would always throw, recovery header formula was math-wrong) and REV 2 (APPROVED WITH NITS). Implementation passed Step 4 architect review.

## [1.0.5] — 2026-05-18

**Pool top-up follow-up to 1.0.4.** Validator-honesty contract is now defended at TWO layers (in addition to the 1.0.4 mutation in `formatSelection`): top-up generation in `cmdInit` and a safety net in `formatRecoveryPanel`.

This release supersedes never-published `1.0.4` — see «Note on 1.0.4» below.

### Fixed

- **Pool top-up when initial validation under-fills (self-sufficient recovery).** 1.0.4 Fix A could leave the validated-pool at 1 or 2 RETRIEVAL queries when `inferCategory()` returned a long marketing string AND fewer than 3 alternatives survived commercial-only. The recovery panel's option-1 `--keywords` command would then have <3 items, which the CLI's own precondition rejected — the exact trust failure class 1.0.4 was meant to close, surviving in cells D (pool=1+unclean) and F (pool=2+unclean) of the 4×2 matrix. New module `lib/init/research/pool-topup.js`: when initial pool validation produces <3 RETRIEVAL queries, the tool autonomously generates the missing queries via a single dedicated LLM call (~$0.002-0.005 one-time per init), validates them through both stages, and appends RETRIEVAL passes to the pool. Top-ups carry `topUp: true` in the persisted pool for traceability. Hard cap of 1 top-up attempt per init prevents loops.
- **Safety net in `formatRecoveryPanel`.** `showOption1 = finalQueries.length === 3` — even if top-up itself silently no-ops (no provider, LLM error, all rejected), the panel never emits an invalid suggested command. Defence-in-depth: top-up handles the happy path; the safety net handles every degraded case.

### Added

- New `cli-walkthrough` skill at `.claude/skills/cli-walkthrough.md` — pre-publish exhaustive simulation of every CLI command across the realistic input matrix (recovery-panel 4×2 cells included). Wired into `/release-flow` as Step 4c. **Caught the cells D and F regression before this release reached npm — first run of the skill.**
- `/release-flow` skill gained Step 3b: mandatory `package.json` version bump in the same commit as the code change. Every published artefact = unique version. (We're paying respect to the rule by jumping 1.0.4-internal → 1.0.5 even though 1.0.4 never reached npm.)
- New `test/pool-topup.test.js` (11 unit cases) for the top-up generator. 8-cell matrix in `test/validator-recovery-pool-filter.test.js` (cells A–H) asserting option 1 either has exactly 3 `--keywords` items or is fully suppressed. `test/suggested-commands-resolvable.test.js` extended with a per-suggestion `--keywords` item-count assertion (static-grep flags any literal with !=3 items).

### Note on 1.0.4

The 1.0.4 commit (`4a2214b`) was authored 2026-05-18 with the validator-honesty work documented in `## [1.0.4]` below, but `cli-walkthrough` ran before `npm publish` and flagged the cells-D/F matrix regression. 1.0.4 was never registered with npm; this `1.0.5` is the first release published from the validator-honesty branch. The 1.0.4 CHANGELOG entry stays as-is for git-history fidelity.

## [1.0.4] — 2026-05-18 (NEVER PUBLISHED — see 1.0.5)

**Validator-honesty hotfix.** Three P0 bugs surfaced during 1.0.3 dogfood on `typelessform.com` (a new brand the LLM has no context for). Every suggested-fix command in the validator-recovery panel was either rejected by the validator on the next run, or fabricated brand-comparison queries that LLMs autocorrect to a different brand's category.

### Fixed

- **`(validated)` tag now means both validator stages passed.** Previously the Alternatives pool was tagged `(validated)` after the category-validation step only — the LLM industry-fit / commercial-only stage never ran on pool entries. When the operator copied those queries via the suggested `--keywords` command, the commercial-only stage re-blocked them on the next run. Now: at init time, immediately after `selectTopThree`, pool entries pass through a dedicated `runTwoStageValidation` pass (~1 batched LLM call, ~$0.001-0.002 per init). The `search_behavior` verdict mutates onto each alternative, the user-facing `(validated)` label in `formatSelection` checks BOTH stages, the persisted `.aeo-tracker.json::candidatePool` carries the verdict, and the recovery panel filter uses real data. Single-provider mode is supported (secondary: null). On validator error or no-provider mode, the panel degrades gracefully (no `search_behavior` ⇒ pass-through, the legacy 1.0.3 behaviour). Applied symmetrically in the `--queries-only` / `--add-queries` / `--replace-queries` branch with cache-hit honouring against `existing.validationCache`.
- **Recovery panel filler templates switched from brand-archetype to category-archetype.** The old `best ${brand} alternatives 2026` / `top ${brand} competitors` / `${brand} vs alternatives` templates only worked for brands the LLM already knew. For new brands the LLM autocorrected the brand name (`typelessform → Typeform`) and returned competitors of the autocorrected target — guaranteed blocked by the commercial-only check. New fillers are domain-agnostic: `best ${category} 2026` / `top ${category} tools` / `${category} platforms`. A length-guard (≤4 words) suppresses fillers when category is empty or a long marketing sentence (typical of `inferCategory()` output) — the panel honestly says so instead of rendering invalid English. Architectural rule documented in `memory/project_query_archetypes_category_based.md`.
- **Recovery panel now offers a `--manual` interactive escape hatch.** Previously, for a new brand, every `--yes` path could be blocked by validators — leaving operators with only `--force` (labelled "degrades trend data"). The panel now lists, as **option 3** (above `--force`), the always-works escape: `aeo-platform init --brand=X --domain=Y --manual` (no `--yes`, interactive query prompts). `--force` demoted to option 4.

### Added

- New test `test/validator-recovery-pool-filter.test.js` (4 cases) — verifies the COMMERCIAL_OK filter, including the documented info-loss exception for legacy cache entries that lack `search_behavior`.
- `test/validator-recovery.test.js` rewritten at the affected cases (architect REV 2 caught that this was a rewrite, not an extension): old brand-filler assertions deleted; new category-filler, no-category-suppression, long-sentence-guard, and `--manual`-ordering cases added.

### Internal

- Architectural rule saved as `memory/project_query_archetypes_category_based.md`: AEO query archetypes are category-based ("best X for Y") the way real users search, NOT brand-comparison ("X vs alternatives"). Brand-comparison archetypes only work for brands the LLM already indexes — exactly the brands that don't need AEO tracking.
- Architect-review skill at `.claude/skills/release-flow.md` expanded (Step 2 + Step 4) with a mandatory "scenario-wide audit" duty: trace data flow beyond cited file:line, enumerate 3-5 user scenarios per fix with verdicts (helped/unchanged/newly-broken), explicit no-op-fix check, codify-the-bug detection. This release caught the dead-code Fix A under the new duty before any implementation started.

### Known limitations (deferred)

- `--yes --manual` with no pre-configured queries still errors (`bin/aeo-tracker.js:1350-1353`). Workaround: drop `--yes` per Fix C.
- UX redesign of validator output, auto-substitute in `--yes`, placeholder-domain hint, CLI hygiene pass (`--json` / `--verbose` / exit codes), README quickstart `--keywords` mention — all deferred per `docs/roadmap.md`.

## [1.0.3] — 2026-05-18

**Trust-restoration patch.** Fixes a systemic class of bug where the CLI's error panels suggested commands that the CLI's own precondition checks would reject. Plus four smaller fixes flagged during the same director-level audit.

### Fixed

- **`--yes --keywords="..."` now works without `--auto`/`--manual`.** Previously the precondition at `cmdInit` rejected `--keywords` despite the downstream code handling it as a valid third mode. The `validator-recovery` panel and the `research-failure` panel both suggested commands using `--keywords` — those suggestions now run as intended.
- **`research-failure-panel.js` env-unset fallback** suggested `--auto`, which would re-trigger the same provider failure that prompted the panel. Now suggests `--manual` so the operator can actually recover.
- **`unexpected-error-panel.js` config-issue panel** offered only `--auto` as the regenerate-config path. Now lists both `--auto` (LLM brainstorm) and `--manual --keywords="q1,q2,q3"` (zero LLM cost) as parallel options.
- **`validator-recovery.js` `--force` path** moved from option 2 to option 3 with a visible yellow warning explaining trend-data degradation. The `--category` hint promoted to option 2 since it is a real solution, not an escape hatch.
- **`Blocked:` list deduplication.** A single query that tripped both the LLM industry-fit check and the commercial-only check no longer appears twice in the rendered output. The headline count matches the rendered list.
- **`Configured providers:` line printed twice** on consecutive output lines during `init`. The duplicate concatenation has been removed; only the standalone line remains.
- **`run-manual` silent partial runs.** `aeo-platform run-manual perplexity --from-dir ./responses` no longer silently skips missing `qN.txt` files. A pre-flight check lists missing files and exits before any work begins — including before the OpenAI+Gemini extractor key check, so operators get an instant diagnostic.
- **`diff --since=DATE` raw error when DATE not in snapshots.** Now prints the available dates inline (`Available dates: 2026-05-04, 2026-05-11, …`) so the operator does not have to `ls aeo-responses/` separately.
- **`crawl-stats` memory exhaustion on large access logs.** Switched from `readFile` (entire file into heap) to `createReadStream` + `readline` for line-by-line streaming. Memory is now O(1) regardless of log size. A 500MB log runs to completion on a default Node heap. Files over 100MB get a `Streaming Nmb log — this may take 30-60s` hint.

### Added

- **Static-grep invariant test** (`test/suggested-commands-resolvable.test.js`). Scans every `aeo-platform init --yes` string literal in `lib/errors/` and `lib/init/` and fails CI if any one is missing a mode flag (`--auto`, `--manual`, or `--keywords`). Glob-based — future panels are auto-covered. Catches the regression class that produced the 1.0.2 trust failure.
- **Three regression tests** in `test/cli-smoke.test.js`: `--yes --keywords` precondition acceptance, error-message-lists-all-three-modes, and `run-manual` empty-directory hard-fail.
- **Dedup test** for `formatRecoveryPanel` (`test/validator-recovery-dedup.test.js`) — 4 cases covering same-behaviour collapse, specificity tiebreak, message-loss-is-acceptable, and distinct-query preservation.
- **Internal `AEO_TRACKER_DRY_RUN=1` env flag** short-circuits `cmdInit` right after the precondition gate. Used by the regression test suite to keep CLI smoke tests deterministic (no DNS, no filesystem touches). Not documented in `--help`.

### Internal

- New `release-flow` workflow in `.claude/skills/release-flow.md` — every non-trivial release now passes two independent architect-review gates (plan review + implementation review) before shipping. This release was the first to follow it: plan went through 3 revisions before approval.
- Maintainer-side TODOs and audit findings now live in `docs/roadmap.md` and `docs/plans/<version>-<slug>.md`. GitHub Issues remain reserved for user reports.

### Known limitations

- `[ux] Validator output reads as fatal crash` — full visual redesign (red ✗ → tilde, "Cannot auto-recover" → "Almost there", letter-keyed alternatives, cargo-style colour palette) deferred to **1.0.4** per the 3-persona review documented in `docs/roadmap.md`.
- `[enhancement] Auto-substitute in --yes mode` — deferred to **1.0.4**, depends on the UX redesign landing first.
- `[ux] Placeholder-domain hint` (detecting copy-paste of `YOURDOMAIN.COM` from the README) — deferred to **1.0.4**.
- Corporate-proxy `HTTPS_PROXY` support — on the **1.0.5+ roadmap** (requires undici `ProxyAgent` wiring).

## [1.0.2] — 2026-05-18

**Provider resilience layer + cross-platform stdin/readline fix.** Two independent fix tracks bundled into one release: (1) the «readline was closed» crash during `init --auto --strict-validation` is fully eliminated by centralising stdin/readline ownership in a single module, and (2) every provider call now goes through a TPM-aware retry/scheduler layer that survives bursty 429 / overload / network errors instead of failing the whole run.

### Fixed

- **`readline was closed` mid-`init`.** Previously two readline interfaces could be created on the same `process.stdin` (one in `cmdInit`, one in `runValidationFlow`), and an unconditional `close()` at one branch tore down the other. Now `lib/util/prompt.js` is the single owner of stdin — the top-level dispatcher creates one prompter and threads it into both commands. 18 ad-hoc `closeRl()` calls removed from `bin/aeo-tracker.js`.
- **`ReferenceError: ask is not defined` in `run --depth=auto`.** The depth-auto branch referenced an `ask` symbol that existed only inside `cmdInit`. Resolved by routing every prompt through the injected `opts.prompter`.
- **Parallel readline in `runValidationFlow` removed.** The validator no longer spawns its own `createInterface`; it reuses the prompter passed by the dispatcher.
- **Non-TTY auto-detection.** `echo "y" | aeo-platform init` no longer touches readline at all — when `process.stdin.isTTY` is false, prompts return their default values silently.
- **External-close detection.** Ctrl+D or a broken pipe now produces a readable error («Input stream closed (Ctrl+D or pipe end) — cannot prompt further») instead of `ERR_USE_AFTER_CLOSE` or a hang.
- **Bursty 429 / `Retry-After` ignored.** OpenAI's `Retry-After: 140ms` was previously hit with the old 3-attempt cap and gave up in ~420ms. The new budget-based retry waits up to `RATE_LIMIT_MAX_WAIT_MS` of wall-clock (default ~5min) before surrendering, honouring the parsed `Retry-After`.
- **CRLF/LF diff noise on Windows contributors.** `.gitattributes` now forces `eol=lf` on all text files (with explicit `crlf` for `*.cmd`/`*.bat`/`*.ps1`), preventing the round-trip where Git on Windows rewrites LF→CRLF on checkout and pollutes diffs.

### Added

- **Provider resilience layer** (`lib/providers/_retry.js`, `tpm-ledger.js`, `rate-limits.js`, `lib/util/scheduler.js`).
  - **TPM ledger:** sliding 60-second window tracking tokens-per-minute per provider; learns provider limits from parsed 429 bodies (OpenAI emits structured `Limit X, Used Y, Requested Z`); blocks the next request if the projected budget would exceed the learnt limit.
  - **Cooldown gate:** honest cooldown computed as `now − firstTokenInWindow + safety` instead of a fixed 30s sleep, so we re-enter exactly when the oldest token leaves the rolling window.
  - **Retry classification:** errors split into `rate-limit` (budget-based retry, up to ~5min total wall-clock) vs `overload` (fast 2s loop with ±500ms jitter, capped at 5 attempts) vs permanent (auth, billing, 4xx, malformed).
  - **Per-provider concurrency semaphore:** prevents one provider's stampede from starving another's budget.
- **`lib/util/fetch-with-timeout.js`** — uniform `AbortSignal.timeout()` wrapper with a fallback for Node 20.0–20.2 (where `AbortSignal.any` is missing). Distinct default budgets for `bootstrap` (30s) / `runtime` (60s) / `site` (15s) calls.
- **`lib/util/prompt.js`** — single owner of `process.stdin` and `readline.createInterface` for the entire CLI. Lazy: never creates a readline in non-interactive mode. Auto-non-interactive when stdin is not a TTY. Safety-net `process.on('exit')` closes any open readline synchronously.
- **`lib/util/live-rows.js`** — live-updating per-engine status table in the terminal (TTY mode) with ASCII fallback for legacy Windows ConHost; detects Windows Terminal via `WT_SESSION` and VSCode/iTerm via `TERM_PROGRAM`; restores cursor on `SIGINT`/`exit`.
- **`lib/util/open-browser.js`** — cross-platform browser launcher: `cmd /c start "" url` on Windows, `open` on macOS, `xdg-open` on Linux, all detached + `stdio: ignore` + `unref()` so the CLI exits cleanly.
- **`lib/util/safe-filename.js`** — sanitises engine/query strings before they hit `aeo-responses/`: strips Windows-reserved characters (`<>:"/\\|?*`), reserved names (`CON`/`NUL`/`AUX`/…), and control codes.
- **`lib/util/cost-estimate.js`** — per-run cost projection shown during `init` and at the start of `run`, derived from the active model pricing table and per-cell token estimates (calibrated against AEO_LOG_TOKENS=1 runs).
- **`lib/providers/main-options.js`** — per-provider main-call options (reasoning effort, thinking budget, etc.) centralised so the four provider modules stop drifting.
- **`lib/providers/discover.js` overhaul** — paginated/retried model enumeration for all four providers; falls back to the previous-known model when the bootstrap query itself rate-limits, instead of dying with «discover failed».
- **README quickstart blocks for PowerShell and CMD** alongside the existing bash/zsh instructions for first-time Windows users.

### Tests

- New test files (≈1500 lines of assertions): `prompt-lifecycle.test.js`, `no-stray-readline.test.js`, `live-rows.test.js`, `tpm-ledger.test.js`, `rate-limits.test.js`, `scheduler.test.js`, `discover.test.js`, `openai.test.js`, `anthropic.test.js`, `main-options.test.js`, `fetch-with-timeout.test.js`, `cli-smoke.test.js`, `depth.test.js`.
- **Architectural invariant test** (`test/no-stray-readline.test.js`) fails CI if any file outside `lib/util/prompt.js` touches `createInterface` or `process.stdin.on/once/read/resume/pause` — locks in the singleton ownership pattern.

### Known limitations (intentional, not blocking)

- `_retry.js` and `classify-error.js` do not match a raw HTTP 408 status by number. Most 408-equivalent failures still flow through `ETIMEDOUT` / `fetch failed` / `socket hang up` which are matched. If you see a literal `408` from a provider, retry-by-hand is the workaround.
- Gemini API key is passed in the request URL (per Google's own examples) rather than via `x-goog-api-key` header. The CLI runs locally on the user's machine, but reverse proxies or shared shells will see the key in their connection logs.

## [1.0.1] — 2026-05-14

Republish of `1.0.0` with the `version` field bumped after a stale-tag accident on npm. No code or behaviour changes.

## [1.0.0] — 2026-05-13

**Renamed: `@webappski/aeo-tracker` → `aeo-platform`.** The «tracker» name described only the measurement layer; the tool now spans measure → audit → diagnose → recommend → plan-generate → track. The new package name reflects the full scope.

### Breaking changes

1. **npm package name changed** from `@webappski/aeo-tracker` to `aeo-platform` (bare, unscoped). Existing `npm install @webappski/aeo-tracker` will continue to install the old package but will receive NO new versions on that name. Migrate with:

   ```bash
   npm uninstall -g @webappski/aeo-tracker
   npm install -g aeo-platform
   ```

   Project-dependency users with `^0.3.0` caret in `package.json` will stay on the old buggy 0.3.x branch — manually edit `package.json` to `"aeo-platform": "^1.0.0"`.

2. **CLI command `aeo-tracker` preserved as a built-in alias.** Both `aeo-platform run/init/report` and `aeo-tracker run/init/report` work. Existing scripts and muscle memory unaffected. New documentation prefers `aeo-platform`.

3. **`engines.node` bumped** from `>=18.0.0` to `>=20.0.0` (Node 18 reached EOL April 2025; `pnpm` with `engine-strict=true` refuses install on EOL Node).

4. **Old package `@webappski/aeo-tracker` will be deprecated** on npm 2-4 weeks after `aeo-platform@1.0.0` reaches stability. A patch release on the old name (`0.2.8`) will replace `latest` dist-tag with a stable 0.2.7-based codebase + redirect banner README, so default installs of the old name get a working tool with migration guidance.

### What stays the same

- All CLI command names and flags (via the `aeo-tracker` bin alias)
- All configuration files (`.aeo-tracker.json`)
- All API surfaces (`_summary.json` schema, raw response paths)
- Raw response folder structure (`aeo-responses/YYYY-MM-DD/`)
- Report output folder structure (`aeo-reports/YYYY-MM-DD/`)

**What changed:**

- Package name: `@webappski/aeo-tracker` → `aeo-platform` (bare, no scope)
- New canonical CLI command: `aeo-platform` (alongside backward-compatible `aeo-tracker`)
- `engines.node`: `>=18.0.0` → `>=20.0.0` (Node 18 reached EOL in April 2025; `pnpm` with `engine-strict=true` refuses install on EOL Node)
- README rewritten: hero positions the tool as an AEO/GEO **platform** (audit + diagnose + recommend + plan), not just a tracker
- Maintainer byline updated: Webappski (Organization) + Alex Isa (lead maintainer) — replaces prior personal byline
- Competitor pricing claims removed from README and docs (we describe pricing **model**, not specific amounts — those shift and are not ours to publish)
- Render fixes from the 0.3.x feature release bundled in (see «Bundled fixes» below)

**Migration path for existing users:**

- `npm i -g aeo-platform` — install the new package
- Old `@webappski/aeo-tracker@<1.0.0`: `npm deprecate` flag (eventually) will display a redirect notice on install
- Same-day stable patch on the old name (`@webappski/aeo-tracker@0.2.8`) repoints `latest` dist-tag from buggy `0.3.x` back to the proven `0.2.7` codebase, with a redirect README. Pinned consumers of `0.3.x` are unaffected
- Project-dep users with caret `^0.3.0` stay on the buggy `0.3.x` branch — manually edit `package.json` to `"aeo-platform": "^1.0.0"`

**Bundled fixes (from agent-pass audit work):**

- UVI breakdown popover (`<details>` with `ⓘ` icon) — exposes per-axis math (presence/sentiment/rank/citation, applied weights, contribution, re-norm banner when components null)
- Rank-component honest handling: when no cell has position data, rank is excluded and weights re-normalised; no more hardcoded `50/100` phantom value
- Sentiment composite excludes low-confidence «neutral» tie-breaks; displays effective sample size `n=K high-confidence cells`
- Two-model competitor extractor: category-grounded prompt; retailers-mentioned-as-customers (Amazon/Walmart/Starbucks) no longer flagged as competitors; cross-check splits unverified into a separate bucket with dashed badge
- «Actionable Gaps» section respects the dashed badge for unverified competitors and uses a softened «Cross-check this cell» action
- Outreach denylist hardened: bare-apex entries for developer-hosting domains (`github.io`, `gitlab.io`, `netlify.app`, `vercel.app`, `glitch.me`, `pages.dev`, `web.app`, `firebaseapp.com`); trailing-dot + `www.` normalisation
- Own-domain filter strips `:port`, `?query`, `#fragment` suffixes; LLM action prompts filter own-domain before assembly (no more self-pitch)
- Hero «Citations earned» KPI renamed to «Lift opportunities» with honest framing (the metric measures «cited but not named» — a lift opportunity count, not total citations)
- «Discoverability Score» renamed to «AI-Bot Crawl Readiness» with a caveat that it measures technical access, not actual visibility in AI answers
- «UTM-Tagged Citations» renamed to «Engine-Auto-Tagged Citations» with honest framing (the UTMs are auto-appended by AI engines, not user-configured)
- Trend chart suppressed below 4 runs (statistical noise floor); topic clusters suppressed below 3 (no meaningful clustering at N=1)
- competitorPricing section suppressed when ≥80% of rows are `tier: unknown`
- regionContext block suppressed when `--geo` was not used
- «How your score compares» anchoring baselines removed (no sourced methodology behind the bands)
- Engine-specific actions cards now pull from actual run citations (per engine), with generic playbook only as fallback when an engine has zero citations
- Industry-mismatch panel fires only when ≥30% off-share AND ≥70% of off-category verdicts are `confidence: high` (no more false-positive panel on classifier failures)
- mc-metadata `scores` and `perEngine` delegate to `computeUVI` byte-for-byte (the paste-into-AI JSON brand-context block now matches the markdown UVI exactly)
- Radar polygon Mentions axis uses verified count (`topCompetitors[i].count`); no more discrepancy between bar chart and radar
- Cross-run delta: provider absent in previous run reports «new this run» instead of a fabricated −67pp regression; method-change between runs tagged `mixedMethod`

**Tests:** +95 new test assertions across 8 new files; 30+ test suites pass.

**Why now:** at 101 weekly downloads we are well below the 1500-DL break-even where rename cost compounds; renaming after that point loses real signal. Two independent senior npm-migration audits confirmed the timing.

## [0.3.2] — 2026-05-13

**Re-publish of 0.3.1 with the full intended file set.** The original `npm publish` for `[0.3.1]` packed the working tree before the complete staging was finalised — the tarball missed `lib/report/own-domain.js` (new module) and likely additional parallel-diff fixes that depend on it (`outreach-templates.js::filterOwnDomainFromTopDomains`, `sections.js::topCitedHostsForProvider`/`isDenyListedOutreachHost`, the additive `_summary.json::scores` sub-component fields).

`[0.3.1]` is published on npm but technically broken: `test/own-domain.test.js` references `lib/report/own-domain.js` which is not in the tarball, and the four downstream call-sites that should filter own-domain from outreach surfaces silently fall back to the pre-fix behavior. 0.3.2 is a same-day patch shipping the complete intended `[0.3.1]` scope.

### Fixed (vs published 0.3.1 tarball)

- Ships `lib/report/own-domain.js` (the dependency missing from 0.3.1).
- Ships the full sections.js refactor (own-domain filtering in 4 surfaces, AI-Bot Crawl Readiness rename, sectionBaseline placeholder, UTM by-origin split).
- Ships the mc-metadata.js additive schema expansion (`scores.{presence,sentiment,rank,citation,sample,sentimentSample,rankSample}` + per-engine breakdown).
- Ships the 7 new test files referenced by the [0.3.1] CHANGELOG entry.

### Unchanged

- `[0.3.1]` CHANGELOG entry below describes the intended scope of both releases. No new features in 0.3.2 vs the documented 0.3.1 scope — this is strictly a re-publish to fix the incomplete tarball.

## [0.3.1] — 2026-05-13

Patch release on top of v0.3.0. Two themes: (a) closing the docs-vs-reality drift flagged by an independent persona review (solo founder / agency operator / B2B SaaS lead) — outreach kill-switch was documented as a working feature in 5+ places; (b) fixing a real dogfooding bug where AI suggested the user pitch their own brand, plus surfacing the UVI sub-components for clients consuming `_summary.json` directly. **No breaking changes** — CLI surface unchanged, config schema unchanged, `_summary.json` schema additively extended (consumers reading 0.3.0 fields still work).

### Fixed — own-domain pitching bug (real dogfooding regression)

A run on `typelessform.com` had `topCanonicalSources[]` led by the user's own domain (because AI engines already cite their pages). Without filtering, four downstream surfaces targeted that own domain for outreach:
1. «Actionable Gaps» «What to do» column → *"Get listed on typelessform.com"*
2. «Where to get mentioned» table → first row was typelessform.com
3. «Outreach Email Templates» → drafted *"Hi Typeless Form team"* email
4. «Actions this week» → *"Pitch a guest post on typelessform.com"*

All four surfaces now filter own-domain (incl. www-prefix and any subdomain). Centralised in a new shared module so the four call-sites use the same canonicalisation + subdomain-spoof guard (`foo.com.evil.com` is **not** treated as a subdomain of `foo.com`).

- New module: `lib/report/own-domain.js` — pure helpers `normaliseOwnDomain(host)` and `isOwnDomain(host, ownDomain)`. Handles scheme strip / `www.` strip / trailing slash / path / query / fragment / port. 30 unit tests in `test/own-domain.test.js` including the spoof guard.
- New helper `outreach-templates.js::filterOwnDomainFromTopDomains` — drops own-domain before drafting outreach.
- New helper `sections.js::topCitedHostsForProvider(results, provider, ownDomain, …)` — provider-aware top-host extractor that respects own-domain.
- New helper `sections.js::isDenyListedOutreachHost` — deny-list for hosts that should never be outreach targets (review platforms, search engines, social — additional to own-domain).
- `bin/aeo-tracker.js` post-run summary now uses `externalSources` instead of raw `topCanonicalSources` when surfacing pitch targets to the operator.

### Added — UVI sub-components in `_summary.json::scores`

Previously, `_summary.json::scores` exposed only `uvi` (composite 0–100). Consumers reading `_summary.json` directly (BI pipelines, paste-into-AI brand-context block, downstream dashboards) had no way to see *why* a UVI moved between runs. Now `scores` additively exposes:

- `presence`, `sentiment`, `rank`, `citation` — the 4 sub-components UVI is computed from (each 0–100).
- `sample`, `sentimentSample`, `rankSample` — denominators used to compute each sub-component, so consumers can tell a sub-score apart from "not enough data yet" cases.
- `scores.perEngine[].{presence, sentiment, rank, citation}` — same breakdown per engine, so the paste-into-AI 30-mission plan generator can ground recommendations in which engine is the weakest on which axis.

Schema change is **additive only**. 0.3.0 consumers that read `scores.uvi` keep working without changes. New fields are computed inside `lib/report/mc-metadata.js::scores()` using helpers from `lib/report/visibility-index.js`.

### Added — sections.js refinements

- `sectionBaseline()` — placeholder section for the first run, when historical comparisons can't be computed yet. Surfaces "what to expect next week" instead of empty blocks.
- `trendNotYetPlaceholder(runCount)` — friendlier copy when the 8-week trend chart can't render (auto-replaces stale "Flat at zero" placeholder).
- `splitUtmByOrigin(utm)` — separates UTM citations into own-domain vs external buckets so the UTM section doesn't conflate "your link got cited" with "someone else's link got cited".
- `isSignalBearingSentiment(s)` (in `lib/report/visibility-index.js`) — guards UVI sentiment sub-component against `null` / `'unknown'` sentiment labels that would otherwise pollute the average.

### Added — coverage tests for previously-untested surfaces

7 new test files (~600 LOC), all green on `npm test`:

- `test/own-domain.test.js` — 30 unit tests for the new pure helpers, including subdomain-spoof safety.
- `test/diff.test.js` — `lib/diff.js` delta computation.
- `test/sections-recommendations.test.js` — actions section grounded in real data fields.
- `test/sections-copy.test.js` — guards against stale or misleading prose in section renderers.
- `test/sections-data-integrity.test.js` — verifies sections never reference undefined `summary.*` fields.
- `test/report-empty-blocks.test.js` — verifies empty-block placeholders render without crashing on first-run data.
- `test/mc-metadata-scores.test.js` — guards the new sub-component schema (regression test for the additive expansion).

### Fixed — documentation drift

- **Outreach kill-switch disclosure.** The outreach-template generator caches drafts in `_summary.json::outreachTemplates` but rendering in HTML + Markdown is muted via kill-switch (`html.js:367`, `markdown.js:84`) — see note under [0.3.0] below. **0.3.0 README documented the feature in 5+ places without warning the user about the muted rendering, including a screenshot caption claiming to show outreach-draft cards that no fresh install can produce.** README §04 Citations now carries a yellow callout explaining the kill-switch and the workaround (pitch top-3 domains by hand using citation context). README §04 Citations tail screenshot caption flagged with "rendering muted in 0.3.x" qualifier. Re-enables in 0.3.1+ once the publisher / competitor / community domain-type classifier ships.
- **Hero example replaced.** Line 41 hero pitch used an "email editors of firstpagesage.com to get added to their AEO agency list — cited 2× by AI this run" example — which is literally the killed feature. Replaced with a live-feature example referencing the `05 Actions` mission stack instead.
- **Listicle-pitch KPI honesty.** README §01 Overview previously described the listicle-pitch KPI as "surfaces the canonical sources that get cited 2×+ across engines (the pages your outreach budget should target)" — implying URLs the user can immediately pitch. Reality is a count + ratio. Rephrased to describe what 0.3.x ships (descriptive count) with explicit note that the actionable URL grid + `[Copy pitch]` + state tracking lands in 0.4.
- **Discoverability Score → AI-Bot Crawl Readiness rename.** The 0-100 composite over crawlability inputs (robots 30% · bots-not-blocked 25% · sitemap 25% · llms.txt 20%) was named «Discoverability Score» in 0.3.0 — implying it measured discoverability in answer engines. It only measures TECHNICAL access for AI crawlers (robots.txt allows / sitemap present / llms.txt present), not actual answer-pool inclusion (which is driven by off-page authority — Wikipedia / Reddit / review platforms). Renamed to «AI-Bot Crawl Readiness» across the HTML/markdown reports + README description, with explicit note disambiguating it from answer-pool inclusion.
- **Security & Privacy box** added to README `Key facts` — explicit one-liner on no telemetry, no traffic to webappski.com, API keys never written to disk, no SOC2 (single-developer tool — bus-factor honesty).
- **Known limitations in 0.3.x section** added below `Key facts` — surfaces both the outreach kill-switch and the listicle KPI gap before installation, not after.
- **CHANGELOG narrative competitor list** aligned with README's 11 commercial vendors (Otterly / Profound / Peec / Bluefish / AthenaHQ / Goodie / HubSpot AEO Grader / Evertune / Ahrefs Brand Radar / Semrush AI Toolkit / Discovered Labs) — previous draft mentioned Wellows / OneGlanse / Brandlight / Knowatoa which weren't in README.
- **CHANGELOG `[0.3.0]` heading date** corrected from `2026-05-09` (internal milestone) to `2026-05-13` (actual npm publish date).
- **CODING_STANDARDS.md** — new «Template literals» section documenting the backtick-in-comment trap (a stray backtick inside `<!-- … -->` or `/* … */` inside a template-literal-returning function closes the template literal and produces a misleading SyntaxError far below).

### Changed — bridge card redesign (HTML report promote-card)

- DIY and Webappski end-nodes now have parallel geometry (256×88 each) — DIY was previously 168×48 and read as a "lesser option" visually, contradicting the open-source-first marketing.
- Status pills inside each box: **FREE** top-left for DIY, **PRE-RELEASE** top-left for Webappski.
- `?` chip top-right INSIDE each box — replaces the orphan «↓ details · hover» footnote text that was previously positioned BELOW the box. Tap and hover both supported via the existing `aria-haspopup="true"` `<button>` overlay.
- Webappski meta-line «pre-release · $29 per plan · 30 missions» (285px wide) previously overflowed the 192px box and read as detached; now fits comfortably inside the 256px box, with `pre-release` lifted to the pill.
- `priceLabel` default `'$29 once'` → `'$29 per plan'` (kills the «once» / «one-time» / «at-launch-time» semantic collision).
- `priceMetaLine` default `'pre-release · $29 once'` → `'$29 per plan · 30 missions'`.
- Footer line `'$29 once when it ships · demo + signup on the same page.'` → `'$29 per plan · one-time, no subscription · demo + signup on the linked page.'` (resolves «same page» antecedent ambiguity).

### Changed — package.json

- `version` bumped to `0.3.1`.
- 7 new test scripts wired into the root `test` chain.
- Description references «30-mission AEO plan (≈1–3 hours per mission, work at your pace)» instead of bare «30-day plan» (avoids the «30 days × 8 hours = 240 hours» misreading).

## [0.3.0] — 2026-05-13

Major feature release on top of v0.2.7. **No breaking changes** to the v0.2.x CLI surface, config schema, or `_summary.json` consumers. Single jump on npm covering an internal dev cycle (tracked locally as 0.3.0 → 0.4.0 → 0.5.0 → 0.6.0 between 2026-04-23 and 2026-04-27, plus the security review and `--depth` work in early May, finalised + published 2026-05-13).

The core narrative: catch up to hosted competitors (Otterly, Profound, Peec.ai, Bluefish, AthenaHQ, Goodie, HubSpot AEO Grader, Evertune, Ahrefs Brand Radar, Semrush AI Toolkit, Discovered Labs) on capability without giving up the open-source / direct-API positioning.

### Costs (read before running)

- `aeo-tracker run` LLM cost is unchanged unless queries trigger brand mentions. Each cell with a mention now adds a two-model sentiment classification call: **~$0.0008 per mention** (skip-on-no-mention, cached in `_summary.json`). Typical run of 9 cells with 3 mentions: **+$0.0024**.
- `aeo-tracker report` adds **~$0.003 one-off** for outreach-template drafts to the top-3 cited domains (single classify-tier LLM call, cached in `_summary.json::outreachTemplates` — re-running `report` does **not** re-spend).
- `aeo-tracker run --geo=us,uk,de,...` multiplies LLM cost linearly by region count.
- `aeo-tracker run --depth=full` doubles LLM cost (web pass + training-data pass).
- All other new modules — crawlability audit, page signals, entity-graph reciprocity, competitor pricing tier, region context, response freshness, ads detector, UTM tracker, topic clusters — are **$0** (no LLM calls). Wikipedia / Reddit / pricing-page checks use free public APIs / direct HTTP.
- Skip optional `report` fetches with `--no-authority` (Wikipedia + Reddit), `--no-page-signals`, `--no-entity-graph`, `--no-pricing` if you are behind a corporate VPN, hitting rate limits, or want a fully offline report.

### Added — analysis & report sections

- **Brand sentiment scoring (two-model cross-check).** Per-cell `positive | neutral | negative` label + one-line rationale + confidence tier (`high` / `low` / `single-model`). Reuses the same `gpt-5.4-mini + gemini-2.5-flash` pair as competitor extraction. ~$0.0008 per cell with a brand mention; skipped on `mention === 'no' | 'error'`. Stored as `results[].sentiment`. New module: `lib/report/sentiment-classify.js`.
- **Domain share-of-voice table.** Aggregates `canonicalCitations` by hostname → top-10 publishers with citation count + share %. New summary field `topDomains`; new section `sectionDomainShareOfVoice()`. Backwards-compat: section computes on the fly for older snapshots.
- **Historical 8-week trend chart.** Wide-format sparkline over last 8 snapshots with date+score tick row below. Auto-skipped on first run.
- **Outreach email templates for top-3 cited domains.** One classify-tier LLM call drafts a short, specific email (subject < 60 chars, body < 150 words, soft CTA) per top-3 publisher. Cached in `_summary.json::outreachTemplates`. New module: `lib/report/outreach-templates.js`.
  - **Note (2026-05-13) — rendering disabled in 0.3.0 final cut.** The pitch generator currently treats every domain in the citation pool as a publisher, which means direct competitors (scrunch.io, minonta.com, peec.ai etc.) get drafted outreach emails alongside legitimate listicle editors — not actionable advice. The cache layer (`_summary.json::outreachTemplates`) still populates so no data is lost; rendering in both HTML and Markdown reports is muted via a kill-switch (`lib/report/html.js:367`, `lib/report/markdown.js:84`). Re-enables in 0.3.1+ once the publisher / competitor / community domain-type classifier ships. See `TECH_DEBT.md` for the restoration path.
- **Competitor 4-axis radar.** Side-by-side radars (presence / sentiment / rank / mentions) for the user's brand vs top-3 competitors.
- **AI-bot crawlability audit (zero-LLM).** Pure-HTTP audit of `/robots.txt`, `/llms.txt`, `/sitemap.xml`. Maps GPTBot, OAI-SearchBot, ChatGPT-User, Google-Extended, GoogleOther, ClaudeBot, Claude-Web, anthropic-ai, PerplexityBot, Perplexity-User, CCBot, Bytespider to one of `allowed | blocked | partial | unspecified`. Cost: zero (no LLM, ~3 HTTPS GETs). New module: `lib/report/crawlability-audit.js`.
- **Domain category breakdown.** Static rule-based classifier mapping topDomains to semantic buckets (Reviews / Forums / Q&A / News / Reference / Social / Agency / Blog / Docs / Vendor / Gov-Edu / Other). Per-row outreach hint. New module: `lib/report/domain-category.js`.
- **Funnel / intent tags on queries.** `.aeo-tracker.json::queries[]` now accepts both string form (legacy) and `{ q, tag }` form. Visibility split per tag in a new section. Auto-hidden when no tags defined. New module: `lib/config/queries-normalize.js`.
- **Actionable gap matrix.** Top-8 cells where competitors were cited but the user wasn't, each with a one-line concrete action grounded in this run's data (cell host / topDomain / comparison-page suggestion).
- **Unified Visibility Index (UVI).** Single 0-100 composite score (presence 35% · sentiment 25% · rank 20% · citation 20%). Inspired by Rankability's SPI but open — every weight is in `lib/report/visibility-index.js`, every component is rendered alongside the composite.
- **Discoverability Score.** 0-100 composite derived from crawlability inputs (robots 30% · bots-not-blocked 25% · sitemap 25% · llms.txt 20%). No extra fetches.
- **Topical Visibility Clusters.** Rule-based query grouping by most-frequent shared content word. Visibility per cluster. Zero-LLM. New module: `lib/report/topic-cluster.js`.
- **Authority-source presence with dynamic profile detection.** Wikipedia REST API + Reddit search JSON checks by default — free public APIs, no auth. Cached in `_summary.json::authorityPresence`. Disambiguation pages flagged separately. **Dev-tool / AEO-studio brands additionally get a GitHub row** (with disambiguation guard — `owner === brandSlug || owner === domainRoot` — to avoid surfacing wrong repos for popular brand names like Spotify). Detection inputs: category text → pageSignals H1/H2 fallback → domain TLD. Caveat note appears above the table for dev-tool segment («Wikipedia and Reddit are rarely populated for dev tools — the GitHub row below carries the meaningful signal»). Schema is **additive** — old `{wikipedia, reddit}` snapshots render via backwards-compat fallback. Optional `GITHUB_TOKEN` env var lifts unauth 60/h limit to 5000/h. New modules: `lib/report/authority-presence.js`, `lib/report/authority-profiles.js`, `lib/report/authority-github.js`, `lib/report/_http.js` (shared fetch util). New tests: `test/authority-profiles.test.js`, `test/authority-github.test.js`, `test/authority-legacy-shape.test.js`.
- **AI Ads / sponsored-content detector.** Heuristic precision-over-recall scanner for inline disclosure markers (`Sponsored`, `[paid]`, `(advertisement)`) and ad-network domain citations (DoubleClick, Taboola, Outbrain, Criteo). New module: `lib/report/ads-detector.js`.
- **UTM citation tracker.** Surfaces UTM-tagged URLs from your own domain when AI engines cite them. Aggregates by `utm_source` / `utm_campaign` / engine. New module: `lib/report/utm-tracker.js`.
- **Top-domains aggregation helper.** `lib/report/top-domains.js` — `computeTopDomains()` — replaces duplicated logic in `cmdRun` + `cmdRunManual`.

### Added — new CLI flags & commands

- **`aeo-tracker run --geo=us,uk,de,...`** — runs every query under multiple regional contexts. 12 regions: `us, uk, de, fr, es, it, ca, au, in, br, jp, nl`. Cost multiplies linearly with region count; warned explicitly before spending. Region tag on each result + region suffix in raw response filenames. Manual-paste path normalises queries but does not loop regions. Differentiation: most paid competitors are single-region or charge for regional coverage; we're free.
- **`aeo-tracker run --depth=<web|full|auto>`** — selects how many LLM passes per cell.
  - `web` (default) — single web-search pass. Identical to v0.2.7 behaviour.
  - `full` — adds a second training-data pass (no web search) where supported (OpenAI / Gemini / Anthropic). Perplexity is search-only by design and is auto-skipped. Cost ~2× web-only. Distinguishes "absent from current SERPs" from "absent from training corpus".
  - `auto` — defaults to `web`; prompts when the last training-data baseline is older than 14 days (or never run). Lets corpus drift get re-measured at a sparse cadence without weekly waste.
  - New module: `lib/providers/non-search-model.js` — `deriveTrainingModel()` strips `-search-api` / `-search-preview[-YYYY-MM-DD]` suffixes for OpenAI; Gemini and Anthropic toggle web-search via request flags so the model name stays the same.
  - Tracked in `_summary.json::lastFullRun` (date of most recent `depth=full` run) for the auto-prompt logic.
- **`aeo-tracker export [--format=csv|json] [--output=path]`** — flatten every `_summary.json` snapshot into a tabular file for BI ingestion (Looker Studio, Google Sheets, Tableau). One row per result cell with 17 columns. RFC 4180 quoting. New module: `lib/report/csv-export.js`.
- **`aeo-tracker crawl-stats --log-file=path`** — parse Apache/nginx access logs (Combined Log Format + CLF) and count AI-bot crawl frequency per bot, with first-seen / last-seen / top-5 paths. New module: `lib/report/log-parser.js`.
- **`aeo-tracker report --refresh-cache <fields>`** — force-refresh cached fields in `_summary.json` before the report runs, so site-changed signals (own-domain crawl, authority presence, robots.txt, etc.) refetch instead of reading stale data. CSV format or `all` shortcut: `aeo-tracker report --refresh-cache=pageSignals,authorityPresence` or `--refresh-cache=all`. Invalid field names fail fast with the full valid-fields list. Refreshable fields: `pageSignals`, `authorityPresence`, `crawlability`, `citationClassification`, `outreachTemplates`, `entityGraph`, `competitorPricing`, `llmActions`, `adsDetected`.

### Added — HTML report (editorial bento layout)

`aeo-tracker report --html` produces a single-file editorial-bento report: KPI hero with animated UVI counter, sticky outline rail with scroll-spy, six bento sections (`#overview` / `#visibility` / `#competitors` / `#citations` / `#actions` / `#diagnostics`), promote row (planner-prompt bridge + sponsor card), footer reprise, print stylesheet.

- **Self-hosted variable fonts.** Three latin-subset variable woff2 files bundled inside the npm package (Fraunces display serif, Geist sans, JetBrains Mono — all SIL OFL 1.1) are base64-embedded at render time. Zero CDN dependency; the report works offline, in email, from `file://`. Total ~170KB per `report.html`. Loader: `lib/report/fonts/index.js`. Provenance + license: `lib/report/fonts/LICENSE.md`.
- **Hero KPI strip** — UVI / mention rate / citations / top competitor in a 4-cell bento. UVI counts 0 → target on first paint with `prefers-reduced-motion` guard. Hero narrative is context-aware: 4 templates pick based on `(mentions, citations)` tuple — `cited but never named` is the actionable lift case (engines see your domain, just haven't promoted it to a named brand).
- **Promote row** — bridge card (planner prompt copy) on the left, sponsor card on the right. Bridge has 5 states (`success` / `limited` / `expand` / `stale` / `fallback`) selected by `(daysSinceRun, queryCount, navigator.clipboard)`. Success path shows a top-center toast on copy, not a modal. Pre-flight gate disables the button when `queryCount < 10` or `daysSinceRun > 30`; tooltip on hover explains which condition failed and the exact CLI command to fix.
- **Bento sections** — six numbered panels of `.cell.span-N` (2/3/4/6 column widths). Empty sections still render their numbered header + dashed `.cell-empty` placeholder so the rail stays continuous (no `01 02 03 — 05 06` holes that read as broken builds).
- **Per-engine color tokens with fallback chain** — `--eng-gpt` (green), `--eng-gem` (blue), `--eng-cla` (purple), `--eng-perp` (teal). Unknown providers fall through `var(--c, var(--ink-3))`.
- **Section content:**
  - `01 Overview` — score trend chart (in-place SVG with axes + annotation), listicle-pitch KPI, topic cluster bars, top-3 gaps preview.
  - `02 Visibility` — per-engine cards, query × engine matrix (Mention/Position/Sentiment sub-toggle), regions cell when `--geo` was used, verbatim quotes when populated.
  - `03 Competitors` — most-named brands list (dark cell) + 4-axis radar.
  - `04 Citations` — domain share-of-voice with own-domain marker, by-category breakdown, outreach drafts.
  - `05 Actions` — heuristic day-by-day plan (Day labels with Week-fallback when distribution is skewed; chip hidden entirely when uncomputable).
  - `06 Diagnostics` — site-readiness composite, authority presence, per-engine session cost, geo indicator, AI ads, UTM citations.
- **Footer reprise** — Mission Control CTA only when bridge metadata was provided.
- **Print stylesheet** — every section stacks naturally for PDF export; rail/footer-reprise hidden, ghost SVG hidden, dark cells inverted.
- **Stale artifact cleanup** — `aeo-tracker report --html` sweeps orphaned `report.{md,html}` from older date dirs in `aeo-reports/` so post-rewrite layout drift can't mislead a reader who opens the wrong file.

### Changed — visual redesign (editorial bento, canonical pass)

Pixel-aligned to the v2 editorial-bento prototype (`handoff 3/templates/`). No structural changes to data flow, schema, or section order — purely typography, spacing, and component-shape adjustments.

- **Canonical CSS lifted into `renderCss()`.** Stylesheet now mirrors `templates/styles.css` verbatim: `.mast-title` jumps to 64px display weight 300 with `--opsz 144`, hero number to 180px with `--opsz 144 --SOFT 100` (was 168px), engine-pill animation (`@keyframes pulse`), `.eng-pill` shrinks to 8px with shadowed glow, hero card gets 20px radius + radial accent gradient + 38/40 padding, `.rail` becomes a sticky 50-z bar with full-width backdrop-blur and 3px scaleX accent underline (was 1px border-bottom), `.cell` borders bump to 16px / padding 22-24, `.eng-card` gets a top accent strip via `::before`, `.matrix-toggle` becomes a dark-pill segmented control. `.btn-solid` (ink-on-paper) joins `.btn-accent` and `.btn-ghost`.
- **Combined 4-axis radar.** Section 03 (Competitors) replaces the four per-brand radar grid with a single overlay chart: brand polygon (orange) over Top-N competitor average (dark, fill-opacity 0.18). Top-N average is per-axis arithmetic mean of the top-3 competitors by mentions count; if fewer than 3 are present, averages over all available (no zero-padding). New helper: `lib/svg/combined-radar.js` (~50 LoC, viewBox 0 0 280 240, hand-drawn polygons matching canonical reference). Headline branches off the gap: «Behind on every axis», «Ahead on N of 4 axes», «Mixed vs top-3 avg».
- **MC bridge wrapper aligned with canonical class names.** Outer element is now `<article class="promote-card bridge mc-bridge mc-bridge-compact" id="mc-bridge">` (was `<section class="mc-bridge mc-bridge-compact">`). The 5-state machine (`success` / `limited` / `expand` / `stale` / `fallback`), all IDs targeted by `bridgeJs`, and the `[data-mc-trigger]` delegation handler are unchanged. Compact-variant inner padding zeroed because the outer `.promote-card` now provides the 24×26 padding.
- **Footer-reprise + colophon refined.** Footer reprise picks up a 56px top margin, 28×32 padding, 16px radius, accent radial-gradient on the right edge, and the heading climbs to 22px display; colophon spacing tightens to 12px gap with `--line-strong` separator dot.

- **Markdown → HTML converter** for legacy section markdown (`sectionDomainShareOfVoice` etc.). Zero-deps, `lib/report/markdown-to-html.js`. Handles headers, pipe tables, bold/italic/code/links, blockquotes, bullet lists, inline raw HTML pass-through.
- `renderHtml(summary, snapshots, opts)` — second arg unlocks markdown sections. `opts.mcMetadata` enables the bridge.

### Changed

- **`aeo-tracker report` now writes the bento HTML by default and opens it in the browser.** Both `report.md` and `report.html` are written every time. Use `--no-html` to skip the HTML write + browser open (useful for CI / email-only flows). The legacy markdown→TMP-HTML preview path (and the undocumented `aeo-tracker preview` command) was removed — the single-file bento HTML is the canonical view. The `--html` flag is kept as a no-op so existing scripts keep working.
- **`extractWithTwoModels` + `classifySentimentWithTwoModels` run in parallel** via `Promise.all` per cell (previously sequential). Halves the per-cell wall-clock for runs with mentions.
- **`persistSnapshot()` helper** centralises atomic `_summary.json` writes (tmp + rename) — replaces 5 inline duplicated blocks across cache writers (citation classification, LLM actions, authority, crawlability, outreach). Random suffix is now `pid+Date.now()+randomBytes(4)` to avoid collisions on double-press.
- **Region loop in `cmdRun`** properly indented; skipKey format unified to 5-component `query:region:provider:model:mode` in both load and lookup paths.
- **Repository URL** consolidated under the `webappski` GitHub organization across README, error panels, help text.
- **Authority block CLI log line** changed from «Checking Wikipedia + Reddit for X…» to «Checking authority signals for X…» (now includes GitHub when dev-tool profile fires).
- **Authority section header copy:** «Wikipedia and Reddit are two off-page signals…» → «Off-page signals AI engines weight heavily…» (segment-neutral, since dev-tool brands now also surface GitHub).
- **`bin/aeo-tracker.js` execution order:** page-signals crawl now runs **before** the authority block (was after) — authority profile detection reads pageSignals H1/H2 as a category proxy.

### Fixed

- **TDZ crash on `aeo-tracker run --geo=...`.** Cost-warn line referenced `activeProviders.length` before the const declaration. Moved warning to fire after provider discovery. Reproducer in `/tmp/geo_crash.mjs` confirmed the fix.
- **Cache-resume mismatch on non-geo runs.** Existing-summary load built 3-component skipKeys but the run-loop lookup used 4-component keys — non-geo runs lost resume-after-error behaviour silently. Now both sides use a 5-component key including `mode`.
- **Discoverability note misleading.** Showed `allowedCount/total` while the score formula used `notBlocked = allowed + partial + unspecified`. A site with no robots.txt would score 100/100 but the note read `0/12 bots not blocked`. Note now matches the formula.
- **`parseGeoFlag` inconsistent return shape.** Returned bare `[]` for falsy input vs `{ regions, invalid }` for valid. Consistent shape now.
- **Reddit query escape.** `brand` containing embedded `"` produced an unbalanced quoted search. Strips quotes before wrapping multi-word brand names.

### Security

- **XSS hardening for HTML report.** `escMd()` helper (escapes `& < >`) applied to every user / LLM / third-party data interpolation in `lib/report/sections.js`: brand, queryText, competitor names, sentiment rationale, outreach template fields (subject / body / why / host), Wikipedia extract, Reddit subreddit names, UTM source/medium/campaign, ad sample snippets, topic cluster examples, region labels, industry classifier output.
- **URL scheme allowlist in markdown→HTML.** `isSafeUrl()` permits only `https?:`, `mailto:`, `tel:`, anchors and relative paths in `[label](url)`. `javascript:`, `data:`, `vbscript:` are rewritten to `#`.
- **Idempotent label escape.** `escapeHtmlIdempotent()` on link-label content — escapes raw `<` and `>` for defence-in-depth without double-encoding pre-escaped `&amp;` from upstream `escMd()`.

### Tooling

- `package.json` bumped `0.2.7 → 0.3.0`.
- 23 new test scripts wired into root `test`: `test:sentiment`, `test:outreach`, `test:crawlability`, `test:category`, `test:queries`, `test:geo`, `test:mdhtml`, `test:htmlrender`, `test:uvi`, `test:topics`, `test:csv`, `test:logs`, `test:authority`, `test:ads`, `test:utm`, `test:topdomains`, `test:depth`. Plus 4 regression tests for XSS hardening and URL scheme allowlist in `test:mdhtml`.
- `test:imports` extended with all 16 new modules (`sentiment-classify`, `outreach-templates`, `crawlability-audit`, `domain-category`, `geo-context`, `markdown-to-html`, `visibility-index`, `topic-cluster`, `csv-export`, `log-parser`, `authority-presence`, `ads-detector`, `utm-tracker`, `queries-normalize`, `top-domains`, `non-search-model`).
- `--help` documents `--geo`, `--depth`, `aeo-tracker export`, `aeo-tracker crawl-stats`.

**All 25 test suites green.**

---

> Internal dev-cycle history (NOT separate npm releases — collapsed into 0.3.0 above, kept here for git-archaeology only):
> - 2026-04-27 — internal milestone "0.3.0" (sentiment, share-of-voice, trend, outreach, competitor radar)
> - 2026-04-27 — internal milestone "0.4.0" (crawlability, domain categories, funnel tags, actionable gaps, `--geo`)
> - 2026-04-27 — internal milestone "0.5.0" (UVI, discoverability score, topic clusters, markdown→HTML bridge)
> - 2026-04-27 — internal milestone "0.6.0" (CSV export, crawl-stats, authority presence, ads detector, UTM tracker)
> - 2026-05-04 — security review pass (XSS hardening) + `--depth` feature

## [0.2.5] — 2026-04-23

Patch release. **No breaking changes.** Two UX quality-of-life improvements surfaced by dogfood testing of 0.2.4.

### Added — live TTY spinner during long pipeline phases

Previously: `init --auto` printed `[brainstorm] started` and then sat silently for 10+ seconds while the LLM worked. Users could not distinguish "working" from "network hang" — a poor signal for a 51-second pipeline.

**Fix — `lib/util/spinner.js`:** a TTY-aware spinner renders a live, in-place progress frame with elapsed counter between every `started` and `done`/`failed`/`skipped` event from `research()`. Wired into both `init --auto` and `init --queries-only` call sites via a new `makePipelineReporter(spinner)` helper — the existing `logPhase` callback shape and final-line formatting are preserved byte-for-byte.

**Design constraints:**
- **TTY-only.** `process.stdout.isTTY === false` (CI, pipes, `--yes` in a script) → all spinner methods are no-op; the original flat log emits unchanged, keeping logs grep-able.
- **`NO_COLOR=1` respected.** Drops the Unicode braille frames for a cycling ASCII dots fallback (`.  ` / `.. ` / `...`).
- **Zero dependencies.** Raw `process.stdout.write` with `\r\x1b[2K` clear-line sequences.
- **SIGINT cleanup.** Registers a one-shot handler so Ctrl+C doesn't leave a half-rendered line in the terminal.

**10 new tests** in `test/spinner.test.js`: `formatElapsed` (ms/s/m formatting), non-TTY no-op with stream capture, `NO_COLOR` ASCII fallback, Unicode + dim-ANSI color mode, final-line emission (with and without trailing newline), clean transition between phases.

### Added — "Next" hint after `run` and `run-manual`

Mirrors the existing post-`init` convention (`Next: aeo-tracker run`). After a successful `run` (exitCode 0/1/2), the command now prints:

```
Next: aeo-tracker report --html  (or 'aeo-tracker report' for markdown-only)
```

Guards:
- **Skipped on exitCode 3** (all engines errored) — no data to report; the `all-engines-failed` panel has already given the user next steps
- **Skipped in `--json` mode** — programmatic consumers parse JSON; a hint line would corrupt their pipeline

Philosophical choice: **no auto-run** of `report --html` after `run`. Reasons: `run` often lives in CI/cron where an HTML file is useless; auto-open browser hangs on headless machines; `run && report --html` as an explicit UNIX chain is the convention the README already teaches. The hint is the least-surprise nudge.

**159 total tests green** (149 + 10 new).

## [0.2.4] — 2026-04-23

Patch release. **No breaking changes.** Extends the 0.2.2 actionable-panel philosophy from provider errors into the validator gate — the last hard-abort path in `init --auto`.

### Added — validator auto-recovery

Previously: `init --auto` ran the research pipeline (~51 sec, ~$0.006), produced 3 selected queries + up to 5 validated alternatives in the `candidatePool`, then sent the 3 queries through the commercial-only validator. If the validator blocked any query (e.g. a `problem`-intent query that produces tutorial-style answers rather than a vendor list), init aborted — discarding the 5 already-validated alternatives and forcing the user to copy-paste queries into `--keywords` and rerun the whole pipeline.

This violated the no-silent-fatal-aborts rule (established in 0.2.2). The recovery was data-available but logic-absent.

**Fix — `lib/init/validator-recovery.js`:**

1. **Intent-diversity auto-promotion.** When the validator blocks N queries and `candidatePool` contains N unused validated alternatives, init picks replacements that maximize intent-bucket diversity in the final 3-query set. Rule: highest-scored alternative with an intent bucket not already present in the surviving (non-blocked) queries, falling back to highest-score-any when no bucket diversity is available. For the typelessform case — blocked=`problem` with pool=`[vertical:90, comparison:78×4]` — the tool skips `vertical:90` (already covered by a surviving query) and picks `comparison:78`, yielding a final set with 3 unique intents.

2. **`--yes` (non-interactive) behavior.** Single blocker + recoverable → silent auto-promote with a warning line disclosing the measurement-semantics shift (per senior review: *"measurement shifts from problem→comparison — your visibility score will track a different question than you intended"*). Multi-blocker → actionable panel with a pre-filled `--keywords="..."` command built from the validated pool (safer default — user reviews substitutions before rerunning).

3. **TTY (interactive) behavior.** Numbered prompt per blocker: 4 options `[1-4/m/a]` with Enter = recommended (highest-intent-diversity pick). No `[f] keep original` — global `--force` covers that path, reducing prompt clutter per senior review.

4. **Scope discipline — recovery is narrow by design.** Only `informationalIssues` blockers (wrong intent / `search_behavior !== 'retrieval-triggered'`) are auto-recoverable. `staticIssues` (acronym tripwire) and `llmIssues` (low-confidence verdicts) fall through to the actionable panel — a substitution may introduce the same problem, so silent swap is unsafe. The type guard `isRecoverable(blocker)` gates this.

5. **Re-validation is free.** Substituted queries come from the pipeline's own validationCache, so the second `runTwoStageValidation` call hits the cache for every query — ~0ms, $0.

6. **`runValidationFlow` stays untouched structurally.** Added one opt-in flag `returnBlockersInsteadOfAbort` (default `false`, fully backward-compatible for the 3 existing call sites). Recovery is a new wrapper `runValidationWithRecovery` in `bin/aeo-tracker.js` — wrap, not refactor.

**20 new tests** in `test/validator-recovery.test.js`: `isRecoverable` type-guard branches (informational vs static vs llm), `tryAutoRecover` intent-diversity ranking (1-blocker, 2-blockers, pool-exhausted, empty-pool, duplicate-in-queries, no-intent-data fallback), `formatRecoveryPanel` output shape (pre-filled --keywords from pool, editable templates when pool empty, --force + --category hints, static/llm blocker reason rendering), `formatAutoPromoteWarning` measurement-shift disclosure, `promptBlockedQueryReplacement` all 5 branches (Enter-default, numeric pick, `[m]` manual, `[a]` abort, typo → fallback to recommended). Full suite: **149 tests green**.

### Added — `config_queryIntents` persistence for recovery

The research pipeline's `selectResult.selected[].candidate.intent` now persists in-memory (`config_queryIntents` parallel to `queries`) so validator-recovery can enforce intent-diversity ranking. Not written to `.aeo-tracker.json` — it's transient state, regenerated on next `init`.

## [0.2.3] — 2026-04-23

Republish of the 0.2.2 payload. The `0.2.2` slot on npm was occupied by an earlier partial publish, so the full resilience + error-coverage release ships under `0.2.3`. **No code differences vs the intended 0.2.2** — same tests (129/129 green), same features, same config. See [0.2.2 notes](#022--2026-04-23) below for the complete changelog.

## [0.2.2] — 2026-04-23

Patch release. **No breaking changes, no behavioural changes for existing users with standard env var names.** Bundles the 0.2.1 work (README + internal code quality) with two targeted UX fixes: non-standard env var naming + research-provider resilience.

### Added — init research-provider resilience

Previously: `init --auto` picked ONE research provider (priority #1 in `PROVIDER_PRIORITY`) for the brainstorm pipeline. If that single provider returned 402 (credit balance empty), 401 (invalid key), or 429 (rate-limit), the whole init crashed with a generic *"Auto-suggest failed / Aborting"* message — even when the user had two other working keys in their environment.

This was inconsistent with how `run` handles the same errors: a single engine's billing issue becomes a red `status: 'error'` cell in the report; other engines keep working. Init should be equally error-tolerant.

**Two complementary fixes:**

**1. `PROVIDER_PRIORITY` reordered** from `['anthropic', 'openai', 'gemini']` to `['openai', 'gemini', 'anthropic']`. Required providers (per README contract) now come first, optional providers last. Matches the declared user-facing model.

**2. Retry loop in the auto-suggest pipeline.** Init now walks `PROVIDER_PRIORITY` until one provider succeeds. Billing/auth/rate-limit errors trigger automatic retry with the next provider; real bugs (TypeError, SyntaxError, malformed requests) bubble up as before — they're not silently swallowed.

**Actionable failure panel.** When every available provider fails (rare — requires all configured billings to be empty), init prints a structured panel listing every attempt, the classified reason, and three copy-pastable fixes:

```
  All research providers failed — init cannot brainstorm queries on its own.

  Attempted (in priority order):
    ✗ OpenAI (ChatGPT) — empty billing balance
      "You exceeded your current quota..."
    ✗ Google (Gemini) — empty billing balance
      "Billing account ... is disabled"

  How to fix — pick one:

    1. Top up billing on one of these providers (brainstorm costs ~$0.01):
         OpenAI (ChatGPT): https://platform.openai.com/settings/organization/billing/overview
         Google (Gemini):  https://aistudio.google.com/apikey

    2. Skip brainstorm — provide 3-5 queries yourself (zero LLM cost):
         aeo-tracker init --yes \
           --brand=YOURBRAND \
           --domain=https://yourdomain.com \
           --keywords="query 1,query 2,query 3,query 4,query 5"

    3. Hide the failing provider for this run (skip it in priority):
         env -u OPENAI_API_KEY_DEV aeo-tracker init --yes \
           --brand=YOURBRAND --domain=https://yourdomain.com --auto
```

**Error classification** (see `lib/providers/classify-error.js`) catches billing-error phrasings from all four providers (OpenAI "exceeded your current quota", Anthropic "credit balance is too low", Google "billing account disabled"), auth errors (401, invalid key, `invalid x-api-key`), and rate-limit (429, "resource exhausted", "rate_limit"). Non-matching errors — TypeError, SyntaxError, generic 500 — are explicitly NOT retryable, because retrying a real bug across providers would mask the root cause.

**20 new tests** in `test/research-resilience.test.js` cover classification for real error strings from each provider, panel formatting edge cases (single-provider attempts, long error messages, color-off mode), and option numbering logic (Option 1 "top up" appears only when there are billing errors; Option 3 "env -u" appears only when 2+ providers were attempted).



### Added — README TL;DR section

New `## TL;DR` block right after the tagline: one-line positioning statement + three-command install/run chain + cost line with links to get keys + navigational hints ("never opened a terminal before?" → Path B, "want full context?" → Key facts). Appears before the detailed paragraphs so readers can decide in 5 seconds whether to keep reading or copy-paste and go.

AEO-benefit: AI crawlers strongly prefer atomic first-sentence claims + structured code blocks as citable answers. The new opening sentence (*"checks whether ChatGPT, Gemini, Claude, and Perplexity mention your brand — runs locally, reads your keys from shell env"*) is phrased to match the primary user query (*"how do I check if ChatGPT mentions my brand"*) rather than generic marketing copy, which improves the chance AI engines quote it verbatim.

### Added — full error-coverage matrix

Expanded from provider-only classification (v0.2.2 preview) to every failure path in the tool. Three complementary layers:

**1. Universal error classifier** (`lib/providers/classify-error.js`). Old `classifyProviderError` now also detects: network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN via both `err.code` and regex on `.message`), bot-protection pages (Cloudflare / captcha phrases), SSL/certificate failures on user's domain, filesystem issues (EACCES, ENOSPC, EROFS, EPERM), and config-file corruption (SyntaxError on `.aeo-tracker.json`). Each category carries a `reason` + `fixHint` so downstream panels can generate actionable output without re-parsing the error.

Categories split into **retryable across providers** (billing/auth/rate-limit — init's research loop walks them) and **NOT retryable** (network/filesystem/config — retrying with Gemini won't fix a broken disk). Unclassified errors fall into `other` so they bubble to the bug-report link instead of being silently swallowed.

**2. `run` command: "all engines failed" panel** (`lib/errors/all-engines-failed-panel.js`). When every engine returns `mention === 'error'` (exit code 3), the command now prints a grouped breakdown: each engine with its classified reason, count of affected queries, and the env var the key was read from. Followed by option-numbered fixes: top-up links for billing failures, key-regeneration hints for auth failures, wait-and-retry for rate-limits, infra-check for network errors. Always includes a final escape hatch ("remove the failing engine from .aeo-tracker.json"). Skipped in `--json` mode so programmatic consumers still parse clean JSON.

**3. Top-level global catch** in `bin/aeo-tracker.js` (wraps the entire command dispatcher). Any error that escapes the command-specific error handling — config corruption at startup, filesystem issues, unclassified edge cases, real bugs — now lands in `formatUnexpectedErrorPanel` instead of as a raw Node stack trace. The panel shows the command that crashed, a classified headline (e.g. "Network error during `aeo-tracker run`"), a truncated error message, 2-3 concrete next steps per category, and a bug-report link for `other` errors. Raw stack is still printed to stderr when `AEO_DEBUG=1` so developers can dig in.

**Result:** every failure path in aeo-tracker now prints either a resolved result, a command-specific actionable panel, or (worst case) the top-level unexpected-error panel with next steps. Raw Node stack traces reach the user only in `AEO_DEBUG=1` mode.

19 new tests in `test/research-resilience.test.js` cover all new categories (ECONNREFUSED via err.code, SSL, EACCES, ENOSPC, ENOENT→config, bare-SyntaxError-stays-other), plus formatters for both new panels (grouping, option numbering, truncation).

### Added — per-provider interactive key prompt

Previously: if `aeo-tracker init` found SOME API keys via stages 1+2 (standard names, regex heuristic) but not others, it silently proceeded with partial config — then hard-failed at `run` because the two-model extractor requires both OpenAI + Gemini. Users with partial-standard / partial-custom naming were stuck.

Now: Stage 3 (interactive prompt) runs for EVERY missing provider after stages 1+2, not all-or-nothing. The old `[y/N]` gate is gone — the tool just asks directly:

```
Some API keys weren't auto-detected. Type the env var name (not the key itself):
  OpenAI (ChatGPT) env var name (required): MY_OPENAI_KEY
    ✓ verified (164 chars)
  Google (Gemini) env var name (required): MY_GEMINI_VAR
    ✓ verified (39 chars)
  Anthropic (Claude) env var name (Enter to skip — optional):   ← Enter
  Perplexity env var name (Enter to skip — optional):           ← Enter
```

Required providers (OpenAI + Gemini) retry up to 3 times on bad input (blank, env var not set, value too short). Optional providers (Anthropic + Perplexity) accept Enter to skip. Each confirmed name is written to `.aeo-tracker.json::providers[].env`; actual key values stay in `process.env`.

**Safety against accidental key paste.** The prompt asks for the env var NAME (e.g. `MY_OPENAI_KEY`), not the key itself. If a user — under time pressure — pastes an actual key value (`sk-proj-...`, `AIzaSy...`, `sk-ant-...`, `pplx-...`), `init` detects the provider-specific prefix, rejects the input, and prints an explicit nudge: *"That looks like an API key value, not an env var name — please type the NAME of the variable that holds your key"*. The pasted value is never logged, never displayed back, never written to disk. Only the confirmed env var **name** lands in `.aeo-tracker.json::providers[].env`.

Additionally, env var names themselves are validated against POSIX rules (`[A-Z_][A-Z0-9_]*`) — catches typos like dots or dashes in the name before confusing downstream errors.

If all 3 attempts are exhausted for a required provider, init hard-fails with explicit guidance pointing to shell-profile setup. In CI (`--yes`), Stage 3 is skipped — the user must either use standard env var names or pre-seed `.aeo-tracker.json` with explicit `providers[].env` fields.

### Changed — 0.2.1 content merged in

All 0.2.1-planned changes included here. Consolidation decision: ship one larger patch instead of two smaller ones.

Previously in the 0.2.1 entry:

### Added

- **`CODING_STANDARDS.md`** — project-level conventions (ESM only, JSDoc on public API, max-lines limits, error-handling patterns, naming, security). Source of truth for contributors.
- **Webappski sponsor card in the HTML report**, positioned directly under the Visibility Score hero. Soft call-to-action for teams who want implementation help; fully local (no tracking pixels).
- **Exported constants** `SEARCH_BEHAVIORS = Object.freeze({ RETRIEVAL, PARAMETRIC, MIXED })` from `lib/init/research/validate-query-llm.js`. Replaces magic string literals across the validator.
- **Named constants** for the sponsor-card brightness hover (`.sponsor-cta`) with rationale comment — readable palette, not a magic number.
- **Delegated keyboard handler** on `.pm-cell-clickable` — one document-level `keydown` listener replaces per-cell inline `onkeydown` attributes. Same a11y behaviour, cleaner markup.

### Changed

- **Replay mode productized.** `--replay` and `--replay-from` flags are now documented in `--help`. The "REMOVE OR COMMENT OUT BEFORE COMMIT" markers scattered through the code were author dev-notes; productizing them is net-positive (lets users rebuild summaries from historical responses without API cost).
- **`buildExtractionProviders` parallelized.** OpenAI and Gemini providers now resolve via `Promise.all` instead of sequentially — saves ~30 ms of cold-import latency on every run.
- **Inner `resolve` → `mkProvider`** rename to stop shadowing `Promise.resolve`.
- **`extractionSources` stored conditionally.** Per-cell extractor source arrays (per-model brand lists) are now written to `_summary.json` only when the two models disagreed or one failed. On unanimous agreement the sources are redundant — omitting them keeps the summary ~3× smaller over a year of weekly snapshots.
- **`runOne` in `extractWithTwoModels` rewritten** from `.then(success, error)` callback form to an idiomatic async/`try`/`catch` block.
- **GitHub URL in HTML report footer** corrected (`webappski/aeo-tracker` → `webappski/aeo-tracker`).
- **CLI `--help` text** cleaned up: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY` sections now distinguish required vs optional explicitly; Source URL corrected.

### Fixed

- **`err.message` in `catch` blocks** — replaced every site in `bin/aeo-tracker.js` with a defensive `err instanceof Error ? err.message : String(err)` guard via new `errMsg(err)` helper. Prevents `undefined` messages when a non-Error value is thrown (rare in practice, but the defensive guard is free).
- **README consistency pass (25 findings from agent-review):**
  - Price figures unified across 7+ locations to canonical trio: $0.20 min / $0.50 recommended / $0.55 full (~$0.80–$2.40/month).
  - `aeo-tracker paste` reference in FAQ (which does not exist as a command) replaced with correct `run-manual perplexity --from-dir <dir>`.
  - Date placeholders in "What changes over time" table switched from concrete `2026-04-19` to relative `Day 0 / +7 / +28` + `YYYY-MM-DD` paths.
  - Duplicate screenshot eliminated — hero image swapped to `screenshot-05-actions.png` (recommended-actions card, the stronger demo).
  - Config example and 60-second-init transcript use `YOURBRAND` / `YOURDOMAIN.COM` / `YOURCATEGORY` placeholders instead of `acme.com` or `Webappski` — unambiguous for new readers.
  - Added Quickstart block (3 commands, ~60 seconds) at the top of the document.
  - Added "Your first run will show 0% — that's normal" section to frame the baseline emotionally for first-time users.
  - Added shields.io badges (npm version, MIT, Node ≥18, GitHub stars) under the H1.
  - Added "Is aeo-tracker an Otterly alternative?" FAQ (completeness with existing Profound / Peec.ai entries).
  - Table of contents now includes Limitations and Behind this tool anchors.
  - Roadmap section tightened: historic version details collapsed into a one-line CHANGELOG reference.
  - Limitations expanded from 4 to 7 items (week-over-week stochastic variance, provider rate limits, single-brand scope).
  - FAQ "best AEO tool for B2B SaaS" rewritten with an honest "when to choose something else" block (Profound for dashboards, Peec.ai for team workflows, Otterly for wider engine coverage).
  - "How accurate is AI visibility tracking?" + related FAQ content added for AEO discoverability.
  - Entity coverage tightened: `Answer Engine Optimization` repeats 4–6 times across the top 100 lines for AI-cite signal.

### Infrastructure

- **`.gitignore`** — added `.idea/`, `.vscode/`, `.claude/`, `aeo-reports/`, `*.tgz`. Prevents IDE state, local Claude settings, generated reports, and npm pack tarballs from entering commits.
- **Test coverage maintained:** 77 tests across 5 suites (validator, extractor, response-quality, pipeline, smoke). All green.
- **Package integrity verified:** `npm pack --dry-run` shows 54 files, ~820 kB, no dev artifacts leaked into the tarball.

---

## [0.2.0] — 2026-04-23

### ⚠ Breaking changes (upgrading from 0.1.x)

**1. `aeo-tracker run` now requires both `OPENAI_API_KEY` and `GEMINI_API_KEY`.**
The new two-model LLM competitor extractor needs both providers. Previously any single key was sufficient to run the audit. If you previously ran with only one of those keys — or with only Anthropic/Perplexity — you must set both before the next run. The tool hard-fails before spending any API credits. See the updated [API keys section in README](./README.md#api-keys) for links to obtain keys.

**2. `aeo-tracker run` now rejects non-commercial queries by default.**
A new commercial-only validator blocks methodological / informational queries (e.g. "how to measure AI search visibility", "what is Answer Engine Optimization") because they produce tutorial-style AI answers without vendor lists, polluting the trend signal with structural "0% visibility" scores. If your `.aeo-tracker.json` was generated by 0.1.3 and contains such a query, the next `run` will hard-fail with a clear error. Fix via one of:

- `aeo-tracker init --queries-only` to regenerate queries through the new validator pipeline (recommended)
- Hand-edit `.aeo-tracker.json` to replace the flagged query with a commercial one like "best X 2026" / "top X for Y" / "X consultants for Z"
- Temporary escape hatch: `aeo-tracker run --force` (use only for cross-industry interpretation research)

**Fields retained for backward compatibility:** old configs with a `competitors: [...]` field are still readable (field is silently ignored — competitor detection is now fully automatic via the two-model extractor). Missing `category` and `validationCache` fields fall back safely. Outdated model names in `providers[].model` (e.g. `gpt-4o-search-preview`) are auto-replaced by the latest available model via `discoverModels` at run start — no user action needed. (Note: this auto-replace behaviour was later removed; current versions require `aeo-platform init` to refresh model selection.)

### Added — Full HTML report

The tool now produces a rich HTML report in addition to markdown. Covers hero score with trend sparkline, per-engine cards, query × engine heatmap, a per-cell `Position in AI answers` grid with verified/unverified competitor tiers, coverage radar, competitors bar chart, canonical sources, verbatim quotes, LLM-generated recommended actions, and session cost breakdown. Self-contained — inline SVG, inline CSS, zero external assets.

- **Interactive cell drill-down** in the Position grid. Click (or keyboard Tab + Enter) any cell to open a bottom panel with the full raw AI response for that query × engine pair. `View response →` affordance with hover animation and focus ring.
- **Verified / unverified competitor tiers** rendered inline. Solid badge = both extraction models agreed. Dashed badge with `?` superscript = only one model agreed (weak signal, fail-visible).
- **Coverage ring + traffic-light hero** — invisible / emerging / present / strong — matches the score bucket at a glance.

### Added — Two-model LLM competitor extractor

Replaces the previous regex + aggregate-classifier pipeline with a semantic extractor.

- Runs `gpt-5.4-mini` + `gemini-2.5-flash` in parallel against each per-cell response text.
- Merge strategy: intersection → verified, symmetric difference → unverified, union filtered for hallucinations (every returned name must appear verbatim in source text).
- `category`-aware prompt: extractor is told the user's competitive category (e.g. "Answer Engine Optimization services") and explicitly excludes data sources / review platforms / social networks / publications (Reddit, G2, Trustpilot, LinkedIn, TechCrunch, Wired, Yelp) unless the user's category names them.
- Three concrete counter-examples in the prompt: geography-dependent acronym, concept-vs-vendor confusion, domain collision.
- Cost: ~$0.008 per run at CLASSIFY_MODELS tier.

Deleted: `lib/mention.js::extractCompetitors` (regex), `lib/report/classify-brands.js` (aggregate classifier), `lib/report/bucket-brands.js` (tiering from classifier outputs), and all five filter dictionaries (NOISE_START, METRIC_KEYWORDS, IMPERATIVE_START, CONCEPTUAL_SEPARATOR, BRAND_ALLOWLIST).

### Added — Commercial-only query validator

Non-commercial queries are now rejected by default at `init` and at `run`.

- Validator already classified `search_behavior` as `retrieval-triggered | parametric-only | mixed`. New default: only `retrieval-triggered` passes. `parametric-only` and `mixed` produce blockers before any API is called.
- Rationale: methodological queries ("how to get recommended by AI") return tutorial-style answers with no ranked vendor list. Scoring them as 0% visibility conflates "wrong format of response" with "brand not ranked" and pollutes the trend chart.
- Opt-out at library level: `commercialOnly: false` in `runTwoStageValidation` (surfaced as `parametricQueries` list for content-marketing use cases). CLI flag for opt-out deferred until a real user requests it.

### Added — Response quality classifier

Per-cell `responseQuality` field distinguishes three states the old report rendered identically as "not listed":

- `empty` — engine refused / returned <200 chars and 0 citations. Shown as "no answer" in the grid.
- `narrative` — engine wrote prose but no extractable vendor list (competitors empty + fewer than 3 citations). Shown as "narrative response".
- `rich` — normal structured response. Default rendering.

Thresholds live in named constants (`EMPTY_TEXT_MAX = 200`, `NARRATIVE_CITATION_MAX = 3`) with boundary tests.

### Added — Validation cache

`validationCache` field in `.aeo-tracker.json` stores LLM verdicts keyed by exact query text. `run` trusts the cache; if the user edits a query by a single character, cache miss triggers inline re-validation with visible cost. Prevents re-running the same industry-fit check every week.

### Added — Cross-model query validation (opt-in)

`--strict-validation` runs validator through two providers in parallel. Unanimous valid → avg confidence. Unanimous invalid → max confidence (strong reject). Split → blocked with both verdicts shown for audit. Pure merge helper (`mergeCrossCheck`) reused by the extractor's parallel merge logic.

### Added — LLM-generated recommended actions

At `report` time, an LLM reads the run summary + prior snapshot + category and produces prioritised, engine-aware action cards: "Email editors of firstpagesage.com to add [Brand] to their AEO list", "Publish alternatives page for First Page Sage", etc. Cached in `_summary.json::llmActions` so repeat renders don't re-bill.

### Added — a11y + keyboard navigation on clickable cells

Position grid cells now have `role="button"`, `tabindex="0"`, `aria-label`, and keyboard handler (Enter / Space opens the response panel). Focus ring renders as 2px inset outline in accent colour; animation respects `prefers-reduced-motion`.

### Added — Tests

77 tests across 4 suites: static + LLM query validator (with cross-check merge), two-model extractor (parse / hallucination / self-brand / merge / partial failure), response-quality boundary tests, end-to-end pipeline integration with mocked providers.

### Fixed

- Definition-list extractor bug where Gemini format `**Brand:**` caused the brand name to be rejected by the old regex extractor. Two-model LLM extractor handles all formatting variants natively.
- Customs-consultancy drift on queries like "AEO consultants Poland". Static acronym validator catches bare `AEO` without the `Answer Engine Optimization` expansion. LLM validator catches additional cases (e.g. "AEO status" as customs term) via geography-aware prompt.
- Methodology queries inflating "0% visibility" signal. Commercial-only validator blocks them at init time.

### Documentation

- `test/fixtures/README.md` — rotation policy for regression fixtures.
- Expanded CHANGELOG entry honestly describing the architectural change (this entry).

---

> _Earlier development history (pre-2026-04-23 internal version-numbering experiments) is archived in git log only. Those entries used non-canonical version numbers that were later reset before the v0.2.0 npm publishing line._
