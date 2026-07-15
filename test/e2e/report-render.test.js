/**
 * E2E — `report` output formats and toggles.
 *
 *   P0-10 — default flags → both report.md AND report.html are written;
 *           report.html contains the bento (`class="bento"`) grid AND the
 *           mc-bridge anchor (`<article ... id="mc-bridge">`).
 *   P0-11 — `report --no-html --no-mc-block --no-open` → report.md exists,
 *           report.html does NOT exist, and markdown omits the MC block.
 *   P0-12 — `report --no-html --no-open` → report.md exists with brand
 *           content; report.html absent. (Markdown-only CI flow.)
 *
 * Tests use stable replay (positive score) so the report has data to render.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  reportsDateDir,
  todayDateString,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };
const DOMAIN = 'testbrand.com';

function runStableReplay(dir) {
  const r = spawnCli(
    ['run', '--replay', '--replay-from=2026-05-13'],
    { cwd: dir, env: KEYS },
  );
  assertExitCode(r, 0, 'stable replay should exit 0');
}

test('P0-10 — default report writes md+html, HTML has bento + mc-bridge anchors', async () => {
  await withTmpProject('aeo-e2e-report-default-', async (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    runStableReplay(dir);
    const r = spawnCli(['report', '--no-open'], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report --no-open should exit 0');

    const today = todayDateString();
    const mdPath = join(reportsDateDir(dir, DOMAIN, today), 'report.md');
    const htmlPath = join(reportsDateDir(dir, DOMAIN, today), 'report.html');
    assert.ok(existsSync(mdPath), `report.md missing at ${mdPath}`);
    assert.ok(existsSync(htmlPath), `report.html missing at ${htmlPath}`);
    const html = readFileSync(htmlPath, 'utf-8');
    assert.match(html, /<section[^>]*class="bento"/, 'HTML must use bento layout');
    assert.match(html, /<article[^>]*\bid="mc-bridge"/, 'HTML must contain mc-bridge anchor');
  });
});

test('P0-11 — report --no-html --no-mc-block → only md, MC block suppressed', async () => {
  await withTmpProject('aeo-e2e-report-no-mc-', async (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    runStableReplay(dir);
    const r = spawnCli(
      ['report', '--no-html', '--no-mc-block', '--no-open'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'report --no-html --no-mc-block --no-open should exit 0');

    const today = todayDateString();
    const mdPath = join(reportsDateDir(dir, DOMAIN, today), 'report.md');
    const htmlPath = join(reportsDateDir(dir, DOMAIN, today), 'report.html');
    assert.ok(existsSync(mdPath), `report.md missing at ${mdPath}`);
    assert.ok(!existsSync(htmlPath), `report.html should be absent under --no-html`);
    const md = readFileSync(mdPath, 'utf-8');
    assert.doesNotMatch(
      md, /Mission Control|mc-bridge/i,
      '--no-mc-block must keep MC bridge text out of markdown',
    );
  });
});

test('P0-12 — report --no-html writes a non-empty markdown report, no HTML', async () => {
  await withTmpProject('aeo-e2e-report-md-only-', async (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    runStableReplay(dir);
    const r = spawnCli(
      ['report', '--no-html', '--no-open'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'report --no-html --no-open should exit 0');

    const today = todayDateString();
    const mdPath = join(reportsDateDir(dir, DOMAIN, today), 'report.md');
    const htmlPath = join(reportsDateDir(dir, DOMAIN, today), 'report.html');
    assert.ok(existsSync(mdPath), `report.md missing at ${mdPath}`);
    assert.ok(!existsSync(htmlPath), 'report.html should be absent under --no-html');
    const md = readFileSync(mdPath, 'utf-8');
    assert.match(md, /TestBrand/, 'markdown report must mention the brand');
    assert.ok(md.trim().length > 200, 'markdown report should not be a stub');
  });
});
