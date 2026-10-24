/**
 * E2E — the "no client names in the npm package" guard must never say "clean"
 * when it did not really check.
 *
 * WHY THIS FILE EXISTS
 * `test/no-client-names.test.js` needs the CRM folder (outside this repo), so it
 * cannot run in `npm test` on a clean checkout. Its mechanics, though, can: this
 * file runs the REAL guard, as a child process, against a small fixture package
 * and a SYNTHETIC denylist (random `zq…` tokens — no real name appears here),
 * with a real `npm pack --dry-run`. Every way the guard could quietly pass —
 * a missing or half-read list, a broken matcher, an empty file set, a skipped
 * file, a changed binary — has a case that must come out red. Without this the
 * guard is exercised only at release time, i.e. after the damage is done.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0): the subject is a process that reads a
 * directory, runs `npm pack` and exits 0/1. There is no function to unit-test
 * in isolation, and mocking `npm pack` would test the mock.
 *
 * ENVIRONMENT: every child gets an explicit environment (envFor), never
 * `...process.env`. This file first poisons its OWN AEO_CLIENT_DENYLIST with a
 * path that does not exist: a child that inherited the variable would report
 * "does not exist" instead of "is not set" and cases a/b would go red. That is
 * the configuration of a real release (`AEO_CLIENT_DENYLIST=… npm publish`
 * runs this suite with the variable exported).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, rmSync,
  symlinkSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT } from './_helpers.js';

const POISON = join(tmpdir(), `zq-no-such-denylist-${randomBytes(4).toString('hex')}`);
process.env.AEO_CLIENT_DENYLIST = POISON;

const GUARD_REL = 'test/no-client-names.test.js';
const LIST_FILE = 'public-package-denylist.txt';
const STACK = /^\s+at .+:\d+:\d+\)?$/m;

const tmpDirs = [];
const mk = (prefix) => { const d = mkdtempSync(join(tmpdir(), `${prefix}-`)); tmpDirs.push(d); return d; };
const tok = () => `zq${randomBytes(4).toString('hex')}`;

function envFor({ list, skip, path } = {}) {
  const env = {};
  for (const k of ['HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  env.PATH = path !== undefined ? path : process.env.PATH;
  if (list) env.AEO_CLIENT_DENYLIST = list;
  if (skip) env.AEO_SKIP_CLIENT_NAME_GUARD = '1';
  return env;
}

// A CRM-like directory: folders (one per client) + the list file (a filler line by default; `file: null` = no list file at all).
function makeList({ folders = [], file = [tok()], extra = {} } = {}) {
  const d = mk('zq-list');
  for (const f of folders) mkdirSync(join(d, f));
  if (file !== null) writeFileSync(join(d, LIST_FILE), Array.isArray(file) ? file.join('\n') + '\n' : file);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(d, name), body);
  return d;
}

function packPaths(cwd) {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  assert.strictEqual(r.status, 0, `npm pack --dry-run failed in ${cwd}: ${r.stderr}`);
  return JSON.parse(r.stdout)[0].files.map((f) => f.path);
}

const isBinaryPath = (p) => /\.(png|woff2)$/.test(p);
let BINARIES = [];   // repo-relative paths of the shipped binaries (from the repo's own `npm pack`)
let BASE;            // base fixture package, built once

// Relative imports of a module (and theirs, transitively) are copied next to the
// guard copy, so a guard that imports a sibling module still runs in the fixture.
function copyRelativeImports(fromRepoFile, intoRoot, seen = new Set()) {
  const abs = resolve(REPO_ROOT, fromRepoFile);
  if (seen.has(abs)) return;
  seen.add(abs);
  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(abs), m[1]);
    const rel = target.slice(REPO_ROOT.length + 1);
    mkdirSync(dirname(join(intoRoot, rel)), { recursive: true });
    copyFileSync(target, join(intoRoot, rel));
    copyRelativeImports(rel, intoRoot, seen);
  }
}

function buildBase() {
  const root = mk('zq-fixture');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'zq-fixture', version: '0.0.0', keywords: [], files: ['lib/', 'assets/', 'examples/', 'README.md', 'LICENSE'],
  }, null, 2) + '\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT\n');
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  mkdirSync(join(root, 'lib')); writeFileSync(join(root, 'lib/a.js'), 'export const a = 1;\n');
  mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'assets/x.html'), '<p>fixture</p>\n');
  mkdirSync(join(root, 'test'));
  copyFileSync(join(REPO_ROOT, GUARD_REL), join(root, GUARD_REL));
  copyRelativeImports(GUARD_REL, root);
  // The guard pins the shipped binaries by path and sha256: the fixture carries the same bytes.
  for (const b of BINARIES) {
    mkdirSync(dirname(join(root, b)), { recursive: true });
    copyFileSync(join(REPO_ROOT, b), join(root, b));
  }
  return root;
}

before(() => {
  BINARIES = packPaths(REPO_ROOT).filter(isBinaryPath);
  assert.ok(BINARIES.length > 0, 'the package ships binaries; the fixture needs their bytes');
  BASE = buildBase();
});
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function runGuard(root, env) {
  return spawnSync(process.execPath, [join(root, GUARD_REL)], { cwd: root, env, encoding: 'utf8' });
}
// Run the guard in a throw-away COPY of the base fixture after `mutate(root)`.
function runMutated(mutate, env) {
  const root = mk('zq-case');
  cpSync(BASE, root, { recursive: true });
  mutate(root);
  return runGuard(root, env);
}
function expectFail(r, reason, label) {
  assert.strictEqual(r.status, 1, `${label}: expected exit 1, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(reason.test(r.stderr), `${label}: stderr should match ${reason}\n${r.stderr}`);
  assert.ok(!STACK.test(r.stderr), `${label}: a refusal must not dump a stack trace\n${r.stderr}`);
}
function expectClean(r, label) {
  assert.strictEqual(r.status, 0, `${label}: expected exit 0, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /shippable file\(s\) checked against/, `${label}: a clean run prints the verdict line`);
}
const append = (root, rel, text) => writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8') + text);

// ── input contract ────────────────────────────────────────────────────────

test('a: the variable is not set → refuses, and says so (not "no such path")', () => {
  expectFail(runGuard(BASE, envFor()), /AEO_CLIENT_DENYLIST is not set/, 'a');
});

test('b: there is no skip switch — AEO_SKIP_CLIENT_NAME_GUARD=1 changes nothing', () => {
  expectFail(runGuard(BASE, envFor({ skip: true })), /AEO_CLIENT_DENYLIST is not set/, 'b');
});

test('c: an empty directory → refuses (nothing to check against)', () => {
  expectFail(runGuard(BASE, envFor({ list: makeList({ file: null }) })), /empty/, 'c');
});

test('d: folders but no list file → refuses and names the file', () => {
  expectFail(runGuard(BASE, envFor({ list: makeList({ folders: [tok()], file: null }) })), new RegExp(`${LIST_FILE} is missing`), 'd');
});

test('d2: folders but a list file with no names (comments and blank lines only) → refuses and names the file', () => {
  expectFail(runGuard(BASE, envFor({ list: makeList({ folders: [tok()], file: ['# header only', ''] }) })), new RegExp(`${LIST_FILE} has no names`), 'd2');
});

test('e: the variable points at a file → refuses', () => {
  const f = join(mk('zq-file'), 'list.txt'); writeFileSync(f, `${tok()}\n`);
  expectFail(runGuard(BASE, envFor({ list: f })), /must be a directory/, 'e');
});

test('f: the path does not exist → refuses, no stack', () => {
  expectFail(runGuard(BASE, envFor({ list: join(tmpdir(), `zq-nowhere-${tok()}`) })), /does not exist/, 'f');
});

test('f2: the list file is a directory (unreadable as a file) → refuses, no stack', () => {
  const d = makeList({ folders: [tok()], file: null }); mkdirSync(join(d, LIST_FILE));
  expectFail(runGuard(BASE, envFor({ list: d })), new RegExp(`${LIST_FILE} is not a regular file`), 'f2');
});

test('g: a list line that is not a plain name → refuses with its line number', () => {
  const t = tok();
  for (const bad of [`${t} # former`, `https://${t}.test`, `${t}/x`, `a@${t}`]) {
    expectFail(runGuard(BASE, envFor({ list: makeList({ folders: [tok()], file: [tok(), bad] }) })), new RegExp(`${LIST_FILE}:2 `), `g ${bad}`);
  }
});

test('g2: names with "&" or an apostrophe are accepted — and found', () => {
  const a = tok(); const b = tok(); const c = tok();
  const list = makeList({ folders: [tok()], file: [`${a} & ${b}`, `l'${c}`] });
  expectClean(runGuard(BASE, envFor({ list })), 'g2 clean');
  const r = runMutated((root) => append(root, 'lib/a.js', `// ${a} & ${b}\n// l'${c}\n`), envFor({ list }));
  expectFail(r, /lib\/a\.js:\d+/, 'g2 hit');
  assert.ok(r.stderr.includes(a) && r.stderr.includes(c), 'both accepted names are reported');
});

// ── the file set is `npm pack`, paths included ────────────────────────────

test('h1: a name in package.json (keywords) is found', () => {
  const t = tok(); const list = makeList({ folders: [t] });
  expectFail(runMutated((root) => {
    const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); p.keywords.push(t);
    writeFileSync(join(root, 'package.json'), JSON.stringify(p, null, 2) + '\n');
  }, envFor({ list })), /package\.json:\d+/, 'h1');
});

test('h2: a name in LICENSE is found', () => {
  const t = tok();
  expectFail(runMutated((root) => append(root, 'LICENSE', `(c) ${t}\n`), envFor({ list: makeList({ folders: [t] }) })), /LICENSE:\d+/, 'h2');
});

test('h3: a name in an .html file is found (no extension allow-list)', () => {
  const t = tok();
  expectFail(runMutated((root) => append(root, 'assets/x.html', `<p>${t}</p>\n`), envFor({ list: makeList({ folders: [t] }) })), /assets\/x\.html:\d+/, 'h3');
});

test('h4: a name only in a file PATH is found', () => {
  const t = tok();
  expectFail(runMutated((root) => writeFileSync(join(root, `lib/${t}-x.js`), 'export const b = 2;\n'), envFor({ list: makeList({ folders: [t] }) })), new RegExp(`lib/${t}-x\\.js \\(path\\)`), 'h4');
});

test('h5: the same name in a file that does not ship (test/) is NOT a failure', () => {
  const t = tok();
  const r = runMutated((root) => writeFileSync(join(root, 'test/x.js'), `// ${t}\n`), envFor({ list: makeList({ folders: [t] }) }));
  expectClean(r, 'h5');
});

test('h6: a folder token and a list-file token are both found', () => {
  const f = tok(); const l = tok();
  const r = runMutated((root) => { append(root, 'lib/a.js', `// ${f}\n`); append(root, 'assets/x.html', `${l}\n`); }, envFor({ list: makeList({ folders: [f], file: [l] }) }));
  expectFail(r, new RegExp(f), 'h6');
  assert.ok(r.stderr.includes(f) && r.stderr.includes(l), 'both are reported');
});

test('h7: a name split by a separator, or in capitals, is found (13 separators + upper case)', () => {
  const seps = ['-', '_', '.', '+', '&', "'", '’', '‑', ' ', '​', '­', '⁠', '%20'];
  const toks = [...seps.map(() => tok()), tok()];
  const lines = seps.map((s, i) => `// ${toks[i][0]}${s}${toks[i].slice(1)}`);
  lines.push(`// ${toks[seps.length].toUpperCase()}`);
  const r = runMutated((root) => append(root, 'lib/a.js', lines.join('\n') + '\n'), envFor({ list: makeList({ folders: toks }) }));
  expectFail(r, /lib\/a\.js:\d+/, 'h7');
  for (const t of toks) assert.ok(r.stderr.includes(t), `separator variant of ${t} was not found`);
});

test('h8: a list file with CRLF line ends and a BOM still loads its names', () => {
  const t = tok();
  const list = makeList({ folders: [tok()], file: `﻿${t}\r\n` });
  expectFail(runMutated((root) => append(root, 'lib/a.js', `// ${t}\n`), envFor({ list })), /lib\/a\.js:\d+/, 'h8');
});

test('h9: clients.json next to the folders is never read (personal data)', () => {
  const t = tok();
  const list = makeList({ folders: [tok()], extra: { 'clients.json': JSON.stringify({ clients: [{ slug: t, person: t, email: `${t}@example.test` }] }) } });
  expectClean(runMutated((root) => append(root, 'lib/a.js', `// ${t}\n`), envFor({ list })), 'h9');
});

// ── spelling and language ─────────────────────────────────────────────────

test('t1: a name with a diacritic is found when the text is in the other Unicode form (NFC vs NFD)', () => {
  const name = `zqółka${randomBytes(2).toString('hex')}`;
  assert.notStrictEqual(name, name.normalize('NFD'));
  const list = makeList({ folders: [tok()], file: [name.normalize('NFC')] });
  expectFail(runMutated((root) => append(root, 'lib/a.js', `// ${name.normalize('NFD')}\n`), envFor({ list })), /lib\/a\.js:\d+/, 't1');
});

test('t2: a two-word name is found joined by "+" and by "%20"', () => {
  const a = tok(); const b = tok();
  const list = makeList({ folders: [tok()], file: [`${a} ${b}`] });
  expectFail(runMutated((root) => append(root, 'lib/a.js', `// ?q=${a}+${b}\n`), envFor({ list })), /lib\/a\.js:\d+/, 't2 plus');
  expectFail(runMutated((root) => append(root, 'lib/a.js', `// ?q=${a}%20${b}\n`), envFor({ list })), /lib\/a\.js:\d+/, 't2 pct');
});

test('n1: a name of 5+ characters glued to a suffix ("Labs", "2") is found', () => {
  const a = tok(); const b = tok();
  const r = runMutated((root) => append(root, 'lib/a.js', `// ${a}Labs\n// ${b}2\n`), envFor({ list: makeList({ folders: [a, b] }) }));
  expectFail(r, /lib\/a\.js:\d+/, 'n1');
  assert.ok(r.stderr.includes(a) && r.stderr.includes(b), 'both glued forms are reported');
});

test('n2: a 4-character name inside a longer word is NOT a hit (only whole-word, no false alarm)', () => {
  const short = `zq${randomBytes(1).toString('hex')}`;
  expectClean(runMutated((root) => append(root, 'lib/a.js', `// a${short}bcd\n`), envFor({ list: makeList({ folders: [short] }) })), 'n2');
});

test('o: a domain line also matches its bare stem', () => {
  const t = tok();
  const list = makeList({ folders: [tok()], file: [`${t}.test`] });
  expectFail(runMutated((root) => append(root, 'lib/a.js', `// ${t}\n`), envFor({ list })), /lib\/a\.js:\d+/, 'o');
});

// ── the guard cannot lie ─────────────────────────────────────────────────

test('i: npm is not on PATH → refuses (never "checked 0 — clean")', () => {
  expectFail(runGuard(BASE, envFor({ list: makeList({ folders: [tok()] }), path: mk('zq-nopath') })), /npm pack/, 'i');
});

test('j: a denylist name equal to the project\'s own brand → refuses', () => {
  expectFail(runGuard(BASE, envFor({ list: makeList({ folders: [tok()], file: ['acme'] }) })), /own brand/, 'j');
});

function patchedGuardRun(from, to, label, reason) {
  const list = makeList({ folders: [tok()] });
  const root = mk('zq-patched'); cpSync(BASE, root, { recursive: true });
  const p = join(root, GUARD_REL); const original = readFileSync(p, 'utf8');
  const patched = original.replace(from, to);
  assert.notStrictEqual(patched, original, `${label}: the mutation must change the guard (anchor moved?)`);
  writeFileSync(p, patched);
  expectFail(runGuard(root, envFor({ list })), reason, label);
}

test('m1: a matcher that finds nothing is caught by the canary', () => {
  patchedGuardRun('export function findHits(compiled, text) {', 'export function findHits(compiled, text) { return [];', 'm1', /does not find its own entry/);
});

test('m2: an empty `npm pack` file list is caught', () => {
  patchedGuardRun('function listPackFiles() {', 'function listPackFiles() { return [];', 'm2', /no files/);
});

test('m3: a scan loop that skips a file is caught by the count', () => {
  patchedGuardRun('// scan-loop\n  for (const file of textPaths) {', '// scan-loop\n  for (const file of textPaths.slice(1)) {', 'm3', /expected/);
});

test('p: the verdict line carries N, M, F and L, and they equal the independent count', () => {
  const list = makeList({ folders: [tok(), tok()], file: [tok(), tok(), tok()] });
  const r = runGuard(BASE, envFor({ list }));
  expectClean(r, 'p');
  const m = r.stdout.match(/(\d+) shippable file\(s\) checked against (\d+) denylisted name\(s\) \(folders (\d+) \+ file lines (\d+)\) — clean/);
  assert.ok(m, `verdict line format changed:\n${r.stdout}`);
  const n = packPaths(BASE).filter((p) => !isBinaryPath(p)).length;
  assert.deepStrictEqual(m.slice(1).map(Number), [n, 5, 2, 3]);
});

// ── inspected binaries ───────────────────────────────────────────────────

test('q1: a new binary outside the manifest stops the release', () => {
  const list = makeList({ folders: [tok()] });
  expectFail(runMutated((root) => copyFileSync(join(root, BINARIES[0]), join(root, `examples/${tok()}.png`)), envFor({ list })), /not text/, 'q1');
});

test('q2: a manifest binary with one changed byte stops the release', () => {
  const list = makeList({ folders: [tok()] });
  expectFail(runMutated((root) => {
    const p = join(root, BINARIES[0]); const b = readFileSync(p); b[b.length - 1] ^= 0xff; writeFileSync(p, b);
  }, envFor({ list })), /changed since it was inspected/, 'q2');
});

test('q3: a manifest binary that is gone stops the release (entry without a file)', () => {
  const list = makeList({ folders: [tok()] });
  expectFail(runMutated((root) => rmSync(join(root, BINARIES[0])), envFor({ list })), /entry without a file/, 'q3');
});

test('s1/s2/s3: a file that is not text (NUL, UTF-16, invalid UTF-8) stops the release', () => {
  const t = tok(); const list = makeList({ folders: [t] });
  expectFail(runMutated((root) => writeFileSync(join(root, `examples/${tok()}.txt`), Buffer.from('abc\0def')), envFor({ list })), /not text/, 's1 NUL');
  expectFail(runMutated((root) => writeFileSync(join(root, `examples/${tok()}.txt`), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`// ${t}`, 'utf16le')])), envFor({ list })), /not text/, 's2 UTF-16');
  expectFail(runMutated((root) => writeFileSync(join(root, `lib/${tok()}.md`), Buffer.from([0x61, 0xff, 0x62])), envFor({ list })), /not text/, 's3 invalid UTF-8');
});

// ── the CRM directory itself (D12) ───────────────────────────────────────

test('l1: a symlink to a directory counts as a client folder', () => {
  const t = tok(); const target = mk('zq-target'); const list = makeList();
  symlinkSync(target, join(list, t), process.platform === 'win32' ? 'junction' : 'dir');
  expectFail(runMutated((root) => append(root, 'lib/a.js', `// ${t}\n`), envFor({ list })), /lib\/a\.js:\d+/, 'l1');
});

test('l2/l3: a directory starting with "_" or "." is an error, not a silent skip', () => {
  for (const prefix of ['_', '.']) {
    const list = makeList({ folders: [tok()] }); mkdirSync(join(list, `${prefix}${tok()}`));
    expectFail(runGuard(BASE, envFor({ list })), /starts with "\." or "_"/, `l ${prefix}`);
  }
});

test('l4: a broken symlink in the folder → refuses', () => {
  const list = makeList({ folders: [tok()] });
  symlinkSync(join(tmpdir(), `zq-gone-${tok()}`), join(list, tok()), 'file');
  expectFail(runGuard(BASE, envFor({ list })), /broken link/, 'l4');
});

test('l5: a hidden regular file (.DS_Store) is not a name', () => {
  expectClean(runGuard(BASE, envFor({ list: makeList({ folders: [tok()], extra: { '.DS_Store': 'x' } }) })), 'l5');
});

// ── the real package, wiring, and the real repo ──────────────────────────

function testScriptFiles(pkg) {
  const files = new Set(); const seen = new Set();
  const visit = (name) => {
    if (seen.has(name) || !pkg.scripts[name]) return; seen.add(name);
    const cmd = pkg.scripts[name];
    for (const m of cmd.matchAll(/npm run ([\w:.-]+)/g)) visit(m[1]);
    for (const m of cmd.matchAll(/\btest\/[\w./*-]+/g)) {
      const t = m[0];
      if (!t.includes('*')) { files.add(t); continue; }
      const dir = dirname(t); const re = new RegExp('^' + t.slice(dir.length + 1).replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
      for (const f of readdirSync(join(REPO_ROOT, dir))) if (re.test(f)) files.add(`${dir}/${f}`);
    }
  };
  visit('test');
  return files;
}

test('k: wiring — the guard runs first in prepublishOnly, never in `npm test`, no lifecycle script can add files after it, no bypass', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const closure = testScriptFiles(pkg);
  assert.ok(!closure.has(GUARD_REL), 'the guard needs the CRM: it must not be in the `test` chain');
  assert.ok(closure.has('test/e2e/no-client-names-guard.test.js'), 'this file must be picked up by `npm test`');
  assert.strictEqual(pkg.scripts['test:no-client-names'], 'node test/no-client-names.test.js');
  assert.strictEqual(pkg.scripts.prepublishOnly.split('&&')[0].trim(), 'npm run test:no-client-names', 'the guard must be the FIRST step: a wrong path fails in a second');
  for (const s of ['prepack', 'prepare', 'postpack']) assert.ok(!pkg.scripts[s], `\`${s}\` runs after prepublishOnly: files it creates would not be seen by the guard`);
  const guard = readFileSync(join(REPO_ROOT, GUARD_REL), 'utf8');
  assert.ok(!guard.includes('brand-match'), 'the guard has its own matcher');
  assert.ok(!guard.includes('AEO_SKIP'), 'there is no skip switch');
  assert.ok(!readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8').includes('AEO_SKIP'), 'AGENTS.md must not teach a bypass');
});

test('r: the real repo with a synthetic list → clean, and the guard checked every non-binary file', () => {
  const list = makeList({ folders: [tok()], file: [tok()] });
  const r = spawnSync(process.execPath, [join(REPO_ROOT, GUARD_REL)], { cwd: REPO_ROOT, env: envFor({ list }), encoding: 'utf8' });
  expectClean(r, 'r');
  const nonText = new Set(packPaths(REPO_ROOT).filter((p) => readFileSync(join(REPO_ROOT, p)).includes(0)));
  const n = packPaths(REPO_ROOT).filter((p) => !nonText.has(p)).length;
  assert.match(r.stdout, new RegExp(`${n} shippable file\\(s\\) checked against 2 denylisted name\\(s\\) \\(folders 1 \\+ file lines 1\\)`), 'N equals the paths of `npm pack` minus the files with a NUL byte');
});
