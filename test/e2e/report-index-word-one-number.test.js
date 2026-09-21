/**
 * E2E — the word "index" names ONE number on the page.
 *
 * The defect this pins, found 2026-09-21 on a delivered client report: the
 * headline read
 *
 *     **14 of 100 on the first run. This is the baseline.**
 *     - **Visibility index:** 14 of 100
 *     - **Answers naming or citing you:** 3 of 21
 *
 * while the UVI block further down printed **9 / 100**. Two different
 * quantities under one word, five points apart, with the wrong one first.
 * 14 is `aggregateScore().hits / valid` — a share of answers, the same
 * numerator as the count on the very next line. 9 is the weighted composite of
 * four axes. Neither number was wrong; the label was.
 *
 * WHY THE FIXTURE IS SHAPED LIKE THIS. A run where the share and the composite
 * happen to coincide makes every assertion here pass over nothing — the same
 * vacuous green that let three leak tests run for months against fixtures that
 * could not produce the copy they banned. So the seed reproduces the shape that
 * separates them: 21 cells, a few hits, and sentiment/rank measured on one or
 * two cells each. That trips the v2 small-sample guard, which re-normalises the
 * composite over the surviving axes and pulls it away from the plain share.
 * The test asserts the two differ BEFORE it asserts anything about copy — if a
 * future change makes them coincide, this file fails loudly instead of going
 * quietly green.
 *
 * WHAT IT CHECKS, on BOTH surfaces in all three render modes:
 *   1. control — "Unified Visibility Index" is present with its number, and the
 *      word "index" occurs at all. Without this a clean sweep would only prove
 *      the pattern matches nothing.
 *   2. the share is not rendered as "<n> of 100" — index phrasing for a count —
 *      and IS still rendered, as a percentage. Two-sided on purpose: an
 *      absence-only check passes just as happily when the figure disappears.
 *   3. the old label "Visibility index" is gone as a standalone label (it
 *      survives only inside "Unified Visibility Index").
 *
 * What (2) deliberately is NOT: "the share never appears near the word index".
 * The fix includes a sentence that names both numbers precisely in order to
 * CONTRAST them, and a proximity rule would score that sentence as the defect
 * and push the page back towards explaining nothing.
 *
 * Markup, not file: `<style>` and `<script>` are stripped first. A regex over a
 * whole rendered page reads the inlined stylesheet and the embedded bridge
 * payload too — that is how `data-sentiment-scored="(\d+)"` once returned 0 out
 * of a CSS selector while the attribute said 1.
 *
 * Mutation-sanity (each MUST go red, verified 2026-09-21):
 *   - restore `label: 'Visibility index'` in lib/report/run-metrics.js → (3) on
 *     both surfaces.
 *   - restore `fig(M.index, 100)` in lib/report/sections.js → (2) on markdown.
 *   - restore `denom: '/ 100'` and the literal value on the KPI card in
 *     lib/report/html.js → (2) on html.
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
  offlineFetchEnv,
} from './_helpers.js';

const DOMAIN = 'testbrand.com';
const KEYS = offlineFetchEnv();

/** A measured cell in the shape the run loop writes. */
const cell = (i, extra = {}) => ({
  query: `Q${i}`, queryText: `q${i}`, provider: 'openai', label: 'ChatGPT',
  model: 'gpt-5-search-api', mode: 'web', mention: 'no', position: null,
  citationCount: 0, canonicalCitations: [], competitors: [], competitorsUnverified: [],
  responseQuality: 'ok', hasBrandInCitations: false, elapsedMs: 10,
  ...extra,
});

/**
 * 21 cells, 3 of them naming the brand, sentiment on 2 and rank on 1 — the
 * shape that makes the plain share and the guarded composite disagree.
 */
function seed(dir) {
  const today = todayDateString();
  const dd = responsesDateDir(dir, DOMAIN, today);
  mkdirSync(dd, { recursive: true });

  const results = [];
  for (let i = 1; i <= 21; i++) results.push(cell(i));
  results[0] = cell(1, {
    mention: 'yes', position: 3, responseExcerpt: 'TestBrand is listed third.',
    sentiment: { label: 'positive', confidence: 'high' },
  });
  results[1] = cell(2, {
    mention: 'yes', responseExcerpt: 'TestBrand is mentioned.',
    sentiment: { label: 'positive', confidence: 'high' },
  });
  results[2] = cell(3, { mention: 'yes', responseExcerpt: 'TestBrand again.' });

  writeFileSync(join(dd, '_summary.json'), JSON.stringify({
    date: today, brand: 'TestBrand', domain: DOMAIN,
    score: 14, mentions: 3, total: 21, errors: 0, results,
  }));

  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand', domain: DOMAIN, queries: ['q1'],
    providers: { openai: { model: 'gpt-5-search-api', env: 'OPENAI_API_KEY' } },
  }));
  return today;
}

function render(dir, today, extraArgs = []) {
  const r = spawnCli(['report', '--no-open', ...extraArgs], { cwd: dir, env: KEYS });
  assertExitCode(r, 0, `report ${extraArgs.join(' ')} should exit 0`);
  const at = reportsDateDir(dir, DOMAIN, today);
  return {
    html: readFileSync(join(at, 'report.html'), 'utf-8'),
    md: readFileSync(join(at, 'report.md'), 'utf-8'),
  };
}

/** Visible copy only: no stylesheet, no script, no tags, whitespace collapsed. */
function visibleText(markup) {
  return markup
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/** The composite, read off the rendered UVI block rather than recomputed. */
function renderedUvi(html) {
  const m = html.match(/score-block-num[^>]*>(\d+)</);
  assert.ok(m, 'the UVI score block must render a number — without it there is no control');
  return Number(m[1]);
}

/** Every ±N-character window around the word "index" in visible copy. */
function indexWindows(text, radius = 90) {
  const out = [];
  for (const m of text.matchAll(/index/gi)) {
    out.push(text.slice(Math.max(0, m.index - radius), m.index + radius));
  }
  return out;
}

for (const [mode, args] of [
  ['default', []],
  ['--public', ['--public']],
  ['--white-label', ['--white-label']],
]) {
  test(`${mode}: the share of answers is published as a share, not as a score out of a scale`, async () => {
    await withTmpProject(`aeo-e2e-index-word-${mode.replace(/\W+/g, '')}-`, async (dir) => {
      const today = seed(dir);
      const { html, md } = render(dir, today, args);

      const uvi = renderedUvi(html);
      const share = 14;

      // Fixture sanity FIRST: on a run where the two coincide every assertion
      // below is vacuous, so that case must fail here rather than pass quietly.
      assert.notEqual(
        share, uvi,
        `the seed must keep the share and the composite apart; both read ${uvi}`,
      );

      for (const [surface, markup] of [['html', html], ['md', md]]) {
        const text = visibleText(markup);
        const windows = indexWindows(text);

        // (1) Control — the pattern finds something it is supposed to find.
        assert.ok(
          windows.length > 0,
          `${surface}: no occurrence of "index" at all — the sweep below would prove nothing`,
        );
        assert.match(
          text, /Unified Visibility Index/,
          `${surface}: the composite's own heading must survive in every mode`,
        );

        // (2) The defect itself: the share rendered in index phrasing. This is
        // the exact string the delivered report carried — "14 of 100" in the
        // headline and again in the bullet — and it is what makes a share read
        // as a score out of a scale.
        //
        // Deliberately NOT "the share never appears near the word index": the
        // fix includes a sentence that names both numbers in order to
        // CONTRAST them ("two different measurements of the same run"), and a
        // proximity rule would call that sentence a defect and push the page
        // back towards saying nothing.
        assert.doesNotMatch(
          text, new RegExp(`${share} of 100`),
          `${surface}: the share is still rendered as "${share} of 100" — index phrasing for a count`,
        );
        // Two-sided: it must be rendered SOME way, as a percentage.
        assert.match(
          text, new RegExp(`${share}%`),
          `${surface}: the share must still be published, as a percentage`,
        );

        // (3) The old label is gone except inside the composite's own name.
        const bare = text.replace(/Unified Visibility Index/g, ' ');
        assert.doesNotMatch(
          bare, /Visibility index/i,
          `${surface}: "Visibility index" still labels something other than the composite`,
        );
      }
    });
  });
}
