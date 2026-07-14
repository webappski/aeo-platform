#!/usr/bin/env node
// Maintainer drift-checker for lib/providers/pricing.js — NOT a runtime path.
//
// Why this exists: our curated pricing table is the single source of truth
// (zero-dep, self-contained, honest). Its one weakness is silent staleness — a
// provider raises a price and our number lingers. This script surfaces that by
// diffing our table against a machine-readable community feed (simonw/llm-prices)
// and WARNING on drift. It never rewrites pricing.js — correctness stays human-
// owned; this only tells a maintainer where to look. Run before a release / in CI.
//
// Advisory by design: any network/parse/schema problem degrades to a clear
// "could not verify" instead of failing hard, so a feed outage never blocks a
// release. Exit codes:
//   0 — checked, no drift (or nothing to verify but feed reachable)
//   1 — drift found (our price disagrees with the feed beyond tolerance, OR a
//        shipped default model is missing from our table)
//   2 — could not verify (feed unreachable / unparseable for every vendor)
//
// Feed: https://github.com/simonw/llm-prices  (data/<vendor>.json, per-1M USD).
// Schema: { vendor, models: [{ id, name, price_history: [{ input, output, … }] }] }.

import { pricingRows, findPricingPrefix } from '../lib/providers/pricing.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { FALLBACK } from '../lib/providers/discover.js';

const FEED_BASE = 'https://raw.githubusercontent.com/simonw/llm-prices/main/data';
// our provider key → feed vendor file basename
const VENDOR_FILE = { openai: 'openai', anthropic: 'anthropic', gemini: 'google', perplexity: 'perplexity' };
const TOLERANCE = 0.001;      // USD/1M — flag differences larger than this
const FETCH_TIMEOUT_MS = 8000;

// Rows where OUR value is verified-correct but the FEED is stale/wrong. Keyed by
// pricing prefix → reason. These are reported as advisory (feed lag), NOT counted
// as drift, so exit-1 stays meaningful (= a NEW unexplained divergence). Prune an
// entry once the feed catches up.
const KNOWN_FEED_STALE = {
  'claude-opus': 'feed lists retired Opus 4 ($15/$75); official Opus 4.8 = $5/$25 (verified 2026-07-13)',
};

// Classify one of our pricing-table prefixes to a provider key (for vendor-file
// routing). Mirrors how the runtime picks a provider from a model id.
function providerOfModel(id) {
  if (/^(gpt-|o\d|chatgpt)/i.test(id)) return 'openai';
  if (/^claude/i.test(id)) return 'anthropic';
  if (/^gemini/i.test(id)) return 'gemini';
  if (/^sonar/i.test(id)) return 'perplexity';
  return null;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (err?.message || String(err)) };
  } finally {
    clearTimeout(t);
  }
}

// Build { modelId → { input, output } } from a feed vendor file, using the
// CURRENT price (the history entry with to_date === null, else the last one).
function indexFeed(feed) {
  const out = new Map();
  for (const m of feed?.models || []) {
    const hist = Array.isArray(m.price_history) ? m.price_history : [];
    if (!hist.length || !m.id) continue;
    const current = hist.find(h => h.to_date == null) || hist[hist.length - 1];
    if (typeof current?.input === 'number' && typeof current?.output === 'number') {
      out.set(m.id, { input: current.input, output: current.output });
    }
  }
  return out;
}

// Best feed match for one of our prefixes. A feed model only counts if OUR table
// would actually price it with THIS row (findPricingPrefix(id) === prefix) — this
// avoids comparing e.g. our 'gemini-3.1-flash' row against a feed
// 'gemini-3.1-flash-lite-preview', which our table routes to the -lite row.
// Among qualifying ids, prefer the exact canonical id, else the shortest.
function matchFeed(prefix, feedIndex) {
  let best = null;
  for (const [id, price] of feedIndex) {
    if (findPricingPrefix(id) !== prefix) continue;
    if (id === prefix) return { id, ...price };
    if (!best || id.length < best.id.length) best = { id, ...price };
  }
  return best;
}

function fmt(n) { return `$${Number(n).toFixed(2)}`; }

async function main() {
  const rows = pricingRows();
  const providers = [...new Set(rows.map(r => providerOfModel(r.prefix)).filter(Boolean))];

  // Fetch each needed vendor file once.
  const feeds = new Map();          // provider → indexed feed
  const feedErrors = [];
  await Promise.all(providers.map(async (prov) => {
    const file = VENDOR_FILE[prov];
    if (!file) return;
    const { data, error } = await fetchJson(`${FEED_BASE}/${file}.json`);
    if (error) { feedErrors.push(`${prov} (${file}.json): ${error}`); return; }
    feeds.set(prov, indexFeed(data));
  }));

  if (feeds.size === 0) {
    console.error('pricing-check: could not verify — feed unreachable for every vendor:');
    for (const e of feedErrors) console.error(`  - ${e}`);
    return 2;
  }

  const drift = [];       // our price disagrees with the feed (real, needs review)
  const knownStale = [];  // feed disagrees but OUR value is verified-correct
  const unverified = [];  // no feed entry to compare against
  for (const row of rows) {
    const prov = providerOfModel(row.prefix);
    const feedIndex = prov && feeds.get(prov);
    if (!feedIndex) { unverified.push(`${row.prefix} (no feed for ${prov ?? 'unknown provider'})`); continue; }
    const match = matchFeed(row.prefix, feedIndex);
    if (!match) { unverified.push(`${row.prefix} (not found in feed)`); continue; }
    const dIn = Math.abs(match.input - row.inputPer1M);
    const dOut = Math.abs(match.output - row.outputPer1M);
    if (dIn > TOLERANCE || dOut > TOLERANCE) {
      const line =
        `${row.prefix.padEnd(24)} ours ${fmt(row.inputPer1M)}/${fmt(row.outputPer1M)}  ` +
        `feed[${match.id}] ${fmt(match.input)}/${fmt(match.output)}`;
      if (KNOWN_FEED_STALE[row.prefix]) knownStale.push(`${line}  — ${KNOWN_FEED_STALE[row.prefix]}`);
      else drift.push(line);
    }
  }

  // Every shipped default/fallback model must be priced (mirrors the guard test,
  // but also reported here so a pricing sweep flags it in one place).
  const defaults = new Set();
  for (const p of Object.values(DEFAULT_CONFIG.providers)) { defaults.add(p.model); defaults.add(p.classifyModel); }
  for (const f of Object.values(FALLBACK)) { defaults.add(f.main); defaults.add(f.classify); }
  const unpriced = [...defaults].filter(Boolean).filter(m => findPricingPrefix(m) == null);

  // ── Report ──
  console.log(`pricing-check — table vs simonw/llm-prices (verified ${feeds.size}/${providers.length} vendors)\n`);
  if (feedErrors.length) {
    console.log('Feeds not reachable (skipped, advisory):');
    for (const e of feedErrors) console.log(`  ~ ${e}`);
    console.log('');
  }
  if (unpriced.length) {
    console.log('✗ SHIPPED DEFAULT WITH NO PRICING ROW (would show "cost not tracked"):');
    for (const m of unpriced) console.log(`  - ${m}`);
    console.log('');
  }
  if (drift.length) {
    console.log('✗ PRICE DRIFT (our table disagrees with the feed — review + update pricing.js):');
    for (const d of drift) console.log(`  - ${d}`);
    console.log('');
  }
  if (knownStale.length) {
    console.log('~ Feed disagrees but OUR value is verified-correct (feed lag, not counted as drift):');
    for (const k of knownStale) console.log(`  ~ ${k}`);
    console.log('');
  }
  if (unverified.length) {
    console.log('~ Not verified against the feed (advisory — feed may name it differently):');
    for (const u of unverified) console.log(`  - ${u}`);
    console.log('');
  }
  if (!drift.length && !unpriced.length) {
    console.log('✓ No drift: every priced row within tolerance and every default is covered.');
  }

  return drift.length || unpriced.length ? 1 : 0;
}

// Set exitCode and let the event loop drain naturally — calling process.exit()
// while fetch/AbortController handles are still closing crashes libuv on Windows
// (UV_HANDLE_CLOSING assertion).
main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(`pricing-check crashed: ${err?.stack || err}`); process.exitCode = 2; });
