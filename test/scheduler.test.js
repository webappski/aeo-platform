import assert from 'node:assert/strict';
import { planSchedule, runScheduled } from '../lib/util/scheduler.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

async function asyncTest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nplanSchedule (token-budget packing)');

test('empty tasks returns empty schedule',
  () => assert.deepEqual(planSchedule([], 6000), []));

test('null limit fires everything at t=0 (degraded mode)', () => {
  const tasks = [{ estimatedTokens: 1000 }, { estimatedTokens: 1000 }, { estimatedTokens: 1000 }];
  const sched = planSchedule(tasks, null);
  assert.equal(sched.length, 3);
  for (const s of sched) assert.equal(s.fireAt, 0);
});

test('zero limit also degrades to all-at-t=0', () => {
  const tasks = [{ estimatedTokens: 1000 }];
  const sched = planSchedule(tasks, 0);
  assert.equal(sched[0].fireAt, 0);
});

test('tasks that fit in budget all go to window 0', () => {
  // 3 × 1000 = 3000 < 90000 * 0.9 = 81000 budget → all window 0
  const tasks = [{ estimatedTokens: 1000 }, { estimatedTokens: 1000 }, { estimatedTokens: 1000 }];
  const sched = planSchedule(tasks, 90000);
  for (const s of sched) assert.equal(s.fireAt, 0);
});

test('tasks exceeding budget spill to next window', () => {
  // 3 × 2500 = 7500 vs limit 6000 → budget 5400.
  // task 0: window 0 (sum=2500)
  // task 1: window 0 (sum=5000)
  // task 2: window 1 (sum 5000+2500=7500 > 5400 → next window)
  const tasks = [
    { estimatedTokens: 2500 },
    { estimatedTokens: 2500 },
    { estimatedTokens: 2500 },
  ];
  const sched = planSchedule(tasks, 6000);
  assert.equal(sched[0].fireAt, 0);
  assert.equal(sched[1].fireAt, 0);
  assert.equal(sched[2].fireAt, 60_000);
});

test('huge tasks each go to their own window', () => {
  // Each task 5000, limit 6000 → budget 5400.
  // task 0 alone fits (5000 < 5400); but task 1 won't fit alongside → next window.
  const tasks = [
    { estimatedTokens: 5000 },
    { estimatedTokens: 5000 },
    { estimatedTokens: 5000 },
  ];
  const sched = planSchedule(tasks, 6000);
  assert.equal(sched[0].fireAt, 0);
  assert.equal(sched[1].fireAt, 60_000);
  assert.equal(sched[2].fireAt, 120_000);
});

test('task larger than budget alone still gets a window (no infinite loop)', () => {
  // 8000 > 5400 (90% of 6000) but we always start the current window with at
  // least one task to make progress. Ledger throttle will catch the actual 429.
  const tasks = [{ estimatedTokens: 8000 }];
  const sched = planSchedule(tasks, 6000);
  assert.equal(sched.length, 1);
  assert.equal(sched[0].fireAt, 0);
});

test('default estimate (2500) used when estimatedTokens missing', () => {
  // No estimatedTokens → 2500 default. 3 × 2500 vs 6000 → 2 fit, 3rd next.
  const tasks = [{}, {}, {}];
  const sched = planSchedule(tasks, 6000);
  assert.equal(sched[0].fireAt, 0);
  assert.equal(sched[1].fireAt, 0);
  assert.equal(sched[2].fireAt, 60_000);
});

console.log('\nrunScheduled (fire timing)');

await asyncTest('all-at-t=0 tasks fire immediately and resolve in order', async () => {
  const order = [];
  const fns = [
    async () => { order.push('a'); return 'a'; },
    async () => { order.push('b'); return 'b'; },
    async () => { order.push('c'); return 'c'; },
  ];
  const sched = [
    { taskIdx: 0, fireAt: 0 },
    { taskIdx: 1, fireAt: 0 },
    { taskIdx: 2, fireAt: 0 },
  ];
  const results = await runScheduled(fns, sched);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(order.length, 3);
});

await asyncTest('delayed task fires after its planned delay', async () => {
  const start = Date.now();
  const fns = [
    async () => Date.now() - start,
    async () => Date.now() - start,
  ];
  const sched = [
    { taskIdx: 0, fireAt: 0 },
    { taskIdx: 1, fireAt: 100 },
  ];
  const [t0, t1] = await runScheduled(fns, sched);
  // Timing asserts are jitter-tolerant on purpose: setTimeout(fn, N) is a
  // *minimum* delay, and Date.now() ms-truncation at both ends routinely shows
  // ~99ms for a 100ms timer (and a few ms for an "immediate" task under load).
  // What the scheduler must guarantee: the immediate task is not delayed, and
  // the delayed task fires clearly LATER than the immediate one, ~the planned
  // 100ms. We check the gap relatively (robust to CI load) plus loose absolute
  // bounds, never the exact ms.
  assert.ok(t0 < 80, `first (immediate) task should not be delayed, got ${t0}ms`);
  assert.ok(t1 - t0 >= 80, `second task should fire clearly after the immediate one (~100ms), gap was ${t1 - t0}ms`);
  assert.ok(t1 < 1000, `second task should still fire near its 100ms target, got ${t1}ms`);
});

await asyncTest('rejection from one task propagates', async () => {
  const fns = [
    async () => 'ok',
    async () => { throw new Error('boom'); },
  ];
  const sched = [
    { taskIdx: 0, fireAt: 0 },
    { taskIdx: 1, fireAt: 0 },
  ];
  await assert.rejects(runScheduled(fns, sched), /boom/);
});

await asyncTest('empty input returns empty array', async () => {
  const results = await runScheduled([], []);
  assert.deepEqual(results, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
