// answer-history — the per-answer record behind the Visibility section.
//
// The regressions guarded here all have the same shape: a sentence about
// continuity that the data does not support. A skipped run read as a loss, a
// citation-to-naming upgrade flattened into "no change", or a streak claimed
// across runs that asked a different question.

import assert from 'node:assert/strict';
import {
  ST_NAMED, ST_CITED, ST_ABSENT, ST_BLANK, VERDICT,
  cellState, isVisible, cellKey, buildAnswerHistory,
  verdictFor, flipCount, recordSentence, groupByQuestion, headlineCell,
} from '../lib/report/answer-history.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

/** Build a snapshot from `[query, provider, mention, queryText?]` tuples. */
function snap(date, rows, score = 50) {
  return {
    date,
    score,
    results: rows.map(([query, provider, mention, queryText, position]) => ({
      query, provider, mention,
      queryText: queryText || `text for ${query}`,
      label: provider === 'openai' ? 'ChatGPT' : provider === 'gemini' ? 'Gemini' : provider,
      position: position ?? null,
      citationCount: 0,
      competitors: [],
    })),
  };
}

console.log('\nanswer-history — states');

test('the four states map off the mention value', () => {
  assert.equal(cellState({ mention: 'yes' }), ST_NAMED);
  assert.equal(cellState({ mention: 'src' }), ST_CITED);
  assert.equal(cellState({ mention: 'no' }), ST_ABSENT);
  assert.equal(cellState({ mention: 'error' }), ST_BLANK);
  assert.equal(cellState(null), ST_BLANK, 'an unmeasured cell is blank, not absent');
});

test('cited-as-a-source counts as visible but is NOT the same state as named', () => {
  assert.equal(isVisible(ST_CITED), true);
  assert.equal(isVisible(ST_NAMED), true);
  assert.equal(isVisible(ST_ABSENT), false);
  assert.notEqual(ST_CITED, ST_NAMED, 'the finer ladder is the point of this module');
});

test('the cell key ignores the model so a provider version swap is not a loss', () => {
  assert.equal(cellKey({ query: 'Q1', provider: 'openai', model: 'gpt-5' }), 'Q1::openai');
  assert.equal(cellKey({ query: 'Q1', provider: 'openai', model: 'gpt-6' }), 'Q1::openai');
});

console.log('\nanswer-history — verdicts');

test('citation converting to a naming reads as GAINED, not held', () => {
  // The aggregate segmentation counts both as "present" — correct there,
  // because the presence arithmetic depends on it. Per cell it is the one
  // thing that improved, and flattening it would hide the win.
  assert.equal(verdictFor([ST_CITED, ST_NAMED]), VERDICT.GAINED);
});

test('named then absent is LOST', () => {
  assert.equal(verdictFor([ST_NAMED, ST_NAMED, ST_ABSENT]), VERDICT.LOST);
});

test('named then cited-only is SLIPPED, not lost', () => {
  assert.equal(verdictFor([ST_NAMED, ST_CITED]), VERDICT.SLIPPED);
});

test('a skipped run does not manufacture a loss', () => {
  // Compare against the last run that actually measured, not against a blank.
  assert.equal(verdictFor([ST_NAMED, ST_BLANK, ST_NAMED]), VERDICT.HELD);
  assert.equal(verdictFor([ST_ABSENT, ST_BLANK, ST_NAMED]), VERDICT.GAINED);
});

test('never present is NEVER, which is not a decline', () => {
  assert.equal(verdictFor([ST_ABSENT, ST_ABSENT, ST_ABSENT]), VERDICT.NEVER);
  assert.equal(verdictFor([ST_ABSENT]), VERDICT.NEVER, 'a first-run absence has nothing to have lost');
});

test('a first measurement that names you is NEW, not GAINED', () => {
  assert.equal(verdictFor([ST_NAMED]), VERDICT.NEW);
  assert.equal(verdictFor([ST_BLANK, ST_BLANK, ST_NAMED]), VERDICT.NEW);
});

test('an unusable current cell is UNKNOWN rather than a loss', () => {
  assert.equal(verdictFor([ST_NAMED, ST_NAMED, ST_BLANK]), VERDICT.UNKNOWN);
});

console.log('\nanswer-history — record sentences');

test('flips ignore blanks so a skipped run is not two flips', () => {
  assert.equal(flipCount([ST_NAMED, ST_BLANK, ST_NAMED]), 0);
  assert.equal(flipCount([ST_NAMED, ST_ABSENT, ST_NAMED]), 2);
  assert.equal(flipCount([ST_ABSENT, ST_ABSENT, ST_NAMED]), 1);
});

test('an unbroken record states the total, not a start date', () => {
  const meta = [1, 2, 3].map(i => ({ date: `2026-0${i}-01`, index: i, partial: false }));
  assert.match(recordSentence([ST_NAMED, ST_NAMED, ST_NAMED], meta), /Named on all 3 runs\./);
});

test('a loss states how long it had been held', () => {
  const meta = [1, 2, 3, 4].map(i => ({ date: `2026-0${i}-01`, index: i, partial: false }));
  const s = recordSentence([ST_NAMED, ST_NAMED, ST_NAMED, ST_ABSENT], meta);
  assert.match(s, /Lost this run/);
  assert.match(s, /3 runs before/);
});

test('a volatile record is called volatile rather than given a false start date', () => {
  const meta = [1, 2, 3, 4, 5].map(i => ({ date: `2026-0${i}-01`, index: i, partial: false }));
  const s = recordSentence([ST_NAMED, ST_ABSENT, ST_NAMED, ST_ABSENT, ST_NAMED], meta);
  assert.match(s, /Volatile/);
  assert.match(s, /4 changes/);
});

test('a single measured run makes no claim about a record', () => {
  const meta = [{ date: '2026-01-01', index: 1, partial: false }];
  assert.match(recordSentence([ST_NAMED], meta), /First run for this answer/);
  assert.match(recordSentence([ST_BLANK], meta), /Not measured on any run yet/);
});

console.log('\nanswer-history — full build');

test('builds a run-by-run record for every cell in the newest run', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'yes'], ['Q1', 'gemini', 'no']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes'], ['Q1', 'gemini', 'yes']]),
    snap('2026-03-01', [['Q1', 'openai', 'no'], ['Q1', 'gemini', 'yes']]),
  ];
  const h = buildAnswerHistory(snaps);
  assert.equal(h.runs.length, 3);
  assert.equal(h.cells.length, 2);
  const gpt = h.cells.find(c => c.provider === 'openai');
  assert.deepEqual(gpt.states, [ST_NAMED, ST_NAMED, ST_ABSENT]);
  assert.equal(gpt.verdict, VERDICT.LOST);
  const gem = h.cells.find(c => c.provider === 'gemini');
  assert.deepEqual(gem.states, [ST_ABSENT, ST_NAMED, ST_NAMED]);
  assert.equal(gem.verdict, VERDICT.HELD);
});

test('a partial run is marked, and its missing cells render blank not absent', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'yes'], ['Q1', 'gemini', 'yes']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes']]),                       // gemini failed
    snap('2026-03-01', [['Q1', 'openai', 'yes'], ['Q1', 'gemini', 'yes']]),
  ];
  const h = buildAnswerHistory(snaps);
  assert.equal(h.expectedCells, 2);
  assert.equal(h.runs[1].partial, true, 'the short run is flagged');
  const gem = h.cells.find(c => c.provider === 'gemini');
  assert.deepEqual(gem.states, [ST_NAMED, ST_BLANK, ST_NAMED],
    'the unmeasured run is blank — reading it as absent would invent a loss and a recovery');
  assert.equal(gem.verdict, VERDICT.HELD);
});

test('a reworded question is surfaced, not swallowed', () => {
  // The slot keeps its record — that is what continuity means — but any
  // streak claim has to disclose that the wording changed.
  const snaps = [
    snap('2026-01-01', [['Q3', 'gemini', 'yes', 'old wording of the question']]),
    snap('2026-02-01', [['Q3', 'gemini', 'yes', 'old wording of the question']]),
    snap('2026-03-01', [['Q3', 'gemini', 'yes', 'new wording of the question']]),
    snap('2026-04-01', [['Q3', 'gemini', 'no', 'new wording of the question']]),
  ];
  const h = buildAnswerHistory(snaps);
  const cell = h.cells[0];
  assert.ok(cell.textDrift, 'the rewording must be detected');
  assert.deepEqual(cell.textDrift.runs, [1, 2], 'the runs that asked something else are named');
  assert.equal(cell.textDrift.settledAt, '2026-03-01', 'the date the current wording starts');
  assert.equal(cell.states.length, 4, 'the record still spans every run of the slot');
});

test('a question that never changed carries no drift note', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'yes', 'stable question']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes', 'stable question']]),
  ];
  assert.equal(buildAnswerHistory(snaps).cells[0].textDrift, null);
});

test('an empty record does not throw', () => {
  const h = buildAnswerHistory([]);
  assert.deepEqual(h.cells, []);
  assert.deepEqual(h.runs, []);
  assert.equal(h.expectedCells, 0);
});

console.log('\nanswer-history — grouping');

test('questions that moved lead the section', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'yes'], ['Q2', 'openai', 'yes']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes'], ['Q2', 'openai', 'no']]),
  ];
  const groups = groupByQuestion(buildAnswerHistory(snaps).cells);
  assert.equal(groups[0].query, 'Q2', 'the question that changed comes first');
  assert.equal(groups[0].lost, 1);
  assert.equal(groups[0].named, 0);
  assert.equal(groups[1].named, 1);
});

test('the headline cell is the loss with the longest record behind it', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'yes'], ['Q2', 'openai', 'no']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes'], ['Q2', 'openai', 'yes']]),
    snap('2026-03-01', [['Q1', 'openai', 'no'], ['Q2', 'openai', 'no']]),
  ];
  const cell = headlineCell(buildAnswerHistory(snaps).cells);
  assert.equal(cell.query, 'Q1', 'two runs held beats one run held');
});

test('with no losses the headline falls back to a gain', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'no']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes']]),
  ];
  assert.equal(headlineCell(buildAnswerHistory(snaps).cells).verdict, VERDICT.GAINED);
});

test('a stable run has no headline cell at all', () => {
  const snaps = [
    snap('2026-01-01', [['Q1', 'openai', 'yes']]),
    snap('2026-02-01', [['Q1', 'openai', 'yes']]),
  ];
  assert.equal(headlineCell(buildAnswerHistory(snaps).cells), null,
    'nothing changed, so the report must not manufacture "the change this run"');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
