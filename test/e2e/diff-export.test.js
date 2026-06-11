/**
 * E2E — `diff` and `export` commands.
 *
 *   P0-15 — `diff 2026-01-14 2026-01-15` on a pre-staged pair (score 40 → 50)
 *           exits 0 and prints the "Score delta" header line plus a
 *           "Cell changes:" panel.
 *   P0-16 — `export --format=csv` produces a CSV with a header row plus at
 *           least one data row. Pinned via stdout (no --output flag) so we
 *           can grep the bytes directly.
 *
 * These tests pre-stage `aeo-responses/2026-01-14/_summary.json` and
 * `2026-01-15/_summary.json` from `test/fixtures/diff-pair/` — `diff` does
 * NOT need raw response files, only `_summary.json`. `export` flattens
 * every `_summary.json` it finds; we ship both so the CSV has >= 2 runs.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  FIXTURE_ROOT,
} from './_helpers.js';

function seedDiffPair(dir) {
  const src = join(FIXTURE_ROOT, 'diff-pair');
  for (const [date, file] of [['2026-01-14', 'yesterday-summary.json'], ['2026-01-15', 'today-summary.json']]) {
    const destDir = join(dir, 'aeo-responses', date);
    mkdirSync(destDir, { recursive: true });
    cpSync(join(src, file), join(destDir, '_summary.json'));
  }
}

test('P0-15 — diff between two pre-staged runs prints score delta + cell changes', async () => {
  await withTmpProject('aeo-e2e-diff-', (dir) => {
    seedDiffPair(dir);
    const r = spawnCli(['diff', '2026-01-14', '2026-01-15'], { cwd: dir });
    assertExitCode(r, 0, 'diff between two existing snapshots should exit 0');
    assert.match(r.stdout, /Score delta:/, 'diff stdout must include "Score delta:" header');
    assert.match(r.stdout, /Cell changes:|No cell changes/, 'diff stdout must report cell changes');
    assert.ok(existsSync(join(dir, 'aeo-responses', '2026-01-14', '_summary.json')));
  });
});

test('P0-16 — export --format=csv prints a CSV header row + at least one data row', async () => {
  await withTmpProject('aeo-e2e-export-', (dir) => {
    seedDiffPair(dir);
    const r = spawnCli(['export', '--format=csv'], { cwd: dir });
    assertExitCode(r, 0, 'export --format=csv should exit 0');
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 2, `expected header + >=1 data row, got ${lines.length} lines`);
    // CSV format check: header line must be comma-separated, contain
    // canonical field names. We pin "date" + "brand" tokens (loadbearing
    // for any consumer of the flat export); pinning the exact column list
    // would be brittle when new optional fields land.
    const header = lines[0];
    assert.match(header, /(^|,)date(,|$)/, 'CSV header must include "date" column');
    assert.match(header, /(^|,)brand(,|$)/, 'CSV header must include "brand" column');
    // Explicit machine-output contract (version-awareness, 1.2.x): the CLI
    // version line must NEVER leak into export stdout — only human commands
    // print it. Without this assert the guarantee was only transitive
    // through the header-on-line-0 check above.
    assert.doesNotMatch(r.stdout, /aeo-platform v\d/, 'version line must not pollute export stdout');
    // Data row must contain the canonical fixture brand.
    const dataRowsText = lines.slice(1).join('\n');
    assert.match(dataRowsText, /TestBrand/, 'CSV data should reference TestBrand fixture brand');
  });
});
