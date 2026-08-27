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
  responsesDateDir,
  todayDateString,
} from './_helpers.js';

const DOMAIN = 'testbrand.com';

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

    const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
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

    const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
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

/**
 * ── MULTI-language branch (added 2026-08-27 with the pl/at/ch region axis) ──
 *
 * Everything above drives the `langs.length === 1` path, which short-circuits
 * in `resolveRegionLang` BEFORE `REGION_NATIVE_LANG` is ever consulted. So the
 * whole per-region native-language map was uncovered at CLI level, and the two
 * tests above would stay green even if it were empty.
 *
 * This is the shape the PL/DACH beachhead actually runs: several markets, more
 * than one language, each cell expected in the language its market speaks.
 * `--lang pl,de` in THAT order is the discriminating choice — a region missing
 * from `REGION_NATIVE_LANG` falls through to `langs[0]` = 'pl', so a broken
 * build asks the AUSTRIAN and SWISS cells in Polish while still exiting 0 and
 * still tagging the regions correctly. Nothing but the `lang` field shows it.
 *
 * MUTATION-SANITY (proven 2026-08-27, out-of-tree — the repo file was restored
 * and `git diff` re-checked): deleting `at: 'de', ch: 'de'` from
 * REGION_NATIVE_LANG makes the AT/CH assertions below fail with
 * `'pl' !== 'de'`, and the sibling unit guard in test/geo-context.test.js goes
 * RED too (25 passed / 2 failed).
 */
test('multi-lang --regions pl,de,at,ch --lang pl,de asks AT + CH in German, not langs[0]', async () => {
  await withTmpProject('aeo-e2e-region-multilang-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13', '--regions', 'pl,de,at,ch', '--lang', 'pl,de'],
      { cwd: dir, env: KEYS, timeout: 120000 },
    );
    assertExitCode(r, 0, 'multi-region multi-lang replay run should serve fixtures offline and exit 0');

    const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    // 3 queries × 4 regions — the region axis multiplies cells, the language
    // axis does NOT (it is a parameter of the region, by design).
    assert.equal(summary.results.length, 12,
      `expected 3 queries × 4 regions = 12 cells, got ${summary.results?.length}`);

    // market → the language that market is actually asked in.
    const EXPECTED = { pl: 'pl', de: 'de', at: 'de', ch: 'de' };
    const EXPECTED_LABEL = { pl: 'Poland', de: 'Germany', at: 'Austria', ch: 'Switzerland' };
    const seen = new Set();
    for (const cell of summary.results) {
      assert.ok(EXPECTED[cell.region], `unexpected region tag "${cell.region}"`);
      seen.add(cell.region);
      assert.equal(cell.regionLabel, EXPECTED_LABEL[cell.region],
        `region ${cell.region} must carry its own market label`);
      assert.equal(
        cell.lang, EXPECTED[cell.region],
        `region "${cell.region}" was asked in "${cell.lang}" but its market speaks ` +
        `"${EXPECTED[cell.region]}" — a region missing from REGION_NATIVE_LANG falls ` +
        `through to the FIRST --lang entry ('pl' here)`,
      );
    }
    assert.deepEqual([...seen].sort(), ['at', 'ch', 'de', 'pl'],
      'all four requested markets must produce cells');
  });
});

/**
 * R39 / GAP-0 acceptance criterion, made explicit rather than assumed: growing
 * the REGIONS map must not change a run that never asked for regions. A default
 * replay carries NEITHER `region` NOR `lang` on any cell — the region axis is
 * entirely opt-in and leaves no trace when unused.
 */
test('default run (no --regions) is untouched by the region axis — no region, no lang', async () => {
  await withTmpProject('aeo-e2e-region-default-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'plain replay run should exit 0');

    const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    assert.equal(summary.results.length, 3, 'a no-region run stays at 3 cells (1 per query)');
    for (const cell of summary.results) {
      assert.ok(!('region' in cell), 'a no-region run must not tag cells with a region');
      assert.ok(!('regionLabel' in cell), 'a no-region run must not tag cells with a region label');
      assert.ok(!('lang' in cell), 'a no-region run must not tag cells with a language');
    }
  });
});
