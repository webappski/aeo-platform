/**
 * E2E — `report` never deletes the reports of other runs.
 *
 * `report` writes aeo-reports/<domain>/<date>/report.{md,html} for the run it
 * renders. It used to ALSO sweep report.{md,html} out of every other date
 * folder (`cleanupStaleReportArtifacts`), so a plain `aeo-platform report
 * --no-open` on 2026-10-28 erased the report.md and report.html of the
 * 2026-10-11 run. The original files were gone; re-rendering them later with
 * `--for-date` gives today's layout, not what was delivered on the day.
 * `--public` was guarded earlier; `--for-date` and the DEFAULT path (no
 * --output, no --public) were not (`--output` never swept). `--for-date <older
 * date>` was the worst of them: the date it renders is an old folder, and the
 * sweep erased the reports of every NEWER date.
 *
 * Three cases, each against a folder of known bytes, byte for byte (sha256):
 *   1. `report --no-open` and 2. `report --html --no-open` — an OLDER date
 *      folder holds a report.md and report.html; both must be on disk after.
 *   3. `report --for-date <OLD_DATE> --no-open` — a NEWER date folder (today)
 *      holds a report.md and report.html; both must be on disk after, and the
 *      report of the date asked for must have been written.
 * A bare existsSync would pass on a file the command rewrote with other bytes;
 * the hash does not.
 *
 * Mutation-sanity (run by hand): put the call back in cmdReport —
 * `if (!args.output && !publicMode) await cleanupStaleReportArtifacts(...)` —
 * all three cases MUST go RED. Put it back on the `--for-date` path only
 * (`if (args.forDate) ...`) — cases 1 and 2 stay green, case 3 MUST go RED.
 * Remove it → green.
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

// Newer run whose delivered reports must survive `report --for-date <OLD_DATE>`.
// Its folder is todayDateString(), which is always later than OLD_DATE. The bytes
// differ from OLD_MD / OLD_HTML on purpose: `--for-date` rewrites the folder of
// OLD_DATE, so only the newer folder can carry bytes the command must not touch.
const NEW_MD = '# Delivered today\n\nThe report of the newest run, as sent, layout of that day.\n';
const NEW_HTML = '<!doctype html><title>delivered today</title><p>layout of the newest run</p>\n';

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

// Two runs on disk (the old one and today's) and the delivered report.md +
// report.html of ONE of them in aeo-reports/<domain>/<deliveredDate>/.
function seedTwoRunsWithDeliveredReports(dir, deliveredDate, md, html) {
  for (const date of [OLD_DATE, todayDateString()]) {
    const dd = responsesDateDir(dir, DOMAIN, date);
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, '_summary.json'), JSON.stringify(summaryFor(date)));
  }
  const deliveredDir = reportsDateDir(dir, DOMAIN, deliveredDate);
  mkdirSync(deliveredDir, { recursive: true });
  const mdPath = join(deliveredDir, 'report.md');
  const htmlPath = join(deliveredDir, 'report.html');
  writeFileSync(mdPath, md);
  writeFileSync(htmlPath, html);
  return { mdPath, htmlPath };
}

for (const args of [['report', '--no-open'], ['report', '--html', '--no-open']]) {
  test(`${args.join(' ')} leaves the report.md and report.html of an earlier run untouched`, async () => {
    await withTmpProject('aeo-e2e-keeps-old-reports-', async (dir) => {
      const { mdPath: oldMd, htmlPath: oldHtml } = seedTwoRunsWithDeliveredReports(dir, OLD_DATE, OLD_MD, OLD_HTML);

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

// The sweep also ran on `--for-date`, with the folder of the date asked for as
// the one to spare — so rendering an OLD run erased the reports of every newer
// date, the ones the user had just received.
test('report --for-date <older date> leaves the report.md and report.html of a newer run untouched', async () => {
  await withTmpProject('aeo-e2e-keeps-newer-reports-', async (dir) => {
    const { mdPath: newMd, htmlPath: newHtml } = seedTwoRunsWithDeliveredReports(dir, todayDateString(), NEW_MD, NEW_HTML);

    const args = ['report', '--for-date', OLD_DATE, '--no-open'];
    const r = spawnCli(args, { cwd: dir, env: KEYS });
    assertExitCode(r, 0, `${args.join(' ')} should exit 0`);

    // The command did render the date it was asked for — the run is not a no-op.
    assert.ok(existsSync(join(reportsDateDir(dir, DOMAIN, OLD_DATE), 'report.md')),
      'report --for-date must still write the report of the date it renders');

    assert.ok(existsSync(newMd), 'report.md of the newer run must still be on disk');
    assert.ok(existsSync(newHtml), 'report.html of the newer run must still be on disk');
    assert.strictEqual(sha256(newMd), sha256Of(NEW_MD), 'report.md of the newer run must be byte-for-byte unchanged');
    assert.strictEqual(sha256(newHtml), sha256Of(NEW_HTML), 'report.html of the newer run must be byte-for-byte unchanged');
    assert.doesNotMatch(r.stdout, /Cleanup: removed/, 'report --for-date must not print a clean-up line: it removes nothing');
  });
});
