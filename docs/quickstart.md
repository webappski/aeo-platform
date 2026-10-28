# Quickstart and setup notes

Part of [`aeo-platform`](https://github.com/webappski/aeo-platform#readme) — moved out of the README so the npm page can show the README whole.

## Full quickstart — for first-time terminal users (~5 minutes)

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

## What the three commands do — in plain English

The three commands (`init`, `run`, `report`), in plain English — no AEO background needed. Read this once and you
know everything the tool does for you.

- **`init`** (run once) — reads your site, detects your API keys, and **auto-picks 3 tracking
  queries**: *unbranded, buyer-intent* phrases, the way a real customer searches when
  comparing vendors — e.g. *"best voice form filler software"*, *"top X tools for Y"* — not
  your brand name and not "what is X" questions. Everything lands in `.aeo-tracker.json`.
- **`run`** (run weekly) — sends each query to every engine you have a key for and records, per
  answer: were you mentioned, roughly where, who was mentioned instead, and which sources
  got cited. Raw answers + a summary go under `aeo-responses/`.
- **`report`** — turns the latest run into a self-contained `report.html` (auto-opens in
  your browser) plus `report.md`: visibility score, per-engine breakdown, top competitors,
  cited sources, and 3–5 prioritized fixes. Compare weeks with `aeo-platform diff`.

## Windows: the `npx` one-liners (PowerShell and CMD)

**Windows (PowerShell)**

```powershell
npx aeo-platform@latest init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto
if ($LASTEXITCODE -eq 0) { npx aeo-platform@latest run }
if ($LASTEXITCODE -eq 0) { npx aeo-platform@latest report }
```

**Windows (CMD)**

```cmd
set OPENAI_API_KEY=sk-proj-...
set GEMINI_API_KEY=AIzaSy...

npx aeo-platform@latest init --yes --brand=YOURBRAND --domain=YOURDOMAIN.COM --auto && npx aeo-platform@latest run && npx aeo-platform@latest report
```

> Note: `&&` chain works in CMD and PowerShell 7+, but **not in PowerShell 5.1** (the default Windows 10/11 shell — check via `$PSVersionTable.PSVersion`). For persistent env vars across sessions on Windows, see the [Full quickstart](#full-quickstart--for-first-time-terminal-users-5-minutes) above. Git Bash and WSL users — the bash block above works as-is.

## Optional engines — Claude and Perplexity keys

The recommended pair (OpenAI + Gemini) covers the ChatGPT and Gemini columns with cross-model verification. Minimum to start: any ONE research-capable key (OpenAI, Gemini, or Anthropic) — single-key mode runs the same pipeline on one model and marks competitor mentions as unverified. Two more keys are optional and each adds an engine column to the report:

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

**Never used a CLI before?** A founder-friendly walk-through (5 minutes, no terminal background required) is in the [full quickstart](#full-quickstart--for-first-time-terminal-users-5-minutes) above.

## Does `aeo-platform` work on Windows?

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

## API keys under non-standard env-var names

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

## Cost (per weekly run)

You pay only the LLM-API cost for your own runs. There is no `aeo-platform` subscription fee.

- 2-engine minimum (OpenAI + Gemini) — ≈$0.21 per run (3 questions × OpenAI + Gemini; recalculated on 24 October 2026 from the token counts of the 19 June 2026 run at current prices)
- 4-engine matrix (+ Claude + Perplexity) — roughly 2× the 2-engine cost
- `--depth=full` doubles cost (adds a training-data pass per cell where supported)
- `--geo=us,uk,de` multiplies cost linearly by region count
- Sentiment classification: ~$0.0008 per cell that has a brand mention (skip-on-no-mention)
- Outreach-template drafts: ~$0.003 one-off per report, cached in `_summary.json::outreachTemplates`

All other modules — crawlability audit, page signals, entity graph reciprocity, authority presence (Wikipedia / Reddit / GitHub), competitor pricing tier, region context, ads detector, UTM tracker, topic clusters — are zero LLM cost (free public APIs / direct HTTP).
