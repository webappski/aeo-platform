/**
 * Guard — the fabricated Anthropic model id must never reappear in the repo.
 *
 * Background: an earlier release shipped a non-existent Anthropic model id as
 * the documented + fallback Claude model across lib/, README, the FAQPage
 * schema, and the test fixtures. The real id is `claude-sonnet-4-6`. This
 * guard greps every tracked text file (contents) AND every tracked path
 * (filenames) and FAILS if the fabricated token appears ANYWHERE — so the
 * string cannot silently creep back in via a copy-paste, a regenerated
 * fixture, or a doc edit.
 *
 * Self-reference safety: the forbidden token is assembled at runtime from
 * fragments so the literal string never appears in THIS file. If it appeared
 * verbatim here, the guard would find itself and be permanently RED. Keep it
 * fragmented — do not inline the literal.
 *
 * Scope: tracked files only (`git ls-files`), so the binary `.tgz` package
 * snapshot and any untracked scratch files are out of scope by construction.
 * Contents are scanned with `git grep -I` (skips binary blobs).
 *
 * Mutation-sanity: re-inject the token into any tracked file (e.g. add it to
 * lib/config.js) and this test goes RED; remove it and it goes GREEN.
 */
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './_helpers.js';

// Assemble the forbidden token from fragments so the literal never appears in
// this source file (self-reference trap — see header).
const FORBIDDEN = ['claude', 'sonnet', '4', '7'].join('-');

/** Run a git subcommand at the repo root, return trimmed stdout (or '' on a
 *  clean non-match exit). git grep exits 1 when there are no matches — that is
 *  the GREEN path, not an error, so we swallow status-1 and rethrow anything
 *  else (a real git failure). */
function git(args, { allowNoMatch = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  } catch (err) {
    if (allowNoMatch && err.status === 1) return '';
    throw err;
  }
}

test('no tracked file CONTENT contains the fabricated model id', () => {
  // -I skips binary files; restrict to tracked files via `git grep` (no path
  // arg = whole tree at HEAD's working state). Exit 1 = no matches = pass.
  const hits = git(['grep', '-In', FORBIDDEN], { allowNoMatch: true });
  assert.equal(
    hits, '',
    `Fabricated model id "${FORBIDDEN}" found in tracked file contents — ` +
    `replace with claude-sonnet-4-6:\n${hits}`,
  );
});

test('no tracked file PATH contains the fabricated model id', () => {
  const paths = git(['ls-files'])
    .split('\n')
    .filter(p => p.includes(FORBIDDEN));
  assert.deepEqual(
    paths, [],
    `Fabricated model id "${FORBIDDEN}" found in tracked filenames — ` +
    `rename to claude-sonnet-4-6:\n${paths.join('\n')}`,
  );
});
