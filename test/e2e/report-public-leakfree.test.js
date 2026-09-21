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
 * (4) run-internal per-cell fields in the EMBEDDED BRIDGE PAYLOAD (added
 *     2026-09-21, AP-LEAKTEST-BLIND-FIXTURES). `--public` KEEPS the
 *     Mission-Control bridge (R8) and the bridge embeds its metadata JSON
 *     straight into the served HTML, so the strict allow-list in
 *     lib/report/mc-metadata.js `perCell` is a load-bearing leak guard — it
 *     drops `extractionSources` / `degraded` / `errorKind` / `slots` /
 *     `resolvedModel` / `modelDrift` / `costTracked` by NOT naming them. Until
 *     the seed carried those fields the guard had nothing to drop: the test
 *     made no assertion about payload contents at all.
 *
 * Mutation-sanity (run by hand to confirm teeth): delete the `&& !publicMode`
 * guard on the cost card in lib/report/html.js, OR make the formulaNote /
 * weightsNote ignore opts.public — this test MUST go RED.
 * For (4), name any one of those fields in `perCell` → RED. Verified 2026-09-21
 * for `extractionSources` and `costTracked`, both against the pre-seed file too
 * (`git show HEAD:<this file>`), which stayed GREEN under the same mutation —
 * that green is the whole reason this block exists.
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
  conditionalSurfaceCells,
  CONDITIONAL_DECLARED_SUBSETS,
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
  // One cell per CONDITIONAL surface. In `--public` the Mission-Control bridge
  // SURVIVES (R8) and embeds its metadata payload straight into the served
  // HTML, so the strict allow-list in lib/report/mc-metadata.js `perCell` is a
  // load-bearing leak guard — and with no such fields in the fixture it had
  // nothing to drop and nothing to prove (AP-LEAKTEST-BLIND-FIXTURES).
  summary.results.push(...conditionalSurfaceCells(summary.results[0]));
  summary.declaredSubsets = CONDITIONAL_DECLARED_SUBSETS;
  writeFileSync(join(dd, '_summary.json'), JSON.stringify(summary));
  return today;
}

// Run-internal per-cell fields that must never reach a hosted page. They are
// dropped by OMISSION — `perCell` names every field it keeps — so the only way
// to test the guard is to have the fields in the run and look for them in the
// served file. Matched as JSON keys: the payload is embedded verbatim, and a
// bare word would collide with ordinary prose.
const PAYLOAD_INTERNALS = [
  'extractionSources',
  'degraded',
  'errorKind',
  'slots',
  'resolvedModel',
  'modelDrift',
  'costTracked',
];
const keyRe = (k) => new RegExp(`"${k}"\\s*:`);

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

test('report --public embeds the bridge payload without a single run-internal per-cell field', async () => {
  await withTmpProject('aeo-e2e-public-payload-', async (dir) => {
    const today = seedSummaryWithCost(dir);

    // TWO-SIDED: the fields are genuinely IN this run. Without this half, the
    // absence below would prove only that the fixture never had them — the
    // exact false-pass this test existed with for months.
    const summaryRaw = readFileSync(join(responsesDateDir(dir, DOMAIN, today), '_summary.json'), 'utf-8');
    for (const k of PAYLOAD_INTERNALS) {
      assert.match(summaryRaw, keyRe(k), `the seeded run must carry "${k}" for its absence downstream to mean anything`);
    }

    const html = reportHtml(dir, today, ['--public']);
    // The bridge is present — so the payload really is embedded and the
    // assertions below are scanning something, not an omitted block.
    assert.match(html, /<article[^>]*\bid="mc-bridge"/, '--public must keep the bridge (R8) — otherwise there is no payload to scan');
    assert.match(html, /"queryText"\s*:/, 'the embedded payload must carry the allow-listed per-cell fields');
    for (const k of PAYLOAD_INTERNALS) {
      assert.doesNotMatch(html, keyRe(k), `--public served HTML must not carry the run-internal field "${k}"`);
    }
  });
});
