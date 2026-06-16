/**
 * E2E — `report --for-date <YYYY-MM-DD>` renders a SPECIFIC historical run.
 *
 * Default `report` renders the newest run on disk. `--for-date` re-points the
 * whole report at an older `aeo-responses/<date>/_summary.json` so a dated proof
 * report (an April / May snapshot hosted as a proof page) can be regenerated
 * from data still on disk. Precedent: the historical TypelessForm renders
 * (23 Apr / 13 May / 18 May / 25 May) had to be rebuilt from their existing
 * `_summary.json` files — the tool had no way to address an old run.
 *
 * Acceptance (from the founder brief):
 *   - rendering a specific past date produces a report carrying THAT date's
 *     score, NOT the newest run's score;
 *   - an invalid / absent date → exit 1 with a clear message + the list of
 *     available dates (never-fail bar — the user is told what they CAN ask for).
 *
 * TWO-SIDED on purpose: the OLD-date assertion fails if `--for-date` were
 * ignored (the report would carry the NEWEST score instead). We seed two runs
 * with DELIBERATELY DIFFERENT scores (old=58, new=83) so the two are
 * distinguishable — if the score were the same, an ignored flag would false-pass.
 *
 * Mutation-sanity (run by hand to confirm teeth): in cmdReport, drop the
 * `latest = snapshots[idx]` reassignment inside the `--for-date` block (so it
 * keeps the newest snapshot) — the OLD-date test MUST go RED (it would render
 * 83 instead of 58). Restore → green.
 *
 * Pure file-write + subprocess; no network, no live API, no product test hooks.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real', OPENAI_API_KEY: 'test-key-do-not-use-real' };

const OLD_DATE = '2026-05-25';
const NEW_DATE = '2026-06-11';
const OLD_SCORE = 58;
const NEW_SCORE = 83;

// Minimal valid summary the report renderer accepts. One result cell is enough
// for the headline score + trend; mirrors the real _summary.json shape.
function summaryFor(date, score) {
  return {
    date,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    score,
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

// Seed two dated runs (old + new) so "render the OLD one, not the latest" is
// a real, distinguishable assertion.
function seedTwoRuns(dir) {
  for (const [date, score] of [[OLD_DATE, OLD_SCORE], [NEW_DATE, NEW_SCORE]]) {
    const dd = join(dir, 'aeo-responses', date);
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, '_summary.json'), JSON.stringify(summaryFor(date, score)));
  }
}

test('report --for-date renders the chosen historical run (its score), not the newest run', async () => {
  await withTmpProject('aeo-e2e-fordate-old-', async (dir) => {
    seedTwoRuns(dir);

    // Write to an explicit output path so this test never touches the default
    // aeo-reports/ sweep behaviour (that is the separate sweep-skip test).
    const out = join(dir, 'out-0525.md');
    const r = spawnCli(['report', '--for-date', OLD_DATE, '--no-open', '--output', out], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report --for-date <valid past date> should exit 0');

    // The console headline must reflect the OLD run, not the newest. (The flag
    // also renames the label from "Latest score" to "<date> score".)
    assert.match(r.stdout, new RegExp(`${OLD_DATE} score:\\s*\\x1b?\\[?[0-9;]*m?${OLD_SCORE}%`),
      `console headline should report the ${OLD_DATE} score (${OLD_SCORE}%); stdout was:\n${r.stdout}`);

    // Assert the RENDERED ARTIFACT, not just the console. The markdown report is
    // deterministic (the HTML embeds base64 fonts where "58"/"83" appear as
    // byte-noise, so an HTML substring match is unreliable). The MD title and
    // the embedded machine block both carry the chosen run.
    const md = readFileSync(out, 'utf-8');
    assert.match(md, new RegExp(`^#\\s+\\S*\\s*${OLD_SCORE}%\\s*·\\s*AEO Report`, 'm'),
      `report title should carry the chosen run's score (${OLD_SCORE}%)`);
    assert.match(md, new RegExp(`"score":\\s*${OLD_SCORE}\\b`),
      `embedded machine block should record score ${OLD_SCORE}`);
    assert.match(md, new RegExp(`"runDate":\\s*"${OLD_DATE}"`),
      `embedded machine block should record runDate ${OLD_DATE}`);
    // The trend is truncated to the chosen date inclusive — it must NOT plot the
    // newer run that came after it.
    assert.match(md, new RegExp(`"trendCutoff":\\s*"${OLD_DATE}"`),
      `trend must be truncated to ${OLD_DATE} (an old report must not plot newer data)`);

    // Mutation-anchor: an ignored --for-date would render the NEWEST run instead
    // (title "83%", runDate 2026-06-11). These guard that exact regression.
    assert.doesNotMatch(r.stdout, new RegExp(`Latest score:.*${NEW_SCORE}%`),
      'with --for-date the headline must not fall back to the newest "Latest score"');
    assert.doesNotMatch(md, new RegExp(`"runDate":\\s*"${NEW_DATE}"`),
      `the report must be the ${OLD_DATE} run, never the newest ${NEW_DATE} run`);
    assert.doesNotMatch(md, new RegExp(`"score":\\s*${NEW_SCORE}\\b`),
      `the report score must be ${OLD_SCORE}, never the newest ${NEW_SCORE}`);
  });
});

test('report --for-date with an absent date exits 1 and lists available dates', async () => {
  await withTmpProject('aeo-e2e-fordate-absent-', async (dir) => {
    seedTwoRuns(dir);

    const r = spawnCli(['report', '--for-date', '2024-01-01', '--no-open'], { cwd: dir, env: KEYS });
    assertExitCode(r, 1, 'absent --for-date should exit 1');
    assert.match(r.stderr, /No run found for 2024-01-01/, 'should name the missing date');
    assert.match(r.stderr, new RegExp(`Available dates:.*${OLD_DATE}.*${NEW_DATE}`),
      'should list the available run dates so the user can correct the request');
  });
});

test('report --for-date with a malformed date exits 1 with a format hint', async () => {
  await withTmpProject('aeo-e2e-fordate-malformed-', async (dir) => {
    seedTwoRuns(dir);

    const r = spawnCli(['report', '--for-date', '2026-5-1', '--no-open'], { cwd: dir, env: KEYS });
    assertExitCode(r, 1, 'malformed --for-date should exit 1');
    assert.match(r.stderr, /--for-date must be YYYY-MM-DD/, 'should explain the expected format');
    assert.match(r.stderr, new RegExp(`Available dates:.*${OLD_DATE}`),
      'should still list available dates on a format error');
  });
});
