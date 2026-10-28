# Commands reference

Part of [`aeo-platform`](https://github.com/webappski/aeo-platform#readme) — moved out of the README so the npm page can show the README whole.

## Flags reference — every flag, by command

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
| `--samples=<N>` | `run` | Query each cell N times instead of once, so a noisy LLM flip is not read as a real change. Presence then carries a 95% Wilson confidence interval and `diff` treats overlapping intervals as noise. Default `1` (single-shot); capped at 25; cost scales ~N×. See [How we count visibility](https://github.com/webappski/aeo-platform/blob/main/README.md#how-we-count-visibility) |
| `--replay` | `run` | Rebuild summary from cached raw responses (zero API cost, fully offline — skips live model discovery AND extractor/sentiment LLM calls; no API keys required) |
| `--replay-from=YYYY-MM-DD` | `run` | Replay a specific date instead of the most recent capture |
| `--from-dir <path>` | `run-manual` | Directory containing `q1.txt`, `q2.txt`, `q3.txt` with pasted UI answers |
| `--last <N>` / `--since <date>` | `diff` | Compare last N runs / compare a date to latest run |
| `--format=<csv\|json>` | `export` | Output format (CSV default) |
| `--refresh-cache <fields>` | `report` | Force-refresh cached fields before report. CSV list or `all` |
| `--no-html` | `report` | Markdown only — skip HTML write + browser auto-open |
| `--no-open` | `report` | Write files but don't auto-open the browser |
| `--offline` | `report` | Render from what is already on disk: makes no request at all and writes nothing (a normal `report` re-writes the run's `_summary.json` even when every value came from cache). Missing signals are marked as not fetched, never guessed |
| `--no-authority` / `--no-page-signals` / `--no-entity-graph` / `--no-pricing` | `report` | Skip individual fetch-heavy checks (behind a VPN, or to dodge rate limits). These four are not an offline mode — other fetchers have no flag here; use `--offline` for that |
| `--openai-model=<id>` / `--gemini-model=<id>` / `--anthropic-model=<id>` / `--perplexity-model=<id>` | `run` | Override the model for one run only (no config rewrite). E.g. switch from the default `gpt-6-luna` to another model available to your OpenAI project. A pin always wins. Without one, `run` takes the cheap tier of the newest model family (a generation that ships only a flagship or the balanced `terra` tier, such as `gpt-6.1-sol` + `gpt-6.1-terra`, is passed over for the next one down in the same family, `gpt-6-luna`; `terra`, about ten times the price of a `luna`, is taken only when no generation of the family has a `mini` / `luna` / `lite` / `nano` tier, and then the run says so). When no generation of the newest family ships a recognised cheap tier (a flagship-only family), `run` does not take it on its own: it uses the model of this project's last run, then the config model (each only if the key still lists it, and the config model only if it is not the flagship itself), and otherwise stops before any paid call and asks for this flag. The run log names the model that was actually sent and where it came from |
| `--openai-classify-model=<id>` | `run`, `run-manual` | Pin the OpenAI model for the cheap tier — competitor extraction, sentiment, query validation. Pin both commands of a series the same (`AEO_OPENAI_CLASSIFY_MODEL_PIN` is the same pin as an env var; other commands refuse the flag instead of ignoring it). Without it the run picks one live: a chat model one generation behind the search model, cheapest tier, the same pick on every request (text-to-speech, transcription, image and realtime ids are never candidates). Pin it to keep an earlier run's extractor. If the key lists no usable chat model for that tier, `run` stops before any paid call and asks for this flag |
| `--add-queries "q1,q2,q3"` | `init` | Add queries to an existing config without re-running brainstorm; preserves prior basket history |
| `--replace-queries "q1,q2,q3"` | `init` | Replace queries in an existing config (forks basket version); preserves prior versions in `basketHistory` |

## Exit codes & CI integration — cron, Task Scheduler, GitHub Actions

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

**CI integration**

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
      - run: npm install -g aeo-platform@1   # pin the major in CI — upgrade deliberately
      - run: aeo-platform run --json > latest.json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          NO_COLOR: '1'
      - uses: actions/upload-artifact@v4
        with: { name: aeo-latest, path: aeo-responses/ }
```

## Configuration — `.aeo-tracker.json` fields

`aeo-platform init` creates `.aeo-tracker.json` in the working directory. The file name is preserved across the rename so existing dotfiles keep working.

```json
{
  "brand": "YOURBRAND",
  "domain": "YOURDOMAIN.COM",
  "category": "Short description of your competitive space",
  "queries": [
    { "q": "best YOURCATEGORY services 2026",          "tag": "commercial" },
    { "q": "top YOURCATEGORY monitoring tools 2026",   "tag": "commercial" },
    { "q": "YOURCATEGORY consultants for B2B startups", "tag": "vertical" }
  ],
  "regressionThreshold": 10,
  "providers": {
    "openai":     { "model": "gpt-6-luna",          "classifyModel": "gpt-6-luna",         "env": "OPENAI_API_KEY" },
    "gemini":     { "model": "gemini-3.8-flash",    "classifyModel": "gemini-3.1-flash-lite", "env": "GEMINI_API_KEY" },
    "anthropic":  { "model": "claude-sonnet-5",     "classifyModel": "claude-haiku-4-5", "env": "ANTHROPIC_API_KEY" },
    "perplexity": { "model": "sonar-reasoning-pro", "classifyModel": "sonar",            "env": "PERPLEXITY_API_KEY" }
  }
}
```

Fields:

- `brand`, `domain`, `category` — what the tool measures
- `queries` — exactly 3, unbranded, commercial-intent. Methodological queries («how to X») are rejected by the validator
- `queries[].tag` — the intent class `init` already worked out for that question (`comparison`, `problem`, `commercial`, `informational`, `vertical`); the report uses it to show which KIND of question you lose. Edit or delete it by hand — a plain string instead of an object is still valid and simply carries no breakdown
- `regressionThreshold` — exit code `1` fires when score drops by more than this many percentage points week-over-week (default 10)
- `providers[].env` — name of the env var that holds the key (override for non-standard names like `OPENAI_API_KEY_DEV`)
- `providers[].model` — auto-discovered at run start (newest available); override here to pin a specific model
- `providers[].classifyModel` — cheaper model used for extraction, sentiment, validation, and other short classification calls

## Can I track multiple brands?

Yes. All new on-disk artifacts are namespaced by domain — `aeo-responses/<domain>/<date>/` and `aeo-reports/<domain>/<date>/` — so two different domains can safely share one working directory: re-run `init` for the next domain (it overwrites `.aeo-tracker.json`), then `run` / `report`. Each domain keeps its own runs, trend history, and reports; they never blend. Internationalized domains use their canonical Punycode hostname as `<domain>`, so distinct Unicode domains cannot collapse to the same directory. Pre-namespacing `aeo-responses/<date>/` history remains readable when its `_summary.json` records the active domain; cache updates and same-day continuations stay in that source directory, while fresh dates use the namespaced layout. `run`/`report`/`diff`/`export` operate on the domain in the current `.aeo-tracker.json` (or, if there's no config, the single unambiguous domain present on disk).

A separate working directory per brand still works and keeps each client's `.aeo-tracker.json` (queries, provider config, validation cache) fully isolated — that's the cleaner setup for many clients. A wrapper script that loops over client directories is ~10 lines of bash (macOS / Linux) or PowerShell (Windows).
