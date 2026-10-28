/**
 * E2E — `report` never deletes the reports of earlier runs.
 *
 * `report` writes aeo-reports/<domain>/<date>/report.{md,html} for the run it
 * renders. It used to ALSO sweep report.{md,html} out of every other date
 * folder (`cleanupStaleReportArtifacts`), so a plain `aeo-platform report
 * --no-open` on 2026-10-28 erased the report.md and report.html of the
 * 2026-10-11 run. The original files were gone; re-rendering them later with
 * `--for-date` gives today's layout, not what was delivered on the day.
 * `--public` and `--for-date` were guarded earlier; the DEFAULT path (no
 * --output, no --public) was not, and it is the path a user takes every week.
 *
 * Pins the exact path: default `report` and `report --html`, with an older
 * date folder holding a report.md and report.html of known bytes. Both must be
 * on disk, byte for byte (sha256), after the command. A bare existsSync would
 * pass on a file the command rewrote with other bytes; the hash does not.
 *
 * Mutation-sanity (run by hand): put the call back in cmdReport —
 * `if (!args.output && !publicMode) await cleanupStaleReportArtifacts(...)` —
 * both tests MUST go RED. Remove it → green.
 *
 * Pure file-write + subprocess; no network, no live API, no product test hooks.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

// Earlier run whose delivered reports must survive. Hard-coded: it only has to
// differ from todayDateString(), which it always will.
const OLD_DATE = '2026-10-11';
const OLD_MD = '# Delivered 2026-10-11\n\nThe report as sent to the client, layout of that day.\n';
const OLD_HTML = '<!doctype html><title>delivered 2026-10-11</title><p>layout of that day</p>\n';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256Of = (text) => createHash('sha256').update(text).digest('hex');

function summaryFor(date) {
  return {
    date,
    brand: 'TestBrand',
    domain: DOMAIN,
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

// Two runs on disk (the old one and today's) and the old run's delivered
// report.md + report.html in aeo-reports/<domain>/<OLD_DATE>/.
function seedTwoRunsWithOldDeliveredReports(dir) {
  for (const date of [OLD_DATE, todayDateString()]) {
    const dd = responsesDateDir(dir, DOMAIN, date);
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, '_summary.json'), JSON.stringify(summaryFor(date)));
  }
  const oldDir = reportsDateDir(dir, DOMAIN, OLD_DATE);
  mkdirSync(oldDir, { recursive: true });
  const oldMd = join(oldDir, 'report.md');
  const oldHtml = join(oldDir, 'report.html');
  writeFileSync(oldMd, OLD_MD);
  writeFileSync(oldHtml, OLD_HTML);
  return { oldMd, oldHtml };
}

for (const args of [['report', '--no-open'], ['report', '--html', '--no-open']]) {
  test(`${args.join(' ')} leaves the report.md and report.html of an earlier run untouched`, async () => {
    await withTmpProject('aeo-e2e-keeps-old-reports-', async (dir) => {
      const { oldMd, oldHtml } = seedTwoRunsWithOldDeliveredReports(dir);

      const r = spawnCli(args, { cwd: dir, env: KEYS });
      assertExitCode(r, 0, `${args.join(' ')} should exit 0`);

      // The command did write today's report — the run is not a no-op.
      assert.ok(existsSync(join(reportsDateDir(dir, DOMAIN, todayDateString()), 'report.md')),
        'report must still write the report of the run it renders');

      assert.ok(existsSync(oldMd), 'report.md of the earlier run must still be on disk');
      assert.ok(existsSync(oldHtml), 'report.html of the earlier run must still be on disk');
      assert.strictEqual(sha256(oldMd), sha256Of(OLD_MD), 'report.md of the earlier run must be byte-for-byte unchanged');
      assert.strictEqual(sha256(oldHtml), sha256Of(OLD_HTML), 'report.html of the earlier run must be byte-for-byte unchanged');
      assert.doesNotMatch(r.stdout, /Cleanup: removed/, 'report must not print a clean-up line: it removes nothing');
    });
  });
}
