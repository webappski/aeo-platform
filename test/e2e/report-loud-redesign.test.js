/**
 * E2E — the 2026-08 loud report redesign, through the real `report` command.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The redesign landed as eight new modules (trend-model, answer-history,
 * run-metrics, loud, comparison-segments, comparison-drivers, run-comparison)
 * covered only by unit tests calling `renderHtml` directly. Every one of those
 * tests passes on a renderer that the CLI no longer reaches, or on a snapshot
 * shape the CLI never writes. This file drives the same behaviour the way a
 * client gets it: real `_summary.json` files on disk, the real `report`
 * subprocess, the real report.html + report.md it writes.
 *
 * What it pins:
 *   1. The degradation ladder end to end (N=1 / 2 / 3 / 8) — a young account
 *      must not be shown a trend line through two points, and an old one must
 *      not be shown a smear of dots.
 *   2. `--white-label` stops at Diagnostics and withholds the advisory KPI.
 *   3. The HTML report and the markdown report state the SAME verdict and the
 *      SAME lift aggregate — the drift the shared model in run-metrics.js
 *      exists to prevent, checked at the surface rather than at the model.
 *
 * ZERO paid API calls: seeded `_summary.json` files mean the `run` command is
 * never invoked, and `offlineFetchEnv()` fails every outbound HTTP request in
 * the subprocess (crawlability / authority / sameAs probes) deterministically.
 * The report tolerates all of them being unavailable — that is the offline
 * behaviour under test as much as it is the sandbox.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  offlineFetchEnv,
  responsesDateDir,
  reportsDateDir,
} from './_helpers.js';

const DOMAIN = 'testbrand.com';
const ENV = offlineFetchEnv({
  OPENAI_API_KEY: 'test-key-do-not-use-real',
  GEMINI_API_KEY: 'test-key-do-not-use-real',
});

const ENGINES = [
  { provider: 'openai', label: 'ChatGPT', model: 'gpt-5' },
  { provider: 'gemini', label: 'Gemini', model: 'gemini-3.5-flash' },
];

/** Dates are fixed and dense so the run ORDER is the directory sort order. */
const dateOfRun = (i) => `2026-03-${String(i + 1).padStart(2, '0')}`;

/**
 * One run's `_summary.json`, shaped like the file `run` writes.
 *
 * `mentionAt(engineIndex, runIndex)` decides each cell, so a caller shapes a
 * loss, a hold or a cited-only answer without hand-writing every row.
 */
function summaryFor(runIndex, score, mentionAt) {
  const date = dateOfRun(runIndex);
  const results = ENGINES.map((e, ei) => ({
    query: 'Q1', queryText: 'best test tools',
    provider: e.provider, label: e.label, model: e.model, mode: 'web',
    mention: mentionAt(ei, runIndex),
    position: null,
    citationCount: 1,
    canonicalCitations: ['https://testbrand.com/a', 'https://g2.com/x'],
    competitors: ['RivalCo'],
    responseQuality: 'ok',
    hasBrandInCitations: true,
    responseExcerpt: 'An answer about test tools.',
    elapsedMs: 10, inputTokens: 10, outputTokens: 10, costUsd: 0,
  }));
  return {
    date, brand: 'TestBrand', domain: DOMAIN, score,
    mentions: results.filter(r => r.mention === 'yes').length,
    total: results.length,
    errors: 0,
    sessionCostUsd: 0,
    // Present so the report renders its Actions section from stored data
    // instead of reaching for the LLM recommendation pass.
    llmActions: [
      { title: 'Publish a comparison page', detail: 'Target the query a rival wins.', priority: 'high', kind: 'gap' },
    ],
    topCompetitors: [{ name: 'RivalCo', count: 1 }],
    topDomains: [
      { host: DOMAIN, count: 2, share: 0.5 },
      { host: 'g2.com', count: 2, share: 0.5 },
    ],
    topCanonicalSources: [{ url: 'https://g2.com/x', count: 2 }],
    results,
  };
}

/**
 * Seed a project with `n` dated runs and a minimal config, then return the date
 * of the newest run — the directory the report is written into.
 *
 * @param {string} dir            tmp project root
 * @param {number} n              number of runs on record
 * @param {object} [opts]
 * @param {(runIndex:number)=>number} [opts.scoreAt]     per-run score
 * @param {(engineIndex:number, runIndex:number)=>string} [opts.mentionAt]
 */
function seedRuns(dir, n, opts = {}) {
  const scoreAt = opts.scoreAt || ((i) => 50 + i);
  // Default: every cell holds, except the newest run's Gemini answer, which is
  // lost. That is the case the verdict headline is built to describe.
  const mentionAt = opts.mentionAt
    || ((ei, ri) => (ri === n - 1 && ei === 1 ? 'no' : 'yes'));

  for (let i = 0; i < n; i++) {
    const dd = responsesDateDir(dir, DOMAIN, dateOfRun(i));
    mkdirSync(dd, { recursive: true });
    writeFileSync(
      join(dd, '_summary.json'),
      JSON.stringify(summaryFor(i, scoreAt(i), mentionAt)),
    );
  }
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: DOMAIN,
    queries: ['best test tools'],
    providers: {
      openai: { model: 'gpt-5', classifyModel: 'gpt-5-mini', env: 'OPENAI_API_KEY' },
    },
  }));
  return dateOfRun(n - 1);
}

/** Run `report` and read back both rendered files. */
function renderReport(dir, latestDate, extraArgs = []) {
  const r = spawnCli(['report', '--no-open', ...extraArgs], { cwd: dir, env: ENV });
  assertExitCode(r, 0, `report ${extraArgs.join(' ')} should exit 0`);
  const out = reportsDateDir(dir, DOMAIN, latestDate);
  return {
    html: readFileSync(join(out, 'report.html'), 'utf-8'),
    md: readFileSync(join(out, 'report.md'), 'utf-8'),
  };
}

const countOf = (s, re) => (s.match(re) || []).length;

/** The verdict headline, as text, from each surface. */
const htmlHeadline = (html) =>
  (/<h1 class="lr-hero-title">([\s\S]*?)<\/h1>/.exec(html)?.[1] || '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const mdHeadline = (md) =>
  (/## The run in one page\s*\n\s*\n\*\*([\s\S]*?)\*\*/.exec(md)?.[1] || '')
    .replace(/\s+/g, ' ').trim();

// ─── 1. The degradation ladder, through the CLI ─────────────────────────────

test('ladder N=1 — a first run states its score and draws no comparison', async () => {
  await withTmpProject('aeo-e2e-loud-n1-', async (dir) => {
    const latest = seedRuns(dir, 1, { mentionAt: () => 'yes' });
    const { html, md } = renderReport(dir, latest);

    assert.equal(countOf(html, /class="lr-chip"/g), 0, 'a first run has nothing to compare against');
    assert.equal(countOf(html, /class="lr-chart"/g), 0, 'one point is not a line');
    assert.equal(countOf(html, /class="lr-dots"/g), 0, 'one run is not a record');
    assert.match(html, /on the first run/, 'the hero must state the score, not a change');
    assert.match(html, /Movement is not called until run 3/,
      'silence about movement must be explained, not left as an absence');
    assert.match(md, /on the first run/, 'the markdown surface must say the same');
  });
});

test('ladder N=2 — a delta is drawn, a trend is not', async () => {
  await withTmpProject('aeo-e2e-loud-n2-', async (dir) => {
    const latest = seedRuns(dir, 2);
    const { html } = renderReport(dir, latest);

    assert.ok(countOf(html, /class="lr-chip"/g) > 0, 'a delta exists at two runs');
    assert.equal(countOf(html, /class="lr-chart"/g), 0, 'two points are a delta, not a trend');
    assert.equal(countOf(html, /class="lr-dots"/g), 0, 'no per-answer record marks yet');
    assert.doesNotMatch(html, /since day 1/, 'the baseline caption would restate the same delta');
  });
});

test('ladder N=3 — the whole pattern switches on at once', async () => {
  await withTmpProject('aeo-e2e-loud-n3-', async (dir) => {
    const latest = seedRuns(dir, 3);
    const { html } = renderReport(dir, latest);

    assert.ok(countOf(html, /class="lr-chip"/g) > 0, 'chips still drawn');
    assert.equal(countOf(html, /class="lr-chart"/g), 1, 'the dated chart appears exactly once');
    assert.ok(countOf(html, /class="lr-dots"/g) > 0, 'per-answer record marks appear');
    assert.match(html, /since day 1/, 'the baseline caption appears');
  });
});

test('ladder N=8 — one full-size mark per run, nothing hidden', async () => {
  await withTmpProject('aeo-e2e-loud-n8-', async (dir) => {
    const latest = seedRuns(dir, 8);
    const { html } = renderReport(dir, latest);

    assert.match(html, /class="lr-dots" data-size="md"/, 'marks stay full size below ten runs');
    const strip = /<span class="lr-dots"[^>]*>([\s\S]*?)<\/span>\s*<p/.exec(html);
    assert.ok(strip, 'no record strip found');
    assert.equal(countOf(strip[1], /class="lr-dot"/g), 8, 'one mark per run');
    assert.doesNotMatch(html, /class="lr-dots-more"/, 'nothing is hidden at eight runs');
    // The chart must not print eight identical labels on top of each other.
    const chart = /<svg class="lr-chart"[\s\S]*?<\/svg>/.exec(html);
    assert.ok(chart, 'chart missing at eight runs');
    assert.ok(countOf(chart[0], /class="lr-chart-axis"/g) >= 2,
      'the first and last dates must survive any label thinning');
  });
});

test('the where-to-act line survives every rung — "none" is stated, never omitted', async () => {
  for (const n of [1, 3, 8]) {
    await withTmpProject(`aeo-e2e-loud-act-${n}-`, async (dir) => {
      const latest = seedRuns(dir, n);
      const { html, md } = renderReport(dir, latest);
      assert.ok(countOf(html, /class="lr-act-label">Where to act/g) > 0,
        `N=${n}: "no finding" and "no finding large enough" must not look the same`);
      assert.match(md, /\*\*Where to act\.\*\*/, `N=${n}: the markdown callout vanished`);
    });
  }
});

// ─── 2. White-label ends at Diagnostics ─────────────────────────────────────

test('--white-label ends the deliverable at Diagnostics and withholds the advisory KPI', async () => {
  await withTmpProject('aeo-e2e-loud-wl-', async (dir) => {
    // Seed a cited-not-named answer so the lift KPI has a non-zero figure to
    // withhold — a zero would make the assertion pass for the wrong reason.
    const latest = seedRuns(dir, 3, {
      mentionAt: (ei, ri) => (ei === 1 ? (ri === 2 ? 'src' : 'yes') : 'yes'),
    });
    const plain = renderReport(dir, latest);
    const wl = renderReport(dir, latest, ['--white-label']);

    // Two-sided: the surfaces must be PRESENT in the default report, or the
    // absence below proves nothing.
    assert.match(plain.html, /id="actions"/, 'default report should carry the internal Actions section');
    assert.match(plain.html, /Lift opportunities/, 'default hero should carry the lift KPI');
    assert.match(plain.html, /class="lr-hero-kpis" data-count="4"/, 'default hero carries four KPIs');

    assert.doesNotMatch(wl.html, /id="actions"/, 'the internal Actions section leaked into white-label');
    assert.doesNotMatch(wl.html, /Recommended actions/, 'the recommendation block leaked into white-label');
    assert.doesNotMatch(wl.html, /Lift opportunities/, 'the advisory KPI leaked into white-label');
    assert.doesNotMatch(wl.html, /shortest lift/, 'the advisory sentence leaked into white-label');
    assert.match(wl.html, /class="lr-hero-kpis" data-count="3"/,
      'white-label must still carry the three statistical KPIs');
    // Diagnostics is the last section a client deliverable renders — and the
    // rail must agree, because a rail entry pointing at a section that is not
    // there reads as a broken build rather than as a withheld section.
    assert.match(wl.html, /id="diagnostics"/, 'white-label must keep Diagnostics');
    const lastRailOf = (html) => [...html.matchAll(/<a href="#([a-z-]+)"[^>]*><span class="rail-num">/g)].pop()?.[1];
    assert.equal(lastRailOf(plain.html), 'actions', 'the default report should end on Actions');
    assert.equal(lastRailOf(wl.html), 'diagnostics', 'the white-label rail must end on Diagnostics');
    // The statistics themselves survive — this is still a real report.
    assert.match(wl.html, /class="lr-hero-title"/, 'white-label lost its verdict headline');
    assert.match(wl.md, /## The run in one page/, 'white-label markdown lost the run verdict');
  });
});

test('the lift CTA is internal-only — present in the default markdown, withheld from white-label markdown', async () => {
  // The MARKDOWN twin of the assertion above. The HTML report withholds the
  // whole lift KPI card from a client; markdown keeps the figure and drops one
  // clause, because a client snapshot that silently loses a statistic reads as
  // a broken report. Both halves come from run-metrics.buildLiftNarrative, so
  // this also pins that the split is wired to the white-label flag rather than
  // to the surface — the gap that made the markdown report state a figure the
  // HTML report explained.
  await withTmpProject('aeo-e2e-loud-md-cta-', async (dir) => {
    const latest = seedRuns(dir, 3, {
      mentionAt: (ei, ri) => (ei === 1 ? (ri === 2 ? 'src' : 'yes') : 'yes'),
    });
    const plain = renderReport(dir, latest);
    const wl = renderReport(dir, latest, ['--white-label']);

    // Two-sided: present by default, or the absence below proves nothing.
    assert.match(plain.md, /- \*\*Cited without being named:\*\* 1 of 2/,
      'the default markdown lost the lift aggregate');
    assert.match(plain.md, /shortest lift on this report is being named in the answer itself/,
      'the default markdown states the figure but withholds the next step the HTML hero gives');
    assert.match(plain.html, /shortest lift/, 'the default HTML hero lost the CTA this test compares against');

    // Withheld from the client deliverable — the figure stays, the advice goes.
    // The advisory scan is scoped to this section: the whole-file advisory ban
    // is the leak-free suite's job (report-whitelabel-leakfree.test.js), and a
    // whole-file scan here would go red for another section's regression.
    const verdictOf = (md) => md.split('## The run in one page')[1]?.split('\n## ')[0] ?? '';
    assert.ok(verdictOf(wl.md).length > 0, 'the white-label run verdict section is missing entirely');
    assert.doesNotMatch(wl.md, /shortest lift/, 'the advisory sentence leaked into white-label markdown');
    assert.doesNotMatch(verdictOf(wl.md), /\bpitch|outreach|recommend/i,
      'advisory copy leaked into the white-label run verdict');
    assert.match(wl.md, /- \*\*Cited without being named:\*\* 1 of 2/,
      'white-label lost the statistic, not just the advice');
    assert.match(wl.md, /1 of 2 answers cites your domain as a source without naming you/,
      'white-label must still say what the figure counts');
  });
});

// ─── 3. The two surfaces state one verdict ──────────────────────────────────

test('HTML and markdown state the SAME verdict headline for the same run pair', async () => {
  await withTmpProject('aeo-e2e-loud-agree-', async (dir) => {
    // Score falls AND an engine drops an answer: the branch where the two
    // surfaces have the most wording to disagree about.
    const latest = seedRuns(dir, 2, { scoreAt: (i) => (i === 0 ? 50 : 41) });
    const { html, md } = renderReport(dir, latest);

    const fromHtml = htmlHeadline(html);
    const fromMd = mdHeadline(md);
    assert.ok(fromHtml.length > 0, 'HTML headline not found');
    assert.ok(fromMd.length > 0, 'markdown headline not found');
    assert.equal(fromHtml, fromMd,
      'the two surfaces describe the same run differently — the shared verdict model drifted');
    // And it is the RIGHT verdict, not two copies of the same wrong one.
    assert.match(fromHtml, /^Down 9 points\./, 'the delta must be the 50 -> 41 fall');
    assert.match(fromHtml, /Gemini dropped an answer it had held before\./,
      'the engine that lost the answer must be named');
  });
});

test('a rise with a loss keeps the same joining word on both surfaces', async () => {
  await withTmpProject('aeo-e2e-loud-agree-up-', async (dir) => {
    // The index rises in the same run an engine drops an answer: "Up N points.
    // X dropped an answer" reads as a contradiction, so both surfaces must
    // reach for the same joining clause.
    const latest = seedRuns(dir, 2, { scoreAt: (i) => (i === 0 ? 50 : 59) });
    const { html, md } = renderReport(dir, latest);
    assert.equal(htmlHeadline(html), mdHeadline(md), 'the surfaces disagree on the joining clause');
    assert.match(htmlHeadline(html), /^Up 9 points overall — but Gemini dropped an answer/);
  });
});

test('a first run reads as a baseline on both surfaces, not as a change', async () => {
  await withTmpProject('aeo-e2e-loud-agree-first-', async (dir) => {
    const latest = seedRuns(dir, 1, { mentionAt: () => 'yes' });
    const { html, md } = renderReport(dir, latest);
    assert.equal(htmlHeadline(html), mdHeadline(md));
    assert.match(htmlHeadline(html), /^\d+ of 100 on the first run\. This is the baseline\.$/);
  });
});

test('both surfaces count the same lift opportunities', async () => {
  await withTmpProject('aeo-e2e-loud-lift-', async (dir) => {
    // One of the two answers cites the domain without naming the brand.
    const latest = seedRuns(dir, 2, {
      mentionAt: (ei, ri) => (ei === 1 && ri === 1 ? 'src' : 'yes'),
    });
    const { html, md } = renderReport(dir, latest);

    const kpi = /Lift opportunities<\/span>\s*<div class="lr-kpi-row">\s*<span class="lr-kpi-num">(\d+)<\/span>\s*<span class="lr-kpi-denom">\/ (\d+)<\/span>/.exec(html);
    assert.ok(kpi, 'the aggregate lift KPI is missing from the hero');
    assert.equal(kpi[1], '1', 'one answer cites the domain without naming the brand');
    assert.equal(kpi[2], '2', 'the denominator is every answer measured this run');
    assert.match(html, /1 of 2 answers cites your domain as a source without naming you/,
      'the KPI must say what it counts, not print a bare number');
    assert.match(html, /shortest lift/, 'the KPI must carry a next step, not only a figure');

    const mdLine = /- \*\*Cited without being named:\*\* (\d+) of (\d+)/.exec(md);
    assert.ok(mdLine, 'the markdown run verdict does not state the lift aggregate');
    assert.equal(mdLine[1], kpi[1], 'the two surfaces disagree about how many answers cite without naming');
    assert.equal(mdLine[2], kpi[2], 'the two surfaces disagree about the denominator');
  });
});

test('a run where nothing is cited-only reads as a success state, not as a gap', async () => {
  await withTmpProject('aeo-e2e-loud-lift-clean-', async (dir) => {
    const latest = seedRuns(dir, 2, { mentionAt: () => 'yes' });
    const { html, md } = renderReport(dir, latest);
    assert.match(html, /Lift opportunities/, 'the KPI must render on every run, not only a non-zero one');
    assert.match(html, /success state/, 'zero cited-only answers with namings present is a success state');
    assert.match(md, /- \*\*Cited without being named:\*\* 0 of 2/);
    assert.match(md, /Every answer that cites your domain also names you/);
  });
});
