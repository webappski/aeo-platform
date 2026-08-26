// The run verdict — the one conclusion both report surfaces open with.
//
// WHY THIS FILE EXISTS
// --------------------
// The HTML hero and the markdown "run in one page" state the SAME finding in
// different markup. They used to decide it twice: two copies of the same
// four-way branch, one wrapping a clause in <em> and one not. Nothing failed
// when they drifted — the two surfaces simply began saying different things
// about the same run, which is the failure `run-metrics.js` exists to prevent
// for the NUMBERS, repeated for the WORDING.
//
// So this file checks two things:
//   1. `buildVerdictHeadline` — every branch of the decision, directly.
//   2. `sectionRunVerdict` — that the markdown surface renders those decisions
//      (it previously had no direct test of its branches at all).
// The cross-SURFACE agreement itself is asserted end to end in
// test/e2e/report-loud-redesign.test.js, through the real CLI.

import assert from 'node:assert/strict';
import {
  buildVerdictHeadline, buildLiftOpportunity, buildLiftNarrative, engineNameOf,
} from '../lib/report/run-metrics.js';
import { buildMetric } from '../lib/report/trend-model.js';
import { VERDICT } from '../lib/report/answer-history.js';
import { sectionRunVerdict } from '../lib/report/sections.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** The index metric as buildRunMetrics builds it, from a score series. */
const indexFor = (history) => buildMetric({
  id: 'index', label: 'Visibility index', unit: 'points',
  history, unitLabel: 'points', unitLabelOne: 'point',
});

const cell = (verdict, label) => ({ verdict, label, provider: 'gemini' });
const plain = (model) => model.segments.map(s => s.text).join('');

console.log('\nbuildVerdictHeadline — the branch decisions, in one place');

test('run 1 states the score and calls it the baseline, never a change', () => {
  const m = buildVerdictHeadline({ index: indexFor([50]), changedCell: null });
  assert.equal(m.kind, 'baseline');
  assert.equal(m.direction, null, 'there is no direction on a first run');
  assert.equal(m.points, null);
  assert.match(plain(m), /^50 of 100 on the first run\./);
  assert.match(plain(m), /This is the baseline\./);
});

test('a first run falls back to the summary score when the series carries none', () => {
  const m = buildVerdictHeadline({ index: indexFor([]), changedCell: null, fallbackScore: 42 });
  assert.match(plain(m), /^42 of 100 on the first run/);
});

test('nothing changed hands -> the magnitude, then "every answer held its ground"', () => {
  const m = buildVerdictHeadline({ index: indexFor([50, 47]), changedCell: null });
  assert.equal(m.kind, 'held');
  assert.equal(m.direction, 'down');
  assert.equal(m.points, 3);
  assert.equal(plain(m), 'Down 3 points. Every answer held its ground.');
});

test('a flat index reads as "holding at N", not "up 0 points"', () => {
  const m = buildVerdictHeadline({ index: indexFor([50, 50]), changedCell: null });
  assert.equal(m.direction, 'flat');
  assert.equal(plain(m), 'Holding at 50. Every answer held its ground.');
});

test('one point is singular', () => {
  const m = buildVerdictHeadline({ index: indexFor([50, 51]), changedCell: null });
  assert.equal(plain(m), 'Up 1 point. Every answer held its ground.');
});

test('a lost answer while the index FELL joins with a full stop', () => {
  const m = buildVerdictHeadline({
    index: indexFor([50, 41]), changedCell: cell(VERDICT.LOST, 'Gemini'),
  });
  assert.equal(m.kind, 'lost');
  assert.equal(m.engine, 'Gemini');
  assert.equal(plain(m), 'Down 9 points. Gemini dropped an answer it had held before.');
});

test('a lost answer while the index ROSE is joined by "overall — but", not a full stop', () => {
  // "Up 9 points. Gemini dropped an answer." reads as a contradiction; the
  // joining word is what tells the reader the two are both true.
  const m = buildVerdictHeadline({
    index: indexFor([50, 59]), changedCell: cell(VERDICT.LOST, 'Gemini'),
  });
  assert.equal(plain(m), 'Up 9 points overall — but Gemini dropped an answer it had held before.');
});

test('a gained answer while the index FELL is joined by "overall — but"', () => {
  const m = buildVerdictHeadline({
    index: indexFor([50, 45]), changedCell: cell(VERDICT.GAINED, 'ChatGPT'),
  });
  assert.equal(m.kind, 'gained');
  assert.equal(plain(m), 'Down 5 points overall — but ChatGPT started naming you where it did not before.');
});

test('a gained answer while the index ROSE joins with a full stop', () => {
  const m = buildVerdictHeadline({
    index: indexFor([50, 58]), changedCell: cell(VERDICT.GAINED, 'ChatGPT'),
  });
  assert.equal(plain(m), 'Up 8 points. ChatGPT started naming you where it did not before.');
});

test('a verdict the headline has no sentence for falls back to the held branch', () => {
  // SLIPPED / NEVER / NEW reach headlineCell in no path today, but a future
  // caller must get a true sentence rather than "undefined dropped an answer".
  const m = buildVerdictHeadline({
    index: indexFor([50, 47]), changedCell: cell(VERDICT.SLIPPED, 'Claude'),
  });
  assert.equal(m.kind, 'held');
  assert.ok(!/Claude/.test(plain(m)), 'an unhandled verdict must not name an engine it says nothing about');
});

test('the engine name drops the model parenthetical the label carries', () => {
  const m = buildVerdictHeadline({
    index: indexFor([50, 47]),
    changedCell: cell(VERDICT.LOST, 'Gemini (gemini-3.1-flash)'),
  });
  assert.equal(m.engine, 'Gemini');
  assert.match(plain(m), /Gemini dropped/);
  assert.ok(!/gemini-3\.1/.test(plain(m)), 'a model id is not the engine name a reader knows');
});

test('exactly one segment is emphasised, and it is the closing clause', () => {
  for (const model of [
    buildVerdictHeadline({ index: indexFor([50]), changedCell: null }),
    buildVerdictHeadline({ index: indexFor([50, 47]), changedCell: null }),
    buildVerdictHeadline({ index: indexFor([50, 47]), changedCell: cell(VERDICT.LOST, 'Gemini') }),
    buildVerdictHeadline({ index: indexFor([50, 57]), changedCell: cell(VERDICT.GAINED, 'Gemini') }),
  ]) {
    const emphasised = model.segments.filter(s => s.emphasis);
    assert.equal(emphasised.length, 1, `expected one emphasised clause in "${plain(model)}"`);
    assert.ok(emphasised[0].text.trim().length > 0, 'an emphasised clause must carry words');
  }
});

test('a changed cell with no usable label never renders a headless sentence', () => {
  const m = buildVerdictHeadline({
    index: indexFor([50, 47]), changedCell: { verdict: VERDICT.LOST, label: '', provider: '' },
  });
  assert.ok(!/undefined|null/.test(plain(m)), `leaked a placeholder: "${plain(m)}"`);
  assert.equal(m.kind, 'held');
});

console.log('\nengineNameOf');

test('falls back to the provider slug when no label was recorded', () => {
  assert.equal(engineNameOf({ provider: 'openai' }), 'openai');
  assert.equal(engineNameOf(null), null);
  assert.equal(engineNameOf({ label: '   ' }), null);
});

console.log('\nbuildLiftOpportunity — the aggregate the per-answer pills cannot state');

const answers = (...mentions) => ({ results: mentions.map(mention => ({ mention })) });

test('counts the answers that cite the domain without naming the brand', () => {
  const lift = buildLiftOpportunity(answers('yes', 'src', 'src', 'no'));
  assert.equal(lift.cited, 2);
  assert.equal(lift.named, 1);
  assert.equal(lift.absent, 1);
  assert.equal(lift.total, 4);
  assert.equal(lift.kind, 'lift');
});

test('zero cited-only answers WITH a naming is a success state, not a gap', () => {
  const lift = buildLiftOpportunity(answers('yes', 'yes', 'no'));
  assert.equal(lift.cited, 0);
  assert.equal(lift.kind, 'clean');
});

test('zero citations AND zero namings is neither — the gap is upstream', () => {
  const lift = buildLiftOpportunity(answers('no', 'no'));
  assert.equal(lift.kind, 'unseen', 'an invisible brand must not be told it is in a success state');
});

test('error cells are counted apart, never as an absence', () => {
  const lift = buildLiftOpportunity(answers('src', 'error'));
  assert.equal(lift.errored, 1);
  assert.equal(lift.absent, 0, 'a failed call is not a measured absence');
  assert.equal(lift.total, 2, 'the denominator is every cell the run attempted');
});

test('an empty or absent snapshot does not throw', () => {
  assert.equal(buildLiftOpportunity(null).total, 0);
  assert.equal(buildLiftOpportunity({}).kind, 'unseen');
});

console.log('\nbuildLiftNarrative — one sentence about the figure, split where the client copy ends');

// The `stat` half ships to a client, the `advisory` half does not. If the split
// point drifts into the wrong half, the white-label snapshot either leaks
// advice or loses the figure — and both surfaces inherit the mistake at once,
// which is the price of sharing the copy.
const ADVISORY_VERBS = [/shortest lift/i, /\bpitch/i, /outreach/i, /recommend/i, /push for/i, /to convert/i];

test('every kind states its figure in the stat half and its next step in the advisory half', () => {
  for (const [kind, lift] of [
    ['lift', buildLiftOpportunity(answers('yes', 'src'))],
    ['clean', buildLiftOpportunity(answers('yes', 'yes'))],
    ['unseen', buildLiftOpportunity(answers('no', 'no'))],
  ]) {
    const note = buildLiftNarrative(lift);
    assert.equal(lift.kind, kind);
    assert.ok(note.stat.trim().length > 0, `${kind}: the client half must still say something`);
    assert.ok(note.advisory.trim().length > 0, `${kind}: the internal half must still say something`);
    for (const verb of ADVISORY_VERBS) {
      assert.ok(!verb.test(note.stat),
        `${kind}: advisory copy ${verb} sits in the half that ships to a client`);
    }
  }
});

test('the lift half counts what the aggregate counted, with agreeing grammar', () => {
  assert.equal(
    buildLiftNarrative(buildLiftOpportunity(answers('yes', 'src'))).stat,
    '1 of 2 answers cites your domain as a source without naming you in the answer text.',
  );
  assert.equal(
    buildLiftNarrative(buildLiftOpportunity(answers('src', 'src'))).stat,
    '2 of 2 answers cite your domain as a source without naming you in the answer text.',
  );
  assert.equal(
    buildLiftNarrative(buildLiftOpportunity(answers('src'))).stat,
    '1 of 1 answer cites your domain as a source without naming you in the answer text.',
  );
});

test('the advisory half of a lift run is the CTA the HTML hero has always carried', () => {
  const note = buildLiftNarrative(buildLiftOpportunity(answers('yes', 'src')));
  assert.match(note.advisory, /shortest lift on this report is being named in the answer itself/);
});

test('a missing or malformed lift does not throw and falls to the upstream-gap wording', () => {
  assert.match(buildLiftNarrative(null).stat, /No answer cites your domain at all this run/);
  assert.match(buildLiftNarrative({}).advisory, /The gap is upstream of this figure/);
});

console.log('\nsectionRunVerdict — the markdown surface renders those decisions');

const PROVIDERS = [['openai', 'ChatGPT'], ['gemini', 'Gemini']];

/**
 * One synthetic run. `mentionAt(providerIdx)` shapes each engine's answer to
 * the single tracked question.
 */
function snap(index, score, mentionAt) {
  return {
    date: `2026-03-0${index}`,
    score,
    brand: 'TestBrand',
    domain: 'testbrand.com',
    topCompetitors: [{ name: 'Rival One', count: 1 }],
    results: PROVIDERS.map(([provider, label], pi) => ({
      query: 'Q1', queryText: 'best test tools', provider, label,
      model: 'test-model', mention: mentionAt(pi), position: null,
      citationCount: 1, canonicalCitations: ['https://testbrand.com/a'],
      competitors: ['Rival One'],
    })),
  };
}

test('a first run prints the baseline headline, not a delta', () => {
  const md = sectionRunVerdict([snap(1, 50, () => 'yes')]);
  assert.match(md, /## The run in one page/);
  assert.match(md, /\*\*50 of 100 on the first run\. This is the baseline\.\*\*/);
});

test('a held run prints the magnitude and says every answer held', () => {
  const md = sectionRunVerdict([snap(1, 50, () => 'yes'), snap(2, 47, () => 'yes')]);
  assert.match(md, /\*\*Down 3 points\. Every answer held its ground\.\*\*/);
});

test('a lost answer names the engine that dropped it', () => {
  const md = sectionRunVerdict([
    snap(1, 50, () => 'yes'),
    snap(2, 41, (pi) => (pi === 1 ? 'no' : 'yes')),
  ]);
  assert.match(md, /\*\*Down 9 points\. Gemini dropped an answer it had held before\.\*\*/);
});

test('a gain against a falling index keeps the "overall — but" join', () => {
  const md = sectionRunVerdict([
    snap(1, 50, (pi) => (pi === 1 ? 'no' : 'yes')),
    snap(2, 45, () => 'yes'),
  ]);
  assert.match(md, /overall — but Gemini started naming you where it did not before/);
});

test('the markdown headline carries no HTML — the emphasis is dropped, not printed', () => {
  const md = sectionRunVerdict([snap(1, 50, () => 'yes'), snap(2, 47, () => 'yes')]);
  assert.ok(!/<em>|<\/em>|<b>/.test(md), 'markup leaked into the markdown surface');
});

test('the lift aggregate is stated on the markdown surface too, from the same source', () => {
  const md = sectionRunVerdict([snap(1, 50, (pi) => (pi === 1 ? 'src' : 'yes'))]);
  assert.match(md, /- \*\*Cited without being named:\*\* 1 of 2/);
  assert.match(md, /1 of 2 answers cites your domain as a source without naming you/);
});

test('the internal markdown keeps the lift CTA — parity with the HTML hero KPI', () => {
  // The HTML hero states the figure AND what to do about it. The markdown
  // report is the same report for a terminal reader, so dropping the CTA here
  // made the two surfaces say different things about the same number. The
  // white-label gate below — not the surface — is what withholds advice.
  const md = sectionRunVerdict([snap(1, 50, (pi) => (pi === 1 ? 'src' : 'yes'))]);
  assert.match(md, /- \*\*Cited without being named:\*\* 1 of 2/);
  assert.match(md, /1 of 2 answers cites your domain as a source without naming you/);
  assert.match(md, /shortest lift on this report is being named in the answer itself/,
    'the markdown surface states the figure but withholds the next step the HTML hero gives');
});

test('the default call and an explicit whiteLabel:false render the same thing', () => {
  // renderMarkdown calls this section bare, like its five neighbours. If the
  // default ever stopped meaning "internal", the CTA would vanish from the
  // real report while the explicit call above kept passing.
  const snaps = [snap(1, 50, (pi) => (pi === 1 ? 'src' : 'yes'))];
  assert.equal(sectionRunVerdict(snaps), sectionRunVerdict(snaps, { whiteLabel: false }));
});

test('the white-label markdown drops the CTA and keeps the figure', () => {
  // renderWhiteLabelMarkdown passes { whiteLabel: true }: any advisory verb
  // that survives lands in a client deliverable that must read as a self-made
  // statistics tool — while the statistics themselves must still be there, or
  // the client is handed a report with a hole in it.
  const md = sectionRunVerdict([snap(1, 50, (pi) => (pi === 1 ? 'src' : 'yes'))], { whiteLabel: true });
  for (const banned of [/outreach/i, /\bpitch/i, /recommend/i, /push for/i, /to convert/i, /shortest lift/i]) {
    assert.ok(!banned.test(md), `advisory copy ${banned} leaked into a white-label snapshot`);
  }
  assert.match(md, /- \*\*Cited without being named:\*\* 1 of 2/, 'the client lost the figure, not the advice');
  assert.match(md, /1 of 2 answers cites your domain as a source without naming you/);
});

test('the white-label lift note is client-safe on the OTHER two branches too', () => {
  // The gate ships `stat` alone. Only the 'lift' branch is exercised by the
  // tests above and by the leak-free E2E seed, so the two branches a real
  // client hits on a good run — or on a run with no citations at all — would
  // otherwise change wording with nothing watching them.
  const clean = sectionRunVerdict([snap(1, 50, () => 'yes')], { whiteLabel: true });
  assert.match(clean, /Every answer that cites your domain also names you in the text\./);
  assert.doesNotMatch(clean, /Nothing is stranded/, 'the advisory half of the success state leaked');

  const unseen = sectionRunVerdict([snap(1, 0, () => 'no')], { whiteLabel: true });
  assert.match(unseen, /No answer cites your domain at all this run, so there is no citation here to lift\./);
  assert.doesNotMatch(unseen, /The gap is upstream of this figure/, 'the advisory half of the unseen state leaked');

  // …and the internal report still gets both halves on the same two branches.
  assert.match(sectionRunVerdict([snap(1, 50, () => 'yes')]), /Nothing is stranded/);
  assert.match(sectionRunVerdict([snap(1, 0, () => 'no')]), /The gap is upstream of this figure/);
});

test('white-label drops nothing but the advisory clause — the rest of the section is identical', () => {
  // A gate that quietly removed a whole block would pass the denylist above
  // while gutting the client report; this pins the delta to one clause.
  const snaps = [snap(1, 50, (pi) => (pi === 1 ? 'src' : 'yes'))];
  const internal = sectionRunVerdict(snaps);
  const wl = sectionRunVerdict(snaps, { whiteLabel: true });
  const advisory = ' Those pages are already inside the engine\'s source pool — the shortest lift on this report is being named in the answer itself, not only linked beneath it.';
  assert.equal(internal.replace(advisory, ''), wl,
    'the white-label snapshot differs from the internal one by more than the advisory sentence');
});

test('"where to act" is present at every run count, including run 1', () => {
  for (const snaps of [
    [snap(1, 50, () => 'yes')],
    [snap(1, 50, () => 'yes'), snap(2, 47, () => 'yes')],
    [snap(1, 50, () => 'yes'), snap(2, 47, () => 'yes'), snap(3, 44, () => 'yes')],
  ]) {
    const md = sectionRunVerdict(snaps);
    assert.match(md, /\*\*Where to act\.\*\*/,
      `run ${snaps.length}: a missing callout reads as "no finding", not "no finding large enough"`);
  }
});

test('no snapshots renders nothing rather than a headline about nothing', () => {
  assert.equal(sectionRunVerdict([]), '');
  assert.equal(sectionRunVerdict(null), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
