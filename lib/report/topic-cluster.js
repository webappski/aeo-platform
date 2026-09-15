/**
 * Topic clustering for queries — group similar queries by shared keywords so
 * the report can show "topic-level visibility" instead of just "query-level".
 *
 * Inspired by Surfer's "Topical Map" and Knowatoa's "compounding proof"
 * framing: AEO works at the cluster level, not the keyword level. Five
 * queries about CRM all need the same publisher relationships.
 *
 * Pure rule-based, zero LLM:
 *   - tokenise each query into lowercase content words
 *   - drop English stopwords
 *   - bucket queries by their most distinctive shared content word
 *   - any single-query bucket falls back to "uncategorised"
 *
 * Returns:
 *   [{ topic, queries: [{ id, text }], rate, hits, total }]
 * sorted by total descending.
 */

import { sliceStats } from '../score.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'in', 'on', 'at', 'to',
  'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'best', 'top', 'free', 'how', 'what', 'which', 'why', 'when', 'where',
  'good', 'better', 'great', 'cheap', 'small', 'large', 'big', 'new',
  'do', 'does', 'did', 'i', 'you', 'we', 'they', 'me', 'us', 'them',
  'my', 'your', 'our', 'their', 'his', 'her', 'its',
  'tools', 'tool', 'service', 'services', 'app', 'apps', 'platform', 'platforms',
  'software', 'website', 'sites', 'site', 'product', 'products',
  'vs', 'versus', 'compare', 'comparison',
  '2024', '2025', '2026', '2027',
]);

function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length >= 3)
    .filter(w => !STOPWORDS.has(w));
}

/**
 * Cluster queries by their top shared content word.
 * Each query is assigned to its most-frequent token across all queries (so
 * shared words get prioritised). Queries whose top token is unique fall
 * into "uncategorised".
 */
export function clusterQueries(latest) {
  const queryOrder = [];
  const seen = new Set();
  for (const r of latest?.results || []) {
    if (!seen.has(r.query)) {
      seen.add(r.query);
      queryOrder.push({ id: r.query, text: r.queryText || r.query });
    }
  }
  if (queryOrder.length === 0) return [];

  // Token frequency across the whole query set
  const tokenFreq = new Map();
  const tokensByQ = new Map();
  for (const q of queryOrder) {
    const toks = tokenise(q.text);
    tokensByQ.set(q.id, toks);
    for (const t of toks) tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
  }

  // Assign each query to its highest-frequency token (ties → first by length)
  const buckets = new Map();
  for (const q of queryOrder) {
    const toks = tokensByQ.get(q.id) || [];
    let bestToken = null;
    let bestFreq = 0;
    for (const t of toks) {
      const f = tokenFreq.get(t) || 0;
      if (f > bestFreq || (f === bestFreq && bestToken && t.length > bestToken.length)) {
        bestToken = t; bestFreq = f;
      }
    }
    const topic = (bestToken && bestFreq >= 2) ? bestToken : 'uncategorised';
    if (!buckets.has(topic)) buckets.set(topic, []);
    buckets.get(topic).push(q);
  }

  // Visibility per bucket — count cells where the user's brand was mentioned
  // for any query in the bucket
  const results = latest?.results || [];
  const out = [];
  for (const [topic, queries] of buckets) {
    const queryIds = new Set(queries.map(q => q.id));
    const cells = results.filter(r => queryIds.has(r.query));
    // ONE denominator (lib/score.js): valid trials, never cells, never attempts.
    const st = sliceStats(cells);
    out.push({
      topic,
      queries,
      hits: st.hits,
      total: st.valid,
      rate: st.rate,
    });
  }

  return out.sort((a, b) => b.total - a.total);
}
