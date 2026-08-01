// Guard: the report's cost line must equal its own breakdown.
//
// Root cause this prevents: `report`'s cache-fillers run concurrently inside one
// `Promise.all`. The recommendations branch pushed its entry to `costByModel` AND
// recomputed `sessionCostUsd`; the outreach-templates branch pushed but did not.
// Whichever finished last won, so the headline total silently under-reported —
// observed on the webappski 2026-07-31 report: breakdown $0.0577, total $0.0296.
// Both branches now go through addCostEntry, which always re-derives the total.
//
// Unit rather than E2E (R37 exception): reproducing it end-to-end would require
// real paid LLM calls in both branches. These are pure functions over plain data
// — no mocks, nothing that can lie about behaviour.

import assert from 'node:assert/strict';
import { addCostEntry, sumCostUsd } from '../lib/report/cost-telemetry.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ncost telemetry (addCostEntry / sumCostUsd)');

test('sessionCostUsd always equals the sum of the whole breakdown', () => {
  const snap = {};
  addCostEntry(snap, { label: 'actions',  costUsd: 0.029564 });
  addCostEntry(snap, { label: 'outreach', costUsd: 0.028160 });
  assert.equal(snap.costByModel.length, 2);
  assert.equal(snap.sessionCostUsd, 0.057724,
    'the exact webappski 2026-07-31 pair — the total must be the sum, not the last-recomputed subset');
});

test('a later push re-derives the total (the concurrent-branch bug)', () => {
  const snap = { costByModel: [{ costUsd: 1 }], sessionCostUsd: 1 };
  addCostEntry(snap, { costUsd: 2 });
  assert.equal(snap.sessionCostUsd, 3, 'pushing without re-deriving is what left the total stale');
});

test('a falsy entry is a no-op — no empty row, total untouched', () => {
  const snap = { costByModel: [{ costUsd: 0.5 }], sessionCostUsd: 0.5 };
  addCostEntry(snap, null);
  addCostEntry(snap, undefined);
  assert.equal(snap.costByModel.length, 1);
  assert.equal(snap.sessionCostUsd, 0.5);
});

test('an untracked-model entry contributes 0, never NaN', () => {
  // calcCost returns null for an unlisted model, so a caller can hand us an entry
  // with no costUsd. That must not poison every tracked cost alongside it.
  assert.equal(sumCostUsd([{ costUsd: 0.25 }, { model: 'unpriced' }, { costUsd: undefined }]), 0.25);
});

test('rounds to the micro-dollar the rest of the codebase stores', () => {
  assert.equal(sumCostUsd([{ costUsd: 0.0000004 }, { costUsd: 0.0000004 }]), 0.000001);
});

test('an empty or missing breakdown totals 0', () => {
  assert.equal(sumCostUsd([]), 0);
  assert.equal(sumCostUsd(undefined), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
