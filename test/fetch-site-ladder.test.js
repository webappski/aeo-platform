// Tests for the 1.1.8 fetchSite resilience ladder:
//   declared bot UA → transient retry (same UA) → browser UA on blocked
//   status → final paused declared-UA retry (transient-403 edge states).
// Production trigger: a transient 403 killed a non-interactive init whose
// IDENTICAL rerun succeeded one minute later — one retry was the whole fix.

import assert from 'node:assert/strict';
import { fetchSite } from '../lib/init/fetch-site.js';

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

/** Build a fetchImpl stub from a list of step functions; records calls. */
function makeFetchImpl(steps) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, ua: init.headers['User-Agent'] });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return step();
  };
  impl.calls = calls;
  return impl;
}

const ok200 = () => ({
  ok: true, status: 200, statusText: 'OK', url: 'https://example.com/',
  text: async () => '<html><title>t</title></html>',
});
const deny = (status, statusText) => () => ({
  ok: false, status, statusText, url: 'https://example.com/',
  text: async () => '',
});
const netErr = () => { const e = new Error('socket hang up'); throw e; };
const timeoutErr = () => { const e = new Error('fetch timed out'); e.name = 'TimeoutError'; e.code = 'ETIMEDOUT'; throw e; };

const OPTS = { retryDelayMs: 1 };

await test('happy path: one call, declared UA, botBlocked=false', async () => {
  const impl = makeFetchImpl([ok200]);
  const r = await fetchSite('https://example.com', { ...OPTS, fetchImpl: impl });
  assert.equal(impl.calls.length, 1);
  assert.match(impl.calls[0].ua, /^aeo-platform\//);
  assert.equal(r.botBlocked, false);
  assert.equal(r.uaUsed, 'declared');
  assert.equal(r.retried, false);
  assert.equal(r.status, 200);
});

await test('403 on declared UA → browser UA succeeds → botBlocked=true (AEO finding)', async () => {
  const impl = makeFetchImpl([deny(403, 'Forbidden'), ok200]);
  const r = await fetchSite('https://example.com', { ...OPTS, fetchImpl: impl });
  assert.equal(impl.calls.length, 2);
  assert.match(impl.calls[0].ua, /^aeo-platform\//);
  assert.match(impl.calls[1].ua, /Mozilla/);
  assert.equal(r.botBlocked, true);
  assert.equal(r.uaUsed, 'browser');
  assert.equal(r.retried, true);
});

await test('transient network error → one retry with same UA succeeds', async () => {
  const impl = makeFetchImpl([netErr, ok200]);
  const r = await fetchSite('https://example.com', { ...OPTS, fetchImpl: impl });
  assert.equal(impl.calls.length, 2);
  assert.match(impl.calls[1].ua, /^aeo-platform\//);
  assert.equal(r.botBlocked, false);
  assert.equal(r.retried, true);
});

await test('timeout → retry → still timeout → throws mapped TimeoutError', async () => {
  const impl = makeFetchImpl([timeoutErr, timeoutErr]);
  await assert.rejects(
    fetchSite('https://example.com', { ...OPTS, fetchImpl: impl, timeoutMs: 5000 }),
    (e) => e.code === 'ETIMEDOUT' && /timed out after 5000ms/.test(e.message)
  );
  assert.equal(impl.calls.length, 2);
});

await test('transient 403 (production case): 403 → browser 403 → paused declared retry 200', async () => {
  const impl = makeFetchImpl([deny(403, 'Forbidden'), deny(403, 'Forbidden'), ok200]);
  const r = await fetchSite('https://example.com', { ...OPTS, fetchImpl: impl });
  assert.equal(impl.calls.length, 3);
  assert.match(impl.calls[2].ua, /^aeo-platform\//);
  assert.equal(r.botBlocked, false); // declared UA ultimately passed
  assert.equal(r.retried, true);
});

await test('hard block: all three attempts 403 → enriched error names both UAs', async () => {
  const impl = makeFetchImpl([deny(403, 'Forbidden'), deny(403, 'Forbidden'), deny(403, 'Forbidden')]);
  await assert.rejects(
    fetchSite('https://example.com', { ...OPTS, fetchImpl: impl }),
    (e) => e.bothUAsBlocked === true && /declared bot UA/.test(e.message) && /browser UA/.test(e.message)
  );
  assert.equal(impl.calls.length, 3);
});

await test('non-blocked HTTP error (404) → no browser-UA attempt, throws directly', async () => {
  const impl = makeFetchImpl([deny(404, 'Not Found'), deny(404, 'Not Found')]);
  await assert.rejects(
    fetchSite('https://example.com', { ...OPTS, fetchImpl: impl }),
    /HTTP 404/
  );
  // 404 has no HTTP-status-undefined → not transient... but status 404 <500 and defined → not transient, not blocked → 1 attempt only
  assert.equal(impl.calls.length, 1);
});

await test('5xx is transient: 503 → retry succeeds', async () => {
  const impl = makeFetchImpl([deny(503, 'Service Unavailable'), ok200]);
  const r = await fetchSite('https://example.com', { ...OPTS, fetchImpl: impl });
  assert.equal(impl.calls.length, 2);
  assert.equal(r.status, 200);
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
