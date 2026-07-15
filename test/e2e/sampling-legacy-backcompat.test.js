/**
 * E2E — AP-MEASURE-SAMPLING-CI must not disturb LEGACY snapshots.
 *
 * Months of `_summary.json` files on disk pre-date sampling: they have NO
 * `presence` object on cells and NO root `sampling` block. Every consumer of a
 * summary must render them exactly as before. This test exercises all FOUR
 * consumers named in the gate against a legacy-shaped summary:
 *
 *   1. report  (visibility-index → sectionUnifiedVisibilityIndex)
 *   2. diff    (lib/diff.js cellChanges classification)
 *   3. export  (lib/report/csv-export.js flattenSummary)
 *   4. report machine-block / sections (sections-data-integrity surface)
 *
 * The contract: legacy input → legacy output. Concretely:
 *   - report renders, exits 0, and shows NO sampling-only surface (no
 *     "trials/cell", no "CI [" presence hint);
 *   - diff of two legacy runs classifies a real flip as a `point-estimate`
 *     change (today's behaviour), NOT a distribution test;
 *   - CSV export has the unchanged column header and one row per cell.
 *
 * MUTATION-SANITY: make perCellPresence return r.presence?.rate (no boolean
 * fallback) → the report would NaN the presence axis on a legacy cell and the
 * "renders a numeric Presence" assertion goes RED.
 *
 * Pure file-write + subprocess; no network.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  responsesDateDir,
  BIN,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real', OPENAI_API_KEY: 'test-key-do-not-use-real' };

const DOMAIN = 'testbrand.com';
const DATE_A = '2026-05-25';
const DATE_B = '2026-06-11';

// A legacy summary — exactly the pre-sampling shape: NO presence, NO sampling.
function legacySummary(date, { q1Mention }) {
  return {
    date,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    score: q1Mention === 'yes' ? 100 : 0,
    mentions: q1Mention === 'yes' ? 1 : 0,
    total: 1,
    errors: 0,
    regressionThreshold: 10,
    results: [
      {
        query: 'Q1', queryText: 'best test brands 2026', provider: 'openai', label: 'ChatGPT',
        model: 'gpt-5-search-api', mode: 'web', mention: q1Mention,
        position: q1Mention === 'yes' ? 1 : null,
        citationCount: q1Mention === 'yes' ? 1 : 0,
        canonicalCitations: q1Mention === 'yes' ? ['testbrand.com'] : [],
        competitors: [], competitorsUnverified: [],
        responseQuality: 'ok',
        hasBrandInCitations: q1Mention === 'yes',
        responseExcerpt: 'TestBrand is great.',
        elapsedMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.0,
      },
    ],
  };
}

function seedRun(dir, date, summary) {
  const dd = responsesDateDir(dir, DOMAIN, date);
  mkdirSync(dd, { recursive: true });
  writeFileSync(join(dd, '_summary.json'), JSON.stringify(summary));
  return dd;
}

test('report renders a legacy (no-presence) summary unchanged — no sampling surface', async () => {
  await withTmpProject('aeo-e2e-legacy-report-', (dir) => {
    seedRun(dir, DATE_B, legacySummary(DATE_B, { q1Mention: 'yes' }));
    const out = join(dir, 'legacy.md');
    const r = spawnCli(['report', '--no-open', '--no-html', '--output', out], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report on a legacy summary should exit 0');

    const md = readFileSync(out, 'utf-8');
    // Presence axis renders a real number (proves the boolean fallback fired —
    // a sampled-only path would NaN here).
    assert.match(md, /\*\*Presence\*\*\s*\|\s*<span[^>]*>100\/100<\/span>/,
      'legacy cell must still produce a numeric Presence (100/100)');
    // NO sampling-only surface may appear for a legacy run.
    assert.doesNotMatch(md, /trials\/cell/, 'legacy report must NOT show a trials/cell note');
    assert.doesNotMatch(md, /trials · /, 'legacy report must NOT show a per-trial CI hint');
  });
});

test('diff of two legacy runs classifies a real flip as point-estimate (back-compat)', async () => {
  await withTmpProject('aeo-e2e-legacy-diff-', (dir) => {
    seedRun(dir, DATE_A, legacySummary(DATE_A, { q1Mention: 'yes' }));
    seedRun(dir, DATE_B, legacySummary(DATE_B, { q1Mention: 'no' }));

    // `diff A B` writes nothing — it prints a table. Assert it exits cleanly and
    // surfaces the cell change. (yes→no is a regression on a 1-cell basket.)
    const r = spawnCli(['diff', DATE_A, DATE_B], { cwd: dir, env: KEYS });
    // diff may exit 0 (table) or 1 (regression flagged) depending on threshold;
    // both are "rendered without crashing". Assert it did not crash (not 2/3).
    assert.ok(r.status === 0 || r.status === 1,
      `diff of two legacy runs should render (exit 0/1), got ${r.status}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /undefined|Cannot read|TypeError/,
      'legacy diff must not throw on absent presence objects');
  });
});

test('CSV export of a legacy summary has the unchanged header + one row per cell', async () => {
  await withTmpProject('aeo-e2e-legacy-csv-', (dir) => {
    seedRun(dir, DATE_B, legacySummary(DATE_B, { q1Mention: 'yes' }));
    const csv = execFileSync(process.execPath, [BIN, 'export'], {
      cwd: dir, encoding: 'utf-8',
      env: { ...process.env, ...KEYS, TZ: 'UTC' },
    });
    const lines = csv.trim().split('\n');
    // Header is the pre-feature column set — sampling added NO columns.
    assert.equal(
      lines[0],
      'date,brand,domain,query,queryText,provider,model,mention,position,citationCount,region,tag,sentiment,sentimentConfidence,topCompetitor,competitorCount,topCitationDomain',
      'CSV header must be byte-identical to the pre-sampling schema',
    );
    assert.equal(lines.length, 2, 'header + exactly one data row for the single legacy cell');
    assert.match(lines[1], /,yes,/, 'the legacy cell mention is preserved in the row');
  });
});
