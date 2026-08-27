/**
 * E2E — the "No sentiment data this run" panel must state a number it actually
 * measured.
 *
 * The bug this locks (found 2026-08-27, shipped in every report before that):
 * the panel's copy was a static string ending "This run: 0 named cells →
 * nothing to classify", while the CSS gate that decides whether the panel is
 * visible at all counted something else entirely — cells carrying a sentiment
 * LABEL (`data-sentiment-scored` on the grid, styles.css:1778-1783). Two
 * independent computations, one of them hardcoded, so the report could tell a
 * reader "0 named cells" on a run where the brand WAS named. That is the worst
 * class of report defect: not a missing number, a confidently wrong one, in a
 * document a client reads as measurement.
 *
 * Two things are wrong in that sentence and this file pins both:
 *   - the COUNT was a literal, never derived from the run;
 *   - the NOUN was wrong. Sentiment is classified for
 *     `mention === 'yes' || mention === 'src'` (bin/aeo-tracker.js:2864 live
 *     path, :4554 run-manual path) — named OR cited — which is what the
 *     sentiment-view legend in the same report already told the reader. So
 *     "named cells" understated the eligible set on any run with cited-only
 *     cells.
 *
 * Why `--replay` is the right driver: under replay the per-cell classify calls
 * are short-circuited (`sentiment = null`), so a replay report ALWAYS lands in
 * the empty-panel branch with zero API spend — while the `stable` fixture
 * still carries a real named cell. That is exactly the state the old copy got
 * wrong, reproduced offline and for free.
 *
 * MUTATION-SANITY (proven out-of-tree 2026-08-27, repo restored + git-diff
 * re-checked): restoring the hardcoded "This run: 0 named cells" string in
 * lib/report/html.js makes the first test fail — the report claims 0 while the
 * run's own `_summary.json` carries 1 eligible cell.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  reportsDateDir,
  responsesDateDir,
  todayDateString,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };
const DOMAIN = 'testbrand.com';

/** Run the stable replay + render, return { html, summary }. */
function renderStableReport(dir) {
  seedReplayProject(dir, { variant: 'stable' });
  assertExitCode(
    spawnCli(['run', '--replay', '--replay-from=2026-05-13'], { cwd: dir, env: KEYS }),
    0, 'stable replay run should exit 0',
  );
  assertExitCode(
    spawnCli(['report', '--no-open'], { cwd: dir, env: KEYS }),
    0, 'report --no-open should exit 0',
  );
  const today = todayDateString();
  return {
    html: readFileSync(join(reportsDateDir(dir, DOMAIN, today), 'report.html'), 'utf-8'),
    summary: JSON.parse(readFileSync(join(responsesDateDir(dir, DOMAIN, today), '_summary.json'), 'utf-8')),
  };
}

/** Cells eligible for sentiment classification, derived from the run itself —
 *  the same `yes | src` gate the CLI applies before calling the classifier. */
function eligibleCellCount(summary) {
  return (summary.results || []).filter(r => r.mention === 'yes' || r.mention === 'src').length;
}

test('the empty-sentiment panel reports the run\'s OWN eligible-cell count', async () => {
  await withTmpProject('aeo-e2e-sentiment-empty-', (dir) => {
    const { html, summary } = renderStableReport(dir);

    const eligible = eligibleCellCount(summary);
    // Guard the guard: if a future fixture re-record drops every mention, this
    // test would pass vacuously against the old hardcoded "0" and stop
    // discriminating. Fail loudly instead of quietly going blind.
    assert.ok(
      eligible > 0,
      'fixture precondition broken — the stable replay must produce at least one ' +
      'named/cited cell, otherwise this test cannot tell a measured count from the ' +
      'hardcoded 0 it exists to catch',
    );

    const body = html.match(/class="mx-empty-body">([^<]*)</)?.[1];
    assert.ok(body, 'report.html must render the empty-sentiment panel body');

    const stated = Number(body.match(/This run:\s*(\d+)\s+such cell/)?.[1]);
    assert.ok(Number.isFinite(stated), `panel copy must state a measured count, got: "${body}"`);
    assert.equal(
      stated, eligible,
      `the report tells the reader "${stated}" sentiment-eligible cells, but this run's ` +
      `_summary.json carries ${eligible} (mention yes|src). The panel is publishing a ` +
      `number it did not measure.`,
    );
  });
});

test('the panel names the right eligibility rule — named OR cited, not named alone', async () => {
  await withTmpProject('aeo-e2e-sentiment-noun-', (dir) => {
    const { html } = renderStableReport(dir);
    const body = html.match(/class="mx-empty-body">([^<]*)</)?.[1];
    assert.ok(body, 'report.html must render the empty-sentiment panel body');

    assert.match(
      body, /named or cited/i,
      'the panel must state the same eligibility rule the classifier applies and the ' +
      'sentiment legend already shows (named OR cited) — "named" alone understates it',
    );
    assert.doesNotMatch(
      body, /\b0 named cells\b/,
      'the hardcoded "0 named cells" string must not come back',
    );
  });
});

test('the CSS gate attribute and the panel agree about the same run', async () => {
  await withTmpProject('aeo-e2e-sentiment-gate-', (dir) => {
    const { html, summary } = renderStableReport(dir);

    // The grid attribute counts cells that came back WITH a sentiment label.
    // Under replay classification is skipped, so it must be 0 — which is
    // precisely why the panel is visible. The point of this assertion is that
    // the attribute and the panel are two views of one computation, not two
    // independent ones that happened to agree.
    const scored = [...html.matchAll(/data-sentiment-scored="(\d+)"/g)].map(m => Number(m[1]));
    assert.ok(scored.length > 0, 'the matrix grid must carry the data-sentiment-scored gate');
    for (const n of scored) {
      assert.equal(n, 0, 'a replay run classifies no sentiment, so the gate must read 0');
    }

    const labelled = (summary.results || []).filter(r => r.sentiment && r.sentiment.label).length;
    assert.equal(scored[0], labelled,
      'data-sentiment-scored must equal the number of labelled cells in the run');

    // The two numbers are allowed to differ — that IS the interesting state
    // (eligible cells exist, none got a label) and the copy must survive it
    // without claiming zero eligible cells.
    assert.ok(eligibleCellCount(summary) !== labelled,
      'this fixture is meant to exercise the eligible-but-unlabelled branch');
  });
});
