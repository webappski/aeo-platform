// Tests for canonical-URL de-duplication of topCanonicalSources
// (fail-branch #12, AP-FAILBRANCH-REMAINDER). Same-page variants must merge;
// genuinely distinct pages on the same host must stay distinct.

import assert from 'node:assert/strict';
import { canonicalizeUrl, aggregateCanonicalSources } from '../lib/report/canonical-url.js';

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push({ name, ok: true }); }
  catch (err) { failed++; results.push({ name, ok: false, err: err.message }); }
}

test('canonicalizeUrl: trailing slash, fragment, www, default port, http→https all collapse', () => {
  const base = 'https://firstpagesage.com/seo-blog/top-seo';
  assert.equal(canonicalizeUrl('https://firstpagesage.com/seo-blog/top-seo/'), base);
  assert.equal(canonicalizeUrl('https://firstpagesage.com/seo-blog/top-seo#methods'), base);
  assert.equal(canonicalizeUrl('https://www.firstpagesage.com/seo-blog/top-seo'), base);
  assert.equal(canonicalizeUrl('https://firstpagesage.com:443/seo-blog/top-seo'), base);
  assert.equal(canonicalizeUrl('http://firstpagesage.com/seo-blog/top-seo'), base);
});

test('canonicalizeUrl: tracking params stripped, real query params kept', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/post?utm_source=chatgpt&utm_medium=ai'),
    'https://example.com/post',
  );
  // a genuine selector param must survive — it picks a different page
  assert.equal(canonicalizeUrl('https://example.com/post?id=42'), 'https://example.com/post?id=42');
  // mixed: tracking dropped, real kept
  assert.equal(
    canonicalizeUrl('https://example.com/post?id=42&fbclid=xyz&ref=foo'),
    'https://example.com/post?id=42',
  );
});

test('canonicalizeUrl: distinct pages on same host stay distinct', () => {
  assert.notEqual(
    canonicalizeUrl('https://firstpagesage.com/seo-blog/a'),
    canonicalizeUrl('https://firstpagesage.com/seo-blog/b'),
  );
});

test('canonicalizeUrl: unparseable input returned as-is (never throws)', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
  assert.equal(canonicalizeUrl(''), '');
  assert.equal(canonicalizeUrl(null), null);
});

test('aggregateCanonicalSources: firstpagesage variants merge into ONE row with summed count', () => {
  const urls = [
    'https://firstpagesage.com/seo-blog/top-seo/',
    'https://firstpagesage.com/seo-blog/top-seo#methods',
    'https://www.firstpagesage.com/seo-blog/top-seo?utm_source=chatgpt',
    'https://firstpagesage.com/other-page',
  ];
  const agg = aggregateCanonicalSources(urls);
  const topSeo = agg.find(s => s.url === 'https://firstpagesage.com/seo-blog/top-seo');
  assert.ok(topSeo, 'the three variants collapsed into one canonical row');
  assert.equal(topSeo.count, 3, 'their counts summed (3), not split into 1+1+1');
  assert.equal(agg.length, 2, 'exactly two distinct pages remain');
});

test('aggregateCanonicalSources: respects limit and sorts by count desc', () => {
  const urls = [
    'https://a.com/1', 'https://a.com/1', 'https://a.com/1', // 3
    'https://b.com/2', 'https://b.com/2',                    // 2
    'https://c.com/3',                                        // 1
  ];
  const agg = aggregateCanonicalSources(urls, 2);
  assert.equal(agg.length, 2);
  assert.equal(agg[0].count, 3);
  assert.equal(agg[1].count, 2);
});

console.log('');
for (const r of results) console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
