/**
 * E2E — the published methodology must describe the code that actually runs.
 *
 * The README section «How we count visibility» is the public answer to «why
 * should I trust this number?». A methodology page that drifts from the engine
 * is worse than no page at all: it converts an honest gap into a false claim.
 *
 * So every load-bearing number and rule in that section is pinned here AGAINST
 * THE REAL MODULES — not against a copy of the numbers. Change `MAX_SAMPLES`,
 * a UVI weight, the prose-rank discount, or the mention taxonomy without
 * updating the README, and this file goes red naming the sentence that became
 * a lie.
 *
 * Two of these pins close a PRE-EXISTING hole: the UVI weights table (README
 * lines ~368-373) and the sampling default were previously documented prose
 * with nothing holding them to `lib/`.
 *
 * Pure file read + pure function calls — no fixtures, no subprocess, no mocks
 * (R37: there is no behaviour here that a heavier harness would measure better).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_helpers.js';

import { resolveSamples, MAX_SAMPLES } from '../../lib/sampling.js';
import { detectMention } from '../../lib/mention.js';
import { isOwnDomain } from '../../lib/report/own-domain.js';
import {
  perCellPresence,
  computeComponents,
  computeUVIBreakdown,
} from '../../lib/report/visibility-index.js';

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
const VISIBILITY_INDEX_SRC = readFileSync(
  join(REPO_ROOT, 'lib', 'report', 'visibility-index.js'), 'utf-8');

const HEADING = '## How we count visibility';

/** The methodology section only — so a coincidental match elsewhere in a
 *  1000-line README cannot make one of these assertions pass by accident. */
function methodologySection() {
  const start = README.indexOf(`\n${HEADING}\n`);
  assert.notEqual(start, -1, `README must contain the section heading "${HEADING}"`);
  const after = README.indexOf('\n## ', start + 1);
  return README.slice(start, after === -1 ? README.length : after);
}

const SECTION = methodologySection();

test('the methodology section exists and is substantive', () => {
  assert.ok(
    SECTION.length > 2000,
    `«${HEADING}» is present but only ${SECTION.length} chars — a stub is not a methodology`,
  );
  // Anchor stability: everything (the flags table, the comparison section) links
  // to #how-we-count-visibility. A renamed heading silently breaks those links.
  assert.ok(
    README.includes('](#how-we-count-visibility)'),
    'the README must link to #how-we-count-visibility — the anchor is the point of the section',
  );
});

test('«one API call per cell» is what resolveSamples actually defaults to', () => {
  assert.ok(
    SECTION.includes('exactly one API call per cell'),
    'the section must state the run count outright, not imply it',
  );
  // The claim, checked against the resolver every run goes through.
  assert.equal(resolveSamples(undefined), 1, 'no --samples flag → 1 call per cell');
  assert.equal(resolveSamples(''), 1, 'empty --samples → 1 call per cell');
  assert.equal(resolveSamples('not-a-number'), 1, 'garbage --samples → 1 call per cell');
  assert.equal(resolveSamples('0'), 1, '--samples=0 → 1 call per cell');
});

test('the documented --samples ceiling equals MAX_SAMPLES', () => {
  // Scoped to the section + the flags row (checked below) rather than the whole
  // README, so an unrelated future "capped at N" sentence elsewhere in the file
  // cannot be coupled to lib/sampling.js by accident.
  const flagsRow = README.match(/^\|\s*`--samples=<N>`\s*\|.*$/m)?.[0] ?? '';
  const caps = [...`${SECTION}\n${flagsRow}`.matchAll(/capped at (\d+)/gi)].map(m => Number(m[1]));
  assert.ok(caps.length >= 1, 'README must state the --samples ceiling');
  for (const cap of caps) {
    assert.equal(
      cap, MAX_SAMPLES,
      `README says the cap is ${cap}, lib/sampling.js says ${MAX_SAMPLES}`,
    );
  }
  assert.equal(resolveSamples(String(MAX_SAMPLES + 7)), MAX_SAMPLES, 'over-cap clamps to the cap');
  // And the flag is documented where a reader looks for flags, not only in prose.
  assert.ok(
    /\|\s*`--samples=<N>`\s*\|\s*`run`\s*\|/.test(README),
    'the full flags reference table must carry a --samples row',
  );
});

test('the quoted confidence-interval line is the shape the report really renders', () => {
  // Guard against quoting an output format that no renderer emits. The decimal
  // form that lib/stats.js's header and `--help` use («3/5 · 95% CI [0.23,
  // 0.88]») is NOT what sectionUnifiedVisibilityIndex prints — it pools the
  // sampled cells and renders whole percents with a «trials» label. The doc
  // must quote the renderer, not the comment.
  const quoted = SECTION.match(/`share of cells where brand was mentioned · [^`]+`/);
  assert.ok(quoted, 'the section must quote the presence-interval line the report prints');
  assert.match(quoted[0], /\d+\/\d+ trials · \d+% CI \[\d+%, \d+%\]/,
    'the quoted line must use the renderer’s trials + whole-percent form');

  const sectionsSrc = readFileSync(
    join(REPO_ROOT, 'lib', 'report', 'sections.js'), 'utf-8');
  assert.ok(
    sectionsSrc.includes('share of cells where brand was mentioned · ${hits}/${n} trials · ${lvl}% CI ['),
    'lib/report/sections.js must still build the presence hint in the documented shape',
  );
});

test('the UVI weights table matches the weights the code applies', () => {
  const rows = [...README.matchAll(/\|\s*\*\*(Presence|Sentiment|Rank|Citation)\*\*\s*\|\s*(\d+)%\s*\|/g)];
  assert.equal(rows.length, 4, 'README must document all four UVI axes with a percentage each');

  // Ask the real breakdown for its default (unnormalised) weights.
  const breakdown = computeUVIBreakdown({
    presence: 50, sentiment: 50, rank: 50, citation: 50,
    sample: 4, sentimentSample: 4, rankSample: 4,
  });
  const codeWeights = Object.fromEntries(
    breakdown.rows.map(c => [c.key, Math.round(c.weight * 100)]),
  );

  for (const [, label, pct] of rows) {
    const key = label.toLowerCase();
    assert.equal(
      Number(pct), codeWeights[key],
      `README documents ${label} at ${pct}%, lib/report/visibility-index.js applies ${codeWeights[key]}%`,
    );
  }
  const sum = Object.values(codeWeights).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100, 'default weights must sum to 100 — otherwise the published table cannot be true');
});

test('the documented mention taxonomy is the taxonomy detectMention emits', () => {
  for (const label of ['`yes`', '`src`', '`no`']) {
    assert.ok(SECTION.includes(label), `the mention table must document the ${label} label`);
  }

  const brand = 'Gcore';
  const domain = 'gcore.com';

  // yes — named in the body.
  assert.equal(detectMention('We suggest Gcore for edge delivery.', [], brand, domain), 'yes');
  // yes — separator-tolerant spelling, the documented gcore ≈ G-Core ≈ G Core rule.
  assert.equal(detectMention('Try G-Core Labs.', [], brand, domain), 'yes');
  assert.equal(detectMention('Try G Core Labs.', [], brand, domain), 'yes');
  // yes — the domain in the body counts as being named.
  assert.equal(detectMention('See gcore.com for pricing.', [], brand, domain), 'yes');
  // src — present ONLY in a cited source URL.
  assert.equal(
    detectMention('Consider Fastly or Bunny.', ['https://gcore.com/blog/cdn'], brand, domain),
    'src',
  );
  // no — absent in every spelling.
  assert.equal(detectMention('Consider Fastly or Bunny.', [], brand, domain), 'no');
  // no — the documented «does not fire inside a longer word / across a seam» rule.
  assert.equal(detectMention('They run a big core network.', [], brand, domain), 'no');
  assert.equal(detectMention('Ask the gcorehouse team.', [], brand, domain), 'no');
  // The documented dot-is-significant rule.
  assert.equal(detectMention('Built with nodejs.', [], 'Node.js', 'nodejs-example.dev'), 'no');
  assert.equal(detectMention('Built with Node.js.', [], 'Node.js', 'nodejs-example.dev'), 'yes');

  // The documented no-fuzzy-matching limit — an engine misspelling is an absence
  // until the operator adds an alias, and the alias then makes it a hit.
  assert.equal(detectMention('We like Gcoore.', [], brand, domain), 'no');
  assert.equal(detectMention('We like Gcoore.', [], brand, domain, ['Gcoore']), 'yes');
});

test('«yes and src both count as one for Presence» is literally true', () => {
  assert.ok(
    /`yes` and `src` both count as one for Presence/i.test(SECTION),
    'the section must state the yes/src presence rule outright',
  );
  assert.equal(perCellPresence({ mention: 'yes' }), 1);
  assert.equal(perCellPresence({ mention: 'src' }), 1);
  assert.equal(perCellPresence({ mention: 'no' }), 0);
});

test('errored cells really are dropped from the denominator, not scored as absences', () => {
  assert.ok(
    SECTION.includes('dropped from the denominator'),
    'the section must disclose how errored cells are treated',
  );
  const components = computeComponents({
    domain: 'gcore.com',
    results: [
      { query: 'q1', provider: 'openai', mention: 'yes' },
      { query: 'q1', provider: 'gemini', mention: 'error' },
    ],
  });
  assert.equal(components.sample, 1, 'the errored cell must not enter the denominator');
  assert.equal(components.presence, 100, 'one hit out of one measurable cell is 100%, not 50%');
});

test('an unmeasured rank axis is excluded and the other weights re-normalise', () => {
  assert.ok(
    /excluded and the remaining weights re-normalise/.test(SECTION),
    'the section must state what happens when an axis has no data',
  );
  const noPositions = computeComponents({
    domain: 'gcore.com',
    results: [{ query: 'q1', provider: 'openai', mention: 'yes' }],
  });
  assert.equal(noPositions.rank, null, 'no positions → rank is null, never a fabricated 50');

  const breakdown = computeUVIBreakdown({
    presence: 100, sentiment: null, rank: null, citation: 100,
    sample: 1, sentimentSample: 0, rankSample: 0,
  });
  const byKey = Object.fromEntries(breakdown.rows.map(c => [c.key, c]));
  assert.equal(byKey.rank.appliedWeight, null, 'an excluded axis carries no applied weight');
  assert.equal(byKey.rank.contribution, null, 'an excluded axis contributes nothing');
  const applied = breakdown.rows
    .filter(c => c.appliedWeight !== null)
    .reduce((s, c) => s + c.appliedWeight, 0);
  assert.ok(
    Math.abs(applied - 1) < 1e-9,
    `re-normalised weights must sum to 1, got ${applied}`,
  );
  assert.equal(breakdown.uvi, 100, 'two measured axes at 100 must yield 100, not a diluted score');
});

test('the documented prose-rank discount is the constant the code multiplies by', () => {
  const documented = SECTION.match(/multiplied by ([\d.]+) before it enters the average/);
  assert.ok(documented, 'the section must state the prose-rank discount as a number');
  const inCode = VISIBILITY_INDEX_SRC.match(/PROSE_RANK_DISCOUNT\s*=\s*([\d.]+)/);
  assert.ok(inCode, 'lib/report/visibility-index.js must define PROSE_RANK_DISCOUNT');
  assert.equal(
    Number(documented[1]), Number(inCode[1]),
    `README says the prose discount is ${documented[1]}, the code applies ${inCode[1]}`,
  );
});

test('the citation rule matches at the registered domain, subdomains included', () => {
  assert.ok(
    SECTION.includes('registered-domain level'),
    'the section must say how a citation is matched to your domain',
  );
  assert.equal(isOwnDomain('blog.yourbrand.com', 'yourbrand.com'), true, 'a subdomain is yours');
  assert.equal(isOwnDomain('www.yourbrand.com', 'yourbrand.com'), true);
  assert.equal(isOwnDomain('yourbrand.com.evil.com', 'yourbrand.com'), false, 'a look-alike host is not yours');
  assert.equal(isOwnDomain('notyourbrand.com', 'yourbrand.com'), false);
});
