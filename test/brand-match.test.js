// brand-match — separator-tolerant + alias-aware brand matching.
//
// Root-cause 2026-06-17 (Gcore false 0%): the naive `lowerText.includes(brand)`
// check produced a SILENT false-zero whenever the engine spelled the brand with a
// different separator ("G-Core" vs "gcore") or a known alias. These tests pin the
// fix: hyphen/space tolerance both directions, alias matching, dot-significance,
// and full backward-compat when no aliases are supplied.
//
// Why these are pure-function unit tests (R37): detectMention / findPosition are
// pure string functions with no UI / network / filesystem surface — an E2E here
// would be ceremony around a single boolean. The non-lying bar is met (real
// modules, no behavioural mocks). The mutation-sanity block at the end proves the
// suite goes RED if matching regresses to naive substring.

import assert from 'node:assert/strict';
import { detectMention, findPosition } from '../lib/mention.js';
import {
  brandTerms,
  textMentionsBrand,
  citationsMentionBrand,
  earliestBrandIndex,
} from '../lib/brand-match.js';

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nbrand-match — separator tolerance');

// ─── Separator equivalence: needle "gcore", varied text spellings ───
test('"gcore" config matches "Gcore" in text → yes', () => {
  assert.equal(detectMention('We recommend Gcore for CDN.', [], 'gcore', 'gcore.com'), 'yes');
});

test('"gcore" config matches "G-Core" in text (hyphen) → yes', () => {
  assert.equal(detectMention('We recommend G-Core for CDN.', [], 'gcore', 'gcore.com'), 'yes');
});

test('"gcore" config matches "G Core" in text (space) → yes', () => {
  assert.equal(detectMention('We recommend G Core for CDN.', [], 'gcore', 'gcore.com'), 'yes');
});

test('"gcore" config matches "G–Core" en-dash variant → yes', () => {
  assert.equal(detectMention('We recommend G–Core for CDN.', [], 'gcore', 'gcore.com'), 'yes');
});

// ─── Separator equivalence: needle "G-Core", varied text spellings ───
test('"G-Core" config matches "Gcore" in text (reverse direction) → yes', () => {
  assert.equal(detectMention('We recommend Gcore for CDN.', [], 'G-Core', 'gcore.com'), 'yes');
});

test('"G-Core" config matches "g core" in text → yes', () => {
  assert.equal(detectMention('We recommend g core for CDN.', [], 'G-Core', 'gcore.com'), 'yes');
});

// ─── Domain matching still works (and a dot in a domain is significant) ───
test('mention via domain only → yes', () => {
  assert.equal(detectMention('See https://gcore.com/cdn', [], 'Gcore', 'gcore.com'), 'yes');
});

test('domain match is plain substring — "gcore.com" not matched by separator trick', () => {
  // Brand-name tolerance must NOT spill into domain matching: "g core.com" is not
  // a real domain occurrence and should not be conjured by separator collapse.
  assert.equal(detectMention('hosted on g core dot com', [], 'ZZZ-no-name', 'gcore.com'), 'no');
});

// ─── Dot is significant punctuation, not a separator ───
console.log('\nbrand-match — dot is significant');

test('"Node.js" matches "Node.js" in text → yes', () => {
  assert.equal(detectMention('Built with Node.js runtime.', [], 'Node.js', 'nodejs.org'), 'yes');
});

test('"Node.js" does NOT match bare "Nodejs" (dot required) → no', () => {
  // The dot in the needle is escaped to a literal — it is not turned into a
  // wildcard or an optional separator. "Nodejs" lacks the literal dot.
  assert.equal(detectMention('Built with Nodejs runtime.', [], 'Node.js', 'zzz-nodot.example'), 'no');
});

// ─── Aliases ───
console.log('\nbrand-match — aliases');

test('alias matches when primary brand absent → yes', () => {
  assert.equal(
    detectMention('GCore Labs powers their edge.', [], 'Gcore', 'gcore.com', ['GCore Labs']),
    'yes'
  );
});

test('alias is also separator-tolerant → yes', () => {
  assert.equal(
    detectMention('Powered by g-core labs.', [], 'Gcore', 'gcore.com', ['GCore Labs']),
    'yes'
  );
});

test('non-matching alias does not create a false positive → no', () => {
  assert.equal(
    detectMention('We use Fastly here.', [], 'Gcore', 'gcore.com', ['GCore Labs']),
    'no'
  );
});

// ─── Backward compatibility: no aliases arg = pre-1.4 behaviour ───
console.log('\nbrand-match — backward compatibility');

test('empty/omitted aliases — plain brand still matches', () => {
  assert.equal(detectMention('Webappski is great.', [], 'Webappski', 'webappski.com'), 'yes');
});

test('empty/omitted aliases — absent brand → no', () => {
  assert.equal(detectMention('Some other text.', [], 'Webappski', 'webappski.com'), 'no');
});

test('separator-less single-word brand with no internal seam behaves like includes', () => {
  // "Webappski" has no internal separator; on text without separators it must match
  // exactly the same spans the old includes() did.
  assert.equal(detectMention('I love webappski tooling.', [], 'Webappski', 'webappski.com'), 'yes');
});

test('brand as a strict prefix of a longer unrelated word does NOT match', () => {
  // Root-cause repro (2026-07-08, init "typele" vs "TypelessForm"): a naive
  // includes() check treats any prefix of a longer word as a match. Word-boundary
  // anchoring must reject it — the brand simply isn't the word that's on the page.
  assert.equal(
    detectMention('Welcome to TypelessForm — voice-to-form filling.', [], 'typele', 'typelessform.com'),
    'no'
  );
});

// ─── Citations → 'src' ───
console.log('\nbrand-match — citation matches → src');

test('brand absent in body but domain in citation → src', () => {
  assert.equal(
    detectMention('Several CDNs exist.', ['https://gcore.com/blog/cdn'], 'Gcore', 'gcore.com'),
    'src'
  );
});

test('alias appears in citation URL → src', () => {
  assert.equal(
    detectMention('Several CDNs exist.', ['https://news.example/gcore-labs-launch'], 'Gcore', 'zzz-other.example', ['gcore-labs']),
    'src'
  );
});

// ─── findPosition threads aliases ───
console.log('\nbrand-match — findPosition with aliases');

test('findPosition ranks brand spelled "G-Core" in numbered list (config "gcore") → 2', () => {
  const text = `1. Fastly
2. G-Core
3. Cloudflare`;
  assert.equal(findPosition(text, 'gcore', 'gcore.com'), 2);
});

test('findPosition ranks an alias in a list when primary absent → 3', () => {
  const text = `1. Fastly
2. Cloudflare
3. GCore Labs`;
  assert.equal(findPosition(text, 'gcore', 'zzz-no-domain.example', ['GCore Labs']), 3);
});

test('findPosition with no aliases unchanged (regression guard)', () => {
  const text = `1. Profound
2. Webappski
3. NoGood`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 2);
});

// ─── Helper-level checks (brandTerms dedup, earliestBrandIndex) ───
console.log('\nbrand-match — helpers');

test('brandTerms dedups case-insensitively and drops blanks', () => {
  const t = brandTerms('Gcore', 'gcore.com', ['gcore', '  ', 'G-Core', 'GCore']);
  // "gcore" dup of brand; "G-Core" and one "GCore" remain distinct by lowercased key.
  assert.deepEqual(t.nameTerms.map(s => s.toLowerCase()), ['gcore', 'g-core']);
  assert.equal(t.domainTerm, 'gcore.com');
});

test('earliestBrandIndex returns earliest of name/alias/domain, -1 if absent', () => {
  const terms = brandTerms('Gcore', 'gcore.com', ['edge-net']);
  const text = 'First edge-net, then later Gcore.';
  // "edge-net" (alias) appears before "Gcore" → its index wins.
  assert.equal(earliestBrandIndex(text, terms), text.indexOf('edge-net'));
  assert.equal(earliestBrandIndex('nothing here', terms), -1);
});

test('textMentionsBrand / citationsMentionBrand booleans line up with detectMention', () => {
  const terms = brandTerms('Gcore', 'gcore.com', []);
  assert.equal(textMentionsBrand('use G-Core', terms), true);
  assert.equal(textMentionsBrand('use Fastly', terms), false);
  assert.equal(citationsMentionBrand(['https://gcore.com/x'], terms), true);
  assert.equal(citationsMentionBrand(['https://fastly.com/x'], terms), false);
});

// ─── Mutation sanity: prove the suite is load-bearing ───
// If the implementation regressed to naive `includes`, the hyphenated spelling
// would NOT match and this assertion (a 'yes' we now expect) would flip to 'no'.
// We assert the post-fix expectation here explicitly so a revert turns it RED.
console.log('\nbrand-match — mutation sanity (separator tolerance is the fix)');

test('SENTINEL: hyphenated spelling must match — RED if matching reverts to includes()', () => {
  const got = detectMention('Top pick: G-Core.', [], 'gcore', 'gcore.com');
  assert.equal(got, 'yes', 'separator-tolerant matching regressed to naive substring');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
