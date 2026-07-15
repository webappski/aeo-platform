// Tests for lib/util/open-browser.js's pure helpers.
// No registry access or process spawning here — those are exercised manually
// on Windows; this covers the string-parsing/building logic in isolation.

import assert from 'node:assert/strict';
import { decodeBase64Utf8, buildSpawnArgs, extractExePath } from '../lib/util/open-browser.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    failed++;
    results.push({ name, ok: false, err: err.message });
  }
}

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

// ─── decodeBase64Utf8 ───

test('decodeBase64Utf8: decodes a valid marker-tagged payload', () => {
  const cmd = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1';
  const stdout = `AEO_BROWSER_CMD_B64:${b64(cmd)}\r\n`;
  assert.equal(decodeBase64Utf8(stdout), cmd);
});

test('decodeBase64Utf8: round-trips non-ASCII (Cyrillic) content', () => {
  const cmd = '"C:\\Users\\Алексей\\browser.exe" %1';
  const stdout = `AEO_BROWSER_CMD_B64:${b64(cmd)}\n`;
  assert.equal(decodeBase64Utf8(stdout), cmd);
});

test('decodeBase64Utf8: ignores extraneous stdout lines (AV/EDR banner, etc.) and finds the marker', () => {
  const cmd = '"C:\\Chrome\\chrome.exe" %1';
  const stdout = `Some banner line\r\nAnother notice: (по умолчанию)\r\nAEO_BROWSER_CMD_B64:${b64(cmd)}\r\ntrailing noise\r\n`;
  assert.equal(decodeBase64Utf8(stdout), cmd);
});

test('decodeBase64Utf8: returns null when the marker line is absent', () => {
  assert.equal(decodeBase64Utf8('just some unrelated output\r\n'), null);
});

test('decodeBase64Utf8: returns null on empty/missing/whitespace-only stdout', () => {
  assert.equal(decodeBase64Utf8(''), null);
  assert.equal(decodeBase64Utf8(null), null);
  assert.equal(decodeBase64Utf8('   \r\n  '), null);
});

test('decodeBase64Utf8: returns null (not a throw) on an empty payload after the marker', () => {
  assert.equal(decodeBase64Utf8('AEO_BROWSER_CMD_B64:\r\n'), null);
});

// ─── buildSpawnArgs ───
//
// The URL must arrive as its OWN argv element, verbatim and un-quoted by
// us — Chrome's `--single-argument` flag takes everything after it as a
// literal raw string rather than doing normal quote-stripping, so any
// quotes we added ourselves used to end up embedded in the URL Chrome
// actually navigated to (observed live: the address bar showed
// `"file:///...report.html"`, quotes and all). Spawning the exe directly
// with the URL as a separate array element (no shell, no hand-built
// command-line string) avoids that entirely.

test('buildSpawnArgs: substitutes bare %1, url is its own unquoted arg', () => {
  const url = 'file:///C:/report.html';
  const { exePath, args } = buildSpawnArgs('"C:\\Chrome\\chrome.exe" --single-argument %1', url);
  assert.equal(exePath, 'C:\\Chrome\\chrome.exe');
  assert.deepEqual(args, ['--single-argument', url]);
});

test('buildSpawnArgs: substitutes quoted "%1" among multiple flags', () => {
  const url = 'file:///C:/report.html';
  const { exePath, args } = buildSpawnArgs('"C:\\Firefox\\firefox.exe" -osint -url "%1"', url);
  assert.equal(exePath, 'C:\\Firefox\\firefox.exe');
  assert.deepEqual(args, ['-osint', '-url', url]);
});

test('buildSpawnArgs: substitutes legacy %L', () => {
  const url = 'file:///C:/report.html';
  const { exePath, args } = buildSpawnArgs('"C:\\Old\\browser.exe" %L', url);
  assert.equal(exePath, 'C:\\Old\\browser.exe');
  assert.deepEqual(args, [url]);
});

test('buildSpawnArgs: appends the URL when no placeholder is present', () => {
  const url = 'file:///C:/report.html';
  const { exePath, args } = buildSpawnArgs('"C:\\Weird\\browser.exe"', url);
  assert.equal(exePath, 'C:\\Weird\\browser.exe');
  assert.deepEqual(args, [url]);
});

test('buildSpawnArgs: returns null for an empty template', () => {
  assert.equal(buildSpawnArgs('', 'file:///C:/report.html'), null);
});

test('buildSpawnArgs: a literal $ character in the URL survives verbatim (no .replace() involved)', () => {
  const url = 'file:///C:/Users/tester/$&weird$$path$`$\'/report.html';
  const { args } = buildSpawnArgs('"C:\\Chrome\\chrome.exe" --single-argument %1', url);
  assert.deepEqual(args, ['--single-argument', url]);
});

test('buildSpawnArgs: an unquoted exe path with an unquoted placeholder', () => {
  const url = 'file:///C:/report.html';
  const { exePath, args } = buildSpawnArgs('C:\\Browser\\browser.exe %1', url);
  assert.equal(exePath, 'C:\\Browser\\browser.exe');
  assert.deepEqual(args, [url]);
});

// ─── extractExePath ───

test('extractExePath: extracts a quoted path with trailing args', () => {
  assert.equal(
    extractExePath('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );
});

test('extractExePath: extracts an unquoted no-space path with trailing args', () => {
  assert.equal(extractExePath('C:\\Browser\\browser.exe %1'), 'C:\\Browser\\browser.exe');
});

test('extractExePath: extracts an unquoted path with no args at all', () => {
  assert.equal(extractExePath('C:\\Browser\\browser.exe'), 'C:\\Browser\\browser.exe');
});

test('extractExePath: returns null for an unterminated quote (malformed registry data)', () => {
  assert.equal(extractExePath('"C:\\Broken\\browser.exe --single-argument %1'), null);
});

test('extractExePath: returns null for an empty or whitespace-only template', () => {
  assert.equal(extractExePath(''), null);
  assert.equal(extractExePath('   '), null);
});

// ─── Summary ───

console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
