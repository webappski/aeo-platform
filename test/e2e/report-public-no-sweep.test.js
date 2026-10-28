/**
 * E2E — `report --public` does NOT delete older aeo-reports/<date>/ artifacts.
 *
 * A hosted proof timeline is a SET of dated reports (April / May / … each its
 * own aeo-reports/<date>/report.html). `report` used to sweep report.{md,html}
 * out of every date dir except the one being written, which erased exactly
 * those historical renders; `--public` (proof-archive mode) was the first path
 * to skip the sweep. The sweep is gone from every path now; the default path is
 * pinned by report-keeps-older-reports.test.js. This file keeps the `--public`
 * path pinned on its own: the archive must survive a regen.
 *
 * NOT A LEAK TEST, despite the company it keeps. Its two assertions are
 * `existsSync` and one stdout regex — it never reads a rendered
 * report, so no denylist and no fixture enrichment changes anything it proves.
 * It was grouped with the two leak E2Es in the AP-LEAKTEST-BLIND-FIXTURES card
 * (2026-09-20) and deliberately left alone when that card was closed: a content
 * assertion here would only duplicate report-public-leakfree. Read it as a test
 * of FILE BEHAVIOUR under `--public`, not as a third line of leak defence.
 *
 * Pure file-write + subprocess; no network, no live API, no product test hooks.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  responsesDateDir,
  reportsDateDir,
  todayDateString,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real', OPENAI_API_KEY: 'test-key-do-not-use-real' };

const DOMAIN = 'testbrand.com';

// A date in the past, distinct from today, that carries a pre-existing proof
// report we must not lose. Hard-coded date (not relative) is fine: it only has
// to differ from todayDateString(), which it always will.
const ARCHIVE_DATE = '2026-04-23';

function summaryFor(date) {
  return {
    date,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    score: 50,
    total: 1,
    results: [
      {
        query: 'Q1', queryText: 'best test brands 2026', provider: 'openai', label: 'ChatGPT',
        model: 'gpt-5-search-api', mode: 'web', mention: 'yes', position: 1, citationCount: 1,
        canonicalCitations: ['testbrand.com'], competitors: [], competitorsUnverified: [],
        responseQuality: 'ok', hasBrandInCitations: true, responseExcerpt: 'TestBrand is great.',
        elapsedMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.0,
      },
    ],
  };
}

// Seed: a TODAY run (what `report` will render to aeo-reports/<today>/) plus a
// pre-existing PROOF report under aeo-reports/<ARCHIVE_DATE>/report.html that
// must still be there afterwards.
function seedTodayRunPlusArchivedReport(dir) {
  const today = todayDateString();
  const dd = responsesDateDir(dir, DOMAIN, today);
  mkdirSync(dd, { recursive: true });
  writeFileSync(join(dd, '_summary.json'), JSON.stringify(summaryFor(today)));

  const archiveDir = reportsDateDir(dir, DOMAIN, ARCHIVE_DATE);
  mkdirSync(archiveDir, { recursive: true });
  const archiveReport = join(archiveDir, 'report.html');
  writeFileSync(archiveReport, '<!doctype html><title>archived proof 2026-04-23</title>');
  return { today, archiveReport };
}

test('report --public preserves an older aeo-reports/<date>/report.html (no sweep)', async () => {
  await withTmpProject('aeo-e2e-public-nosweep-', async (dir) => {
    const { archiveReport } = seedTodayRunPlusArchivedReport(dir);

    const r = spawnCli(['report', '--public', '--no-open'], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report --public should exit 0');

    assert.ok(existsSync(archiveReport),
      'report --public must NOT delete the archived proof report (proof-archive mode skips the sweep)');
    // And the sweep summary line must not claim it removed anything.
    assert.doesNotMatch(r.stdout, /Cleanup: removed \d+ stale report/,
      '--public must not run the stale-artifact cleanup at all');
  });
});
