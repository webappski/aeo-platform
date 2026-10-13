/**
 * E2E — a ChatGPT run's cost must carry what OpenAI actually bills: the
 * model's tokens at the model's price, plus the web_search TOOL calls — counted
 * as the provider counts them, shown on a line of their own, and kept even when
 * the model's token price is unknown.
 *
 * WHAT WENT WRONG (a measurement run, 2026-10-11, `gpt-6-luna`)
 *   - `gpt-6-luna` had no row in the pricing table, so every ChatGPT cell was
 *     `costTracked:false, costUsd:0`: the tokens AND the 102 web_search calls
 *     (≈ $1.02, the largest single item of the run) were missing from
 *     "Session cost". The run was reported at $1.15 and cost ≈ $2.35.
 *   - Once a row exists, a second defect shows: the tracker counted every
 *     `web_search_call` OUTPUT ITEM, and a gpt-6 answer also carries
 *     `open_page` / `find_in_page` items (102 search + 43 + 1 on that run).
 *     OpenAI's tool guide bills "search actions"; its own `tool_usage` counter
 *     reported 102. Counting items alone would have charged $1.46.
 *
 * WHY E2E (R37 Gate 0): both are properties of what the real run loop WRITES —
 * the summary cell, the Session-cost block, the summary key. A unit test of
 * `calcCost` cannot see that the loop passed it the wrong count (the pricing
 * unit tests were green throughout). The run is offline: `/v1/models` and
 * `/v1/responses` are stubbed by the `_helpers.js` preload, no key, no money.
 *
 * Prices below are the OpenAI pricing page as read 2026-10-13 (Standard tier,
 * short context): gpt-6-luna $0.10 in / $0.50 out per 1M, web search $10 per
 * 1k calls. They are typed here ON PURPOSE — the other side of this seam is the
 * provider's page, not our code, and importing the constant from pricing.js
 * would make the test agree with itself. The answer bodies are the SHAPE of the
 * real ones (`tool_usage` + mixed `web_search_call` actions), read from the 60
 * saved responses of that run.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { readdirSync } from 'node:fs';
import {
  withTmpProject, spawnCli, offlineFetchEnv, responsesDateDir, reportsDateDir, todayDateString,
  readRequestJournal, isAnswerCall,
} from './_helpers.js';
import { buildMcMetadata } from '../../lib/report/mc-metadata.js';

const DOMAIN = 'testbrand.com';
const QUERIES = ['best test brands 2026', 'top test brand alternatives'];
const CATALOGUE = ['gpt-6-luna', 'gpt-5-search-api', 'gpt-4o-mini'];

const SEARCH = (q) => ({ type: 'web_search_call', status: 'completed', action: { type: 'search', query: q, queries: [q] } });
const OPEN = { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://example.com/a' } };
const FIND = { type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url: 'https://example.com/a', pattern: 'TestBrand' } };
const MESSAGE = { type: 'message', content: [{ type: 'output_text', text: 'TestBrand is a solid option here, alongside a couple of alternatives.' }] };

/** 2 real searches, one opened page, one find-in-page: four items, TWO billed calls. */
function answer(model, { items = [SEARCH('test brands'), OPEN, SEARCH('test brand alternatives'), FIND, MESSAGE], toolUsage = { web_search: { num_requests: 2 } } } = {}) {
  return {
    model,
    output: items,
    ...(toolUsage ? { tool_usage: toolUsage } : {}),
    usage: { input_tokens: 20000, output_tokens: 1000 },
  };
}

function seed(dir, model = 'gpt-5.6-luna') {
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: DOMAIN,
    queries: QUERIES,
    providers: {
      openai: { model, classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' },
    },
    validationCache: QUERIES.map((query) => ({
      query, valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered',
    })),
  }));
}

function run(dir, { model, catalogue = CATALOGUE, body, args, tag = 'run' }) {
  const urlLog = join(dir, `requests-${tag}.log`);
  const r = spawnCli(args || ['run', `--openai-model=${model}`], {
    cwd: dir,
    env: offlineFetchEnv({
      // The anchor search SKU makes classify discovery resolve the way it does
      // on a real key (one generation behind it) instead of on the model under
      // test; `gpt-4o-mini` is the cheap chat model it lands on.
      AEO_E2E_CATALOGUE: JSON.stringify(catalogue),
      AEO_E2E_URL_LOG: urlLog,
      ...(body ? { AEO_E2E_ANSWER: JSON.stringify(body) } : {}),
    }),
    timeout: 60000,
  });
  const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
  assert.ok(existsSync(summaryPath),
    `expected a written summary at ${summaryPath}; run said:\n${r.stdout}\n${r.stderr}`);
  return {
    r,
    summary: JSON.parse(readFileSync(summaryPath, 'utf-8')),
    out: `${r.stdout}\n${r.stderr}`,
    requests: readRequestJournal(urlLog),
  };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
const answerCells = (summary) => summary.results.filter((c) => c.provider === 'openai' && c.mention !== 'error');

test('gpt-6-luna is priced: tokens at its rate + 2 billed searches, nothing marked untracked', async () => {
  await withTmpProject('aeo-cost-ws-', (dir) => {
    seed(dir);
    const { summary, requests } = run(dir, { model: 'gpt-6-luna', body: answer('gpt-6-luna') });
    const cells = answerCells(summary);
    assert.strictEqual(cells.length, QUERIES.length, `expected one answer cell per query; got ${JSON.stringify(summary.results)}`);
    for (const cell of cells) {
      // 20 000 × $0.10/1M + 1 000 × $0.50/1M = $0.0025 tokens; 2 × $0.01 = $0.02 search.
      assert.ok(near(cell.costUsd, 0.0225),
        `cell cost should be tokens $0.0025 + 2 billed searches $0.02 = $0.0225; got ${cell.costUsd}`);
      assert.strictEqual(cell.costTracked, undefined, 'a priced model must not be flagged costTracked:false');
      // Two billed calls, not the four `web_search_call` items in the body.
      assert.strictEqual(cell.webSearchCalls, 2);
    }
    assert.strictEqual(summary.costComplete, undefined,
      `a priced model must not mark the total incomplete; summary said ${JSON.stringify(summary.costUntrackedModels)}`);
    assert.strictEqual(summary.costUntrackedModels, undefined);
    // …and the priced model is the one the request actually named.
    const answerModels = new Set(requests.filter(isAnswerCall).map((r) => r.model));
    assert.ok(answerModels.has('gpt-6-luna'), `no request named gpt-6-luna; journal: ${JSON.stringify(requests)}`);
  });
});

test('the web search fee is its own line, with the price and where it came from — and is not added twice', async () => {
  await withTmpProject('aeo-cost-ws-line-', (dir) => {
    seed(dir);
    const { summary, out } = run(dir, { model: 'gpt-6-luna', body: answer('gpt-6-luna') });
    // 2 cells × 2 billed searches.
    assert.match(out, /web search: 4 calls × \$0\.01 = \$0\.0400/,
      `Session cost must print the tool fee on its own line; got:\n${out}`);
    assert.match(out, /developers\.openai\.com\/api\/docs\/pricing/,
      'the fee line must name where the price came from');
    assert.match(out, /already inside the ChatGPT line/,
      'the line must say it is part of the ChatGPT line, not an addition to it');

    assert.strictEqual(summary.webSearchToolFee.calls, 4);
    assert.ok(near(summary.webSearchToolFee.costUsd, 0.04));
    assert.strictEqual(summary.webSearchToolFee.unitUsd, 0.01);
    assert.strictEqual(summary.webSearchToolFee.includedInSessionCost, true);

    // No double count: the breakdown still sums to the total, and the ChatGPT
    // line of it is the two cells (tokens + fee), which is where the fee lives.
    const sum = summary.costByModel.reduce((s, m) => s + m.costUsd, 0);
    assert.ok(near(sum, summary.sessionCostUsd), `costByModel ${sum} must sum to sessionCostUsd ${summary.sessionCostUsd}`);
    const gpt = summary.costByModel.find((m) => m.provider === 'openai' && m.model === 'gpt-6-luna');
    assert.ok(gpt, `expected the ChatGPT line in costByModel; got ${JSON.stringify(summary.costByModel)}`);
    assert.ok(near(gpt.costUsd, 0.045), `ChatGPT line = 2 × $0.0225; got ${gpt.costUsd}`);
  });
});

test('a model with no price row keeps its web search fee: tokens unknown, searches are not', async () => {
  await withTmpProject('aeo-cost-ws-untracked-', (dir) => {
    seed(dir);
    const UNPRICED = 'gpt-9.9-zephyr';
    const { summary, out } = run(dir, {
      model: UNPRICED,
      catalogue: [UNPRICED, 'gpt-5-search-api', 'gpt-4o-mini'],
      body: answer(UNPRICED),
    });
    const cells = answerCells(summary);
    assert.strictEqual(cells.length, QUERIES.length);
    for (const cell of cells) {
      assert.ok(near(cell.costUsd, 0.02),
        `tokens are unknown but the 2 billed searches are not: expected $0.02; got ${cell.costUsd}`);
      assert.strictEqual(cell.costTracked, false, 'the token side is still untracked and must say so');
      assert.strictEqual(cell.webSearchCalls, 2);
    }
    assert.strictEqual(summary.costComplete, false);
    assert.deepStrictEqual(summary.costUntrackedModels, [UNPRICED]);
    assert.match(out, /web search: 4 calls × \$0\.01 = \$0\.0400/);
  });
});

test('no tool_usage in the response: the search ACTIONS are what is billed, through the real loop', async () => {
  // The provider's counter is preferred, the documented rule is the fallback —
  // and the fallback is a different line of code. Unit-covered on the pure
  // function; this is the wiring: the loop must hand it the raw body, whole.
  await withTmpProject('aeo-cost-ws-notu-', (dir) => {
    seed(dir);
    const { summary } = run(dir, { model: 'gpt-6-luna', body: answer('gpt-6-luna', { toolUsage: null }) });
    for (const cell of answerCells(summary)) {
      assert.strictEqual(cell.webSearchCalls, 2, 'two `search` actions of four items');
      assert.ok(near(cell.costUsd, 0.0225));
    }
  });
});

test('a run that never searched writes no search keys, no fee line — byte-identical to before (R39)', async () => {
  await withTmpProject('aeo-cost-ws-none-', (dir) => {
    seed(dir);
    const { summary, out } = run(dir, {
      model: 'gpt-6-luna',
      body: answer('gpt-6-luna', { items: [MESSAGE], toolUsage: { web_search: { num_requests: 0 } } }),
    });
    for (const cell of answerCells(summary)) {
      assert.ok(!('webSearchCalls' in cell), `a cell with no search must not carry webSearchCalls: ${JSON.stringify(cell)}`);
      assert.ok(near(cell.costUsd, 0.0025), `tokens only: $0.0025; got ${cell.costUsd}`);
    }
    assert.ok(!('webSearchToolFee' in summary), 'no search → no webSearchToolFee key');
    assert.ok(!/web search:/.test(out), `no search → no fee line; got:\n${out}`);
  });
});

test('--replay re-serves saved answers for free: no fee line, no search keys, nothing billed twice', async () => {
  await withTmpProject('aeo-cost-ws-replay-', (dir) => {
    // 1. A real live-shaped run writes the raw answers (with web_search_call
    //    items and a tool_usage counter) to aeo-responses/<domain>/<today>/.
    seed(dir);
    run(dir, { model: 'gpt-6-luna', body: answer('gpt-6-luna'), tag: 'live' });
    const rawFile = join(responsesDateDir(dir, DOMAIN, todayDateString()), 'q1-openai-gpt-6-luna.json');
    assert.ok(existsSync(rawFile), `the live run must save its raw answer at ${rawFile}`);
    const saved = JSON.parse(readFileSync(rawFile, 'utf-8'));
    assert.strictEqual(saved.tool_usage.web_search.num_requests, 2, 'the replayed file must really carry a search counter');

    // 2. Replay it. The config names the recorded model (replay is keyed by
    //    q, provider, model and skips discovery).
    seed(dir, 'gpt-6-luna');
    const r = run(dir, {
      args: ['run', '--replay', `--replay-from=${todayDateString()}`],
      tag: 'replay',
    });
    for (const cell of answerCells(r.summary)) {
      assert.ok(!('webSearchCalls' in cell), `a replayed cell must not carry webSearchCalls: ${JSON.stringify(cell)}`);
      assert.strictEqual(cell.costUsd, 0, 'a replayed cell costs nothing');
    }
    assert.ok(answerCells(r.summary).length > 0, 'the replay must have served cells');
    assert.ok(!('webSearchToolFee' in r.summary), 'replay → no webSearchToolFee key (it would claim a fee that was not paid)');
    assert.ok(!/web search:/.test(r.out), `replay → no fee line; got:\n${r.out}`);
    assert.strictEqual(r.summary.sessionCostUsd, 0);
    assert.ok(!r.requests.some(isAnswerCall), `a replay made an answer request:\n${JSON.stringify(r.requests)}`);
  });
});

test('the new cost keys never reach the Mission Control payload (allow-list, not deny-list)', async () => {
  await withTmpProject('aeo-cost-ws-mc-', (dir) => {
    seed(dir);
    const { summary } = run(dir, { model: 'gpt-6-luna', body: answer('gpt-6-luna') });
    assert.ok(summary.webSearchToolFee, 'precondition: the real summary carries the new key');
    const payload = JSON.stringify(buildMcMetadata(summary, [], { trackerVersion: 'test' }));
    assert.ok(!/webSearchToolFee/.test(payload), 'webSearchToolFee leaked into the MC payload');
    assert.ok(!/webSearchCalls/.test(payload), 'webSearchCalls leaked into the MC payload');
  });
});

test('the fee never reaches a CLIENT-facing report (--public, --white-label): it is our API spend', async () => {
  // Cost is internal telemetry. The two client render modes already strip the
  // Session-cost card; the new fields are a second route for the same number,
  // and "the card is hidden" does not cover a key that is serialised elsewhere.
  await withTmpProject('aeo-cost-ws-clientleak-', (dir) => {
    seed(dir);
    run(dir, { model: 'gpt-6-luna', body: answer('gpt-6-luna') });
    for (const mode of ['--public', '--white-label']) {
      const r = spawnCli(['report', mode, '--no-open', '--offline'], { cwd: dir, env: offlineFetchEnv({}), timeout: 60000 });
      assert.strictEqual(r.status, 0, `report ${mode} failed:\n${r.stdout}\n${r.stderr}`);
      const outDir = reportsDateDir(dir, DOMAIN, todayDateString());
      const files = readdirSync(outDir).filter((f) => /\.(html|md|json)$/.test(f));
      assert.ok(files.length > 0, `report ${mode} wrote nothing under ${outDir}`);
      for (const f of files) {
        const text = readFileSync(join(outDir, f), 'utf-8');
        assert.ok(!/webSearchToolFee|webSearchCalls|already inside the ChatGPT|web search: \d/.test(text),
          `${mode}: ${f} carries our web-search cost`);
      }
    }
  });
});
