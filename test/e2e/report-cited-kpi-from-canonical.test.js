/**
 * E2E — the "cited you N times" KPI counts OWN-DOMAIN canonical citations,
 * read from the field the run actually persists (`canonicalCitations`).
 *
 * AP-CITATION-KPI-DORMANT (found by code-review-runner, confirmed against a
 * real _summary.json): buildHtmlSummary computed the per-engine "N citations"
 * card AND the hero `totalCitations`/`totalCitationsPrev` KPI by reading
 * `r.citations` — a key that the persisted result object NEVER carries. Every
 * real run writes `canonicalCitations` (+ `citationCount`, `hasBrandInCitations`)
 * and no `citations` key, so `(r.citations || [])` was always `[]` → the KPI was
 * STRUCTURALLY 0 on every real report regardless of how many times engines cited
 * the user's domain.
 *
 * Semantic (locked by the renderer's own comments, lib/report/html.js:227-230 +
 * bin/aeo-tracker.js:3197-3211, 3303-3306): "cited you N times" = number of
 * own-domain canonical-citation URLs (matched by registrable domain via
 * isOwnDomain — exact host or subdomain, NOT raw substring). A canonical URL on
 * a competitor host does NOT count.
 *
 * TWO-SIDED on purpose:
 *   - the NON-ZERO case (a cell with an own-domain canonical citation) fails if
 *     the code reads the dead `r.citations` field again (KPI would collapse to 0);
 *   - the ZERO case (a cell whose only canonical citation is a competitor host)
 *     fails if a future change counted ALL canonical citations instead of
 *     own-domain ones (the KPI would over-count).
 *
 * Mutation-sanity (run by hand to confirm teeth): in bin/aeo-tracker.js's
 * buildHtmlSummary, revert the per-engine `citations` reducer (the line that
 * reads `r.canonicalCitations`) back to `r.citations` — the NON-ZERO assertion
 * ("1 citations" in the rendered engine card) MUST go RED (it renders
 * "0 citations" because the field does not exist). Restore → green.
 *
 * Pure file-write + subprocess; no network, no live API, no product test hooks.
 * Uses --for-date + --output so it never touches the default aeo-reports/ sweep.
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
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real', OPENAI_API_KEY: 'test-key-do-not-use-real' };

const DATE = '2026-06-11';
const DOMAIN = 'testbrand.com';

// One result cell, mirroring the real _summary.json shape: it carries
// `canonicalCitations` (URL string array) + `citationCount` + the
// `hasBrandInCitations` flag — and DELIBERATELY no `citations` key, exactly
// like every persisted run.
function cell({ query, mention, canonicalCitations }) {
  return {
    query, queryText: `q for ${query}`, provider: 'openai', label: 'ChatGPT',
    model: 'gpt-5-search-api', mode: 'web', mention, position: mention === 'yes' ? 1 : null,
    citationCount: canonicalCitations.length, canonicalCitations,
    competitors: [], competitorsUnverified: [],
    responseQuality: 'ok',
    hasBrandInCitations: canonicalCitations.some(u => u.includes(DOMAIN)),
    responseExcerpt: 'x', elapsedMs: 100, inputTokens: 10, outputTokens: 10, costUsd: 0.0,
  };
}

function writeSummary(dir, results) {
  const dd = responsesDateDir(dir, DOMAIN, DATE);
  mkdirSync(dd, { recursive: true });
  writeFileSync(join(dd, '_summary.json'), JSON.stringify({
    date: DATE, brand: 'TestBrand', domain: DOMAIN, score: 50, total: results.length, results,
  }));
}

// Pull the rendered "N citations" out of the engine card meta row
// (lib/report/html.js: `<span>${e.citations} citations</span>`).
function renderedCitations(html) {
  const m = html.match(/>(\d+) citations</);
  return m ? Number(m[1]) : null;
}

test('cited-N KPI counts an own-domain canonical citation (non-zero from real-shape data)', async () => {
  await withTmpProject('aeo-e2e-citedkpi-nonzero-', async (dir) => {
    // Two cells: one cites the OWN domain (counts), one cites only a competitor
    // host (does not count). Expected own-domain citation total for the engine: 1.
    writeSummary(dir, [
      cell({ query: 'Q1', mention: 'yes', canonicalCitations: [`https://${DOMAIN}/post?utm_source=openai`] }),
      cell({ query: 'Q2', mention: 'no',  canonicalCitations: ['https://competitor.com/x?utm_source=openai'] }),
    ]);

    const out = join(dir, 'out.md');
    const r = spawnCli(['report', '--for-date', DATE, '--no-open', '--output', out], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report should exit 0');

    const html = readFileSync(out.replace(/\.md$/, '') + '.html', 'utf-8');
    assert.strictEqual(renderedCitations(html), 1,
      `engine card should render "1 citations" (one own-domain canonical cite); ` +
      `0 means the code read the non-existent r.citations field again. HTML had: ` +
      `${(html.match(/>\d+ citations</) || ['<none>'])[0]}`);
  });
});

test('cited-N KPI is 0 when the only canonical citation is a competitor host (no over-count)', async () => {
  await withTmpProject('aeo-e2e-citedkpi-zero-', async (dir) => {
    // The engine DID name the brand (mention: 'yes') but its canonical citations
    // point only at competitor hosts. The own-domain filter must exclude those,
    // so the "cited you" count is 0 — proving the KPI counts own-domain hits, not
    // every URL the engine returned. (A `yes` cell also keeps the report on the
    // same healthy render path as the non-zero test.)
    writeSummary(dir, [
      cell({ query: 'Q1', mention: 'yes', canonicalCitations: ['https://competitor.com/a?utm_source=openai'] }),
      cell({ query: 'Q2', mention: 'no',  canonicalCitations: ['https://another-rival.io/b'] }),
    ]);

    const out = join(dir, 'out.md');
    const r = spawnCli(['report', '--for-date', DATE, '--no-open', '--output', out], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'report should exit 0');

    const html = readFileSync(out.replace(/\.md$/, '') + '.html', 'utf-8');
    assert.strictEqual(renderedCitations(html), 0,
      'engine card should render "0 citations" when no canonical citation is own-domain ' +
      '(a competitor-host citation must NOT count as "they cited you")');
  });
});
