/**
 * Guard — real client names must never ship in the published npm package.
 *
 * Why this exists (A70, 2026-09): four client brand names — found in comments,
 * doc examples and one usage example across `lib/`, `bin/`, README.md and
 * CHANGELOG.md — shipped in published 1.x tarballs before this guard existed.
 * See CHANGELOG.md's [Unreleased] / Docs entry for the cleanup this pins.
 *
 * The denylist is deliberately NOT embedded in this file. This repo is public;
 * a hardcoded list of client names would itself publish the very names it
 * exists to keep out, and it would go stale the moment a client is onboarded
 * or offboarded without anyone remembering to edit a test. Instead the list is
 * read from OUTSIDE the repo at runtime, named by the AEO_CLIENT_DENYLIST env
 * var — either a text file (one name/domain per line) or a directory (entry
 * names are the client names, matching how the founder described the CRM
 * layout as `resources/clients/<name>/`). Point it at that path before a
 * release:
 *
 *   AEO_CLIENT_DENYLIST=/path/to/resources/clients npm run prepublishOnly
 *
 * Without that env var this guard has nothing to check against. Per this
 * repo's own rule (AGENTS.md: "the correct output is a named gap — never a
 * plausible number"), it refuses to report a silent "clean" in that case — it
 * fails loudly instead, naming the env var, UNLESS the release explicitly
 * acknowledges the skip with AEO_SKIP_CLIENT_NAME_GUARD=1 (which still prints
 * an unmissable "DID NOT CHECK" line, never a quiet pass). That makes the
 * choice to skip a release-time decision someone has to make on purpose, not
 * a default nobody notices.
 *
 * Matching reuses this project's own separator-tolerant, word-boundary-anchored
 * brand matcher (`lib/brand-match.js` — the same code `detectMention` uses) so
 * a denylisted "Acme Corp" also catches "AcmeCorp" / "Acme-Corp", not just an
 * exact substring. `OWN_NAMES` exempts this project's own brand/product family
 * (the names `bin/research-dataset.mjs` already treats as "ours", plus this
 * guard's own fictional placeholder brand) so the guard cannot fail on the
 * maintainer's own `author` field or `--help` text.
 *
 * Not part of the default `npm test` chain — nothing on a contributor's
 * machine has the CRM path, so it would fail on every clean checkout the way
 * AGENTS.md warns a "suite nobody runs" does. It runs from `prepublishOnly`,
 * next to `test:pack-files`, over the same on-disk file set that script
 * already enumerates from `npm pack --dry-run --json`.
 *
 * Mutation-sanity: this goes red the moment any denylisted name is
 * reintroduced into any shippable text file, anywhere in the file (not just
 * the four sites this cleanup touched) — verified by copying the guard next
 * to a tree with one name deliberately reinserted and confirming it fails
 * with the exact file:line.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandTerms, textMentionsBrand, earliestBrandIndex } from '../lib/brand-match.js';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));

// This project's own brand/product family — never a "client". Mirrors
// bin/research-dataset.mjs's OWN_DOMAINS plus the bare names those domains
// resolve to, and the fictional placeholder brand this cleanup introduced.
const OWN_NAMES = new Set([
  'webappski', 'webappski.com',
  'webappka',
  'typelessform', 'typelessform.com',
  'typelessity', 'typelessity.com',
  'aeo-platform', 'aeo-tracker',
  'acme', 'acore', 'acore.com', // this guard's own placeholder brand
]);

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.txt', '.css']);

function walkTextFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTextFiles(full));
    else if (TEXT_EXTENSIONS.has(extname(full))) out.push(full);
  }
  return out;
}

// Same shippable surface as test/pack-files.test.js (package.json::files[]).
function shippableTextFiles() {
  const files = [
    ...walkTextFiles(join(PROJ, 'bin')),
    ...walkTextFiles(join(PROJ, 'lib')),
    ...walkTextFiles(join(PROJ, 'examples')),
  ];
  for (const f of ['README.md', 'CHANGELOG.md']) {
    const full = join(PROJ, f);
    if (existsSync(full)) files.push(full);
  }
  return files;
}

function loadDenylist(pathArg) {
  const st = statSync(pathArg);
  // Directory mode: only take entries that are THEMSELVES directories (one per
  // client, `resources/clients/<name>/`) — a stray file dropped next to them
  // (a README, a .DS_Store) must not silently become a denylisted "name".
  const names = st.isDirectory()
    ? readdirSync(pathArg, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    : readFileSync(pathArg, 'utf-8').split('\n');
  return names
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !s.startsWith('.') && !s.startsWith('_'))
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

function lineOf(text, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) if (text[i] === '\n') line++;
  return line;
}

console.log('no-client-names — real client names must not ship in the npm package');

const denylistPath = process.env.AEO_CLIENT_DENYLIST;

if (!denylistPath) {
  if (process.env.AEO_SKIP_CLIENT_NAME_GUARD === '1') {
    console.warn('  ⚠ DID NOT CHECK — AEO_SKIP_CLIENT_NAME_GUARD=1 set with no AEO_CLIENT_DENYLIST.');
    console.warn('    This release was NOT verified clean of real client names. Explicit skip acknowledged.');
    process.exit(0);
  }
  console.error('  ✗ AEO_CLIENT_DENYLIST is not set — this guard has nothing to check against.');
  console.error('');
  console.error('  Point it at the CRM client list before a release:');
  console.error('    AEO_CLIENT_DENYLIST=/path/to/resources/clients npm run prepublishOnly');
  console.error('');
  console.error('  Or, to publish anyway with this guard explicitly unverified:');
  console.error('    AEO_SKIP_CLIENT_NAME_GUARD=1 npm run prepublishOnly');
  process.exit(1);
}

const names = loadDenylist(denylistPath).filter(n => !OWN_NAMES.has(n.toLowerCase()));

if (names.length === 0) {
  console.log(`  ✓ denylist at ${denylistPath} loaded but is empty (or only own-brand names) — nothing to check`);
  process.exit(0);
}

const files = shippableTextFiles();
const hits = [];

for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  for (const name of names) {
    const domainLike = /\.[a-z]{2,}$/i.test(name);
    const terms = brandTerms(name, domainLike ? name : '', []);
    if (!textMentionsBrand(text, terms)) continue;
    const idx = earliestBrandIndex(text, terms);
    hits.push({
      file: relative(PROJ, file).split(sep).join('/'),
      line: idx >= 0 ? lineOf(text, idx) : '?',
      name,
    });
  }
}

if (hits.length === 0) {
  console.log(`  ✓ ${files.length} shippable file(s) checked against ${names.length} denylisted name(s) — clean`);
  process.exit(0);
}

console.error(`  ✗ ${hits.length} client-name match(es) found in shippable files:`);
for (const h of hits) console.error(`      ${h.file}:${h.line} — "${h.name}"`);
process.exit(1);
