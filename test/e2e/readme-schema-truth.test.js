/**
 * E2E — the README carries no Schema.org entity block, and the maintainer's
 * release command does not depend on one.
 *
 * Why this file changed (1.17.1). Until 1.17.0 the README ended with a
 * ```json fence holding a Schema.org `@graph` ("the machine-readable entity we
 * publish to npmjs.com"). On npm and GitHub a fenced block is TEXT, not markup
 * — JSON-LD only works as a `<script>` tag, and npm strips those — so the block
 * told a crawler nothing, while it was the single largest thing in the file
 * (13 499 of 106 832 characters) and sat past the 65 536-character cut the
 * registry applies to the README field. It was removed.
 *
 * The block had a second life as a release trap. A pin on its `softwareVersion`
 * plus `.githooks/pre-commit` (full suite, no bypass) meant `npm version` bumped
 * package.json and then committed with a README one version behind; a lifecycle
 * script (`scripts/sync-readme-version.mjs`, wired as the npm `version` script)
 * healed that — and it exited 1 ("Refusing to edit") when the README did not
 * hold exactly one `"softwareVersion"`. Removing the block without removing the
 * script would have made the maintainer's `npm version` fail on release day.
 * So the script and its wiring went with the block, and this file now pins:
 *
 *   1. the README carries no Schema.org block (so nothing needs syncing);
 *   2. the release path itself — `npm version patch --no-git-tag-version` on a
 *      COPY of the package exits 0 and leaves README.md byte for byte alone;
 *   3. that the release-path check is not vacuous: put the old `version`
 *      lifecycle script back (a fixture with the 1.17.0 script's contract) and
 *      the same helper goes red, naming `softwareVersion`.
 *
 * SAFETY. The `npm version` runs below happen only in a fresh `mkdtemp` copy
 * outside this repository, and every run first asserts that its cwd is that
 * copy. Nothing here ever bumps the real package.json.
 *
 * MUTATION-SANITY: restore the `"version"` script in package.json, or put a
 * fenced Schema.org block back into README.md, and a test below goes red.
 */
import test from 'node:test';
import assert from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_helpers.js';

const README_PATH = join(REPO_ROOT, 'README.md');
const README = readFileSync(README_PATH, 'utf-8');
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));

test('the README carries no Schema.org entity block', () => {
  assert.ok(!/"@graph"/.test(README), 'README must not hold a Schema.org @graph (a fenced block is text on npm)');
  assert.ok(!/"softwareVersion"/.test(README), 'README must not hold a softwareVersion to keep in step with package.json');
  assert.ok(!/```json\n[^`]*"@context"/.test(README), 'README must not hold a fenced JSON-LD block');
});

test('package.json has no `version` lifecycle script and the sync script is gone', () => {
  assert.equal(
    PKG.scripts.version, undefined,
    '`scripts.version` runs on every `npm version` — with the README block gone there is nothing to sync, ' +
    'and a script that expects the block exits 1 and blocks the release',
  );
  assert.ok(
    !existsSync(join(REPO_ROOT, 'scripts', 'sync-readme-version.mjs')),
    'scripts/sync-readme-version.mjs must not come back without the block it syncs',
  );
});

/** A fresh package copy outside the repo: package.json, README.md, scripts/. */
function stagePackage({ versionScript, extraScripts = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aeo-e2e-release-path-')));
  const pkg = { ...PKG, scripts: { ...PKG.scripts } };
  if (versionScript) pkg.scripts.version = versionScript;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  cpSync(README_PATH, join(dir, 'README.md'));
  cpSync(join(REPO_ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  for (const [name, body] of Object.entries(extraScripts)) writeFileSync(join(dir, 'scripts', name), body);
  return dir;
}

/** Refuse to run anywhere that could be this repository. */
function assertScratch(dir) {
  const root = realpathSync(REPO_ROOT);
  assert.ok(
    dir !== root && !dir.startsWith(root + sep) && !root.startsWith(dir + sep),
    `release-path runs must happen in a temp copy, not in the repository (cwd ${dir})`,
  );
  assert.ok(dir.startsWith(realpathSync(tmpdir())), `cwd ${dir} is not under the temp directory`);
}

/**
 * `npm version patch --no-git-tag-version` in `dir`, lifecycle scripts forced
 * ON (an `ignore-scripts=true` in someone's npmrc would otherwise make the
 * check pass without ever running the `version` script). Inherited `npm_*`
 * variables are dropped so a nested npm does not think it is the outer one.
 */
function bumpPatch(dir) {
  assertScratch(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
  const execpath = process.env.npm_execpath;
  const viaNode = execpath && /\.c?js$/.test(execpath);
  return spawnSync(
    viaNode ? process.execPath : 'npm',
    [...(viaNode ? [execpath] : []), 'version', 'patch', '--no-git-tag-version', '--ignore-scripts=false'],
    { cwd: dir, env: { ...env, npm_config_ignore_scripts: 'false', npm_config_update_notifier: 'false' }, encoding: 'utf-8' },
  );
}

function nextPatch(version) {
  const [a, b, c] = version.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

/** The contract of the 1.17.0 `scripts/sync-readme-version.mjs`, reduced to the part that blocked a release. */
const OLD_SYNC_CONTRACT = `
import { readFileSync } from 'node:fs';
const text = readFileSync('README.md', 'utf-8');
const hits = text.match(/"softwareVersion":\\s*"[^"]*"/g) || [];
if (hits.length !== 1) {
  console.error('sync-readme-version: expected exactly 1 "softwareVersion" in README.md, found ' + hits.length + '. Refusing to edit');
  process.exit(1);
}
`;

test('npm version patch on a copy of the package exits 0 and leaves README.md alone', () => {
  const dir = stagePackage();
  try {
    const before = readFileSync(join(dir, 'README.md'));
    const r = bumpPatch(dir);
    assert.equal(r.status, 0, `the maintainer's \`npm version\` must succeed.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(
      Buffer.compare(before, readFileSync(join(dir, 'README.md'))), 0,
      'the version bump must not rewrite README.md — the version no longer lives there',
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).version, nextPatch(PKG.version),
      'package.json in the copy must carry the bumped version (the command did run)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutant: the 1.17.0 `version` lifecycle script back — the same helper goes red and names softwareVersion', () => {
  const dir = stagePackage({
    versionScript: 'node scripts/sync-readme-version.mjs && git add README.md',
    extraScripts: { 'sync-readme-version.mjs': OLD_SYNC_CONTRACT },
  });
  try {
    const r = bumpPatch(dir);
    assert.notEqual(r.status, 0, 'with the old script wired in and no Schema.org block the release must fail — if it passes, the check never ran the lifecycle script');
    assert.match(
      `${r.stdout}\n${r.stderr}`, /softwareVersion/,
      `it must fail for the right reason (the missing softwareVersion), not on an unrelated error:\n${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
