/**
 * E2E — Two-step funnel integrity (R8 in resources/aeo-platform/RULES.md).
 *
 *   P0-17a — README zero-match against canonical commerce-CTA regex.
 *            README is the OSS-discovery surface: it MUST stay free of buy-now /
 *            subscribe / $X/month copy. Positioning words like `paid SaaS` or
 *            cost estimates like `~$0.0008 per cell` are still allowed (R8).
 *
 *   P0-17b — HTML report contains the `<article ... id="mc-bridge">` anchor
 *            (founder decision in resources/aeo-platform/PITFALLS.md entry 6).
 *            The bridge block is where commerce CTAs live; this test pins its
 *            existence so removing it requires an explicit code change.
 *
 * P0-17a is a pure file read — no fixtures, no subprocess. P0-17b runs a
 * stable-fixture replay to generate `report.html`, then greps the rendered
 * output for the anchor ID. Both are belt-and-suspenders for R8.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  reportsDateDir,
  todayDateString,
} from './_helpers.js';

// Canonical commerce-CTA regex per RULES.md R8 (resources/aeo-platform/RULES.md).
// Do NOT loosen — any change here needs founder approval. The very purpose of
// this test is to fail loudly if someone tries to slip commerce copy into
// README.
const COMMERCE_CTA_RE =
  /buy now|subscribe (to|for) \$|sign up for \$|upgrade to (premium|pro)|\$\d+\s*(\/|per)\s*(month|year|mo|yr)|start (free|your) trial|get full access|unlock premium/i;

test('P0-17a — README contains zero matches of the canonical commerce-CTA regex', () => {
  const readmePath = join(REPO_ROOT, 'README.md');
  const text = readFileSync(readmePath, 'utf-8');
  const matches = text.match(new RegExp(COMMERCE_CTA_RE.source, 'gi')) || [];
  assert.equal(
    matches.length, 0,
    `README must not contain commerce CTA copy (R8 in RULES.md). Found: ${JSON.stringify(matches)}`,
  );
});

test('P0-17b — generated HTML report contains the <article id="mc-bridge"> anchor', async () => {
  await withTmpProject('aeo-e2e-funnel-html-', async (dir) => {
    const { domain } = seedReplayProject(dir, { variant: 'stable' });
    // Run the replay; GEMINI key required by buildExtractionProviders even
    // though we don't expect it to be called for un-mentioned cells. Fake key
    // is fine — extractWithTwoModels catches 401s internally (per-cell error
    // path, not whole-run abort).
    const runRes = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: { GEMINI_API_KEY: 'test-key-do-not-use-real' } },
    );
    assertExitCode(runRes, 0, 'stable replay run should exit 0');

    // Now generate the report. We want HTML, so do NOT pass --no-html. We DO
    // pass --no-open so no browser launches inside CI/Docker.
    const reportRes = spawnCli(
      ['report', '--no-open'],
      { cwd: dir, env: { GEMINI_API_KEY: 'test-key-do-not-use-real' } },
      // report can take ~10s due to fetch-heavy auditing modules; bump the
      // timeout above the helper default to be safe under Docker.
    );
    assertExitCode(reportRes, 0, 'report should exit 0 after a successful run');

    // report.html lives under aeo-reports/<today>/report.html
    const today = todayDateString();
    const htmlPath = join(reportsDateDir(dir, domain, today), 'report.html');
    assert.ok(existsSync(htmlPath), `expected report.html at ${htmlPath}`);
    const html = readFileSync(htmlPath, 'utf-8');
    assert.match(
      html, /<article[^>]*\bid="mc-bridge"/,
      'HTML report must contain <article id="mc-bridge"> anchor (PITFALLS entry 6, founder decision).',
    );
  });
});
