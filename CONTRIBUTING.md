# Contributing & git hooks

PRs welcome. Open an issue first if you're planning a non-trivial change so we can sketch the shape together. Bug reports and feature requests at [github.com/webappski/aeo-platform/issues](https://github.com/webappski/aeo-platform/issues).

**Git hooks**

Repo ships with `pre-commit` (runs `npm test` before commit) and `pre-push` (runs `npm test` and on `main` / `master` runs it a second time for a determinism check) hooks under `.githooks/`. They are auto-installed via the `npm install` `postinstall` script — it points git at the tracked hooks via `git config core.hooksPath .githooks`. Zero new dependencies (no Husky, no `lint-staged`, no `simple-git-hooks`); vanilla bash that runs on macOS and Linux. `postinstall` ends with `|| true`, so the step is a no-op in non-git environments (CI containers, Docker, etc.).

Bypass when needed: `git commit --no-verify` / `git push --no-verify`, or add `[skip-tests]` anywhere in the commit message to make the intent explicit (suitable for typo / comment-only / doc-only changes).

> **Running from source on Windows:** the shebang line in `bin/aeo-tracker.js` is ignored by Windows, so `./bin/aeo-tracker.js` won't work. Use `node bin/aeo-tracker.js <command>` for development, or install globally (`npm install -g .` from the repo root) which creates the `aeo-platform.cmd` wrapper that handles the shebang transparently.
