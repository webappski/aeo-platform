/**
 * E2E — which model a run measures with, and which model grades it, must never
 * be chosen by accident: not by the order a catalogue lists its ids in, not by
 * a non-chat model that merely looks cheap, and (further down) not by a flagship
 * that happens to be the only id in the newest generation.
 *
 * WHAT WENT WRONG (a measurement run, 2026-10-11)
 *   `extractorModels = [gemini-3.1-flash-lite, gpt-4o-mini-tts]`: the cheap-tier
 *   picker (`fetchOpenAIClassifyModel`) filtered out `search|audio|realtime` and
 *   nothing else, so the text-to-speech model and the transcription model stayed
 *   in the pool, passed its "-mini" requirement, and the winner was whichever id
 *   `/v1/models` listed first. Every second extraction answered "not a chat
 *   model", the report said "0 brands verified, 398 unverified", and no flag
 *   could repair it — a config `classifyModel` loses to live discovery.
 *
 * WHAT THESE TESTS LOOK AT: THE REQUEST, NOT THE LOG
 * The run log names a model; the model that is CALLED is the one in the request
 * body. A first version of these tests read the printed `classify:` line, and a
 * mutant that printed the discovered extractor and then sent the config's one
 * passed every test. The preload journals `<METHOD> <url> model=<body.model>`
 * (`AEO_E2E_URL_LOG`), the answer stub lets a run reach its extraction calls,
 * and the assertions are on `model=` of the answer/chat requests. The printed
 * line is asserted second, for the human who reads it.
 *
 * WHY E2E (R37 Gate 0): the defect is in what the REAL run loop does with a
 * catalogue; the pure selectors are unit-covered in test/discover.test.js, but a
 * unit test cannot see that the loop ignored a flag or kept going after a
 * refusal. No account, no key, no money: every request is answered by the
 * `_helpers.js` preload.
 *
 * THE CATALOGUE is the live OpenAI key's, 133 ids, 2026-10-13
 * (test/fixtures/openai-models-2026-10-13.json) — not a subset chosen by the
 * author, because the defect was an UNKNOWN family reaching the pool.
 *
 * CROSS-PLATFORM: no shell, no signals, no path separators typed by hand (every
 * path goes through `join`), journal lines split on `\n` and compared as text.
 * The `--help` test reads the help through a file descriptor passed to
 * `spawnSync` — portable, and independent of the 8 KB pipe truncation a
 * `process.exit` right after the print causes (a separate, older defect).
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, openSync, closeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  withTmpProject, spawnCli, offlineFetchEnv, readRequestJournal, isAnswerCall, BIN, FIXTURE_ROOT,
} from './_helpers.js';

const QUERIES = ['best test brands 2026', 'top test brand alternatives'];
const LIVE = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'openai-models-2026-10-13.json'), 'utf-8')).ids;
const MAIN = 'gpt-5.6-luna';   // pinned in these tests: the main tier is not what they are about

const ANSWER = {
  model: MAIN,
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'TestBrand is a solid option here, alongside a couple of alternatives.' }] }],
  usage: { input_tokens: 400, output_tokens: 900 },
};

function seed(dir, providerExtra = {}) {
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: 'testbrand.com',
    queries: QUERIES,
    providers: {
      openai: { model: 'gpt-5.4-nano', classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY', ...providerExtra },
    },
    validationCache: QUERIES.map((query) => ({
      query, valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered',
    })),
  }));
}

/** One `run`; returns the printed output and the REQUESTS it made. */
function run(dir, { catalogue, args = [MAIN_PIN], tag = 'run', env = {} }) {
  const urlLog = join(dir, `requests-${tag}.log`);
  const r = spawnCli(['run', ...args], {
    cwd: dir,
    env: offlineFetchEnv({
      AEO_E2E_CATALOGUE: JSON.stringify(catalogue),
      AEO_E2E_URL_LOG: urlLog,
      AEO_E2E_ANSWER: JSON.stringify(ANSWER),
      ...env,
    }),
    timeout: 60000,
  });
  return { r, out: `${r.stdout || ''}\n${r.stderr || ''}`, requests: readRequestJournal(urlLog) };
}
const MAIN_PIN = `--openai-model=${MAIN}`;

/** The models that were asked to GRADE: answer/chat requests naming anything but the main model. */
const extractorsCalled = (requests) =>
  [...new Set(requests.filter(isAnswerCall).map((q) => q.model).filter((m) => m && m !== MAIN))].sort();
const madePaidCall = (requests) => requests.some(isAnswerCall);

test('the extractor that RUNS is a chat model — on the live catalogue, in API order and reversed', async () => {
  await withTmpProject('aeo-classify-live-', async (dir) => {
    seed(dir);
    for (const [tag, catalogue] of [['fwd', LIVE], ['rev', [...LIVE].reverse()]]) {
      const { out, requests } = run(dir, { catalogue, tag });
      assert.deepStrictEqual(extractorsCalled(requests), ['gpt-4o-mini'],
        `the model asked to grade (${tag}) must be the chat model gpt-4o-mini; requests:\n${JSON.stringify(requests.filter(isAnswerCall))}\n${out}`);
      assert.match(out, /classify: gpt-4o-mini(?![-\w.])/, `the run log must say what it did; got:\n${out}`);
    }
  });
});

test('a non-chat family would win here without the deny list: tts / transcribe rank above the only real cheap tier', async () => {
  await withTmpProject('aeo-classify-denylist-', async (dir) => {
    seed(dir);
    // No `-mini` chat model on this key. `-mini-tts` / `-mini-transcribe` match
    // the "mini" tier (rank 0); the one real cheap chat model is `nano` (rank
    // 3). Take either family out of the deny list and one of them is called.
    const catalogue = ['gpt-4o-mini-tts', 'gpt-4o-mini-transcribe', 'gpt-4.1-nano', 'gpt-4o', 'gpt-5-search-api', MAIN];
    const { requests } = run(dir, { catalogue });
    assert.deepStrictEqual(extractorsCalled(requests), ['gpt-4.1-nano']);
  });
});

test('--openai-classify-model pins the extractor that is CALLED, and the log says where it came from', async () => {
  await withTmpProject('aeo-classify-pin-', async (dir) => {
    seed(dir);
    const { out, requests } = run(dir, { catalogue: LIVE, args: [MAIN_PIN, '--openai-classify-model=gpt-4.1-mini'] });
    assert.deepStrictEqual(extractorsCalled(requests), ['gpt-4.1-mini']);
    assert.match(out, /classify: gpt-4\.1-mini \(pinned by --openai-classify-model\)/);
  });
});

test('AEO_OPENAI_CLASSIFY_MODEL_PIN is the same pin for a script that has no flag to type', async () => {
  await withTmpProject('aeo-classify-env-', async (dir) => {
    seed(dir);
    const { requests } = run(dir, { catalogue: LIVE, env: { AEO_OPENAI_CLASSIFY_MODEL_PIN: 'gpt-4.1-nano' } });
    assert.deepStrictEqual(extractorsCalled(requests), ['gpt-4.1-nano']);
  });
});

test('the QUERY-VALIDATION stage grades with the resolved extractor too, not the config pin', async () => {
  // `activeProviders[].classifyModel` feeds a different consumer from the
  // extractors (the validator) and was set from a different variable: a run
  // log and an extractor that agreed said nothing about it. No validation cache
  // here, so the validator really calls; the stub answers 401 and the run ends
  // — after the request that names the model has been made.
  await withTmpProject('aeo-classify-validation-', async (dir) => {
    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
      brand: 'TestBrand', domain: 'testbrand.com', queries: QUERIES,
      providers: { openai: { model: 'gpt-5.4-nano', classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' } },
    }));
    const { requests } = run(dir, { catalogue: LIVE });
    const firstGrader = requests.find((q) => isAnswerCall(q) && q.model && q.model !== MAIN);
    assert.ok(firstGrader, `the validator made no request; journal:\n${JSON.stringify(requests)}`);
    assert.strictEqual(firstGrader.model, 'gpt-4o-mini',
      'the validator must be sent to the resolved cheap-tier model, not the config\'s gpt-5-nano');
  });
});

test('a classify pin the key does not list stops the run before any paid call', async () => {
  await withTmpProject('aeo-classify-pin-dead-', async (dir) => {
    seed(dir);
    const { r, out, requests } = run(dir, { catalogue: LIVE, args: [MAIN_PIN, '--openai-classify-model=gpt-9.9-ghost'] });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\n${out}`);
    assert.match(out, /--openai-classify-model=gpt-9\.9-ghost/);
    assert.match(out, /does not list that id/);
    assert.ok(!madePaidCall(requests), `a billed call was made before the refusal:\n${JSON.stringify(requests)}`);
  });
});

test('no usable chat model for the cheap tier: stop before any paid call and name the flag', async () => {
  await withTmpProject('aeo-classify-empty-', async (dir) => {
    seed(dir);
    // Search SKU + audio/tts/transcribe/realtime only: nothing a classifier can
    // run on, and the config's `gpt-5-nano` is not on this key either. The MAIN
    // model is pinned to the search SKU that IS listed, so the refusal under
    // test is the cheap tier's alone — a pin the key does not list would end the
    // run through its own, different refusal and let this one pass unseen.
    const catalogue = ['gpt-5-search-api', 'gpt-4o-mini-tts', 'gpt-4o-mini-transcribe', 'gpt-realtime-2.1', 'gpt-audio-mini'];
    const { r, out, requests } = run(dir, { catalogue, args: ['--openai-model=gpt-5-search-api'] });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\n${out}`);
    assert.match(out, /--openai-classify-model=<id>/, `the refusal must name the flag; got:\n${out}`);
    assert.match(out, /Refusing to run: an extractor/, `it must be the cheap-tier refusal, not another one; got:\n${out}`);
    assert.ok(!/does not list that id/.test(out), `a dead-pin refusal answered instead of the cheap-tier one:\n${out}`);
    // A refusal that merely fell through to "No API keys found" (an empty
    // provider list) would also exit 1 — and would LET a run with a second
    // provider carry on. The refusal itself has to be what ends the run.
    assert.ok(!/No API keys found/.test(out), `the run fell through the refusal:\n${out}`);
    assert.ok(!madePaidCall(requests), `a billed call was made before the refusal:\n${JSON.stringify(requests)}`);
  });
});

test('a config classifyModel that is a text-to-speech id is not an extractor, even though the key lists it', async () => {
  await withTmpProject('aeo-classify-cfg-tts-', async (dir) => {
    // The tier of the generation one below the search SKU is not recognised
    // (`gpt-4o` only), so the config rung is consulted — and it names a model
    // the key lists. Listed is not usable.
    seed(dir, { classifyModel: 'gpt-4o-mini-tts' });
    const catalogue = ['gpt-5-search-api', 'gpt-4o', 'gpt-4o-mini-tts', MAIN];
    const { r, out, requests } = run(dir, { catalogue });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\n${out}`);
    assert.match(out, /Listed by the key but not a chat model by name: gpt-4o-mini-tts/,
      `the refusal must say why the listed config model was turned down; got:\n${out}`);
    assert.ok(!requests.some((q) => isAnswerCall(q) && q.model === 'gpt-4o-mini-tts'),
      'the text-to-speech model was called as an extractor');
    assert.ok(!madePaidCall(requests));
  });
});

test('a config classifyModel from the reasoning series (o4-mini) IS usable — it is a chat model without a gpt-N number', async () => {
  await withTmpProject('aeo-classify-cfg-o4-', async (dir) => {
    seed(dir, { classifyModel: 'o4-mini' });
    const catalogue = ['gpt-5-search-api', 'gpt-4o', 'o4-mini', MAIN];
    const { requests, out } = run(dir, { catalogue });
    assert.deepStrictEqual(extractorsCalled(requests), ['o4-mini'], `o4-mini was turned down by the name filter:\n${out}`);
  });
});

test('the cheap-tier pin applies to run and run-manual only, and needs a value', async () => {
  await withTmpProject('aeo-classify-scope-', async (dir) => {
    seed(dir);
    const onReport = spawnCli(['report', '--openai-classify-model=gpt-4.1-mini'], { cwd: dir, env: offlineFetchEnv({}) });
    assert.strictEqual(onReport.status, 2, `report must refuse the flag instead of ignoring it:\n${onReport.stdout}\n${onReport.stderr}`);
    assert.match(onReport.stderr, /applies to `run` and `run-manual` only/);
    const noValue = spawnCli(['run', '--openai-classify-model'], { cwd: dir, env: offlineFetchEnv({}) });
    assert.strictEqual(noValue.status, 2);
    assert.match(noValue.stderr, /needs a model id/);
  });
});

// ─── run-manual: the second leg of a series ─────────────────────────────────
//
// A series is `run` (API columns) plus `run-manual` (pasted Claude / Perplexity
// answers), and both grade with the cheap tier. The flag used to be accepted by
// `run-manual` and silently dropped: one series, two extractors, nothing in the
// output saying so — the class of defect the comment above its extractor build
// (2026-09-01) names by name.

function seedManual(dir) {
  const paste = join(dir, 'manual-paste');
  mkdirSync(paste, { recursive: true });
  for (const name of readdirSync(join(FIXTURE_ROOT, 'manual-paste'))) cpSync(join(FIXTURE_ROOT, 'manual-paste', name), join(paste, name));
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: 'testbrand.com',
    queries: ['best test brands 2026', 'top test brand alternatives', 'test brand vs competitor'],
    providers: {
      openai:     { model: MAIN, classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' },
      perplexity: { model: 'sonar-pro', env: 'PERPLEXITY_API_KEY' },
    },
    validationCache: [],
  }));
}

function runManual(dir, { args = [], tag }) {
  const urlLog = join(dir, `requests-${tag}.log`);
  const r = spawnCli(['run-manual', 'perplexity', '--from-dir', 'manual-paste', ...args], {
    cwd: dir,
    env: offlineFetchEnv({ AEO_E2E_CATALOGUE: JSON.stringify(LIVE), AEO_E2E_URL_LOG: urlLog }),
    timeout: 60000,
  });
  return { r, out: `${r.stdout || ''}\n${r.stderr || ''}`, requests: readRequestJournal(urlLog) };
}

test('run-manual: without a pin the paste leg is graded by the live pick (control)', async () => {
  await withTmpProject('aeo-manual-control-', async (dir) => {
    seedManual(dir);
    const { requests, out } = runManual(dir, { tag: 'control' });
    assert.deepStrictEqual(extractorsCalled(requests.map((q) => ({ ...q }))), ['gpt-4o-mini'], out);
  });
});

test('run-manual: --openai-classify-model grades the paste leg with the pinned model — one extractor per series', async () => {
  await withTmpProject('aeo-manual-pin-', async (dir) => {
    seedManual(dir);
    const { requests, out } = runManual(dir, { args: ['--openai-classify-model=gpt-4.1-mini'], tag: 'pinned' });
    assert.deepStrictEqual(extractorsCalled(requests), ['gpt-4.1-mini'],
      `the paste leg was graded by another model than the pin:\n${JSON.stringify(requests.filter(isAnswerCall))}\n${out}`);
    assert.match(out, /pinned by --openai-classify-model: gpt-4\.1-mini/);
  });
});

test('run-manual: a pin the key does not list stops before any paid call', async () => {
  await withTmpProject('aeo-manual-pin-dead-', async (dir) => {
    seedManual(dir);
    const { r, out, requests } = runManual(dir, { args: ['--openai-classify-model=gpt-9.9-ghost'], tag: 'dead' });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\n${out}`);
    assert.match(out, /does not list that id/);
    assert.ok(!madePaidCall(requests), `a billed call was made before the refusal:\n${JSON.stringify(requests)}`);
  });
});

test('run-manual takes the SAME refusal as run: a config text-to-speech id the key lists does not grade the paste leg', async () => {
  // B-3 through B-2: `run` refuses this config (see the test above) — and the
  // paste leg of the same series used to take the config pin unexamined, so one
  // series was graded by two different models, one of them a speech model.
  await withTmpProject('aeo-manual-cfg-tts-', async (dir) => {
    seedManual(dir);
    const cfg = JSON.parse(readFileSync(join(dir, '.aeo-tracker.json'), 'utf-8'));
    cfg.providers.openai.classifyModel = 'gpt-4o-mini-tts';
    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify(cfg));
    const urlLog = join(dir, 'requests-cfgtts.log');
    const spawn = (extra) => spawnCli(['run-manual', 'perplexity', '--from-dir', 'manual-paste', ...extra], {
      cwd: dir,
      env: offlineFetchEnv({
        AEO_E2E_CATALOGUE: JSON.stringify(['gpt-5-search-api', 'gpt-4o', 'gpt-4o-mini-tts', MAIN]),
        AEO_E2E_URL_LOG: urlLog,
      }),
      timeout: 60000,
    });
    const refused = spawn([]);
    const out = `${refused.stdout}\n${refused.stderr}`;
    assert.strictEqual(refused.status, 1, `expected exit 1; got ${refused.status}\n${out}`);
    assert.match(out, /Listed by the key but not a chat model by name: gpt-4o-mini-tts/);
    assert.match(out, /--openai-classify-model=<id>/);
    assert.ok(!readRequestJournal(urlLog).some(isAnswerCall), 'a billed call was made before the refusal');
    // …and a pin resolves it, the way it does for run.
    const pinned = spawn(['--openai-classify-model=gpt-4o']);
    assert.ok(!/Refusing to run/.test(`${pinned.stdout}\n${pinned.stderr}`), `a pin must resolve the refusal:\n${pinned.stdout}\n${pinned.stderr}`);
    const models = extractorsCalled(readRequestJournal(urlLog));
    assert.deepStrictEqual(models, ['gpt-4o'], `the pinned model must grade the leg; got ${JSON.stringify(models)}`);
  });
});

test('--help documents the cheap-tier pin (read through a file, not a pipe)', async () => {
  await withTmpProject('aeo-help-', (dir) => {
    const file = join(dir, 'help.txt');
    const fd = openSync(file, 'w');
    let r;
    try {
      r = spawnSync(process.execPath, [BIN, '--help'], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
    } finally {
      closeSync(fd);
    }
    assert.strictEqual(r.status, 0, r.stderr);
    const help = readFileSync(file, 'utf-8');
    assert.ok(help.length > 9000, `the whole help must be there (got ${help.length} chars) — a truncated read would test the pipe, not the help`);
    assert.match(help, /--openai-classify-model=<id>/);
    assert.match(help, /AEO_OPENAI_CLASSIFY_MODEL_PIN/);
    assert.match(help, /run AND run-manual/);
  });
});
