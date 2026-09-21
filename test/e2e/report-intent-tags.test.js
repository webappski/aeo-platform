/**
 * E2E — intent tags travel from `.aeo-tracker.json` to the rendered report, and
 * the report never dresses them up as a funnel.
 *
 * Why this file exists. The by-tag section shipped in v0.4 and, until 1.15.1,
 * had never rendered in any run on any machine: `init` classified every query it
 * selected (lib/init/research/classify-intent.js) and then dropped the result,
 * so no config ever carried a `tag`, so `r.tag` was always absent and the
 * section's own filter always emptied. Everything downstream of that filter was
 * untested by construction — including a default blurb that read a
 * "high ToFu, zero BoFu" story out of numbers we do not measure. Mapping intent
 * classes onto a funnel model is our judgement about someone's market; printing
 * it beside real percentages presents that judgement as measurement
 * (founder ruling 2026-09-21). Now that init stamps tags, that section reaches
 * clients, so both halves need pinning.
 *
 * TWO-SIDED ON PURPOSE. A tagged-basket-only test would pass just as happily if
 * the string-only form had stopped working, and a string-only test would pass if
 * tags never rendered at all. Old configs are bare strings and must keep running
 * untouched, so each side is asserted against its own run:
 *
 *   A. tagged basket   → results carry `tag` → the Intent section RENDERS with a
 *                        row per class, in markdown AND html.
 *   B. string-only     → run exits 0, report renders, section is ABSENT — the
 *                        graceful dormancy that back-compat depends on.
 *
 * THE FUNNEL BAN IS GUARDED BY A CONTROL. Asserting "the artifact contains no
 * ToFu" proves nothing if the section did not render — which is exactly the
 * state every previous run was in. So side A asserts the section is PRESENT
 * first, and only then that the wording is absent; if the render breaks, the
 * control fails rather than the ban passing vacuously.
 *
 * WHAT THIS FILE DOES NOT COVER. It seeds the tagged config by hand, so it says
 * nothing about `init` WRITING those tags — that path runs the research
 * pipeline, which makes paid LLM calls this repository forbids from a test. The
 * write contract (`stampQueryAxes`) is pinned in test/queries-normalize.test.js
 * against the real module, and the two config-write sites are
 * bin/aeo-tracker.js:1346 / :1358 / :2321.
 *
 * MUTATION-SANITY (each verified RED before commit): restore either old blurb in
 * sections.js, restore the `## Visibility by Funnel Stage / Intent Tag` heading,
 * restore the `By funnel stage` card label, put a funnel word back in the
 * inlined styles.css comments, or drop the per-result `tag` wiring at
 * bin/aeo-tracker.js:3223 — and the corresponding assertion fails.
 *
 * ZERO COST. Replay fixtures + `offlineFetchEnv` (which stubs fetch outright), so
 * no network call is possible, let alone a paid one. The seeded `validationCache`
 * is keyed by query TEXT via `queryText`: seeding the raw entry put an object in
 * that slot for a tagged basket, every lookup missed, and the run fell through to
 * the LIVE validator — measured, and it spent real money before the helper was
 * fixed (2026-09-21).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject, spawnCli, assertExitCode, seedReplayProject, offlineFetchEnv,
  reportsDateDir, responsesDateDir, todayDateString,
} from './_helpers.js';

/** Funnel-stage vocabulary that must not appear in a client-facing artifact. */
const FUNNEL_RE = /\bfunnel\b|\bToFu\b|\bMoFu\b|\bBoFu\b/i;

const QUERY_TEXTS = [
  'best test brands 2026',
  'top test brand alternatives',
  'test brand vs competitor',
];

const ENV = () => offlineFetchEnv({ GEMINI_API_KEY: 'test-key-do-not-use-real' });

/** Replay a seeded project and render both report formats. Returns their text. */
function runAndReport(dir, domain) {
  const env = ENV();
  assertExitCode(
    spawnCli(['run', '--replay', '--replay-from=2026-05-13'], { cwd: dir, env }),
    0, 'replay run should exit 0',
  );
  const summary = JSON.parse(readFileSync(
    join(responsesDateDir(dir, domain, todayDateString()), '_summary.json'), 'utf-8',
  ));
  assertExitCode(
    spawnCli(['report', '--no-open'], { cwd: dir, env }),
    0, 'report should exit 0 after a successful run',
  );
  const dateDir = reportsDateDir(dir, domain, todayDateString());
  const read = (name) => {
    const p = join(dateDir, name);
    assert.ok(existsSync(p), `expected ${name} at ${p}`);
    return readFileSync(p, 'utf-8');
  };
  return { summary, md: read('report.md'), html: read('report.html') };
}

test('a tagged basket segments the report by intent, and never calls it a funnel', async () => {
  await withTmpProject('aeo-e2e-intent-tagged-', async (dir) => {
    const { domain } = seedReplayProject(dir, {
      variant: 'stable',
      queries: [
        { q: QUERY_TEXTS[0], tag: 'commercial' },
        { q: QUERY_TEXTS[1], tag: 'comparison' },
        { q: QUERY_TEXTS[2], tag: 'comparison' },
      ],
    });
    const { summary, md, html } = runAndReport(dir, domain);

    // The wiring: config tag → normalizeQueries → per-result `tag`. Without this
    // the section below could only render empty.
    const tags = summary.results.map(r => r.tag);
    assert.ok(tags.length > 0, 'run produced no results');
    assert.deepEqual(
      [...new Set(tags)].sort(), ['commercial', 'comparison'],
      `every result must carry its query's tag, got ${JSON.stringify(tags)}`,
    );

    // CONTROL — the section actually rendered. Every assertion below is
    // meaningless without this one, because an absent section satisfies a
    // wording ban trivially (and that was the state of this code for four
    // minor versions).
    assert.match(md, /^## Visibility by Intent$/m,
      'markdown report must carry the Intent section heading');
    assert.match(html, /By intent/,
      'html report must carry the intent card label');
    for (const cls of ['commercial', 'comparison']) {
      assert.ok(md.includes(`**${cls}**`), `markdown must carry a row for the ${cls} class`);
    }

    // THE BAN — now non-vacuous.
    for (const [name, text] of [['report.md', md], ['report.html', html]]) {
      const hit = text.match(new RegExp(FUNNEL_RE.source, 'gi'));
      assert.equal(
        hit, null,
        `${name} must not describe intent classes as funnel stages — we do not ` +
        `measure a funnel, and printing one beside real percentages publishes a ` +
        `judgement as a measurement. Found: ${JSON.stringify(hit)}`,
      );
    }
  });
});

test('a string-only basket still runs, and simply carries no intent section', async () => {
  await withTmpProject('aeo-e2e-intent-legacy-', async (dir) => {
    // Exactly the shape every config written before 1.15.1 has on disk.
    const { domain } = seedReplayProject(dir, { variant: 'stable', queries: QUERY_TEXTS });
    const { summary, md, html } = runAndReport(dir, domain);

    assert.ok(summary.results.length > 0, 'run produced no results');
    assert.ok(
      summary.results.every(r => r.tag === undefined || r.tag === null),
      'an untagged basket must not acquire tags on the way through `run`',
    );

    // Dormant, not broken: no heading, no empty bucket, no placeholder row.
    assert.doesNotMatch(md, /^## Visibility by Intent$/m,
      'the intent section must stay hidden when nothing is tagged');
    assert.doesNotMatch(html, /By intent/,
      'the intent card must stay hidden when nothing is tagged');
    // And the report is still a real report, not a husk that happens to lack
    // the section — otherwise this half would pass on a crashed render.
    assert.ok(md.length > 2000, `markdown report looks truncated (${md.length} chars)`);
    assert.match(html, /<\/html>/, 'html report must be complete');
  });
});
