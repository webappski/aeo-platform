// Cross-platform "open this file/URL in the user's default browser".
//
// Windows root cause this file works around: `start "" "<path>"` resolves
// the handler through the FILE-EXTENSION association for `.html`
// (HKCU\...\FileExts\.html\UserChoice), which is a different Windows setting
// than "default web browser" (Settings > Apps > Default apps > Web browser,
// backed by HKCU\...\UrlAssociations\https\UserChoice). Editors like VS Code
// commonly end up bound to `.html` (often via a one-time "Open with... ->
// Always use this app" click) without ever touching the user's actual
// browser choice — so `start` silently hands the report to an editor instead
// of a browser. Only real browsers register as the `https` protocol handler,
// so we resolve the browser through that association instead of the file
// type, then launch the report directly through it as a file:// URL.
//
// We resolve via PowerShell's .NET registry API (Get-Item(...).GetValue),
// NOT `reg.exe` + text parsing: reg.exe prints the registry's unnamed
// "default value" under a LOCALIZED pseudo-label — English "(Default)",
// Russian "(по умолчанию)", German "(Standard)", etc — so any parsing
// anchored on that label breaks on non-English Windows (confirmed broken on
// a ru-RU machine). .NET's GetValue(null) returns the value directly; there
// is no label to parse, so this is locale-proof by construction.
//
// Output is tagged with a fixed marker and base64-encoded before being
// printed, and only the marker-prefixed line is decoded, so extraneous
// stdout content (banners, logon-script noise, AV/EDR output) can't be
// misread as a resolved command — plain base64 decoding never throws in
// Node even on garbage input.
//
// Two defensive bounds on the resolution step itself:
//   - `timeout: 5000` on the PowerShell execFile call — without it, a
//     hung/stalled powershell.exe (AV scanning it, a dead network share,
//     a WMI hang) would hang the whole CLI forever, since the caller awaits
//     this before exiting.
//   - the resolved template's leading exe path is verified to exist on disk
//     before being trusted. Without this, a stale registry entry pointing
//     at an uninstalled/moved browser would still report "success" — Node's
//     'error' event only fires if spawning cmd.exe itself fails, not if
//     cmd.exe's own child fails to start.
// If resolution fails at any point (unusual setup, missing keys, timeout,
// missing exe), we fall back to the old `start`-based behaviour rather than
// erroring.
//
// We spawn the resolved browser exe DIRECTLY (no shell, URL as its own argv
// element) rather than building a command-line string and running it via
// `shell:true`. This was discovered live: Chrome's `--single-argument` flag
// (added as security hardening against argument injection via ShellExecute)
// treats everything after it as a literal raw string instead of doing normal
// quote-stripping — so any quotes WE add ourselves around the URL end up
// embedded in the literal value Chrome navigates to (observed: the address
// bar showed `"file:///...report.html"`, quotes and all, and Chrome tried to
// resolve it as a search query). Spawning the exe directly with the URL as
// its own array element sidesteps this: there's no shell and no hand-built
// command-line string to quote in the first place, so nothing exists for
// that mechanism to misinterpret — Node's own (non-shell) Windows argv
// handling passes each array element through as a distinct argument. This
// also incidentally removes the entire class of shell-metacharacter risk
// (`&`, `|`, etc. in a resolved path) that `shell:true` carried.
//
// Behaviour:
//   - win32:  resolve the https UserChoice ProgId -> its shell\open\command,
//             tokenize it into an exe path + args, substitute the file://
//             URL for the %1/%L placeholder token, and spawn the exe
//             directly. Falls back to `cmd /c start "" "<target>"` if
//             resolution fails.
//   - darwin: open "<target>"
//   - other:  xdg-open "<target>"          (Linux, BSD, etc)
//
// We spawn detached + stdio:ignore + unref() so the parent process exits
// cleanly without waiting for the browser. Errors (e.g. xdg-open missing
// on a headless Linux box) surface via the 'error' event — callers get a
// boolean back so they can fall back to printing the path.

import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

// Scheme must be 2+ chars: every real URI scheme this could see (http,
// https, file, ftp) is 2+ chars, and a Windows drive letter is always
// exactly 1 — this is what distinguishes "C://foo" (a path, however oddly
// slashed — reachable via an unnormalized --output flag) from "https://foo"
// (a real URL), with no drive-letter special case needed.
const IS_URL = /^[a-z][a-z0-9+.-]+:\/\//i;
const MARKER = 'AEO_BROWSER_CMD_B64:';

function toTargetUrl(target) {
  return IS_URL.test(target) ? target : pathToFileURL(resolvePath(target)).href;
}

/**
 * Isolate the AEO_BROWSER_CMD_B64:-tagged line from PowerShell's stdout and
 * decode its base64 payload back to the original UTF-8 command string.
 * Returns null if the marker line is absent or the payload is empty/invalid.
 * @param {string} stdout
 * @returns {string|null}
 */
export function decodeBase64Utf8(stdout) {
  if (!stdout) return null;
  const line = stdout.split(/\r?\n/).find(l => l.startsWith(MARKER));
  if (!line) return null;
  const payload = line.slice(MARKER.length).trim();
  if (!payload) return null;
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return decoded || null;
  } catch {
    return null;
  }
}

const PLACEHOLDER_RE = /^(%1|%L)$/i;

/**
 * Tokenize a registry "open" command template into whitespace-separated
 * tokens, treating "..." segments as single tokens (their quotes stripped).
 * Sufficient for these machine-generated, non-adversarial templates (an exe
 * path plus a handful of simple flags) — not a full Windows command-line
 * parser.
 * @param {string} template
 * @returns {string[]}
 */
function tokenizeTemplate(template) {
  const tokens = [];
  let i = 0;
  const n = template.length;
  while (i < n) {
    while (i < n && /\s/.test(template[i])) i++;
    if (i >= n) break;
    if (template[i] === '"') {
      const end = template.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push(template.slice(i + 1));
        i = n;
      } else {
        tokens.push(template.slice(i + 1, end));
        i = end + 1;
      }
    } else {
      let j = i;
      while (j < n && !/\s/.test(template[j])) j++;
      tokens.push(template.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/**
 * Turn a resolved registry "open" command template into `{ exePath, args }`
 * ready for a direct (non-shell) spawn, substituting `url` for the
 * template's `%1`/`"%1"`/legacy `%L` placeholder token (appending it if none
 * is found). Returns null if the template has no tokens at all.
 * @param {string} template
 * @param {string} url
 * @returns {{exePath: string, args: string[]}|null}
 */
export function buildSpawnArgs(template, url) {
  const tokens = tokenizeTemplate(template);
  if (tokens.length === 0) return null;
  const [exePath, ...rest] = tokens;
  const hasPlaceholder = rest.some(t => PLACEHOLDER_RE.test(t));
  const args = hasPlaceholder
    ? rest.map(t => PLACEHOLDER_RE.test(t) ? url : t)
    : [...rest, url];
  return { exePath, args };
}

/**
 * Extract the leading executable path from a registry "open" command
 * template, which is always either `"<quoted path>" <args>` or
 * `<unquoted-no-space-path> <args>`.
 * @param {string} template
 * @returns {string|null}
 */
export function extractExePath(template) {
  const trimmed = template.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end === -1 ? null : trimmed.slice(1, end);
  }
  const spaceIdx = trimmed.indexOf(' ');
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

const RESOLVE_BROWSER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$progId = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice').ProgId
$cmd = $null
if ($progId) { $cmd = (Get-Item -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$progId\\shell\\open\\command").GetValue($null) }
if (-not $cmd) { $cmd = (Get-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\https\\shell\\open\\command').GetValue($null) }
if ($cmd) { Write-Output ("AEO_BROWSER_CMD_B64:" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($cmd))) }
`;

async function resolveWindowsBrowserCommand() {
  const template = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', RESOLVE_BROWSER_SCRIPT],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => resolve(err ? null : decodeBase64Utf8(stdout))
    );
  });
  if (!template) return null;
  const exePath = extractExePath(template);
  if (!exePath) return null;
  try {
    await access(exePath);
  } catch {
    return null;
  }
  return template;
}

function runDetached(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.unref();
      // Resolve on next tick — if spawn was going to fail synchronously
      // ('error' event fires async on next tick), we'd hear about it first.
      setImmediate(() => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

async function openWindows(target) {
  const url = toTargetUrl(target);
  const template = await resolveWindowsBrowserCommand();
  if (template) {
    const spawnArgs = buildSpawnArgs(template, url);
    if (spawnArgs && await runDetached(spawnArgs.exePath, spawnArgs.args)) {
      return true;
    }
  }
  // Resolution failed or the resolved browser didn't launch — fall back to
  // the file-type association via `start` rather than erroring out.
  return runDetached('cmd', ['/c', 'start', '""', target]);
}

/**
 * @param {string} target  absolute path or URL
 * @returns {Promise<boolean>} true if the OS handler was launched, false on error
 */
export function openInBrowser(target) {
  const p = process.platform;
  if (p === 'win32') return openWindows(target);
  if (p === 'darwin') return runDetached('open', [target]);
  return runDetached('xdg-open', [target]);
}
