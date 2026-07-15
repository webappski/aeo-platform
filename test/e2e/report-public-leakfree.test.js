/**
 * E2E — `report --public` is leak-free BY CONSTRUCTION (no manual scrub).
 *
 * A HOSTED proof report (published like the TypelessForm proof page) must never
 * carry three internal categories that the default report renders:
 *
 *   (1) Session-cost card  — "$X / run", "Nk tokens", per-engine $ — publishing
 *       our own per-run API spend is a pricing liability against the paid tier
 *       on the same page.
 *   (2) source-path footnote — "lib/report/visibility-index.js" in the UVI
 *       details (both HTML <code> and the markdown weights note).
 *   (3) any *.js source path in served output (incl. "mc-bridge.js").
 *
 * Precedent: 2026-06-15 the public webappski "2/39" proof report was BLOCKED by
 * independent review because a manual scrub missed exactly these (memory
 * feedback_aeo_platform_report_leaks_cost_and_source_paths). `--public` makes
 * the omission structural so no scrub is needed.
 *
 * The test is TWO-SIDED on purpose: it asserts each category is PRESENT in the
 * default report AND ABSENT in --public. A one-sided "absent in public" test
 * would false-pass if --public silently stopped being wired (the category would
 * be absent in both). The UVI FORMULA (Σ(value × applied_weight)) MUST survive
 * in both modes — only the file-path provenance is dropped.
 *
 * Mutation-sanity (run by hand to confirm teeth): delete the `&& !publicMode`
 * guard on the cost card in lib/report/html.js, OR make the formulaNote /
 * weightsNote ignore opts.public — this test MUST go RED.
 *
 * Rendering precondition: the Session-cost card only renders when the latest
 * _summary.json carries `costByModel` with engine labels (ChatGPT/Gemini/…).
 * Stable replay fixtures omit costByModel, so we seed a minimal valid summary
 * with a real costByModel block directly under aeo-responses/<today>/ and run
 * `report` against it (report reads the latest on-disk snapshot — no `run`
 * needed). Pure file-write + subprocess; no network, no live API.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  responsesDateDir,
  reportsDateDir,
  todayDateString,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real', OPENAI_API_KEY: 'test-key-do-not-use-real' };

const DOMAIN = 'testbrand.com';

// Source-path regex per the leak-guard memory: matches dashed/numbered file
// names like "visibility-index.js" that a naive /lib\/[a-z/]+\.js/ would miss.
const SRC_PATH_RE = /[a-zA-Z0-9_/.-]+\.(?:js|ts|mjs)\b/g;
const COST_PER_RUN_RE = /\$\s*[\d.]+\s*\/\s*run/;
const TOKENS_RE = /\d+k?\s*tokens/;
const UVI_FORMULA_RE = /Σ\(value\s*×\s*applied_weight\)/;

// Only INTERNAL paths count as leaks. testbrand.com / esc'd domains and the
// public CSS class `.mc-bridge` (element name, public) are NOT leaks — the
// dangerous forms are `lib/…` and a `*.js` filename.
function internalSourcePaths(html) {
  const all = html.match(SRC_PATH_RE) || [];
  return [...new Set(all.filter(s => /^lib\//.test(s) || /\blib\/[\w./-]+\.js$/.test(s) || s.endsWith('mc-bridge.js') || s.endsWith('visibility-index.js')))];
}

// Minimal valid summary carrying costByModel with engine labels so the
// Session-cost card renders in the default report. Mirrors the real
// costByModel shape emitted by `run`.
function seedSummaryWithCost(dir) {
  const today = todayDateString();
  const dd = responsesDateDir(dir, DOMAIN, today);
  mkdirSync(dd, { recursive: true });
  const summary = {
    date: today,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    score: 50,
    total: 1,
    sessionCostUsd: 1.98,
    costByModel: [
      { provider: 'openai', model: 'gpt-5-search-api', label: 'ChatGPT', requests: 13, inputTokens: 215476, outputTokens: 16866, costUsd: 0.54 },
      { provider: 'gemini', model: 'gemini-3.5-flash', label: 'Gemini', requests: 13, inputTokens: 159, outputTokens: 24889, costUsd: 0.01 },
    ],
    results: [
      {
        query: 'Q1', queryText: 'best test brands 2026', provider: 'openai', label: 'ChatGPT',
        model: 'gpt-5-search-api', mode: 'web', mention: 'yes', position: 1, citationCount: 1,
        canonicalCitations: ['testbrand.com'], competitors: [], competitorsUnverified: [],
        responseQuality: 'ok', hasBrandInCitations: true, responseExcerpt: 'TestBrand is great.',
        elapsedMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.54,
      },
    ],
  };
  writeFileSync(join(dd, '_summary.json'), JSON.stringify(summary));
  return today;
}

function reportHtml(dir, today, extraArgs = []) {
  const r = spawnCli(['report', '--no-open', ...extraArgs], { cwd: dir, env: KEYS });
  assertExitCode(r, 0, `report ${extraArgs.join(' ')} should exit 0`);
  return readFileSync(join(reportsDateDir(dir, DOMAIN, today), 'report.html'), 'utf-8');
}

test('default report HTML carries the Session-cost card, $/run, tokens and a lib/ source path', async () => {
  await withTmpProject('aeo-e2e-public-default-', async (dir) => {
    const today = seedSummaryWithCost(dir);
    const html = reportHtml(dir, today);

    // Card + telemetry present (this is the leak surface we suppress in --public).
    assert.match(html, /Session cost/, 'default report should render the Session-cost card');
    assert.match(html, COST_PER_RUN_RE, 'default report should show "$X / run"');
    assert.match(html, TOKENS_RE, 'default report should show token count');
    const leaks = internalSourcePaths(html);
    assert.ok(
      leaks.includes('lib/report/visibility-index.js'),
      `default report should carry the UVI source-path footnote; internal paths found: ${JSON.stringify(leaks)}`,
    );
    // Formula present (baseline for the --public "formula survives" assert).
    assert.match(html, UVI_FORMULA_RE, 'default report should show the UVI formula');
  });
});

test('report --public omits the cost card, telemetry and every internal source path, but keeps the UVI formula', async () => {
  await withTmpProject('aeo-e2e-public-clean-', async (dir) => {
    const today = seedSummaryWithCost(dir);
    const html = reportHtml(dir, today, ['--public']);

    // (1) Cost card + telemetry gone.
    assert.doesNotMatch(html, /Session cost/, '--public must omit the Session-cost card');
    assert.doesNotMatch(html, COST_PER_RUN_RE, '--public must omit "$X / run"');
    assert.doesNotMatch(html, TOKENS_RE, '--public must omit token telemetry');

    // (2)+(3) No internal source paths at all (lib/…, visibility-index.js, mc-bridge.js).
    const leaks = internalSourcePaths(html);
    assert.deepEqual(
      leaks, [],
      `--public served HTML must contain zero internal source paths; found: ${JSON.stringify(leaks)}`,
    );
    assert.doesNotMatch(html, /mc-bridge\.js/, '--public must not contain mc-bridge.js (the .js path form)');

    // The FORMULA itself stays — only the path provenance is dropped.
    assert.match(html, UVI_FORMULA_RE, '--public must keep the UVI formula (only the lib/ path is dropped)');

    // R8 funnel-invariant preserved: the public-name anchor <article id="mc-bridge">
    // is NOT a leak and must survive (the commerce CTA lives there).
    assert.match(html, /<article[^>]*\bid="mc-bridge"/, '--public must keep the <article id="mc-bridge"> anchor (R8)');
  });
});
