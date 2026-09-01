#!/usr/bin/env node
/**
 * research-dataset.mjs — aggregate every OWN-BRAND tracker run on this machine
 * into one reproducible research dataset (JSON + a human summary).
 *
 * Why this exists: the runs we have already paid for are a dataset nobody has
 * ever read as a whole. Each `_summary.json` answers "how visible were we on
 * that day"; read together they answer a different, publishable question —
 * "when an answer engine is asked about our category, WHOSE domains and WHOSE
 * brands does it name?". That is original research on first-party data, and it
 * is the input to the monthly research hub. Written to be re-run every month
 * with no hand-editing: point it at a root, it rescans and re-derives.
 *
 * ── Hard invariants (read before changing anything) ─────────────────────────
 *
 * 1. CLIENT DATA IS NEVER INCLUDED. The gate is an ALLOW-LIST of our own
 *    domains (`OWN_DOMAINS`), never a deny-list of known clients: a client
 *    onboarded next month must be excluded by default, without anyone
 *    remembering to add them. Every excluded domain is printed with its run and
 *    observation count, so the allow-list audits itself — an own domain missing
 *    from the list shows up in the exclusion table instead of silently
 *    vanishing.
 *
 * 2. THIS IS A CROSS-SECTION, NOT A TIME SERIES. No trend, no growth, no
 *    "change since". The instrument drifted underneath the data: 14 distinct
 *    provider:model combinations, a query grid that was rewritten more than
 *    once (a `query` id of "Q3" means a different question in different runs),
 *    and two engines that are partly hand-pasted rather than API-called. Any
 *    delta computed across those runs would measure our own tooling changes.
 *    `instrumentDrift` in the output states those limits so a consumer of the
 *    JSON cannot miss them.
 *
 * 3. ZERO COST. Local file reads only. No network, no API, no LLM. Every
 *    classification here is a rule table you can read in this file.
 *
 * Usage:
 *   node bin/research-dataset.mjs [--root <dir>] [--out <file>] [--top <n>]
 *                                 [--slice <all|pl|de|ru|en>] [--json]
 * Examples:
 *   node bin/research-dataset.mjs
 *   node bin/research-dataset.mjs --root ~/Projects --slice pl --top 30
 *   node bin/research-dataset.mjs --out /tmp/dataset.json --json
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { categorizeDomain } from '../lib/report/domain-category.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

// ───────────────────────────────────────────────────────────────────────────
// 1. Scope — what counts as "ours"
// ───────────────────────────────────────────────────────────────────────────

/**
 * The allow-list. A run is ours when its `domain` is here. `webappski.com`
 * covers both the agency's own basket AND the aeo-platform product basket —
 * the product measures its own ICP under the agency domain, so brand alone
 * cannot separate them and domain is the stable key.
 */
export const OWN_DOMAINS = new Set([
  'webappski.com',
  'typelessform.com',
  'typelessity.com',
]);

/** Directories that never hold real measurements (fixtures, deps, test data). */
const SKIP_DIRS = new Set([
  'node_modules', 'fixtures', '__tests__', '.git', 'dist', 'build', 'coverage', '.next',
]);

/**
 * Engine-coverage floor for quoting an engine inside a slice.
 *
 * Why 30 observations / 8 distinct questions: our ICP baskets run 9–12 queries
 * per pass, so 30 observations is roughly three complete passes and 8 distinct
 * questions is most of one grid. Below either line a single run — or a single
 * question — dominates that engine's column, and "we checked engine X" stops
 * being a statement about the engine and becomes a statement about one
 * afternoon. This is a PUBLISHING guard, not a statistical test: it does not
 * make N=31 significant, it only makes N=6 impossible to quote by accident.
 */
const MIN_ENGINE_OBS = 30;
const MIN_ENGINE_QUERIES = 8;

// ───────────────────────────────────────────────────────────────────────────
// 2. Language + market detection (two axes, deliberately separate)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Language is what the question was ASKED IN. Market is what the question is
 * ABOUT. They are not the same axis and conflating them silently changes the
 * meaning of a "Polish slice": `AEO consultants Poland` is an English-language
 * question about the Polish market, and `najlepsze agencje AEO 2026` is a
 * Polish-language question with no geographic token at all. Both belong in a
 * Polish issue; a reader deserves to know which is which, so the output reports
 * `langOnly` / `marketOnly` / `both` separately.
 *
 * Deliberately NOT derived from the runs' own `regionContext`: that field is
 * inferred from the TLD mix of the citations we are trying to study, so slicing
 * by it would make every finding circular ("Polish queries cite .pl domains"
 * would be true by construction). The query text is upstream of the answer and
 * is the only non-circular key available.
 *
 * Token lists hold only words that do NOT exist in English, so an English
 * question cannot be pulled into the PL or DE bucket by a shared word. (An
 * earlier draft listed `top`, `firm`, `in` and misfiled English questions.)
 */
const RE_CYRILLIC = /[\u0400-\u04FF\u0500-\u052F]/;
const RE_PL_DIACRITIC = /[ąćęłńóśźż]/i;
const RE_DE_DIACRITIC = /[äöüß]/i;
const RE_PL_TOKEN = /\b(agencj\w*|najleps\w*|darmow\w*|narz[eę]dzi\w*|widoczno\w*|konsultanci|specjalista|audyt\w*|doradztwo|wdro[zż]eni\w*|czo[lł]ow\w*|kosztuje|polsce|polski\w*|firmy|dla)\b/i;
const RE_DE_TOKEN = /\b(beste\w*|agentur\w*|f[uü]r|fuer|kostenlos\w*|sichtbarkeit\w*|markensichtbarkeit|deutschland|pr[uü]fung|pruefung|antworten|beratung|berater|suchmaschinen|marken)\b/i;

const RE_MARKET_PL = /\b(polsce|polski\w*|polska|poland|polnisch\w*|tr[oó]jmiasto|gdyni\w*|gda[nń]sk\w*|wroc[lł]aw\w*|warszaw\w*|krak[oó]w\w*)\b/i;
const RE_MARKET_DE = /\b(deutschland|germany|german|deutsche\w*|dach|[oö]sterreich|austria)\b/i;
const RE_MARKET_EU = /\b(europ[aey]\w*|eu)\b/i;

/** @returns {'pl'|'de'|'ru'|'en'|'ambiguous'|'undetermined'} */
export function detectLanguage(queryText) {
  const q = String(queryText || '').trim();
  if (!q) return 'undetermined';
  if (RE_CYRILLIC.test(q)) return 'ru';
  const pl = RE_PL_DIACRITIC.test(q) || RE_PL_TOKEN.test(q);
  const de = RE_DE_DIACRITIC.test(q) || RE_DE_TOKEN.test(q);
  if (pl && de) return 'ambiguous';
  if (pl) return 'pl';
  if (de) return 'de';
  return 'en';
}

/** @returns {'pl'|'de'|'eu'|'none'} — geography named IN the question. */
export function detectMarket(queryText) {
  const q = String(queryText || '').trim();
  if (!q) return 'none';
  if (RE_MARKET_PL.test(q)) return 'pl';
  if (RE_MARKET_DE.test(q)) return 'de';
  if (RE_MARKET_EU.test(q)) return 'eu';
  return 'none';
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Entity canonicalisation — competitor names
// ───────────────────────────────────────────────────────────────────────────

/**
 * The engines spell the same company several ways: "Agencja Whites" and
 * "Whites", "EACTIVE" and "Eactive", "Taka Oto" and "Takaoto". Counting those
 * as separate entities splits a real company's frequency in half and produces
 * an arithmetically wrong public ranking — the first thing a named agency will
 * check. Canonicalisation is a rule table, never an LLM call, so every merge is
 * auditable and the same input always yields the same output.
 *
 * The fold is deliberately CONSERVATIVE. It merges spelling variants of one
 * name (case, diacritics, punctuation, an `Agencja `/`Agentur ` prefix, a legal
 * suffix, a trailing country word, a trailing bare "AI", a domain-style TLD
 * tail). It does NOT merge a vendor with its product ("Semrush" vs "Semrush AI
 * Visibility Toolkit") and it does NOT merge on a shared prefix ("Sembility",
 * "Sempai", "Sempire" and "Semcore" are four different companies). Those
 * survive as separate entities and are listed in `unmergedNearCollisions` so a
 * human can rule on them instead of the script guessing.
 */
const LEGAL_SUFFIX = /\s*(sp\.?\s*z\s*o\.?\s*o\.?|sp\.?\s*j\.?|s\.?\s*a\.?|gmbh|ag|ltd|limited|llc|inc|co\.?)\.?$/i;
const NAME_PREFIX = /^(agencja|agencji|agencje|agentur|agency|the)\s+/i;
const TLD_TAIL = /\.(pl|ai|io|com|dev|eu|de|net|org|co|app|pro|is)$/i;
const COUNTRY_TAIL = /\s+(polska|poland|deutschland|germany|europe|eu|global|international)$/i;
const AI_TAIL = /\s+ai$/i;

/** Strip diacritics so "Widoczność" and "widocznosc" fold together. */
function deaccent(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

/** The merge key. Two names with the same key are treated as one entity. */
export function entityKey(name) {
  let s = String(name || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  s = s.replace(/[.,;:!?]+$/, '');
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(NAME_PREFIX, '').replace(LEGAL_SUFFIX, '').replace(COUNTRY_TAIL, '')
      .replace(TLD_TAIL, '').replace(AI_TAIL, '').trim();
    if (s === before) break;
  }
  // `\p{L}\p{N}` and not `a-z0-9`: an ASCII-only filter deletes every
  // character of a Cyrillic (or Greek, or CJK) name, so all of them fold to the
  // empty string and merge into ONE entity. That is not a cosmetic bug — on the
  // Russian slice it silently fused 15 unrelated agencies into a single
  // 49-mention "leader". Over-merging is the worst failure this file can have,
  // because the output names real companies in public.
  const folded = deaccent(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // A name made only of punctuation/emoji would still fold to '' and pull every
  // other such name in with it — keep it distinct instead.
  return folded || 'raw:' + s.toLowerCase();
}

/**
 * Hosts that must never be used as evidence that two brand names are the same
 * company. The tracker's competitor-pricing lookup falls back to a reference
 * page when it cannot find a vendor site, so three unrelated brands can all
 * carry `en.wikipedia.org` — merging on that would invent a merger.
 */
const NON_OWNED_EVIDENCE_HOSTS = new Set([
  'en.wikipedia.org', 'wikipedia.org', 'linkedin.com', 'youtube.com', 'github.com',
  'medium.com', 'clutch.co', 'g2.com', 'crunchbase.com', 'facebook.com', 'x.com', 'twitter.com',
]);

/**
 * Build the entity index over the whole dataset (not per-slice, so the same
 * company canonicalises identically in every slice).
 *
 * Alias evidence has two independent sources:
 *   (a) the fold above — spelling variants;
 *   (b) `competitorPricing[]`, where the tracker itself recorded a name→domain
 *       mapping. Two names pointing at the same VENDOR-OWNED host are the same
 *       company on the tracker's own evidence, not on our guess. This is what
 *       ties "Whites" to "Agencja Whites" independently of the prefix rule.
 */
export function buildEntityIndex(runs) {
  const keyToNames = new Map();   // key -> Map(originalName -> count)
  const nameToHost = new Map();   // original name -> vendor host (from runs)
  const hostToKeys = new Map();   // vendor host -> Set(key)

  for (const run of runs) {
    for (const c of run.summary.competitorPricing || []) {
      if (!c || !c.name || !c.domain) continue;
      const host = normaliseHost(c.domain);
      if (!host || NON_OWNED_EVIDENCE_HOSTS.has(host)) continue;
      nameToHost.set(String(c.name).trim(), host);
    }
  }

  const note = (name) => {
    const key = entityKey(name);
    if (!key) return;
    if (!keyToNames.has(key)) keyToNames.set(key, new Map());
    const m = keyToNames.get(key);
    m.set(name, (m.get(name) || 0) + 1);
    const host = nameToHost.get(name);
    if (host) {
      if (!hostToKeys.has(host)) hostToKeys.set(host, new Set());
      hostToKeys.get(host).add(key);
    }
  };

  for (const run of runs) {
    for (const o of run.summary.results || []) {
      for (const c of o.competitors || []) note(String(c).trim());
    }
  }

  // Union keys that the tracker's own name→domain evidence puts on one host.
  const parent = new Map();
  const find = (k) => { while (parent.get(k) && parent.get(k) !== k) k = parent.get(k); return k; };
  for (const key of keyToNames.keys()) parent.set(key, key);
  const domainMerges = [];
  for (const [host, keys] of hostToKeys) {
    const list = [...keys];
    for (let i = 1; i < list.length; i++) {
      const a = find(list[0]), b = find(list[i]);
      if (a !== b) { parent.set(b, a); domainMerges.push({ host, merged: [list[0], list[i]] }); }
    }
  }

  // Display name = the spelling the engines used most often (ties: longest,
  // then lexicographic) so the public table shows a real observed string.
  const canonical = new Map();    // key -> { key, display, aliases: [{name,count}] }
  for (const [key, names] of keyToNames) {
    const root = find(key);
    if (!canonical.has(root)) canonical.set(root, { key: root, display: '', aliases: new Map() });
    const bucket = canonical.get(root).aliases;
    for (const [n, c] of names) bucket.set(n, (bucket.get(n) || 0) + c);
  }
  for (const entity of canonical.values()) {
    entity.aliases = [...entity.aliases].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || b.name.length - a.name.length || a.name.localeCompare(b.name));
    entity.display = entity.aliases[0].name;
  }

  const keyOf = (name) => find(entityKey(name));

  // Residual near-collisions the table refused to merge — published so a human
  // rules on them rather than the script quietly deciding.
  const roots = [...canonical.keys()].sort();
  const nearCollisions = [];
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i], b = roots[j];
      // Only a SHORT extra tail is a plausible mis-split ("otterly" vs
      // "otterlyai"); a long tail is visibly a different string (a product
      // line such as "ahrefsbrandradar") and listing every one of those buries
      // the pairs a human actually needs to rule on.
      if (a.length >= 5 && b.startsWith(a) && b.length - a.length <= 12) {
        nearCollisions.push({ shorter: canonical.get(a).display, longer: canonical.get(b).display, reason: 'shared prefix — deliberately NOT merged; confirm they are different companies' });
      }
    }
  }

  return { canonical, keyOf, domainMerges, nearCollisions, vendorHosts: nameToHost };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Domain classification
// ───────────────────────────────────────────────────────────────────────────

/** hostname, lowercased, `www.` and trailing dot removed. '' when unparseable. */
export function normaliseHost(url) {
  if (!url) return '';
  let s = String(url).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch { return ''; }
}

/** Citation URL without tracking parameters or fragment (for page-level counts). */
export function normaliseUrl(url) {
  if (!url) return '';
  let s = String(url).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_cid|mc_eid|ref|source)/i.test(p)) u.searchParams.delete(p);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.toString().replace(/\/$/, '');
  } catch { return ''; }
}

/**
 * Research buckets. Coarser than `lib/report/domain-category.js` on purpose —
 * that table answers "who do I pitch"; this one answers "what KIND of source is
 * an engine leaning on". The base table is reused rather than re-invented; only
 * the three distinctions it cannot make are added on top:
 *   `own`             — our own properties (must never be counted as a neutral source);
 *   `video`           — YouTube is `social` in the base table, but video is its own surface;
 *   `competitor_site` — a domain owned by a company the engines named as a competitor.
 * `competitor_site` is DERIVED, not curated: it comes from the entity index, so
 * next month's new agency is classified without editing this file.
 */
const RESEARCH_BUCKETS = {
  own: 'Own properties',
  competitor_site: 'Competitor / vendor own site',
  directory: 'Directory / marketplace / review platform',
  video: 'Video',
  social_forum: 'Social / forum / Q&A',
  media: 'Media / reference',
  vendor_or_agency_site: 'Other company or agency site',
  docs_code: 'Docs / code host',
  unclassified: 'Unclassified long tail (no rule matched)',
};

/** Hosts the base table does not know, in buckets it cannot infer. */
const RESEARCH_OVERRIDES = new Map(Object.entries({
  // Directories / marketplaces where agencies and tools are listed and ranked.
  'clutch.co': 'directory',
  'goodfirms.co': 'directory',
  'designrush.com': 'directory',
  'sortlist.com': 'directory',
  'sortlist.pl': 'directory',
  'themanifest.com': 'directory',
  'upcity.com': 'directory',
  'expertise.com': 'directory',
  'topseos.com': 'directory',
  'semfirms.com': 'directory',
  'agencies.semrush.com': 'directory',
  'alternativeto.net': 'directory',
  'saashub.com': 'directory',
  'theresanaiforthat.com': 'directory',
  'slashdot.org': 'directory',
  'sourceforge.net': 'directory',
  'aixploria.com': 'directory',
  'futurepedia.io': 'directory',
  // Video.
  'youtube.com': 'video',
  'youtu.be': 'video',
  'vimeo.com': 'video',
  'rutube.ru': 'video',
  'dailymotion.com': 'video',
  // Regional trade media the US/EN base table does not carry.
  'nowymarketing.pl': 'media',
  'wirtualnemedia.pl': 'media',
  'spidersweb.pl': 'media',
  'marketingprzykawie.pl': 'media',
  'socialpress.pl': 'media',
  'bankier.pl': 'media',
  'rp.pl': 'media',
  'businessinsider.com.pl': 'media',
  'vc.ru': 'media',
  'sostav.ru': 'media',
  'dtf.ru': 'media',
  'rb.ru': 'media',
  'cossa.ru': 'media',
  't3n.de': 'media',
  'horizont.net': 'media',
  'onlinemarketing.de': 'media',
  'techradar.com': 'media',
  'zdnet.com': 'media',
  'searchengineland.com': 'media',
}));

/** Map a base-table slug onto a research bucket. */
const BASE_TO_RESEARCH = {
  review: 'directory',
  forum: 'social_forum',
  qna: 'social_forum',
  social: 'social_forum',
  news: 'media',
  reference: 'media',
  'gov-edu': 'media',
  agency: 'vendor_or_agency_site',
  vendor: 'vendor_or_agency_site',
  blog: 'vendor_or_agency_site',
  docs: 'docs_code',
  other: 'unclassified',
};

export function classifyHost(host, ctx) {
  if (!host) return 'unclassified';
  if (ctx.ownHosts.has(host) || [...ctx.ownHosts].some(d => host.endsWith('.' + d))) return 'own';
  if (RESEARCH_OVERRIDES.has(host)) return RESEARCH_OVERRIDES.get(host);
  const apex = host.split('.').slice(-2).join('.');
  if (RESEARCH_OVERRIDES.has(apex)) return RESEARCH_OVERRIDES.get(apex);
  if (ctx.competitorHosts.has(host) || ctx.competitorHosts.has(apex)) return 'competitor_site';
  return BASE_TO_RESEARCH[categorizeDomain(host).slug] || 'unclassified';
}

/** Registrable-ish suffix for the TLD split — mechanical, needs no curation. */
export function tldOf(host) {
  const parts = String(host || '').split('.');
  if (parts.length < 2) return '(none)';
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (['com', 'co', 'net', 'org', 'gov', 'edu', 'ac'].includes(second) && last.length === 2) {
    return `${second}.${last}`;
  }
  return last;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Load + dedupe
// ───────────────────────────────────────────────────────────────────────────

/**
 * Find every `_summary.json` under `root`.
 *
 * Deliberately NOT anchored on a folder named `aeo-responses`: an exploratory
 * pass that globbed `**\/aeo-responses/**` missed 6 files sitting in a folder
 * called `webappka-aeo-responses` and over-counted the corpus by 32%, because
 * those files were byte-identical backups of runs it had already read. Find the
 * files by name, then filter by CONTENT.
 */
export function scanSummaries(root, depth = 0, out = []) {
  if (depth > 12) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scanSummaries(full, depth + 1, out);
    } else if (e.name === '_summary.json') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Markers of a path that is a COPY of a run rather than the run's own home:
 * a session backup tree, a git worktree checkout, an archive folder. Files are
 * read in an order that puts these last, so the ORIGINAL file wins "first seen"
 * and the copy is the one reported as duplicated. Without this the report reads
 * backwards — it accuses `clients/webappski/aeo-responses/2026-07-31/` of being
 * a duplicate of its own backup, because `_session-...` sorts earlier.
 */
const COPY_PATH_MARKERS = [
  'tree-backup-before-move', '_session-', '-backup', 'backup-', '/_backup', '-wt/', '-archive/', '/archive/',
];

function copyRank(file) {
  return COPY_PATH_MARKERS.some(m => file.includes(m)) ? 1 : 0;
}

/** Canonical-first ordering: originals, then shorter paths, then lexicographic. */
function byCanonicalFirst(a, b) {
  return copyRank(a) - copyRank(b) || a.length - b.length || a.localeCompare(b);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Read the corpus, split it into ours / not-ours, and drop duplicate
 * observations.
 *
 * Duplicates are real and large on this machine: backup trees
 * (`_session-.../tree-backup-before-move/`) and a git worktree
 * (`webappka-aeo-wt/`) hold copies of runs that also live in their original
 * folder. The dedupe key is a hash of the ENTIRE observation plus the run's
 * domain — not folder or date. That is the conservative choice: two genuinely
 * separate measurements would have to agree on the response text, the citation
 * list, the token counts AND the elapsed milliseconds to collide, while a
 * copied file collides exactly. A partially-post-processed copy (same 168
 * results, later sections filled in) therefore dedupes correctly at the
 * observation level even though the two files are not byte-identical.
 */
export function loadCorpus(files) {
  const runs = [];
  const excluded = new Map();
  const unreadable = [];
  const seen = new Map();          // hash -> first file that supplied it
  let rawOwnObservations = 0;
  let duplicateObservations = 0;
  const duplicateSources = new Map();

  for (const file of files.slice().sort(byCanonicalFirst)) {
    let summary;
    try { summary = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      unreadable.push({ file, error: String(err.message || err) });
      continue;
    }
    if (!summary || !Array.isArray(summary.results)) continue;
    const domain = String(summary.domain || '').toLowerCase();

    if (!OWN_DOMAINS.has(domain)) {
      const key = domain || '(no domain field)';
      const bucket = excluded.get(key) || { domain: key, runs: 0, observations: 0, examplePath: file };
      bucket.runs++; bucket.observations += summary.results.length;
      excluded.set(key, bucket);
      continue;
    }

    const kept = [];
    let dupsHere = 0;
    for (const o of summary.results) {
      rawOwnObservations++;
      const hash = crypto.createHash('sha1').update(domain + '|' + stableStringify(o)).digest('hex');
      if (seen.has(hash)) { duplicateObservations++; dupsHere++; continue; }
      seen.set(hash, file);
      kept.push(o);
    }
    if (dupsHere) {
      duplicateSources.set(file, { file, duplicateObservations: dupsHere, totalObservations: summary.results.length });
    }
    if (kept.length === 0) continue;
    runs.push({ file, summary, observations: kept });
  }

  return {
    runs,
    excluded: [...excluded.values()].sort((a, b) => b.observations - a.observations),
    unreadable,
    rawOwnObservations,
    duplicateObservations,
    duplicateSources: [...duplicateSources.values()].sort((a, b) => b.duplicateObservations - a.duplicateObservations),
  };
}

/** Flatten runs to observations, dropping errored / mention-less rows. */
export function usableObservations(runs) {
  const out = [];
  let dropped = 0;
  for (const run of runs) {
    for (const o of run.observations) {
      if (o.error || o.mention === undefined || o.mention === null) { dropped++; continue; }
      out.push({
        ...o,
        runDate: String(run.summary.date || ''),
        runDomain: String(run.summary.domain || ''),
        runBrand: String(run.summary.brand || ''),
        runFile: run.file,
        language: detectLanguage(o.queryText),
        market: detectMarket(o.queryText),
      });
    }
  }
  return { observations: out, dropped };
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Aggregation (pure — same function for every slice)
// ───────────────────────────────────────────────────────────────────────────

function topN(map, n, extra = () => ({})) {
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([k, v]) => ({ key: k, ...v, ...extra(k, v) }));
}

/** Count instances + the number of DISTINCT questions the item appeared under. */
function tally(map, key, queryText, init = {}) {
  if (!map.has(key)) map.set(key, { count: 0, queries: new Set(), ...init });
  const e = map.get(key);
  e.count++;
  if (queryText) e.queries.add(queryText);
  return e;
}

function finaliseSets(rows) {
  return rows.map(r => {
    const { queries, ...rest } = r;
    return { ...rest, distinctQueries: queries ? queries.size : 0 };
  });
}

export function aggregate(observations, ctx, opts = {}) {
  const top = opts.top || 20;

  const domains = new Map();
  const pages = new Map();
  const tlds = new Map();
  const buckets = new Map();
  const competitors = new Map();
  const engines = new Map();
  const perEngineDomains = new Map();
  const perEngineCompetitors = new Map();
  const unclassifiedHosts = new Map();

  let citationInstances = 0;
  let mentionYes = 0;
  const questions = new Set();
  const dates = new Set();

  for (const o of observations) {
    const q = o.queryText || '';
    if (q) questions.add(q);
    if (o.runDate) dates.add(o.runDate);
    if (String(o.mention).toLowerCase() === 'yes') mentionYes++;

    const provider = String(o.provider || 'unknown');
    const isManual = String(o.model || '') === 'manual' || String(o.source || '') === 'manual';
    const eng = engines.get(provider) || { count: 0, queries: new Set(), manual: 0, api: 0, models: new Set() };
    eng.count++; eng.queries.add(q); eng.models.add(String(o.model || '?'));
    if (isManual) eng.manual++; else eng.api++;
    engines.set(provider, eng);

    if (!perEngineDomains.has(provider)) perEngineDomains.set(provider, new Map());
    if (!perEngineCompetitors.has(provider)) perEngineCompetitors.set(provider, new Map());

    for (const url of o.canonicalCitations || []) {
      const host = normaliseHost(url);
      if (!host) continue;
      citationInstances++;
      const bucket = classifyHost(host, ctx);
      tally(domains, host, q, { bucket });
      tally(perEngineDomains.get(provider), host, q, { bucket });
      tally(tlds, tldOf(host), q);
      tally(buckets, bucket, q);
      if (bucket === 'unclassified') tally(unclassifiedHosts, host, q);
      const page = normaliseUrl(url);
      if (page) tally(pages, page, q, { host });
    }

    for (const raw of o.competitors || []) {
      const name = String(raw).trim();
      if (!name) continue;
      const key = ctx.entities.keyOf(name);
      const display = ctx.entities.canonical.get(key)?.display || name;
      const e = tally(competitors, key, q, { display, spellings: new Map() });
      e.spellings.set(name, (e.spellings.get(name) || 0) + 1);
      tally(perEngineCompetitors.get(provider), key, q, { display });
    }
  }

  // Which engines agree on WHICH sources? Computed only over engines that
  // cleared the publication floor, so a 1-observation column cannot make the
  // engines look like they disagree. Sets are of cited hosts, not of ranks —
  // this measures overlap of the source pool, nothing about ordering.
  const perEngineHostSets = new Map();
  for (const [provider, m] of perEngineDomains) perEngineHostSets.set(provider, new Set(m.keys()));

  const engineCoverage = [...engines.entries()]
    .map(([provider, e]) => ({
      provider,
      observations: e.count,
      distinctQueries: e.queries.size,
      apiObservations: e.api,
      manualObservations: e.manual,
      models: [...e.models].sort(),
      sufficientForPublication: e.count >= MIN_ENGINE_OBS && e.queries.size >= MIN_ENGINE_QUERIES,
      instrumentMixed: e.manual > 0 && e.api > 0,
      mostlyManual: e.manual > e.api,
    }))
    .sort((a, b) => b.observations - a.observations);

  const qualified = engineCoverage.filter(e => e.sufficientForPublication).map(e => e.provider);
  const qualifiedSets = qualified.map(p => perEngineHostSets.get(p) || new Set());
  const hostEngineCount = new Map();
  for (const set of qualifiedSets) for (const h of set) hostEngineCount.set(h, (hostEngineCount.get(h) || 0) + 1);
  const sharedByAll = qualified.length > 1
    ? [...hostEngineCount.entries()].filter(([, n]) => n === qualified.length).map(([h]) => h) : [];
  const uniqueToOne = [...hostEngineCount.entries()].filter(([, n]) => n === 1).length;
  const pairOverlap = [];
  for (let i = 0; i < qualified.length; i++) {
    for (let j = i + 1; j < qualified.length; j++) {
      const a = qualifiedSets[i], b = qualifiedSets[j];
      let inter = 0;
      for (const h of a) if (b.has(h)) inter++;
      const union = a.size + b.size - inter;
      pairOverlap.push({ pair: [qualified[i], qualified[j]], sharedHosts: inter, jaccard: union ? inter / union : 0 });
    }
  }
  const engineAgreement = {
    enginesCompared: qualified,
    excludedBelowFloor: engineCoverage.filter(e => !e.sufficientForPublication).map(e => e.provider),
    distinctHostsAcrossComparedEngines: hostEngineCount.size,
    hostsCitedByEveryComparedEngine: sharedByAll.length,
    hostsCitedByExactlyOneEngine: uniqueToOne,
    shareCitedByExactlyOneEngine: hostEngineCount.size ? uniqueToOne / hostEngineCount.size : 0,
    sharedHostsSample: sharedByAll.slice(0, 40).sort(),
    sharedHostsSampleTruncated: sharedByAll.length > 40,
    pairOverlap: pairOverlap.sort((a, b) => b.jaccard - a.jaccard),
  };

  const bucketRows = finaliseSets(topN(buckets, 99)).map(b => ({
    bucket: b.key,
    label: RESEARCH_BUCKETS[b.key] || b.key,
    citationInstances: b.count,
    share: citationInstances ? b.count / citationInstances : 0,
    distinctQueries: b.distinctQueries,
  }));

  const competitorRows = finaliseSets(topN(competitors, top)).map(c => ({
    entity: c.display,
    key: c.key,
    mentions: c.count,
    distinctQueries: c.distinctQueries,
    spellingsMerged: [...c.spellings].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, count: n })),
  }));
  // Rows with equal mention counts are ordered lexicographically by the sort,
  // which is deterministic but NOT a ranking. Flag them, so nobody publishes
  // "X beat Y" off an alphabetical accident — the top of the Polish table is a
  // real tie, and the tied parties are the readers most likely to check.
  for (const row of competitorRows) {
    row.tiedWith = competitorRows
      .filter(o => o !== row && o.mentions === row.mentions)
      .map(o => o.entity);
  }

  return {
    observations: observations.length,
    distinctQuestions: questions.size,
    runDates: [...dates].sort(),
    mentionYes,
    citationInstances,
    distinctDomains: domains.size,
    engineCoverage,
    engineAgreement,
    enginesBelowFloor: engineCoverage.filter(e => !e.sufficientForPublication).map(e => e.provider),
    topDomains: finaliseSets(topN(domains, top)).map(d => ({
      host: d.key, citationInstances: d.count, distinctQueries: d.distinctQueries, bucket: d.bucket,
    })),
    topPages: finaliseSets(topN(pages, Math.min(top, 15))).map(p => ({
      url: p.key, host: p.host, citationInstances: p.count, distinctQueries: p.distinctQueries,
    })),
    sourceTypes: bucketRows,
    unclassified: {
      citationInstances: buckets.get('unclassified')?.count || 0,
      share: citationInstances ? (buckets.get('unclassified')?.count || 0) / citationInstances : 0,
      distinctHosts: unclassifiedHosts.size,
      topHosts: finaliseSets(topN(unclassifiedHosts, 15)).map(h => ({ host: h.key, citationInstances: h.count })),
    },
    tldSplit: finaliseSets(topN(tlds, 15)).map(t => ({
      tld: t.key, citationInstances: t.count, share: citationInstances ? t.count / citationInstances : 0,
    })),
    topCompetitors: competitorRows,
    perEngine: [...perEngineDomains.keys()].sort().map(provider => ({
      provider,
      topDomains: finaliseSets(topN(perEngineDomains.get(provider), 10)).map(d => ({
        host: d.key, citationInstances: d.count, distinctQueries: d.distinctQueries, bucket: d.bucket,
      })),
      topCompetitors: finaliseSets(topN(perEngineCompetitors.get(provider), 10)).map(c => ({
        entity: c.display, mentions: c.count, distinctQueries: c.distinctQueries,
      })),
    })),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Dataset assembly
// ───────────────────────────────────────────────────────────────────────────

const SLICES = {
  all: () => true,
  pl: o => o.language === 'pl' || o.market === 'pl',
  de: o => o.language === 'de' || o.market === 'de',
  ru: o => o.language === 'ru',
  en: o => o.language === 'en' && o.market === 'none',
};

export function buildDataset({ root, files, top = 20 }) {
  const corpus = loadCorpus(files);
  const { observations, dropped } = usableObservations(corpus.runs);

  const entities = buildEntityIndex(corpus.runs);
  const competitorHosts = new Set([...entities.vendorHosts.values()]);
  // A competitor's own site is also recognisable when the host stem matches the
  // canonical entity key ("Delante" ↔ delante.pl, "Agencja Whites" ↔
  // agencjawhites.pl). Derived from the data, so it needs no monthly curation.
  // `entityKey` strips a leading "Agencja "/"Agentur "/"The " from a brand
  // name, but the company's DOMAIN usually keeps it ("Agencja Wrocławska" →
  // agencjawroclawska.pl, "The Story" → thestory.is). Register the
  // prefix-reattached forms too, or those hosts land in the unclassified tail
  // while the brand sits in the competitor table — the same entity counted as
  // two different kinds of thing.
  const NAME_PREFIXES_FOR_HOSTS = ['agencja', 'agencje', 'agentur', 'agency', 'the'];
  const entityStems = new Set();
  for (const k of entities.canonical.keys()) {
    if (k.length < 5) continue;
    entityStems.add(k);
    for (const p of NAME_PREFIXES_FOR_HOSTS) entityStems.add(p + k);
  }
  const ctx = {
    ownHosts: OWN_DOMAINS,
    competitorHosts,
    entities,
    entityStems,
  };
  // Second pass: promote unclassified hosts whose stem IS an observed entity.
  const stemHosts = new Set();
  for (const o of observations) {
    for (const url of o.canonicalCitations || []) {
      const host = normaliseHost(url);
      if (!host || competitorHosts.has(host)) continue;
      const stem = host.replace(/\.[a-z.]+$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (entityStems.has(stem)) stemHosts.add(host);
    }
  }
  for (const h of stemHosts) competitorHosts.add(h);

  const languageCounts = {};
  const marketCounts = {};
  for (const o of observations) {
    languageCounts[o.language] = (languageCounts[o.language] || 0) + 1;
    marketCounts[o.market] = (marketCounts[o.market] || 0) + 1;
  }

  const providerModels = new Map();
  const dates = new Set();
  for (const o of observations) {
    const key = `${o.provider}:${o.model}`;
    const e = providerModels.get(key) || { provider: o.provider, model: o.model, observations: 0, manual: 0 };
    e.observations++;
    if (String(o.model) === 'manual' || String(o.source || '') === 'manual') e.manual++;
    providerModels.set(key, e);
    if (o.runDate) dates.add(o.runDate);
  }

  const slices = {};
  for (const [name, pred] of Object.entries(SLICES)) {
    slices[name] = aggregate(observations.filter(pred), ctx, { top });
  }

  // The PL slice is the first issue's subject, so its definition is spelled out
  // rather than implied: how many rows come from the language axis, how many
  // from the market axis, how many from both.
  const plLang = observations.filter(o => o.language === 'pl');
  const plMarket = observations.filter(o => o.market === 'pl');
  slices.pl.sliceDefinition = {
    rule: 'language === "pl" OR market === "pl"',
    languageOnly: plLang.filter(o => o.market !== 'pl').length,
    marketOnly: plMarket.filter(o => o.language !== 'pl').length,
    both: plLang.filter(o => o.market === 'pl').length,
    shareOfAllObservations: observations.length ? slices.pl.observations / observations.length : 0,
  };

  // What the duplicate copies would have done to the headline table if nobody
  // had deduped. Recomputed with the SAME aggregate() over the raw rows, so the
  // comparison is apples-to-apples.
  const rawObservations = [];
  for (const file of files.slice().sort(byCanonicalFirst)) {
    let s; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!s || !Array.isArray(s.results)) continue;
    if (!OWN_DOMAINS.has(String(s.domain || '').toLowerCase())) continue;
    for (const o of s.results) {
      if (o.error || o.mention == null) continue;
      rawObservations.push({ ...o, runDate: String(s.date || ''), language: detectLanguage(o.queryText), market: detectMarket(o.queryText) });
    }
  }
  const rawPl = aggregate(rawObservations.filter(SLICES.pl), ctx, { top: 10 });
  const dedupedPlTop = slices.pl.topCompetitors.slice(0, 10).map(c => c.entity);
  const rawPlTop = rawPl.topCompetitors.slice(0, 10).map(c => c.entity);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      generator: 'bin/research-dataset.mjs',
      // FAIR F1 + R1.1: a monthly issue needs a stable handle to cite and
      // explicit reuse terms, or a reader who wants to check our arithmetic
      // has neither a name for the dataset nor permission to republish it.
      datasetId: `webappski-aeo-research-${new Date().toISOString().slice(0, 7)}`,
      datasetName: 'Webappski AEO research dataset (own-brand cross-section)',
      license: 'CC BY 4.0 — reuse with attribution to Webappski',
      schemaVersion: 1,
      trackerVersion: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
      root,
      summaryFilesFound: files.length,
      cost: 'zero — local file reads only, no network, no API, no LLM',
      isCrossSection: true,
      notATimeSeries:
        'Deliberately no trend/growth/change metrics. The instrument drifted across these runs ' +
        '(models, query grid, and manual-vs-API legs all changed), so any delta would measure our ' +
        'own tooling, not the engines. See instrumentDrift.',
    },
    scope: {
      ownDomains: [...OWN_DOMAINS],
      gate: 'allow-list of own domains — a newly onboarded client is excluded by default, never by name',
      includedRuns: corpus.runs.length,
      includedObservations: observations.length,
      rawOwnObservationsBeforeDedupe: corpus.rawOwnObservations,
      duplicateObservationsDropped: corpus.duplicateObservations,
      duplicateShareOfRaw: corpus.rawOwnObservations ? corpus.duplicateObservations / corpus.rawOwnObservations : 0,
      duplicateSources: corpus.duplicateSources,
      droppedErroredOrMentionless: dropped,
      excludedRuns: corpus.excluded,
      excludedRunsTotal: corpus.excluded.reduce((s, e) => s + e.runs, 0),
      excludedObservationsTotal: corpus.excluded.reduce((s, e) => s + e.observations, 0),
      unreadableFiles: corpus.unreadable,
    },
    instrumentDrift: {
      warning:
        'These runs are NOT one instrument. Comparability is bounded by the lists below: ' +
        'different models answered different runs, some legs were pasted by hand rather than called ' +
        'via API, and the query grid was rewritten (a positional `query` id such as "Q3" is NOT stable ' +
        'across runs — always key on queryText).',
      providerModels: [...providerModels.values()].sort((a, b) => b.observations - a.observations),
      distinctProviderModels: providerModels.size,
      runDates: [...dates].sort(),
      distinctRunDates: dates.size,
      distinctQuestions: new Set(observations.map(o => o.queryText).filter(Boolean)).size,
      manualLegs: [...providerModels.values()].filter(e => e.manual > 0)
        .map(e => ({ provider: e.provider, model: e.model, manualObservations: e.manual })),
    },
    axes: {
      note: 'language = what the question was asked in; market = what geography the question names. ' +
        'Derived from queryText only — never from the runs\' own regionContext, which is inferred from ' +
        'the citation TLDs under study and would make every finding circular.',
      languageCounts,
      marketCounts,
    },
    entityCanonicalisation: {
      rule: 'transparent fold (case, diacritics, punctuation, Agencja/Agentur prefix, legal suffix, ' +
        'country tail, trailing "AI", TLD tail) + same-vendor-host evidence from competitorPricing. No LLM.',
      canonicalEntities: entities.canonical.size,
      mergedByVendorHost: entities.domainMerges,
      unmergedNearCollisions: entities.nearCollisions,
    },
    duplicateImpact: {
      note: 'What the un-deduped corpus would have produced for the headline slice. Published so the ' +
        'correction is auditable rather than invisible.',
      plObservationsWithDuplicates: rawPl.observations,
      plObservationsDeduped: slices.pl.observations,
      plTop10WithDuplicates: rawPlTop,
      plTop10Deduped: dedupedPlTop,
      plTop10OrderChanged: JSON.stringify(rawPlTop) !== JSON.stringify(dedupedPlTop),
    },
    slices,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Human summary
// ───────────────────────────────────────────────────────────────────────────

const pct = n => (n * 100).toFixed(1) + '%';

function renderSlice(name, s, lines) {
  lines.push('');
  lines.push(`── SLICE: ${name} ─ ${s.observations} observations · ${s.distinctQuestions} distinct questions · ` +
    `${s.citationInstances} citation instances · ${s.distinctDomains} distinct domains`);
  if (s.sliceDefinition) {
    const d = s.sliceDefinition;
    lines.push(`   definition: ${d.rule} → language-only ${d.languageOnly} · market-only ${d.marketOnly} · both ${d.both} ` +
      `(= ${pct(d.shareOfAllObservations)} of all observations)`);
  }
  lines.push('   engine coverage:');
  for (const e of s.engineCoverage) {
    const flag = e.sufficientForPublication ? 'OK  ' : 'THIN';
    const mix = e.manualObservations ? ` (api ${e.apiObservations} / manual ${e.manualObservations})` : '';
    if (e.mostlyManual) lines.push(`     ⚠️  ${e.provider}: most of this column was pasted by hand, not called via API — it is a different instrument from the API columns`);
    lines.push(`     [${flag}] ${e.provider.padEnd(11)} n=${String(e.observations).padStart(4)} · ` +
      `${String(e.distinctQueries).padStart(3)} questions${mix}`);
  }
  if (s.enginesBelowFloor.length) {
    lines.push(`     ⚠️  below the publication floor (n<${MIN_ENGINE_OBS} or <${MIN_ENGINE_QUERIES} questions): ` +
      `${s.enginesBelowFloor.join(', ')} — do NOT claim these engines were "checked" in this slice`);
  }
  const ea = s.engineAgreement;
  if (ea && ea.enginesCompared.length > 1) {
    lines.push(`   engine agreement (over ${ea.enginesCompared.join(' / ')}${ea.excludedBelowFloor.length ? `; ${ea.excludedBelowFloor.join(', ')} excluded — below floor` : ''}):`);
    lines.push(`     ${ea.distinctHostsAcrossComparedEngines} distinct hosts · cited by ALL: ${ea.hostsCitedByEveryComparedEngine} · ` +
      `cited by exactly ONE: ${ea.hostsCitedByExactlyOneEngine} (${pct(ea.shareCitedByExactlyOneEngine)})`);
    for (const o of ea.pairOverlap) {
      lines.push(`     ${o.pair.join(' ∩ ').padEnd(26)} ${String(o.sharedHosts).padStart(4)} shared hosts · Jaccard ${o.jaccard.toFixed(3)}`);
    }
  }
  lines.push('   top cited domains:');
  for (const d of s.topDomains.slice(0, 12)) {
    lines.push(`     ${String(d.citationInstances).padStart(4)}× ${d.host.padEnd(28)} ` +
      `${String(d.distinctQueries).padStart(3)}q  [${d.bucket}]`);
  }
  lines.push('   source types:');
  for (const b of s.sourceTypes) {
    lines.push(`     ${String(b.citationInstances).padStart(5)} ${pct(b.share).padStart(7)}  ${b.label}`);
  }
  lines.push(`   unclassified: ${s.unclassified.citationInstances} instances (${pct(s.unclassified.share)}) across ` +
    `${s.unclassified.distinctHosts} hosts — top: ${s.unclassified.topHosts.slice(0, 5).map(h => h.host).join(', ') || '(none)'}`);
  lines.push('   TLD split: ' + s.tldSplit.slice(0, 8).map(t => `${t.tld} ${pct(t.share)}`).join(' · '));
  lines.push('   top competitors named:');
  for (const c of s.topCompetitors.slice(0, 12)) {
    const merged = c.spellingsMerged.length > 1
      ? `  ← merged ${c.spellingsMerged.map(x => `"${x.name}" ${x.count}`).join(' + ')}` : '';
    const tie = c.tiedWith && c.tiedWith.length ? `  ⇄ TIED with ${c.tiedWith.join(', ')} — the order above is alphabetical, not a ranking` : '';
    lines.push(`     ${String(c.mentions).padStart(4)}× ${c.entity.padEnd(26)} ${String(c.distinctQueries).padStart(3)}q${tie}${merged}`);
  }
  lines.push('   per engine (top 3 domains / top 3 competitors):');
  for (const p of s.perEngine) {
    lines.push(`     ${p.provider.padEnd(11)} domains: ${p.topDomains.slice(0, 3).map(d => `${d.host} (${d.citationInstances})`).join(', ') || '—'}`);
    lines.push(`     ${''.padEnd(11)} names:   ${p.topCompetitors.slice(0, 3).map(c => `${c.entity} (${c.mentions})`).join(', ') || '—'}`);
  }
}

export function renderSummary(ds, sliceNames) {
  const lines = [];
  lines.push('═══ AEO RESEARCH DATASET — own-brand cross-section ═══');
  lines.push(`root: ${ds.meta.root}`);
  lines.push(`generated: ${ds.meta.generatedAt}  ·  tracker ${ds.meta.trackerVersion}  ·  cost: ${ds.meta.cost}`);
  lines.push('');
  lines.push('SCOPE');
  lines.push(`  summary files found ......... ${ds.meta.summaryFilesFound}`);
  lines.push(`  own runs included ........... ${ds.scope.includedRuns}`);
  lines.push(`  raw own observations ........ ${ds.scope.rawOwnObservationsBeforeDedupe}`);
  lines.push(`  duplicate rows dropped ...... ${ds.scope.duplicateObservationsDropped} (${pct(ds.scope.duplicateShareOfRaw)} of raw)`);
  lines.push(`  errored / mention-less ...... ${ds.scope.droppedErroredOrMentionless}`);
  lines.push(`  observations in dataset ..... ${ds.scope.includedObservations}`);
  lines.push(`  EXCLUDED (not our domains) .. ${ds.scope.excludedRunsTotal} runs / ${ds.scope.excludedObservationsTotal} observations`);
  for (const e of ds.scope.excludedRuns) {
    lines.push(`      · ${e.domain.padEnd(20)} ${String(e.runs).padStart(2)} runs / ${String(e.observations).padStart(4)} observations`);
  }
  if (ds.scope.duplicateSources.length) {
    lines.push('  duplicate sources (files whose rows were already seen):');
    for (const d of ds.scope.duplicateSources.slice(0, 20)) {
      lines.push(`      · ${d.duplicateObservations}/${d.totalObservations}  ${d.file.replace(process.env.HOME || '~', '~')}`);
    }
  }
  lines.push('');
  lines.push('INSTRUMENT DRIFT (bounds of comparability — this is a cross-section, not a trend)');
  lines.push(`  distinct provider:model ..... ${ds.instrumentDrift.distinctProviderModels}`);
  for (const pmRow of ds.instrumentDrift.providerModels) {
    lines.push(`      · ${(pmRow.provider + ':' + pmRow.model).padEnd(34)} ${String(pmRow.observations).padStart(4)} obs` +
      (pmRow.manual ? `  (hand-pasted, not API)` : ''));
  }
  lines.push(`  distinct run dates .......... ${ds.instrumentDrift.distinctRunDates}  [${ds.instrumentDrift.runDates.join(', ')}]`);
  lines.push(`  distinct questions .......... ${ds.instrumentDrift.distinctQuestions}`);
  lines.push('');
  lines.push('AXES');
  lines.push(`  language: ${Object.entries(ds.axes.languageCounts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push(`  market:   ${Object.entries(ds.axes.marketCounts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push('');
  lines.push('ENTITY CANONICALISATION');
  lines.push(`  canonical entities .......... ${ds.entityCanonicalisation.canonicalEntities}`);
  lines.push(`  merged on vendor-host proof . ${ds.entityCanonicalisation.mergedByVendorHost.length}`);
  lines.push(`  near-collisions NOT merged .. ${ds.entityCanonicalisation.unmergedNearCollisions.length}` +
    (ds.entityCanonicalisation.unmergedNearCollisions.length
      ? ` (e.g. ${ds.entityCanonicalisation.unmergedNearCollisions.slice(0, 4).map(n => `${n.shorter}/${n.longer}`).join(', ')})` : ''));
  lines.push('');
  lines.push('DUPLICATE IMPACT ON THE HEADLINE SLICE');
  lines.push(`  PL observations: ${ds.duplicateImpact.plObservationsWithDuplicates} raw → ${ds.duplicateImpact.plObservationsDeduped} deduped`);
  lines.push(`  PL top-10 order changed by dedupe: ${ds.duplicateImpact.plTop10OrderChanged ? 'YES' : 'no'}`);
  lines.push(`     raw     : ${ds.duplicateImpact.plTop10WithDuplicates.join(' > ')}`);
  lines.push(`     deduped : ${ds.duplicateImpact.plTop10Deduped.join(' > ')}`);

  for (const name of sliceNames) {
    if (ds.slices[name]) renderSlice(name, ds.slices[name], lines);
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// 9. CLI
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { top: 20, slices: ['all', 'pl', 'de', 'ru', 'en'], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]) || 20;
    else if (a === '--slice') args.slices = String(argv[++i]).split(',').map(s => s.trim());
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node bin/research-dataset.mjs [--root <dir>] [--out <file>] [--top <n>] [--slice all,pl,de,ru,en] [--json]');
    process.exit(0);
  }
  // Default root = the folder that holds this repo, i.e. all sibling projects.
  // Not hardcoded to one machine's layout; --root overrides.
  const root = path.resolve(args.root ? args.root.replace(/^~(?=\/|$)/, process.env.HOME || '~') : path.dirname(REPO));
  if (!fs.existsSync(root)) {
    console.error(`root does not exist: ${root}`);
    process.exit(1);
  }

  const files = scanSummaries(root);
  const dataset = buildDataset({ root, files, top: args.top });

  const outDir = path.join(REPO, 'aeo-reports');
  const outPath = args.out
    ? path.resolve(args.out.replace(/^~(?=\/|$)/, process.env.HOME || '~'))
    : path.join(outDir, `research-dataset-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2));

  if (args.json) {
    console.log(JSON.stringify(dataset, null, 2));
  } else {
    console.log(renderSummary(dataset, args.slices));
    console.log('');
    console.log(`✅ wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB) — ` +
      `${dataset.scope.includedRuns} own runs, ${dataset.scope.includedObservations} observations, ` +
      `${dataset.scope.excludedRunsTotal} client/foreign runs excluded, ` +
      `${dataset.scope.duplicateObservationsDropped} duplicate rows dropped`);
  }
}
