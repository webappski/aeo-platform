/**
 * Guard — real client names must never ship in the published npm package.
 *
 * Why this exists (A70, 2026-09): four client brand names — found in comments,
 * doc examples and one usage example across `lib/`, `bin/`, README.md and
 * CHANGELOG.md — shipped in published 1.x tarballs before this guard existed.
 *
 * The denylist is deliberately NOT embedded in this file. This repo is public;
 * a hardcoded list of client names would itself publish the very names it
 * exists to keep out. The list is read from OUTSIDE the repo at runtime, from
 * ONE directory named by AEO_CLIENT_DENYLIST (the CRM layout
 * `resources/clients/`):
 *
 *   - every sub-directory is one client (the folder name is the name; a
 *     symlink to a directory counts; a directory starting with `.` or `_`
 *     is an error, not a skip);
 *   - `public-package-denylist.txt` in that directory adds the brands and
 *     domains that are not equal to a folder name (one per line; empty
 *     lines and lines starting with `#` are skipped; anything else that is
 *     not a plain name — a trailing comment, a URL, `/`, `@` — is an error).
 *
 * Release command (same path, one place):
 *
 *   AEO_CLIENT_DENYLIST=$HOME/Projects/webappski-ops/resources/clients npm publish
 *
 * Fail closed, never a quiet "clean". Exit 1 when: the variable is not set;
 * the path does not exist or is not a directory; the list file is missing,
 * unreadable or not a regular file; a list line is not a plain name; a CRM
 * entry is neither a directory nor a regular file; the list is empty; a name
 * equals this project's own brand; `npm pack` fails or returns no files; the
 * file list lacks package.json, a README or a LICENSE; a file is not text
 * (NUL byte or invalid UTF-8) and is not in the inspected-binary manifest; a
 * manifest binary changed, or is gone; the matcher cannot find its own
 * entries; the number of files scanned differs from the number expected.
 * There is NO bypass variable: tests are never skipped (maintainer decision;
 * npm's own `--ignore-scripts` is the only way past a lifecycle script).
 *
 * File set: exactly what `npm pack --dry-run --json --ignore-scripts` lists
 * (the same set the registry gets: package.json, README and LICENSE are
 * always in it). Every path is scanned as a name too (paths are visible on
 * npmjs.com). Binary files cannot be read as text, so the nine in
 * BINARY_MANIFEST were looked at by eye and are pinned by path and sha256; a
 * new or changed binary stops the release until someone looks at it and
 * updates the manifest.
 *
 * Matcher (own, self-contained — it deliberately imports no product module,
 * because the product's brand matcher has the opposite goal: avoid false
 * positives):
 * names and text are NFC-normalised; between any two letters of a name the
 * separators `- _ . + & ' ’`, U+2010–2015, U+00A0, any format character
 * (\p{Cf}: zero-width, soft hyphen, word joiner) and `%20` are allowed; the
 * name must not touch another letter or digit. A domain-like line also
 * matches its bare stem. Names of 5+ characters get a second pass without
 * word boundaries (glued suffixes such as `<name>Labs`, `<name>2`). The cost
 * of a false positive is loud and cheap (rewrite a sentence); a miss is
 * silent and cannot be recalled from npm. Deliberate obfuscation (HTML
 * entities, `\u` escapes, homoglyphs) is out of scope: this guards against an
 * accident, not against someone with commit rights.
 *
 * Not in `npm test`'s chain: a clean checkout has no CRM. It runs first in
 * `prepublishOnly`, so a wrong path fails in a second instead of after the
 * whole suite. `test/e2e/no-client-names-guard.test.js` (synthetic names,
 * real `npm pack`) keeps the mechanics honest on every commit.
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));
const LIST_FILE = 'public-package-denylist.txt';

// This project's own brand/product family — never a "client". A denylist name
// equal to one of these is a configuration error (it would never be checked).
const OWN_NAMES = new Set([
  'webappski', 'webappski.com',
  'webappka',
  'typelessform', 'typelessform.com',
  'typelessity', 'typelessity.com',
  'aeo-platform', 'aeo-tracker',
  'acme', 'acore', 'acore.com', // the placeholder brand used in docs and tests
]);

// Binary files that ship in the package, looked at by eye on 2026-10-24
// (six screenshots and a preview image: own brand, AEO competitors, Acme;
// three variable fonts). Path → sha256.
export const BINARY_MANIFEST = [
  ['examples/screenshot-01-hero.png', 'de06695a4c41ad33f1662e2add0b98679f01dc2624713072f9e85fec72b3c1e5'],
  ['examples/screenshot-02-position-grid.png', '4f4aca35e01d7a2026e4c908d857d1537ae2e73a91007fcef593db6cbe5646e9'],
  ['examples/screenshot-03-competitors-sources.png', 'fd163ed2740f90007ce3de5815ae894371ed0d9d5c78c44995fc2250a763e5b5'],
  ['examples/screenshot-04-actions.png', 'a4e3c9e4148a83b8ee3dcc6d63425f6fa5ae85d0152dcc3c6a3f13814be62d35'],
  ['examples/screenshot-05-actions.png', '3af64029bf7c5f6c0488976ef05cbb8a1b1ce02d17ae7954084e043e1cea756b'],
  ['lib/report/assets/mc-preview.png', '7de4fa887ecb9005d32c84999daff3ed626e6313fd15b3fa7e9db38b4af20516'],
  ['lib/report/fonts/Fraunces-Variable-latin.woff2', '48282a415ec22e31beaf0a0666e6fae0c8cbddcd0b1f6e729f27c3ade8a64e43'],
  ['lib/report/fonts/Geist-Variable-latin.woff2', 'a29f900a6d603e989449327956e7ac61ea3e6b26ca7426f64e7cccf2cd4aed37'],
  ['lib/report/fonts/JetBrainsMono-Variable-latin.woff2', '2c32b9b3ee358c119e210f6f5195f9bd34894d78a785ff2e95d60e718e400af4'],
];

// ── matcher ───────────────────────────────────────────────────────────────

const SEPCH = "[\\s\\-_.+&'\\u2019\\u2010-\\u2015\\u00a0\\p{Cf}]";
const SEP = `(?:${SEPCH}|%20)*`;
const STRIP = new RegExp(`(?:${SEPCH}|%20)+`, 'gu');
const TLD = /\.[a-z]{2,}$/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function boundedPattern(stem) {
  const chars = [...stem.replace(STRIP, '')].map(esc).join(SEP);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${chars})(?![\\p{L}\\p{N}])`, 'giu');
}

export function compileDenylist(names) {
  return names.map(raw => {
    const name = raw.normalize('NFC').trim();
    const stems = TLD.test(name) ? [name, name.replace(TLD, '')] : [name];
    const glued = name.replace(TLD, '').replace(STRIP, '').toLowerCase();
    return {
      name,
      patterns: stems.map(boundedPattern),
      glued: glued.length >= 5 ? glued : null,
      gluedRe: glued.length >= 5 ? new RegExp(esc(glued), 'giu') : null,
    };
  });
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// Every place where any compiled name occurs in `text` (a file body or a
// path). Index/length/line refer to the NFC-normalised text.
export function findHits(compiled, text) {
  const t = text.normalize('NFC');
  const hits = [];
  for (const entry of compiled) {
    for (const re of entry.patterns) {
      for (const m of t.matchAll(re)) {
        hits.push({ name: entry.name, index: m.index, length: m[0].length, line: lineOf(t, m.index) });
      }
    }
    if (entry.gluedRe) {
      for (const m of t.matchAll(entry.gluedRe)) {
        hits.push({ name: entry.name, index: m.index, length: m[0].length, line: lineOf(t, m.index) });
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

// ── denylist loading ──────────────────────────────────────────────────────

class GuardError extends Error {}
const fail = msg => { throw new GuardError(msg); };

const LINE_OK = /^[\p{L}\p{N}][\p{L}\p{N} .\-&'’+]*$/u;

function loadDenylist(dir) {
  let st;
  try { st = statSync(dir); } catch { fail(`AEO_CLIENT_DENYLIST points to a path that does not exist: ${dir}`); }
  if (!st.isDirectory()) fail(`AEO_CLIENT_DENYLIST must be a directory (the CRM clients folder), not a file: ${dir}`);

  let entries;
  try { entries = readdirSync(dir); } catch (e) { fail(`cannot read the denylist directory ${dir}: ${e.code || e.message}`); }

  const folders = [];
  for (const entry of entries.sort()) {
    if (entry === LIST_FILE) continue;
    let es;
    try { es = statSync(join(dir, entry)); } catch { fail(`denylist entry "${entry}" is a broken link or unreadable`); }
    if (es.isDirectory()) {
      if (entry.startsWith('.') || entry.startsWith('_')) {
        fail(`denylist directory "${entry}" starts with "." or "_": rename it, or put that brand on a line in ${LIST_FILE}`);
      }
      folders.push(entry.normalize('NFC'));
    } else if (!es.isFile()) {
      fail(`denylist entry "${entry}" is neither a directory nor a regular file`);
    }
  }

  const listPath = join(dir, LIST_FILE);
  let lines = [];
  if (!existsSync(listPath)) {
    if (folders.length > 0) {
      fail(`${LIST_FILE} is missing in ${dir}: brands and domains that differ from a folder name would silently go unchecked`);
    }
  } else {
    let ls;
    try { ls = statSync(listPath); } catch { fail(`${LIST_FILE} is unreadable`); }
    if (!ls.isFile()) fail(`${LIST_FILE} is not a regular file`);
    let body;
    try { body = readFileSync(listPath, 'utf-8'); } catch (e) { fail(`${LIST_FILE} cannot be read: ${e.code || e.message}`); }
    body.split('\n').forEach((raw, i) => {
      const line = raw.normalize('NFC').trim();
      if (line === '' || line.startsWith('#')) return;
      if (!LINE_OK.test(line)) {
        fail(`${LIST_FILE}:${i + 1} is not a plain name (a trailing comment, URL, "/" or "@" would match nothing, silently)`);
      }
      lines.push(line);
    });
  }

  const seen = new Set();
  const names = [];
  for (const n of [...folders, ...lines]) {
    const k = n.toLowerCase();
    if (!seen.has(k)) { seen.add(k); names.push(n); }
  }
  if (names.length === 0) fail(`the denylist at ${dir} is empty — there is nothing to check against`);
  for (const n of names) {
    if (OWN_NAMES.has(n.toLowerCase())) fail(`a denylist name equals this project's own brand ("${n}") and would never be checked`);
  }
  return { names, folders: folders.length, lines: lines.length };
}

// ── package file set ──────────────────────────────────────────────────────

function listPackFiles() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PROJ, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  });
  if (r.error || r.status !== 0) fail(`npm pack --dry-run failed (${r.error ? r.error.code || r.error.message : 'exit ' + r.status}): the file list is unknown`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { fail('npm pack --dry-run did not return JSON: the file list is unknown'); }
  const files = parsed && parsed[0] && Array.isArray(parsed[0].files) ? parsed[0].files.map(f => f.path) : [];
  return files;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

const decoder = new TextDecoder('utf-8', { fatal: true });

// One report line per name per file (the earliest place), like the check it replaces.
function firstPerName(hs) {
  const seen = new Map();
  for (const h of hs) if (!seen.has(h.name)) seen.set(h.name, h);
  return [...seen.values()];
}

// ── main ──────────────────────────────────────────────────────────────────

function run(env) {
  console.log('no-client-names — real client names must not ship in the npm package');

  const dir = env.AEO_CLIENT_DENYLIST;
  if (!dir) {
    console.error('  ✗ AEO_CLIENT_DENYLIST is not set — this guard has nothing to check against.');
    console.error('');
    console.error('  Point it at the CRM clients folder:');
    console.error('    AEO_CLIENT_DENYLIST=/path/to/resources/clients npm run test:no-client-names');
    return 1;
  }

  const { names, folders, lines } = loadDenylist(dir);
  const compiled = compileDenylist(names);

  // Canary: the matcher must find every one of its own entries, in both passes.
  compiled.forEach((e, i) => {
    if (!findHits([e], `x ${e.name} y`).length) fail(`the matcher does not find its own entry #${i + 1} (boundary pass)`);
    if (e.glued && !findHits([e], `x${e.glued}zq y`).length) fail(`the matcher does not find its own entry #${i + 1} (glued pass)`);
  });

  const packFiles = listPackFiles();
  const base = packFiles.filter(f => !f.includes('/'));
  if (packFiles.length === 0) fail('npm pack lists no files: the file set is unknown');
  if (!packFiles.includes('package.json')) fail('npm pack does not list package.json');
  if (!base.some(f => /^readme(\.|$)/i.test(f))) fail('npm pack does not list a README');
  if (!base.some(f => /^licen[cs]e(\.|$)/i.test(f))) fail('npm pack does not list a LICENSE');

  // Inspected binaries: pinned by path and sha256.
  const manifest = new Map(BINARY_MANIFEST);
  const packSet = new Set(packFiles);
  for (const [p] of BINARY_MANIFEST) {
    if (!packSet.has(p)) fail(`manifest binary "${p}" is not in the package (entry without a file): inspect the change and update BINARY_MANIFEST`);
  }
  const textPaths = packFiles.filter(f => !manifest.has(f));
  const expected = textPaths.length;

  const hits = [];
  let checked = 0;

  for (const [p, want] of BINARY_MANIFEST) {
    let buf;
    try { buf = readFileSync(join(PROJ, p)); } catch (e) { fail(`manifest binary "${p}" cannot be read: ${e.code || e.message}`); }
    if (sha256(buf) !== want) fail(`binary "${p}" changed since it was inspected: look at it, then update BINARY_MANIFEST`);
    for (const h of firstPerName(findHits(compiled, p))) hits.push({ where: `${p} (path)`, name: h.name });
  }

  // scan-loop
  for (const file of textPaths) {
    let buf;
    try { buf = readFileSync(join(PROJ, file)); } catch (e) { fail(`"${file}" is in the package but cannot be read: ${e.code || e.message}`); }
    let text;
    if (buf.includes(0)) fail(`"${file}" is not text (NUL byte) and is not in BINARY_MANIFEST: inspect it, then add it`);
    try { text = decoder.decode(buf); } catch { fail(`"${file}" is not text (invalid UTF-8) and is not in BINARY_MANIFEST: inspect it, then add it`); }
    for (const h of firstPerName(findHits(compiled, file))) hits.push({ where: `${file} (path)`, name: h.name });
    for (const h of firstPerName(findHits(compiled, text))) hits.push({ where: `${file}:${h.line}`, name: h.name });
    checked++;
  }

  if (checked !== expected) fail(`scanned ${checked} file(s) but expected ${expected}: the scan loop skipped files`);

  if (hits.length === 0) {
    console.log(`  ✓ ${checked} shippable file(s) checked against ${names.length} denylisted name(s) (folders ${folders} + file lines ${lines}) — clean`);
    return 0;
  }
  const unique = [...new Map(hits.map(h => [`${h.where}\u0000${h.name}`, h])).values()];
  console.error(`  ✗ ${unique.length} client-name match(es) found in shippable files:`);
  for (const h of unique) console.error(`      ${h.where} — "${h.name}"`);
  return 1;
}

function isDirectRun() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href; } catch { return false; }
}

if (isDirectRun()) {
  let code;
  try {
    code = run(process.env);
  } catch (e) {
    console.error(`  ✗ ${e instanceof GuardError ? e.message : 'the guard crashed: ' + (e && e.message)}`);
    code = 1;
  }
  process.exit(code);
}
