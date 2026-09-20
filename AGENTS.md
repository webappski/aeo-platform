# AGENTS.md — working on `aeo-platform`

Instructions for coding agents. Humans want [README.md](README.md) (what the tool
does, how to use it) and [CODING_STANDARDS.md](CODING_STANDARDS.md) (style, in
full — this file does not repeat it).

Written against the [agents.md](https://agents.md) format: plain Markdown at the
repo root, nearest file wins in a nested checkout, and an explicit instruction
from the person you are working with outranks everything here.

## What this repository is

A zero-dependency Node CLI that measures how visible a brand is in AI answer
engines (ChatGPT, Gemini, Claude, Perplexity): it asks each engine a fixed
basket of buyer questions, records the raw answers, and renders a report —
markdown for the terminal, a single-file HTML page for a client.

Two properties decide almost every judgement call in this codebase:

1. **It spends real money.** A run makes paid API calls. Nothing you do while
   developing may make one (see *Never* below).
2. **It publishes numbers someone acts on.** A figure that is wrong, or right
   but missing the caveat that qualifies it, is the failure mode this repo has
   spent most of its history closing. When you cannot measure something, the
   correct output is a named gap — never a plausible number.

## Setup

```bash
node --version      # >= 20 required (package.json engines)
npm install         # installs devDependencies; runtime dependencies are empty and stay empty
```

`npm install` also points `core.hooksPath` at `.githooks` (postinstall). That is
how the pre-commit gate below gets installed — do not undo it.

There is **no build step**. `bin/aeo-tracker.js` is plain ESM and runs directly.

## Test and check commands

```bash
npm test                    # THE gate: syntax + imports + every unit suite + the E2E suite
npm run test:e2e            # node --test test/e2e/*.test.js
node --test test/<file>.test.js   # one file, while iterating
npm run                     # lists every test:<name> script (the suite index — do not keep a copy here)
```

`npm test` is a long `&&` chain of the individual `test:*` scripts. Two
consequences:

- **A new test file is not run until you add it.** Register `test:<name>` in
  `package.json` *and* insert `npm run test:<name> &&` into the `test` chain.
  A suite nobody runs is worse than no suite — it reads as coverage.
- **A new `lib/` module belongs in `test:imports`** too. That script imports
  every module and is what catches a typo in an import path before the CLI does.

`.githooks/pre-commit` runs `npm test` on every commit and **has no bypass**
(maintainer decision: tests are never skipped). So a commit is a full test run —
budget for it, and do not start one while another heavy job is using the machine.

There is no CI workflow in this repo. The pre-commit hook and `prepublishOnly`
(`npm test` + `test:pack-files` + `scripts/smoke-tarball.sh`) are the only gates.

## Never

- **Never `npm publish`, `npm version`, `git tag`, or `git push`.** Releases are
  the maintainer's, always. Bump `package.json` only when explicitly asked, and
  then run `node scripts/sync-readme-version.mjs` in the same commit (the
  README's Schema.org `softwareVersion` is pinned to `package.json` by a test).
- **Never make a paid API call to try something out.** Use `run --replay`
  (rebuilds a summary from cached raw responses, zero cost) or the offline E2E
  seam: `test/e2e/_helpers.js` stubs `/v1/models` and OpenAI's Responses endpoint
  and fails every other request closed at 401. If a change cannot be verified
  without spending, say so and stop — do not spend.
- **Never commit a key.** `.env` is gitignored; `.aeo-tracker.json` carries the
  *names* of env vars, never values. Raw answers land on disk under
  `aeo-responses/`, never in stdout.
- **Never add a runtime dependency.** `"dependencies"` is empty by design
  (install time, supply-chain surface, sandboxed CI). devDependencies are fine.
- **Never write a test that asserts on a behavioural mock.** Injecting a
  `providerCall` that returns a canned body is the house pattern and is fine —
  the real prompt, the real parser and the real merge still run. Stubbing the
  function under test, or asserting that a mock was called, proves nothing.

## Testing conventions

- **E2E first.** Reach for a unit test only when an E2E is genuinely
  disproportionate — a pure reducer with no UI, or an exit code's *decision* as
  opposed to the exit code itself. Say which in the test's header: every test
  file here opens with why it exists and why it is the shape it is.
- **Every behavioural test carries a mutation-sanity note** — what has to break
  for it to go red. A test that passes against an inverted implementation is a
  green light over nothing, and this repo has caught itself shipping them.
- **Fixtures must keep testing what they are named after.** Widening a fixture
  to dodge a newly-added guard is sometimes right and sometimes test-fitting;
  when you do it, say which and why, in the commit.
- No `.only`, no `.skip` committed.

## Report and measurement conventions

- **One definition per question, in one module.** `lib/score.js` owns "did this
  cell produce a measurement"; `lib/report/visibility-index.js` owns the
  composite index; `lib/basket-manifest.js` owns question identity. A second
  copy of any of these has drifted before and will again — delegate, never
  re-derive.
- **A caveat must reach both surfaces.** The markdown report and the HTML page
  are rendered by different code (`lib/report/sections.js` and
  `lib/report/html.js`). Copy that only one of them prints is the recurring bug
  class here — the HTML page is the one a client is shown. Build the sentence
  once (see `lib/report/instrument-caveat.js`,
  `lib/report/section-degradation.js`) and render it in both.
- **Never label a cause you did not observe.** Degradation markers read a typed
  error; an untyped failure renders as an unnamed failure rather than being
  guessed into a specific one.
- **Summary JSON stays lean.** A per-cell field that is absent by default costs
  nothing across a year of weekly snapshots; one written on every clean cell
  costs a lot. Omit rather than write an empty value.

## Repository map

| Path | What lives there |
|---|---|
| `bin/aeo-tracker.js` | The whole CLI: arg parsing, the run loop, both sinks. Large by acknowledged debt — new logic goes in `lib/`, not here. |
| `lib/report/` | Everything that turns records into a report: renderers, the comparison model, the LLM classifiers, the caveat builders. |
| `lib/providers/` | Per-engine call wrappers, model discovery, pricing, retry/rate-limit. |
| `lib/init/` | `init`: site fetch, query research, validation, key probing. |
| `test/`, `test/e2e/` | Unit suites and the offline end-to-end suite (`_helpers.js` is the seam). |
| `test/fixtures/` | Synthetic replay snapshots for the E2E suite, plus pins of real recorded answers and two trimmed real runs. `test/fixtures/README.md` says which is which; do not edit a real-run pin to make a test pass. |
| `scripts/` | Release and maintenance helpers (`sync-readme-version.mjs`, `pricing-check.mjs`, …). |

## Using the CLI

`aeo-platform --help` is the authority and is kept current — read it rather than
a list in this file. The shape of a session: `init` writes
`.aeo-tracker.json`; `run` asks the engines and writes
`aeo-responses/<domain>/<date>/_summary.json`; `report` renders
`aeo-reports/<domain>/<date>/report.{md,html}`; `diff A B` compares two dates.
`run --replay` re-runs everything after the network, from cache, for free — that
is the command to use while developing.

## Finishing a change

1. The change, and the test that would have caught the bug, in the same commit.
2. `npm test` green — the pre-commit hook will run it anyway; running it first
   means you read the failure instead of the hook.
3. A `CHANGELOG.md` entry when behaviour or output changed, naming what a reader
   of the output has to do differently.
4. Commit subject in the imperative, body explaining *why*, including anything
   you decided not to do and the reason. No AI/co-author attribution lines.
