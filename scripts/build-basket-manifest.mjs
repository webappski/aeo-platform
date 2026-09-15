#!/usr/bin/env node
/**
 * Stamp a basket manifest (and, optionally, a primed validation cache) into an
 * `.aeo-tracker.json`.
 *
 * MEAS-1. Three things go into the config, all of them data the tool can then
 * look up instead of re-deriving:
 *
 *   basketManifest.queries[] — one entry per question: a stable id (hash of the
 *       normalised text), the text, and the DECLARED market. The id is what
 *       `lib/diff.js` compares on, so that two runs line up by question and not
 *       by array position.
 *   basketManifest.runRoot   — the one directory this basket is run from. The
 *       tool warns when you run it somewhere else; nothing is moved or deleted.
 *   validationCache          — a verdict per question, so `run` does not send
 *       the whole basket back through a non-deterministic classifier on every
 *       run and cannot be aborted by it mid-flight.
 *
 * On markets, the one thing this script will not do is invent them.
 *   --market-from-language derives an assignment from the question's language
 *   and then REFUSES to write it unless it reproduces `--expect-ratio` exactly.
 *   The ratio is the thing a human declared (for the webappski basket, in the
 *   `basketHistory` v4 note: PL 35 / DE 5 / EN 5 / RU 5); the per-question
 *   assignment is derived, and the agreement between the two is the evidence
 *   that the derivation matches what was meant. Disagreement is an error, not
 *   a nudge — fix the input or declare the markets by hand.
 *   Without the flag, markets come only from `{ q, market }` entries.
 *
 * Usage:
 *   node scripts/build-basket-manifest.mjs <config.json> [options]
 *     --out <path>           write here instead of in place (default: stdout diff summary only)
 *     --write                write back to <config.json>
 *     --run-root <dir>       canonical run directory (absolute)
 *     --market-from-language derive per-question markets from the question's language
 *     --expect-ratio PL=35,DE=5,EN=5,RU=5   required when deriving markets
 *     --prime-cache <reason> prime validationCache for every basket question, with this provenance
 *     --validated-at <iso>   evidence date recorded on primed cache entries
 *                            (the manifest's own generatedAt is always today)
 *
 * Never calls an engine, never spends money, never deletes anything.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildManifest, queryIdFor } from '../lib/basket-manifest.js';
import { normalizeQueries } from '../lib/config/queries-normalize.js';

// ── Language → market derivation (used only under --market-from-language) ────
// Deliberately crude and readable: this runs ONCE, its output is checked
// against a declared ratio, and a human reads the 50 lines it prints before the
// result becomes a "declared" field.
const CYRILLIC = /[\u0400-\u04FF]/;
const PL_DIACRITICS = /[ąćęłńóśźż]/i;
const DE_DIACRITICS = /[äöüß]/i;
const PL_WORDS = /\b(najlepsze|najlepsi|najlepszych|agencja|agencje|agencji|ranking|doradztwo|ile kosztuje|w polsce|widoczno|optymalizacj|promocj|wyszukiwarki|firmy|uslugi|usługi)/i;
const DE_WORDS = /\b(kostenlos\w*|agentur\w*|sichtbarkeit\w*|ki-|künstliche|für|beste\b|unternehmen)/i;

function marketFromLanguage(text) {
  if (CYRILLIC.test(text)) return 'RU';
  if (PL_DIACRITICS.test(text) || PL_WORDS.test(text)) return 'PL';
  if (DE_DIACRITICS.test(text) || DE_WORDS.test(text)) return 'DE';
  return 'EN';
}

function parseRatio(spec) {
  const out = {};
  for (const part of String(spec).split(',')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    out[k.trim().toUpperCase()] = Number(v);
  }
  return out;
}

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const configPath = argv[0];
if (!configPath || configPath.startsWith('--')) {
  console.error('Usage: node scripts/build-basket-manifest.mjs <config.json> [--write|--out <path>] [--run-root <dir>] [--market-from-language --expect-ratio PL=35,...] [--prime-cache <reason>]');
  process.exit(1);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null;
};

const outPath = flag('--out');
const writeBack = argv.includes('--write');
const runRoot = flag('--run-root');
const deriveMarkets = argv.includes('--market-from-language');
const expectRatio = flag('--expect-ratio');
const primeReason = flag('--prime-cache');
// Two different dates, deliberately not conflated:
//   validatedAt — when the verdict being cached was EVIDENCED (e.g. the run
//                 that proved the gate accepted these questions);
//   generatedAt — when this manifest was built (today).
const validatedAt = flag('--validated-at') || new Date().toISOString();
const generatedAt = new Date().toISOString().slice(0, 10);

const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const { texts } = normalizeQueries(config.queries);
if (texts.length === 0) {
  console.error(`No queries in ${configPath}`);
  process.exit(1);
}

// ── markets ─────────────────────────────────────────────────────────────────
let markets = {};
let marketProvenance = null;
if (deriveMarkets) {
  if (!expectRatio || expectRatio === true) {
    console.error('--market-from-language requires --expect-ratio (the ratio a human declared). Refusing to invent markets.');
    process.exit(1);
  }
  const expected = parseRatio(expectRatio);
  const counts = {};
  for (const t of texts) {
    const m = marketFromLanguage(t);
    markets[t] = m;
    counts[m] = (counts[m] || 0) + 1;
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(counts)])].sort();
  const mismatch = keys.filter(k => (expected[k] || 0) !== (counts[k] || 0));
  console.log('Derived market assignment:');
  for (const k of keys) console.log(`  ${k}: derived ${counts[k] || 0} · declared ${expected[k] || 0}`);
  if (mismatch.length > 0) {
    console.error(`\nThe derived assignment does NOT reproduce the declared ratio (${mismatch.join(', ')}).`);
    console.error('Refusing to write a "declared" market that nobody declared. Fix the rules or declare markets per question.');
    process.exit(1);
  }
  for (const t of texts) console.log(`  [${markets[t]}] ${t}`);
  marketProvenance = `ratio declared in basketHistory v${config.basketVersion ?? '?'}; per-question assignment derived from the question's language on ${generatedAt} and verified to reproduce ${expectRatio} exactly`;
}

const manifest = buildManifest(config.queries, {
  version: config.basketVersion,
  runRoot: typeof runRoot === 'string' ? runRoot : (config.basketManifest?.runRoot || null),
  generatedAt,
  marketProvenance: marketProvenance || config.basketManifest?.marketProvenance || null,
  markets,
});

// ── validation cache priming ────────────────────────────────────────────────
let validationCache = config.validationCache || [];
if (primeReason) {
  if (primeReason === true) {
    console.error('--prime-cache needs a reason string (the provenance of the verdict).');
    process.exit(1);
  }
  const existing = new Map(validationCache.filter(e => e && e.query).map(e => [e.query, e]));
  validationCache = texts.map(q => existing.get(q) || {
    query: q,
    valid: true,
    // No `confidence` field: none was ever recorded for these, and a number
    // invented here would be indistinguishable from a measured one.
    alternate_meanings: [],
    dominant_interpretation: '',
    search_behavior: 'retrieval-triggered',
    reason: primeReason,
    validatedAt,
  });
}

const next = { ...config, basketManifest: manifest, validationCache };

console.log(`\nBasket: ${texts.length} questions · manifest entries ${manifest.queries.length} · validationCache ${validationCache.length}`);
console.log(`Sample id: ${queryIdFor(texts[0])} → ${texts[0]}`);

if (writeBack) {
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Written in place: ${configPath}`);
} else if (typeof outPath === 'string') {
  writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Written: ${outPath}`);
} else {
  console.log('(dry run — pass --write or --out <path> to persist)');
}
