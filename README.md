# aeo-platform

[![npm version](https://img.shields.io/npm/v/aeo-platform)](https://www.npmjs.com/package/aeo-platform)
[![npm downloads](https://img.shields.io/npm/dw/aeo-platform)](https://www.npmjs.com/package/aeo-platform)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![GitHub stars](https://img.shields.io/github/stars/webappski/aeo-platform?style=social)](https://github.com/webappski/aeo-platform)
[![Self-test UVI](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fwebappski%2Faeo-platform%2Fmain%2F.github%2Fbadges%2Fuvi.json)](https://webappski.com/reports/aeo-webappski-2026-06-14.html)

**Webappski is an AEO agency that measures client visibility with `aeo-platform`, its own open-source npm engine — clients can install it and reproduce the measurement grid themselves.**

Every hosted AEO platform scores you with a model you cannot inspect. Here the scoring *is* the code you just installed: the answer arrives from the engine's official API, `lib/` turns it into a number, and nothing happens in between on a vendor's server. Same brand, same query basket, same day — same grid. (Engines drift week to week, so a later run is a new measurement, not a contradiction; that is why every run is dated and kept.)

**The receipts, unedited:**

- **On ourselves.** Webappski's own agency brand is cited in **2 of 39** AI-answer cells — 13 buyer queries × ChatGPT / Gemini / Claude, measured 2026-06-14 — and we published the whole grid, including the thirty-seven cells that do not cite us: [aeo-webappski-2026-06-14](https://webappski.com/reports/aeo-webappski-2026-06-14.html). A vendor who hides their own score is asking you to trust a number you cannot check.
- **On a product we optimized.** TypelessForm is present in **12 of 12** cells on the 11 July 2026 run, Unified Visibility Index 92/100 (11 direct mentions + 1 source-only citation — both count as Presence, see [How we count visibility](#how-we-count-visibility)): [aeo-typelessform-2026-07-11](https://webappski.com/reports/aeo-typelessform-2026-07-11.html).

Both files are ordinary `aeo-platform report` output, produced by the three commands in the next section. Nothing in them was written by hand.

## How to run it — init → run → report

**1. Set your API keys.** Two keys are strongly recommended — **any two** of OpenAI, Gemini,
or Anthropic let the tool cross-verify competitor mentions across two models (the pair below
is just an example — use whichever two you have). One key is enough to start (any of the
three) — competitor names just won't be cross-verified.

> **Perplexity is the exception.** Its API is search-tuned, not a general classifier, so it
> can't power query validation or the competitor cross-check. A `PERPLEXITY_API_KEY` only
> adds a 4th answer-engine column at `run` time — it doesn't count as one of your two keys,
> and it can't be your only key.

macOS / Linux (bash / zsh):

```bash
export OPENAI_API_KEY="sk-proj-..."   # platform.openai.com/api-keys
export GEMINI_API_KEY="AIza..."       # aistudio.google.com/apikey
```

Windows (PowerShell):

```powershell
$env:OPENAI_API_KEY = "sk-proj-..."   # platform.openai.com/api-keys
$env:GEMINI_API_KEY = "AIza..."       # aistudio.google.com/apikey
```

**2. Run the three commands** (same on every OS):

```bash
aeo-platform init            # Setup  — picks your tracking queries, writes .aeo-tracker.json
aeo-platform run             # Audit  — asks each AI engine your queries, records the answers
aeo-platform report --html   # Report — builds report.html (+ report.md) and opens it in your browser
```

That's the whole loop — three commands, once a week. **Not sure what each step is actually
doing?** [How the loop works](#how-the-loop-works), just below the flags, walks through
`init` → `run` → `report` in plain English.

Persistent keys (that survive a restart), Windows CMD, extra engines, and no-install `npx`
→ see the [full quickstart](https://github.com/webappski/aeo-platform/blob/main/docs/quickstart.md#full-quickstart--for-first-time-terminal-users-5-minutes).

## Flags — what each one gives you

Short version; the full reference is further down. Every command runs fine with no flags —
reach for these when you need them.

**`init`**

- `--yes --brand=X --domain=x.com --auto` — non-interactive setup (CI / scripts); still auto-suggests the queries.
- `--keywords="q1,q2,q3"` — skip the AI suggester and bring your own 3 queries (zero LLM cost).
- `--queries-only` — re-pick queries without touching brand / domain / keys.

**`run`**

- `--json` — machine-readable output for CI. Exit code says what happened: `0` stable · `1` regressed · `2` invisible · `3` API errors.
- `--regions=us,de,fr` — run every query under each region (multiplies cost by region count).
- `--replay` — rebuild a summary from cached answers, zero API cost (offline).
- `--force` — proceed even if the query-validation gate flags something.
- `--samples=5` — ask each cell 5 times instead of once and report a confidence interval (default is one call per cell; cost scales with N). See [How we count visibility](#how-we-count-visibility).

**`report`**

- `--no-html` — write Markdown only, skip the HTML + browser.
- `--no-open` — write both files but don't auto-open the browser.
- `--public` — strip internal cost figures + source paths for a shareable report.

## How the loop works

`aeo-platform` answers one question: **when someone asks ChatGPT, Claude, Gemini, or
Perplexity to recommend tools in your space, does your brand come up?** It sends your
queries to each engine through their official APIs, checks whether you're mentioned (and
who's mentioned instead), and turns the result into a browser report with a visibility
score and a prioritized to-do list.

In short: `init` sets up and picks your queries, `run` measures them on every engine you have a key for, `report` turns the run into a report — each step in plain English: [what the three commands do](https://github.com/webappski/aeo-platform/blob/main/docs/quickstart.md#what-the-three-commands-do--in-plain-english).

**Run it to** — find out whether AI recommends you today · track that number week over
week · get a concrete list of what to fix to get cited more often.

---

> **`aeo-platform` is the open-source CLI for answer-engine optimization (AEO / GEO).** It measures your brand across **ChatGPT, Claude, Gemini, and Perplexity**, audits AI-bot crawlability + authority signals, and exports a JSON brand-context you paste into any AI for a personalised **30-day AEO plan**. MIT-licensed. Runs locally. Zero runtime dependencies. Free alternative to Otterly, Profound, Peec, and Bluefish.

**macOS / Linux (bash / zsh)** — `npx …@latest` always runs the newest release, nothing to keep updated:

```bash
npx aeo-platform@latest init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto \
  && npx aeo-platform@latest run \
  && npx aeo-platform@latest report
```

Prefer a global install for a weekly rhythm? `npm install -g aeo-platform` and use bare `aeo-platform …` — the CLI prints its version on every command and tells you when a newer release is out (one cached check a day against the npm registry; opt out with `AEO_NO_UPDATE_CHECK=1`).

**Windows (PowerShell / CMD):** the same `npx` chain — including the PowerShell 5.1 caveat (`&&` is not supported there) — is in the [Windows one-liners](https://github.com/webappski/aeo-platform/blob/main/docs/quickstart.md#windows-the-npx-one-liners-powershell-and-cmd).

**Already know your 3 target queries?** Skip the LLM auto-suggest pipeline (zero LLM cost, BYO mode added as first-class in `1.0.3`):

```bash
aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM \
  --keywords="best X for Y,top X 2026,X vs alternatives"
```

Use category-based phrasing («best X for Y» / «top X 2026») the way real users search — the strict commercial-only validator blocks brand-comparison archetypes like «brand vs alternatives» that LLMs auto-correct away for new brands.

> Renamed from `@webappski/aeo-tracker` in `1.0.0` (2026-05-13). The `aeo-tracker` CLI command stays as a built-in alias — existing scripts keep working. Migration: `npm i -g aeo-platform`.

---

## Why `aeo-platform`

Six concrete reasons `aeo-platform` exists, in order of how often they decide the install:

- **Measures 4 engines via official APIs** — ChatGPT (`gpt-6-luna` + the Responses `web_search` tool), Claude (`claude-sonnet-5`), Gemini (`gemini-3.8-flash`), Perplexity (`sonar-reasoning-pro`). No scraping. No proprietary score.
- **Local-first.** Raw responses stay on your disk in `aeo-responses/<domain>/YYYY-MM-DD/`. No telemetry. No traffic to webappski.com. API keys read from `process.env`, never written to disk. OpenAI Responses web-search calls send `store:false` to disable Responses application-state storage; this is not a claim of Zero Data Retention, and provider abuse-monitoring retention remains governed by your provider account. The only non-provider network call is an update check against `registry.npmjs.org` (the host npm itself talks to) — at most once a day, nothing sent, skipped in CI/non-TTY, opt out with `AEO_NO_UPDATE_CHECK=1`.
- **CI-grade.** Exit codes `0/1/2/3` (stable / regressed / invisible / providers errored). `--json` stdout. Cron-friendly.
- **Zero runtime dependencies.** `"dependencies": {}` in `package.json`. Vanilla Node 20+. The report is a single self-contained HTML file (~390 KB — about 170 KB of that is the embedded variable fonts that let it render identically offline, with zero CDN calls).
- **MIT.** Fork it, embed it, ship it inside a paid product — your choice.

## Who runs this — the agency behind `aeo-platform`

**Webappski is an AEO agency that measures client visibility with `aeo-platform`, its own open-source npm engine — clients can install it and reproduce the measurement grid themselves.** The agency is based in Gdynia, Poland, and works in English, German, Polish and Russian. This package is not a side project it left behind: it is the engine behind the client audits. When Webappski measures a client's AI visibility, the grid in that client's report comes out of this repository, at the version stamped inside the report itself (the 2026-06-14 grid above says `v1.3.2`).

That has one consequence worth stating plainly, because no hosted AEO platform can offer it: **the client can audit the auditor.** Install the package, point it at your own domain, and you are running the exact code path that produced the grid you were sent — the query validation, the engine calls your keys allow, the competitor cross-check, and the scoring in `lib/`. There is no vendor-side step to take on trust.

Three things to keep honest about that:

- What is reproducible is the **measurement**. A full client audit also carries on-page findings and a written roadmap around the grid — human work, not tool output, and nothing you can re-derive by installing a package.
- The **free instant check** on the agency's site is a deliberately reduced version — three questions, two engines, no API keys asked of you. The full four-engine run, the crawlability audit, the authority-signal pass and the 30-day plan are what this repository does.
- Running it against your own brand costs you your own API spend, a few cents per week. Webappski earns nothing from your runs, and the tool sends nothing to webappski.com.

The agency's site is [webappski.com](https://webappski.com), and the reduced hosted check described above lives at [webappski.com/en/aeo-audit](https://webappski.com/en/aeo-audit) — free, no account, no card. This README carries no prices and no sales call-to-action by design: commercial detail belongs on that site, not in an MIT repository you were invited to fork.

## What you get

Every `aeo-platform report` writes two files in `aeo-reports/<domain>/<date>/`:

- `report.md` — markdown with inline SVG charts. Renders on GitHub, Notion, VSCode preview, email. Perfect for CI logs and PR comments.
- `report.html` — single-file editorial bento layout, ~390 KB (≈170 KB of which is embedded variable fonts), works offline from `file://`, zero CDN, zero JS dependencies, zero tracking pixels.

The HTML report has:

| Section | Surfaces |
|---|---|
| Hero | UVI (Unified Visibility Index) · mention rate · lift opportunities · top competitor · ⓘ popover with per-axis math |
| `01 Overview` | 8-week score trend · listicle-pitch KPI · topic-cluster bars · top-3 actionable gaps preview |
| `02 Visibility` | Per-engine cards · query × engine matrix (Mention / Position / Sentiment lenses) · region breakdown when `--geo` is used · verbatim quotes |
| `03 Competitors` | Most-named brands · 4-axis radar (presence / sentiment / rank / mentions) vs top-3 competitors |
| `04 Citations` | Domain share-of-voice (own-domain marker) · category breakdown · top-cited publishers |
| `05 Diagnostics` | AI-Bot Crawl Readiness · authority presence (Wikipedia / Reddit / GitHub) · per-engine session cost · region indicator · UTM citations · AI-ad detector |
| `06 Actions` | 5 ordered moves (badges: FIX GAP / LOCK IN WIN / COMPETE / DEFEND) with specific competitors to displace and URLs to pitch |
| Bridge card | Copy-prompt button → 30-day paste-into-AI plan |

Each surface is grounded in actual run data: specific competitors named by this run, specific URLs cited by AI, specific gaps you can act on this week.

## The 30-day AEO plan (the portable wedge no hosted vendor ships)

After measuring you across 4 engines, `aeo-platform report` exports a **JSON brand-context block** with everything the AI needs to write a grounded plan: visibility index, per-engine citation deltas, top competitors, citation gaps, crawl matrix, authority signals, page signals, entity graph, region, freshness, competitor pricing tier.

Paste that JSON into **your own ChatGPT / Claude / Gemini / Perplexity** (any frontier model — same chat subscription you already pay for, no extra API spend). Ask: *"give me a 30-day plan to be cited more"*. The answer is keyed to your specific gaps — named competitors from `topCompetitors`, URLs from `topCanonicalSources`, weakest-engine fortification, citation-gap closure.

**Workflow:**

1. `aeo-platform report` — opens HTML report in browser.
2. Find the section *Your AEO action prompt*. Click the one-tap **Copy** button.
3. Paste into your ChatGPT, Claude, Gemini, or Perplexity chat.
4. Receive a 30-day plan: 30 actions × ≈1–3 hours each, grouped into 4 weekly chunks, every action references a specific competitor / URL / engine / gap from the data.

**Real run for typelessform.com — the file the whole pipeline exists to produce:**

<!-- source: aeo-platform run 2026-05-18, ~/Projects/typelessity-landing/aeo-responses/2026-05-18/_summary.json (Presence 42%, mentions 5/12) -->

### Diagnosis

UVI **42%** (5/12 cells), leading 8 named competitors by mentions but missing on 7; strongest on ChatGPT (67% / 67%), weakest on Perplexity (33% / 0%).

| # | Action | Expected outcome | Time |
|---|--------|------------------|------|
| 3 | Add 40–60 word answer capsule under each H2 lacking one (coverage 1/9) | Multiplies extractability across all 12 engine cells in one pass | 90 min |
| … | *28 more missions, each tied to a specific finding in the audit* | | |
| 30 | Re-run `aeo-platform` to measure delta; AMA in strongest sub from new `topSubreddits` | Quantifies progress; doubles down on warmest Reddit surface | 120 min |

Full plans: [`sample-plan-typelessform.md`](https://github.com/webappski/aeo-platform/blob/main/examples/sample-plan-typelessform.md) (established brand at UVI 42%) · [`sample-plan-output.md`](https://github.com/webappski/aeo-platform/blob/main/examples/sample-plan-output.md) (bare-site brand at 0%).

**Why no hosted AEO dashboard ships a *portable* one:** a paste-into-AI plan cannibalises the dashboard moat. Once the user takes the JSON to their own AI chat, the vendor's UI is no longer the destination. Hosted tools do generate action plans — [Waikay](https://waikay.io/) meters them by the unit, "up to 30 / 90 / 220 AIO Action Plans" depending on tier (checked 4 September 2026) — but they generate them *inside* the dashboard you are renting, and the plan stops when the subscription does. Open-source has the opposite incentive: show zero when it's zero, hand you the data, win when you take it wherever you want.

## Multi-engine coverage

**aeo-platform calls four AI answer engines via their official REST APIs in a single run: ChatGPT (`gpt-6-luna` + the Responses `web_search` tool), Gemini (`gemini-3.8-flash`), Claude (`claude-sonnet-5`), Perplexity (`sonar-reasoning-pro`). OpenAI + Gemini keys are recommended (they power the two-model hallucination filter); any ONE research-capable key (OpenAI, Gemini, or Anthropic) is enough to start in single-key mode — competitor mentions are then marked unverified. Claude + Perplexity add optional columns. Browser-only surfaces (Perplexity Pro UI, ChatGPT Pro personalisation, Claude.ai chat) are covered via `run-manual` paste mode that merges into the same `_summary.json`.**

| Engine | Default model | API path | Web-search grounding | Required key |
|---|---|---|---|---|
| ChatGPT (OpenAI) | `gpt-6-luna` | direct REST | yes (Responses `web_search` tool) | `OPENAI_API_KEY` |
| Gemini (Google) | `gemini-3.8-flash` | direct REST | optional (request flag) | `GEMINI_API_KEY` |
| Claude (Anthropic) | `claude-sonnet-5` | direct REST | optional (request flag) | `ANTHROPIC_API_KEY` |
| Perplexity | `sonar-reasoning-pro` | direct REST | always | `PERPLEXITY_API_KEY` |

OpenAI + Gemini keys are **recommended** (two-model competitor extractor: GPT-5-nano + Gemini-2.5-flash cross-check filters hallucinated brand mentions). Minimum: any ONE of OpenAI / Gemini / Anthropic — single-key mode runs the extractor on one model and marks competitor mentions unverified. Perplexity is optional — adds a column.

For engines whose API tier you can't access (Perplexity Pro browser, ChatGPT Pro UI personalisation, Claude.ai UI), use **manual paste mode**:

```bash
# macOS / Linux
mkdir perplexity-responses
# paste UI answers into perplexity-responses/q1.txt, q2.txt, q3.txt
aeo-platform run-manual perplexity --from-dir ./perplexity-responses
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory perplexity-responses
# paste UI answers into perplexity-responses\q1.txt, q2.txt, q3.txt
aeo-platform run-manual perplexity --from-dir .\perplexity-responses
```

> **Windows note:** save your `q1.txt`/`q2.txt`/`q3.txt` files as **UTF-8 without BOM**. Notepad's default («ANSI» or «UTF-8 with BOM») leaves an invisible byte at the file start that can affect mention detection. In Notepad: *File → Save As → Encoding: UTF-8* (NOT «UTF-8 with BOM»). VSCode and Notepad++ default to UTF-8 without BOM.

Results merge into today's `_summary.json` alongside API runs. `diff` and `report` treat both identically.

## How we count visibility

**Every number in the report comes from a rule you can read in this repository. This section states the rules that decide the score: how many times each engine is asked (once per cell per run, by default), what counts as a mention, and how each axis is derived.** Two neighbouring sections stay the authority for the rest and are not repeated here — [what this measures and what it does not](#what-this-measures--and-what-it-does-not) for scope, and [UVI methodology](#uvi-methodology--unified-visibility-index) for the weights.

### How many times we ask: once per cell, by default

A **cell** is one combination of *query × engine × region × pass*. `aeo-platform run` makes **exactly one API call per cell**. Three queries against three engines is nine answers — one answer per cell. The tool does not ask the same question twice and average the results.

Say plainly what that means for the number. Language models are non-deterministic: the same question, to the same engine, an hour later, can name a different set of tools. A default run is therefore a **point estimate with unknown spread** — not a measurement carrying an error bar. Two runs on the same day can honestly disagree, and a single cell flipping from `no` to `yes` is not a trend.

If you need the error bar, ask for it:

```bash
aeo-platform run --samples 5
```

`--samples N` queries every cell N times and keeps each trial in `_summary.json` (`results[].trials[]`), with the cell's own hit rate under `results[].presence`. The report then pools the sampled cells into one Wilson confidence interval on the Presence axis — `share of cells where brand was mentioned · 12/15 trials · 95% CI [62%, 96%]`. `aeo-platform diff` uses the same statistics for its regression verdict: when **both** runs sampled a cell, a flip whose intervals overlap is classified as noise and dropped rather than reported as a change, so one jittery trial cannot trip the exit-1 regression code. When either side is single-shot there is no distribution to test, and the flip is reported as before, tagged `point-estimate`. Cost scales roughly N×, which is why the default is 1 and the flag is capped at 25. Five is a sensible starting point when a decision depends on the number.

### What counts as a mention

Each answer gets exactly one label (`lib/mention.js`):

| Label | What it means |
|---|---|
| `yes` | your brand name, one of your configured aliases, or your domain appears in the answer body |
| `src` | your brand appears **only** inside a cited source URL — not in the text a reader sees |
| `no` | absent under every spelling checked |

**`yes` and `src` both count as one for Presence.** Being cited as a source counts as being visible. That is the least obvious scoring decision in the tool, so it is stated rather than buried.

Name matching is case-insensitive and separator-tolerant — `acore` matches `Acore`, `A-Core`, `A Core`, `(Acore)` — and anchored on word boundaries, so it does not fire inside a longer word (`acorehouse`) or across a seam (`an extr**a core** team`). Three limits, stated rather than hidden:

- **No fuzzy matching.** An engine that misspells your name counts as an absence until you add that spelling to `brandAliases` in `.aeo-tracker.json`.
- **The domain is matched as a plain substring**, without word anchoring — so a longer host that contains your domain string would register as a mention.
- **A dot is significant.** A brand configured as `Node.js` needs the literal `node.js`; `nodejs` will not match it.

### Where each axis of the score comes from

- **Presence** — share of non-error cells labelled `yes` or `src`. A cell that errored (bad key, rate limit, provider outage) is dropped from the denominator entirely; it is not counted as an absence. Under `--samples N` a cell contributes its **fraction** of hits (0.667 for two of three trials) rather than a flat 1 or 0, while its headline label stays the most common outcome of the trials, breaking ties towards the stronger reading (`yes` over `src` over `no`).
- **Sentiment** — two cheap classification-tier models, one per provider, resolved at run time, score each mentioning cell independently. Both agree, the label stands at high confidence; they disagree, the label degrades to neutral at low confidence; one fails, the other's label is used and marked single-model. The axis then averages the surviving cells at `positive = 100`, `neutral = 50`, `negative = 0`. **A low-confidence neutral is dropped, not averaged in as a 50** — a tie between two disagreeing models records "no signal", not "a middling opinion". Cells that never mentioned you carry no sentiment at all and never enter this axis.
- **Rank** — an integer only when the answer is a structured list of at least three numbered or bulleted items *and* the mention sits inside one of those items. Prose answers get an ordinal from a classification-tier model instead, carried at lower confidence and multiplied by 0.7 before it enters the average, so an explicit list position always outweighs a prose one. When no cell yields a usable position, the rank axis is **excluded and the remaining weights re-normalise** — it is never filled with a zero or a 50.
- **Citation** — cells where your own domain appears among the answer's cited sources, matched at the registered-domain level, so `blog.yourbrand.com` counts as yours.

### Which model actually answered

Model IDs are discovered live from each provider at run time; the values in `.aeo-tracker.json` are fallbacks, not promises. The ID that actually produced each answer is stamped into `_summary.json`, and a run prints a warning when a provider serves a different model lineage than the one requested (`--strict-model-pin` turns that warning into a failed run, for a frozen basket you want kept comparable month over month). Read the served ID, not the configured one.

### What we do not measure

Scope is covered in the [next section](#what-this-measures--and-what-it-does-not) — engine APIs rather than the consumer apps, and no coverage of Google AI Overviews / AI Mode or Microsoft Copilot. Four more things this tool never claims to know:

- **How many real people ask these questions.** The basket is the one you chose. It carries no search-volume or demand signal.
- **Your position in classic Google search.** Different surface, different tool.
- **Why the number moved.** A score that rises after you shipped a page is a correlation. The tool records what changed, not what caused it.
- **What an engine will answer tomorrow.** Every score is a reading of one moment on one surface.

## What this measures — and what it does NOT

Be precise about scope: `aeo-platform` queries each engine's **API surface** with your own keys. That is a reproducible, auditable proxy you can re-run and put in CI — but it is **not** the same thing a human sees in the consumer app. The consumer apps use a different retrieval pipeline, can serve a different model version, and add personalization and locale that the API does not. Treat the score as *"how the engine's API answers your queries"*, not *"exactly what a user of chatgpt.com sees"*.

Each run records this in `_summary.json` under `measurement` (`{ "surface": "api", "disclaimer": "…" }`), and the report header shows it.

| Engine measured (API) | What we call | Is NOT the same as |
|---|---|---|
| OpenAI `gpt-6-luna` + Responses `web_search` | direct REST, search-grounded | chatgpt.com (Pro personalisation, memory, plugins) |
| Perplexity `sonar-reasoning-pro` | direct REST, always grounded | perplexity.ai Pro browser UI |
| Gemini `generateContent` + grounding | direct REST | the Gemini app |
| Anthropic `claude-sonnet-5` | direct REST (optional column) | claude.ai chat |

**Not covered at all (no first-party query API):** **Google AI Overviews / AI Mode** and **Microsoft Copilot**. A run reports zero signal for these because the tool never queries them — their absence from the score is a coverage gap, not evidence you are invisible there. For the browser-only surfaces above, use `run-manual` paste mode (previous section) to fold a real UI answer into the same `_summary.json`.

A Google AI Overviews connector is on the [roadmap](#roadmap) (not built yet).

## AI-bot crawlability audit (zero LLM cost)

**The crawlability audit scores your domain against the 12-bot AI-crawler matrix (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, and 8 others) using ~3 HTTPS GETs against your `/robots.txt`, `/sitemap.xml`, and `/llms.txt`. No LLM calls, no auth, no cost. The composite **AI-Bot Crawl Readiness** score (0–100) weighs robots posture 30%, bots-not-blocked 25%, sitemap 25%, and whether your homepage content is in the served HTML 20%.**

The bot-by-bot table (which blocks cost citations and which do not), the scoring weights and the `llms.txt` finding: [AI-bot crawlability audit](https://github.com/webappski/aeo-platform/blob/main/docs/crawlability-audit.md).

## Authority signals

**Authority signals check the off-page surfaces AI engines weight heavily when picking who to cite: Wikipedia article presence + length, Reddit mention count, GitHub repo stars/forks (auto-surfaced for dev-tool brands with disambiguation guard), and Wikidata Q-ID + `sameAs` reciprocity. All four use free public APIs — no auth required (optional `GITHUB_TOKEN` lifts GitHub rate from 60/h to 5000/h).**

`aeo-platform report` checks the off-page surfaces AI engines weight heavily when deciding who to cite. Free public APIs only — no auth.

| Source | What's checked | Method |
|---|---|---|
| Wikipedia | Article exists for your brand? Disambiguation page? Length? | Wikipedia REST API |
| Reddit | Mention count in posts + comments referencing your brand | Reddit search JSON |
| GitHub | Repo exists under your namespace? Stars / forks? (auto-surfaced for dev-tool brands; disambiguation guard prevents wrong-repo matches for popular names) | GitHub REST API; optional `GITHUB_TOKEN` env lifts 60/h → 5000/h |
| Wikidata | Q-ID present? `sameAs` chain reciprocal? | Wikidata SPARQL |

Why this matters: in Webappski's 2026 weekly audits, brands with a Wikidata entity, named-author `sameAs` chains, and presence on Reddit/G2/Wikipedia consistently outperform on AI Overview citation rates compared to brands relying on domain authority alone. Entity signals and citation-source presence are the highest-ROI surfaces to fix.

## UVI methodology — Unified Visibility Index

**UVI (Unified Visibility Index) is a 0–100 composite of four AI-answer signals: Presence 35% (mentioned cells / non-error cells), Sentiment 25% (average tone of mentioning cells, positive 100 · neutral 50 · negative 0), Rank 20% (normalised average rank position), Citation 20% (cells where your domain was cited as a source). Weights are visible in `lib/report/visibility-index.js`; sub-components with insufficient data are excluded and remaining weights re-normalise — never phantom values. Sample size is published alongside the score.**

`aeo-platform` rolls four AI-answer signals into a single 0-100 composite. Every weight is in the source (`lib/report/visibility-index.js`); the ⓘ popover next to the hero number shows the per-axis math on every run.

| Sub-component | Weight | What it measures |
|---|---|---|
| **Presence** | 35% | Cells where your brand was mentioned (yes/src) out of total cells |
| **Sentiment** | 25% | Average tone of the cells that mention you (`positive` 100 · `neutral` 50 · `negative` 0), over cells whose label carries signal — see [how we count visibility](#how-we-count-visibility) |
| **Rank** | 20% | Average rank position when mentioned, normalised 0-100 |
| **Citation** | 20% | Cells where your domain was cited as a source |

Sub-components with insufficient data (e.g. zero rank positions in a first run) are excluded; remaining weights re-normalise and the popover flags the re-norm. No phantom values. Sample size is published alongside the score (`n=K high-confidence cells`).

## A 0% is a hypothesis, not a fact

**A low or zero score is a question to investigate, not a conclusion to act on.** The tool measures exactly what it asked — and a score is only as trustworthy as the basket behind it. Before you treat a 0% as "AI does not know my brand", confirm two things the tool now surfaces for you in the report's *"How representative is this score?"* panel:

1. **Did the raw answer mention your brand under every spelling?** A naive match misses `A-Core` when you tracked `Acore`, or a brand cited only inside a source URL. The tool checks aliases and separators and shows the exact sentences engines produced (the *"What AI engines actually said"* section) — read them before trusting a 0. If you see the brand there but the score is 0, that is a matching gap to report, not invisibility.
2. **Does the basket cover the field where your brand actually competes?** A CDN brand measured only on "VPC for healthcare" will score 0 — not because it is invisible, but because the basket asked about ground it does not play on. The report's coverage line ("your queries touch X of N product lines") and the small-sample warning are there to catch this. A headline driven by off-target or too-few queries is an artefact of the basket, not a verdict on the brand.

This is the same discipline the tool applies to itself: a number without provenance is a guess. Re-run with a corrected basket (`aeo-platform init --queries-only --add-queries` preserves your trend history) before drawing conclusions. Only a 0% on a basket that covers your real product lines, checked against the raw answer text, is evidence of an AEO gap worth acting on.

## Comparison vs hosted AEO platforms

| Tool | Pricing model | Open source | Raw data stays local | Portable paste-into-AI plan |
|---|---|---|---|---|
| **[`aeo-platform`](https://github.com/webappski/aeo-platform)** | **Free + your own API spend** | **MIT** | **Yes** | **Yes — the only engine in this table that ships one** |
| [Ahrefs Brand Radar](https://ahrefs.com/brand-radar) | Paid SEO-suite add-on | No | No | No |
| [AirOps](https://www.airops.com/) ✳ | Freemium platform — AI-search visibility is one module beside content production and agents | No | No | No |
| [AthenaHQ](https://athenahq.ai/) | Paid subscription | No | No | No |
| [Bluefish](https://www.bluefish.ai/) | Enterprise contract | No | No | No |
| [Discovered Labs](https://discoveredlabs.com/) | Managed-service retainer | No | No | No |
| [Evertune](https://www.evertune.ai/) | Custom contract | No | No | No |
| [Goodie](https://higoodie.com/) | Paid subscription | No | No | No |
| [HubSpot AI Search Grader](https://www.hubspot.com/ai-search-grader) ✳ | Free one-shot grade; HubSpot's ongoing AEO monitoring from $50 a month | No | No | No |
| [LLMrefs](https://llmrefs.com/) ✳ | $79 a month, 7-day trial | No | No | No |
| [Otterly](https://otterly.ai/) ✳ | Paid subscription from $29 a month | No | No | No |
| [Peec.ai](https://peec.ai/) | Paid subscription | No | No | No |
| [Profound](https://www.tryprofound.com/) | Paid subscription | No | No | No |
| [Scrunch AI](https://scrunch.com/) ✳ | Sales-led — 7-day trial, no public price | No | No | No |
| [Semrush AI Visibility](https://www.semrush.com/ai-seo/overview/) | Paid SEO-suite add-on | No | No | No |
| [Superlines](https://www.superlines.io/) ✳ | Paid subscription, price on request | No | No | No |
| [Trakkr](https://trakkr.ai/) ✳ | $100 a month for one brand · $500 a month for ten | No | No | No |
| [Waikay](https://waikay.io/) ✳ | $69.95 / $199.95 / $449.95 per month | No | No | No — meters plans by quota, generated in-dashboard |
| **[Webappski](https://webappski.com/)** (agency — the maintainer of this project) | Monthly retainer or one-off project, invoiced | MIT — the same engine as row 1 | **No** for an audit we deliver — it runs on our infrastructure; Yes if you run the CLI yourself | Yes — this engine's export, handed to the client |

**Two of the 19 rows in this table are ours, and the last two columns need a qualifier the cells cannot hold.** `aeo-platform` is this repository; **Webappski** is the agency that maintains it and delivers audits with it. The agency row is here because two other agencies already are — Discovered Labs and Evertune — and a table that grades everyone else while leaving out its own author is not a comparison. It also fixes what the wedge claim means, so read that claim precisely: *no hosted vendor ships a portable plan* is a statement about the **17 third-party products in this table**, and the two Yes cells in the last column trace back to one engine — this CLI, and the agency running the same CLI for a client. On **raw data stays local** the honest answer for the agency row leads with No: the free audit on webappski.com executes in Firebase Cloud Functions on Webappski's own provider keys, and an audit we deliver is run by us, on our side — either way the raw answers land in our infrastructure, not on your disk. Run the CLI yourself, row one, and they never leave your machine. That is the same distinction the AirOps row draws below: whose machine, not whose key. One number to keep apart while reading on: the 19 rows here and the *live re-check of 19 tools* stamped in the next section are different nineteens — the stamp counts tools whose own pages we read that day (8 ✳ hosted platforms, 8 open-source peers, 3 projects excluded with the reason printed), and neither of our rows is among them. The pricing cell is the shape published on [webappski.com/en/pricing](https://webappski.com/en/pricing), read on 7 September 2026 — both paths are invoiced, and no Webappski price appears in this README by design.

**✳ = re-checked live on 4 September 2026; the linked page is the page that was read.** It marks third-party rows only — our own two rows carry no ✳, because "we read the vendor's page" is not a claim we can make about ourselves. Unmarked third-party rows keep the pricing *shape* recorded in our July 2026 review of 23 AEO tools and had only their URL re-confirmed on the same day — read those price cells as a category, not as a quote. Two labels moved at that check and are corrected above: HubSpot's tool now ships as **AI Search Grader** (it was the "AEO Grader") and Semrush's surface now reads **AI Visibility**. Adobe LLM Optimizer is on our watch list but is deliberately absent from the table — its product page timed out twice on 4 September 2026, and an unreachable page is *unknown*, not *absent*.

**To be fair about where the hosted tools are genuinely ahead.** Engine breadth is the clearest gap: `aeo-platform` calls four engines and deliberately does not scrape Google AI Overviews or AI Mode, while Superlines reads 10+ surfaces, LLMrefs 11, Trakkr 8 (including Meta AI and DeepSeek) and Otterly 7 (including AI Overviews and AI Mode) — all counts from their own pages on 4 September 2026. Trakkr and Superlines each ship an MCP server and a hosted API; Trakkr adds white-label client portals on its $500 tier. AirOps is a different animal again, wrapping visibility inside content production and pipeline attribution — and it is the one row where the "raw data stays local" No deserves a sentence rather than a word: AirOps does let you supply your own provider keys on its paid plans, which removes the vendor's model markup but not the vendor's servers, since the runs still execute on their infrastructure. Bring-your-own-key is not the same property as bring-your-own-machine, and this column measures the second one. And HubSpot AI Search Grader returns a score in under two minutes with nothing to install. `aeo-platform` does none of that, and none of it is on the roadmap — it trades breadth and polish for a run whose every number you can read in `lib/`.

**Pick something else when.** Three questions; one "yes" and a row above serves you better than this CLI:

1. **Does the result need to reach people who will never open a terminal, on a schedule?** Then you want seats, alerting and SSO — **Profound** or **Peec.ai**. `aeo-platform` writes an HTML file; nothing emails it for you.
2. **Do Google AI Overviews or AI Mode have to be inside the number?** Then you need a vendor that goes and gets them — **Otterly** (7 surfaces) or **Superlines** (10+). This tool covers the four engines reachable by official API and says so instead of estimating the rest.
3. **Does procurement need SOC-2, a DPA and an invoice?** Then you need a company, not an MIT repo — **Bluefish**, or **AirOps** at its enterprise tier.

If all three are "no", the rest of this README is written for you.

**Pick `aeo-platform` when:** indie founders, small AEO / GEO agencies, dev-centric teams who prefer CLI + CI integration, anyone who wants the portable paste-into-AI plan, anyone who can't justify a subscription for a tool whose direct-API cost is a few cents per week.

**One axis the table cannot show: who checks the checker.** Every third-party platform above is closed-source — see the column; the only MIT in it is this engine, on the two rows that run it. That means the score reaches you from a server you cannot enter, and you are trusting the vendor's definition of a mention, their competitor matching, and their weighting, none of which you can read. Here all three sit in `lib/` in the copy on your disk, [how we count visibility](#how-we-count-visibility) writes out the mention rule and the one-call-per-cell sampling behaviour, and the [UVI methodology](#uvi-methodology--unified-visibility-index) writes out the weights. It is also the axis on which an *agency* is judged: Webappski measures clients with this engine, so a client can install it and re-derive the grid they were sent. Transparency as a file you can open, rather than as a word on a landing page.

## Comparison vs open-source AEO trackers

The open-source side of this category is real, crowded, and moving faster than we are on stars. Rather than name one peer and stop, here is the whole neighbourhood. Every cell below was derived live on **4 September 2026** — `gh api repos/<owner>/<repo>` for the stars, licence and last push, and the project's own README for what it takes to run and what it covers. Star counts are what GitHub served that day, not a cached number, and they include ours.

| Project | Stars | Licence | What it takes to run | Engines | Portable paste-into-AI plan |
|---|---|---|---|---|---|
| **[`aeo-platform`](https://github.com/webappski/aeo-platform)** (this repo) | **11** | **MIT** | **`npx aeo-platform` — no server, no database, no container** | **4** (ChatGPT, Claude, Gemini, Perplexity) | **Yes** |
| [elmohq/elmo](https://github.com/elmohq/elmo) | 293 | MIT | Docker Compose + PostgreSQL you run, or their managed cloud from $29 a month | 9 named, incl. Google AI Mode and AI Overviews | No |
| [danishashko/geo-aeo-tracker](https://github.com/danishashko/geo-aeo-tracker) | 250 | MIT | Clone + `npm install`, local dashboard; bring your own keys | 6 | No |
| [ai-search-guru/getcito](https://github.com/ai-search-guru/getcito-worlds-first-open-source-aio-aeo-or-geo-tool) | 182 | MIT — a derivative work of elmo, above | Docker Compose + PostgreSQL 16+, plus a scraping provider | 7, incl. Google AI Mode and AI Overview | No |
| [aryamantodkar/oneglanse](https://github.com/aryamantodkar/oneglanse) | 164 | MIT | Docker + PostgreSQL + ClickHouse; captures through the real product UIs rather than the APIs | 5, incl. AI Overview | No |
| [Canonry/canonry](https://github.com/Canonry/canonry) | 129 | FSL-1.1-ALv2 — fair-source, converts to Apache-2.0 after two years, not OSI-approved at release | `npm i -g @canonry/canonry`, then a self-hosted single-tenant deployment | 4 | No |
| [ansvisor/ansvisor](https://github.com/ansvisor/ansvisor) | 106 | MIT | Self-host on Supabase, or their managed cloud | 8 | No |
| [letterstory/lettertrace](https://github.com/letterstory/lettertrace) | 69 | MIT | Self-host Next.js + Supabase, Docker path documented; bring your own keys | 4 provider APIs | No |
| [sharozdawa/ai-visibility](https://github.com/sharozdawa/ai-visibility) | 9 | MIT | Clone + `npm install` + Prisma | 4 | No |

**Read the fourth column before the second.** Stars measure attention; that column measures the afternoon between you and your first number. Every other project above asks you to stand something up first — a Postgres, a Supabase project, a Docker Compose file, at minimum a clone and an install. `npx aeo-platform` writes to disk and is done, and that is the trade being made: they get a dashboard and a database you can query, we get no deployment step at all. If you want the dashboard, take one of theirs — elmo and ansvisor are both MIT and both actively shipping.

**Activity, from the same check.** elmo, canonry and lettertrace all pushed on 4 September 2026; getcito on 31 August; geo-aeo-tracker on 12 August; this repo on 2 September. Two are quiet: oneglanse has had no push since 10 May 2026 and sharozdawa/ai-visibility since 22 March 2026 — they are listed because engines still name them, not because we would bet a workflow on them.

**Two naming traps worth knowing before you type an install command.** The npm package literally called [`ai-visibility`](https://www.npmjs.com/package/ai-visibility) is *not* [sharozdawa/ai-visibility](https://github.com/sharozdawa/ai-visibility) — it is a robots.txt / llms.txt / JSON-LD generator for AI crawlers (`npm view ai-visibility`, 4 September 2026). And `geo-aeo-tracker`, `oneglanse`, `getcito` and `ansvisor` have no package under those names on the npm registry — all four returned 404 on that same check — so whatever a search result implies, you get them by cloning, not by installing.

**Deliberately not in the table, with the reason.** [addyosmani/agentic-seo](https://github.com/addyosmani/agentic-seo) is the most-starred repo in this neighbourhood at 307, but it audits a site or a docs folder for agent readiness (`npx agentic-seo ./my-docs-site`) — it does not measure brand mentions across engines, so it is not a peer of the rows above. Same reasoning for [mverab/eGEOagents](https://github.com/mverab/eGEOagents) (173), a GEO content-optimisation skills pack. [ivannikov-pro/ai-visibility-tracker](https://github.com/ivannikov-pro/ai-visibility-tracker) *is* a tracker by intent, but its README still marks self-hosting as "planned", the repo sits at 0 stars, and nothing has been pushed since 22 May 2026 — putting it in would pad the table rather than inform it.

**The structural difference is still the plan.** After measuring you across four engines, `aeo-platform` exports a JSON brand-context block you paste into any frontier AI chat and get back a 30-action plan keyed to your own gaps. In our July 2026 review of 23 tracked AEO tools, plus a live re-check of 19 tools on 4 September 2026, no other tracker — open or closed — shipped a portable one. Those 19, so the number can be audited rather than taken on faith: the eight open-source projects listed beside ours above, the three excluded in the paragraph before this one, and the eight ✳ hosted platforms whose own pages were read that day (AirOps, HubSpot AI Search Grader, LLMrefs, Otterly, Scrunch AI, Superlines, Trakkr, Waikay). None of the 19 is one of ours: this nineteen counts tools whose own pages we read, not rows in a table, so it is a different nineteen from the row count of the hosted table above. Semrush is deliberately not among them: its URL and current product name were re-confirmed, but its capabilities were not re-checked, so it carries no ✳ and is not counted. A further twelve tools logged by our Product Hunt scout on 2026-08-19 — LLM SEO Monitor, PromptSignal, Passionfruit Labs, Appear on AI, Promptmonitor, SEORCE, ClayHog, AI Visibility Rank Tracker, Rankfender, Citable, CrowdReply and Keupera — were **not** vetted in this pass, and are absent from both tables for that reason alone: their fit here is *unknown*, not *ruled out*.

## Commands

| Command | Purpose |
|---|---|
| `aeo-platform init` | Set up `.aeo-tracker.json` — auto-discovers category, generates 3 commercial queries, validates them |
| `aeo-platform init --queries-only` | Re-suggest queries without touching brand / domain / providers |
| `aeo-platform run` | Query each AI engine with each query. Save raw responses to `aeo-responses/<domain>/YYYY-MM-DD/` |
| `aeo-platform run --replay [--replay-from=YYYY-MM-DD]` | Rebuild today's summary from cached responses (zero API cost, fully offline — no extractor/sentiment LLM calls either; no API keys required) |
| `aeo-platform run-manual <engine> --from-dir ./folder` | Import pasted UI answers for engines without an accessible API |
| `aeo-platform report` | Generate `report.md` + `report.html`. HTML auto-opens in your browser |
| `aeo-platform diff` | Compare last two runs — what changed, what's new, what regressed |
| `aeo-platform export --format=csv` | Flatten every snapshot into a CSV (or JSON) for Looker / Sheets / your warehouse |
| `aeo-platform crawl-stats --log-file=path` | Parse Apache/nginx access logs to see AI-bot crawl frequency on your own site (Combined Log Format only — IIS W3C Extended Format not supported, see [Limitations](#limitations)) |

`aeo-platform --help` lists every flag. `aeo-platform <cmd> --help` for per-command help.

The flags of every command, the exit codes for cron / Task Scheduler / GitHub Actions and the `.aeo-tracker.json` fields: [commands reference](https://github.com/webappski/aeo-platform/blob/main/docs/commands.md).

## FAQ

### Who maintains `aeo-platform`, and is there a company behind it?

**Webappski is an AEO agency that measures client visibility with `aeo-platform`, its own open-source npm engine — clients can install it and reproduce the measurement grid themselves.** The agency is in Gdynia, Poland; the engine is MIT-licensed so a client can re-derive a grid instead of trusting it. More, and the three caveats: [Who runs this](#who-runs-this--the-agency-behind-aeo-platform).

### What is answer engine optimization (AEO), and how is it different from GEO?

Answer engine optimization (AEO) and generative engine optimization (GEO) describe the same field — the practice of making your brand recommended by AI answer engines (ChatGPT, Claude, Gemini, Perplexity). The naming split is industry-political: *AEO* is preferred by Profound and parts of the agency world; *GEO* is preferred by Wikipedia, AthenaHQ, and most 2026 listicles. `aeo-platform` works for both and surfaces both terms in metadata and reports.

### How is AEO different from SEO?

Traditional SEO optimises for click-through from search-result pages. AEO/GEO optimises for inclusion in the AI-generated answer itself. Per Webappski's 2026 audits and the wider industry consensus, classic domain-authority signals predict a small fraction of AI citations — entity signals (Schema.org with verified `sameAs`, Wikidata Q-IDs, named-author attribution) and citation-source presence (Reddit, YouTube, Wikipedia, G2, niche listicles) do most of the work. `aeo-platform` measures the foundational metric directly: *"when a user asks an AI engine about my category, does my brand appear in the answer?"*

### Which AI engines does `aeo-platform` cover?

Four, via official APIs: **ChatGPT** (`gpt-6-luna` + the Responses `web_search` tool), **Claude** (`claude-sonnet-5`), **Gemini** (`gemini-3.8-flash`), **Perplexity** (`sonar-reasoning-pro`). For browser-only surfaces (Perplexity Pro UI, ChatGPT Pro personalisation, Claude.ai UI) use `run-manual` to paste UI answers. Models auto-discover at run time and refresh to the newest stable variant via provider model-listing APIs — pin a specific model in `.aeo-tracker.json::providers[].model` if you need version-locked measurements for compliance.

### Is my data private?

Yes. Nothing leaves your machine except to the AI providers you explicitly configure (the same providers you'd query from a browser) — plus at most one version check a day against `registry.npmjs.org` (the host npm itself talks to; nothing is sent, skipped in CI/non-TTY, opt out with `AEO_NO_UPDATE_CHECK=1`). No telemetry. No analytics. No traffic to `webappski.com`. Raw responses stay on disk in `aeo-responses/<domain>/YYYY-MM-DD/`. API keys are read from `process.env` and never written to disk. OpenAI Responses requests include `store:false`, which disables Responses application-state storage but does not eliminate separate provider abuse-monitoring retention or constitute Zero Data Retention.

### Do I need API keys for all four engines?

No. One is enough to start: any of `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` (single-key mode — competitor mentions are marked unverified, since there is no second model to cross-check them). Recommended: `OPENAI_API_KEY` + `GEMINI_API_KEY` — they double as the ChatGPT + Gemini columns and power the two-model competitor extractor. `PERPLEXITY_API_KEY` is optional; it adds its engine column.

### What is the 30-day AEO plan?

A free action plan from your own AI: paste `aeo-platform`'s JSON brand-context block (visibility index, per-engine deltas, top competitors, citation gaps, crawl matrix, authority signals) into ChatGPT, Claude, Gemini, or Perplexity and it returns 30 missions of about 1–3 hours each, grouped into 4 weekly chunks and keyed to your gaps. In our July 2026 review of 23 tracked AEO tools, plus a live re-check of 19 tools on 4 September 2026, no other one shipped a *portable* plan generator. Full flow: [The 30-day AEO plan](#the-30-day-aeo-plan-the-portable-wedge-no-hosted-vendor-ships).

### How is this different from Otterly, Profound, Peec, Bluefish?

Otterly, Profound, Peec, Bluefish, AthenaHQ, Goodie — and Waikay, Trakkr, LLMrefs, Superlines, Scrunch AI and AirOps, added to the table after the 4 September 2026 check — are paid hosted dashboards. They tell you the problem inside their UI and mostly stop there; where they do generate an action plan, Waikay most explicitly, it is metered and stays in the dashboard. `aeo-platform` is a free open-source CLI that calls provider APIs directly, runs on your machine, stores raw responses locally, and none of the 17 third-party products in that table shipped a portable paste-into-AI 30-day plan generator when they were re-checked on 4 September 2026. Two of the 19 rows in that table do ship one, and both are ours: this CLI, and Webappski, the agency that maintains it and delivers audits with the same engine — a Webappski-delivered audit runs on our infrastructure, so raw data stays local only on the CLI path. See [Comparison vs hosted AEO platforms](#comparison-vs-hosted-aeo-platforms) for the full table, including what those tools do better than this one.

### Is `aeo-platform` CI-friendly?

Yes. `--json` flag for structured stdout, ANSI auto-disabled on non-TTY, `NO_COLOR` env honoured, exit codes `0/1/2/3` map cleanly to alerting tiers. GitHub Actions / cron example above.

### My first run showed 0% — is the tool broken?

No. New brands typically score 0–5% in the first 4 weeks. AI engines update when third-party sources (blog posts, directories, review sites) start mentioning your brand, not in real time. Typical trajectory: 0% in weeks 1–4, first mention between week 6 and 12. The value is in week-over-week deltas, not the absolute score on day 1. The Recommended actions section of every report tells you which third-party sources to pitch to move the needle. Before acting on a 0%, treat it as a hypothesis and confirm the two checks in [A 0% is a hypothesis, not a fact](#a-0-is-a-hypothesis-not-a-fact) — a zero on an off-target basket is an artefact, not invisibility.

### Does it work with non-English sites?

Yes. The auto-suggest prompt tells the LLM to match the site's primary language (detected from `<html lang>`). Tested on English, Polish, and German sites.

### Does `aeo-platform` work on Windows?

Yes — Node 20+ and `npm install -g aeo-platform` is all you need. The Windows-specific gotchas (the `&&` operator and UTF-16 output in PowerShell 5.1, execution policy, PATH after `npm i -g`, persistent environment variables, long paths, Defender, Task Scheduler time) are listed in the [Windows notes](https://github.com/webappski/aeo-platform/blob/main/docs/quickstart.md#does-aeo-platform-work-on-windows).

### Can I track multiple brands?

Yes. Everything on disk is namespaced by domain (`aeo-responses/<domain>/<date>/`, `aeo-reports/<domain>/<date>/`), so several brands can share one working directory; a separate directory per brand keeps each `.aeo-tracker.json` fully isolated, which is cleaner for many clients. Details: [tracking multiple brands](https://github.com/webappski/aeo-platform/blob/main/docs/commands.md#can-i-track-multiple-brands).

### How often should I run it?

Weekly. Daily adds noise without signal (AI models don't update fast enough to make daily deltas meaningful). Monthly loses meaningful trend resolution.

## Limitations

Honest list of where `aeo-platform` stops short — read before you wire it into a contract or a board slide.

- **API ≠ browser UI.** Personalisation, session context, and occasional model upgrades mean API responses can differ slightly from what users see in the ChatGPT / Gemini / Claude browser apps. Manual paste mode catches the browser-personalisation layer. Scope is spelled out in full under [What this measures — and what it does NOT](#what-this-measures--and-what-it-does-not).
- **No Google AI Overviews / AI Mode or Microsoft Copilot coverage.** These have no first-party query API; the tool does not measure them, so their absence from a score is a coverage gap, not invisibility on those surfaces. A connector is on the roadmap.
- **Week-over-week stochastic variance.** Same queries on the same day typically produce ±5–10% score fluctuation because AI outputs are probabilistic. Use weekly cadence (not daily) to smooth noise.
- **Provider rate limits on free tiers.** Running 3 queries in parallel is usually fine, but back-to-back brand runs can hit 429s.
- **Single-brand scope per config.** Multi-brand workflows need a wrapper that loops over per-client directories.
- **Gemini citation URLs are Vertex AI redirect tokens** — resolved to readable domains using the `title` field; unreadable tokens are dropped rather than displayed.
- **`crawl-stats` parses Apache/nginx Combined Log Format only.** IIS W3C Extended Log Format is not supported in 1.0.x (on the roadmap). Workaround for IIS users: pre-convert with [Log Parser 2.2](https://www.microsoft.com/en-us/download/details.aspx?id=24659) (`logparser "SELECT * INTO out.log FROM in.log" -o:NCSA`) to NCSA Combined format, then point `--log-file=out.log`.

## Roadmap

Where `aeo-platform` is going next (no fixed dates — feedback-driven):

- Google AI Overviews / AI Mode coverage (no first-party query API today — needs a separate connector; see [What this measures — and what it does NOT](#what-this-measures--and-what-it-does-not))
- Multi-brand profiles for agencies running weekly audits on many clients
- Diagnostic prompts asking AI engines *why* they don't cite you
- Optional SQLite-backed history for trends beyond filesystem snapshots
- README AEO-discoverability optimisation driven by real npm-download query patterns

Not planned: hosted dashboard, proprietary scoring layer, data uploads to Webappski servers. Local-first privacy and methodology transparency are core values of `aeo-platform`, not features.

Full version history: [`CHANGELOG.md`](./CHANGELOG.md).

## Migrating from `@webappski/aeo-tracker`

`npm uninstall -g @webappski/aeo-tracker && npm install -g aeo-platform` — the `aeo-tracker` command stays as an alias inside `aeo-platform` and `.aeo-tracker.json` stays compatible. The full account is in the `1.0.0` entry of [CHANGELOG.md](https://github.com/webappski/aeo-platform/blob/main/CHANGELOG.md).

**Longer guides:** [Quickstart, Windows notes, API keys under non-standard names, cost per weekly run](https://github.com/webappski/aeo-platform/blob/main/docs/quickstart.md) · [Commands reference](https://github.com/webappski/aeo-platform/blob/main/docs/commands.md) · [Contributing](https://github.com/webappski/aeo-platform/blob/main/CONTRIBUTING.md).

<details>
<summary><b>Behind this tool</b></summary>

Built and maintained by **[Webappski](https://webappski.com)** — an AEO / GEO agency. `aeo-platform` (formerly `@webappski/aeo-tracker`) is the open-source spinout of Webappski's internal AEO / GEO audit toolchain. Weekly runs against Webappski's own brand and client brands are in production.

The tool was open-sourced after observing a gap between third-party AEO scorecards (which surfaced a mid-range proprietary score for Webappski) and direct-API tests (which showed zero brand mentions across the same engines in the same week). That gap between proprietary score and direct-API truth is the bug `aeo-platform` is built to fix.

Methodology lives in the weekly reports at [webappski.com/blog](https://webappski.com/blog). The tool itself is the *what*; the blog is the *how*.

- [Report a bug](https://github.com/webappski/aeo-platform/issues)
- [Request a feature](https://github.com/webappski/aeo-platform/issues)
- [Open a pull request](https://github.com/webappski/aeo-platform/pulls)
- [Star the repo](https://github.com/webappski/aeo-platform)

</details>

## License

MIT — do whatever you want with it.
