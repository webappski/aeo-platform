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
  readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, openSync, closeSync, renameSync, rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { MAIN_CHEAP_TIER, isOpenAIClassifyCapableId } from '../../lib/providers/discover.js';
import {
  withTmpProject, spawnCli, offlineFetchEnv, readRequestJournal, isAnswerCall, BIN, FIXTURE_ROOT,
  responsesDateDir, todayDateString,
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
function run(dir, { catalogue, args = [MAIN_PIN], tag = 'run', env = {}, answerModel = MAIN }) {
  const urlLog = join(dir, `requests-${tag}.log`);
  const r = spawnCli(['run', ...args], {
    cwd: dir,
    env: offlineFetchEnv({
      AEO_E2E_CATALOGUE: JSON.stringify(catalogue),
      AEO_E2E_URL_LOG: urlLog,
      AEO_E2E_ANSWER: JSON.stringify({ ...ANSWER, model: answerModel }),
      ...env,
    }),
    timeout: 60000,
  });
  return { r, out: `${r.stdout || ''}\n${r.stderr || ''}`, requests: readRequestJournal(urlLog) };
}
const MAIN_PIN = `--openai-model=${MAIN}`;

/**
 * The models that were asked to GRADE: the chat-completions requests. By URL, not
 * by "anything but the main model": since AP-7 the main and the classify tier can
 * be the same id (`gpt-6-luna`), and a filter on the main id would hide the
 * extractor. Not valid where the MAIN model is itself served over chat/
 * completions (a `-search-api` SKU) or under `--depth=full` (the learning pass):
 * tests of those paths do not use it.
 */
const extractorsCalled = (requests) =>
  [...new Set(requests.filter((q) => /\/v1\/chat\/completions/.test(q.url)).map((q) => q.model).filter(Boolean))].sort();
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

// ─── The newest generation ships a flagship only ────────────────────────────
//
// 2026-10-11, live key: generation 6.1 = `gpt-6.1-sol` ($2/$10 per 1M) and
// nothing else; the cheap `gpt-6-luna` ($0.10/$0.50) sits one generation down.
// A bare `run` took `gpt-6.1-sol` ("may be the flagship" on stderr, then paid
// for it). The rule since 2026-10-13: a pick that is not a recognised cheap tier
// is not taken on the operator's behalf — the run uses the model THIS project's
// last run asked for, else the config's (unless the config IS the flagship),
// else stops and asks for a pin. The decisions of the card owner, 2026-10-13:
//   · last run == the flagship: TAKEN (an earlier run was pinned to it on
//     purpose — "the previous model"), and the log says so in so many words;
//   · config == the flagship: NOT taken, exit 1 naming the flag.
// Every assertion below is on the model in the REQUEST (/v1/responses), the log
// line second.

/** The models the MAIN answer calls named (Responses API; the extractor here is a chat-completions model). */
const mainModelsCalled = (requests) =>
  [...new Set(requests.filter((q) => /\/v1\/responses/.test(q.url)).map((q) => q.model).filter(Boolean))].sort();

/**
 * A REAL earlier run: the CLI itself writes the `_summary.json` the next run
 * reads (a run pinned to `model`, answers served by the stub), then its date
 * directory is moved to `date`. Writer and reader are the product's own — not a
 * summary typed into the shape the test author believes the writer produces.
 */
function priorRun(dir, { model, date, catalogue = LIVE }) {
  const r = run(dir, { catalogue, args: [`--openai-model=${model}`], tag: `prior-${model}-${date || 'today'}`, answerModel: model });
  const made = responsesDateDir(dir, 'testbrand.com', todayDateString());
  assert.ok(existsSync(join(made, '_summary.json')), `the prior run wrote no summary:\n${r.out}`);
  if (date) renameSync(made, responsesDateDir(dir, 'testbrand.com', date));
}

// ─── The newest FAMILY ships no recognised cheap tier (branch of 10d2a7f) ────
//
// AP-7 changed what "newest generation" means: discovery now DESCENDS inside the
// newest family (6.1 has only `gpt-6.1-sol`, so the cheap tier is `gpt-6-luna`).
// The branch below therefore needs a catalogue in which no id of the newest
// FAMILY is a cheap tier: the live catalogue minus every id `MAIN_CHEAP_TIER`
// recognises (NO_TIER). A literal carry-over of the old tests on LIVE would no
// longer reach this branch, and a catalogue with the tier ids removed also
// removes the classify candidates and every model a past run could have used —
// the run would then end on the EXTRACTOR's refusal with 0 requests, a false
// reason. So each case is re-seeded: the classifier is a listed chat id with no
// cheap tier (`gpt-4.1`), and the models are ids with no tier either.

const NO_TIER = LIVE.filter((id) => !MAIN_CHEAP_TIER.some((re) => re.test(id)));
const SEED = { cfg: 'gpt-5.5', last: 'gpt-5.4', older: 'gpt-5.2', flagship: 'gpt-6.1-sol', famOutOfPool: 'gpt-6-sol', classify: 'gpt-4.1' };
const seedNoTier = (dir, model) => seed(dir, { model, classifyModel: SEED.classify });

test('T0 · the re-seed ids are still outside the cheap tier, and the tier ids are still absent from NO_TIER', () => {
  const why = 'the catalogue fixture changed, not the product: re-seed section 1.4 of the AP-7 test design';
  for (const [k, id] of Object.entries(SEED)) {
    assert.ok(NO_TIER.includes(id), `SEED.${k} = ${id} is not in NO_TIER — ${why}`);
  }
  assert.ok(isOpenAIClassifyCapableId(SEED.classify), `SEED.classify = ${SEED.classify} is not a chat-capable id — ${why}`);
  for (const id of ['gpt-6-luna', 'gpt-5-nano']) {
    assert.ok(!NO_TIER.includes(id), `${id} is in NO_TIER — it was the recorded reason to re-seed — ${why}`);
  }
});

test('T263 · no recognised cheap tier: the run keeps the model its LAST run asked for — sent, and labelled with its source', async () => {
  await withTmpProject('aeo-flagship-lastrun-', async (dir) => {
    // A config model that IS on the key and differs from the last run's: the
    // two disagree in practice (a config written at `init` freezes that day's
    // model), and the last run is the instrument the series was measured on.
    seedNoTier(dir, SEED.cfg);
    priorRun(dir, { model: SEED.last, date: '2026-09-28', catalogue: NO_TIER });
    const { out, requests } = run(dir, { catalogue: NO_TIER, args: [], tag: 'second', answerModel: SEED.last });
    assert.deepStrictEqual(mainModelsCalled(requests), [SEED.last],
      `the model SENT must be the last run's; requests:\n${JSON.stringify(requests.filter(isAnswerCall))}\n${out}`);
    assert.match(out, /openai: gpt-5\.4[^\n]*using last run's model gpt-5\.4 — source: 2026-09-28 _summary\.json[^\n]*gpt-6\.1-sol not taken/,
      `the label must name the model sent and where it came from; got:\n${out}`);
  });
});

test('T278 · "last run" is the NEWEST date, and a damaged newest summary is skipped, not trusted and not fatal', async () => {
  await withTmpProject('aeo-flagship-dates-', async (dir) => {
    seedNoTier(dir, SEED.cfg);
    // Two real runs on two dates, older model first. The older model is still on
    // the key, so an oldest-first scan would pick it.
    priorRun(dir, { model: SEED.older, date: '2026-08-27', catalogue: NO_TIER });
    priorRun(dir, { model: SEED.last, date: '2026-09-28', catalogue: NO_TIER });
    const newest = run(dir, { catalogue: NO_TIER, args: [], tag: 'newest', answerModel: SEED.last });
    assert.deepStrictEqual(mainModelsCalled(newest.requests), [SEED.last],
      `the newest of two dates must win; got:\n${newest.out}`);
    assert.match(newest.out, /source: 2026-09-28 _summary\.json/);

    // The run above wrote today's summary; it would be "the newest date" for the
    // next one and hide what this half asserts. Take it out of the series.
    rmSync(responsesDateDir(dir, 'testbrand.com', todayDateString()), { recursive: true, force: true });
    // A run that died mid-write leaves an unreadable summary on the newest date.
    const broken = responsesDateDir(dir, 'testbrand.com', '2026-10-11');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, '_summary.json'), '{"date": "2026-10-11", "results": [');
    const skipped = run(dir, { catalogue: NO_TIER, args: [], tag: 'broken', answerModel: SEED.last });
    assert.deepStrictEqual(mainModelsCalled(skipped.requests), [SEED.last],
      `an unreadable newest summary must fall back to the previous date, not abort and not read as "no history"; got:\n${skipped.out}`);
    assert.match(skipped.out, /source: 2026-09-28 _summary\.json/);
  });
});

test('T304 · a last run that was pinned to the flagship ON PURPOSE is kept — and the label says the model sent, never "not taken"', async () => {
  await withTmpProject('aeo-flagship-lastrun-is-flagship-', async (dir) => {
    seedNoTier(dir, SEED.cfg);
    priorRun(dir, { model: SEED.flagship, date: '2026-10-11', catalogue: NO_TIER });
    const { out, requests } = run(dir, { catalogue: NO_TIER, args: [], tag: 'second', answerModel: SEED.flagship });
    assert.deepStrictEqual(mainModelsCalled(requests), [SEED.flagship], `the earlier run's own model is the previous model; got:\n${out}`);
    const line = out.split('\n').find((l) => /openai: gpt-6\.1-sol/.test(l)) || '';
    assert.match(line, /using last run's model gpt-6\.1-sol — source: 2026-10-11 _summary\.json/);
    assert.match(line, /priced as a flagship/, `the label must say what this id costs; got: ${line}`);
    assert.ok(!/not taken/.test(line),
      `a log line must not say a model was "not taken" while that model is the one being sent:\n${line}`);
  });
});

test('T318 · a config model that IS the flagship-only id is not taken: exit 1, names the flag, before any paid call', async () => {
  await withTmpProject('aeo-flagship-config-is-flagship-', async (dir) => {
    seedNoTier(dir, SEED.flagship);
    const { r, out, requests } = run(dir, { catalogue: NO_TIER, args: [], tag: 'cfg', answerModel: SEED.flagship });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\n${out}`);
    assert.match(out, /--openai-model=gpt-6\.1-sol/, `the refusal must hand over the flag with the id; got:\n${out}`);
    assert.match(out, /config model gpt-6\.1-sol IS that flagship-only id/);
    // The first line of the refusal must not contradict the second: the config
    // model EXISTS on this key — it is the rejected one.
    assert.ok(!/no earlier run or config model/.test(out), `the refusal denies a config model that it names next:\n${out}`);
    assert.match(out, /the config model gpt-6\.1-sol is one of those ids/);
    assert.match(out, /Refusing to run/);
    assert.ok(!/No API keys found/.test(out), `the run fell through the refusal:\n${out}`);
    assert.ok(!madePaidCall(requests), `a billed call was made before the refusal:\n${JSON.stringify(requests)}`);
  });
});

test('T335 · no earlier run, config model on the key and not the flagship: the config model is SENT and labelled — the newest family has no cheap tier', async () => {
  await withTmpProject('aeo-flagship-config-', async (dir) => {
    seedNoTier(dir, SEED.cfg);
    const { out, requests } = run(dir, { catalogue: NO_TIER, args: [], answerModel: SEED.cfg });
    assert.deepStrictEqual(mainModelsCalled(requests), [SEED.cfg]);
    const line = out.split('\n').find((l) => /openai: gpt-5\.5/.test(l)) || '';
    assert.match(line, /using config model gpt-5\.5 — source: \.aeo-tracker\.json providers\.openai\.model[^\n]*gpt-6\.1-sol not taken/);
    assert.match(line, /family 6/, `the label speaks of the family, not a single generation; got: ${line}`);
  });
});

test('T6sol · a config model from the same family but outside the rejected pool is SENT: gpt-6-sol is not gpt-6.1-sol', async () => {
  await withTmpProject('aeo-flagship-config-famout-', async (dir) => {
    seedNoTier(dir, SEED.famOutOfPool);
    const { out, requests } = run(dir, { catalogue: NO_TIER, args: [], answerModel: SEED.famOutOfPool });
    assert.deepStrictEqual(mainModelsCalled(requests), [SEED.famOutOfPool],
      `a config model that is not in the rejected pool must be sent, not refused; got:\n${out}`);
    assert.match(out, /using config model gpt-6-sol — source: \.aeo-tracker\.json/);
  });
});

test('T344 · no earlier run and no config model on the key: stop before any paid call and name the flag — the newest family has no cheap tier', async () => {
  await withTmpProject('aeo-flagship-stop-', async (dir) => {
    seedNoTier(dir, 'gpt-9.9-ghost');   // not on this key
    const { r, out, requests } = run(dir, { catalogue: NO_TIER, args: [], answerModel: SEED.flagship });
    assert.strictEqual(r.status, 1, `expected exit 1; got ${r.status}\n${out}`);
    assert.match(out, /--openai-model=<id>/, `the refusal must name the flag; got:\n${out}`);
    assert.match(out, /gpt-6\.1-sol/, 'the refusal must name the candidate it declined');
    assert.match(out, /no recognised cheap tier/);
    // The refusal sentence itself, not the [discover-warn] line above it (which also says `family 6`).
    assert.match(out, /the newest family \(6\) ships no recognised cheap tier/, `the refusal speaks of the family; got:\n${out}`);
    assert.match(out, /Refusing to run/);
    assert.ok(!/No API keys found/.test(out), `the run fell through the refusal:\n${out}`);
    assert.ok(!madePaidCall(requests), `a billed call was made before the refusal:\n${JSON.stringify(requests)}`);
  });
});

test('T358 · a last-run model the key no longer lists is not sent', async () => {
  await withTmpProject('aeo-flagship-retired-', async (dir) => {
    seedNoTier(dir, SEED.cfg);
    priorRun(dir, { model: SEED.last, date: '2026-10-11', catalogue: NO_TIER });
    // The key has since lost the last run's model (and nothing else changed).
    const retired = NO_TIER.filter((id) => id !== SEED.last);
    const { out, requests } = run(dir, { catalogue: retired, args: [], tag: 'second', answerModel: SEED.cfg });
    assert.deepStrictEqual(mainModelsCalled(requests), [SEED.cfg],
      `a model the catalogue no longer lists was sent, or the config was not used:\n${out}`);
    assert.match(out, /using config model gpt-5\.5/);
  });
});

test('T371 · an explicit pin still wins — including a pin ON the flagship', async () => {
  await withTmpProject('aeo-flagship-pin-', async (dir) => {
    seed(dir);
    const { out, requests } = run(dir, { catalogue: LIVE, args: ['--openai-model=gpt-6.1-sol'], answerModel: 'gpt-6.1-sol' });
    assert.deepStrictEqual(mainModelsCalled(requests), ['gpt-6.1-sol']);
    assert.match(out, /openai: gpt-6\.1-sol[^\n]*pinned by --openai-model/);
  });
});

test('T380 · control — a recognised cheap tier in the newest generation is sent; history is not consulted', async () => {
  await withTmpProject('aeo-cheap-tier-', async (dir) => {
    seed(dir);
    const withLuna6_1 = [...LIVE, 'gpt-6.1-luna'];
    priorRun(dir, { model: 'gpt-6-luna', date: '2026-10-11', catalogue: withLuna6_1 });
    const { out, requests } = run(dir, { catalogue: withLuna6_1, args: [], tag: 'second', answerModel: 'gpt-6.1-luna' });
    assert.deepStrictEqual(mainModelsCalled(requests), ['gpt-6.1-luna'],
      `the newest generation's cheap tier must win when one exists; got:\n${out}`);
    assert.ok(!/last run|using config/.test(out), `history/config was consulted although discovery was safe:\n${out}`);
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
