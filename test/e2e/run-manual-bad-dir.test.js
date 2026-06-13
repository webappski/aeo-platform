/**
 * E2E / regression-lock — `run-manual --from-dir` must FAIL LOUD on a missing
 * or empty source directory.
 *
 *   AP-FAIL-BRANCHES (1.1.8) standard: on any failure branch the operator gets
 *   ONE plain, actionable next step and a NON-ZERO exit — never a silent pass,
 *   never a bare crash. These two branches were verified present at v1.3.1
 *   (the bug the upstream card described — silent pass / crash — does NOT exist
 *   in the live code; it was already fixed in the 1.1.8 fail-branch work). This
 *   test LOCKS that behaviour so a future refactor can't regress it back to a
 *   silent exit-0.
 *
 * Both branches exit BEFORE any provider/API-key work:
 *   - missing dir  → the `existsSync(fromDir)` guard (bin/aeo-tracker.js ~3468)
 *   - empty dir    → the "Missing query response files" panel (~3491), emitted
 *                    before buildExtractionProviders — so no key is needed.
 *
 * Mutation-sanity: change either `process.exit(1)` on those branches to
 * `process.exit(0)` and the matching assertion goes RED.
 */
import test from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmpProject, spawnCli } from './_helpers.js';

// Minimal config so run-manual gets past the "no .aeo-tracker.json" guard and
// reaches the missing-files panel for the empty-dir case.
const CONFIG = JSON.stringify({
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
});

test('run-manual --from-dir <missing dir> exits non-zero with an actionable message', async () => {
  await withTmpProject('aeo-e2e-baddir-missing-', (dir) => {
    // The missing-dir guard runs before the config check, so no config needed.
    const r = spawnCli(
      ['run-manual', 'perplexity', '--from-dir', join(dir, 'does-not-exist')],
      { cwd: dir, timeout: 30_000 },
    );
    assert.notEqual(r.status, 0, 'missing --from-dir must NOT exit 0');
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.match(out, /directory must exist/i,
      `expected an actionable "directory must exist" message, got:\n${out}`);
  });
});

test('run-manual --from-dir <empty dir> exits non-zero and names the missing files', async () => {
  await withTmpProject('aeo-e2e-baddir-empty-', (dir) => {
    // Config present → past the config guard → reach the missing-query-files
    // panel (the empty-dir branch). The tmp dir itself exists but is empty, so
    // we point --from-dir at the (existing, file-less) project root.
    writeFileSync(join(dir, '.aeo-tracker.json'), CONFIG);
    const r = spawnCli(
      ['run-manual', 'perplexity', '--from-dir', dir],
      { cwd: dir, timeout: 30_000 },
    );
    assert.notEqual(r.status, 0, 'empty --from-dir must NOT exit 0');
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.match(out, /Missing query response files/i,
      `expected the "Missing query response files" panel, got:\n${out}`);
    // The panel must name each expected paste file so the operator knows what
    // to create. (q1.txt is sufficient as a representative.)
    assert.match(out, /q1\.txt/,
      `expected the panel to name the missing q1.txt, got:\n${out}`);
  });
});
