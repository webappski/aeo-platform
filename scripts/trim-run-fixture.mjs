#!/usr/bin/env node
/**
 * Project a real `_summary.json` onto the fields the scoring and comparison
 * code actually reads, and write it into `test/fixtures/` as a committed test
 * input.
 *
 * Why a projection instead of the file itself: the real summaries live outside
 * this repository (a measured project's own working directory) and carry the
 * full answer text of every cell. A test that reads an absolute path on one
 * machine is a test that fails on every other checkout of a published npm
 * package; a fixture that carries verbatim engine answers bloats the package
 * and leaks a client's report into it.
 *
 * Why a script instead of a hand-written fixture: the numbers in these files
 * are load-bearing (a fixture asserts the 2026-08-31 baseline still scores 13),
 * so they must be reproducible from the source rather than typed. Re-run this
 * and diff if you ever doubt them.
 *
 * Usage:
 *   node scripts/trim-run-fixture.mjs <summary.json> <fixture-name> [--also <path>]
 *
 * Reads nothing else, writes exactly one file, calls no network and no engine.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'test', 'fixtures');

/**
 * Describe a source path WITHOUT writing an absolute home path into a file that
 * ships to a public repository. The provenance has to stay checkable by whoever
 * has the tree, so the path is kept — with `$HOME` collapsed to `~`, which
 * drops the operating-system account name.
 */
function describePath(p) {
  const home = homedir();
  return typeof p === 'string' && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Fields a trimmed cell keeps — exactly what lib/score.js and lib/diff.js read
 *  (plus `model`, which the per-engine split groups by). */
const KEEP = ['query', 'queryText', 'queryId', 'provider', 'model', 'mention', 'presence', 'trials', 'market'];

function trimCell(r) {
  const out = {};
  for (const k of KEEP) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

const [, , srcPath, name, ...rest] = process.argv;
if (!srcPath || !name) {
  console.error('Usage: node scripts/trim-run-fixture.mjs <summary.json> <fixture-name> [--also <path>]');
  process.exit(1);
}
const alsoIdx = rest.indexOf('--also');
const also = alsoIdx >= 0 ? rest[alsoIdx + 1] : null;

const s = JSON.parse(readFileSync(srcPath, 'utf-8'));
const out = {
  _provenance: {
    source: describePath(srcPath),
    sourceNote: 'A measured project\'s own run directory, outside this repository. Paths are written with $HOME collapsed to ~ because this file ships in a public repo.',
    ...(also ? { alsoAt: describePath(also) } : {}),
    generated: new Date().toISOString().slice(0, 10),
    generatedBy: 'scripts/trim-run-fixture.mjs',
    reduction: `results[] trimmed to ${KEEP.join(', ')}. Every other field (responseExcerpt, citations, competitors, costs) dropped — none of them is read by lib/score.js or lib/diff.js.`,
    publishedHeadline: {
      score: s.score, mentions: s.mentions, total: s.total,
      errors: s.errors, cells: (s.results || []).length,
    },
  },
  date: s.date,
  brand: s.brand,
  domain: s.domain,
  score: s.score,
  mentions: s.mentions,
  total: s.total,
  errors: s.errors,
  regressionThreshold: s.regressionThreshold,
  results: (s.results || []).map(trimCell),
};

const dest = join(FIXTURE_DIR, `${name}.json`);
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${dest} — ${out.results.length} cells, published score ${s.score}`);
