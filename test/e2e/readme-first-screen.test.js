/**
 * E2E — the first screen of the README: install before run, a Contents list that
 * covers every section, and a cost figure that says what it measures (AEO24-AP-3).
 *
 * Why this file exists. On 2026-10-24 a visitor reading the README top-down met
 * `aeo-platform init` at character 3 525 and the first install command at 7 826
 * (so the first thing they were told to run was a command they might not have),
 * there was no table of contents in a 1 000-line page, and the cost was "a few
 * cents per week" while the one run we had priced came to about $0.21. Each of
 * those is a claim or a structure a rewrite can silently undo, so each is pinned:
 *
 *   - install-order: `npm install -g aeo-platform` comes before the first
 *     `aeo-platform init`;
 *   - contents: the README has a `## Contents`, and the set of anchors it links
 *     to equals the set of the other `##` headings — a new section without a
 *     link, or a link to a renamed heading, is red. The check compares ANCHORS,
 *     not link text, so labels stay short;
 *   - few-cents: "a few cents" appears in neither the README nor
 *     docs/quickstart.md (where the Cost notes now live);
 *   - cost-figure: the "≈$X per run (…)" figure is stated in both places and is
 *     the same number. The number comes from the recomputation kept with the
 *     card (cost-per-run.json: 3 questions × OpenAI + Gemini, token counts of the
 *     19 June 2026 run at the prices in lib/providers/pricing.js on 24 October
 *     2026). It is dated and scoped in the sentence itself, because a bare cost
 *     number is a guess.
 *
 * MUTATION-SANITY: the `MUTANTS` table at the bottom feeds one broken README per
 * pin to the same checker; a pin that stops firing turns its own mutant red.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_helpers.js';

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
const QUICKSTART = readFileSync(join(REPO_ROOT, 'docs', 'quickstart.md'), 'utf-8');

/** GitHub's heading anchor (same rule as readme-npm-budget.test.js): lowercase, punctuation dropped, each space a hyphen. */
function slug(heading) {
  return heading.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

/** `≈$0.21` out of "≈$0.21 per run (…" — null when the sentence is absent. */
function costFigure(text) {
  return text.match(/≈\$(\d+\.\d{2}) per run \(/)?.[1] ?? null;
}

export function firstScreenProblems(readme, quickstart) {
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });

  const install = readme.indexOf('npm install -g aeo-platform');
  const firstInit = readme.indexOf('aeo-platform init');
  if (install === -1 || firstInit === -1 || install > firstInit) {
    add('install-order', `"npm install -g aeo-platform" (at ${install}) must come before the first "aeo-platform init" (at ${firstInit})`);
  }

  const start = readme.indexOf('\n## Contents\n');
  if (start === -1) {
    add('contents', 'the README has no "## Contents"');
  } else {
    const after = readme.indexOf('\n## ', start + 1);
    const block = readme.slice(start, after === -1 ? readme.length : after);
    const linked = [...block.matchAll(/\]\(#([^)\s]+)\)/g)].map(m => m[1]);
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map(m => m[1]).filter(h => h !== 'Contents').map(slug);
    const missing = headings.filter(a => !linked.includes(a));
    const extra = linked.filter(a => !headings.includes(a));
    if (missing.length || extra.length || new Set(linked).size !== linked.length) {
      add('contents', `Contents links and "##" headings differ — headings without a link: [${missing}]; links without a heading: [${extra}]`);
    }
  }

  for (const [name, text] of [['README.md', readme], ['docs/quickstart.md', quickstart]]) {
    if (/few cents/i.test(text)) add('few-cents', `${name} still says "a few cents"`);
  }

  const a = costFigure(readme);
  const b = costFigure(quickstart);
  if (!a || !b || a !== b) {
    add('cost-figure', `the "≈$X per run (…)" figure must be stated in README.md (${a}) and docs/quickstart.md (${b}) and be the same`);
  }

  return problems;
}

const codes = (readme, quickstart = QUICKSTART) => firstScreenProblems(readme, quickstart).map(p => p.code);

test('the README first screen: install before run, Contents for every section, a dated cost figure', () => {
  const problems = firstScreenProblems(README, QUICKSTART);
  assert.deepEqual(problems, [], problems.map(p => `${p.code}: ${p.detail}`).join('\n'));
});

const MUTANTS = [
  ['a "##" heading with no Contents link', (r) => `${r}\n## Extra section\n`, 'contents'],
  ['a Contents link removed', (r) => r.replace(/^- \[FAQ\]\(#faq\)\n/m, ''), 'contents'],
  ['a Contents link to a heading that was renamed', (r) => r.replace('](#faq)', '](#faqs)'), 'contents'],
  ['"## Contents" deleted', (r) => r.replace(/^## Contents\n[\s\S]*?(?=^## How to run it)/m, ''), 'contents'],
  ['"aeo-platform init" before the install command', (r) => `aeo-platform init\n${r}`, 'install-order'],
  ['"a few cents" back in the README', (r) => `${r}\nIt costs a few cents per week.\n`, 'few-cents'],
  ['the README figure differs from the quickstart figure', (r) => r.replace(/≈\$(\d+\.\d{2}) per run \(/, '≈$9.99 per run ('), 'cost-figure'],
];

for (const [name, mutate, expected] of MUTANTS) {
  test(`mutant "${name}" is caught by the "${expected}" pin`, () => {
    assert.ok(!codes(README).includes(expected), `the real README already trips "${expected}"`);
    assert.ok(
      codes(mutate(README)).includes(expected),
      `the README with "${name}" must trip the "${expected}" pin, got [${codes(mutate(README))}]`,
    );
  });
}

test('mutant "a few cents back in docs/quickstart.md" is caught by the "few-cents" pin', () => {
  assert.ok(!codes(README).includes('few-cents'));
  assert.ok(codes(README, `${QUICKSTART}\nroughly a few cents\n`).includes('few-cents'));
});
