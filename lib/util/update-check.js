// Self-announcing update check (1.2.x, version-awareness package).
//
// The stale-global trap: a client installs once with `npm i -g`, versions
// move on, and the tool silently keeps running the old build — the client
// has no way to know. This module makes the CLI say so itself, npm-style:
// a cached registry check (24h TTL) and a one-line "Update available" banner.
//
// Privacy contract (README §privacy): the ONLY network traffic is one GET to
// registry.npmjs.org (the same host npm itself talks to) at most once per
// day; no telemetry, nothing sent, opt-out via AEO_NO_UPDATE_CHECK=1.
// Every failure path is silent — an update check must never break a command.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CACHE_PATH = join(tmpdir(), 'aeo-platform-update-check.json');
export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org/aeo-platform/latest';

/**
 * Compare two dotted versions. Returns 1 if a > b, -1 if a < b, 0 if equal,
 * null if either side is unparseable (prerelease tags and garbage fail safe —
 * callers treat null as "no banner").
 */
export function cmpVersions(a, b) {
  const parse = (v) => {
    const parts = String(v || '').trim().split('.');
    if (parts.length < 3 || parts.some(p => !/^\d+$/.test(p))) return null;
    return parts.map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Banner suppression policy: explicit opt-out, CI environments, and
 * non-interactive output (cron logs, pipes) — the banner is advice for a
 * human at a terminal, not noise for machines.
 */
export function shouldSkipUpdateCheck(env = process.env, isTTY = process.stdout.isTTY) {
  return env.AEO_NO_UPDATE_CHECK === '1' || Boolean(env.CI) || !isTTY;
}

/**
 * Decide whether a newer version exists. Cache-first: a fresh cache answers
 * with zero network; a stale/absent cache costs ONE registry GET with a hard
 * timeout, then refreshes the cache. All failures → { updateAvailable: false }.
 *
 * @param {Object} opts
 * @param {string} opts.currentVersion
 * @param {Function} [opts.fetchImpl]    injected for tests
 * @param {number}  [opts.now]
 * @param {string}  [opts.cachePath]
 * @param {string}  [opts.registryUrl]
 * @param {number}  [opts.timeoutMs]
 * @returns {Promise<{updateAvailable: boolean, latest: string|null}>}
 */
export async function maybeCheckForUpdate({
  currentVersion,
  fetchImpl = fetch,
  now = Date.now(),
  cachePath = DEFAULT_CACHE_PATH,
  registryUrl = DEFAULT_REGISTRY_URL,
  timeoutMs = 1500,
}) {
  const verdict = (latest) => ({
    updateAvailable: cmpVersions(latest, currentVersion) === 1,
    latest: latest || null,
  });

  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf-8'));
    if (cached && typeof cached.latest === 'string'
      && Number.isFinite(cached.checkedAt)
      && now - cached.checkedAt < UPDATE_CHECK_TTL_MS) {
      return verdict(cached.latest);
    }
  } catch { /* absent or corrupt cache → fall through to live check */ }

  try {
    const res = await fetchImpl(registryUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { updateAvailable: false, latest: null };
    const latest = (await res.json())?.version;
    if (typeof latest !== 'string') return { updateAvailable: false, latest: null };
    try {
      await writeFile(cachePath, JSON.stringify({ checkedAt: now, latest }));
    } catch { /* unwritable cache → still answer from the live result */ }
    return verdict(latest);
  } catch {
    return { updateAvailable: false, latest: null };
  }
}
