// The metric set both report surfaces read.
//
// The HTML report and the markdown report state the same findings in different
// registers. If each derived its own numbers they would eventually disagree —
// the classic failure where the PDF says "down one answer" and the markdown
// says "down two" because one of them counted citations-only differently.
// Every figure either surface quotes about movement comes from here.

import { buildMetric, whereToAct } from './trend-model.js';
import { VERDICT } from './answer-history.js';

/**
 * Answers where the brand appears at all: named in the prose, or cited as a
 * source. This is the same population the index's Presence axis counts, which
 * is why the two never disagree about "one answer was lost".
 * @param {{results?: Array<{mention?: string}>}} snapshot
 * @returns {number}
 */
export function presenceCount(snapshot) {
  return (snapshot?.results || []).filter(r => r.mention === 'yes' || r.mention === 'src').length;
}

/**
 * Engines whose every answer this run mentions the brand.
 * @param {{results?: Array<{provider?: string, mention?: string}>}} snapshot
 * @returns {{full: number, total: number}}
 */
export function enginesFullyCovering(snapshot) {
  const per = new Map();
  for (const r of snapshot?.results || []) {
    const e = per.get(r.provider) || { total: 0, hit: 0 };
    e.total++;
    if (r.mention === 'yes' || r.mention === 'src') e.hit++;
    per.set(r.provider, e);
  }
  return { full: [...per.values()].filter(e => e.hit === e.total).length, total: per.size };
}

/**
 * Citations pointing at the brand's own domain.
 * @param {{results?: Array<{canonicalCitations?: Array<string>}>}} snapshot
 * @param {string} domain
 * @returns {number|null} null when no domain is configured.
 */
export function ownCitationCount(snapshot, domain) {
  const own = String(domain || '').replace(/^www\./, '').toLowerCase();
  if (!own) return null;
  let n = 0;
  for (const r of snapshot?.results || []) {
    for (const u of r.canonicalCitations || []) {
      try { if (hostOf(u) === own) n++; } catch { /* unparseable URL */ }
    }
  }
  return n;
}

/**
 * Every citation the engines emitted this run, across all hosts.
 *
 * NOT the same thing as `summary.totalCitations`, which counts only the
 * citations pointing at the brand's OWN domain. Using that field as the
 * denominator for a share makes the brand's own share read as 100%.
 * @param {{results?: Array<{canonicalCitations?: Array<string>}>}} snapshot
 * @returns {number}
 */
export function totalCitationCount(snapshot) {
  return (snapshot?.results || []).reduce((n, r) => n + (r.canonicalCitations || []).length, 0);
}

/**
 * Citations per host, across every answer.
 *
 * Computed from the raw results rather than read off `topDomains`, which is
 * capped at ten entries — a rival sitting at position eleven would look like a
 * host that was never cited at all.
 * @param {{results?: Array<{canonicalCitations?: Array<string>}>}} snapshot
 * @returns {Map<string, number>} Bare hostname -> citation count.
 */
export function hostCitationCounts(snapshot) {
  const counts = new Map();
  for (const r of snapshot?.results || []) {
    for (const u of r.canonicalCitations || []) {
      const h = hostOf(u);
      if (h) counts.set(h, (counts.get(h) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Distinct hosts the engines cited this run.
 * @param {{results?: Array<{canonicalCitations?: Array<string>}>}} snapshot
 * @returns {number}
 */
export function hostCount(snapshot) {
  return hostCitationCounts(snapshot).size;
}

/**
 * Homepage answer-capsule coverage, when the page-signals crawl ran.
 * @param {Object} snapshot
 * @returns {number|null}
 */
export function capsuleCoverage(snapshot) {
  const c = snapshot?.pageSignals?.homepage?.answerCapsules;
  return c && Number.isFinite(c.coverage) ? c.coverage : null;
}

/**
 * @param {string} url
 * @returns {string} Bare hostname, or '' when the URL will not parse.
 */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

/**
 * Build every run-level metric, in one place, for both surfaces.
 *
 * @param {{trend?: Array<number>, meta?: {domain?: string}}} summary
 * @param {Array<Object>} snapshots Ordered oldest -> newest.
 * @returns {{index: Object, presence: Object, competitors: Object,
 *            ownCitations: Object, hosts: Object, capsules: Object,
 *            engines: {now: {full:number,total:number}, prev: {full:number|null,total:number}},
 *            all: Array<Object>}}
 */
export function buildRunMetrics(summary, snapshots) {
  const snaps = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  const latest = snaps[snaps.length - 1] || null;
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const domain = summary?.meta?.domain || '';

  // The index reads the STORED per-run score — the same series the chart
  // plots. Recomputing an old run's components under today's code answers a
  // different question and would put a different number in each place.
  const index = buildMetric({
    id: 'index', label: 'Visibility index', unit: 'points',
    history: summary?.trend || [], unitLabel: 'points', unitLabelOne: 'point',
  });
  const presence = buildMetric({
    id: 'presence', label: 'Answers naming or citing you', unit: 'count',
    history: snaps.map(presenceCount), unitLabel: 'answers', unitLabelOne: 'answer',
  });
  const competitors = buildMetric({
    id: 'competitors', label: 'Rival tools named', unit: 'count',
    history: snaps.map(s => (s.topCompetitors || []).length),
    unitLabel: 'tools', unitLabelOne: 'tool',
    // More rivals named alongside you is not an improvement.
    higherIsBetter: false,
  });
  const ownCitations = buildMetric({
    id: 'own-citations', label: 'Citations to your own pages', unit: 'count',
    history: snaps.map(s => ownCitationCount(s, domain)),
    unitLabel: 'citations', unitLabelOne: 'citation',
  });
  const hosts = buildMetric({
    id: 'hosts', label: 'Hosts cited', unit: 'count',
    history: snaps.map(hostCount), unitLabel: 'hosts', unitLabelOne: 'host',
  });
  const capsules = buildMetric({
    id: 'capsules', label: 'Answer-capsule coverage', unit: 'points',
    history: snaps.map(capsuleCoverage), unitLabel: 'pp',
  });

  return {
    index, presence, competitors, ownCitations, hosts, capsules,
    engines: {
      now: enginesFullyCovering(latest),
      prev: prev ? enginesFullyCovering(prev) : { full: null, total: 0 },
    },
    all: [index, presence, competitors, ownCitations, hosts, capsules],
  };
}

/**
 * The report-level "where to act" line, restricted to the metrics that make up
 * the headline index. Ranking every section's metric against each other here
 * would let an incidental count out-shout the reason the score moved.
 *
 * @param {{index: Object, presence: Object}} metrics From buildRunMetrics().
 * @param {Array<Object>} axisMetrics The reportable index axes, may be empty.
 * @param {string|null} prevDate
 * @returns {{text: string, metric: Object|null}}
 */
export function headlineMover(metrics, axisMetrics, prevDate) {
  return whereToAct([...(axisMetrics || []), metrics.index, metrics.presence], prevDate);
}

/**
 * Engine name as the verdict states it: the label with any parenthetical model
 * suffix removed ("Gemini (gemini-3.1-flash)" -> "Gemini").
 * @param {{label?: string, provider?: string}|null|undefined} cell
 * @returns {string|null}
 */
export function engineNameOf(cell) {
  if (!cell) return null;
  const raw = String(cell.label || cell.provider || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  return raw || null;
}

/**
 * The run's headline verdict, as ORDERED SEGMENTS rather than a finished
 * string.
 *
 * Both surfaces state the same conclusion in different markup: the HTML report
 * wraps one clause in `<em>`, the markdown report has no emphasis to give. When
 * each surface owned its own copy of the branching, the two drifted by
 * construction — the same failure `buildRunMetrics` exists to prevent for the
 * NUMBERS, repeated for the WORDING. The branch decisions live here once; each
 * renderer only decides how a segment looks.
 *
 * @param {{index: Object, changedCell: Object|null, fallbackScore?: number|null}} spec
 *   `index` is `buildRunMetrics().index`; `changedCell` is `headlineCell()`'s
 *   pick, or null when nothing changed hands.
 * @returns {{kind: 'baseline'|'lost'|'gained'|'held', direction: 'up'|'down'|'flat'|null,
 *            points: number|null, current: number|null, engine: string|null,
 *            segments: Array<{text: string, emphasis: boolean}>}}
 */
export function buildVerdictHeadline(spec) {
  const idx = spec?.index || {};
  const changedCell = spec?.changedCell || null;
  const current = idx.current ?? spec?.fallbackScore ?? null;
  const engine = engineNameOf(changedCell);

  // Run 1: there is nothing to have changed from, so the headline states the
  // score rather than a movement.
  if (idx.deltaPrev == null) {
    return {
      kind: 'baseline', direction: null, points: null, current, engine: null,
      segments: [
        { text: `${current} of 100 on the first run. `, emphasis: false },
        { text: 'This is the baseline.', emphasis: true },
      ],
    };
  }

  const d = idx.deltaPrev;
  const direction = d < 0 ? 'down' : d > 0 ? 'up' : 'flat';
  const points = Math.abs(d);
  const magnitude = d === 0
    ? `Holding at ${current}`
    : `${d < 0 ? 'Down' : 'Up'} ${points} point${points === 1 ? '' : 's'}`;

  // The index and the per-answer record can disagree — the score can rise in
  // the same run an engine drops you. "Up 9 points. X dropped an answer."
  // reads as a contradiction; the joining word carries which of the two it is.
  const verdict = changedCell ? changedCell.verdict : null;
  if (engine && verdict === VERDICT.LOST) {
    return {
      kind: 'lost', direction, points, current, engine,
      segments: [
        { text: magnitude, emphasis: false },
        { text: d > 0 ? ' overall — but ' : '. ', emphasis: false },
        { text: `${engine} dropped an answer it had `, emphasis: false },
        { text: 'held before', emphasis: true },
        { text: '.', emphasis: false },
      ],
    };
  }
  if (engine && verdict === VERDICT.GAINED) {
    return {
      kind: 'gained', direction, points, current, engine,
      segments: [
        { text: magnitude, emphasis: false },
        { text: d < 0 ? ' overall — but ' : '. ', emphasis: false },
        { text: `${engine} started naming you where it `, emphasis: false },
        { text: 'did not before', emphasis: true },
        { text: '.', emphasis: false },
      ],
    };
  }
  return {
    kind: 'held', direction, points, current, engine: null,
    segments: [
      { text: magnitude, emphasis: false },
      { text: '. ', emphasis: false },
      { text: 'Every answer held its ground.', emphasis: true },
    ],
  };
}

/**
 * The run's aggregate lift opportunity: answers where an engine reached the
 * brand's own domain and cited it as a source, but did not name the brand in
 * the answer text.
 *
 * This is a CLIENT-FACING aggregate, not a per-cell state. The per-answer rows
 * already carry a "Cited, not named" pill each; without the roll-up the report
 * states the condition N times and its size zero times, and the reader has to
 * count pills to learn how big the opportunity is.
 *
 * Buckets are derived from `snapshot.results` and reproduce the coverage
 * buckets `bin/aeo-tracker.js` writes into `summary.coverage` (see the
 * `latest.results.reduce` there) exactly — same field, same order of tests. The
 * derivation lives here rather than reading `summary.coverage` because the
 * markdown surface's run verdict is given snapshots only, and a figure read
 * from two different places is the drift this module exists to prevent.
 *
 * @param {{results?: Array<{mention?: string}>}} snapshot
 * @returns {{named: number, cited: number, absent: number, errored: number,
 *            total: number, kind: 'lift'|'clean'|'unseen'}}
 */
export function buildLiftOpportunity(snapshot) {
  const results = snapshot?.results || [];
  let named = 0, cited = 0, absent = 0, errored = 0;
  for (const r of results) {
    if (r.mention === 'yes') named++;
    else if (r.mention === 'src') cited++;
    else if (r.mention === 'error') errored++;
    else absent++;
  }
  // Three genuinely different situations, and they must not be collapsed:
  //   lift   — citations exist that have not converted into a naming yet;
  //   clean  — every answer that cites the domain also names the brand;
  //   unseen — the domain is not in the source pool at all, so there is no
  //            citation to lift and the gap is upstream of this metric.
  const kind = cited > 0 ? 'lift' : named > 0 ? 'clean' : 'unseen';
  return { named, cited, absent, errored, total: results.length, kind };
}

/**
 * The lift note in two halves, decided ONCE for both report surfaces.
 *
 * `stat` states what the aggregate counts — measured fact, and the only half a
 * white-label snapshot may carry (it ships under the legend of a statistics
 * tool the client ran themselves). `advisory` is the consulting sentence that
 * says what to do about the figure; it belongs to the internal / default
 * report only.
 *
 * Both surfaces compose from here rather than each carrying its own copy: the
 * HTML hero KPI and the markdown run verdict were printing the same sentence
 * from two files, which is exactly the drift this module exists to prevent
 * (same contract as `buildVerdictHeadline` on the headline). The split is a
 * plain sentence boundary, so `${stat} ${advisory}` reproduces the sentence
 * the HTML hero has always rendered, character for character.
 *
 * @param {{cited?: number, total?: number, kind?: 'lift'|'clean'|'unseen'}} lift
 *        the value returned by `buildLiftOpportunity`
 * @returns {{stat: string, advisory: string}}
 */
export function buildLiftNarrative(lift) {
  const cited = Number.isFinite(lift?.cited) ? lift.cited : 0;
  const total = Number.isFinite(lift?.total) ? lift.total : 0;
  if (lift?.kind === 'lift') {
    return {
      stat: `${cited} of ${total} answer${total === 1 ? '' : 's'} cite${cited === 1 ? 's' : ''} your domain as a source without naming you in the answer text.`,
      advisory: `Those pages are already inside the engine's source pool — the shortest lift on this report is being named in the answer itself, not only linked beneath it.`,
    };
  }
  if (lift?.kind === 'clean') {
    return {
      stat: `Every answer that cites your domain also names you in the text.`,
      advisory: `Nothing is stranded as a bare source link this run — that is the success state, not a gap.`,
    };
  }
  return {
    stat: `No answer cites your domain at all this run, so there is no citation here to lift.`,
    advisory: `The gap is upstream of this figure: your pages are not yet in the engines' source pool.`,
  };
}
