/**
 * E2E — the README must fit the document the npm registry stores for it.
 *
 * Why this file exists. `registry.npmjs.org/aeo-platform` keeps the README in a
 * `readme` field that is cut at exactly 65 536 characters, mid-word. On
 * 2026-10-24 the README was 106 435 characters: 18 FAQ questions were reduced to
 * 2, and Limitations, Roadmap, Migrating, the full quickstart and License sat
 * past the cut. Nothing in the repo noticed, because every README test asserts
 * what the README SAYS, not how big it is. The limit is a property of the
 * registry, so the pin has to live next to the file: a README that grows past
 * the budget goes red here, before it ships.
 *
 * Budget: 62 000, not 65 536 — the margin covers the few characters a registry
 * re-render adds, and keeps room for the next section. The README has no
 * character outside the BMP, so `String.length` (UTF-16 units) equals the
 * number of characters the registry counts.
 *
 * Reference docs that used to live in the README now live in `docs/` and
 * `CONTRIBUTING.md`. Those directories are NOT in `package.json` `files`, so
 * the published README cannot link to them relatively (the npm page would 404).
 * Every link into the repository is therefore an absolute GitHub URL, and the
 * "dead link" pin below checks that each such URL points at a file that exists
 * in this tree.
 *
 * One name per artifact (1.17.1): the free paste-into-AI result is the "30-day
 * AEO plan"; "30-mission plan" is the paid Webappski Plan. The "naming" pin keeps
 * the README from calling the free result by the paid one's name again.
 *
 * MUTATION-SANITY: the `MUTANTS` table at the bottom feeds one broken README
 * per pin to the same checker. A pin that stops firing makes its own mutant
 * test go red, so the pins cannot rot silently.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_helpers.js';

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');

/** Character count of the registry's `readme` field the README must stay under. */
export const BUDGET = 62000;
const BLOB = 'https://github.com/webappski/aeo-platform/blob/main/';

/**
 * Every way the README can leave the shape the registry and the repo layout
 * need. Returns `[{ code, detail }]`; empty means the README is fine.
 */
export function readmeProblems(text, root = REPO_ROOT) {
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });

  if (text.length > BUDGET) {
    add('budget', `README is ${text.length} characters, the budget is ${BUDGET} ` +
      `(the registry cuts the field at 65 536)`);
  }

  const faq = [...text.matchAll(/^## FAQ$/gm)].map(m => m.index);
  const license = text.search(/^## License$/m);
  if (faq.length !== 1) add('faq', `expected exactly one "## FAQ", found ${faq.length}`);
  else if (license !== -1 && faq[0] > license) add('faq', '"## FAQ" must come before "## License"');

  if (/"@graph"/.test(text) || /```json\n[^`]*"@context"/.test(text)) {
    add('graph', 'a Schema.org @graph / @context block is back: on npm and GitHub a ```json ' +
      'fence is text, not markup, and it is the single largest thing in the file');
  }

  const relative = text.match(/\]\((?:\.\/)?(?:docs\/|CONTRIBUTING)[^)]*\)/g) || [];
  if (relative.length) {
    add('relative-link', `relative link(s) into files outside the package: ${relative.join(', ')} ` +
      `— use ${BLOB}…`);
  }

  if (/^#{2,4}\s+What's new in 1\.0/m.test(text)) {
    add('whats-new', '"What\'s new in 1.0.x" entries belong in CHANGELOG.md, not the README');
  }

  // A count said in words must equal what is counted: "Six concrete reasons"
  // over a list of five went unnoticed for months.
  const why = sectionOf(text, WHY);
  if (!why) {
    // Renaming the heading must not switch the count pin off: an empty section
    // has no sentence to compare and would pass.
    add('reasons-count', `section not found: the README has no "${WHY}" heading, so the count of its reasons is not checked`);
  }
  const said = why.match(/\b(\w+) concrete reasons\b/i);
  if (said) {
    const claimed = NUMBER_WORDS[said[1].toLowerCase()];
    const listed = (why.match(/^- \*\*/gm) || []).length;
    if (claimed !== listed) {
      add('reasons-count', `"${said[0]}" is followed by ${listed} bullets (the sentence says ${claimed ?? 'a number this check does not know'})`);
    }
  }

  // A path on someone's machine in a published README is a leak and a dead end.
  const local = text.match(/(?:~\/Projects\/|\/Users\/)[^\s)>`]*/g);
  if (local) add('local-path', `local filesystem path(s) in the README: ${[...new Set(local)].join(', ')}`);

  // One name per artifact: the free result of this package (the JSON brand-context
  // pasted into your own AI) is the "30-day AEO plan". "30-mission plan" belongs
  // to the paid Webappski Plan, so it may appear only on a line that says so.
  const misnamed = text.split('\n').filter(l => /30-mission/i.test(l) && !/Webappski Plan|€\s?129/i.test(l));
  if (misnamed.length) {
    add('naming', `the free plan is the "30-day AEO plan", not "30-mission" (that is the paid Webappski Plan): ` +
      misnamed.map(l => `"${l.trim().slice(0, 60)}…"`).join(', '));
  }

  const dead = linkProblems(text, root);
  if (dead.length) add('dead-link', `links that lead nowhere: ${dead.join('; ')}`);

  return problems;
}

const WHY = '## Why `aeo-platform`';
const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** One `##` section, heading line to the next `##` (or the end). Empty when absent. */
function sectionOf(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const after = text.indexOf('\n## ', start + 1);
  return text.slice(start, after === -1 ? text.length : after);
}

/** GitHub's heading anchor: lowercase, backticks and punctuation dropped, every space a hyphen. */
function slug(heading) {
  return heading.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

/** Every anchor a markdown file offers: its headings and any explicit `id="…"`. */
function anchorsOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) out.add(slug(m[1]));
  for (const m of text.matchAll(/\bid="([^"]+)"/g)) out.add(m[1]);
  return out;
}

/**
 * Links in `text` that lead nowhere: an in-page `](#anchor)` with no such
 * heading, or an absolute link into this repository whose file does not exist
 * or whose `#fragment` is not a heading of that file.
 */
export function linkProblems(text, root = REPO_ROOT) {
  const out = [];
  const own = anchorsOf(text);
  for (const m of text.matchAll(/\]\(#([^)\s]+)\)/g)) {
    if (!own.has(m[1])) out.push(`#${m[1]} (no such heading in this file)`);
  }
  for (const m of text.matchAll(/\]\(https:\/\/github\.com\/webappski\/aeo-platform\/blob\/main\/([^)#\s]+)(?:#([^)\s]+))?\)/g)) {
    const [, path, fragment] = m;
    const file = join(root, path);
    if (!existsSync(file)) { out.push(`${path} (file does not exist)`); continue; }
    if (fragment && path.endsWith('.md') && !anchorsOf(readFileSync(file, 'utf-8')).has(fragment)) {
      out.push(`${path}#${fragment} (no such heading)`);
    }
  }
  return out;
}

const codes = (text) => readmeProblems(text).map(p => p.code);

test('the README fits the npm registry document and keeps the shape the layout needs', () => {
  const problems = readmeProblems(README);
  assert.deepEqual(problems, [], problems.map(p => `${p.code}: ${p.detail}`).join('\n'));
});

// The files that took README text with them: their links back into the README
// and between each other must resolve too, or a reader of the npm page lands
// on a 404 / a page without the section the summary promised.
for (const file of ['docs/commands.md', 'docs/quickstart.md', 'docs/crawlability-audit.md', 'CONTRIBUTING.md']) {
  test(`${file}: every link into the repository resolves to a file and a heading`, () => {
    const dead = linkProblems(readFileSync(join(REPO_ROOT, file), 'utf-8'));
    assert.deepEqual(dead, [], `${file} has links that lead nowhere: ${dead.join('; ')}`);
  });
}

// ── The package metadata npm shows next to the README (AEO24-AP-4) ─────────────
//
// `description`, `keywords` and `homepage` are what a search on npmjs.com reads
// and what the page header links to. On 2026-10-24 the description carried
// neither "AI visibility" nor "answer engine optimization" (the two phrases the
// category is searched by), the keywords named the free result "30-mission-aeo-
// plan", and `homepage` pointed at GitHub, so the npm page had no path to the
// product page on webappski.com. The README had no link there either, and one
// link still went through a 301 (/blog -> /en/posts).
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
export const HOMEPAGE = 'https://webappski.com/en/aeo-platform';
const NEW_KEYWORDS = ['ai-visibility-tracker', 'ai-visibility-tracking', 'llm-visibility', 'aeo-tracker', 'cli'];

export function metadataProblems(pkg, readme) {
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });

  const d = pkg.description || '';
  if (d.length > 160) add('description', `description is ${d.length} characters, the limit is 160`);
  for (const phrase of ['AI visibility', 'answer engine optimization']) {
    if (!d.toLowerCase().includes(phrase.toLowerCase())) add('description', `description lacks "${phrase}"`);
  }
  if (/30-mission/i.test(d)) add('naming', 'the description calls the free result "30-mission" (that is the paid Webappski Plan)');

  const kw = pkg.keywords || [];
  const lacking = NEW_KEYWORDS.filter(k => !kw.includes(k));
  if (lacking.length) add('keywords', `keywords lack: ${lacking.join(', ')}`);
  if (kw.includes('30-mission-aeo-plan') || !kw.includes('30-day-aeo-plan')) {
    add('keywords', 'the free result is the "30-day-aeo-plan" keyword, not "30-mission-aeo-plan"');
  }

  if (pkg.homepage !== HOMEPAGE) add('homepage', `homepage is ${pkg.homepage}, expected ${HOMEPAGE}`);

  const at = readme.indexOf(HOMEPAGE);
  if (at === -1 || at > 60000) add('product-link', `the README must link ${HOMEPAGE} within its first 60 000 characters (found at ${at})`);
  if (/webappski\.com\/blog\b/.test(readme)) add('blog-link', 'webappski.com/blog is a 301 to /en/posts — link /en/posts');

  return problems;
}

test('the package metadata npm shows (description, keywords, homepage) and the README links to the product page', () => {
  const problems = metadataProblems(PKG, README);
  assert.deepEqual(problems, [], problems.map(p => `${p.code}: ${p.detail}`).join('\n'));
});

const META_MUTANTS = [
  ['the 1.17.0 description (no "AI visibility")', (p, r) => [{ ...p, description: 'Open-source CLI that measures brand visibility across ChatGPT, Claude, Gemini & Perplexity — exports a paste-into-AI 30-mission AEO plan.' }, r], 'description'],
  ['a description over 160 characters', (p, r) => [{ ...p, description: `${p.description}${' x'.repeat(30)}` }, r], 'description'],
  ['"30-mission" in the description', (p, r) => [{ ...p, description: `${p.description} Portable 30-mission plan.` }, r], 'naming'],
  ['the old keyword 30-mission-aeo-plan', (p, r) => [{ ...p, keywords: [...p.keywords.filter(k => k !== '30-day-aeo-plan'), '30-mission-aeo-plan'] }, r], 'keywords'],
  ['a new keyword missing (cli)', (p, r) => [{ ...p, keywords: p.keywords.filter(k => k !== 'cli') }, r], 'keywords'],
  ['homepage back to GitHub', (p, r) => [{ ...p, homepage: 'https://github.com/webappski/aeo-platform#readme' }, r], 'homepage'],
  ['the product-page link removed from the README', (p, r) => [p, r.split(HOMEPAGE).join('https://webappski.com/en/aeo-audit')], 'product-link'],
  ['the product-page link only after 60 000 characters', (p, r) => { const base = r.split(HOMEPAGE).join('https://webappski.com/en/aeo-audit'); return [p, `${base}${' '.repeat(Math.max(0, 60001 - base.length))}\n${HOMEPAGE}\n`]; }, 'product-link'],
  ['the /blog link back', (p, r) => [p, `${r}\n[blog](https://webappski.com/blog)\n`], 'blog-link'],
];

for (const [name, mutate, expected] of META_MUTANTS) {
  test(`mutant "${name}" is caught by the "${expected}" metadata pin`, () => {
    const codesOf = (p, r) => metadataProblems(p, r).map(x => x.code);
    assert.ok(!codesOf(PKG, README).includes(expected), `the real package already trips "${expected}"`);
    const [p, r] = mutate(PKG, README);
    assert.ok(codesOf(p, r).includes(expected), `"${name}" must trip the "${expected}" pin, got [${codesOf(p, r)}]`);
  });
}

/** One broken README per pin. Each is the README with ONE thing put back. */
const MUTANTS = [
  ['+6 000 characters', (t) => t + 'x'.repeat(6000), 'budget'],
  ['relative link back to docs/commands.md', (t) => `${t}\n[commands](docs/commands.md)\n`, 'relative-link'],
  ['relative link back to CONTRIBUTING', (t) => `${t}\n[contributing](CONTRIBUTING.md)\n`, 'relative-link'],
  ['Schema.org block back', (t) => `${t}\n\`\`\`json\n{"@context":"https://schema.org","@graph":[]}\n\`\`\`\n`, 'graph'],
  ['"What\'s new in 1.0.8" back', (t) => `${t}\n### What's new in 1.0.8?\n`, 'whats-new'],
  ['a "Why" bullet deleted ("Six concrete reasons" over five)', (t) => t.replace(/^- \*\*MIT\.\*\*.*\n/m, ''), 'reasons-count'],
  ['"Six" changed to "Seven"', (t) => t.replace('Six concrete reasons', 'Seven concrete reasons'), 'reasons-count'],
  // The heading renamed keeps its slug (`why-aeo-platform`), so no link goes dead and
  // the count pin used to read an empty section and pass: the rename switched it off.
  ['the "## Why `aeo-platform`" heading renamed', (t) => t.replace('\n## Why `aeo-platform`\n', '\n## Why aeo-platform\n'), 'reasons-count'],
  ['a local ~/Projects path in a comment', (t) => `${t}\n<!-- source: ~/Projects/typelessity-landing/aeo-responses/x.json -->\n`, 'local-path'],
  ['"Portable 30-mission plan" for the free result', (t) => `${t}\n- **Portable 30-mission plan** pasted into your AI.\n`, 'naming'],
  ['a second "## FAQ"', (t) => `${t}\n## FAQ\n`, 'faq'],
  ['"## FAQ" after "## License"', (t) => t.replace(/^## FAQ$/m, '## Faq') + '\n## FAQ\n', 'faq'],
  ['link to a docs file that does not exist', (t) => `${t}\n[x](${BLOB}docs/no-such-file.md)\n`, 'dead-link'],
  ['link to a heading the docs file does not have', (t) => `${t}\n[x](${BLOB}docs/commands.md#no-such-heading)\n`, 'dead-link'],
  ['in-page link to a heading the README does not have', (t) => `${t}\n[x](#no-such-heading)\n`, 'dead-link'],
];

for (const [name, mutate, expected] of MUTANTS) {
  test(`mutant "${name}" is caught by the "${expected}" pin`, () => {
    // The unmutated README must pass the pin first, otherwise a mutant that
    // "fails" proves nothing.
    assert.ok(!codes(README).includes(expected), `the real README already trips "${expected}"`);
    assert.ok(
      codes(mutate(README)).includes(expected),
      `the README with "${name}" must trip the "${expected}" pin, got [${codes(mutate(README))}]`,
    );
  });
}
