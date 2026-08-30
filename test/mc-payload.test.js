// `bin/mc-payload.mjs` — the CLI wrapper that writes the client-facing MC
// bridge payload next to `_summary.json`. Previously shipped with ZERO test
// coverage on its `loadSnapshotHistory()` walker (flagged 2026-07-11 as
// Blocker 2, never closed; re-flagged independently by two judges on
// 2026-08-29). Driven as a real CLI subprocess against fixture files on
// disk — the same spawnSync pattern as test/cli-smoke.test.js — because the
// function under test is a private, unexported part of the script: the CLI
// IS the interface (E2E-first, R37 — no behavioral mock of the walk).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(PROJ, 'bin', 'mc-payload.mjs');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Minimal but valid `_summary.json` — same shape as mc-basket-kind.test.js's fixture. */
function summaryFixture(date, domain, score) {
  return {
    date, domain, score,
    brand: 'Acme', mentions: 1, total: 2,
    results: [
      { query: 'Q1', provider: 'openai', mention: 'yes', canonicalCitations: [], competitors: [] },
      { query: 'Q2', provider: 'openai', mention: 'no', canonicalCitations: [], competitors: [] },
    ],
    topCompetitors: [], topCanonicalSources: [], topDomains: [],
  };
}

/**
 * A domain-nested `aeo-responses/<domain>/<date>/_summary.json` tree — the
 * v1.8.0 layout `loadSnapshotHistory` walks. Returns the run-folder path for
 * `targetDate`.
 */
function buildFixtureTree(root, domain, dates) {
  const responsesRoot = join(root, 'aeo-responses', domain);
  for (const [date, score] of dates) {
    const dir = join(responsesRoot, date);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_summary.json'), JSON.stringify(summaryFixture(date, domain, score)));
  }
  return responsesRoot;
}

function runCli(runDir, lang = 'en') {
  const r = spawnSync(process.execPath, [BIN, runDir, lang], { stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`mc-payload.mjs exited ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
  }
  return r;
}

/** Run with NO lang arg at all — exercises the config/'en' fallback chain. */
function runCliNoLangArg(runDir) {
  const r = spawnSync(process.execPath, [BIN, runDir], { stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`mc-payload.mjs exited ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
  }
  return r;
}

console.log('\nbin/mc-payload.mjs — loadSnapshotHistory() via the real CLI');

test('history is built from ALL sibling dated runs, sorted by the summary\'s own .date field — not folder-name order', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    const responsesRoot = buildFixtureTree(root, 'acme.com', [
      ['2026-05-01', 40],
      ['2026-06-15', 60],
      ['2026-07-20', 80],
    ]);
    const targetDir = join(responsesRoot, '2026-07-20');
    runCli(targetDir);
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.comparison.runCount, 3, 'all three dated runs must be counted');
    assert.deepEqual(payload.comparison.pair, { prevDate: '2026-06-15', currDate: '2026-07-20' });
    // The earliest run's date, not the latest folder alphabetically or by mtime.
    assert.equal(payload.basket.trendCutoff, '2026-05-01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runs NEWER than the target are excluded — a payload rebuilt for an old date must not see future data', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    const responsesRoot = buildFixtureTree(root, 'acme.com', [
      ['2026-05-01', 40],
      ['2026-06-15', 60],
      ['2026-07-20', 80],
      ['2026-08-01', 90],
    ]);
    const targetDir = join(responsesRoot, '2026-06-15');
    runCli(targetDir);
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.comparison.runCount, 2, 'only 05-01 and 06-15 predate or equal the target');
    assert.equal(payload.comparison.pair.currDate, '2026-06-15');
    assert.equal(payload.comparison.pair.prevDate, '2026-05-01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a single run (no siblings) still resolves — first-run payload, no crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    const responsesRoot = buildFixtureTree(root, 'acme.com', [['2026-07-20', 80]]);
    const targetDir = join(responsesRoot, '2026-07-20');
    runCli(targetDir);
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.comparison.runCount, 1);
    assert.equal(payload.comparison.pair, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('another domain\'s runs never blend into this one\'s trend', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    buildFixtureTree(root, 'other.com', [['2026-05-01', 10], ['2026-06-01', 20]]);
    const responsesRoot = buildFixtureTree(root, 'acme.com', [['2026-07-20', 80]]);
    const targetDir = join(responsesRoot, '2026-07-20');
    runCli(targetDir);
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.comparison.runCount, 1, 'other.com runs must not count toward acme.com\'s history');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the written payload never carries cost/token/outreach fields — privacy invariant holds through the CLI path too', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    const responsesRoot = buildFixtureTree(root, 'acme.com', [['2026-07-20', 80]]);
    const targetDir = join(responsesRoot, '2026-07-20');
    runCli(targetDir);
    const raw = readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8');

    for (const denied of ['costUsd', 'inputTokens', 'outputTokens', 'sessionCostUsd', 'outreachTemplates', 'extractionSources']) {
      assert.ok(!raw.includes(denied), `deny-listed field "${denied}" leaked into mc-payload.json`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no [lang] arg, resolves from .aeo-tracker.json\'s own "lang" field — no warning, no silent \'en\'', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    writeFileSync(join(root, '.aeo-tracker.json'), JSON.stringify({ brand: 'Acme', domain: 'acme.com', lang: 'ru' }));
    const responsesRoot = buildFixtureTree(root, 'acme.com', [['2026-07-20', 80]]);
    const targetDir = join(responsesRoot, '2026-07-20');
    const r = runCliNoLangArg(targetDir);
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.identity.lang, 'ru', 'config lang must be used when no CLI arg is given');
    assert.ok(!r.stderr.includes('defaulted to'), 'no warning expected when config supplies lang');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no [lang] arg and no config "lang" field, falls back to \'en\' AND warns loudly on stderr — this is the bug flagged 2026-07-11 and hit repeatedly since, made loud instead of silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    // No .aeo-tracker.json at all — the config walker finds nothing.
    const responsesRoot = buildFixtureTree(root, 'acme.com', [['2026-07-20', 80]]);
    const targetDir = join(responsesRoot, '2026-07-20');
    const r = runCliNoLangArg(targetDir);
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.identity.lang, 'en', 'bare fallback stays en when nothing else is given');
    assert.ok(r.stderr.includes('defaulted to'), 'must warn on stderr instead of silently guessing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit CLI [lang] arg always wins over .aeo-tracker.json\'s "lang" — a deliberate one-off override is never silently ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-payload-test-'));
  try {
    writeFileSync(join(root, '.aeo-tracker.json'), JSON.stringify({ brand: 'Acme', domain: 'acme.com', lang: 'ru' }));
    const responsesRoot = buildFixtureTree(root, 'acme.com', [['2026-07-20', 80]]);
    const targetDir = join(responsesRoot, '2026-07-20');
    runCli(targetDir, 'pl');
    const payload = JSON.parse(readFileSync(join(targetDir, 'mc-payload.json'), 'utf-8'));

    assert.equal(payload.identity.lang, 'pl', 'explicit CLI arg overrides config default');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
