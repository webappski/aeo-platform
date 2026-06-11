// Tests for the AP-FAIL-BRANCHES guards (1.1.8): Node version gate, atomic
// JSON write, platform-aware key setup lines, and 529 classification.
// Standard: on any failure branch the client gets recovery or ONE plain next
// step — never silence, never a bare stack, never zsh advice on Windows.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkNodeVersion } from '../lib/util/node-version.js';
import { atomicWriteJson } from '../lib/util/atomic-write.js';
import { keySetupLines } from '../lib/init/keys.js';
import { classifyProviderError } from '../lib/providers/classify-error.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  const p = (async () => fn())();
  return p.then(
    () => { passed++; results.push({ name, ok: true }); },
    err => { failed++; results.push({ name, ok: false, err: err.message }); }
  );
}

// ─── checkNodeVersion ───

await test('checkNodeVersion: 20/22 pass, 18 fails with one plain next step', () => {
  assert.equal(checkNodeVersion('20.0.0').ok, true);
  assert.equal(checkNodeVersion('22.4.1').ok, true);
  const r = checkNodeVersion('18.19.1');
  assert.equal(r.ok, false);
  assert.match(r.message, /Node\.js >= 20/);
  assert.match(r.message, /v18\.19\.1/);
  assert.match(r.message, /nodejs\.org/);
});

await test('checkNodeVersion: garbage version fails closed (gate, not crash)', () => {
  assert.equal(checkNodeVersion('').ok, false);
  assert.equal(checkNodeVersion(undefined).ok, false);
  assert.equal(checkNodeVersion('not-a-version').ok, false);
});

// ─── atomicWriteJson ───

await test('atomicWriteJson: writes valid JSON, leaves zero .tmp- files behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-atomic-'));
  try {
    const target = join(dir, '_summary.json');
    await atomicWriteJson(target, { date: '2026-06-11', results: [1, 2, 3] });
    const back = JSON.parse(await readFile(target, 'utf-8'));
    assert.deepEqual(back, { date: '2026-06-11', results: [1, 2, 3] });
    const files = await readdir(dir);
    assert.deepEqual(files, ['_summary.json'], 'no tmp leftovers');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('atomicWriteJson: overwrite is atomic — old content fully replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-atomic2-'));
  try {
    const target = join(dir, 'f.json');
    await atomicWriteJson(target, { v: 1, long: 'x'.repeat(500) });
    await atomicWriteJson(target, { v: 2 });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf-8')), { v: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── keySetupLines ───

await test('keySetupLines(win32): PowerShell setx + new-terminal step, no zshrc', () => {
  const joined = keySetupLines('win32').join('\n');
  assert.match(joined, /setx OPENAI_API_KEY/);
  assert.match(joined, /NEW terminal/);
  assert.doesNotMatch(joined, /zshrc/);
});

await test('keySetupLines(darwin/linux): shell-profile export + source step', () => {
  for (const platform of ['darwin', 'linux']) {
    const joined = keySetupLines(platform).join('\n');
    assert.match(joined, /~\/\.zshrc/);
    assert.match(joined, /export OPENAI_API_KEY/);
    assert.match(joined, /source/);
  }
});

// ─── classify-error: 529 ───

await test('classifyProviderError: bare HTTP 529 → retryable rate-limit (not "other")', () => {
  const r = classifyProviderError(new Error('Request failed with status code 529'));
  assert.equal(r.retryable, true);
  assert.equal(r.category, 'rate-limit');
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
