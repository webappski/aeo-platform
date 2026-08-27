/**
 * E2E — FC-02: `export --format=json --output=<file>`.
 *
 * Top-ranked uncovered flag-combo in resources/aeo-platform/E2E_BACKLOG.md.
 * Until now only `--format=csv` (P0-16, diff-export.test.js) was covered, and
 * that test pins STDOUT — so BOTH the second serialisation format AND the
 * `--output` file-redirect branch shipped untested. `export` is the machine
 * -readable contract other tools consume (Looker / Sheets / BI ingestion), so
 * a silent schema drift here is invisible to humans and breaks a pipeline.
 *
 * What this covers that CSV coverage does not:
 *   1. `snapshotsToJson` — that the payload is a parseable JSON ARRAY of flat
 *      row objects (not an object, not NDJSON, not a stringified blob).
 *   2. The `--output` branch — bytes reach the FILE, and the file is the whole
 *      payload (the stdout success line must not leak into it).
 *   3. The reported row count. This is a real bug the card fixed: the counter
 *      used to be `output.split('\n').length - 1`, i.e. newlines in the
 *      SERIALISED text. On CSV that counted the header as a data row; on
 *      pretty-printed JSON it counted ~19 lines per row and reported 343 rows
 *      for an 18-row export. The count now derives from `flattenSummary`.
 *   4. Schema parity between the two formats — the same run exported as CSV
 *      and as JSON must describe the same rows with the same field names.
 *
 * Fixtures: the `diff-pair` snapshots (9 result cells each, 2 runs = 18 rows),
 * staged flat via `legacyResponsesDateDir` exactly as diff-export.test.js does
 * — `responseDatesForRead` reads both the domain-namespaced and the flat legacy
 * layout, and the flat one is what the sibling export test already proves the
 * command picks up. No subprocess network access, no API keys consumed.
 *
 * MUTATION-SANITY (proven out-of-tree 2026-08-27, repo restored + git-diff
 * re-checked): reverting the row counter to `output.split('\n').length - 1`
 * makes "reports a row count that matches the file" fail with 343 !== 18.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  legacyResponsesDateDir,
  FIXTURE_ROOT,
} from './_helpers.js';

// 9 result cells per fixture snapshot × 2 snapshots. Derived below from the
// fixtures themselves rather than hardcoded, so re-recording a fixture cannot
// make this test silently assert the wrong number.
const FIXTURES = [['2026-01-14', 'yesterday-summary.json'], ['2026-01-15', 'today-summary.json']];

function seedDiffPair(dir) {
  const src = join(FIXTURE_ROOT, 'diff-pair');
  for (const [date, file] of FIXTURES) {
    const destDir = legacyResponsesDateDir(dir, date);
    mkdirSync(destDir, { recursive: true });
    cpSync(join(src, file), join(destDir, '_summary.json'));
  }
}

/** Ground truth: how many result cells the fixtures actually carry. */
function expectedRowCount() {
  return FIXTURES.reduce((n, [, file]) => {
    const s = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'diff-pair', file), 'utf-8'));
    return n + s.results.length;
  }, 0);
}

test('FC-02 — export --format=json --output writes a parseable JSON array of flat rows', async () => {
  await withTmpProject('aeo-e2e-export-json-', (dir) => {
    seedDiffPair(dir);
    const outPath = join(dir, 'runs.json');
    const r = spawnCli(['export', '--format=json', `--output=${outPath}`], { cwd: dir });
    assertExitCode(r, 0, 'export --format=json --output should exit 0');

    assert.ok(existsSync(outPath), `export must write the file it was given: ${outPath}`);
    const raw = readFileSync(outPath, 'utf-8');

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { assert.fail(`--output file must be parseable JSON: ${err.message}`); }

    assert.ok(Array.isArray(parsed), 'JSON export must be a top-level ARRAY of row objects');
    assert.equal(parsed.length, expectedRowCount(),
      'JSON export must carry one row per result cell across every snapshot found');

    // Flat rows — a BI consumer must not have to walk a nested shape. Pin the
    // load-bearing field names (same set the CSV header pins) without pinning
    // the full column list, which would go brittle when an optional field lands.
    for (const row of parsed) {
      assert.equal(typeof row, 'object', 'each element must be a flat row object');
      for (const key of ['date', 'brand', 'domain', 'query', 'provider', 'mention']) {
        assert.ok(key in row, `row is missing the "${key}" field: ${JSON.stringify(row)}`);
      }
      assert.equal(row.brand, 'TestBrand', 'rows must carry the fixture brand');
    }
    // Both runs must be represented, not just the newest.
    const dates = new Set(parsed.map(x => x.date));
    assert.deepEqual([...dates].sort(), ['2026-01-14', '2026-01-15'],
      'export must flatten EVERY snapshot on disk, not only the latest run');

    // The file is the payload and nothing else — no ANSI, no success line, no
    // version banner bleeding into a machine-readable artifact.
    assert.doesNotMatch(raw, /aeo-platform v\d/, 'version banner must never reach the export file');
    assert.doesNotMatch(raw, /Exported \d+ run/, 'the stdout success line must not be written into the file');
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(raw, /\[/, 'no ANSI escapes in a machine-readable export');
  });
});

test('FC-02 — export --output reports a row count that matches the file (not its line count)', async () => {
  await withTmpProject('aeo-e2e-export-json-count-', (dir) => {
    seedDiffPair(dir);
    const outPath = join(dir, 'runs.json');
    const r = spawnCli(['export', '--format=json', `--output=${outPath}`], { cwd: dir });
    assertExitCode(r, 0, 'export --format=json --output should exit 0');

    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'));
    const reported = Number(r.stdout.match(/\((\d+) rows\)/)?.[1]);
    assert.ok(Number.isFinite(reported), `stdout must report a row count, got: ${r.stdout}`);
    assert.equal(
      reported, parsed.length,
      `CLI reported ${reported} rows but the file contains ${parsed.length} — the counter is ` +
      `measuring serialised LINES, not data rows (pretty-printed JSON spends ~19 lines per row)`,
    );
    assert.match(r.stdout, /Exported 2 runs/, 'stdout must report how many snapshots were flattened');
  });
});

test('FC-02 — the same run exported as CSV and as JSON describes the same rows', async () => {
  await withTmpProject('aeo-e2e-export-parity-', (dir) => {
    seedDiffPair(dir);
    // stdout form (no --output) — the other half of the redirect branch, and
    // the shape a shell pipeline consumes.
    const jsonRes = spawnCli(['export', '--format=json'], { cwd: dir });
    assertExitCode(jsonRes, 0, 'export --format=json to stdout should exit 0');
    const rows = JSON.parse(jsonRes.stdout);

    const csvRes = spawnCli(['export', '--format=csv'], { cwd: dir });
    assertExitCode(csvRes, 0, 'export --format=csv to stdout should exit 0');
    const csvLines = csvRes.stdout.trim().split('\n').filter(Boolean);

    assert.equal(rows.length, csvLines.length - 1,
      'JSON row count must equal CSV data-row count (CSV line 0 is the header)');

    // Field names must agree, so a consumer can switch formats without a
    // remap. Order is the CSV column order; JSON object key order follows the
    // same builder, which is why deepEqual on the sorted sets is the right pin.
    const csvHeader = csvLines[0].split(',');
    assert.deepEqual(
      Object.keys(rows[0]).sort(), csvHeader.slice().sort(),
      'JSON row fields and CSV columns must be the same set — they come from one flattener',
    );
  });
});
