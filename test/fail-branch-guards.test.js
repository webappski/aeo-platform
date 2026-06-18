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
import { renderMarkdown } from '../lib/report/markdown.js';
import { sectionAdsDetection } from '../lib/report/sections.js';

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

// ─── AP-ALLNO-RENDER-CRASH: a fully-invisible 0% run must render, never crash ───
//
// The 0%-brand operator is the reader who needs this report MOST (the prime
// consulting lead), yet a run where EVERY cell is `mention:'no'` used to throw
// mid-render — they got a crash instead of an honest "0% — here's why and what
// to do". Root cause: sectionAdsDetection did `Object.entries(ads.byProvider)`
// when `adsDetected` was present-but-shapeless (an interrupted/older-schema run
// persists an empty object or a partial record with no numeric counters, so the
// `totalCellsWithAdSignal === 0` short-circuit was skipped and byProvider was
// undefined). Guard: any non-conforming shape degrades to the honest
// "scanned, clean" stanza. Never-fail standard (AP-FAIL-BRANCHES): on any
// degenerate-input branch the reader gets a real report, never a bare stack.

// Faithful all-'no' snapshot: 3 engines × 3 queries, every cell a miss,
// zero citations, zero competitors, score 0 — a genuinely invisible brand.
function allNoSnapshot(extra = {}) {
  return {
    date: '2026-06-17',
    brand: 'aeo-platform',
    domain: 'aeo-platform.dev',
    score: 0,
    mentions: 0,
    total: 9,
    errors: 0,
    results: ['Q1', 'Q2', 'Q3'].flatMap(q =>
      ['openai', 'gemini', 'anthropic'].map(p => ({
        query: q, queryText: `query ${q}`,
        provider: p, label: p, model: `${p}-m`,
        mention: 'no', position: null, citationCount: 0,
        canonicalCitations: [], competitors: [], competitorsUnverified: [],
        hasBrandInCitations: false,
      }))
    ),
    topCompetitors: [], topCanonicalSources: [], topDomains: [],
    ...extra,
  };
}

await test('renderMarkdown: fully-invisible all-"no" run renders without throwing', () => {
  // Well-formed clean adsDetected (the shape a normal all-"no" run produces).
  const md = renderMarkdown([allNoSnapshot({
    adsDetected: { totalCellsScanned: 9, totalCellsWithAdSignal: 0, byProvider: {}, samples: [] },
  })]);
  assert.ok(md.length > 0, 'must produce a report');
  // Honest 0% / invisible signal must be present — not an empty husk.
  assert.match(md, /0%/, 'headline must show 0%');
  assert.match(md, /INVISIBLE/, 'traffic-light label must read INVISIBLE at score 0');
});

await test('renderMarkdown: all-"no" + DEGENERATE adsDetected shapes never crash', () => {
  // An interrupted run / older schema can persist adsDetected as an empty
  // object, an array, or a partial record with a signal count but no provider
  // map. Each previously crashed the WHOLE report at Object.entries(byProvider).
  for (const ads of [{}, [], { totalCellsWithAdSignal: 2 }, { totalCellsScanned: 9, totalCellsWithAdSignal: 3 }]) {
    const md = renderMarkdown([allNoSnapshot({ adsDetected: ads })]);
    assert.ok(md.length > 0, `must still render with adsDetected=${JSON.stringify(ads)}`);
    assert.match(md, /0%/, 'headline must still show 0%');
  }
});

await test('sectionAdsDetection: degenerate shapes degrade to "scanned, clean", no throw', () => {
  for (const ads of [{}, [], { totalCellsWithAdSignal: 2 }, { totalCellsScanned: 9, totalCellsWithAdSignal: 5 }]) {
    const out = sectionAdsDetection([allNoSnapshot({ adsDetected: ads })]);
    assert.match(out, /none found this run/, `must degrade cleanly for ${JSON.stringify(ads)}`);
    assert.doesNotMatch(out, /undefined/, 'no leaked "undefined" in the rendered stanza');
  }
});

await test('sectionAdsDetection: well-formed signal STILL renders the table (R39 — unchanged path)', () => {
  // The guard must NOT suppress a real ad signal: a conforming byProvider map
  // with a positive count renders the per-engine table + sample blocks exactly
  // as before. This locks the non-empty render path against the fix.
  const out = sectionAdsDetection([allNoSnapshot({
    adsDetected: {
      totalCellsScanned: 9, totalCellsWithAdSignal: 2,
      byProvider: { openai: 2 },
      samples: [{ provider: 'openai', query: 'Q1', kind: 'sponsored', snippet: 'Sponsored: ad copy' }],
    },
  })]);
  assert.match(out, /\| ChatGPT \| 2 cells \|/, 'per-provider row must render for a real signal');
  assert.match(out, /ads-sample/, 'sample block must render for a real signal');
  assert.doesNotMatch(out, /none found this run/, 'must NOT degrade when a real signal exists');
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
