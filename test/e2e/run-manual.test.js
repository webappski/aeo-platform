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
  todayDateString,
  FIXTURE_ROOT,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };
const DOMAIN = 'testbrand.com';

test('P0-13 — run-manual perplexity --from-dir reads pasted text + writes summary', async () => {
  await withTmpProject('aeo-e2e-runmanual-', (dir) => {
    // 1. Stage the manual-paste fixture directory inside tmp.
    const srcPasteDir = join(FIXTURE_ROOT, 'manual-paste');
    const destPasteDir = join(dir, 'manual-paste');
    mkdirSync(destPasteDir, { recursive: true });
    for (const name of readdirSync(srcPasteDir)) {
      cpSync(join(srcPasteDir, name), join(destPasteDir, name));
    }

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

    // 3. Run-manual against perplexity (browser-only engine, common use case).
    //    Timeout bumped: extractor's two-model classify can take ~10s under
    //    fake-key 401 retry/backoff inside Node fetch.
    const r = spawnCli(
      ['run-manual', 'perplexity', '--from-dir', 'manual-paste'],
      { cwd: dir, env: KEYS, timeout: 60_000 },
    );
    // Exit code may be 0 (mentions found, no prior baseline) or 2 (no
    // mentions). The fixture q1.txt contains "TestBrand" → at least one
    // mention → exit 0 is the expected canonical contract.
    assertExitCode(r, 0, 'run-manual with TestBrand in q1.txt should exit 0');

    // 4. Verify the summary landed.
    const today = todayDateString();
    const summaryPath = join(responsesDateDir(dir, DOMAIN, today), '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    assert.equal(summary.brand, 'TestBrand');
    assert.ok(Array.isArray(summary.results) && summary.results.length >= 3,
      `expected >= 3 results, got ${summary.results?.length}`);
    // Every result row from run-manual is source-tagged "manual-paste" — pin
    // that so the test catches a regression where the manual seam silently
    // collapses into the live-run shape.
    assert.ok(
      summary.results.every(r => r.source === 'manual-paste'),
      'every run-manual result should carry source="manual-paste"',
    );
  });
});
