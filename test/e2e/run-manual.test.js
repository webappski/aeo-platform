/**
 * E2E — `run-manual <provider> --from-dir <dir>`.
 *
 *   P0-13 — User has a manual-paste directory with q1.txt / q2.txt / q3.txt
 *           (text pasted from a browser-only engine — Perplexity Pro,
 *           ChatGPT.com, Claude.ai). `run-manual perplexity --from-dir`
 *           parses each file, extracts mentions + citations via the same
 *           extractor pipeline as `run`, and writes a merged _summary.json.
 *           Exit code 0 when at least one query produced a mention (one of
 *           the three fixture files contains "TestBrand" prominently).
 *
 * `run-manual` does NOT call provider APIs to retrieve text — it reads the
 * pasted text from disk. It DOES call the extractor (OpenAI + Gemini) via
 * `extractWithTwoModels`. Per-provider 401s are caught inside the extractor
 * and produce empty verified/unverified lists — the cell's mention is still
 * set by `detectMention()` from the pasted text, so the test asserts on
 * exit code + summary shape, not on extractor verdicts.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  responsesDateDir,
  legacyResponsesDateDir,
  todayDateString,
  FIXTURE_ROOT,
  offlineFetchEnv,
} from './_helpers.js';

const KEYS = offlineFetchEnv({ GEMINI_API_KEY: 'test-key-do-not-use-real' });
const DOMAIN = 'testbrand.com';

function dayBefore(yyyymmdd) {
  const date = new Date(`${yyyymmdd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

test('P0-13 — run-manual perplexity --from-dir reads pasted text + writes summary', async () => {
  await withTmpProject('aeo-e2e-runmanual-', (dir) => {
    // 1. Stage the manual-paste fixture directory inside tmp.
    const srcPasteDir = join(FIXTURE_ROOT, 'manual-paste');
    const destPasteDir = join(dir, 'manual-paste');
    mkdirSync(destPasteDir, { recursive: true });
    for (const name of readdirSync(srcPasteDir)) {
      cpSync(join(srcPasteDir, name), join(destPasteDir, name));
    }
    writeFileSync(join(destPasteDir, 'q2.txt'), 'Alpha and Beta are the leading options.');
    writeFileSync(join(destPasteDir, 'q3.txt'), 'Alpha is stronger than Beta for this use case.');

    // 2. Minimal .aeo-tracker.json. run-manual reads brand/domain/queries
    //    + a perplexity provider stanza (the run-manual target).
    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
      brand: 'TestBrand',
      domain: 'testbrand.com',
      queries: [
        'best test brands 2026',
        'top test brand alternatives',
        'test brand vs competitor',
      ],
      providers: {
        openai:     { model: 'gpt-5', classifyModel: 'gpt-5-mini', env: 'OPENAI_API_KEY' },
        gemini:     { model: 'gemini-2.5-flash', classifyModel: 'gemini-2.5-flash-lite', env: 'GEMINI_API_KEY' },
        perplexity: { model: 'sonar-pro', env: 'PERPLEXITY_API_KEY' },
      },
      validationCache: [],
    }));

    // Continue an old-format same-day run in place, and make the older flat
    // score high enough that the merged manual result must trigger regression.
    const today = todayDateString();
    const todayLegacyDir = legacyResponsesDateDir(dir, today);
    mkdirSync(todayLegacyDir, { recursive: true });
    writeFileSync(join(todayLegacyDir, '_summary.json'), JSON.stringify({
      date: today,
      brand: 'TestBrand',
      domain: DOMAIN,
      score: 100,
      mentions: 1,
      total: 1,
      errors: 0,
      results: [{
        query: 'Q1', queryText: 'best test brands 2026', provider: 'openai',
        label: 'ChatGPT', model: 'gpt-5', mode: 'web', mention: 'yes',
        position: 1, citationCount: 0, canonicalCitations: [], competitors: [],
        competitorsUnverified: [], responseQuality: 'ok', hasBrandInCitations: false,
      }],
    }));
    const previousDate = dayBefore(today);
    const previousDir = legacyResponsesDateDir(dir, previousDate);
    mkdirSync(previousDir, { recursive: true });
    writeFileSync(join(previousDir, '_summary.json'), JSON.stringify({
      date: previousDate, brand: 'TestBrand', domain: DOMAIN,
      score: 100, mentions: 1, total: 1, errors: 0, results: [],
    }));

    // 3. Run-manual against perplexity (browser-only engine, common use case).
    //    Timeout bumped: extractor's two-model classify can take ~10s under
    //    fake-key 401 retry/backoff inside Node fetch.
    const r = spawnCli(
      ['run-manual', 'perplexity', '--from-dir', 'manual-paste'],
      { cwd: dir, env: KEYS, timeout: 60_000 },
    );
    assertExitCode(r, 1, 'flat previous score 100 must drive the run-manual regression exit');

    // 4. Verify the summary landed.
    const summaryPath = join(todayLegacyDir, '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    assert.ok(!existsSync(join(responsesDateDir(dir, DOMAIN, today), '_summary.json')),
      'same-day legacy continuation must not create a namespaced summary shadow');
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    assert.equal(summary.brand, 'TestBrand');
    assert.equal(summary.results.length, 4, 'existing OpenAI cell + three manual cells must merge');
    assert.ok(summary.results.some(result => result.provider === 'openai'),
      'the pre-existing provider cell must survive the same-day merge');
    assert.ok(existsSync(join(todayLegacyDir, 'q1-perplexity-manual.txt')),
      'new raw paste must be written beside the legacy summary');
    // Every result row from run-manual is source-tagged "manual-paste" — pin
    // that so the test catches a regression where the manual seam silently
    // collapses into the live-run shape.
    assert.ok(
      summary.results.filter(r => r.provider === 'perplexity').every(r => r.source === 'manual-paste'),
      'every newly merged run-manual result should carry source="manual-paste"',
    );
    // Manual-paste cells must carry the pasted text as responseExcerpt — the same
    // truncation the live run loop applies. Without it the cell vanishes from every
    // "what the engine said" surface (report + MC payload). Regression guard for the
    // cmdRunManual responseExcerpt fix.
    assert.ok(
      summary.results
        .filter(r => r.provider === 'perplexity')
        .every(r => typeof r.responseExcerpt === 'string' && r.responseExcerpt.length > 0),
      'every run-manual result must carry a non-empty responseExcerpt (the pasted text)',
    );
  });
});

test('run-manual MERGES into the same day — it never drops sections the live run measured', async () => {
  await withTmpProject('aeo-e2e-runmanual-merge-', (dir) => {
    const srcPasteDir = join(FIXTURE_ROOT, 'manual-paste');
    const destPasteDir = join(dir, 'manual-paste');
    mkdirSync(destPasteDir, { recursive: true });
    for (const name of readdirSync(srcPasteDir)) {
      cpSync(join(srcPasteDir, name), join(destPasteDir, name));
    }
    writeFileSync(join(destPasteDir, 'q2.txt'), 'Alpha and Beta are the leading options.');
    writeFileSync(join(destPasteDir, 'q3.txt'), 'Alpha is stronger than Beta for this use case.');

    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
      brand: 'TestBrand',
      domain: DOMAIN,
      queries: [
        'best test brands 2026',
        'top test brand alternatives',
        'test brand vs competitor',
      ],
      providers: {
        openai:     { model: 'gpt-5', classifyModel: 'gpt-5-mini', env: 'OPENAI_API_KEY' },
        gemini:     { model: 'gemini-2.5-flash', classifyModel: 'gemini-2.5-flash-lite', env: 'GEMINI_API_KEY' },
        perplexity: { model: 'sonar-pro', env: 'PERPLEXITY_API_KEY' },
      },
      validationCache: [],
    }));

    // Seed a same-day summary shaped like one a live `run` (+ a later `report`)
    // leaves behind: one API provider column PLUS the site-level scans, the cost
    // telemetry and the run-only `measurement` / `unverifiedOnly` fields. The
    // rebuild-from-a-fixed-field-list bug erased every one of these; the LLM-derived
    // ones then cost money to regenerate, and measurement/unverifiedOnly/costByModel
    // were unrecoverable (only `run` ever writes them).
    const today = todayDateString();
    const todayLegacyDir = legacyResponsesDateDir(dir, today);
    mkdirSync(todayLegacyDir, { recursive: true });
    const SEEDED_SECTIONS = {
      crawlability:      { summary: { hasRobotsTxt: true, bots: [] } },
      authorityPresence: { wikipedia: { found: false } },
      pageSignals:       { homepage: { headings: { h1: 'Seeded H1' } } },
      entityGraph:       { sameAsCount: 2, edges: [] },
      competitorPricing: [{ name: 'PreMergeRival', tier: 'free', domain: 'premerge.example' }],
      citationClassification: { classified: ['seeded.example'] },
      measurement:       { scope: 'seeded disclaimer' },
      sessionCostUsd:    1.6,
      costByModel:       [{ provider: 'gemini', model: 'gemini-3.6-flash', requests: 3, costUsd: 1.6 }],
    };
    writeFileSync(join(todayLegacyDir, '_summary.json'), JSON.stringify({
      date: today,
      brand: 'TestBrand',
      domain: DOMAIN,
      score: 100,
      mentions: 1,
      total: 1,
      errors: 0,
      results: [{
        query: 'Q1', queryText: 'best test brands 2026', provider: 'openai',
        label: 'ChatGPT', model: 'gpt-5', mode: 'web', mention: 'yes',
        position: 1, citationCount: 0, canonicalCitations: [], competitors: [],
        competitorsUnverified: ['PreMergeRival'], responseQuality: 'ok', hasBrandInCitations: false,
      }],
      // Deliberately WRONG relative to the row above: `unverifiedOnly` is an
      // aggregate over results[], so the merge must re-derive it rather than carry
      // this stale value forward.
      unverifiedOnly: [{ name: 'StaleAggregate', count: 9 }],
      ...SEEDED_SECTIONS,
    }));

    // No previous-date snapshot → readPreviousScore() is null → no regression exit.
    const r = spawnCli(
      ['run-manual', 'perplexity', '--from-dir', 'manual-paste'],
      { cwd: dir, env: KEYS, timeout: 60_000 },
    );
    assertExitCode(r, 0, 'at least one pasted cell mentions the brand and there is no previous score');

    const summary = JSON.parse(readFileSync(join(todayLegacyDir, '_summary.json'), 'utf-8'));

    // 1. Everything the live run measured and run-manual does NOT recompute survives.
    for (const [field, seeded] of Object.entries(SEEDED_SECTIONS)) {
      assert.deepEqual(
        summary[field], seeded,
        `run-manual dropped "${field}" — it must merge into the day's summary, not rebuild it`,
      );
    }

    // 2. …while the fields it DOES own are recomputed over the merged result set.
    assert.equal(summary.results.length, 4, 'existing OpenAI cell + three manual cells must merge');
    assert.equal(summary.total, 4, 'total must count the merged cells, not the pre-merge one');
    assert.ok(summary.generatedBy.startsWith('aeo-platform@'), 'generatedBy must be re-stamped');
    assert.deepEqual(
      summary.unverifiedOnly, [{ name: 'PreMergeRival', count: 1 }],
      'unverifiedOnly is an aggregate over results[] — it must be re-derived from the merged set, not carried',
    );

    // 3. Every carried-forward section that `report` CACHES *and* derives from the
    //    results is named as pre-merge, with the refresh command — never silently
    //    served as if it covered the whole day. competitorPricing belongs here: it
    //    is classified from topCompetitors, which this command recomputes.
    const out = `${r.stdout}${r.stderr}`;
    const hint = out.match(/--refresh-cache=(\S+)/)?.[1] ?? '';
    for (const field of ['citationClassification', 'competitorPricing']) {
      assert.ok(
        hint.split(',').includes(field),
        `"${field}" was carried forward but not named in the refresh hint (hint: "${hint}")`,
      );
    }
  });
});
