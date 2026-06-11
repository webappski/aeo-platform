# aeo-platform

[![npm version](https://img.shields.io/npm/v/aeo-platform)](https://www.npmjs.com/package/aeo-platform)
[![npm downloads](https://img.shields.io/npm/dw/aeo-platform)](https://www.npmjs.com/package/aeo-platform)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![GitHub stars](https://img.shields.io/github/stars/webappski/aeo-platform?style=social)](https://github.com/webappski/aeo-platform)

> **`aeo-platform` is the open-source CLI for answer-engine optimization (AEO / GEO).** It measures your brand across **ChatGPT, Claude, Gemini, and Perplexity**, audits AI-bot crawlability + authority signals, and exports a JSON brand-context you paste into any AI for a personalised **30-mission AEO plan**. MIT-licensed. Runs locally. Zero runtime dependencies. Free alternative to Otterly, Profound, Peec, and Bluefish.

**macOS / Linux (bash / zsh)**

```bash
npm install -g aeo-platform

export OPENAI_API_KEY="sk-proj-..."     # required
export GEMINI_API_KEY="AIzaSy..."        # required

aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto \
  && aeo-platform run \
  && aeo-platform report
```

**Windows (PowerShell)**

```powershell
npm install -g aeo-platform

$env:OPENAI_API_KEY = "sk-proj-..."     # required (current session only)
$env:GEMINI_API_KEY = "AIzaSy..."        # required (current session only)

aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto
if ($LASTEXITCODE -eq 0) { aeo-platform run }
if ($LASTEXITCODE -eq 0) { aeo-platform report }
```

**Windows (CMD)**

```cmd
npm install -g aeo-platform

set OPENAI_API_KEY=sk-proj-...
set GEMINI_API_KEY=AIzaSy...

aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto && aeo-platform run && aeo-platform report
```

> Note: `&&` chain works in CMD and PowerShell 7+, but **not in PowerShell 5.1** (the default Windows 10/11 shell — check via `$PSVersionTable.PSVersion`). For persistent env vars across sessions on Windows, see the [Full quickstart](#full-quickstart-for-first-time-terminal-users) below. Git Bash and WSL users — the bash block above works as-is.

**Already know your 3 target queries?** Skip the LLM auto-suggest pipeline (zero LLM cost, BYO mode added as first-class in `1.0.3`):

```bash
aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM \
  --keywords="best X for Y,top X 2026,X vs alternatives"
```

Use category-based phrasing («best X for Y» / «top X 2026») the way real users search — the strict commercial-only validator blocks brand-comparison archetypes like «brand vs alternatives» that LLMs auto-correct away for new brands.

The HTML report opens in your browser. Weekly cadence after that: `aeo-platform run && aeo-platform report` (or the PowerShell `if ($LASTEXITCODE -eq 0)` equivalent on PS 5.1).

> Renamed from `@webappski/aeo-tracker` in `1.0.0` (2026-05-13). The `aeo-tracker` CLI command stays as a built-in alias — existing scripts keep working. Migration: `npm i -g aeo-platform`.

---

## Why `aeo-platform`

Six concrete reasons `aeo-platform` exists, in order of how often they decide the install:

- **Measures 4 engines via official APIs** — ChatGPT (`gpt-5-search-api`), Claude (`claude-sonnet-4-7`), Gemini (`gemini-2.5-flash`), Perplexity (`sonar-reasoning`). No scraping. No proprietary score.
- **Local-first.** Raw responses stay on your disk in `aeo-responses/YYYY-MM-DD/`. No telemetry. No traffic to webappski.com. API keys read from `process.env`, never written to disk.
- **CI-grade.** Exit codes `0/1/2/3` (stable / regressed / invisible / providers errored). `--json` stdout. Cron-friendly.
- **Zero runtime dependencies.** `"dependencies": {}` in `package.json`. Vanilla Node 20+, single-file HTML report under 200 KB.
- **MIT.** Fork it, embed it, ship it inside a paid product — your choice.

## Optional engines + first-time terminal users

The recommended pair above (OpenAI + Gemini) covers the ChatGPT and Gemini columns with cross-model verification. Minimum to start: any ONE research-capable key (OpenAI, Gemini, or Anthropic) — single-key mode runs the same pipeline on one model and marks competitor mentions as unverified. Two more keys are optional and each adds an engine column to the report:

```bash
# macOS / Linux
export ANTHROPIC_API_KEY="sk-ant-..."   # adds Claude column
export PERPLEXITY_API_KEY="pplx-..."     # adds Perplexity column
```

```powershell
# Windows PowerShell — current session
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:PERPLEXITY_API_KEY = "pplx-..."

# Windows PowerShell — persistent (User scope, requires terminal restart)
[System.Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY','sk-ant-...','User')
[System.Environment]::SetEnvironmentVariable('PERPLEXITY_API_KEY','pplx-...','User')
```

```cmd
:: Windows CMD — current session
set ANTHROPIC_API_KEY=sk-ant-...
set PERPLEXITY_API_KEY=pplx-...

:: Windows CMD — persistent (requires terminal restart)
setx ANTHROPIC_API_KEY "sk-ant-..."
setx PERPLEXITY_API_KEY "pplx-..."
```

Get keys at: [platform.openai.com/api-keys](https://platform.openai.com/api-keys), [aistudio.google.com/apikey](https://aistudio.google.com/apikey), [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys), [docs.perplexity.ai](https://docs.perplexity.ai/).

**Never used a CLI before?** A founder-friendly walk-through (5 minutes, no terminal background required) is in the [Full quickstart](#full-quickstart-for-first-time-terminal-users) collapsible below.

## What you get

Every `aeo-platform report` writes two files in `aeo-reports/<date>/`:

- `report.md` — markdown with inline SVG charts. Renders on GitHub, Notion, VSCode preview, email. Perfect for CI logs and PR comments.
- `report.html` — single-file editorial bento layout, ~170 KB, embedded variable fonts, works offline from `file://`, zero CDN, zero JS dependencies, zero tracking pixels.

The HTML report has:

| Section | Surfaces |
|---|---|
| Hero | UVI (Unified Visibility Index) · mention rate · lift opportunities · top competitor · ⓘ popover with per-axis math |
| `01 Overview` | 8-week score trend · listicle-pitch KPI · topic-cluster bars · top-3 actionable gaps preview |
| `02 Visibility` | Per-engine cards · query × engine matrix (Mention / Position / Sentiment lenses) · region breakdown when `--geo` is used · verbatim quotes |
| `03 Competitors` | Most-named brands · 4-axis radar (presence / sentiment / rank / mentions) vs top-3 competitors |
| `04 Citations` | Domain share-of-voice (own-domain marker) · category breakdown · top-cited publishers |
| `05 Actions` | 5 ordered moves (badges: FIX GAP / LOCK IN WIN / COMPETE / DEFEND) with specific competitors to displace and URLs to pitch |
| `06 Diagnostics` | AI-Bot Crawl Readiness · authority presence (Wikipedia / Reddit / GitHub) · per-engine session cost · region indicator · UTM citations · AI-ad detector |
| Bridge card | Copy-prompt button → 30-mission paste-into-AI plan |

Each surface is grounded in actual run data: specific competitors named by this run, specific URLs cited by AI, specific gaps you can act on this week.

## The 30-mission AEO plan (the wedge no commercial vendor ships)

After measuring you across 4 engines, `aeo-platform report` exports a **JSON brand-context block** with everything the AI needs to write a grounded plan: visibility index, per-engine citation deltas, top competitors, citation gaps, crawl matrix, authority signals, page signals, entity graph, region, freshness, competitor pricing tier.

Paste that JSON into **your own ChatGPT / Claude / Gemini / Perplexity** (any frontier model — same chat subscription you already pay for, no extra API spend). Ask: *"give me a 30-mission plan to be cited more"*. The answer is keyed to your specific gaps — named competitors from `topCompetitors`, URLs from `topCanonicalSources`, weakest-engine fortification, citation-gap closure.

**Workflow:**

1. `aeo-platform report` — opens HTML report in browser.
2. Find the section *Your AEO action prompt*. Click the one-tap **Copy** button.
3. Paste into your ChatGPT, Claude, Gemini, or Perplexity chat.
4. Receive a 30-mission plan: 30 actions × ≈1–3 hours each, grouped into 4 weekly chunks, every action references a specific competitor / URL / engine / gap from the data.

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

**Why no hosted AEO dashboard ships this:** a paste-into-AI plan cannibalises the dashboard moat. Once the user takes the JSON to their own AI chat, the vendor's UI is no longer the destination. Open-source has the opposite incentive — show zero when it's zero, hand you the data, win when you take it wherever you want.

## Multi-engine coverage

**aeo-platform calls four AI answer engines via their official REST APIs in a single run: ChatGPT (`gpt-5-search-api`), Gemini (`gemini-2.5-flash`), Claude (`claude-sonnet-4-7`), Perplexity (`sonar-reasoning`). OpenAI + Gemini keys are recommended (they power the two-model hallucination filter); any ONE research-capable key (OpenAI, Gemini, or Anthropic) is enough to start in single-key mode — competitor mentions are then marked unverified. Claude + Perplexity add optional columns. Browser-only surfaces (Perplexity Pro UI, ChatGPT Pro personalisation, Claude.ai chat) are covered via `run-manual` paste mode that merges into the same `_summary.json`.**

| Engine | Default model | API path | Web-search grounding | Required key |
|---|---|---|---|---|
| ChatGPT (OpenAI) | `gpt-5-search-api` | direct REST | yes (search-API) | `OPENAI_API_KEY` |
| Gemini (Google) | `gemini-2.5-flash` | direct REST | optional (request flag) | `GEMINI_API_KEY` |
| Claude (Anthropic) | `claude-sonnet-4-7` | direct REST | optional (request flag) | `ANTHROPIC_API_KEY` |
| Perplexity | `sonar-reasoning` | direct REST | always | `PERPLEXITY_API_KEY` |

OpenAI + Gemini keys are **recommended** (two-model competitor extractor: GPT-5-mini + Gemini-2.5-flash cross-check filters hallucinated brand mentions). Minimum: any ONE of OpenAI / Gemini / Anthropic — single-key mode runs the extractor on one model and marks competitor mentions unverified. Perplexity is optional — adds a column.

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

## AI-bot crawlability audit (zero LLM cost)

**The crawlability audit scores your domain against the 12-bot AI-crawler matrix (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, and 8 others) using ~3 HTTPS GETs against your `/robots.txt`, `/sitemap.xml`, and `/llms.txt`. No LLM calls, no auth, no cost. The composite **AI-Bot Crawl Readiness** score (0–100) weighs robots posture 30%, bots-not-blocked 25%, sitemap 25%, llms.txt 20%.**

`aeo-platform report` runs a pure-HTTP audit of your own domain against the AI-crawler matrix. No LLM calls. Roughly 3 HTTPS GETs.

| Bot | Owner | Purpose |
|---|---|---|
| `GPTBot` | OpenAI | Training crawl |
| `OAI-SearchBot` | OpenAI | ChatGPT Search indexer |
| `ChatGPT-User` | OpenAI | On-demand fetch when a user pastes a URL |
| `Google-Extended` | Google | Gemini training opt-out |
| `GoogleOther` | Google | AI Overviews indexer |
| `ClaudeBot` | Anthropic | Training crawl |
| `Claude-Web` | Anthropic | On-demand fetch (Claude.ai chat) |
| `anthropic-ai` | Anthropic | On-demand fetch (legacy UA string) |
| `PerplexityBot` | Perplexity | Indexer |
| `Perplexity-User` | Perplexity | On-demand fetch |
| `CCBot` | Common Crawl | Used by OpenAI, Anthropic, others as training data |
| `Bytespider` | ByteDance | Doubao / China-market AI |

Each bot is mapped to `allowed | blocked | partial | unspecified` from your `/robots.txt`. `sitemap.xml` + `llms.txt` presence are also checked. The composite **AI-Bot Crawl Readiness** score (0-100) weighs robots 30% · bots-not-blocked 25% · sitemap 25% · llms.txt 20%.

Note: this measures *technical access* — not actual answer-pool inclusion. Answer-pool inclusion is driven by off-page authority (Wikipedia, Reddit, listicles, review platforms) — covered in the next section.

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

**UVI (Unified Visibility Index) is a 0–100 composite of four AI-answer signals: Presence 35% (mentioned cells / total cells), Sentiment 25% (high-confidence positive cells / mentioned cells), Rank 20% (normalised average rank position), Citation 20% (cells where your domain was cited as a source). Weights are visible in `lib/report/visibility-index.js`; sub-components with insufficient data are excluded and remaining weights re-normalise — never phantom values. Sample size is published alongside the score.**

`aeo-platform` rolls four AI-answer signals into a single 0-100 composite. Every weight is in the source (`lib/report/visibility-index.js`); the ⓘ popover next to the hero number shows the per-axis math on every run.

| Sub-component | Weight | What it measures |
|---|---|---|
| **Presence** | 35% | Cells where your brand was mentioned (yes/src) out of total cells |
| **Sentiment** | 25% | High-confidence positive cells out of cells with a mention |
| **Rank** | 20% | Average rank position when mentioned, normalised 0-100 |
| **Citation** | 20% | Cells where your domain was cited as a source |

Sub-components with insufficient data (e.g. zero rank positions in a first run) are excluded; remaining weights re-normalise and the popover flags the re-norm. No phantom values. Sample size is published alongside the score (`n=K high-confidence cells`).

## Comparison vs hosted AEO platforms

| Tool | Pricing model | Open source | Raw data stays local | Paste-into-AI 30-mission plan |
|---|---|---|---|---|
| **`aeo-platform`** | **Free + your own API spend** | **MIT** | **Yes** | **Yes — no tracked vendor ships this as of May 2026** |
| Otterly | Paid subscription | No | No | No |
| Profound | Paid subscription | No | No | No |
| Peec.ai | Paid subscription | No | No | No |
| Bluefish | Enterprise contract | No | No | No |
| AthenaHQ | Paid subscription | No | No | No |
| Goodie | Paid subscription | No | No | No |
| HubSpot AEO Grader | Free one-shot scorecard | No | No | No |
| Evertune | Custom contract | No | No | No |
| Ahrefs Brand Radar | Paid SEO-suite add-on | No | No | No |
| Semrush AI Toolkit | Paid SEO-suite add-on | No | No | No |
| Discovered Labs | Managed-service retainer | No | No | No |

**Pick something else when:** you need team SSO, Slack/email alerts, multi-brand management UI, or SOC-2 — **Profound** or **Peec.ai** are the better fit. For broader engine coverage out-of-the-box — **Otterly**. For enterprise agentic-marketing infrastructure — **Bluefish**. For a free one-time scorecard inside an existing HubSpot workflow — **HubSpot AEO Grader**.

**Pick `aeo-platform` when:** indie founders, small AEO / GEO agencies, dev-centric teams who prefer CLI + CI integration, anyone who wants the paste-into-AI plan, anyone who can't justify a subscription for a tool whose direct-API cost is a few cents per week.

## Comparison vs open-source AEO trackers

A handful of open-source AEO trackers exist; methodologies overlap. The closest peer is **geo-aeo-tracker (danishashko)** — same goal of tracking brand mentions across AI answer engines via API calls. The structural difference is the **paste-into-AI 30-mission plan generator**: after measuring you across 4 engines, `aeo-platform` exports a JSON brand-context block you paste into any frontier AI chat to receive a 30-action plan keyed to your specific gaps. As of May 2026, no other open-source AEO tracker ships this wedge.

## Commands

| Command | Purpose |
|---|---|
| `aeo-platform init` | Set up `.aeo-tracker.json` — auto-discovers category, generates 3 commercial queries, validates them |
| `aeo-platform init --queries-only` | Re-suggest queries without touching brand / domain / providers |
| `aeo-platform run` | Query each AI engine with each query. Save raw responses to `aeo-responses/YYYY-MM-DD/` |
| `aeo-platform run --replay [--replay-from=YYYY-MM-DD]` | Rebuild today's summary from cached responses (zero API cost, fully offline — no extractor/sentiment LLM calls either; no API keys required) |
| `aeo-platform run-manual <engine> --from-dir ./folder` | Import pasted UI answers for engines without an accessible API |
| `aeo-platform report` | Generate `report.md` + `report.html`. HTML auto-opens in your browser |
| `aeo-platform diff` | Compare last two runs — what changed, what's new, what regressed |
| `aeo-platform export --format=csv` | Flatten every snapshot into a CSV (or JSON) for Looker / Sheets / your warehouse |
| `aeo-platform crawl-stats --log-file=path` | Parse Apache/nginx access logs to see AI-bot crawl frequency on your own site (Combined Log Format only — IIS W3C Extended Format not supported, see [Limitations](#limitations)) |

`aeo-platform --help` lists every flag. `aeo-platform <cmd> --help` for per-command help.

## Flags reference

Every flag `aeo-platform` accepts, grouped by which command consumes it.

| Flag | Commands | Purpose |
|---|---|---|
| `--yes` / `-y` | `init` | Non-interactive (CI / dotfiles). Requires `--brand`, `--domain`, and `--auto` or `--manual` |
| `--auto` | `init --yes` | Full research pipeline: brainstorm → filter → score → cross-model validate → select |
| `--manual` | `init --yes` | Skip LLM analysis; use pre-existing queries |
| `--light` | `init --yes --auto` | Bypass research pipeline; single-shot suggest |
| `--keywords "q1,q2,q3"` | `init --yes` | Bring-your-own queries — zero LLM cost |
| `--queries-only` | `init` | Re-suggest queries without changing brand / domain / providers |
| `--strict-validation` | `init`, `run` | Cross-check query validation with 2 LLM providers (~2× validation cost) |
| `--force` | `run` | Bypass validation gate |
| `--json` | `run` | Structured JSON to stdout, ANSI suppressed (CI-friendly) |
| `--geo=us,uk,de,...` | `run` | Run queries under multiple regional contexts. 12 codes: `us, uk, de, fr, es, it, ca, au, in, br, jp, nl`. Multiplies cost by region count |
| `--depth=<web\|full\|auto>` | `run` | `web` (default) — single web pass. `full` — adds training-data pass (~2× cost). `auto` — prompts if last training baseline > 14 days |
| `--replay` | `run` | Rebuild summary from cached raw responses (zero API cost, fully offline — skips live model discovery AND extractor/sentiment LLM calls; no API keys required) |
| `--replay-from=YYYY-MM-DD` | `run` | Replay a specific date instead of the most recent capture |
| `--from-dir <path>` | `run-manual` | Directory containing `q1.txt`, `q2.txt`, `q3.txt` with pasted UI answers |
| `--last <N>` / `--since <date>` | `diff` | Compare last N runs / compare a date to latest run |
| `--format=<csv\|json>` | `export` | Output format (CSV default) |
| `--refresh-cache <fields>` | `report` | Force-refresh cached fields before report. CSV list or `all` |
| `--no-html` | `report` | Markdown only — skip HTML write + browser auto-open |
| `--no-open` | `report` | Write files but don't auto-open the browser |
| `--no-authority` / `--no-page-signals` / `--no-entity-graph` / `--no-pricing` | `report` | Skip optional fetch-heavy checks (use behind a VPN, offline, or to dodge rate limits) |
| `--openai-model=<id>` / `--gemini-model=<id>` / `--anthropic-model=<id>` / `--perplexity-model=<id>` | `run` | Override the model for one run only (no config rewrite). E.g. switch from `gpt-5-search-api` (6k TPM) to `gpt-5` (90k TPM) under rate-limit pressure |
| `--add-queries "q1,q2,q3"` | `init` | Add queries to an existing config without re-running brainstorm; preserves prior basket history |
| `--replace-queries "q1,q2,q3"` | `init` | Replace queries in an existing config (forks basket version); preserves prior versions in `basketHistory` |

## Exit codes (CI-friendly)

`aeo-platform run` returns one of four exit codes after every audit — wire them into your alerting tier.

| Code | Meaning | Typical CI response |
|---|---|---|
| `0` | Score stable or improved vs previous run | Success — nothing to alert |
| `1` | Score dropped more than `regressionThreshold` (default 10pp) | High-priority alert |
| `2` | All checks returned zero mentions | Medium alert — brand invisible (normal on day 1) |
| `3` | All providers errored | Infrastructure alert (keys / billing / network) |

Tune the threshold in `.aeo-tracker.json`:

```json
{ "regressionThreshold": 5 }
```

## CI integration

**Bash + cron (macOS / Linux):**

```bash
#!/bin/bash
aeo-platform run --json > /var/log/aeo-$(date +%F).json
case $? in
  0) : ;;                      # stable
  1) slack-alert "AEO regression detected" ;;
  2) : ;;                      # invisible — expected for new brands
  3) slack-alert "aeo-platform: API errors" ;;
esac
```

**Windows (PowerShell + Task Scheduler):**

> One-time setup: enable script execution for the current user — `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (or skip and use `-ExecutionPolicy Bypass` in the schtasks command below).

Save as `aeo-audit.ps1`:

```powershell
# UTF-8 output (PowerShell 5.1 defaults to UTF-16; PowerShell 7+ is UTF-8 already)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$logDir = Join-Path $env:LOCALAPPDATA 'aeo'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("aeo-{0}.json" -f (Get-Date -Format 'yyyy-MM-dd'))

aeo-platform run --json | Out-File -Encoding utf8 $logPath
$exitCode = $LASTEXITCODE   # capture BEFORE any other command — Invoke-RestMethod overwrites $LASTEXITCODE

function Send-SlackAlert($msg) {
  if ($env:SLACK_WEBHOOK) {
    Invoke-RestMethod -Uri $env:SLACK_WEBHOOK -Method Post `
      -Body (@{text = $msg} | ConvertTo-Json) -ContentType 'application/json' | Out-Null
  }
}

switch ($exitCode) {
  0 { }                                                     # stable
  1 { Send-SlackAlert 'AEO regression detected' }
  2 { }                                                     # invisible — expected for new brands
  3 { Send-SlackAlert 'aeo-platform: API errors' }
}
exit $exitCode
```

Register as a weekly Task Scheduler job (Monday 09:00 **local time** — Task Scheduler does not understand UTC):

```cmd
schtasks /Create /SC WEEKLY /D MON /TN "AEO Weekly Audit" ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\aeo-audit.ps1" ^
  /ST 09:00
```

> Cron and Task Scheduler use different time bases: Linux cron typically runs in the server's TZ (often UTC on cloud VMs), Task Scheduler `/ST` is always **local machine time**. GitHub Actions cron (next block) is **always UTC**. Pick your TZ deliberately.

**GitHub Actions:**

```yaml
name: Weekly AEO Audit
on:
  schedule: [{ cron: '0 9 * * 1' }]   # Monday 9:00 UTC

jobs:
  audit:
    runs-on: ubuntu-latest             # works identically with windows-latest;
                                       # on Windows replace bash `>` with `| Out-File -Encoding utf8`
                                       # to avoid UTF-16 BOM in the JSON artifact.
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g aeo-platform
      - run: aeo-platform run --json > latest.json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          NO_COLOR: '1'
      - uses: actions/upload-artifact@v4
        with: { name: aeo-latest, path: aeo-responses/ }
```

## Configuration (`.aeo-tracker.json`)

`aeo-platform init` creates `.aeo-tracker.json` in the working directory. The file name is preserved across the rename so existing dotfiles keep working.

```json
{
  "brand": "YOURBRAND",
  "domain": "YOURDOMAIN.COM",
  "category": "Short description of your competitive space",
  "queries": [
    "best YOURCATEGORY services 2026",
    "top YOURCATEGORY monitoring tools 2026",
    "YOURCATEGORY consultants for B2B startups"
  ],
  "regressionThreshold": 10,
  "providers": {
    "openai":     { "model": "gpt-5-search-api",  "env": "OPENAI_API_KEY" },
    "gemini":     { "model": "gemini-2.5-flash",  "env": "GEMINI_API_KEY" },
    "anthropic":  { "model": "claude-sonnet-4-7", "env": "ANTHROPIC_API_KEY" },
    "perplexity": { "model": "sonar-reasoning",   "env": "PERPLEXITY_API_KEY" }
  }
}
```

Fields:

- `brand`, `domain`, `category` — what the tool measures
- `queries` — exactly 3, unbranded, commercial-intent. Methodological queries («how to X») are rejected by the validator
- `regressionThreshold` — exit code `1` fires when score drops by more than this many percentage points week-over-week (default 10)
- `providers[].env` — name of the env var that holds the key (override for non-standard names like `OPENAI_API_KEY_DEV`)
- `providers[].model` — auto-discovered at run start (newest available); override here to pin a specific model

## FAQ

### What is answer engine optimization (AEO), and how is it different from GEO?

Answer engine optimization (AEO) and generative engine optimization (GEO) describe the same field — the practice of making your brand recommended by AI answer engines (ChatGPT, Claude, Gemini, Perplexity). The naming split is industry-political: *AEO* is preferred by Profound and parts of the agency world; *GEO* is preferred by Wikipedia, AthenaHQ, and most 2026 listicles. `aeo-platform` works for both and surfaces both terms in metadata and reports.

### How is AEO different from SEO?

Traditional SEO optimises for click-through from search-result pages. AEO/GEO optimises for inclusion in the AI-generated answer itself. Per Webappski's 2026 audits and the wider industry consensus, classic domain-authority signals predict a small fraction of AI citations — entity signals (Schema.org with verified `sameAs`, Wikidata Q-IDs, named-author attribution) and citation-source presence (Reddit, YouTube, Wikipedia, G2, niche listicles) do most of the work. `aeo-platform` measures the foundational metric directly: *"when a user asks an AI engine about my category, does my brand appear in the answer?"*

### Which AI engines does `aeo-platform` cover?

Four, via official APIs: **ChatGPT** (`gpt-5-search-api`), **Claude** (`claude-sonnet-4-7`), **Gemini** (`gemini-2.5-flash`), **Perplexity** (`sonar-reasoning`). For browser-only surfaces (Perplexity Pro UI, ChatGPT Pro personalisation, Claude.ai UI) use `run-manual` to paste UI answers. Models auto-discover at run time and refresh to the newest stable variant via provider model-listing APIs — pin a specific model in `.aeo-tracker.json::providers[].model` if you need version-locked measurements for compliance.

### Is my data private?

Yes. Nothing leaves your machine except to the AI providers you explicitly configure (the same providers you'd query from a browser). No telemetry. No analytics. No traffic to `webappski.com`. Raw responses stay on disk in `aeo-responses/YYYY-MM-DD/`. API keys are read from `process.env` and never written to disk.

### Do I need API keys for all four engines?

No. One is enough to start: any of `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` (single-key mode — competitor mentions are marked unverified, since there is no second model to cross-check them). Recommended: `OPENAI_API_KEY` + `GEMINI_API_KEY` — they double as the ChatGPT + Gemini columns and power the two-model competitor extractor. `PERPLEXITY_API_KEY` is optional; it adds its engine column.

### What is the 30-mission AEO plan?

A personalised action plan you get by pasting `aeo-platform`'s JSON brand-context block (visibility index, per-engine deltas, top competitors, citation gaps, crawl matrix, authority signals) into your own ChatGPT, Claude, Gemini, or Perplexity chat. The receiving AI returns 30 missions (≈1–3 hours each, grouped into 4 weekly chunks) keyed to your specific gaps — named competitors to displace, specific URLs to pitch, weakest-engine fortification, citation-gap closure. As of May 2026, no other tracked AEO tool ships this paste-into-AI plan generator. Detailed flow above in [The 30-mission AEO plan](#the-30-mission-aeo-plan-the-wedge-no-commercial-vendor-ships).

### How is this different from Otterly, Profound, Peec, Bluefish?

Otterly, Profound, Peec, Bluefish, AthenaHQ, and Goodie are paid hosted dashboards — monitoring-only. They tell you the problem inside their UI and stop there. `aeo-platform` is a free open-source CLI that calls provider APIs directly, runs on your machine, stores raw responses locally, and — as of May 2026 — is the only tracked AEO tool that ships a paste-into-AI 30-mission plan generator. See [Comparison vs hosted AEO platforms](#comparison-vs-hosted-aeo-platforms) for the full table.

### Is `aeo-platform` CI-friendly?

Yes. `--json` flag for structured stdout, ANSI auto-disabled on non-TTY, `NO_COLOR` env honoured, exit codes `0/1/2/3` map cleanly to alerting tiers. GitHub Actions / cron example above.

### My first run showed 0% — is the tool broken?

No. New brands typically score 0–5% in the first 4 weeks. AI engines update when third-party sources (blog posts, directories, review sites) start mentioning your brand, not in real time. Typical trajectory: 0% in weeks 1–4, first mention between week 6 and 12. The value is in week-over-week deltas, not the absolute score on day 1. The Recommended actions section of every report tells you which third-party sources to pitch to move the needle.

### Does it work with non-English sites?

Yes. The auto-suggest prompt tells the LLM to match the site's primary language (detected from `<html lang>`). Tested on English, Polish, and German sites.

### Does `aeo-platform` work on Windows?

Yes — Node 20+ and `npm install -g aeo-platform` is all you need. The CLI uses `path.join` everywhere, opens the HTML report via `start` on Windows (the PowerShell/CMD equivalent of macOS `open` and Linux `xdg-open`), and reads API keys from `process.env` identically. **PowerShell 5.1, PowerShell 7+, CMD, Git Bash, and WSL are all supported.**

Known Windows-specific gotchas to watch for:

- **`&&` chain operator** works in CMD and PowerShell 7+; **not in PowerShell 5.1** (the default Windows 10/11 shell — check via `$PSVersionTable.PSVersion`). Use `;` or separate commands with `if ($LASTEXITCODE -eq 0) { ... }` checks.
- **`aeo-platform run --json > out.json` in PowerShell 5.1 writes UTF-16 LE**, which breaks JSON parsers downstream. Pipe through `Out-File -Encoding utf8` instead, or upgrade to PowerShell 7+ (UTF-8 by default). See the CI section above for the full pattern.
- **PowerShell Execution Policy** blocks `.ps1` scripts by default. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or pass `-ExecutionPolicy Bypass` to `powershell.exe` for one-off invocations.
- **`npm i -g` PATH issue:** binaries land in `%APPDATA%\npm` which is not always on PATH right after Node install. Restart the terminal if `aeo-platform` is not found, or use `npx aeo-platform` instead (no global install needed).
- **Persistent env vars require a terminal restart.** `setx` (CMD) and `[System.Environment]::SetEnvironmentVariable(...,'User')` (PowerShell) write to the User profile but do not affect the current session. Use `set` / `$env:` for the current session only.
- **`crawl-stats` parses Apache/nginx logs only** — IIS W3C Extended Log Format is not supported in 1.0.x (on the roadmap). Workaround: convert with [Log Parser 2.2](https://www.microsoft.com/en-us/download/details.aspx?id=24659) to NCSA Combined first.
- **Brand names with non-ASCII characters** render correctly in PowerShell 7+ and Windows Terminal; legacy `cmd.exe` may show `?` for Cyrillic / CJK in console output (file output to `_summary.json` is always UTF-8 and unaffected). For Cyrillic console output in CMD: `chcp 65001` switches the codepage to UTF-8.
- **Manual paste mode + Notepad:** save `.txt` files as **UTF-8 without BOM** (Notepad's «UTF-8 with BOM» default leaves an invisible byte at file start that affects mention detection). VSCode and Notepad++ default to UTF-8 without BOM.
- **Long paths (`MAX_PATH` 260 chars).** If your repo lives deep under `C:\Users\<long-username>\...` and you hit `ENAMETOOLONG` mid-run, enable Windows Long Paths once: `Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1` (admin PowerShell, then reboot). Alternative: move the working directory closer to a drive root (e.g. `C:\aeo\<brand>`).
- **Windows Defender** occasionally flags Node-based CLI tools. If `aeo-platform run` is blocked, add `%APPDATA%\npm` to Defender exclusions.
- **Task Scheduler `/ST` is local time, not UTC** (unlike GitHub Actions cron). Pick your timezone deliberately.

### Can I track multiple brands?

Yes — create a separate working directory for each brand with its own `.aeo-tracker.json`. A wrapper script that loops over client directories is ~10 lines of bash (macOS / Linux) or PowerShell (Windows).

### How often should I run it?

Weekly. Daily adds noise without signal (AI models don't update fast enough to make daily deltas meaningful). Monthly loses meaningful trend resolution.

### What's new in 1.0.8?

Hotfix on top of 1.0.7 — surfaced by maintainer dogfood. Three connected fixes plus relaxed confidence rules:

- **Trust LLM's `valid:true` verdict.** Previously the validator blocked queries with `valid:true` but confidence < 0.7 — but normal commercial queries routinely score 0.6–0.7 (LLM accounts for alternate meanings). The hard threshold rejected good queries. Now: if LLM said «valid» — we accept. Confidence stays in cache for audit only.
- **Substitution uses the SAME rules as main validation.** Pre-1.0.8 the silent-substitution block checked only `search_behavior`, while main validation checked `valid` AND `search_behavior`. Queries passed substitution then got re-blocked by main — recovery panel fired with «5 of 5 commercial passed» but still listed blocked queries. Same class of bug we fought in 1.0.4–1.0.7. Closed structurally — both paths now apply identical criteria.
- **Recovery panel labels show the real reason.** Pre-1.0.8 a `valid:false, retrieval-triggered` blocker rendered as «non-commercial (search_behavior: retrieval-triggered)» — internally contradictory. Now: «LLM rejected: <reason>» for `valid:false`, «non-commercial» only when truly non-commercial, static-issue message for acronym ambiguity.
- **Recovery panel header shows both counts honestly.** Was «only X of 5 commercial candidates passed validation» which lied when LLM-blocking happened. Now: «X of 5 commercial-OK, Y blocked by LLM verdict».

### What's new in 1.0.7?

Hotfix on top of 1.0.6 — surfaced by maintainer dogfood within minutes of the 1.0.6 publish.

- **`gpt-5-search-api` no longer fails on every cell.** 1.0.6 sent `reasoning_effort` to all `gpt-5*` models indiscriminately; search-variants (which are RAG-tuned and stripped-down) rejected it with HTTP 400. `SUPPORTS_REASONING_EFFORT` whitelist now excludes any model ID containing `search` — works for `gpt-5-search-api`, `gpt-5-mini-search-api`, `gpt-4o-search-preview`, and any future search variant.
- **Live status labels rewritten.** Cryptic `firing…` and `60s pacing` replaced with concrete labels: `calling provider API (network in-flight)`, `TPM rate-limit — 58s until token-bucket refill`, `provider cooldown (post-429 backoff) — 12s remaining`.
- **Countdown ticks down in real time.** Operator sees `60s → 59s → 58s …` updating each frame, not a static label that looks frozen.
- **Abort hint at top of live region** — `(running 12 cells across 4 providers — press Ctrl+C to abort cleanly)`. Documents the affordance.

### What's new in 1.0.6?

Commercial-only pipeline with silent substitution. The 4-bucket query generation (commercial / problem / vertical / comparison) was retired — vertical/problem/comparison queries reliably failed the downstream commercial-only validator, which is what produced the recurring "recovery panel suggests command that the CLI rejects" trust failure from 1.0.2 through 1.0.5. New pipeline generates 5 commercial vendor-listing queries (3 needed + 2 spares), validates all 5 at init time, silently substitutes any of the top-3 that fail with passing spares. Operator sees only the final 3 — no recovery panel for the typical case. Recovery panel fires ONLY when fewer than 3 of 5 commercial candidates survive validation (the genuine impossibility case). Full notes in [CHANGELOG.md](./CHANGELOG.md).

### What's new in 1.0.5?

Validator-honesty release (1.0.4 work + a pool top-up follow-up that landed in 1.0.5; 1.0.4 was never published to npm). The `(validated)` tag in `init` now means BOTH validator stages passed (category-validation + industry-fit / commercial-only) — earlier versions tagged queries as `(validated)` after one stage only, and the recovery panel then suggested commands that the validator re-blocked on the next run. A `--manual` interactive escape hatch was added to the recovery panel for new brands the LLM has no context for. Plus self-sufficient pool top-up: when initial pool validation produces fewer than 3 RETRIEVAL-passing alternatives, the tool autonomously generates the missing queries via a dedicated LLM call instead of asking the operator to retry — so the recovery panel never suggests an invalid `--keywords` command. Full notes in [CHANGELOG.md](./CHANGELOG.md).

## Limitations

Honest list of where `aeo-platform` stops short — read before you wire it into a contract or a board slide.

- **API ≠ browser UI.** Personalisation, session context, and occasional model upgrades mean API responses can differ slightly from what users see in the ChatGPT / Gemini / Claude browser apps. Manual paste mode catches the browser-personalisation layer.
- **Week-over-week stochastic variance.** Same queries on the same day typically produce ±5–10% score fluctuation because AI outputs are probabilistic. Use weekly cadence (not daily) to smooth noise.
- **Provider rate limits on free tiers.** Running 3 queries in parallel is usually fine, but back-to-back brand runs can hit 429s.
- **Single-brand scope per config.** Multi-brand workflows need a wrapper that loops over per-client directories.
- **Gemini citation URLs are Vertex AI redirect tokens** — resolved to readable domains using the `title` field; unreadable tokens are dropped rather than displayed.
- **`crawl-stats` parses Apache/nginx Combined Log Format only.** IIS W3C Extended Log Format is not supported in 1.0.x (on the roadmap). Workaround for IIS users: pre-convert with [Log Parser 2.2](https://www.microsoft.com/en-us/download/details.aspx?id=24659) (`logparser "SELECT * INTO out.log FROM in.log" -o:NCSA`) to NCSA Combined format, then point `--log-file=out.log`.

## Roadmap

Where `aeo-platform` is going next (no fixed dates — feedback-driven):

- Multi-brand profiles for agencies running weekly audits on many clients
- Diagnostic prompts asking AI engines *why* they don't cite you
- Optional SQLite-backed history for trends beyond filesystem snapshots
- README AEO-discoverability optimisation driven by real npm-download query patterns

Not planned: hosted dashboard, proprietary scoring layer, data uploads to Webappski servers. Local-first privacy and methodology transparency are core values of `aeo-platform`, not features.

Full version history: [`CHANGELOG.md`](./CHANGELOG.md).

## Migrating from `@webappski/aeo-tracker`

```bash
npm uninstall -g @webappski/aeo-tracker
npm install -g aeo-platform
```

The CLI command `aeo-tracker` keeps working as a built-in alias inside `aeo-platform`. Your `.aeo-tracker.json` config and `aeo-responses/` / `aeo-reports/` folders are unchanged. Project-dependency users with caret `^0.3.0` in `package.json` should manually edit it to `"aeo-platform": "^1.0.0"` (caret semantics don't cross majors). See [`CHANGELOG.md`](./CHANGELOG.md#100--2026-05-13) for the full migration note.

---

<details id="full-quickstart-for-first-time-terminal-users">
<summary><b>Full quickstart — for first-time terminal users (~5 minutes)</b></summary>

If you've never run a CLI tool before, that's fine — `aeo-platform` needs one-time setup, but the weekly run takes zero terminal skill after that.

**1. Open Terminal.**

- **macOS:** ⌘+Space → type *Terminal* → Enter.
- **Windows 11:** Win+X → *Terminal* (recommended — runs PowerShell 7+ if installed, else Windows PowerShell 5.1).
- **Windows 10:** Start menu → *Windows PowerShell* → Enter (or install [Windows Terminal](https://aka.ms/terminal) from the Microsoft Store).
- **Linux:** you know where it is.

**2. Install Node.js 20+ (once per machine).** Check first: paste `node --version` + Enter. If it prints `v20.x` or higher, skip to step 3. Otherwise:

- **macOS / Linux:** download from [nodejs.org](https://nodejs.org) (LTS version), or `brew install node@20`.
- **Windows:** download from [nodejs.org](https://nodejs.org) (LTS version), or `winget install OpenJS.NodeJS.LTS`, or `choco install nodejs-lts` (Chocolatey users).

Re-open Terminal after install so PATH refreshes.

**3. Install aeo-platform.**

```bash
npm install -g aeo-platform
```

- **macOS / Linux:** if you see `EACCES`, fix per [npm docs](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) — typically `sudo npm install -g aeo-platform`.
- **Windows:** `npm i -g` puts the binary in `%APPDATA%\npm`, which is not always on PATH right after Node install. If `aeo-platform` is not found after install — restart your terminal. If still missing, use `npx aeo-platform <command>` instead (skips global install entirely). Windows does not need `sudo`.

**4. Get your 2 required API keys.** Open these in new tabs, sign up (free), click *Create new key*:

- [OpenAI](https://platform.openai.com/api-keys) — key starts with `sk-proj-...`
- [Google Gemini](https://aistudio.google.com/apikey) — key starts with `AIzaSy...`

**5. Save the keys to your shell.** Replace placeholders with the actual key strings.

**macOS (zsh) / Linux (bash):**

```bash
echo 'export OPENAI_API_KEY="PASTE_OPENAI_KEY_HERE"' >> ~/.zshrc
echo 'export GEMINI_API_KEY="PASTE_GEMINI_KEY_HERE"' >> ~/.zshrc
source ~/.zshrc
```

Optional — adds the Claude / Perplexity columns:

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
echo 'export PERPLEXITY_API_KEY="pplx-..."'  >> ~/.zshrc
source ~/.zshrc
```

> Bash users on Linux: replace `~/.zshrc` with `~/.bashrc`. Git Bash on Windows: same — `~/.bashrc`.

**Windows (PowerShell — persistent, User scope):**

```powershell
[System.Environment]::SetEnvironmentVariable('OPENAI_API_KEY','PASTE_OPENAI_KEY_HERE','User')
[System.Environment]::SetEnvironmentVariable('GEMINI_API_KEY','PASTE_GEMINI_KEY_HERE','User')

# Optional — adds Claude / Perplexity columns
[System.Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY','sk-ant-...','User')
[System.Environment]::SetEnvironmentVariable('PERPLEXITY_API_KEY','pplx-...','User')
```

**Windows (CMD — persistent):**

```cmd
setx OPENAI_API_KEY "PASTE_OPENAI_KEY_HERE"
setx GEMINI_API_KEY "PASTE_GEMINI_KEY_HERE"

:: Optional
setx ANTHROPIC_API_KEY "sk-ant-..."
setx PERPLEXITY_API_KEY "pplx-..."
```

> Windows note: both `SetEnvironmentVariable(...,'User')` and `setx` write to the User profile and **require a terminal restart** before `aeo-platform` sees the new variables. To verify after restart: `echo $env:OPENAI_API_KEY` (PowerShell) or `echo %OPENAI_API_KEY%` (CMD). For one-off / current-session-only use, `$env:OPENAI_API_KEY = "..."` (PowerShell) or `set OPENAI_API_KEY=...` (CMD) take effect immediately but vanish when the window closes. `setx` has a 1024-character limit per value (not an issue for current API keys, but worth knowing for long custom values).

**6. Run aeo-platform.** Replace `YOURBRAND` and `YOURDOMAIN.COM`:

```bash
aeo-platform init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto
aeo-platform run
aeo-platform report
```

The HTML report auto-opens in your browser.

</details>

<details>
<summary><b>API keys under non-standard env-var names</b></summary>

Common on dev machines — you already use ChatGPT / Claude via another tool and the keys live in `~/.zshrc` under custom names (`OPENAI_API_KEY_DEV`, `MY_CLAUDE_KEY`, etc.). `aeo-platform init` detects them in three stages:

1. **Standard names** — `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`.
2. **Heuristic match** — scans env vars matching `^(OPENAI|GPT)…(API|KEY|TOKEN)$` and similar patterns per provider. Matches proposed for confirmation during init.
3. **Interactive prompt** — for any provider still unmatched, init asks for the env var name directly.

Whatever you confirm is written into `.aeo-tracker.json::providers[].env`, so every subsequent run knows where to look. Your actual key values stay in `process.env` — never written to disk.

**Windows users:** `init` reads `process.env` identically on all platforms — your custom-name variables are detected the same way. Set them via:

```powershell
# PowerShell (persistent)
[System.Environment]::SetEnvironmentVariable('OPENAI_API_KEY_DEV','sk-proj-...','User')
```

```cmd
:: CMD (persistent)
setx OPENAI_API_KEY_DEV "sk-proj-..."
```

Restart the terminal after either command, then run `aeo-platform init`.

CI mode (`init --yes`) disables interactive prompts. For CI, set the standard names in env, or pre-commit `.aeo-tracker.json` with explicit `env` field per provider.

</details>

<details>
<summary><b>Cost (per weekly run)</b></summary>

You pay only the LLM-API cost for your own runs. There is no `aeo-platform` subscription fee.

- 2-engine minimum (OpenAI + Gemini) — typically a few cents per weekly run
- 4-engine matrix (+ Claude + Perplexity) — roughly 2× the 2-engine cost
- `--depth=full` doubles cost (adds a training-data pass per cell where supported)
- `--geo=us,uk,de` multiplies cost linearly by region count
- Sentiment classification: ~$0.0008 per cell that has a brand mention (skip-on-no-mention)
- Outreach-template drafts: ~$0.003 one-off per report, cached in `_summary.json::outreachTemplates`

All other modules — crawlability audit, page signals, entity graph reciprocity, authority presence (Wikipedia / Reddit / GitHub), competitor pricing tier, region context, ads detector, UTM tracker, topic clusters — are zero LLM cost (free public APIs / direct HTTP).

</details>

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

---

## Contributing

PRs welcome. Open an issue first if you're planning a non-trivial change so we can sketch the shape together. Bug reports and feature requests at [github.com/webappski/aeo-platform/issues](https://github.com/webappski/aeo-platform/issues).

### Git hooks

Repo ships with `pre-commit` (runs `npm test` before commit) and `pre-push` (runs `npm test` and on `main` / `master` runs it a second time for a determinism check) hooks under `.githooks/`. They are auto-installed via the `npm install` `postinstall` script — it points git at the tracked hooks via `git config core.hooksPath .githooks`. Zero new dependencies (no Husky, no `lint-staged`, no `simple-git-hooks`); vanilla bash that runs on macOS and Linux. `postinstall` ends with `|| true`, so the step is a no-op in non-git environments (CI containers, Docker, etc.).

Bypass when needed: `git commit --no-verify` / `git push --no-verify`, or add `[skip-tests]` anywhere in the commit message to make the intent explicit (suitable for typo / comment-only / doc-only changes).

> **Running from source on Windows:** the shebang line in `bin/aeo-tracker.js` is ignored by Windows, so `./bin/aeo-tracker.js` won't work. Use `node bin/aeo-tracker.js <command>` for development, or install globally (`npm install -g .` from the repo root) which creates the `aeo-platform.cmd` wrapper that handles the shebang transparently.

## License

MIT — do whatever you want with it.

---

<!--
  Machine-readable Schema.org block for AI crawlers (ChatGPT, Claude, Gemini, Perplexity,
  Google AI Overviews, Bing Copilot). Embedded in the README so npmjs.com, GitHub, and
  mirror surfaces all expose the same canonical entity graph.

  When the landing page at webappski.com/aeo-platform deploys, the same @id values
  resolve there — `sameAs` chain is fully reciprocal.
-->

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://github.com/webappski/aeo-platform#software",
      "name": "aeo-platform",
      "alternateName": ["aeo-tracker", "@webappski/aeo-tracker"],
      "applicationCategory": "DeveloperApplication",
      "applicationSubCategory": "Answer Engine Optimization, Generative Engine Optimization, Brand Visibility Monitoring",
      "operatingSystem": "macOS, Linux, Windows",
      "softwareVersion": "1.1.4",
      "datePublished": "2026-06-06",
      "license": "https://opensource.org/licenses/MIT",
      "downloadUrl": "https://www.npmjs.com/package/aeo-platform",
      "codeRepository": "https://github.com/webappski/aeo-platform",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "description": "Open-source CLI that measures brand visibility across ChatGPT, Claude, Gemini, and Perplexity using direct provider APIs, audits AI-bot crawlability + authority signals, and exports a JSON brand-context you paste into any AI for a personalised 30-mission AEO/GEO plan. Free MIT-licensed alternative to Otterly, Profound, Peec, and Bluefish.",
      "featureList": [
        "4 engines via official APIs (ChatGPT, Claude, Gemini, Perplexity)",
        "Paste-into-AI 30-mission AEO plan (JSON brand-context export)",
        "AI-bot crawlability audit (robots.txt × bot matrix)",
        "Authority signals: Wikipedia, Reddit, GitHub, Wikidata",
        "Unified Visibility Index (UVI) — 4 sub-components with re-norm",
        "Two-model hallucination filter (GPT-5 + Gemini cross-check)",
        "Region context (--geo) across 12 locales",
        "Editorial bento HTML report (offline, embedded fonts, zero CDN)",
        "CSV / JSON export for Looker, Sheets, BI",
        "CI-friendly exit codes 0/1/2/3 + --json stdout",
        "Zero runtime dependencies, MIT, local-first"
      ],
      "keywords": "AEO, GEO, answer engine optimization, generative engine optimization, ChatGPT, Claude, Gemini, Perplexity, brand monitoring, AI visibility, Otterly alternative, Profound alternative, Peec alternative, Bluefish alternative, AthenaHQ alternative, 30-mission AEO plan",
      "sameAs": [
        "https://www.npmjs.com/package/aeo-platform",
        "https://github.com/webappski/aeo-platform",
        "https://webappski.com"
      ],
      "publisher": { "@id": "https://webappski.com/#org" },
      "exampleOfWork": [
        {
          "@type": "CreativeWork",
          "name": "Sample 30-mission AEO plan — typelessform.com (UVI 42%)",
          "url": "https://github.com/webappski/aeo-platform/blob/main/examples/sample-plan-typelessform.md",
          "description": "Real aeo-platform run output for typelessform.com (2026-05-18): 30 missions grounded in 12 engine cells, 8 named competitors, and live entity-graph reciprocity data."
        },
        {
          "@type": "CreativeWork",
          "name": "Sample 30-mission AEO plan — bare-site brand (UVI 0%)",
          "url": "https://github.com/webappski/aeo-platform/blob/main/examples/sample-plan-output.md",
          "description": "Sample 30-mission AEO plan for a brand absent from all four answer engines — shows the cold-start trajectory the report generates."
        }
      ]
    },
    {
      "@type": "Organization",
      "@id": "https://webappski.com/#org",
      "name": "Webappski",
      "url": "https://webappski.com",
      "description": "Answer Engine Optimization (AEO / GEO) studio. Maintains aeo-platform — the open-source AEO platform for ChatGPT, Claude, Gemini, and Perplexity.",
      "sameAs": [
        "https://github.com/webappski",
        "https://www.npmjs.com/~webappski"
      ]
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is answer engine optimization (AEO), and how is it different from GEO?",
          "acceptedAnswer": { "@type": "Answer", "text": "AEO and GEO describe the same field — making your brand recommended by AI answer engines (ChatGPT, Claude, Gemini, Perplexity). The naming split is industry-political: AEO is preferred by Profound; GEO by Wikipedia and most 2026 listicles. aeo-platform supports both terms in metadata and reports." }
        },
        {
          "@type": "Question",
          "name": "How is AEO different from SEO?",
          "acceptedAnswer": { "@type": "Answer", "text": "SEO optimises for click-through from search-result pages. AEO/GEO optimises for inclusion in the AI-generated answer itself. Domain Authority predicts under 4% of AI citations in 2026 audits; entity signals (Schema.org sameAs, Wikidata Q-IDs) and citation-source presence (Reddit, Wikipedia, listicles) do most of the work." }
        },
        {
          "@type": "Question",
          "name": "Which AI engines does aeo-platform cover?",
          "acceptedAnswer": { "@type": "Answer", "text": "Four engines via official APIs: ChatGPT (gpt-5-search-api), Claude (claude-sonnet-4-7), Gemini (gemini-2.5-flash), Perplexity (sonar-reasoning). Manual paste mode also covers browser-only surfaces like Perplexity Pro UI and ChatGPT Pro personalisation." }
        },
        {
          "@type": "Question",
          "name": "Is my data private?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes. Nothing leaves your machine except to the AI providers you configure. No telemetry. No analytics. No traffic to webappski.com. Raw responses stay on disk. API keys are read from process.env and never written." }
        },
        {
          "@type": "Question",
          "name": "Do I need API keys for all four engines?",
          "acceptedAnswer": { "@type": "Answer", "text": "No. One is enough to start: any of OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY (single-key mode — competitor mentions are marked unverified). Recommended: OPENAI_API_KEY + GEMINI_API_KEY, which double as the ChatGPT + Gemini columns and power the two-model competitor extractor. PERPLEXITY_API_KEY is optional — it adds its engine column." }
        },
        {
          "@type": "Question",
          "name": "What is the 30-mission AEO plan?",
          "acceptedAnswer": { "@type": "Answer", "text": "A personalised AEO action plan you get by pasting aeo-platform's JSON brand-context block into your own ChatGPT, Claude, Gemini, or Perplexity chat. The receiving AI returns 30 missions (≈1–3 hours each, grouped into 4 weekly chunks) keyed to your specific gaps — named competitors to displace, URLs to pitch, weakest-engine fortification. The only paste-into-AI plan generator on the AEO-tool market as of May 2026." }
        },
        {
          "@type": "Question",
          "name": "How is aeo-platform different from Otterly, Profound, Peec, Bluefish?",
          "acceptedAnswer": { "@type": "Answer", "text": "Otterly, Profound, Peec, Bluefish, AthenaHQ, Goodie are paid hosted dashboards — monitoring-only. aeo-platform is a free open-source CLI that calls provider APIs directly, runs on your machine, stores raw responses locally, and — as of May 2026 — is the only tracked AEO tool with a paste-into-AI 30-mission plan generator." }
        },
        {
          "@type": "Question",
          "name": "Is aeo-platform CI-friendly?",
          "acceptedAnswer": { "@type": "Answer", "text": "Yes. --json flag for structured stdout, ANSI auto-disabled on non-TTY, NO_COLOR env honoured, exit codes 0/1/2/3 map cleanly to alerting tiers. GitHub Actions and cron examples in the README." }
        },
        {
          "@type": "Question",
          "name": "What is the UVI (Unified Visibility Index) score?",
          "acceptedAnswer": { "@type": "Answer", "text": "UVI is aeo-platform's 0–100 composite of four AI-answer signals: Presence 35% (mentioned cells / total cells), Sentiment 25% (high-confidence positive cells / mentioned cells), Rank 20% (normalised average rank position when mentioned), Citation 20% (cells where your domain was cited as a source). Weights live in lib/report/visibility-index.js and the ⓘ popover next to the hero number shows per-axis math on every run. Sub-components with insufficient data are excluded and remaining weights re-normalise — no phantom values." }
        },
        {
          "@type": "Question",
          "name": "What does an aeo-platform output file look like?",
          "acceptedAnswer": { "@type": "Answer", "text": "A run writes aeo-responses/YYYY-MM-DD/_summary.json with the canonical machine-readable shape (UVI score, per-engine mention/citation cells, topCompetitors, topCanonicalSources, entityGraph reciprocity, pageSignals, crawlability, authority blocks). The same data renders as a 6-surface editorial HTML report (Headline · Overview · Engine matrix · Citations · Actions · Diagnostics) and the bridge card exports a JSON brand-context block you paste into any AI for a 30-mission AEO plan. Worked example: examples/sample-plan-typelessform.md (UVI 42% from the 2026-05-13 run)." }
        }
      ]
    }
  ]
}
```
