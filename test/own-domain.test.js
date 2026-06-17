import assert from 'node:assert/strict';
import { normaliseOwnDomain, isOwnDomain } from '../lib/report/own-domain.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nnormaliseOwnDomain');

test('returns "" for null', () => {
  assert.equal(normaliseOwnDomain(null), '');
});

test('returns "" for undefined', () => {
  assert.equal(normaliseOwnDomain(undefined), '');
});

test('returns "" for empty string', () => {
  assert.equal(normaliseOwnDomain(''), '');
});

test('returns "" for non-string (defensive)', () => {
  assert.equal(normaliseOwnDomain(123), '');
  assert.equal(normaliseOwnDomain({}), '');
  assert.equal(normaliseOwnDomain([]), '');
});

test('lowercases mixed-case host', () => {
  assert.equal(normaliseOwnDomain('Foo.COM'), 'foo.com');
  assert.equal(normaliseOwnDomain('WWW.Foo.COM'), 'foo.com');
});

test('strips http:// scheme', () => {
  assert.equal(normaliseOwnDomain('http://foo.com'), 'foo.com');
});

test('strips https:// scheme', () => {
  assert.equal(normaliseOwnDomain('https://foo.com'), 'foo.com');
});

test('strips leading www.', () => {
  assert.equal(normaliseOwnDomain('www.foo.com'), 'foo.com');
});

test('strips trailing slash', () => {
  assert.equal(normaliseOwnDomain('foo.com/'), 'foo.com');
});

test('strips multiple trailing slashes', () => {
  assert.equal(normaliseOwnDomain('foo.com///'), 'foo.com');
});

test('drops path segment', () => {
  assert.equal(normaliseOwnDomain('foo.com/blog/post'), 'foo.com');
});

test('drops query string', () => {
  assert.equal(normaliseOwnDomain('foo.com?utm_source=x'), 'foo.com');
});

test('drops fragment', () => {
  assert.equal(normaliseOwnDomain('foo.com#anchor'), 'foo.com');
});

test('strips explicit port :443', () => {
  assert.equal(normaliseOwnDomain('foo.com:443'), 'foo.com');
});

test('strips explicit port :8080', () => {
  assert.equal(normaliseOwnDomain('foo.com:8080'), 'foo.com');
});

test('full URL with scheme + www + port + path + query + fragment', () => {
  assert.equal(
    normaliseOwnDomain('HTTPS://WWW.Foo.COM:443/blog/post?utm=x#top'),
    'foo.com',
  );
});

test('preserves multi-segment domain (no over-stripping)', () => {
  assert.equal(normaliseOwnDomain('blog.foo.co.uk'), 'blog.foo.co.uk');
});

test('preserves bare hostname', () => {
  assert.equal(normaliseOwnDomain('foo.com'), 'foo.com');
});

test('trims whitespace', () => {
  assert.equal(normaliseOwnDomain('  foo.com  '), 'foo.com');
});

console.log('\nisOwnDomain');

test('exact match', () => {
  assert.equal(isOwnDomain('foo.com', 'foo.com'), true);
});

test('case-insensitive match', () => {
  assert.equal(isOwnDomain('FOO.com', 'foo.COM'), true);
});

test('www-prefix match', () => {
  assert.equal(isOwnDomain('www.foo.com', 'foo.com'), true);
});

test('subdomain match — blog.foo.com vs foo.com', () => {
  assert.equal(isOwnDomain('blog.foo.com', 'foo.com'), true);
});

test('deep subdomain match — a.b.foo.com vs foo.com', () => {
  assert.equal(isOwnDomain('a.b.foo.com', 'foo.com'), true);
});

test('subdomain-spoof SAFE — foo.com.evil.com is NOT a match for foo.com', () => {
  // Critical security guard: endsWith('.' + own) prevents an attacker domain
  // from masquerading as our subdomain.
  assert.equal(isOwnDomain('foo.com.evil.com', 'foo.com'), false);
});

test('different domain — bar.com vs foo.com', () => {
  assert.equal(isOwnDomain('bar.com', 'foo.com'), false);
});

test('null own-domain → false (no match possible)', () => {
  assert.equal(isOwnDomain('foo.com', null), false);
  assert.equal(isOwnDomain('foo.com', ''), false);
});

test('null host → false', () => {
  assert.equal(isOwnDomain(null, 'foo.com'), false);
  assert.equal(isOwnDomain('', 'foo.com'), false);
});

test('full URL on both sides resolves correctly', () => {
  assert.equal(
    isOwnDomain('https://www.blog.foo.com/post?x=1', 'http://foo.com/'),
    true,
  );
});

test('host with port matches own without port', () => {
  assert.equal(isOwnDomain('foo.com:443', 'foo.com'), true);
});

// ─── citation-URL matching contract (AP-CITATION-ETLD1, review #8) ───
// isOwnDomain is the registrable-domain matcher the citation axis now uses in
// place of substring `url.includes(domain)`. Lock the exact spoof hostnames
// from the triage so the citation axis cannot silently regress to substring.

test('citation spoof: gcore.com.evil.com is NOT gcore.com', () => {
  assert.equal(isOwnDomain('https://gcore.com.evil.com/x', 'gcore.com'), false);
});

test('citation spoof: notgcore.com.evil.com is NOT gcore.com', () => {
  assert.equal(isOwnDomain('https://notgcore.com.evil.com/x', 'gcore.com'), false);
});

test('citation spoof: xgcore.com is NOT gcore.com (prefix look-alike)', () => {
  assert.equal(isOwnDomain('https://xgcore.com/x', 'gcore.com'), false);
});

test('citation real: blog.gcore.com IS gcore.com (subdomain)', () => {
  assert.equal(isOwnDomain('https://blog.gcore.com/post', 'gcore.com'), true);
});

test('citation real: bare gcore.com with utm query IS gcore.com', () => {
  assert.equal(isOwnDomain('https://gcore.com/x?utm_source=chatgpt', 'gcore.com'), true);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
