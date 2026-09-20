/**
 * Cross-run comparison.
 *
 * The contract this file has to keep is narrow and easy to break: a diff may
 * only subtract measurements of THE SAME QUESTION. Until 2026-09 it keyed
 * cells by the ordinal label the config happened to give a query that day
 * (`` `${r.query}|${r.provider}` `` → `Q12|openai`). The label is a position
 * in an array, not an identity, so the two runs actually on disk —
 * 2026-08-27 (56 questions) and 2026-08-31 (50 questions) — lined up 50 label
 * pairs in which ALL 50 texts differ. Nothing about that comparison was a
 * comparison; it was 50 pairs of unrelated questions rendered as movement,
 * and the headline `scoreDelta` (1% → 13%) was a change of basket presented
 * as a change of visibility.
 *
 * Now: identity comes from `lib/basket-manifest.js` (stable id of the
 * normalised question text, plus the declared market), questions present in
 * only one of the two runs are COUNTED AND NAMED as incomparable rather than
 * dropped or mis-paired, and the overall `scoreDelta` is withheld (null) when
 * the baskets differ — replaced by a delta computed strictly over the
 * intersection, labelled with how many questions it rests on.
 *
 * What this does NOT claim: nothing here says a published historical score was
 * wrong. The 2026-08-31 run had zero errors and no repeated trials, so its
 * headline is unaffected. The defect was always in the comparisons.
 */

import { classifyProportionChange } from './stats.js';
import { aggregateScore } from './score.js';
import { manifestIndex, resolveQueryIdentity, isLabelIdentity } from './basket-manifest.js';
import { headlineComparability } from './run-axes.js';

function listMap(list, key = 'name') {
  const m = new Map();
  for (const item of (list || [])) m.set(item[key], item.count);
  return m;
}

/** A sampled record carries a `presence` object with hits/n. Single-shot
 *  records (the default, and every legacy snapshot on disk) do not. */
function hasPresence(r) {
  return !!(r && r.presence && typeof r.presence.n === 'number' && r.presence.n > 0);
}

/**
 * A cell is "covered" by a run when the run produced a real measurement
 * (api response or manual paste). Cells absent from a run, or where the
 * provider errored, are NOT comparable — diffing them produces fabricated
 * regressions ("Perplexity was: yes → now: no" when Perplexity wasn't even
 * in the previous run).
 */
function isCoveredMention(m) {
  return m && m !== 'error' && m !== 'missing';
}

/** Index one run's records by resolved question identity and by cell. */
function indexRun(summary, idx) {
  const questions = new Map();   // id → { id, text, market, label }
  const cells = new Map();       // `${id}|${provider}` → record
  let labelOnly = 0;
  for (const r of (summary?.results || [])) {
    const ident = resolveQueryIdentity(r, idx);
    if (isLabelIdentity(ident.id)) labelOnly++;
    if (!questions.has(ident.id)) {
      questions.set(ident.id, {
        id: ident.id,
        text: ident.text,
        market: ident.market,
        label: r.query ?? null,
      });
    }
    cells.set(`${ident.id}|${r.provider}`, r);
  }
  return { questions, cells, labelOnly };
}

/**
 * @param {object} summaryA earlier run's `_summary.json`
 * @param {object} summaryB later run's `_summary.json`
 * @param {object} [opts]
 * @param {object} [opts.manifest] basket manifest (`basketManifest` from the
 *        config, or from either summary) — supplies declared markets. Absent
 *        manifest is fine: identity still comes from the question text.
 */
export function diff(summaryA, summaryB, opts = {}) {
  const manifest = opts.manifest || summaryB?.basketManifest || summaryA?.basketManifest || null;
  const idx = manifestIndex(manifest);

  const A = indexRun(summaryA, idx);
  const B = indexRun(summaryB, idx);

  // ── Which questions may be compared at all ───────────────────────────────
  // A question is comparable when BOTH runs asked it. A question asked in only
  // one run is not a gain, not a loss, and not a zero — it is unmeasured on the
  // other side, and the honest report of it is a count plus its text.
  const comparableIds = [];
  const onlyInNew = [];
  const onlyInBaseline = [];
  const marketChanged = [];

  for (const [id, q] of B.questions) {
    const prev = A.questions.get(id);
    if (!prev) { onlyInNew.push(q); continue; }
    // Same text, different DECLARED market ⇒ the basket was re-declared under
    // this question; the two measurements answer different asks. Rare, and
    // named rather than silently compared.
    if (prev.market && q.market && prev.market !== q.market) {
      marketChanged.push({ ...q, wasMarket: prev.market });
      continue;
    }
    comparableIds.push(id);
  }
  for (const [id, q] of A.questions) {
    if (!B.questions.has(id)) onlyInBaseline.push(q);
  }

  const basketChanged = onlyInNew.length > 0 || onlyInBaseline.length > 0 || marketChanged.length > 0;
  const identityWeak = A.labelOnly > 0 || B.labelOnly > 0;

  // ── Cell changes — only over comparable questions ────────────────────────
  const comparableSet = new Set(comparableIds);
  const cellKeys = new Set([...A.cells.keys(), ...B.cells.keys()]);

  const cellChanges = [];
  const pairedCellsA = [];
  const pairedCellsB = [];

  for (const key of cellKeys) {
    const id = key.slice(0, key.lastIndexOf('|'));
    if (!comparableSet.has(id)) continue;
    const ra = A.cells.get(key);
    const rb = B.cells.get(key);
    if (!ra || !rb) continue;                       // provider added/dropped — not a change
    if (!isCoveredMention(ra.mention) || !isCoveredMention(rb.mention)) continue;

    // Both sides measured this exact question on this engine — this is the
    // population the intersection score is computed over, below.
    pairedCellsA.push(ra);
    pairedCellsB.push(rb);

    if (ra.mention === rb.mention) continue;

    // AP-MEASURE-SAMPLING-CI: when BOTH runs sampled this cell, decide whether
    // the change is a real signal or sampling noise (overlapping Wilson CIs →
    // noise). A noise change is NOT a regression — drop it so a single noisy
    // trial flip can't trip exit-1. When EITHER run is single-shot we have no
    // distribution to test, so fall back to today's behaviour: emit the flip,
    // tagged `point-estimate` (back-compat — legacy snapshots on disk).
    let method = 'point-estimate';
    if (hasPresence(ra) && hasPresence(rb)) {
      const verdict = classifyProportionChange(
        { hits: ra.presence.hits, n: ra.presence.n },
        { hits: rb.presence.hits, n: rb.presence.n },
      );
      if (verdict.classification === 'noise') continue;  // statistically indistinguishable — not a change
      method = 'distribution';
    }

    const q = B.questions.get(id) || A.questions.get(id) || {};
    cellChanges.push({
      provider: rb.provider,
      query: rb.query ?? ra.query,      // ordinal label — display only
      queryId: id,
      queryText: q.text || null,
      market: q.market || null,
      was: ra.mention,
      now: rb.mention,
      mixedMethod: (ra.source || 'api') !== (rb.source || 'api'),
      method,
    });
  }

  // ── Score movement ───────────────────────────────────────────────────────
  // Same basket → the published headline delta is a fact and is reported.
  // Different basket → it is not: the two headlines were computed over
  // different question sets. Report null plus the reason, and give the delta
  // that IS defensible — the one restricted to the questions both runs asked,
  // stamped with how many questions that is.
  const aggA = aggregateScore(pairedCellsA);
  const aggB = aggregateScore(pairedCellsB);
  const intersection = comparableIds.length > 0
    ? {
      scoreA: aggA.score,
      scoreB: aggB.score,
      delta: aggB.score - aggA.score,
      questionsCompared: comparableIds.length,
      cellsCompared: pairedCellsA.length,
      hitsA: aggA.hits, validA: aggA.valid,
      hitsB: aggB.hits, validB: aggB.valid,
    }
    : null;

  // AP-DIFF-ENGINE-MIX-AXIS — the basket is not the only way two headlines stop
  // being subtractable. 2026-08-31 measured three engines and 2026-09-16 two;
  // the basket was identical, so the gate above stayed shut and «−2pp» shipped
  // as fact while the honest number over the 100 shared cells was 11 vs 11.
  // The engine set is the second axis, and `intersection` below is already the
  // defensible figure: it is built from PAIRED cells, so an engine present in
  // only one run never enters it.
  const comparability = headlineComparability(summaryA, summaryB, { basketChanged });
  const scoreDelta = comparability.comparable
    ? (summaryB?.score ?? 0) - (summaryA?.score ?? 0)
    : null;

  // Competitor movements
  const aComps = listMap(summaryA?.topCompetitors);
  const bComps = listMap(summaryB?.topCompetitors);

  const newCompetitors = [];
  const lostCompetitors = [];
  for (const [name, count] of bComps) {
    if (!aComps.has(name)) newCompetitors.push({ name, count });
  }
  for (const [name, count] of aComps) {
    if (!bComps.has(name)) lostCompetitors.push({ name, count });
  }

  // Canonical sources movement
  const aSrc = listMap(summaryA?.topCanonicalSources, 'url');
  const bSrc = listMap(summaryB?.topCanonicalSources, 'url');

  const sourcesGained = [];
  const sourcesLost = [];
  for (const [url, count] of bSrc) {
    if (!aSrc.has(url)) sourcesGained.push({ url, count });
  }
  for (const [url, count] of aSrc) {
    if (!bSrc.has(url)) sourcesLost.push({ url, count });
  }

  return {
    scoreDelta,
    scoreDeltaReason: comparability.reason,
    scoreDeltaReasons: comparability.reasons,
    // The engine axis beside the basket one, same shape of answer: what
    // changed, what the two runs share, and the sentence that belongs next to
    // the withheld number.
    engines: {
      changed: comparability.engines.changed,
      common: comparability.engines.common,
      onlyInNew: comparability.engines.onlyInNew,
      onlyInBaseline: comparability.engines.onlyInBaseline,
      countNew: comparability.engines.countNew,
      countBaseline: comparability.engines.countBaseline,
      note: comparability.note,
    },
    basket: {
      changed: basketChanged,
      comparable: comparableIds.length,
      incomparable: onlyInNew.length,          // asked now, never asked in the baseline
      retired: onlyInBaseline.length,          // asked in the baseline, not asked now
      marketChanged: marketChanged.length,
      onlyInNew,
      onlyInBaseline,
      marketChangedQuestions: marketChanged,
      questionsNew: B.questions.size,
      questionsBaseline: A.questions.size,
      // 'label' identity means the runs predate `queryText` on the record and
      // the pairing rests on array position — weak, and said so out loud.
      identity: identityWeak ? 'label' : 'text',
    },
    intersection,
    cellChanges,
    newCompetitors,
    lostCompetitors,
    sourcesMovement: { gained: sourcesGained, lost: sourcesLost },
  };
}
