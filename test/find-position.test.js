// findPosition() — exercise the rank-detection heuristic across the answer
// shapes AI engines actually produce. The v0.2 implementation returned 1 for
// every prose mention; v0.3 returns null when no list structure is present.

import assert from 'node:assert/strict';
import { findPosition } from '../lib/mention.js';

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nfindPosition — list vs prose detection');

test('numbered list — brand at item 3 → 3', () => {
  const text = `Here are the top tools:

1. Profound — strong analytics.
2. NoGood — agency-style.
3. Webappski — open source CLI.
4. AirOps — workflow automation.`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 3);
});

test('numbered list — brand at item 1 → 1', () => {
  const text = `1. Webappski leads with open data.
2. Profound — closed beta.
3. NoGood — agency.`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 1);
});

test('numbered list — brand mentioned only in intro before item 1 → null', () => {
  const text = `Webappski sits in the AEO category. Top tools:

1. Profound
2. NoGood
3. AirOps`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), null);
});

test('numbered list — brand mentioned only in trailing prose → null', () => {
  const text = `1. Profound
2. NoGood
3. AirOps

Honourable mentions: Webappski (newer, open-source).`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), null);
});

test('bulleted list with dashes — brand at bullet 2 → 2', () => {
  const text = `Top tools:

- Profound
- Webappski
- NoGood
- AirOps`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 2);
});

test('bulleted list with asterisks — brand at bullet 4 → 4', () => {
  const text = `* Profound
* NoGood
* AirOps
* Webappski`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 4);
});

test('prose paragraph mention → null (no fake #1)', () => {
  const text = `Webappski is one of several open-source AEO tools that have emerged in 2026, alongside paid services like Profound and NoGood.`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), null);
});

test('prose with two casual bullets (< 3) → null (not a real list)', () => {
  const text = `Webappski offers:
- CLI
- HTML reports

It's a solid choice for engineers.`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), null);
});

test('brand absent → null', () => {
  const text = `1. Profound
2. NoGood
3. AirOps`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), null);
});

test('mention via domain only → 2', () => {
  const text = `1. profound.com
2. webappski.com
3. nogood.io`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 2);
});

test('case-insensitive brand match → 1', () => {
  const text = `1. WEBAPPSKI
2. Profound
3. NoGood`;
  assert.equal(findPosition(text, 'webappski', 'webappski.com'), 1);
});

test('numbered list with parens "1)" → matches', () => {
  const text = `1) Profound
2) Webappski
3) NoGood`;
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), 2);
});

test('separator-tolerant: config "gcore" ranks "G-Core" at item 2 → 2', () => {
  const text = `1. Fastly
2. G-Core
3. Cloudflare`;
  assert.equal(findPosition(text, 'gcore', 'gcore.com'), 2);
});

test('alias ranks at item 3 when primary brand absent → 3', () => {
  const text = `1. Fastly
2. Cloudflare
3. GCore Labs`;
  assert.equal(findPosition(text, 'gcore', 'zzz-no-domain.example', ['GCore Labs']), 3);
});

test('empty / null input → null', () => {
  assert.equal(findPosition('', 'Webappski', 'webappski.com'), null);
  assert.equal(findPosition(null, 'Webappski', 'webappski.com'), null);
  assert.equal(findPosition(undefined, 'Webappski', 'webappski.com'), null);
});

test('numbered list — brand on line BETWEEN items (continuation prose) → null', () => {
  const text = `1. Profound — strong tool.

Webappski is another option to consider.

2. NoGood
3. AirOps`;
  // brand sits between item 1 and item 2 on a non-list line — not ranked.
  assert.equal(findPosition(text, 'Webappski', 'webappski.com'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
