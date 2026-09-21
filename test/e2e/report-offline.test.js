/**
 * E2E — `report --offline` makes NO request and writes NOTHING.
 *
 * WHAT WENT WRONG. Re-rendering an old run was assumed to be free, and it is
 * not. Measured 2026-09-21 on a copy of a client date with a counter on every
 * outgoing request: `report --for-date` made 45 outgoing attempts on a cold
 * cache with all four `--no-*` flags set — three fetchers
 * (`citationClassification`, `llmActions`, `crawlability`) never had a flag at
 * all, and one of them is a PAID classify-tier call. And on a WARM cache, which
 * made zero requests, the source `_summary.json` was still rewritten
 * (sha256 b44c01f2… → e02347e3…), because `regionContext` and
 * `responseFreshness` are pure derivations that persist on every report.
 *
 * So the two halves of this file are independent failures, and both are real:
 * one spends money, the other edits a record that was already handed to a
 * client.
 *
 * WHY THE GUARD IS WHERE IT IS. `--offline` is enforced in
 * `lib/util/fetch-with-timeout.js` and `persistSnapshot`, one place each. A
 * per-field `!args.offline` test is exactly the shape that produced the bug:
 * the flag was written per-fetcher, three fetchers were added later, and none
 * of them got one. This test therefore does NOT enumerate fields — it counts
 * outgoing attempts, which is the property that must hold for fields nobody
 * has written yet.
 *
 * MEASUREMENT, NOT ASSERTION. The subprocess runs under a preload that replaces
 * `fetch`, `http.request` and `https.request` with recorders that refuse and
 * log the target. "Zero requests" is then a number read off disk, not a claim
 * about which code paths we believe were skipped. A stub that only counted
 * `fetch` would miss a module reaching for `node:https` directly.
 *
 * Mutation-sanity (each MUST go red, verified 2026-09-21):
 *   - remove the `if (OFFLINE) throw offlineError(url)` line in
 *     fetch-with-timeout.js → the request count goes non-zero in every mode.
 *   - remove the `if (isOfflineMode()) return` line in `persistSnapshot` → the
 *     summary hash changes.
 *   - gate ONE field by hand instead (e.g. `!args.offline` on page-signals
 *     only) and drop the fetch-layer guard → still non-zero, which is the whole
 *     argument for the single door.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  responsesDateDir,
  todayDateString,
  offlineFetchEnv,
} from './_helpers.js';

const DOMAIN = 'offlinebrand.com';
const DATE = '2026-07-07';

/**
 * Records every outgoing attempt and refuses it. Written to disk so the test
 * reads a measurement rather than trusting the run's own report of itself.
 */
const COUNTER_PRELOAD = `
import { writeFileSync } from 'node:fs';
const hits = [];
const die = (u) => { hits.push(String(u)); throw new Error('NETWORK BLOCKED: ' + u); };
globalThis.fetch = (u) => die(typeof u === 'string' ? u : (u && u.url) || u);
const https = await import('node:https');
const http = await import('node:http');
for (const m of [https.default, http.default]) {
  for (const k of ['request', 'get']) {
    m[k] = (...a) => die(typeof a[0] === 'string' ? a[0] : (a[0] && (a[0].hostname || a[0].host)) || 'node-http');
  }
}
process.on('exit', () => writeFileSync(process.env.AEO_TEST_FETCH_LOG, JSON.stringify(hits)));
`;

/**
 * A run with a COLD cache: none of the fetched fields present, so every fetcher
 * has a reason to call out. A warm fixture would make this test pass over
 * nothing — the fetchers would short-circuit on the cache and never reach the
 * guard being tested.
 */
function seedColdRun(dir) {
  const dd = responsesDateDir(dir, DOMAIN, DATE);
  mkdirSync(dd, { recursive: true });

  const results = [];
  for (let i = 1; i <= 9; i++) {
    const hit = i <= 3;
    results.push({
      query: `Q${i}`, queryText: `question ${i}`, provider: 'openai', label: 'ChatGPT',
      model: 'gpt-5-search-api', mode: 'web', mention: hit ? 'yes' : 'no',
      position: hit ? 2 : null, citationCount: hit ? 1 : 0,
      // A citation to a THIRD-PARTY domain: this is what gives
      // `citationClassification` and `outreachTemplates` something to fetch.
      canonicalCitations: hit ? ['https://someblog.example/post'] : [],
      competitors: hit ? ['RivalCo'] : [], competitorsUnverified: [],
      topCompetitors: [], responseQuality: 'ok', hasBrandInCitations: false,
      elapsedMs: 10, responseExcerpt: hit ? 'OfflineBrand is named.' : 'Not named.',
    });
  }

  writeFileSync(join(dd, '_summary.json'), JSON.stringify({
    date: DATE, brand: 'OfflineBrand', domain: DOMAIN,
    score: 33, mentions: 3, total: 9, errors: 0,
    topCompetitors: [{ name: 'RivalCo', count: 3 }],
    topDomains: [{ domain: 'someblog.example', count: 3 }],
    topCanonicalSources: [{ domain: 'someblog.example', count: 3 }],
    results,
  }, null, 2));

  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'OfflineBrand', domain: DOMAIN, queries: ['question 1'],
    providers: {
      openai: { model: 'gpt-5-search-api', classifyModel: 'gpt-5-mini', env: 'OPENAI_API_KEY' },
      gemini: { model: 'gemini-3.5-flash', env: 'GEMINI_API_KEY' },
    },
  }, null, 2));

  return join(dd, '_summary.json');
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Env with BOTH preloads: the suite's own offline seam and this file's counter.
 *
 * Composed, never assigned: `offlineFetchEnv()` puts its own `--import` in
 * NODE_OPTIONS, so writing the key outright silently switches the house seam
 * off for this file only. The tests would stay green either way — the counter
 * refuses everything the seam would have answered — which is exactly why the
 * mistake survives a passing run and surfaces later as one E2E file behaving
 * unlike every other.
 */
function counterEnv(dir) {
  const preloadPath = join(dir, 'count-fetch.mjs');
  const logPath = join(dir, 'fetch-log.json');
  writeFileSync(preloadPath, COUNTER_PRELOAD);
  const base = offlineFetchEnv();
  return {
    logPath,
    env: {
      ...base,
      AEO_TEST_FETCH_LOG: logPath,
      NODE_OPTIONS: [base.NODE_OPTIONS, `--import=${pathToFileURL(preloadPath).href}`]
        .filter(Boolean).join(' '),
    },
  };
}

function runOffline(dir, extraArgs) {
  const { env, logPath } = counterEnv(dir);
  const r = spawnCli(
    ['report', '--for-date', DATE, '--no-open', '--offline', ...extraArgs],
    { cwd: dir, env },
  );
  assertExitCode(r, 0, `report --offline ${extraArgs.join(' ')} should still produce a report`);
  return JSON.parse(readFileSync(logPath, 'utf-8'));
}

for (const [mode, args] of [
  ['default', []],
  ['--public', ['--public']],
  ['--white-label', ['--white-label']],
]) {
  test(`${mode}: --offline makes zero outgoing requests on a cold cache`, async () => {
    await withTmpProject(`aeo-e2e-offline-${mode.replace(/\W+/g, '')}-`, async (dir) => {
      seedColdRun(dir);
      const attempts = runOffline(dir, args);
      assert.deepEqual(
        attempts, [],
        `--offline must not reach the network; attempted: ${JSON.stringify(attempts)}`,
      );
    });
  });
}

test('--offline leaves the source summary byte-for-byte unchanged', async () => {
  await withTmpProject('aeo-e2e-offline-nowrite-', async (dir) => {
    const summaryPath = seedColdRun(dir);
    const before = sha(summaryPath);
    runOffline(dir, []);
    assert.equal(
      sha(summaryPath), before,
      'nothing was fetched, so there is nothing to cache and nothing to write — '
      + 'a re-render must not edit a record that was already delivered',
    );
  });
});

test('--offline and --refresh-cache refuse to run together instead of silently doing nothing', async () => {
  await withTmpProject('aeo-e2e-offline-refresh-', async (dir) => {
    seedColdRun(dir);
    const r = spawnCli(
      ['report', '--for-date', DATE, '--no-open', '--offline', '--refresh-cache', 'all'],
      { cwd: dir, env: offlineFetchEnv() },
    );
    assertExitCode(r, 2, 'a contradictory pair must fail loudly, not pick one silently');
    assert.match(
      `${r.stderr}`, /contradict/i,
      `the refusal must say why; stderr was:\n${r.stderr}`,
    );
  });
});

test('`run --offline` refuses instead of parsing cleanly and doing nothing', async () => {
  // The options table is global, so a `report` flag is accepted by every
  // command. Silently ignoring it would repeat the defect this flag exists to
  // close: `--help` promised "a fully offline report" from four skip-flags
  // while three fetchers called out regardless. An explicit request must be
  // honoured or refused, never quietly dropped.
  await withTmpProject('aeo-e2e-offline-wrongcmd-', async (dir) => {
    seedColdRun(dir);
    const r = spawnCli(['run', '--offline'], { cwd: dir, env: offlineFetchEnv() });
    assertExitCode(r, 2, 'a report-only flag on `run` must fail, not no-op');
    assert.match(
      `${r.stdout}${r.stderr}`, /--replay/,
      'and must name the free path `run` actually has',
    );
  });
});

test('a cold run WITHOUT --offline does reach the network — the control for every test above', async () => {
  // Without this, all four tests above would pass just as happily against a
  // fixture that has nothing to fetch, a build where the report does no network
  // work at all, or a preload that silently failed to install. The seed has to
  // be proven capable of producing the behaviour the flag suppresses.
  await withTmpProject('aeo-e2e-offline-control-', async (dir) => {
    const summaryPath = seedColdRun(dir);
    const before = sha(summaryPath);
    const preloadPath = join(dir, 'count-fetch.mjs');
    const logPath = join(dir, 'fetch-log.json');
    writeFileSync(preloadPath, COUNTER_PRELOAD);

    spawnCli(['report', '--for-date', DATE, '--no-open'], {
      cwd: dir,
      env: {
        ...offlineFetchEnv(),
        AEO_TEST_FETCH_LOG: logPath,
        NODE_OPTIONS: `--import ${preloadPath}`,
      },
    });

    const attempts = JSON.parse(readFileSync(logPath, 'utf-8'));
    assert.ok(
      attempts.length > 0,
      'the seed must give the report something to fetch, or the --offline tests prove nothing',
    );
    assert.notEqual(
      sha(summaryPath), before,
      'and a normal report must be the thing that rewrites the summary, or the no-write test proves nothing',
    );
  });
});
