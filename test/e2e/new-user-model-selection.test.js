/**
 * E2E — which OpenAI models a NEW USER's first paid calls name (AP-7).
 *
 * THE DEFECT (founder rule 01.09: "the latest model, the cheap modification,
 * no other"; "staying on the previous generation is forbidden")
 *   A new user got `gpt-5.6-luna` from FALLBACK/DEFAULT_CONFIG written by `init`,
 *   and `gpt-5-nano` (retired by OpenAI on 2026-12-11) as the first paid call
 *   of `init` itself, while the key lists the newer and cheaper `gpt-6-luna`.
 *   The earlier tests hid it: they SEEDED a hand-written config
 *   (`model: 'gpt-5.6-luna'`), so no test walked the path a new user walks —
 *   real `init`, then `run` / `report`.
 *
 * WHAT THESE TESTS DO
 *   The path of a new user goes through the REAL `init`; the config is not
 *   hand-written. Three exceptions, each a field outside the model choice or an
 *   explicit snapshot of an old version (see `cfg116` and the E11/E13 notes).
 *   Only the network is replaced (preload `_helpers.js`); the assertions are on
 *   the `model` in the REQUEST body (journal `AEO_E2E_URL_LOG`), the printed line
 *   second. Expected ids are LITERALS from the rule (design section 0), never
 *   read back from `FALLBACK` — a mutant "FALLBACK = old id" would agree with
 *   itself.
 *
 * Every test title starts with its ID and ` · ` (the mutant runner matches on it).
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, renameSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  withTmpProject, spawnCli, offlineFetchEnv, readRequestJournal, FIXTURE_ROOT,
  responsesDateDir, todayDateString,
} from './_helpers.js';
import { heuristicKeyMatch, detectStandardKeys } from '../../lib/init/keys.js';
import { SEARCH_BEHAVIORS } from '../../lib/init/research/validate-query-llm.js';
import { DEFAULT_CONFIG } from '../../lib/config.js';

// The live key of the day AP-7 was built (2026-10-27): generation 6.1 lists gpt-6.1-sol
// AND gpt-6.1-terra. Terra is the balanced tier (ten times a luna), so the cheap tier
// of the newest family is still gpt-6-luna. The 2026-10-13 snapshot (6.1 = sol only)
// is covered by the unit tests U1-U16 and by run-model-selection-safety.test.js.
const LIVE = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'openai-models-2026-10-27.json'), 'utf-8')).ids;
const DOMAIN = 'testbrand.com';
// Three queries without a bare acronym: init's static check blocks "CRM"-style
// words, and the manual-paste fixtures answer exactly these three.
const QUERIES = ['best test brands 2026', 'top test brand alternatives', 'test brand vs competitor'];
const OPENAI_KEY = 'sk-test-do-not-use-0123456789abcdef0123';

/** The validator's answer (`/v1/chat/completions`), shaped by the parser in validate-query-llm.js. */
const CHAT_OK = {
  choices: [{
    message: {
      content: JSON.stringify({
        results: QUERIES.map((query, i) => ({
          index: i + 1, query, valid: true, confidence: 0.9, search_behavior: SEARCH_BEHAVIORS.RETRIEVAL,
        })),
      }),
    },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
};

/** Responses-API answer. The model echoed is the one the test expects to see SENT. */
const answerBody = (model, extra = {}) => ({
  model,
  output: [{
    type: 'message',
    content: [{
      type: 'output_text',
      text: 'TestBrand is a solid option here, alongside a couple of alternatives.',
      annotations: extra.citations || [],
    }],
  }],
  usage: { input_tokens: 400, output_tokens: 900 },
});

/**
 * Environment hermetic as to KEYS (design 2.5): every name init could read as a
 * provider key is blanked (names come from the product's own matcher, not a
 * regex of ours), then one OpenAI key is set. Laid OVER `process.env` so
 * `SystemRoot` / `PATH` survive on Windows.
 */
function hermeticKeys() {
  const env = {};
  for (const names of Object.values(heuristicKeyMatch(process.env))) for (const n of names) env[n] = '';
  for (const n of Object.values(detectStandardKeys(process.env))) if (n) env[n] = '';
  for (const n of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY']) env[n] = '';
  env.OPENAI_API_KEY = OPENAI_KEY;
  return env;
}
const hermeticRest = () => heuristicKeyMatch({ ...process.env, ...hermeticKeys() });

const chatCalls = (requests) => requests.filter((q) => /\/v1\/chat\/completions/.test(q.url));
const responseCalls = (requests) => requests.filter((q) => /\/v1\/responses/.test(q.url));
const modelsOf = (calls) => calls.map((q) => q.model);
const uniq = (arr) => [...new Set(arr)].sort();
const dump = (requests) => JSON.stringify(requests.filter((q) => /\/v1\/(responses|chat)/.test(q.url)));

function env(extra = {}) {
  return offlineFetchEnv({ ...hermeticKeys(), ...extra });
}

/**
 * The REAL `init` of a new user. Returns the result and the requests it made.
 * `keyCheck: false` adds --no-key-check (the common case; E9 runs with the check).
 */
function init(dir, { args = [], tag = 'init', keyCheck = false, catalogue = LIVE, chat = CHAT_OK, extraEnv = {} } = {}) {
  const urlLog = join(dir, `requests-${tag}.log`);
  const r = spawnCli(
    ['init', '--yes', ...(keyCheck ? [] : ['--no-key-check']), '--brand=TestBrand', `--domain=${DOMAIN}`, ...args],
    {
      cwd: dir,
      env: env({
        AEO_E2E_CATALOGUE: JSON.stringify(catalogue),
        AEO_E2E_CHAT: JSON.stringify(chat),
        AEO_E2E_URL_LOG: urlLog,
        ...extraEnv,
      }),
      timeout: 90000,
    },
  );
  return { r, out: `${r.stdout || ''}\n${r.stderr || ''}`, requests: readRequestJournal(urlLog) };
}
const initKeywords = (dir, o = {}) => init(dir, { ...o, args: [`--keywords=${QUERIES.join(',')}`, ...(o.args || [])] });

function readConfig(dir) { return JSON.parse(readFileSync(join(dir, '.aeo-tracker.json'), 'utf-8')); }
function writeConfig(dir, cfg) { writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify(cfg, null, 2)); }

/** One `run` / `report`; returns result, printed text, and the requests it made. */
function cli(dir, args, { tag, catalogue = LIVE, status = null, answerModel = null, citations = [], extraEnv = {} }) {
  const urlLog = join(dir, `requests-${tag}.log`);
  const r = spawnCli(args, {
    cwd: dir,
    env: env({
      ...(status ? { AEO_E2E_CATALOGUE_STATUS: String(status) } : { AEO_E2E_CATALOGUE: JSON.stringify(catalogue) }),
      AEO_E2E_URL_LOG: urlLog,
      ...(answerModel ? { AEO_E2E_ANSWER: JSON.stringify(answerBody(answerModel, { citations })) } : {}),
      ...extraEnv,
    }),
    timeout: 90000,
  });
  return { r, out: `${r.stdout || ''}\n${r.stderr || ''}`, requests: readRequestJournal(urlLog) };
}
const runBare = (dir, o) => cli(dir, ['run', ...(o.args || [])], o);
const openaiLine = (out) => out.split('\n').find((l) => /\bopenai: gpt-/.test(l)) || '';

// ─── E0 / E1: the first paid call of `init` itself ───────────────────────────

test('E0 · the first paid call of a new user (query validation in init --keywords) names gpt-6-luna', async () => {
  await withTmpProject('aeo-nu-e0-', (dir) => {
    assert.deepStrictEqual(hermeticRest(), { openai: [], gemini: [], anthropic: [], perplexity: [] },
      'precondition: the environment is blind to every non-OpenAI key');
    const { r, out, requests } = initKeywords(dir);
    assert.strictEqual(r.status, 0, out);
    const first = chatCalls(requests)[0];
    assert.ok(first, `init made no chat/completions request:\n${out}`);
    assert.strictEqual(first.model, 'gpt-6-luna', `first paid call of init; requests:\n${dump(requests)}`);
  });
});

test('E1 · init --auto (site unreachable, --category given): the brainstorm, the first paid call, names gpt-6-luna', async () => {
  await withTmpProject('aeo-nu-e1-', (dir) => {
    const { requests, out } = init(dir, { args: ['--auto', '--category=project management software'], tag: 'init-auto' });
    // The exit code is NOT asserted: the stub cannot answer a brainstorm.
    const first = chatCalls(requests)[0];
    assert.ok(first, `init --auto made no chat/completions request:\n${out}`);
    assert.strictEqual(first.model, 'gpt-6-luna', `first paid call of init --auto; requests:\n${dump(requests)}`);
  });
});

// ─── E2a–c: init, then a bare run, on the live catalogue ─────────────────────

describe('E2 · init → bare run on the live catalogue', () => {
  let res;
  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aeo-nu-e2-'));
    const i = initKeywords(dir);
    assert.strictEqual(i.r.status, 0, i.out);
    res = { dir, ...runBare(dir, { tag: 'run', answerModel: 'gpt-6-luna' }) };
  });
  after(() => { if (res?.dir) rmSync(res.dir, { recursive: true, force: true }); });

  test('E2a · every Responses request names gpt-6-luna and the run succeeds', () => {
    assert.strictEqual(res.r.status, 0, res.out);
    const calls = responseCalls(res.requests);
    assert.ok(calls.length > 0, `no Responses request was made:\n${res.out}`);
    assert.deepStrictEqual(uniq(modelsOf(calls)), ['gpt-6-luna'], `requests:\n${dump(res.requests)}`);
  });

  test('E2b · the model line names the source `discovery`, not config and not last run', () => {
    const line = openaiLine(res.out);
    assert.ok(line, `no "openai: <model>" line in:\n${res.out}`);
    assert.match(line, /\bdiscovery\b/, `the line must name its source; got: ${line}`);
    assert.doesNotMatch(line, /using config model|last run/, `got: ${line}`);
  });

  test('E2c · exactly one [discover-warn] openai line; it names 6.1, gpt-6.1-sol and gpt-6-luna and does not promise a refusal', () => {
    const warns = res.out.split('\n').filter((l) => l.includes('[discover-warn] openai'));
    assert.strictEqual(warns.length, 1, `got ${warns.length}:\n${warns.join('\n')}`);
    assert.match(warns[0], /6\.1/);
    assert.match(warns[0], /gpt-6\.1-sol/);
    assert.match(warns[0], /gpt-6\.1-terra/);
    assert.match(warns[0], /gpt-6-luna/);
    assert.doesNotMatch(warns[0], /will not take it on its own/);
  });
});

// ─── E3: a user of 1.16.1 whose last run was on the flagship ─────────────────

test('E3 · last run was on the flagship, the next bare run goes to gpt-6-luna and the report says so', async () => {
  await withTmpProject('aeo-nu-e3-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const first = runBare(dir, { tag: 'first', args: ['--openai-model=gpt-6.1-sol'], answerModel: 'gpt-6.1-sol' });
    assert.strictEqual(first.r.status, 0, first.out);
    const made = responsesDateDir(dir, DOMAIN, todayDateString());
    assert.ok(existsSync(join(made, '_summary.json')), `the first run wrote no summary:\n${first.out}`);
    renameSync(made, responsesDateDir(dir, DOMAIN, '2026-10-11'));

    const second = runBare(dir, { tag: 'second', answerModel: 'gpt-6-luna' });
    assert.deepStrictEqual(uniq(modelsOf(responseCalls(second.requests))), ['gpt-6-luna'],
      `the second run must leave the flagship; requests:\n${dump(second.requests)}\n${second.out}`);
    assert.doesNotMatch(openaiLine(second.out), /last run/, `got: ${openaiLine(second.out)}`);

    const rep = cli(dir, ['report', '--no-open', '--offline'], { tag: 'report' });
    assert.strictEqual(rep.r.status, 0, rep.out);
    const reportMd = findFile(join(dir, 'aeo-reports'), 'report.md');
    assert.ok(reportMd, `no report.md under aeo-reports:\n${rep.out}`);
    const md = readFileSync(reportMd, 'utf-8');
    const line = md.split('\n').find((l) => /gpt-6\.1-sol/.test(l) && /gpt-6-luna/.test(l));
    assert.ok(line, 'no single line of the report names both models');
    assert.ok(line.indexOf('gpt-6.1-sol') < line.indexOf('gpt-6-luna'), `the old model comes first; got: ${line}`);
  });
});

function findFile(root, name) {
  if (!existsSync(root)) return null;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

// ─── E4 / E5: the catalogue is down ──────────────────────────────────────────

describe('E4 · init → run with /v1/models = 500', () => {
  let res;
  before(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aeo-nu-e4-'));
    const i = initKeywords(dir);
    assert.strictEqual(i.r.status, 0, i.out);
    res = { dir, ...runBare(dir, { tag: 'run500', status: 500, answerModel: 'gpt-6-luna' }) };
  });
  after(() => { if (res?.dir) rmSync(res.dir, { recursive: true, force: true }); });

  test('E4 · the main model is gpt-6-luna and the line says (fallback)', () => {
    assert.deepStrictEqual(uniq(modelsOf(responseCalls(res.requests))), ['gpt-6-luna'], `${dump(res.requests)}\n${res.out}`);
    assert.match(openaiLine(res.out), /\(fallback\)/);
  });

  test('E5 · the extractor is gpt-6-luna too (same id as the main model: counted by URL)', () => {
    const models = uniq(modelsOf(chatCalls(res.requests)));
    assert.deepStrictEqual(models, ['gpt-6-luna'], `${dump(res.requests)}\n${res.out}`);
  });
});

// ─── E6: no cheap tier in the newest family ──────────────────────────────────

test('E6 · the newest family (gpt-7) has no cheap tier: the config model gpt-6-luna is sent, and the label says why', async () => {
  await withTmpProject('aeo-nu-e6-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const { out, requests } = runBare(dir, { tag: 'run7', catalogue: [...LIVE, 'gpt-7-astra'], answerModel: 'gpt-6-luna' });
    assert.deepStrictEqual(uniq(modelsOf(responseCalls(requests))), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
    const line = openaiLine(out);
    assert.match(line, /using config model gpt-6-luna — source: \.aeo-tracker\.json/, `got: ${line}`);
    assert.match(line, /gpt-7-astra not taken/, `got: ${line}`);
  });
});

// ─── E7 / E8: the FALLBACK rung of the extractor ─────────────────────────────

const C_FB = ['gpt-5-search-api', 'gpt-4o', 'gpt-6-luna', 'gpt-6.1-sol'];

function seedFallbackRung(dir) {
  const paste = join(dir, 'manual-paste');
  mkdirSync(paste, { recursive: true });
  for (const name of readdirSync(join(FIXTURE_ROOT, 'manual-paste'))) cpSync(join(FIXTURE_ROOT, 'manual-paste', name), join(paste, name));
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: DOMAIN,
    queries: QUERIES,
    providers: {
      openai: { model: 'gpt-9.9-ghost', env: 'OPENAI_API_KEY' },      // no classifyModel; not on the key
      perplexity: { model: 'sonar-pro', env: 'PERPLEXITY_API_KEY' },
    },
    validationCache: QUERIES.map((query) => ({ query, valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered' })),
  }));
}

test('E7 · run-manual: the extractor falls to gpt-6-luna when the config has no classifyModel and the catalogue offers no cheap chat tier', async () => {
  await withTmpProject('aeo-nu-e7-', (dir) => {
    seedFallbackRung(dir);
    const { r, out, requests } = cli(dir, ['run-manual', 'perplexity', '--from-dir', 'manual-paste'], { tag: 'manual', catalogue: C_FB });
    assert.strictEqual(r.status, 0, out);
    assert.deepStrictEqual(uniq(modelsOf(chatCalls(requests))), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
  });
});

test('E8 · run: the same rung, main model pinned', async () => {
  await withTmpProject('aeo-nu-e8-', (dir) => {
    seedFallbackRung(dir);
    const { r, out, requests } = runBare(dir, { tag: 'run', catalogue: C_FB, args: ['--openai-model=gpt-6-luna'], answerModel: 'gpt-6-luna' });
    assert.strictEqual(r.status, 0, out);
    assert.deepStrictEqual(uniq(modelsOf(chatCalls(requests))), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
  });
});

// ─── E9: the key probe line every new user sees ──────────────────────────────

test('E9 · init WITH the key check: stderr carries exactly one [discover-warn] openai line, and it is the new one', async () => {
  await withTmpProject('aeo-nu-e9-', (dir) => {
    const { r, out } = initKeywords(dir, { keyCheck: true, tag: 'init-probe' });
    assert.strictEqual(r.status, 0, out);
    const warns = (r.stderr || '').split('\n').filter((l) => l.includes('[discover-warn] openai'));
    assert.strictEqual(warns.length, 1, `got ${warns.length}:\n${warns.join('\n')}\n${out}`);
    assert.match(warns[0], /6\.1/);
    assert.match(warns[0], /gpt-6\.1-sol/);
    assert.match(warns[0], /gpt-6\.1-terra/);
    assert.match(warns[0], /gpt-6-luna/);
    assert.doesNotMatch(warns[0], /will not take it on its own/);
  });
});

// ─── E10: a config written by 1.16.1, no history, the catalogue readable ─────

// What init 1.16.1 wrote to every user: git show 8c2d68c:lib/config.js :124 and
// 8c2d68c:lib/providers/discover.js FALLBACK (checked 25.10). An explicit
// snapshot of the OLD version, never the value of the path under test.
const cfg116 = { model: 'gpt-5.6-luna', classifyModel: 'gpt-5-nano' };

test('E10 · a 1.16.1 config with no run history: the catalogue choice wins over the config on both legs', async () => {
  await withTmpProject('aeo-nu-e10-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const cfg = readConfig(dir);
    cfg.providers.openai = { ...cfg.providers.openai, ...cfg116 };
    writeConfig(dir, cfg);
    const { out, requests } = runBare(dir, { tag: 'run116', answerModel: 'gpt-6-luna' });
    assert.deepStrictEqual(uniq(modelsOf(responseCalls(requests))), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
    assert.deepStrictEqual(uniq(modelsOf(chatCalls(requests))), ['gpt-4o-mini'], `${dump(requests)}\n${out}`);
    const line = openaiLine(out);
    assert.match(line, /\bdiscovery\b/, `got: ${line}`);
    assert.doesNotMatch(line, /using config model/, `got: ${line}`);
  });
});

// ─── E11 / E12: `report` online — recommendations, letters, citation classifier

const CITATIONS = ['https://example.org/a']
  .map((url, i) => ({ type: 'url_citation', url, title: `Source ${i + 1}`, start_index: 0, end_index: 5 }));

/**
 * Fresh project with a run behind it. `category` is the one field added by hand
 * (design 1.1, exception 1): `init --keywords` does not write it, and without it
 * `report` calls no LLM door at all.
 */
function projectWithRun(dir) {
  assert.strictEqual(initKeywords(dir).r.status, 0);
  const cfg = readConfig(dir);
  cfg.category = 'test brand tools';
  writeConfig(dir, cfg);
  const run = runBare(dir, { tag: 'run', answerModel: 'gpt-6-luna', citations: CITATIONS });
  assert.strictEqual(run.r.status, 0, run.out);
}
const REPORT_FLAGS = ['report', '--no-open', '--no-authority', '--no-entity-graph', '--no-page-signals', '--no-pricing'];

test('E11 · report online on the live catalogue: recommendations and letters name gpt-6-luna, citations gpt-4o-mini', async () => {
  await withTmpProject('aeo-nu-e11-', (dir) => {
    assert.deepStrictEqual(hermeticRest(), { openai: [], gemini: [], anthropic: [], perplexity: [] });
    projectWithRun(dir);
    const { out, requests } = cli(dir, REPORT_FLAGS, { tag: 'report' });
    // The citation classifier may re-ask once when the stub's answer does not parse,
    // so its calls are counted as "at least one", the two other doors exactly.
    const models = modelsOf(chatCalls(requests));
    assert.strictEqual(models.filter((m) => m === 'gpt-6-luna').length, 2, `recommendations + letters; ${dump(requests)}\n${out}`);
    const rest = models.filter((m) => m !== 'gpt-6-luna');
    assert.ok(rest.length >= 1, `the citation classifier was not called:\n${dump(requests)}\n${out}`);
    assert.deepStrictEqual(uniq(rest), ['gpt-4o-mini'], `${dump(requests)}\n${out}`);
  });
});

test('E12 · report online with the catalogue down: all three doors name gpt-6-luna', async () => {
  await withTmpProject('aeo-nu-e12-', (dir) => {
    projectWithRun(dir);
    const { out, requests } = cli(dir, REPORT_FLAGS, { tag: 'report500', status: 500 });
    const models = modelsOf(chatCalls(requests));
    assert.ok(models.length >= 3, `three doors expected (citations may re-ask):\n${dump(requests)}\n${out}`);
    assert.deepStrictEqual(uniq(models), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
  });
});

// ─── E13: an extractor built from DEFAULT_CONFIG, no discovery ───────────────

test('E13 · run-manual with no openai block in the config: the extractor comes from DEFAULT_CONFIG and names gpt-6-luna', async () => {
  await withTmpProject('aeo-nu-e13-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const paste = join(dir, 'manual-paste');
    mkdirSync(paste, { recursive: true });
    for (const name of readdirSync(join(FIXTURE_ROOT, 'manual-paste'))) cpSync(join(FIXTURE_ROOT, 'manual-paste', name), join(paste, name));
    const cfg = readConfig(dir);
    cfg.providers = { gemini: DEFAULT_CONFIG.providers.gemini };
    writeConfig(dir, cfg);
    const { r, out, requests } = cli(dir, ['run-manual', 'perplexity', '--from-dir', 'manual-paste'], { tag: 'manual' });
    assert.strictEqual(r.status, 0, out);
    const models = modelsOf(chatCalls(requests));
    assert.ok(models.length > 0, `no extraction request was made:\n${out}`);
    assert.deepStrictEqual(uniq(models), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
  });
});

// ─── E14: `init --queries-only` takes its models from DEFAULT_CONFIG ─────────

test('E14 · init --queries-only / --add-queries / --replace-queries: the brainstorm names gpt-6-luna each time', async () => {
  await withTmpProject('aeo-nu-e14-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const site = { host: DOMAIN, html: '<html><head><title>TestBrand — test brand tools</title></head><body><h1>TestBrand</h1><p>Tools for test brands.</p></body></html>' };
    for (const flag of [[], ['--add-queries'], ['--replace-queries']]) {
      const tag = `queries${flag[0] || ''}`;
      const urlLog = join(dir, `requests-${tag}.log`);
      const r = spawnCli(['init', '--yes', '--queries-only', ...flag], {
        cwd: dir,
        env: env({
          AEO_E2E_CATALOGUE: JSON.stringify(LIVE),
          AEO_E2E_CHAT: JSON.stringify(CHAT_OK),
          AEO_E2E_SITE: JSON.stringify(site),
          AEO_E2E_URL_LOG: urlLog,
        }),
        timeout: 90000,
      });
      // The exit code is NOT asserted: the stub cannot answer a brainstorm.
      const first = chatCalls(readRequestJournal(urlLog))[0];
      assert.ok(first, `${tag}: no chat/completions request was made:\n${r.stdout}\n${r.stderr}`);
      assert.strictEqual(first.model, 'gpt-6-luna', `${tag}: ${dump(readRequestJournal(urlLog))}`);
    }
  });
});

// ─── E15 / E16: the two paths that carry the model id into a second place ───
//     (design section 5, A4; the founder asked for them closed on 2026-10-27)

test('E15 · run --depth=full: the web pass and the training-data pass both name gpt-6-luna', async () => {
  await withTmpProject('aeo-nu-e15-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const { r, out, requests } = runBare(dir, { tag: 'full', args: ['--depth=full'], answerModel: 'gpt-6-luna' });
    assert.strictEqual(r.status, 0, out);
    // The web pass is a Responses request. The training pass of an OpenAI model is
    // served over chat/completions with the same id and no search tool.
    assert.deepStrictEqual(uniq(modelsOf(responseCalls(requests))), ['gpt-6-luna'], `${dump(requests)}\n${out}`);
    const training = chatCalls(requests).filter((q) => q.model === 'gpt-6-luna');
    assert.ok(training.length >= QUERIES.length, `one training-data request per question expected; got ${training.length}:\n${dump(requests)}\n${out}`);
    assert.deepStrictEqual(uniq(modelsOf(chatCalls(requests)).filter((m) => m !== 'gpt-6-luna')), ['gpt-4o-mini'], `${dump(requests)}`);
  });
});

test('E16 · run --replay after a new init: the cached answers are found by the model id init wrote, and no request is made', async () => {
  await withTmpProject('aeo-nu-e16-', (dir) => {
    assert.strictEqual(initKeywords(dir).r.status, 0);
    const live = runBare(dir, { tag: 'live', answerModel: 'gpt-6-luna' });
    assert.strictEqual(live.r.status, 0, live.out);
    const { r, out, requests } = runBare(dir, { tag: 'replay', args: ['--replay'], answerModel: 'gpt-6-luna' });
    assert.strictEqual(r.status, 0, out);
    const paid = requests.filter((q) => /\/v1\/(responses|chat\/completions)/.test(q.url));
    assert.strictEqual(paid.length, 0, `--replay must serve the cached answers; paid requests:\n${dump(requests)}\n${out}`);
    assert.ok(out.split('\n').filter((l) => /YES|NO/.test(l) && l.includes('[replay]')).length >= QUERIES.length, `every question is served from the cache:\n${out}`);
    assert.match(out, /openai: gpt-6-luna \(replay\)/);
  });
});
