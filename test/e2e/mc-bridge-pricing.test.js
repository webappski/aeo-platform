/**
 * E2E regression — the "Webappski plan" bridge card pricing + SLA copy is a
 * never-fail revenue surface. A silent revert to the old "$29" default or the
 * "Delivered in 24h" SLA (e.g. a merge conflict resetting the mc-bridge.js
 * pricing defaults) would otherwise pass CI unnoticed. This pins, on the SAME
 * defaults call the reviewers used (`bridgeMarkup({})`):
 *   - the €129 price of record (founder decision 2026-07-15, «129 евро»);
 *   - zero USD-digit leak — currency is unified to EUR on this card;
 *   - the honest beta SLA "1–3 business days" (never "24h");
 *   - the single canonical 5-bullet description shared by BOTH the hover
 *     tooltip and the always-visible Route-B diptych — guarding the
 *     double-description collapse from reverting to two divergent bullet sets.
 */
import test from 'node:test';
import assert from 'node:assert';
import { bridgeMarkup } from '../../lib/report/mc-bridge.js';

const html = bridgeMarkup({});

test('bridge card carries the €129 price of record', () => {
  assert.ok(
    html.includes('€129 per plan · 30 missions'),
    'curated card meta line must read "€129 per plan · 30 missions"',
  );
  assert.ok(html.includes('€129'), 'card must contain the €129 price');
});

test('bridge card leaks zero USD-digit amounts (EUR-only currency)', () => {
  const usd = html.match(/\$\d/);
  assert.strictEqual(
    usd,
    null,
    `card must not contain any $<digit> amount — found ${usd && usd[0]}`,
  );
});

test('bridge card SLA is the honest "1–3 business days", never "24h"', () => {
  assert.ok(
    html.includes('1–3 business days'),
    'card must promise delivery in "1–3 business days"',
  );
  assert.ok(!html.includes('24h'), 'card must not promise "24h" delivery');
  assert.ok(
    !html.includes('Delivered in 24h'),
    'card must not carry the old "Delivered in 24h" SLA',
  );
});

test('one canonical 5-bullet description — tooltip and Route-B diptych agree', () => {
  // Each canonical bullet's bold lead must appear EXACTLY twice: once in the
  // hover tooltip "What you get" list, once in the always-visible diptych.
  // If either region drifts (e.g. the diptych reverts to its old 4 bullets),
  // one of these counts breaks and the test fails.
  const canonicalLeads = [
    'Pre-flight account audit.',
    'We route around the minefields.',
    'Trap-aware sequencing.',
    'Hand-reviewed by us',
    'Delivered in 1–3 business days',
  ];
  for (const lead of canonicalLeads) {
    const count = html.split(lead).length - 1;
    assert.strictEqual(
      count,
      2,
      `canonical bullet "${lead}" must appear in BOTH the tooltip and the diptych (expected 2, got ${count})`,
    );
  }
});
