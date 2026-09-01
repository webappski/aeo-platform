/**
 * E2E — the identity-links ("Fixable in one line") sameAs alert card,
 * end to end through the real CLI process and a real report.html file.
 *
 * Regression for two defects the founder's own webappski.com report
 * surfaced (root cause + both fixes in CHANGELOG.md "identity-links"
 * entry): (1) the html.js render call site compared an edge's kebab-case
 * `status` against camelCase literals that could never match, collapsing
 * `one-way`/`broken-link` into the generic "Not verified" label; (2) the
 * `broken` bucket driving the headline count, body copy, and "fix this"
 * code sample counted `verified-host` edges (a POSITIVE reciprocityRate
 * signal for auth-walled platforms like LinkedIn) as broken.
 *
 * `test/entity-graph.test.js` already pins `describeEdgeStatus()` as a pure
 * function, and `test/html-render-smoke.js` already pins `renderHtml()`
 * directly. This file closes the remaining gap: nothing previously exercised
 * the ACTUAL CLI path (`report` command reading a persisted `_summary.json`
 * and writing a real `report.html`) for this card at all.
 *
 * Fully offline — no live network. `report`'s entity-graph check
 * (bin/aeo-tracker.js) only calls `checkEntityGraph()` when
 * `!latest.entityGraph`; seeding `_summary.json` with a synthetic
 * `entityGraph` before running `report` makes the CLI use exactly that data.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  responsesDateDir,
  reportsDateDir,
  todayDateString,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };
const DOMAIN = 'testbrand.com';

const SYNTHETIC_ENTITY_GRAPH = {
  sameAsCount: 4,
  edges: [
    { url: 'https://github.com/acme', platform: 'github', host: 'github.com', status: 'reciprocates', httpStatus: 200, error: null },
    { url: 'https://www.linkedin.com/company/acme/', platform: 'linkedin', host: 'linkedin.com', status: 'verified-host', httpStatus: null, error: null },
    { url: 'https://www.youtube.com/channel/acme', platform: 'youtube', host: 'youtube.com', status: 'one-way', httpStatus: 200, error: null },
    { url: 'https://www.g2.com/sellers/acme', platform: 'g2', host: 'g2.com', status: 'unreachable', httpStatus: 403, error: 'HTTP 403' },
  ],
  summary: { reciprocates: 1, oneWay: 1, unreachable: 1, verifiedHost: 1, brokenLink: 0, reciprocityRate: 50 },
};

// Runs a stable replay, then splices a synthetic entityGraph into the
// _summary.json the run just wrote — BEFORE `report` reads it — so the
// report command uses this fixture instead of live-fetching one.
function seedRunWithEntityGraph(dir) {
  const r = spawnCli(['run', '--replay', '--replay-from=2026-05-13'], { cwd: dir, env: KEYS });
  assertExitCode(r, 0, 'stable replay should exit 0');

  const today = todayDateString();
  const summaryPath = join(responsesDateDir(dir, DOMAIN, today), '_summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
  summary.entityGraph = SYNTHETIC_ENTITY_GRAPH;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

test('E2E — identity-links card counts verified-host as resolved, not broken, in a real report.html', async () => {
  await withTmpProject('aeo-e2e-identity-links-', async (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    seedRunWithEntityGraph(dir);

    const r = spawnCli(['report', '--no-open'], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report --no-open should exit 0');

    const today = todayDateString();
    const htmlPath = join(reportsDateDir(dir, DOMAIN, today), 'report.html');
    const html = readFileSync(htmlPath, 'utf-8');

    const idx = html.indexOf('Fixable in one line');
    assert.ok(idx !== -1, 'identity-links alert card did not render in the real report.html');
    const card = html.slice(idx, idx + 2000);

    // 2 genuinely broken edges (one-way + unreachable) out of 4 — NOT 3.
    // The pre-fix headline would have read "3 of your 4 identity links do
    // not resolve", wrongly counting the verified-host LinkedIn edge.
    assert.match(card, /2 of your 4 identity links do not resolve/,
      `headline miscounted verified-host as broken in the real rendered file: ${card.slice(0, 200)}`);

    // No raw internal status string leaked into the client-facing sentence.
    const bodyEnd = card.indexOf('lr-alert-code');
    assert.ok(!/verified-host/.test(card.slice(0, bodyEnd)),
      'raw "verified-host" status leaked into the client-facing sentence in the real rendered file');

    // The "fix this" sameAs code sample must never target the verified,
    // working LinkedIn page — it must point at a genuinely broken edge.
    assert.ok(!/lr-alert-code">"sameAs": \["https:\/\/www\.linkedin\.com/.test(card),
      'code sample told the client to "fix" a verified, working LinkedIn page in the real rendered file');
    assert.ok(/lr-alert-code">"sameAs": \["https:\/\/www\.youtube\.com/.test(card),
      'code sample should target the first genuinely broken edge (YouTube, one-way)');

    // Every tile carries a distinct worded label with the correct tone —
    // 'verified-host' must not collapse into "Not verified"/warn.
    assert.match(card, /<span class="lr-pill" data-tone="good">Reciprocates<\/span>/);
    assert.match(card, /<span class="lr-pill" data-tone="good">Verified host<\/span>/);
    assert.match(card, /<span class="lr-pill" data-tone="warn">One-way<\/span>/);
    assert.match(card, /<span class="lr-pill" data-tone="bad">Unreachable<\/span>/);
  });
});
