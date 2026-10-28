# Contributing & git hooks

PRs welcome. Open an issue first if you're planning a non-trivial change so we can sketch the shape together. Bug reports and feature requests at [github.com/webappski/aeo-platform/issues](https://github.com/webappski/aeo-platform/issues).

**Git hooks**

Repo ships with `pre-commit` (runs `npm test` before commit) and `pre-push` (runs `npm test` and on `main` / `master` runs it a second time for a determinism check) hooks under `.githooks/`. They are auto-installed via the `npm install` `postinstall` script — it points git at the tracked hooks via `git config core.hooksPath .githooks`. Zero new dependencies (no Husky, no `lint-staged`, no `simple-git-hooks`); vanilla bash that runs on macOS and Linux. `postinstall` ends with `|| true`, so the step is a no-op in non-git environments (CI containers, Docker, etc.).

Tests always run — there is no bypass. Neither hook has a skip switch or a commit-message token (founder decision, 2026-06-06: tests are never skipped, for any kind of change, docs and comments included). The old `[skip-tests]` token was removed from `.githooks/pre-commit` (see `CHANGELOG.md`), and the hook messages no longer suggest `--no-verify`; do not use it. A commit takes minutes because it runs the whole `npm test`.

> **Running from source on Windows:** the shebang line in `bin/aeo-tracker.js` is ignored by Windows, so `./bin/aeo-tracker.js` won't work. Use `node bin/aeo-tracker.js <command>` for development, or install globally (`npm install -g .` from the repo root) which creates the `aeo-platform.cmd` wrapper that handles the shebang transparently.
