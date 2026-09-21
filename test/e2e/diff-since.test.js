/**
 * E2E — FC-03: `diff --since <date>` resolves the LATEST run on disk.
 *
 * Why this file exists. `diff A B` (covered by P0-15) is told both ends.
 * `--since` is told one, and picks the other itself:
 *
 *   dateA = args.since
 *   dateB = allDates[allDates.length - 1]      // bin/aeo-tracker.js
 *
 * That selector is the whole surface. `diff` exists to answer "what changed",
 * so a wrong pick does not fail — it reports a real delta between the wrong
 * pair, and a regression can read as an improvement. `allDates` is also a MERGE
 * of two trees (the domain-namespaced one and the legacy flat one, filtered by
 * domain), so "latest" is not simply "the newest directory here".
 *
 * THE FIXTURE HAS TO DISCRIMINATE. With two runs staged, "latest" and "the run
 * after A" are the same directory, and a test would pass against a selector
 * that picked either. So three runs are staged, with the middle one scoring the
 * same as the first:
 *
 *   2026-01-13  40%   ← --since anchors here
 *   2026-01-14  40%   ← picking this yields 0pp
 *   2026-01-15  50%   ← picking this yields +10pp   (correct)
 *
 * Both the delta and the "To:" line therefore separate right from wrong, and
 * the second test asserts the contrasting pair explicitly so the numbers are
 * shown to discriminate rather than assumed to.
 *
 * Summaries are copied from the same `test/fixtures/diff-pair/` that P0-15
 * uses, with ONLY the `date` field moved. Scores and counts are left exactly as
 * the fixture wrote them: editing a score by hand desynchronises it from the
 * mentions/total printed beside it, and a fixture that contradicts itself
 * teaches the test nothing.
 *
 * MUTATION-SANITY (verified RED before commit): change the `--since` branch to
 * `allDates[allDates.indexOf(args.since) + 1]` — the plausible off-by-one — and
 * the first test fails on both the "To:" date and the delta.
 *
 * `diff` reads `_summary.json` only: no raw responses, no network, no cost.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject, spawnCli, assertExitCode, legacyResponsesDateDir, FIXTURE_ROOT,
} from './_helpers.js';

/** date → which fixture summary it carries. Order matters: see the header. */
const RUNS = [
  ['2026-01-13', 'yesterday-summary.json'],
  ['2026-01-14', 'yesterday-summary.json'],
  ['2026-01-15', 'today-summary.json'],
];

function seedThreeRuns(dir) {
  const src = join(FIXTURE_ROOT, 'diff-pair');
  for (const [date, file] of RUNS) {
    const destDir = legacyResponsesDateDir(dir, date);
    mkdirSync(destDir, { recursive: true });
    const summary = JSON.parse(readFileSync(join(src, file), 'utf-8'));
    summary.date = date;
    writeFileSync(join(destDir, '_summary.json'), JSON.stringify(summary, null, 2));
  }
}

test('FC-03 — diff --since anchors on the given date and compares against the LATEST run', async () => {
  await withTmpProject('aeo-e2e-diff-since-', (dir) => {
    seedThreeRuns(dir);
    const r = spawnCli(['diff', '--since', '2026-01-13'], { cwd: dir });
    assertExitCode(r, 0, 'diff --since against an existing date should exit 0');

    assert.match(r.stdout, /From:\s+2026-01-13/,
      '--since must anchor the FROM end on the date it was given');
    assert.match(r.stdout, /To:\s+2026-01-15/,
      '--since must resolve the TO end to the latest run on disk, not the next one after A');
    assert.doesNotMatch(r.stdout, /To:\s+2026-01-14/,
      'picking the middle run is the off-by-one this test exists to catch');
    assert.match(r.stdout, /Score delta:\s*\+10pp/,
      'delta must be computed against the latest run (40% → 50%), not the middle one');
  });
});

test('FC-03 — the staged runs genuinely discriminate: the wrong pair reports a different delta', async () => {
  // Without this, the assertions above could be passing on a fixture where
  // every pair happens to yield the same numbers — the failure mode where a
  // test is green because nothing it looks at can vary.
  await withTmpProject('aeo-e2e-diff-since-control-', (dir) => {
    seedThreeRuns(dir);
    const r = spawnCli(['diff', '2026-01-13', '2026-01-14'], { cwd: dir });
    assertExitCode(r, 0, 'positional diff over the same staged runs should exit 0');
    assert.match(r.stdout, /To:\s+2026-01-14/);
    assert.match(r.stdout, /Score delta:\s*0pp/,
      'the middle pair must read 0pp — this is what makes +10pp above meaningful');
  });
});

test('FC-03 — a --since date with no run fails loudly and names the dates that do exist', async () => {
  await withTmpProject('aeo-e2e-diff-since-missing-', (dir) => {
    seedThreeRuns(dir);
    const r = spawnCli(['diff', '--since', '2026-01-01'], { cwd: dir });
    assertExitCode(r, 1, 'an unknown --since date must exit 1, not diff against something else');
    assert.match(r.stderr, /No run found for:\s*2026-01-01/,
      'the error must name the date that was not found');
    for (const [date] of RUNS) {
      assert.ok(
        r.stderr.includes(date),
        `the error must list ${date} so the operator can pick a real one`,
      );
    }
  });
});
