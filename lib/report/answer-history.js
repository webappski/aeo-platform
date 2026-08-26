// Per-answer history: what each engine did with each question, run by run.
//
// The report already knows whether the brand appears in an answer TODAY. What
// a reader actually asks is narrower and harder: "has this answer always said
// that?" One cell going quiet after holding for months is a different problem
// from a cell that has never worked, and the aggregate presence percentage
// cannot tell them apart.
//
// Relationship to comparison-segments.js: that module answers the AGGREGATE
// question ("how many cells changed hands") and its binary present/absent split
// is what the presence arithmetic depends on — a cited-only answer counts as
// present there, and must keep counting as present. This module answers the
// PER-CELL question and needs a finer ladder, because "cited as a source" and
// "named in the prose" are visibly different outcomes to a reader looking at
// one row. Both are correct at their own altitude; neither should be rewritten
// into the other.

/** @type {string} The brand is named in the answer prose. */
export const ST_NAMED = 'named';
/** @type {string} The brand's domain was cited as a source, but the brand was not named. */
export const ST_CITED = 'cited';
/** @type {string} The question was asked, the answer did not include the brand at all. */
export const ST_ABSENT = 'absent';
/** @type {string} Nothing usable: the run errored here, skipped the engine, or never asked this question. */
export const ST_BLANK = 'blank';

/**
 * Verdict of the current run against the previous one, per cell.
 * @type {Readonly<Record<string, string>>}
 */
export const VERDICT = Object.freeze({
  LOST: 'lost',
  GAINED: 'gained',
  HELD: 'held',
  SLIPPED: 'slipped',
  NEVER: 'never',
  NEW: 'new',
  UNKNOWN: 'unknown',
});

/**
 * State of one measured cell.
 * @param {{mention?: string}|null|undefined} row
 * @returns {string} One of the ST_* constants.
 */
export function cellState(row) {
  if (!row) return ST_BLANK;
  if (row.mention === 'yes') return ST_NAMED;
  if (row.mention === 'src') return ST_CITED;
  if (row.mention === 'no') return ST_ABSENT;
  return ST_BLANK; // 'error', 'missing', anything unrecognised
}

/**
 * Is this state an appearance of any kind?
 * @param {string} state
 * @returns {boolean}
 */
export function isVisible(state) {
  return state === ST_NAMED || state === ST_CITED;
}

/**
 * Normalised question text, used to detect that a tracked question slot was
 * reworded between runs.
 * @param {string|null|undefined} text
 * @returns {string}
 */
function normText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stable identity of a tracked cell: question SLOT plus engine.
 *
 * Slot rather than question text, matching comparison-segments.js's cellKey and
 * lib/diff.js. The slot is what the tool tracks over time; keying on the text
 * would restart every record the day a question is reworded, which is exactly
 * when continuity matters most. The rewording is not swallowed, though — see
 * `textDrift` on the returned entry.
 *
 * @param {{query?: string, provider?: string}} row
 * @returns {string}
 */
export function cellKey(row) {
  return `${row?.query || ''}::${row?.provider || ''}`;
}

/**
 * Build the run-by-run record of every cell in the newest run.
 *
 * @param {Array<Object>} snapshots Ordered oldest -> newest.
 * @returns {{runs: Array<{date: string, index: number, partial: boolean, cells: number}>,
 *            cells: Array<Object>, expectedCells: number}}
 */
export function buildAnswerHistory(snapshots) {
  const runs = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  if (runs.length === 0) return { runs: [], cells: [], expectedCells: 0 };

  const expectedCells = runs.reduce((m, s) => Math.max(m, (s.results || []).length), 0);
  const runMeta = runs.map((s, i) => ({
    date: s.date || '',
    index: i + 1,
    cells: (s.results || []).length,
    partial: (s.results || []).length > 0 && (s.results || []).length < expectedCells,
    score: Number.isFinite(s.score) ? s.score : null,
  }));

  // One lookup per run so the per-cell walk stays linear.
  const indexed = runs.map((s) => {
    const map = new Map();
    for (const row of s.results || []) map.set(cellKey(row), row);
    return map;
  });

  const latest = runs[runs.length - 1];
  const cells = (latest.results || []).map((row) => {
    const key = cellKey(row);
    const currentText = normText(row.queryText);
    const states = [];
    const texts = [];
    for (let i = 0; i < runs.length; i++) {
      const r = indexed[i].get(key) || null;
      // A run that did not measure this cell at all and a run whose whole
      // basket was smaller are both blanks, but only the second is the run's
      // fault; runMeta[i].partial carries that distinction for the caption.
      states.push(cellState(r));
      texts.push(r ? normText(r.queryText) : null);
    }
    // Runs where this slot carried a different question. The record still shows
    // what was measured — it was a real measurement — but any streak claim has
    // to say the question was reworded, or the report asserts continuity it
    // does not have.
    const driftRuns = [];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i] && currentText && texts[i] !== currentText) driftRuns.push(i);
    }
    const textDrift = driftRuns.length > 0
      ? {
        runs: driftRuns.map((i) => runMeta[i].index),
        // The run at which the current wording starts holding continuously.
        settledAt: (() => {
          let start = texts.length - 1;
          while (start > 0 && texts[start - 1] === currentText) start--;
          return runMeta[start] ? runMeta[start].date : null;
        })(),
      }
      : null;

    return {
      key,
      query: row.query || '',
      queryText: row.queryText || '',
      provider: row.provider || '',
      label: row.label || row.provider || '',
      rank: Number.isFinite(row.position) ? row.position : null,
      citationCount: Number.isFinite(row.citationCount) ? row.citationCount : null,
      competitors: (row.competitors || [])
        .map((c) => (typeof c === 'string' ? c : c?.name))
        .filter(Boolean),
      states,
      textDrift,
      state: states[states.length - 1],
      verdict: verdictFor(states),
      record: recordSentence(states, runMeta),
    };
  });

  return { runs: runMeta, cells, expectedCells };
}

/**
 * Verdict of the newest state against the most recent EARLIER state that was
 * actually measured. Comparing against a blank would report every skipped run
 * as a fresh loss.
 * @param {Array<string>} states Ordered oldest -> newest.
 * @returns {string} One of the VERDICT values.
 */
export function verdictFor(states) {
  const list = Array.isArray(states) ? states : [];
  const now = list[list.length - 1];
  if (!now || now === ST_BLANK) return VERDICT.UNKNOWN;
  let before = null;
  for (let i = list.length - 2; i >= 0; i--) {
    if (list[i] !== ST_BLANK) { before = list[i]; break; }
  }
  if (before === null) return now === ST_ABSENT ? VERDICT.NEVER : VERDICT.NEW;
  if (now === ST_NAMED) {
    // A citation converting into a naming is the outcome the whole report is
    // arguing for; calling it "held" because both states counted as present
    // would hide the one thing that improved.
    if (before === ST_NAMED) return VERDICT.HELD;
    return VERDICT.GAINED;
  }
  if (now === ST_CITED) {
    if (before === ST_NAMED) return VERDICT.SLIPPED;
    if (before === ST_CITED) return VERDICT.HELD;
    return VERDICT.GAINED;
  }
  // now === ST_ABSENT
  if (before === ST_NAMED || before === ST_CITED) return VERDICT.LOST;
  return VERDICT.NEVER;
}

/**
 * Count of state changes across the measured runs — the "volatile" test.
 * Blanks are skipped rather than counted as a flip in and a flip out.
 * @param {Array<string>} states
 * @returns {number}
 */
export function flipCount(states) {
  let flips = 0;
  let last = null;
  for (const s of states || []) {
    if (s === ST_BLANK) continue;
    const visible = isVisible(s);
    if (last !== null && visible !== last) flips++;
    last = visible;
  }
  return flips;
}

/**
 * One sentence describing the whole record of a cell.
 *
 * Every branch is derived from the state array; nothing here is a template the
 * caller fills with a claim of its own.
 *
 * @param {Array<string>} states Ordered oldest -> newest.
 * @param {Array<{date: string, index: number, partial: boolean}>} runMeta
 * @returns {string}
 */
export function recordSentence(states, runMeta) {
  const list = Array.isArray(states) ? states : [];
  const measured = list.filter((s) => s !== ST_BLANK).length;
  if (measured === 0) return 'Not measured on any run yet.';
  if (measured === 1) return 'First run for this answer — no record to compare against yet.';

  const now = list[list.length - 1];
  const visibleCount = list.filter(isVisible).length;
  const flips = flipCount(list);

  if (now === ST_ABSENT) {
    // Length of the run of appearances immediately before this one.
    let held = 0;
    for (let i = list.length - 2; i >= 0; i--) {
      if (list[i] === ST_BLANK) continue;
      if (isVisible(list[i])) held++;
      else break;
    }
    if (held === 0) return `Has never appeared in this answer — ${measured} runs measured.`;
    return `Lost this run — had appeared on the ${held === 1 ? 'run before' : `${held} runs before`}.`;
  }

  if (visibleCount === measured) {
    return measured === list.length
      ? `Named on all ${measured} runs.`
      : `Named on every one of the ${measured} runs that measured it.`;
  }

  // Current unbroken streak of appearances, and the run it started on.
  let streak = 0;
  let startIdx = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] === ST_BLANK) continue;
    if (!isVisible(list[i])) break;
    streak++;
    startIdx = i;
  }
  if (flips >= 3) {
    return `Volatile — ${flips} changes on the record, held the last ${streak === 1 ? 'run' : `${streak} runs`}.`;
  }
  const startDate = startIdx != null && runMeta[startIdx] ? runMeta[startIdx].date : null;
  if (streak === measured) return `Named on every measured run.`;
  return startDate
    ? `Named on every run since ${startDate}.`
    : `Named on ${visibleCount} of ${measured} measured runs.`;
}

/**
 * Group the cells of the newest run by question, with the per-question tally
 * the section header states in words.
 *
 * @param {Array<Object>} cells From buildAnswerHistory().
 * @returns {Array<{query: string, queryText: string, cells: Array<Object>,
 *                  named: number, total: number, lost: number, gained: number}>}
 */
export function groupByQuestion(cells) {
  const order = [];
  const byQuery = new Map();
  for (const cell of cells || []) {
    if (!byQuery.has(cell.query)) {
      byQuery.set(cell.query, {
        query: cell.query,
        queryText: cell.queryText,
        cells: [],
        named: 0,
        total: 0,
        lost: 0,
        gained: 0,
      });
      order.push(cell.query);
    }
    const g = byQuery.get(cell.query);
    g.cells.push(cell);
    g.total++;
    if (isVisible(cell.state)) g.named++;
    if (cell.verdict === VERDICT.LOST) g.lost++;
    if (cell.verdict === VERDICT.GAINED) g.gained++;
  }
  // Questions where something changed lead — a reader scanning the section
  // should hit the movement before the steady state.
  return order
    .map((q) => byQuery.get(q))
    .sort((a, b) => (b.lost + b.gained) - (a.lost + a.gained));
}

/**
 * The single cell that best explains this run's movement: the one loss with
 * the longest record behind it, or failing that the most notable gain.
 * @param {Array<Object>} cells
 * @returns {Object|null}
 */
export function headlineCell(cells) {
  const list = cells || [];
  const lost = list.filter((c) => c.verdict === VERDICT.LOST);
  if (lost.length > 0) {
    return lost
      .slice()
      .sort((a, b) => b.states.filter(isVisible).length - a.states.filter(isVisible).length)[0];
  }
  const gained = list.filter((c) => c.verdict === VERDICT.GAINED);
  if (gained.length > 0) {
    return gained
      .slice()
      .sort((a, b) => a.states.filter(isVisible).length - b.states.filter(isVisible).length)[0];
  }
  return null;
}
