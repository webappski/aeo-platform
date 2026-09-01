/**
 * E2E — a completed run must be able to answer "which model produced this
 * number?" and "is this cost total complete?" from `_summary.json` alone.
 *
 * WHY BOTH IN ONE RUN
 * They are the same failure wearing two hats: the run KNEW something and said
 * it only to the terminal.
 *
 *   1. MODEL PROVENANCE. A cell recorded `model` (requested) and, only when the
 *      provider served a different LINEAGE, a `requestedModel`/`resolvedModel`
 *      pair. So the id the provider actually served — including its dated
 *      snapshot — was unrecoverable for every normal cell. Catching a model
 *      swap on 2026-09-01 meant opening raw response files and diffing their
 *      filenames by hand. The comparison engine's new model axis needs this as
 *      an input, and "read the filenames" is not an input.
 *
 *   2. COST COMPLETENESS. Discovery walks itself to each vendor's newest
 *      generation; the pricing table is hand-maintained. Discovery therefore
 *      outruns it BY CONSTRUCTION at every generation change — 2026-09-01 the
 *      run printed «cost not tracked for: gemini-3.7-flash» while
 *      `sessionCostUsd` in the summary sat there understated with nothing
 *      saying so. The total is not fudged with a guessed price (pricing.js's
 *      own header records a ~20× mispricing from exactly that instinct); the
 *      gap is named instead.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0): both are properties of a written
 * ARTIFACT produced by the real run loop — there is no pure function to test,
 * and a unit test of the sink would have to reimplement the record. The run is
 * driven offline: `/v1/models` and OpenAI's Responses endpoint are stubbed by
 * the `_helpers.js` preload, everything else fails closed at 401. No API, no
 * cost, deterministic.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  withTmpProject, spawnCli, offlineFetchEnv, responsesDateDir, todayDateString,
} from './_helpers.js';

const DOMAIN = 'testbrand.com';
// A model the pricing table has never heard of, in a generation whose tier
// names are equally unknown — i.e. exactly the shape of every future vendor
// release on the day it lands.
const UNPRICED = 'gpt-9.9-zephyr';
// What the provider says it SERVED: the same pointer resolved to a dated
// snapshot. Benign (no lineage change, so no drift warning) — and therefore the
// case that used to leave no provenance at all.
const SERVED = `${UNPRICED}-2026-09-01`;

const ANSWER = {
  model: SERVED,
  output: [{
    type: 'message',
    content: [{
      type: 'output_text',
      text: 'TestBrand is a solid option here, alongside a couple of alternatives.',
    }],
  }],
  usage: { input_tokens: 400, output_tokens: 900 },
};

test('a finished run records requested + served model per cell, and flags an incomplete cost total', async () => {
  await withTmpProject('aeo-provenance-', (dir) => {
    const queries = ['best test brands 2026', 'top test brand alternatives'];
    writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
      brand: 'TestBrand',
      domain: DOMAIN,
      queries,
      providers: {
        openai: { model: 'gpt-5.6-luna', classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' },
      },
      validationCache: queries.map((query) => ({
        query, valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered',
      })),
    }));

    const r = spawnCli(['run'], {
      cwd: dir,
      env: offlineFetchEnv({
        AEO_E2E_CATALOGUE: JSON.stringify([UNPRICED]),
        AEO_E2E_ANSWER: JSON.stringify(ANSWER),
      }),
      timeout: 60000,
    });

    const summaryPath = join(responsesDateDir(dir, DOMAIN, todayDateString()), '_summary.json');
    assert.ok(existsSync(summaryPath),
      `expected a written summary at ${summaryPath}; run said:\n${r.stdout}\n${r.stderr}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    const cells = summary.results.filter((c) => c.provider === 'openai' && c.mention !== 'error');
    assert.ok(cells.length > 0, `expected at least one non-error cell; got ${JSON.stringify(summary.results)}`);

    for (const cell of cells) {
      // `model` keeps meaning "requested" — every existing reader depends on
      // that — and `requestedModel` says so unambiguously.
      assert.strictEqual(cell.model, UNPRICED);
      assert.strictEqual(cell.requestedModel, UNPRICED);
      // The served id, on a cell with NO drift. This is the assertion that
      // would have failed before 2026-09-01: provenance was drift-only, so a
      // benign snapshot resolution left no record at all.
      assert.strictEqual(cell.resolvedModel, SERVED);
      // …and it is not misreported as drift: a pointer resolving to its own
      // dated build is normal, and flagging it would cry wolf on every cell.
      assert.strictEqual(cell.modelDrift, undefined);
    }

    // Cost: the model has no pricing row, so the total excludes it — and says so.
    assert.strictEqual(summary.costComplete, false,
      `an understated total must be marked; summary said ${JSON.stringify(summary.sessionCostUsd)}`);
    assert.deepStrictEqual(summary.costUntrackedModels, [UNPRICED]);
    // The grader is part of the measurement, so it is recorded next to the
    // result rather than only printed while the run scrolls past.
    assert.ok(Array.isArray(summary.extractorModels) && summary.extractorModels.length > 0,
      `expected extractorModels in the summary; got ${JSON.stringify(summary.extractorModels)}`);
  });
});
