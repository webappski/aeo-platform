import { classifyProportionChange } from './stats.js';

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

export function diff(summaryA, summaryB) {
  const scoreDelta = (summaryB.score ?? 0) - (summaryA.score ?? 0);

  // Cell changes — only for (query, provider) pairs covered by BOTH runs.
  // Mixed-method comparisons (api ↔ manual-paste) still get a row but are
  // tagged with `mixedMethod: true` so consumers can render them differently.
  const cells = new Map();
  for (const r of (summaryA.results || [])) {
    cells.set(`${r.query}|${r.provider}`, {
      query: r.query, provider: r.provider,
      was: r.mention, wasSource: r.source || 'api',
      // AP-MEASURE-SAMPLING-CI — carry the presence distribution (if sampled)
      // so a presence change can be tested for significance, not just flip-
      // counted. undefined for single-shot / legacy records.
      wasPresence: r.presence,
    });
  }
  for (const r of (summaryB.results || [])) {
    const key = `${r.query}|${r.provider}`;
    const prev = cells.get(key) || { query: r.query, provider: r.provider, was: null, wasSource: null };
    prev.now = r.mention;
    prev.nowSource = r.source || 'api';
    prev.nowPresence = r.presence;
    cells.set(key, prev);
  }

  const cellChanges = [];
  for (const cell of cells.values()) {
    if (!isCoveredMention(cell.was) || !isCoveredMention(cell.now)) continue;
    if (cell.was === cell.now) continue;

    // AP-MEASURE-SAMPLING-CI: when BOTH runs sampled this cell, decide whether
    // the change is a real signal or sampling noise (overlapping Wilson CIs →
    // noise). A noise change is NOT a regression — drop it so a single noisy
    // trial flip can't trip exit-1. When EITHER run is single-shot we have no
    // distribution to test, so fall back to today's behaviour: emit the flip,
    // tagged `point-estimate` (back-compat — legacy snapshots on disk).
    let method = 'point-estimate';
    if (hasPresence(cell.wasPresence ? { presence: cell.wasPresence } : null)
        && hasPresence(cell.nowPresence ? { presence: cell.nowPresence } : null)) {
      const verdict = classifyProportionChange(
        { hits: cell.wasPresence.hits, n: cell.wasPresence.n },
        { hits: cell.nowPresence.hits, n: cell.nowPresence.n },
      );
      if (verdict.classification === 'noise') continue;  // statistically indistinguishable — not a change
      method = 'distribution';
    }

    cellChanges.push({
      provider: cell.provider,
      query: cell.query,
      was: cell.was,
      now: cell.now,
      mixedMethod: cell.wasSource !== cell.nowSource,
      method,
    });
  }

  // Competitor movements
  const aComps = listMap(summaryA.topCompetitors);
  const bComps = listMap(summaryB.topCompetitors);

  const newCompetitors = [];
  const lostCompetitors = [];
  for (const [name, count] of bComps) {
    if (!aComps.has(name)) newCompetitors.push({ name, count });
  }
  for (const [name, count] of aComps) {
    if (!bComps.has(name)) lostCompetitors.push({ name, count });
  }

  // Canonical sources movement
  const aSrc = listMap(summaryA.topCanonicalSources, 'url');
  const bSrc = listMap(summaryB.topCanonicalSources, 'url');

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
    cellChanges,
    newCompetitors,
    lostCompetitors,
    sourcesMovement: { gained: sourcesGained, lost: sourcesLost },
  };
}
