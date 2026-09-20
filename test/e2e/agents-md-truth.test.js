/**
 * E2E — AGENTS.md must stay TRUE, not merely present.
 *
 * WHY THIS FILE EXISTS
 * AGENTS.md is read by machines that then act on it: they will run the command
 * it names, trust the gate it describes, and open the file it links to. A
 * stale instruction file is worse than none — a missing AGENTS.md makes an
 * agent look around, a wrong one makes it confidently do the wrong thing. It
 * also ages in exactly the way a docs file does: someone renames a script and
 * nobody re-reads the markdown.
 *
 * So the load-bearing claims are pinned against the repo itself:
 *   - every `npm run <script>` / `npm test` it names exists in package.json,
 *   - every repo-relative link it makes resolves to a file on disk,
 *   - every path in its repository map exists,
 *   - the claims about the gate (pre-commit runs the suite, no bypass) and
 *     about zero runtime dependencies still describe reality.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0): the subject is the consistency of one
 * FILE with the rest of the working tree — there is no pure function here to
 * unit-test, and the only honest way to check it is to read both.
 *
 * Deliberately NOT asserted: prose, section order, or headings. The agents.md
 * format mandates no structure ("use any headings you like"), and a test that
 * pinned the wording would fail on every honest edit.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './_helpers.js';

const AGENTS_PATH = join(REPO_ROOT, 'AGENTS.md');
const doc = readFileSync(AGENTS_PATH, 'utf-8');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));

test('AGENTS.md sits at the repository root, where the format requires it', () => {
  // Nested AGENTS.md files are allowed by the spec (closest wins); the ROOT one
  // is the entry point and is what a fresh agent reads first.
  assert.ok(existsSync(AGENTS_PATH), 'AGENTS.md must exist at the repo root');
  assert.ok(doc.length > 500, 'a stub AGENTS.md is a promise the repo does not keep');
});

test('every npm script AGENTS.md names actually exists', () => {
  // Scanned over the WHOLE document, fenced blocks included — an agent copies a
  // command out of a code block at least as often as out of inline backticks.
  const named = [...doc.matchAll(/npm run ([a-z0-9:<>-]+)/g)].map((m) => m[1]);
  // Placeholders (`npm run test:<name>`) and the bare `npm run` listing idiom
  // are prose about scripts, not scripts.
  const scripts = named.filter((s) => /^[a-z][a-z0-9-]*(:[a-z0-9-]+)*$/.test(s));
  assert.ok(scripts.length > 0, 'the file should name at least one runnable command');
  for (const s of scripts) {
    assert.ok(pkg.scripts[s], `AGENTS.md tells an agent to run \`npm run ${s}\`, which package.json does not define`);
  }
  assert.ok(pkg.scripts.test, 'AGENTS.md calls `npm test` THE gate — it must exist');
});

test('every repo-relative link in AGENTS.md resolves', () => {
  const links = [...doc.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^https?:/.test(href) && !href.startsWith('#'));
  assert.ok(links.length > 0, 'the file should point a reader at the human docs');
  for (const href of links) {
    assert.ok(existsSync(join(REPO_ROOT, href)), `AGENTS.md links to ${href}, which does not exist`);
  }
});

test('every path in the repository map exists', () => {
  // Table cells of the form `path/` or `path/file.js` in the first column.
  const paths = [...doc.matchAll(/^\| `([^`]+)`(?:, `([^`]+)`)? \|/gm)]
    .flatMap((m) => [m[1], m[2]])
    .filter(Boolean)
    .filter((p) => p.includes('/'));
  assert.ok(paths.length >= 5, `expected the repository map to be parsed; found ${paths.length} paths`);
  for (const p of paths) {
    assert.ok(existsSync(join(REPO_ROOT, p)), `AGENTS.md maps ${p}, which does not exist`);
  }
});

test('the claims about the commit gate are still true', () => {
  const hook = join(REPO_ROOT, '.githooks', 'pre-commit');
  assert.ok(existsSync(hook), 'AGENTS.md promises a pre-commit hook at .githooks/pre-commit');
  const body = readFileSync(hook, 'utf-8');
  assert.match(body, /npm test/, 'AGENTS.md says the hook runs the full suite');
  assert.match(String(pkg.scripts.postinstall || ''), /core\.hooksPath/,
    'AGENTS.md says npm install installs the hook — that wiring is the postinstall script');
  assert.match(String(pkg.scripts.prepublishOnly || ''), /npm test/,
    'AGENTS.md names prepublishOnly as the other gate');
});

test('the zero-runtime-dependency claim is still true', () => {
  // Stated in AGENTS.md as a hard "never". If a dependency ever lands, the
  // instruction has to change in the same commit — that is what this pins.
  assert.deepStrictEqual(pkg.dependencies || {}, {},
    'AGENTS.md forbids runtime dependencies; package.json now has some');
  assert.match(String(pkg.engines?.node || ''), /20/,
    'AGENTS.md tells an agent Node >= 20 — keep the two in step');
});
