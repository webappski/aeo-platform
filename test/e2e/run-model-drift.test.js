/**
 * E2E — answer-surface MODEL DRIFT, end to end: the run loop notices that the
 * provider served a different model lineage than the one we asked for, says so
 * on the terminal, stamps it into `_summary.json`, and — only when
 * `--strict-model-pin` is passed — turns it into a non-zero exit.
 *
 * WHY THIS FILE EXISTS
 * `test/model-drift.test.js` unit-tests the pure decision (`evaluateModelDrift`)
 * and, until today, its header pointed at THIS path as the coverage for the
 * wiring — a file that did not exist. The exit-code contract of a never-fail
 * tool is the last thing that may live on a phantom coverage claim: a CI guard
 * that pins the basket's model has nothing but the exit status to read, and
 * nothing was proving that status is produced.
 *
 * THE CARD SAID «replay fixture», AND THAT CANNOT WORK — stated here rather
 * than quietly done differently. Board card AP-MODELDRIFT-RUNLOOP-E2E asks for
 * «a replay fixture with a desynchronised modelVersion». The drift check in the
 * run loop is deliberately guarded by `if (!replayed && mode !== 'training')`
 * (bin/aeo-tracker.js) — a replayed cell reads a historical file, where there is
 * no live model to drift, and a training cell measures a deliberately different
 * base model. A replay fixture therefore cannot reach the code under test at
 * all; a test built on one would have gone green while asserting nothing. The
 * run is driven instead through the `_helpers.js` offline stub (the same seam
 * `run-model-provenance.test.js` uses): `/v1/models` and OpenAI's Responses
 * endpoint are served from fixtures, every other call fails closed at 401. No
 * API, no cost, deterministic.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0): the subject is a PROCESS EXIT CODE and
 * a written artifact produced by the real run loop, neither of which exists
 * inside a function a unit test could call. The decision that feeds them is
 * already unit-tested; what is untested is that the loop, the summary line and
 * the exit-code ladder are actually wired to it.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  withTmpProject, spawnCli, offlineFetchEnv, responsesDateDir, todayDateString,
} from './_helpers.js';

const DOMAIN = 'testbrand.com';
// What we ask for, and what the provider hands back instead: a different
// GENERATION, not a dated build of the same pointer. That is the distinction
// the drift check is built on — `gpt-5.6-luna` → `gpt-5.6-luna-2026-09-01` is a
// benign roll-forward and must stay silent (asserted by run-model-provenance).
const REQUESTED = 'gpt-5.6-luna';
const SERVED = 'gpt-6-astra';
// Both ids are on the key, so pinning REQUESTED is a legitimate pin (an
// unlisted pin stops the run before the first billed call) and discovery —
// which prefers the newest generation — would otherwise have chosen SERVED.
// Pinning is what makes «we asked for this one» a fact of the test rather than
// a side effect of the discovery rules.
const CATALOGUE = [REQUESTED, SERVED];

const QUERIES = ['best test brands 2026', 'top test brand alternatives'];

/** OpenAI Responses body, served for every answer call. */
function answerBody(text) {
  return {
    model: SERVED,
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 400, output_tokens: 900 },
  };
}

const VISIBLE = 'TestBrand is a solid option here, alongside a couple of alternatives.';
// Not a word about the brand — the run ends invisible (exit 2).
const INVISIBLE = 'Two established vendors dominate this space, with a long tail behind them.';

function writeConfig(dir) {
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand',
    domain: DOMAIN,
    queries: QUERIES,
    providers: {
      openai: { model: REQUESTED, classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' },
    },
    // Pre-populated so the run skips the LLM validator (which would otherwise
    // reach for a live key on every boot).
    validationCache: QUERIES.map((query) => ({
      query, valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered',
    })),
  }));
}

/**
 * Run the CLI in a FRESH tmp project. Fresh matters: a previous `_summary.json`
 * in the same tree becomes the regression baseline, and an exit code from the
 * regression branch would be indistinguishable from the one under test. With no
 * prior run, `previousScore === null` and that branch cannot fire — do not
 * "helpfully" seed a baseline here.
 */
async function runDrift(prefix, { text, args = [] }) {
  return withTmpProject(prefix, (dir) => {
    writeConfig(dir);
    const r = spawnCli(['run', '--openai-model', REQUESTED, ...args], {
      cwd: dir,
      env: offlineFetchEnv({
        AEO_E2E_CATALOGUE: JSON.stringify(CATALOGUE),
        AEO_E2E_ANSWER: JSON.stringify(answerBody(text)),
      }),
      timeout: 60000,
    });
    const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
    const summary = existsSync(summaryPath)
      ? JSON.parse(readFileSync(summaryPath, 'utf-8'))
      : null;
    return { r, summary, summaryPath };
  });
}

test('drift on the answer surface is warned, stamped into the summary — and does NOT fail the run by default', async () => {
  const { r, summary, summaryPath } = await runDrift('aeo-drift-warn-', { text: VISIBLE });

  assert.ok(summary, `expected a written summary at ${summaryPath}; run said:\n${r.stdout}\n${r.stderr}`);

  // 1. The terminal says it. A data-integrity signal that only reached the run
  //    JSON would be invisible to the person watching the run scroll past.
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /Model drift this run: 2 answer cells served a different model than requested/);
  assert.match(out, new RegExp(`openai: requested ${REQUESTED} → served ${SERVED}`));

  // 2. Every answer cell carries the requested/served pair AND the drift flag.
  //    `model` keeps meaning "requested" — existing readers depend on that.
  const cells = summary.results.filter((c) => c.provider === 'openai' && c.mention !== 'error');
  assert.ok(cells.length > 0, `expected non-error cells; got ${JSON.stringify(summary.results)}`);
  for (const cell of cells) {
    assert.strictEqual(cell.model, REQUESTED);
    assert.strictEqual(cell.requestedModel, REQUESTED);
    assert.strictEqual(cell.resolvedModel, SERVED);
    assert.strictEqual(cell.modelDrift, true);
  }

  // 3. Default policy is WARN, not FAIL: a benign roll-forward must not abort an
  //    otherwise legitimate paid run. This is also the BASELINE for the next
  //    test — without it, an exit 1 there would not prove the flag caused it.
  assert.strictEqual(r.status, 0,
    `default policy must not fail the run; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

test('--strict-model-pin turns the same drift into a non-zero exit', async () => {
  const { r, summary } = await runDrift('aeo-drift-strict-', {
    text: VISIBLE,
    args: ['--strict-model-pin'],
  });

  assert.ok(summary, `expected a written summary; run said:\n${r.stdout}\n${r.stderr}`);
  // The flag must not short-circuit the run: the summary is still written and
  // the learned rate-limits are still saved. A `process.exit()` at the point of
  // detection would have skipped both — which is why the flag folds into the
  // exit-code ladder at the end instead.
  assert.ok(Array.isArray(summary.results) && summary.results.length > 0,
    'the summary must still be written on a strict-pin failure');

  assert.strictEqual(r.status, 1,
    `--strict-model-pin must exit 1 on drift; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /--strict-model-pin: answer-surface model drift detected/);
});

test('--strict-model-pin never DOWNGRADES a more severe exit code', async () => {
  // Mutation-sanity for the ladder. The wiring is
  //   `if (strictPinFailed && exitCode === 0) exitCode = 1;`
  // and the mutation that matters is dropping the `&& exitCode === 0`: every
  // happy-path assertion above still passes with it gone. Here the run is
  // ALSO invisible (exit 2, "the brand was named nowhere"), which carries more
  // signal than "the instrument moved" — 2 must survive. Invert the guard and
  // this test goes red.
  const { r, summary } = await runDrift('aeo-drift-invisible-', {
    text: INVISIBLE,
    args: ['--strict-model-pin'],
  });

  assert.ok(summary, `expected a written summary; run said:\n${r.stdout}\n${r.stderr}`);
  assert.strictEqual(summary.mentions, 0,
    `the fixture must leave the brand invisible for this test to mean anything; summary said ${summary.mentions}`);
  // Drift still happened and is still reported — the point is the exit code,
  // not a suppressed warning.
  assert.match(`${r.stdout}\n${r.stderr}`, /Model drift this run: /);
  assert.strictEqual(r.status, 2,
    `invisible (2) outranks strict-pin (1); stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});
