// MEAS-2 guard — "one denominator" has to be ENFORCED, not asserted once.
//
// The defect being prevented is not a wrong number, it is a SECOND definition
// of the same number. Five surfaces each counted "how many answers mentioned
// us / out of how many" in their own file, and they drifted. Fixing the five
// and writing a test for the five leaves the sixth free to be added tomorrow.
//
// So this test walks the source and fails when the hit-test (`mention === 'yes'
// || mention === 'src'`) appears outside `lib/score.js` at a site that is not
// on the allowlist below. Every allowlisted site carries a one-line reason, so
// the residual divergence is NAMED rather than silently tolerated.
//
// Precedent for a source-walking guard in this suite: test/design-lint.test.js
// and test/sections-integrity.test.js.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** file → why this file is allowed to state the hit-test itself. */
const ALLOWED = new Map([
  ['lib/score.js', 'the definition itself'],
  ['lib/sampling.js', 'trial-level hit rule — it is what PRODUCES presence.hits that score.js then reads'],
  ['lib/report/visibility-index.js', 'per-cell presence fallback for a legacy record; already prefers presence.rate'],
  ['lib/report/sections.js', 'two boolean predicates (is this cell a hit?), no denominator'],
  ['lib/report/html.js', 'a comment quoting the rule, and the sentiment gate — not a count'],
  ['bin/aeo-tracker.js', 'sentiment/prose-rank gates on a single cell — not a count'],
]);

/**
 * Same idea for the branched form: file → why its branch counting is not a
 * denominator of its own.
 *
 * Deliberately almost empty. Every file that branch-counts today (the coverage
 * buckets in `bin/aeo-tracker.js`, the lift buckets in `run-metrics.js`, the
 * matrix buckets in `html.js`) keeps ONLY bucket counts locally and takes its
 * denominator from `lib/score.js` — so none of them trips this check and none
 * of them needs an exemption. Adding one back here would re-open the hole the
 * check exists to close; the fix is to take the total from score.js instead.
 */
const BRANCH_ALLOWED = new Map([
  ['lib/score.js', 'the definition itself'],
]);

/**
 * Two shapes of the same hand-rolled hit-test, because the first version of
 * this guard only knew the first one — and the second slipped a fourteenth
 * divergent denominator past it (`coverage` in bin/aeo-tracker.js, which
 * branched `if (mention === 'yes') … else if (mention === 'src') …` and
 * incremented its own `total`, published as «Named in X/Y cells»).
 *
 *   INLINE   — `mention === 'yes' || mention === 'src'` on one line;
 *   BRANCHED — a per-line `mention === 'yes'` / `mention === 'src'` test, which
 *              is only a hit-count when the same block also keeps a running
 *              total, so the branched form is reported per FILE together with
 *              the accumulator it feeds.
 */
const HIT_TEST = /mention === '(yes|src)'\s*\|\|[^\n]*mention === '(yes|src)'/;
const BRANCH_YES = /mention === 'yes'/;
const BRANCH_SRC = /mention === 'src'/;
/** An accumulator that turns branch counting into a denominator. */
const ACCUMULATOR = /(\.total\s*(\+=|\+\+)|total:\s*\w+\.length|\btotal\s*\+\+)/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

console.log('\nthe visibility denominator lives in exactly one module');

test('no un-allowlisted file re-states the hit-test (inline form)', () => {
  const files = [...walk(join(ROOT, 'lib')), join(ROOT, 'bin', 'aeo-tracker.js')];
  const offenders = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (ALLOWED.has(rel)) continue;
    const src = readFileSync(file, 'utf-8');
    src.split('\n').forEach((line, i) => {
      if (HIT_TEST.test(line)) offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'these files count hits themselves instead of calling lib/score.js — either route them through '
    + 'aggregateScore/sliceStats, or add them to ALLOWED with a reason that says why they are not a denominator');
});

test('no un-allowlisted file counts hits by BRANCHING and keeps its own total', () => {
  // The form the first guard was blind to: no `||` anywhere, just
  // `if (yes) … else if (src) …` next to a `total` it increments itself.
  const files = [...walk(join(ROOT, 'lib')), join(ROOT, 'bin', 'aeo-tracker.js')];
  const offenders = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (BRANCH_ALLOWED.has(rel)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (!BRANCH_YES.test(line)) return;
      // Look at the small window around the branch: a hit-count only becomes a
      // denominator when a total is accumulated with it.
      const window = lines.slice(Math.max(0, i - 4), i + 6).join('\n');
      if (BRANCH_SRC.test(window) && ACCUMULATOR.test(window)) {
        offenders.push(`${rel}:${i + 1} — branch-counts hits next to its own total`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these files branch-count mentions into a denominator of their own — take the denominator from '
    + 'lib/score.js (aggregateScore/sliceStats) and keep only the bucket counts locally');
});

test('every allowlist entry still exists and still carries a reason', () => {
  for (const [rel, reason] of [...ALLOWED, ...BRANCH_ALLOWED]) {
    assert.ok(reason && reason.length > 10, `allowlist entry ${rel} has no usable reason`);
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    assert.ok(src.length > 0, `allowlisted file ${rel} no longer exists`);
  }
});

test('the modules that publish a share import the one definition', () => {
  // A surface can also drift by quietly copying the arithmetic without the
  // literal hit-test (e.g. `presence.hits / presence.n` inline). Requiring the
  // import keeps the intent visible in the file itself.
  const mustImport = [
    'lib/report/run-metrics.js',
    'lib/report/sections.js',
    'lib/report/html.js',
    'lib/report/topic-cluster.js',
    'lib/report/mc-metadata.js',
    'lib/diff.js',
    'bin/aeo-tracker.js',
  ];
  for (const rel of mustImport) {
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    assert.match(src, /from '\.\.?\/(\.\.\/)?(lib\/)?score\.js'/,
      `${rel} publishes a share but does not import the one denominator (lib/score.js)`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
