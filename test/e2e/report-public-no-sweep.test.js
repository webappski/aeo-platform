/**
 * E2E — `report --public` does NOT sweep older aeo-reports/<date>/ artifacts.
 *
 * The default `report` (writing to the default location) runs
 * `cleanupStaleReportArtifacts`, which deletes report.{md,html} from EVERY date
 * dir except the one being written — a layout-rewrite hygiene step. But a hosted
 * proof timeline is a SET of dated reports (April / May / … each its own
 * aeo-reports/<date>/report.html). The default sweep erased exactly those
 * historical renders. `--public` is proof-archive mode and must SKIP the sweep
 * so the archive survives a regen.
 *
 * TWO-SIDED on purpose: an "old report survives under --public" assertion alone
 * would false-pass if the sweep silently stopped running in BOTH modes (the file
 * would survive regardless). So we also assert the old report IS deleted in the
 * DEFAULT mode — proving the sweep still has teeth and `--public` is what spares
 * it.
 *
 * Mutation-sanity (run by hand to confirm teeth): change the guard back to
 * `if (!args.output)` (drop `&& !args.public`) — the "survives under --public"
 * test MUST go RED. Restore → green.
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
// pre-existing PROOF report under aeo-reports/<ARCHIVE_DATE>/report.html that the
// sweep would normally delete.
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

test('default report (no --public) DOES sweep the older aeo-reports/<date>/report.html', async () => {
  await withTmpProject('aeo-e2e-default-sweep-', async (dir) => {
    const { archiveReport } = seedTodayRunPlusArchivedReport(dir);

    const r = spawnCli(['report', '--no-open'], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'default report should exit 0');

    assert.ok(!existsSync(archiveReport),
      'default report SHOULD sweep the older report.html (proves the sweep still has teeth; --public is what spares it)');
  });
});
