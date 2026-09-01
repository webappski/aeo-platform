/**
 * E2E — `--openai-model` must be honoured on a run where discovery SUCCEEDS,
 * and a pin the provider no longer lists must stop the run before it spends
 * anything.
 *
 * WHY E2E AND NOT A UNIT TEST (R37 Gate 0)
 * The precedence rule itself is a pure function and is unit-covered in
 * test/model-pin-precedence.test.js. What a unit test structurally cannot see
 * is the bug that actually shipped: the rule was never consulted. The run loop
 * did `r.models ?? r.cfg.model`, so the flag applied only when discovery had
 * FAILED — and every test that stubbed a failing discovery therefore passed.
 * The contract only becomes falsifiable by driving the REAL CLI through a
 * SUCCEEDING discovery, which is what this does.
 *
 * No live API and no cost: `/v1/models` is served from an injected catalogue
 * and every other request fails closed at 401 (test/e2e/_helpers.js preload).
 * The run is expected to die at the first answer cell — this test asserts on
 * what the run RESOLVED, which happens before any billable call.
 */
import test from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { spawnCli, offlineFetchEnv, withTmpProject } from './_helpers.js';

// A catalogue shaped like the live OpenAI account on 2026-09-01: a 5.6
// generation with NAMED tiers and no `-mini`, an older 5.4 line that does have
// one, and the legacy search SKU an operator pins to re-measure an old month.
const CATALOGUE = [
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5-search-api',
];

function seedProject(dir) {
  // TWO queries, not three, on purpose: `gpt-5-search-api` carries a 6k-TPM
  // bucket (lib/providers/rate-limits.js), and a third cell would be paced into
  // the next 60s window by the scheduler — a minute of wall clock spent proving
  // nothing this test asserts. Both cells still fail closed at 401.
  const queries = [
    'best test brands 2026',
    'top test brand alternatives',
  ];
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: 'testbrand.com',
    queries,
    providers: {
      // Deliberately a THIRD value: not the pin, not what discovery picks. So a
      // pass cannot come from the config accidentally agreeing with either.
      openai: { model: 'gpt-5.4-nano', classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' },
    },
    validationCache: queries.map((query) => ({
      query, valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered',
    })),
  }));
}

function run(dir, args) {
  return spawnCli(['run', ...args], {
    cwd: dir,
    env: offlineFetchEnv({ AEO_E2E_CATALOGUE: JSON.stringify(CATALOGUE) }),
    timeout: 60000,
  });
}

test('discovery alone picks the newest generation, not the older -mini', async () => {
  await withTmpProject('aeo-pin-control-', async (dir) => {
    seedProject(dir);
    const r = run(dir, []);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    assert.match(out, /openai: gpt-5\.6-luna/,
      `expected discovery to resolve the newest generation's cheap tier; got:\n${out}`);
    assert.ok(!/openai: gpt-5\.4-mini/.test(out),
      `an older generation won on its -mini suffix — the pre-2026-09-01 defect is back:\n${out}`);
  });
});

test('an explicit --openai-model pin overrides a SUCCESSFUL discovery', async () => {
  await withTmpProject('aeo-pin-honoured-', async (dir) => {
    seedProject(dir);
    const r = run(dir, ['--openai-model=gpt-5-search-api']);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    assert.match(out, /openai: gpt-5-search-api/,
      `the pinned model was not the one resolved; got:\n${out}`);
    // The exact regression: discovery answering successfully must not consume
    // the decision. Note the pin is also EXCLUDEd from the discovery pool
    // (a `-search` SKU), which is precisely why it can only arrive via the pin.
    assert.ok(!/openai: gpt-5\.6-luna/.test(out),
      `discovery's pick won over an explicit flag — the flag is a no-op again:\n${out}`);
    assert.match(out, /pinned by --openai-model/,
      `the run log must name WHERE the model came from; got:\n${out}`);
  });
});

test('a pin the catalogue does not list stops the run instead of substituting', async () => {
  await withTmpProject('aeo-pin-dead-', async (dir) => {
    seedProject(dir);
    const r = run(dir, ['--openai-model=gpt-5.9-ghost']);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    assert.strictEqual(r.status, 1,
      `expected exit 1 on a dead pin; got ${r.status}\n${out}`);
    assert.match(out, /does not list that id/,
      `expected an explicit refusal naming the missing id; got:\n${out}`);
    // Silently measuring on something else is the original defect; so is
    // charging for a run that answers a different question than was asked. The
    // refusal has to land BEFORE the answer cells start.
    assert.ok(!/Session cost/.test(out),
      `the run reached the billed stage before refusing the pin:\n${out}`);
  });
});
