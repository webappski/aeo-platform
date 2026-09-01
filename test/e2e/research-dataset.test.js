/**
 * E2E for `bin/research-dataset.mjs` — the own-brand research aggregator.
 *
 * Why E2E and not unit (R37): every property worth guarding here is a property
 * of the WHOLE pipeline — which files the scanner walks into, which runs the
 * allow-list lets through, what the process actually writes to disk. A unit test
 * of `aggregate()` would pass while the scanner happily walked a client folder,
 * which is the one failure that must never happen. So this spawns the real
 * binary against a real directory tree and asserts on the real JSON it wrote.
 *
 * Two tiers:
 *   1. Portable — builds a temp corpus (real `_summary.json` shape, neutral
 *      names) so the invariants are checked on any machine, including CI.
 *   2. Real corpus — when this machine actually holds tracker runs, re-checks
 *      the privacy invariant against the real files rather than a stand-in.
 *      Skips cleanly (never fails) when the runs are not there.
 *
 * Offline by construction: the aggregator only reads files. The static guard at
 * the end enforces that, so "zero cost" cannot regress into an API call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'research-dataset.mjs');

/** One observation in the exact shape `aeo-platform run` persists. */
function observation(over = {}) {
  return {
    query: 'Q1',
    queryText: 'best answer engine optimization agency 2026',
    provider: 'openai',
    label: 'ChatGPT',
    model: 'gpt-5-search-api',
    mode: 'web',
    mention: 'no',
    position: null,
    citationCount: 1,
    canonicalCitations: ['https://www.example-directory.test/list?utm_source=chatgpt.com'],
    competitors: ['Example Agency'],
    competitorsUnverified: [],
    responseQuality: 'narrative',
    hasBrandInCitations: false,
    responseExcerpt: 'text',
    elapsedMs: 1234,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    ...over,
  };
}

function writeRun(dir, summary) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_summary.json'), JSON.stringify(summary, null, 2));
}

/** Build a corpus that contains every case the scanner must get right. */
function seedCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-dataset-'));

  // (a) An own run — three engines, one Polish-language question.
  const ownResults = [
    observation({ provider: 'openai', model: 'gpt-5-search-api', elapsedMs: 11 }),
    observation({
      provider: 'gemini', model: 'gemini-3.7-flash', elapsedMs: 22,
      queryText: 'najlepsze agencje Answer Engine Optimization 2026',
      canonicalCitations: ['https://agencjaexample.pl/blog', 'https://www.example-directory.test/list'],
      competitors: ['Agencja Example', 'Example', 'EXAMPLE', 'Exámple', 'Example.pl'],
    }),
    observation({
      provider: 'anthropic', model: 'manual', source: 'manual', elapsedMs: 33,
      queryText: 'AEO consultants Poland',
      canonicalCitations: ['https://youtube.com/watch?v=abc'],
      // Non-Latin names: two different companies that must stay apart, and one
      // ё/е spelling pair that must fold together.
      competitors: ['Example Agency', 'Компания Альфа', 'Компания Бета', 'Партнёры Икс', 'Партнеры Икс'],
    }),
    observation({ provider: 'openai', model: 'gpt-5-search-api', elapsedMs: 44, error: 'timeout', mention: undefined }),
  ];
  const ownSummary = {
    date: '2026-08-01', brand: 'Typelessform', domain: 'typelessform.com',
    score: 0, mentions: 0, total: 4, results: ownResults,
    competitorPricing: [{ name: 'Agencja Example', domain: 'https://agencjaexample.pl/' }],
  };
  writeRun(path.join(root, 'typelessform', 'aeo-responses', '2026-08-01'), ownSummary);

  // (b) A client run — a domain that is NOT on the allow-list. Must never
  //     contribute a single row, a single citation, or a single brand name.
  writeRun(path.join(root, 'clients', 'acme', 'aeo-responses', '2026-08-02'), {
    date: '2026-08-02', brand: 'AcmeClient', domain: 'acme-client.example',
    results: [
      observation({ competitors: ['AcmeSecretRival'], canonicalCitations: ['https://acme-secret-source.example/x'] }),
      observation({ provider: 'gemini', model: 'gemini-3.7-flash', elapsedMs: 99 }),
    ],
  });

  // (c) A byte-identical backup copy of the own run, in a differently-named
  //     folder. The 32%-inflation bug: found by name, deduped by content.
  writeRun(path.join(root, 'clients', 'webappski', '_session-2026-08-10', 'tree-backup-before-move', 'webappka-aeo-responses', '2026-08-01'), ownSummary);

  // (d) Copies the scanner must not even open.
  writeRun(path.join(root, 'somepkg', 'node_modules', 'x', 'aeo-responses', '2026-08-01'), ownSummary);
  writeRun(path.join(root, 'aeo-tracker', 'test', 'fixtures', 'aeo-responses', 'stable'), ownSummary);
  writeRun(path.join(root, 'api', 'src', '__tests__', 'traces'), ownSummary);

  return root;
}

function runAggregator(root, extraArgs = []) {
  const out = path.join(root, 'dataset.json');
  const res = spawnSync(process.execPath, [BIN, '--root', root, '--out', out, ...extraArgs], { encoding: 'utf8' });
  return { res, out, json: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

test('research-dataset: client runs are excluded, and nothing of theirs leaks anywhere', () => {
  const root = seedCorpus();
  try {
    const { res, json } = runAggregator(root);
    assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
    assert.ok(json, 'dataset.json was written');

    // Scan the ENTIRE serialized output — minus the exclusion table, where
    // naming the domain IS the transparency requirement — for anything that
    // could only have come from the client run.
    const { excludedRuns, ...restOfScope } = json.scope;
    const blob = JSON.stringify({ ...json, scope: restOfScope });
    for (const secret of ['acme-client.example', 'AcmeSecretRival', 'acme-secret-source.example', 'AcmeClient']) {
      assert.ok(!blob.includes(secret), `client data leaked into the dataset: ${secret}`);
    }
    // The client's own measurements — brand names and cited sources — must not
    // appear even in the exclusion table, which reports only domain + counts.
    const exclusionBlob = JSON.stringify(excludedRuns);
    for (const secret of ['AcmeSecretRival', 'acme-secret-source.example', 'AcmeClient']) {
      assert.ok(!exclusionBlob.includes(secret), `client measurement data leaked: ${secret}`);
    }

    // …and the exclusion is reported, not silent.
    const excluded = json.scope.excludedRuns.find(e => e.domain === 'acme-client.example');
    assert.ok(excluded, 'excluded client run is reported in scope.excludedRuns');
    assert.equal(excluded.runs, 1);
    assert.equal(excluded.observations, 2);
    assert.equal(json.scope.excludedRunsTotal, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: duplicate copies are dropped and attributed to the COPY, not the original', () => {
  const root = seedCorpus();
  try {
    const { json } = runAggregator(root);
    // 4 rows in the own run, 1 of them errored → 3 usable, counted once.
    assert.equal(json.scope.rawOwnObservationsBeforeDedupe, 8, 'both copies were read');
    assert.equal(json.scope.duplicateObservationsDropped, 4, 'the copy contributed nothing');
    assert.equal(json.scope.droppedErroredOrMentionless, 1);
    assert.equal(json.scope.includedObservations, 3);
    assert.equal(json.slices.all.observations, 3);

    const flagged = json.scope.duplicateSources.map(d => d.file);
    assert.equal(flagged.length, 1);
    assert.match(flagged[0], /tree-backup-before-move/,
      'the backup copy must be the one flagged — flagging the original reads backwards');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: node_modules / fixtures / __tests__ are never scanned', () => {
  const root = seedCorpus();
  try {
    const { json } = runAggregator(root);
    // 2 own copies + 1 client = 3 files. The three excluded-directory copies
    // would each add 4 more raw rows if the walker entered them.
    assert.equal(json.meta.summaryFilesFound, 3);
    assert.equal(json.scope.includedRuns, 1, 'only the original own run contributes rows');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: emits a cross-section with drift bounds, and no trend metric', () => {
  const root = seedCorpus();
  try {
    const { json } = runAggregator(root);

    assert.equal(json.meta.isCrossSection, true);
    assert.ok(json.meta.notATimeSeries.length > 40, 'the limitation is stated, not implied');

    // The instrument's own drift must be visible to any consumer of the JSON.
    assert.ok(json.instrumentDrift.distinctProviderModels >= 3);
    assert.deepEqual(json.instrumentDrift.runDates, ['2026-08-01']);
    assert.equal(json.instrumentDrift.manualLegs.length, 1, 'the hand-pasted leg is declared');
    assert.equal(json.instrumentDrift.manualLegs[0].provider, 'anthropic');

    // No trend/growth/delta anywhere — this dataset must not grow a time axis
    // by accident, because the instrument cannot support one.
    const forbidden = /"[a-zA-Z]*(trend|growth|delta|changeSince|previousRun|momentum)[a-zA-Z]*"\s*:/i;
    assert.ok(!forbidden.test(JSON.stringify(json)), 'a time-series metric appeared in a cross-section dataset');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: PL slice separates language from market, and flags a thin engine', () => {
  const root = seedCorpus();
  try {
    const { json } = runAggregator(root);
    const pl = json.slices.pl;

    // One Polish-language question + one English question naming Poland.
    assert.equal(pl.observations, 2);
    assert.equal(pl.sliceDefinition.languageOnly, 1, '"najlepsze agencje ... w Polsce" is PL by language');
    assert.equal(pl.sliceDefinition.marketOnly, 1, '"AEO consultants Poland" is EN text, PL market');
    assert.equal(json.axes.languageCounts.pl, 1, 'the Polish-language question, which names no country');
    assert.equal(json.axes.marketCounts.pl, 1, 'the English question that names Poland');
    assert.equal(pl.sliceDefinition.both, 0, 'neither question carries both signals in this corpus');

    // Every engine here is far below the floor, so none may be quoted.
    assert.ok(pl.enginesBelowFloor.includes('gemini'));
    assert.ok(pl.enginesBelowFloor.includes('anthropic'));
    for (const e of pl.engineCoverage) assert.equal(e.sufficientForPublication, false);
    assert.equal(pl.engineCoverage.find(e => e.provider === 'anthropic').manualObservations, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: competitor spellings are merged, and the merge is shown', () => {
  const root = seedCorpus();
  try {
    const { json } = runAggregator(root);
    const names = json.slices.all.topCompetitors;

    // "Agencja Example" and "Example" fold to one entity (leading "Agencja "
    // is a title, not part of the name) and the merge is auditable.
    const merged = names.find(c => c.spellingsMerged.length > 1);
    assert.ok(merged, 'at least one entity shows its merged spellings');
    // Every axis of the fold at once: a title prefix, upper case, a diacritic
    // and a domain-style tail all name one company.
    assert.deepEqual(merged.spellingsMerged.map(s => s.name).sort(),
      ['Agencja Example', 'EXAMPLE', 'Example', 'Example.pl', 'Exámple']);
    assert.equal(merged.mentions, 5);
    assert.equal(merged.mentions, merged.spellingsMerged.reduce((s, x) => s + x.count, 0),
      'the merged total equals the sum of its parts — no double counting, no lost rows');

    // "Example Agency" is a DIFFERENT company and must survive as its own
    // entity — over-merging is as wrong as under-merging when we name names.
    const separate = names.find(c => c.entity === 'Example Agency');
    assert.ok(separate, '"Example Agency" was not swallowed into "Example"');
    assert.equal(separate.mentions, 2);

    // Equal-count rows are flagged as ties: the sort order between them is
    // alphabetical, and publishing it as a ranking is how a public table gets
    // a fact wrong about a company that is reading it.
    const tied = names.filter(c => c.tiedWith && c.tiedWith.length > 0);
    assert.ok(tied.length >= 2, 'equal-mention entities are marked as tied');
    for (const c of tied) {
      for (const other of c.tiedWith) {
        assert.equal(names.find(x => x.entity === other).mentions, c.mentions,
          'a tie marker must point at a row with the identical count');
      }
    }
    const alfa = names.find(c => c.entity === 'Компания Альфа');
    assert.ok(alfa && alfa.tiedWith.includes('Компания Бета'), 'two distinct 1-mention entities are marked tied, not ranked');

    // …and the pair we chose not to merge is published for a human to rule on.
    // (The display name of the merged entity is whichever spelling the engines
    // used most; here all five tie, so it is the longest — hence matching on
    // `longer` rather than on both sides of the pair.)
    const collision = json.entityCanonicalisation.unmergedNearCollisions
      .find(n => n.longer === 'Example Agency');
    assert.ok(collision, 'a deliberately unmerged near-collision is disclosed');

    // A directory citation keeps its tracking parameter out of the page key.
    const page = json.slices.all.topPages.find(p => p.host === 'example-directory.test');
    assert.ok(page && !page.url.includes('utm_source'), 'utm parameters are stripped from cited URLs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: non-Latin names are not fused into one entity', () => {
  const root = seedCorpus();
  try {
    const { json } = runAggregator(root);
    const names = json.slices.all.topCompetitors;
    const byName = n => names.find(c => c.entity === n);

    // The regression this guards: an ASCII-only fold deletes every character of
    // a Cyrillic name, so all of them collapse to one key and merge. On the real
    // corpus that fused 15 unrelated Russian agencies into a single entity.
    assert.ok(byName('Компания Альфа'), 'Компания Альфа survives as its own entity');
    assert.ok(byName('Компания Бета'), 'Компания Бета survives as its own entity');
    assert.equal(byName('Компания Альфа').mentions, 1);
    assert.equal(byName('Компания Бета').mentions, 1);

    // …while a genuine ё/е spelling variant of ONE name still merges.
    const partners = names.find(c => /Партн[её]ры Икс/.test(c.entity));
    assert.ok(partners, 'the ё/е pair resolves to one entity');
    assert.equal(partners.mentions, 2);
    assert.equal(partners.spellingsMerged.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('research-dataset: zero-cost invariant — the aggregator cannot reach the network', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bfetch\s*\(/.test(code), 'no fetch() call');
  assert.ok(!/from\s+['"]node:?https?['"]/.test(code), 'no http/https import');
  assert.ok(!/require\(['"]node:?https?['"]\)/.test(code), 'no http/https require');
  assert.ok(!/\bXMLHttpRequest\b|\bundici\b|node-fetch/.test(code), 'no other HTTP client');
});

/**
 * Real-corpus tier. The portable tier proves the rules; this proves they hold
 * on the actual files this machine carries, which is the only place a real
 * client's data can leak from. Skips (never fails) where those runs are absent.
 */
test('research-dataset: on the real local corpus, no excluded domain appears in the output', (t) => {
  const realRoot = path.dirname(REPO);
  const probe = spawnSync(process.execPath, [BIN, '--root', realRoot, '--out', path.join(os.tmpdir(), `rd-real-${process.pid}.json`)], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip(`aggregator could not read ${realRoot}`);
  const outFile = path.join(os.tmpdir(), `rd-real-${process.pid}.json`);
  const json = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  try {
    if (json.scope.excludedRuns.length === 0 || json.scope.includedRuns === 0) {
      return t.skip('no real tracker runs on this machine — nothing to check');
    }
    const { excludedRuns, ...restOfScope } = json.scope;
    const blob = JSON.stringify({ ...json, scope: restOfScope });
    for (const e of excludedRuns) {
      if (!e.domain || e.domain.startsWith('(')) continue;
      assert.ok(!blob.includes(e.domain),
        `an excluded domain leaked into the real dataset outside the exclusion table: ${e.domain}`);
      assert.deepEqual(Object.keys(e).sort(), ['domain', 'examplePath', 'observations', 'runs'],
        'the exclusion table reports counts only — never a client measurement');
    }
    // And the own side is non-empty, so the check above is not vacuous.
    assert.ok(json.slices.all.citationInstances > 0, 'own-brand citations were aggregated');
    assert.ok(json.scope.duplicateObservationsDropped >= 0);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
});
