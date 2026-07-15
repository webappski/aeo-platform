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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  responsesDateDir,
  legacyResponsesDateDir,
  reportsDateDir,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real', OPENAI_API_KEY: 'test-key-do-not-use-real' };

const DOMAIN = 'testbrand.com';
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
    topCompetitors: [],
    topCanonicalSources: [],
    topDomains: [],
    crawlability: {
      summary: { hasRobots: true, hasLlmsTxt: true, hasSitemap: true, blockedCount: 0 },
    },
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

const OFFLINE_REPORT_FLAGS = [
  '--no-open', '--no-authority', '--no-entity-graph', '--no-page-signals', '--no-pricing',
];

function writeSummary(dir, date, summary, { legacy = false, domain = DOMAIN } = {}) {
  const dateDir = legacy
    ? legacyResponsesDateDir(dir, date)
    : responsesDateDir(dir, domain, date);
  mkdirSync(dateDir, { recursive: true });
  writeFileSync(join(dateDir, '_summary.json'), JSON.stringify(summary));
  return dateDir;
}

// Seed two dated runs (old + new) so "render the OLD one, not the latest" is
// a real, distinguishable assertion.
function seedTwoRuns(dir) {
  for (const [date, score] of [[OLD_DATE, OLD_SCORE], [NEW_DATE, NEW_SCORE]]) {
    const dd = responsesDateDir(dir, DOMAIN, date);
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

test('legacy flat report renders raw response and writes cache back in place without a shadow', async () => {
  await withTmpProject('aeo-e2e-legacy-report-', async (dir) => {
    const date = OLD_DATE;
    const dateDir = writeSummary(dir, date, summaryFor(date, OLD_SCORE), { legacy: true });
    writeFileSync(join(dateDir, 'q1-openai-gpt-5-search-api.json'), JSON.stringify({
      choices: [{ message: { content: 'TestBrand appears in LEGACY_RAW_RESPONSE_SENTINEL full answer text.' } }],
    }));

    const firstOut = join(dir, 'legacy-first.md');
    const first = spawnCli(
      ['report', '--for-date', date, '--output', firstOut, ...OFFLINE_REPORT_FLAGS],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(first, 0, 'flat legacy report should render');
    const firstMarkdown = readFileSync(firstOut, 'utf-8');
    assert.match(firstMarkdown, /LEGACY_RAW_RESPONSE_SENTINEL/,
      'rendered report must use the full raw response from the flat date directory');
    assert.match(firstMarkdown, new RegExp('Raw responses: `aeo-responses/' + date + '/`'),
      'footer must point at the real flat raw-response directory');

    const persisted = JSON.parse(readFileSync(join(dateDir, '_summary.json'), 'utf-8'));
    assert.ok(persisted.regionContext, 'deterministic report cache should persist to the legacy summary');
    assert.ok(!existsSync(join(responsesDateDir(dir, DOMAIN, date), '_summary.json')),
      'report cache persistence must not create a namespaced summary-only shadow');

    const secondOut = join(dir, 'legacy-second.md');
    const second = spawnCli(
      ['report', '--for-date', date, '--output', secondOut, ...OFFLINE_REPORT_FLAGS],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(second, 0, 'second flat legacy report should still render');
    assert.match(readFileSync(secondOut, 'utf-8'), /LEGACY_RAW_RESPONSE_SENTINEL/,
      'second render must still see the flat raw response after cache write-back');
  });
});

test('same date in both layouts uses the namespaced snapshot', async () => {
  await withTmpProject('aeo-e2e-legacy-precedence-', async (dir) => {
    writeSummary(dir, OLD_DATE, summaryFor(OLD_DATE, 11), { legacy: true });
    writeSummary(dir, OLD_DATE, summaryFor(OLD_DATE, 77));
    const out = join(dir, 'precedence.md');
    const r = spawnCli(
      ['report', '--for-date', OLD_DATE, '--output', out, ...OFFLINE_REPORT_FLAGS],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'mixed-layout report should render');
    const markdown = readFileSync(out, 'utf-8');
    assert.match(markdown, /"score":\s*77\b/, 'namespaced score must win');
    assert.doesNotMatch(markdown, /"score":\s*11\b/, 'flat duplicate must not blend');
  });
});

test('config-domain mismatch excludes the flat snapshot with an actionable failure', async () => {
  await withTmpProject('aeo-e2e-legacy-mismatch-', async (dir) => {
    const foreign = { ...summaryFor(OLD_DATE, 64), domain: 'otherbrand.com' };
    writeSummary(dir, OLD_DATE, foreign, { legacy: true });
    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({ domain: DOMAIN }));
    const r = spawnCli(['report', ...OFFLINE_REPORT_FLAGS], { cwd: dir, env: KEYS });
    assertExitCode(r, 1, 'foreign legacy snapshot must be excluded');
    assert.match(r.stderr, /No compatible runs found.*Check \.aeo-tracker\.json's domain/s,
      'mismatch-only failure should explain the next check');
  });
});

test('distinct IDN domains never share a legacy snapshot', async () => {
  await withTmpProject('aeo-e2e-idn-legacy-mismatch-', async (dir) => {
    const activeDomain = 'mønchen.de';
    const foreignDomain = 'münchen.de';
    const foreign = {
      ...summaryFor(OLD_DATE, 64),
      brand: 'ForeignBrand',
      domain: foreignDomain,
    };
    writeSummary(dir, OLD_DATE, foreign, { legacy: true });
    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({ domain: activeDomain }));

    const r = spawnCli(['report', ...OFFLINE_REPORT_FLAGS], { cwd: dir, env: KEYS });
    assertExitCode(r, 1, 'a different Punycode identity must exclude the foreign legacy snapshot');
    assert.match(r.stderr, /No compatible runs found.*Check \.aeo-tracker\.json's domain/s,
      'IDN mismatch should fail with the same actionable domain-selection message');
    assert.doesNotMatch(r.stdout + r.stderr, /ForeignBrand/,
      'foreign IDN data must never reach rendering or console output');
  });
});

test('distinct IDN domains use distinct response and report namespaces', async () => {
  await withTmpProject('aeo-e2e-idn-namespaces-', async (dir) => {
    const date = OLD_DATE;
    const domainA = 'mønchen.de';
    const domainB = 'münchen.de';
    const responseA = responsesDateDir(dir, domainA, date);
    const responseB = responsesDateDir(dir, domainB, date);

    assert.equal(responseA, join(dir, 'aeo-responses', 'xn--mnchen-bya.de', date));
    assert.equal(responseB, join(dir, 'aeo-responses', 'xn--mnchen-3ya.de', date));
    assert.notEqual(responseA, responseB, 'Punycode namespaces must be collision-free for these IDNs');

    writeSummary(dir, date, {
      ...summaryFor(date, 41), brand: 'NordicA', domain: domainA,
    }, { domain: domainA });
    writeSummary(dir, date, {
      ...summaryFor(date, 72), brand: 'NordicB', domain: domainB,
    }, { domain: domainB });

    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({ domain: domainA }));
    const first = spawnCli(
      ['report', '--for-date', date, '--no-html', ...OFFLINE_REPORT_FLAGS],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(first, 0, 'first IDN namespace should render independently');
    const reportA = join(reportsDateDir(dir, domainA, date), 'report.md');
    assert.match(readFileSync(reportA, 'utf-8'), /"brand":\s*"NordicA"/);
    assert.doesNotMatch(readFileSync(reportA, 'utf-8'), /NordicB/);

    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({ domain: domainB }));
    const second = spawnCli(
      ['report', '--for-date', date, '--no-html', ...OFFLINE_REPORT_FLAGS],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(second, 0, 'second IDN namespace should render independently');
    const reportB = join(reportsDateDir(dir, domainB, date), 'report.md');
    assert.notEqual(reportA, reportB, 'report namespaces must remain distinct too');
    assert.match(readFileSync(reportB, 'utf-8'), /"brand":\s*"NordicB"/);
    assert.doesNotMatch(readFileSync(reportB, 'utf-8'), /NordicA/);
    assert.ok(existsSync(reportA) && existsSync(reportB),
      'rendering the second IDN must not overwrite or sweep the first report');
  });
});

test('malformed flat summary does not hide valid namespaced data; mixed legacy domains fail loudly', async () => {
  await withTmpProject('aeo-e2e-legacy-domain-safety-', async (dir) => {
    const malformedDir = legacyResponsesDateDir(dir, OLD_DATE);
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, '_summary.json'), '{broken json');
    writeSummary(dir, NEW_DATE, summaryFor(NEW_DATE, NEW_SCORE));
    const out = join(dir, 'valid-namespaced.md');
    const valid = spawnCli(['report', '--output', out, ...OFFLINE_REPORT_FLAGS], { cwd: dir, env: KEYS });
    assertExitCode(valid, 0, 'valid namespace must survive a malformed flat sibling');
    assert.match(readFileSync(out, 'utf-8'), new RegExp(`"score":\\s*${NEW_SCORE}\\b`));
  });

  await withTmpProject('aeo-e2e-legacy-ambiguous-', async (dir) => {
    writeSummary(dir, OLD_DATE, summaryFor(OLD_DATE, OLD_SCORE), { legacy: true });
    writeSummary(dir, NEW_DATE, { ...summaryFor(NEW_DATE, NEW_SCORE), domain: 'otherbrand.com' }, { legacy: true });
    const r = spawnCli(['report', ...OFFLINE_REPORT_FLAGS], { cwd: dir, env: KEYS });
    assertExitCode(r, 1, 'no-config mixed legacy domains must not blend');
    assert.match(r.stderr, /Multiple domains found/, 'ambiguity should be explicit');
  });
});
