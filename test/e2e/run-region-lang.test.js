/**
 * E2E — `run --replay --regions <code> [--lang <code>]` region/language wiring.
 *
 * The geo-context PURE functions (resolveRegionLang / wrapQueryForRegion /
 * parseLangFlag) are unit-tested in geo-context.test.js. What was UNCOVERED is
 * the WIRING through the run loop: that `--regions de --lang de` actually makes
 * the per-cell record carry `region` / `regionLabel` / `lang`, and that the
 * `lang` field is persisted ONLY when the language is non-English
 * (`region && regionLang && regionLang !== 'en'` in the sink, bin/aeo-tracker.js).
 *
 * Replay is the offline driver. Phase-0 verified (manual spike 2026-06-18) that
 * the replay reader `_tryReplay(qi, provider, srcDate, trialSuffix)` keys ONLY
 * on query-index + provider + model + trial — NOT on region — so a regional run
 * replays the SAME fixture files seedReplayProject already stages. No regional
 * fixture is needed and no product code is touched: `--regions de` cells are
 * served offline from `q{n}-openai-gpt-5.json`, the run completes (exit 0), and
 * the only thing under test is the region/lang metadata the sink attaches.
 *
 * The model is `gpt-5` (90k TPM) via seedReplayProject, never `gpt-5-search-api`
 * (6k TPM) which would trip the scheduler's 60s pacing stall (PITFALLS entry 5).
 *
 * MUTATION-SANITY:
 *   - The first test pins `lang === 'de'` on every record. A mutant that makes
 *     `resolveRegionLang` always return 'en' (lib/report/geo-context.js) drops
 *     the field entirely → "every DE-cell carries lang:'de'" RED. Verified
 *     out-of-tree against a /tmp copy of geo-context.js (repo file never edited).
 *   - The byte-identity sibling test asserts the no-`--lang` run carries region
 *     metadata but NO `lang` field. REPRODUCED (2026-06-19, AP-CYCLE-C-E2E
 *     residual): with bin now editable, removing the `&& regionLang !== 'en'`
 *     clause from the sink (bin/aeo-tracker.js ~2686) on an out-of-tree HEAD
 *     copy makes the no-`--lang` regional run persist `lang:'en'` on every cell,
 *     and the sibling test below fails with exactly its assertion message
 *     ("an English-preamble (no --lang) cell must NOT carry a lang field") —
 *     1 pass / 1 fail. The repo file is never edited; the guard is genuinely
 *     load-bearing and this pair locks it.
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
  todayDateString,
} from './_helpers.js';

// Extractor needs OPENAI + GEMINI keys; both fakes are fine — under --replay the
// extractor/sentiment/prose-rank classify calls are short-circuited to empty
// shapes, so no live call is made (the fixtures serve every cell).
const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };

test('run --replay --regions de --lang de tags every cell with region + German lang', async () => {
  await withTmpProject('aeo-e2e-region-lang-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13', '--regions', 'de', '--lang', 'de'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'regional replay run should serve fixtures offline and exit 0');

    const summaryPath = join(dir, 'aeo-responses', todayDateString(), '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    assert.ok(Array.isArray(summary.results) && summary.results.length === 3,
      `expected 3 DE cells, got ${summary.results?.length}`);

    // Every cell must carry the region identity and the localised language. The
    // run loop derives regionLang via resolveRegionLang(region, ['de']) → 'de'
    // and the sink persists `region`, `regionLabel`, and (because de !== en)
    // `lang`. All three are the wiring under test.
    for (const cell of summary.results) {
      assert.equal(cell.region, 'de', 'each record is tagged region=de');
      assert.equal(cell.regionLabel, 'Germany', 'each record carries the German market label');
      assert.equal(cell.lang, 'de',
        'a non-English --lang must be persisted on every regional cell');
    }
  });
});

test('byte-identity sibling — same DE region WITHOUT --lang omits the lang field', async () => {
  await withTmpProject('aeo-e2e-region-nolang-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    // SAME region (de), SAME fixtures, SAME everything — the ONLY difference
    // from the test above is the absence of `--lang`. resolveRegionLang then
    // returns 'en', and the sink's `regionLang !== 'en'` guard must keep the
    // `lang` field OFF the record (lean-JSON convention: English preamble is the
    // default and leaves no trace). This is the discriminating pair for the
    // language gate — region metadata identical, language field present xor absent.
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13', '--regions', 'de'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'regional replay run without --lang should also exit 0');

    const summaryPath = join(dir, 'aeo-responses', todayDateString(), '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    assert.ok(Array.isArray(summary.results) && summary.results.length === 3,
      `expected 3 DE cells, got ${summary.results?.length}`);

    for (const cell of summary.results) {
      // Region identity is still present — only the language localisation differs.
      assert.equal(cell.region, 'de', 'region tag is unchanged without --lang');
      assert.equal(cell.regionLabel, 'Germany', 'region label is unchanged without --lang');
      // The discriminator: default-English preamble leaves no `lang` field.
      assert.ok(!('lang' in cell),
        'an English-preamble (no --lang) cell must NOT carry a lang field');
    }
  });
});
