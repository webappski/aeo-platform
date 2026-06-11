// Tests for the version-awareness package (1.2.x): cmpVersions, the cached
// update check, skip policy, and the local-vs-global mismatch detector.
// Contract: advisory only — every failure path is silent and never breaks a
// command.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cmpVersions, shouldSkipUpdateCheck, maybeCheckForUpdate, UPDATE_CHECK_TTL_MS,
} from '../lib/util/update-check.js';
import { detectNewerLocalCopy } from '../lib/util/local-version.js';

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

// ─── cmpVersions ───

await test('cmpVersions: ordering matrix + garbage fails safe (null)', () => {
  assert.equal(cmpVersions('1.2.0', '1.1.7'), 1);
  assert.equal(cmpVersions('1.1.7', '1.2.0'), -1);
  assert.equal(cmpVersions('1.2.0', '1.2.0'), 0);
  assert.equal(cmpVersions('2.0.0', '1.99.99'), 1);
  assert.equal(cmpVersions('1.10.0', '1.9.9'), 1);
  assert.equal(cmpVersions('1.2.0-beta.1', '1.1.0'), null);
  assert.equal(cmpVersions('unknown', '1.0.0'), null);
  assert.equal(cmpVersions(undefined, '1.0.0'), null);
});

// ─── shouldSkipUpdateCheck ───

await test('shouldSkipUpdateCheck: opt-out env, CI, and non-TTY all skip; plain TTY does not', () => {
  assert.equal(shouldSkipUpdateCheck({ AEO_NO_UPDATE_CHECK: '1' }, true), true);
  assert.equal(shouldSkipUpdateCheck({ CI: 'true' }, true), true);
  assert.equal(shouldSkipUpdateCheck({}, false), true);
  assert.equal(shouldSkipUpdateCheck({}, true), false);
});

// ─── maybeCheckForUpdate ───

const NOW = 1_800_000_000_000;
const mkFetch = (version, { fail = false, status = 200 } = {}) => {
  const impl = async () => {
    impl.calls++;
    if (fail) throw new Error('network down');
    return { ok: status === 200, status, json: async () => ({ version }) };
  };
  impl.calls = 0;
  return impl;
};

await test('fresh cache answers with ZERO network calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-upd-'));
  try {
    const cachePath = join(dir, 'cache.json');
    await writeFile(cachePath, JSON.stringify({ checkedAt: NOW - 1000, latest: '9.9.9' }));
    const fetchImpl = mkFetch('0.0.1');
    const r = await maybeCheckForUpdate({ currentVersion: '1.2.0', fetchImpl, now: NOW, cachePath });
    assert.equal(fetchImpl.calls, 0);
    assert.deepEqual(r, { updateAvailable: true, latest: '9.9.9' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await test('stale cache → one registry call + cache refreshed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-upd2-'));
  try {
    const cachePath = join(dir, 'cache.json');
    await writeFile(cachePath, JSON.stringify({ checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, latest: '1.0.0' }));
    const fetchImpl = mkFetch('1.3.0');
    const r = await maybeCheckForUpdate({ currentVersion: '1.2.0', fetchImpl, now: NOW, cachePath });
    assert.equal(fetchImpl.calls, 1);
    assert.deepEqual(r, { updateAvailable: true, latest: '1.3.0' });
    const cached = JSON.parse(await readFile(cachePath, 'utf-8'));
    assert.equal(cached.latest, '1.3.0');
    assert.equal(cached.checkedAt, NOW);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await test('up-to-date version → no banner; registry failure → silent false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-upd3-'));
  try {
    const same = await maybeCheckForUpdate({
      currentVersion: '1.2.0', fetchImpl: mkFetch('1.2.0'), now: NOW, cachePath: join(dir, 'a.json'),
    });
    assert.equal(same.updateAvailable, false);
    const down = await maybeCheckForUpdate({
      currentVersion: '1.2.0', fetchImpl: mkFetch('x', { fail: true }), now: NOW, cachePath: join(dir, 'b.json'),
    });
    assert.deepEqual(down, { updateAvailable: false, latest: null });
    const http500 = await maybeCheckForUpdate({
      currentVersion: '1.2.0', fetchImpl: mkFetch('9.9.9', { status: 500 }), now: NOW, cachePath: join(dir, 'c.json'),
    });
    assert.deepEqual(http500, { updateAvailable: false, latest: null });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await test('corrupt cache → treated as stale, live check proceeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-upd4-'));
  try {
    const cachePath = join(dir, 'cache.json');
    await writeFile(cachePath, '{ not json');
    const fetchImpl = mkFetch('2.0.0');
    const r = await maybeCheckForUpdate({ currentVersion: '1.2.0', fetchImpl, now: NOW, cachePath });
    assert.equal(fetchImpl.calls, 1);
    assert.equal(r.updateAvailable, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ─── detectNewerLocalCopy ───

async function withLocalCopy(version, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aeo-local-'));
  try {
    const pkgDir = join(dir, 'node_modules', 'aeo-platform');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'aeo-platform', version }));
    return await fn(dir, pkgDir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

await test('detectNewerLocalCopy: project copy NEWER than running binary → warning payload', async () => {
  await withLocalCopy('2.0.0', (cwd) => {
    const r = detectNewerLocalCopy({ cwd, runningVersion: '1.2.0', runningUrl: 'file:///usr/local/lib/node_modules/aeo-platform/bin/aeo-tracker.js' });
    assert.deepEqual(r, { localVersion: '2.0.0' });
  });
});

await test('detectNewerLocalCopy: older/equal local, no local copy, or running THE local copy → null', async () => {
  await withLocalCopy('1.0.0', (cwd) => {
    assert.equal(detectNewerLocalCopy({ cwd, runningVersion: '1.2.0' }), null);
  });
  await withLocalCopy('1.2.0', (cwd) => {
    assert.equal(detectNewerLocalCopy({ cwd, runningVersion: '1.2.0' }), null);
  });
  const empty = await mkdtemp(join(tmpdir(), 'aeo-nolocal-'));
  try {
    assert.equal(detectNewerLocalCopy({ cwd: empty, runningVersion: '1.2.0' }), null);
  } finally { await rm(empty, { recursive: true, force: true }); }
  await withLocalCopy('2.0.0', (cwd, pkgDir) => {
    const runningUrl = pathToFileURL(join(pkgDir, 'bin', 'aeo-tracker.js')).href;
    assert.equal(detectNewerLocalCopy({ cwd, runningVersion: '2.0.0', runningUrl }), null);
  });
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
