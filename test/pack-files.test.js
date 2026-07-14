/**
 * Guard against the 0.3.1 bug class: a file exists on disk and is imported by
 * the code, but `npm pack` doesn't include it in the published tarball.
 *
 * What happened in 0.3.1: `lib/report/own-domain.js` was on disk (referenced by
 * `outreach-templates.js`, `sections.js`, and `test/own-domain.test.js`), but
 * the published 0.3.1 tarball didn't include it. End-users running 0.3.1 hit
 * `Cannot find module './own-domain.js'` from the four downstream call-sites.
 * `prepublishOnly` ran `npm test` and passed because tests imported from disk,
 * not from a tarball — masking the gap.
 *
 * This guard closes that gap by running `npm pack --dry-run --json` and
 * verifying that every `.js` / `.css` / `.png` / `.md` / `.txt` / `.woff2`
 * under `lib/` + `bin/` + `examples/` on disk appears in the tarball.
 *
 * Runs as part of `prepublishOnly` (not the default `test` chain) — keeps
 * `npm test` fast for normal development, gates only at publish time.
 *
 * Cost: ~1s. `npm pack --dry-run` doesn't write the tarball, just enumerates
 * what would be packed, so this can't accidentally invoke prepublishOnly
 * recursively.
 */

import { execSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));

/** Recursively collect every file under `dir` (returns repo-relative paths). */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    // Normalize to POSIX separators: npm's `pack --json` always emits '/'-paths,
    // but relative() yields '\' on Windows, so the Set membership check below
    // would never match and every file would be falsely reported "missing".
    else out.push(relative(PROJ, full).split(sep).join('/'));
  }
  return out;
}

// 1. Enumerate every shippable file on disk.
//    `package.json::files[]` is the source of truth for what npm SHOULD include:
//    bin/, lib/, examples/, README.md, CHANGELOG.md, LICENSE.
const onDisk = [
  ...walk(join(PROJ, 'bin')),
  ...walk(join(PROJ, 'lib')),
  ...walk(join(PROJ, 'examples')),
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
];

// 2. Ask npm what it WOULD pack right now.
let packMeta;
try {
  const raw = execSync('npm pack --dry-run --json', { cwd: PROJ, encoding: 'utf-8' });
  packMeta = JSON.parse(raw);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`✗ pack-files: failed to run \`npm pack --dry-run --json\`:\n    ${msg}`);
  process.exit(1);
}

const inTarball = new Set((packMeta[0]?.files || []).map(f => f.path));

// 3. Compare: anything on disk that npm decided NOT to pack is suspicious.
const missing = onDisk.filter(f => !inTarball.has(f));

console.log(`pack-files — npm pack --dry-run check`);

if (missing.length === 0) {
  console.log(`  ✓ all ${onDisk.length} shippable files on disk are in the tarball (${inTarball.size} total files)`);
  process.exit(0);
}

console.error(`  ✗ ${missing.length} file(s) exist on disk but were NOT included in the npm pack tarball:`);
for (const f of missing) console.error(`      ${f}`);
console.error(``);
console.error(`  This is the bug class that broke 0.3.1 (own-domain.js was on disk but`);
console.error(`  missing from the published tarball — end-users hit "Cannot find module").`);
console.error(``);
console.error(`  Likely causes:`);
console.error(`    1. File is gitignored AND not whitelisted by package.json::files[].`);
console.error(`    2. File is in a path that doesn't match the package.json::files[] globs.`);
console.error(`    3. .npmignore (if present) excludes the file.`);
console.error(``);
console.error(`  Fix: ensure each missing file is reachable through package.json::files[]`);
console.error(`  patterns. Re-run \`npm pack --dry-run\` manually to verify.`);
process.exit(1);
