// AP-RATELIMIT-UX: cross-run ledger file persistence (load / save). Uses real
// temp files — no fs mocks. The contract under test: a corrupt or missing
// ledger file must NEVER break a run.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLedger, saveLedger } from '../lib/providers/ledger-store.js';
import { learnTpmLimit, getLearnedOrTierLimit, _resetForTests } from '../lib/providers/tpm-ledger.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  _resetForTests();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-ledger-'));
  return { path: join(dir, '.tpm-ledger.json'), dir };
}

console.log('\nledger-store load/save');

await test('save writes nothing when no limits learned', async () => {
  const { path } = tmpFile();
  const n = await saveLedger(path);
  assert.equal(n, 0);
  assert.equal(existsSync(path), false);
});

await test('save → load roundtrip restores the learned ceiling', async () => {
  const { path } = tmpFile();
  learnTpmLimit('openai:gpt-5-search-api', 18000, 'observed');
  const saved = await saveLedger(path);
  assert.equal(saved, 1);
  assert.equal(existsSync(path), true);

  _resetForTests();
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api') === 18000, false); // gone after reset
  const loaded = await loadLedger(path);
  assert.equal(loaded, 1);
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 18000);
});

await test('load of a missing file returns 0, does not throw', async () => {
  const n = await loadLedger(join(tmpdir(), 'definitely-absent-ledger-xyz.json'));
  assert.equal(n, 0);
});

await test('load of a corrupt file returns 0, does not throw (degrade to learn-from-scratch)', async () => {
  const { path } = tmpFile();
  writeFileSync(path, '{ this is not, json');
  const n = await loadLedger(path);
  assert.equal(n, 0);
});

await test('load tolerates both bare-map and {limits:{}} envelope shapes', async () => {
  const { path: p1 } = tmpFile();
  writeFileSync(p1, JSON.stringify({ 'openai:gpt-5': { limit: 5000 } }));
  assert.equal(await loadLedger(p1), 1);

  _resetForTests();
  const { path: p2 } = tmpFile();
  writeFileSync(p2, JSON.stringify({ updatedAt: 'x', limits: { 'openai:gpt-5': { limit: 6000 } } }));
  assert.equal(await loadLedger(p2), 1);
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5'), 6000);
});

// Mutation-sanity: if saveLedger silently wrote an empty/garbage payload, the
// reload below would not restore the limit.
await test('mutation-sanity: saved payload actually round-trips a real ceiling', async () => {
  const { path } = tmpFile();
  learnTpmLimit('anthropic:claude-sonnet-4-6', 22000, 'header');
  await saveLedger(path);
  _resetForTests();
  await loadLedger(path);
  assert.equal(getLearnedOrTierLimit('anthropic', 'claude-sonnet-4-6'), 22000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
