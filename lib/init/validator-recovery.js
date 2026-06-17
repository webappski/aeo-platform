// Recovery layer for the commercial-only validator gate in init --auto.
//
import { compareCandidates } from './research/select.js';
import { brandFitRank } from './research/brand-fit.js';
//
// Problem it solves: the research pipeline produces 3 selected queries + up to
// 5 validated alternatives (candidatePool). If the commercial-only validator
// blocks 1-3 of the selected queries, the old code aborted — throwing away the
// 5 already-validated alternatives sitting in memory. User had to re-read,
// copy-paste, rerun. This module turns that abort into either a silent
// substitution (auto-promote, --yes mode) or a numbered prompt (TTY).
//
// Scope (revised 1.1.8):
//   - informationalIssues (wrong-intent blockers): recoverable via pool swap,
//     as before.
//   - llmIssues (valid:false verdicts): recoverable too — but ONLY with a
//     VERIFIED substitute (pool entry whose own verdict is valid:true AND
//     retrieval-triggered; see isVerifiedSubstitute). The old "a swap may
//     introduce the same problem" objection is answered by checking the
//     substitute's verdict, not by refusing to swap. Refusing threw away
//     2 validated alternatives while aborting the whole init.
//   - staticIssues (acronym ambiguity) → still not auto-recoverable; the
//     caller falls back to the abort-with-actionable-panel path.
//
// Re-validation after substitution is free: alternatives come from the
// research pipeline's own validationCache, so the second runTwoStageValidation
// call hits the cache for every substituted query — ~0ms, $0.

import { SEARCH_BEHAVIORS } from './research/run-validation.js';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/**
 * @typedef {Object} CandidateEntry
 * @property {string}  text       Query text
 * @property {string=} intent     Intent bucket: 'commercial'|'vertical'|'comparison'|'problem'|'informational'
 * @property {number=} score      Research pipeline score (0-100)
 * @property {boolean=} unverified True when cross-model validation disagreed
 */

/**
 * @typedef {Object} QueryWithIntent
 * @property {string}  text
 * @property {string=} intent
 */

/**
 * @typedef {Object} Substitution
 * @property {string} original       Blocked query text
 * @property {string} originalIntent Intent of the blocked query (may be undefined)
 * @property {string} replacement    Replacement query text
 * @property {string} replacementIntent
 * @property {number} score          Replacement's research score
 * @property {string} searchBehavior The blocker's search_behavior ('mixed' | 'parametric')
 */

/**
 * Shape guard: does this blocker carry { query, search_behavior }, the two
 * fields tryAutoRecover reads? Since 1.1.8 recoverability itself is decided
 * at the call site (llm blockers swap with verified substitutes — see
 * isVerifiedSubstitute); this stays as a pure shape check for legacy callers.
 *
 * @param {Object} blocker
 * @returns {boolean}
 */
export function isRecoverable(blocker) {
  return blocker != null
    && typeof blocker.query === 'string'
    && typeof blocker.search_behavior === 'string';
}

/**
 * Type guard: is this pool entry safe to substitute for an llm-rejected
 * (valid:false) query? Requires the entry's OWN verdict to be a full pass:
 * valid === true AND retrieval-triggered. Entries from legacy pools that
 * never carried a `valid` field fail closed — they may substitute
 * informational blockers (legacy behaviour) but never llm blockers.
 *
 * @param {CandidateEntry} entry
 * @returns {boolean}
 */
export function isVerifiedSubstitute(entry) {
  return entry != null
    && entry.valid === true
    && entry.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL;
}

/**
 * Dedupe blockers by query text. A single query can be flagged by multiple
 * validator stages (llm valid:false + commercial-only) — without dedup the
 * recovery loop would consume two substitutes for one slot. Keeps the FIRST
 * entry per query (callers list llmIssues first so the richer reason wins).
 *
 * @param {Object[]} blockers
 * @returns {Object[]}
 */
export function dedupeBlockersByQuery(blockers) {
  const seen = new Set();
  const out = [];
  for (const b of blockers) {
    if (!b || typeof b.query !== 'string' || seen.has(b.query)) continue;
    seen.add(b.query);
    out.push(b);
  }
  return out;
}

/**
 * Given a set of blockers (informationalIssues only), a queries list, and
 * the candidatePool, return substitutions that maximize intent diversity in
 * the final 3-query set.
 *
 * Ranking rule (intent diversity, per senior review Q1):
 *   1. surviving_intents = intents of queries NOT in blockers
 *   2. for each blocker (processed in blocker order):
 *        pick = highest-scored alternative with intent ∉ surviving_intents
 *               AND text ∉ already-used queries
 *        fallback: highest-scored alternative regardless of intent bucket
 *        after pick: add pick.intent to surviving_intents
 *   3. unresolved = blockers for which no alternative was available
 *
 * @param {Object} opts
 * @param {Object[]} opts.blockers               informationalIssues array
 * @param {QueryWithIntent[]} opts.queries       current 3 queries with their intents
 * @param {CandidateEntry[]} opts.candidatePool  up to 5 validated alternatives
 * @returns {{
 *   substitutions: Substitution[],
 *   unresolvedBlockers: Object[],
 *   newQueries: string[]
 * }}
 */
export function tryAutoRecover({ blockers, queries, candidatePool }) {
  const blockedTexts = new Set(blockers.map(b => b.query));
  const usedTexts = new Set(queries.map(q => q.text));
  const survivingIntents = new Set(
    queries.filter(q => !blockedTexts.has(q.text) && q.intent).map(q => q.intent)
  );

  // Sort pool by score desc, brand-fit as the tie-breaker — cheap, runs once
  // per recover call. This is what the persisted `candidatePool[].brandFit`
  // (cached at init, see bin/aeo-tracker.js) is FOR: on a score tie, prefer the
  // more brand-relevant alternative (core > adjacent/unknown > aspirational),
  // matching select.js's primary ranking. Persisted entries carry `brandFit`
  // but not the numeric rank, so re-derive it here before delegating to the
  // shared comparator (which reads `brandFitRank`).
  const sortedPool = [...candidatePool]
    .map(c => (typeof c.brandFitRank === 'number' ? c : { ...c, brandFitRank: brandFitRank(c.brandFit) }))
    .sort(compareCandidates);

  const substitutions = [];
  const unresolvedBlockers = [];

  for (const blocker of blockers) {
    const blockedQuery = queries.find(q => q.text === blocker.query);
    const originalIntent = blockedQuery?.intent;

    const diverseIdx = sortedPool.findIndex(c =>
      !usedTexts.has(c.text) && c.intent && !survivingIntents.has(c.intent)
    );
    const fallbackIdx = sortedPool.findIndex(c => !usedTexts.has(c.text));

    const pickIdx = diverseIdx >= 0 ? diverseIdx : fallbackIdx;
    if (pickIdx < 0) {
      unresolvedBlockers.push(blocker);
      continue;
    }

    const pick = sortedPool[pickIdx];
    substitutions.push({
      original: blocker.query,
      originalIntent: originalIntent || '',
      replacement: pick.text,
      replacementIntent: pick.intent || '',
      score: pick.score || 0,
      searchBehavior: blocker.search_behavior,
      // llm-rejected blockers carry the verdict's reason; informational ones don't.
      blockReason: blocker.valid === false ? (blocker.reason || 'LLM rejected as invalid') : null,
    });

    usedTexts.add(pick.text);
    if (pick.intent) survivingIntents.add(pick.intent);
  }

  const subByOriginal = new Map(substitutions.map(s => [s.original, s.replacement]));
  const newQueries = queries.map(q => subByOriginal.get(q.text) || q.text);

  return { substitutions, unresolvedBlockers, newQueries };
}

/**
 * Interactive TTY prompt for a single blocked query. Returns replacement text,
 * 'MANUAL' (caller should re-prompt for free-text), or null (user chose abort).
 *
 * Prompt format (per senior review Q2): 4 options (1-N / m / a), no [f]
 * — global --force covers "keep original". Default Enter = recommended (1).
 *
 * @param {Object} opts
 * @param {Object} opts.blocker           one informationalIssues entry
 * @param {CandidateEntry[]} opts.available  pool filtered to non-used, top-4
 * @param {(q: string) => Promise<string>} opts.ask  matches the init ask helper
 * @param {boolean} [opts.useColor]
 * @returns {Promise<{action:'replace',text:string}|{action:'manual'}|{action:'abort'}>}
 */
export async function promptBlockedQueryReplacement({ blocker, available, ask, useColor = true }) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, green: GREEN, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', green: '', dim: '', bold: '', reset: '' };

  console.log('');
  console.log(`${c.yellow}  Query blocked:${c.reset} "${blocker.query}"`);
  if (blocker.valid === false) {
    console.log(`${c.dim}    LLM rejected: ${blocker.reason || 'invalid for this brand/industry'}${c.reset}`);
  } else {
    console.log(`${c.dim}    search_behavior: ${blocker.search_behavior} — produces tutorial answers, not vendor lists${c.reset}`);
  }
  console.log('');
  console.log(`${c.bold}  Choose a replacement:${c.reset}`);

  const shown = available.slice(0, 4);
  shown.forEach((cand, i) => {
    const marker = i === 0 ? ` ${c.green}← recommended${c.reset}` : '';
    const intent = cand.intent ? `${cand.intent}, ` : '';
    const score = cand.score != null ? `score ${cand.score}` : '';
    console.log(`    ${c.bold}[${i + 1}]${c.reset} ${cand.text}  ${c.dim}(${intent}${score})${c.reset}${marker}`);
  });
  console.log(`    ${c.bold}[m]${c.reset} type your own replacement`);
  console.log(`    ${c.bold}[a]${c.reset} abort — edit queries manually with --keywords`);
  console.log('');

  const range = shown.length === 1 ? '1' : `1-${shown.length}`;
  const ans = (await ask(`  Pick [${range}/m/a] (Enter = 1): `)).trim().toLowerCase();

  if (ans === 'a') return { action: 'abort' };
  if (ans === 'm') return { action: 'manual' };
  const picked = ans === '' ? 1 : parseInt(ans, 10);
  if (Number.isFinite(picked) && picked >= 1 && picked <= shown.length) {
    return { action: 'replace', text: shown[picked - 1].text };
  }
  // Invalid input → treat as recommended (Enter default). Robust to typos.
  return { action: 'replace', text: shown[0].text };
}

/**
 * Actionable panel printed in --yes mode when recovery cannot finish silently:
 * multi-blocked with safer-default panel behavior, OR pool exhausted, OR any
 * non-informational blocker present. Gives the user a copy-paste --keywords
 * command pre-populated from the validated pool.
 *
 * @param {Object} opts
 * @param {Object[]} opts.allBlockers        static + llm + informational (full picture)
 * @param {CandidateEntry[]} opts.candidatePool
 * @param {string[]} opts.currentQueries     current 3 queries
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {boolean} [opts.useColor]
 * @returns {string[]} lines ready for console.log
 */
export function formatRecoveryPanel({
  allBlockers, candidatePool, currentQueries, brand, domain,
  category = '', useColor = true,
  commercialPassingCount = null,  // 1.0.6: honest "X of 5 commercial" header
}) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, green: GREEN, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', green: '', dim: '', bold: '', reset: '' };

  // Dedupe by query string — a single query can hit multiple validator stages
  // (LLM industry-fit + commercial-only) and arrive in `allBlockers` twice.
  // Keep the most specific classification per query: parametric-only beats
  // retrieval-triggered beats other behaviour beats no-behaviour.
  // Information-loss: the loser's b.message/b.reason is discarded, but the
  // render path below prefers b.search_behavior over b.message/b.reason, so
  // for the target case (duplicate behaviour-tagged queries) no user-visible
  // information is lost.
  function specificityRank(b) {
    if (b.search_behavior === 'parametric-only') return 3;
    if (b.search_behavior === 'retrieval-triggered') return 2;
    if (b.search_behavior) return 1;
    return 0;
  }
  const dedupedBlockers = Array.from(
    allBlockers.reduce((acc, b) => {
      const prev = acc.get(b.query);
      if (!prev || specificityRank(b) > specificityRank(prev)) acc.set(b.query, b);
      return acc;
    }, new Map()).values()
  );

  const lines = [];
  lines.push('');
  // 1.0.8: header shows BOTH counts honestly. Recovery panel only fires
  // when dedupedBlockers.length > 0, so the "0 blocked" branch is
  // unreachable here — kept conceptually as documentation. After 1.0.8
  // alignment between substitution and main validation, the most common
  // failure is "all 5 commercial-OK but N rejected by LLM verdict".
  // Legacy fallback (commercialPassingCount === null) used by --keywords
  // mode where no substitution block runs.
  const headerSummary = typeof commercialPassingCount === 'number'
    ? `${commercialPassingCount} of 5 commercial-OK, ${dedupedBlockers.length} blocked by LLM verdict`
    : `${dedupedBlockers.length} query/queries blocked by validator`;
  lines.push(`${c.red}${c.bold}  Cannot auto-recover — ${headerSummary}.${c.reset}`);
  lines.push('');
  lines.push(`${c.bold}  Blocked:${c.reset}`);
  for (const b of dedupedBlockers) {
    // 1.0.8: show the REAL reason. Previously this branched on
    // `b.search_behavior` presence and would print "non-commercial
    // (search_behavior: retrieval-triggered)" — a contradiction in one
    // line, because retrieval-triggered IS commercial. The bug came from
    // valid:false llmIssues carrying search_behavior, which won the label.
    let reason;
    if (b.valid === false) {
      // LLM rejected the query outright. Most common after 1.0.8 since
      // `valid:false` is now the only LLM block reason.
      reason = b.reason
        ? `LLM rejected: ${b.reason}`
        : 'LLM rejected as invalid';
    } else if (b.search_behavior && b.search_behavior !== 'retrieval-triggered') {
      // Genuinely non-commercial: parametric-only / mixed → AI gives
      // tutorial answer, not vendor list.
      reason = `non-commercial (search_behavior: ${b.search_behavior})`;
    } else if (b.message) {
      // Static-validation issue (acronym ambiguity, malformed, etc.).
      reason = b.message;
    } else {
      reason = b.reason || 'unspecified block reason';
    }
    lines.push(`    ${c.yellow}✗${c.reset} "${b.query}"`);
    lines.push(`      ${c.dim}${reason}${c.reset}`);
  }
  lines.push('');
  lines.push(`${c.bold}  How to fix — pick one:${c.reset}`);
  lines.push('');

  // Option 1 — pre-filled --keywords command. Take up to 3 alternatives from
  // the pool that pass BOTH validator stages (industry-fit AND commercial-only).
  // 1.0.4 Fix A: candidatePool entries are enriched at the call site with
  // search_behavior from v.updatedCache, so we can filter here.
  // 1.0.4 Fix B: when the pool is short, fall back to category-based fillers
  // (the way users actually search), not brand-comparison templates.
  const COMMERCIAL_OK = (item) =>
    !item.search_behavior || item.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL;
  const unusedPool = candidatePool.filter(c =>
    !currentQueries.includes(c.text) && COMMERCIAL_OK(c)
  );
  const suggested = unusedPool.slice(0, 3).map(c => c.text);

  // Category-based fillers, domain-agnostic. Two guards:
  //   (a) category must be non-empty
  //   (b) category must look like a noun phrase (≤4 words) — inferCategory()
  //       often returns a long marketing sentence, which produces invalid
  //       English when interpolated. When that happens treat category as absent.
  // No hardcoded vertical: 'best X 2026' works for any category; 'best X for
  // small business' would break for verticals where small business isn't
  // the audience. See memory/project_query_archetypes_category_based.md.
  const categoryClean = category && category.split(/\s+/).length <= 4 ? category : '';
  const categoryFillers = categoryClean
    ? [
        `best ${categoryClean} 2026`,
        `top ${categoryClean} tools`,
        `${categoryClean} platforms`,
      ]
    : [];
  const finalQueries = suggested.length === 3
    ? suggested
    : [...suggested, ...categoryFillers.slice(suggested.length)].slice(0, 3);

  // Honest poolNote per state. No more "edit as needed" euphemisms.
  const poolNote = suggested.length === 3
    ? ' (from validated pool — both validator stages passed)'
    : suggested.length > 0
      ? categoryClean
        ? ` (${suggested.length} from validated pool, rest are category templates — edit if you have a specific vertical)`
        : ` (${suggested.length} from validated pool — pool exhausted; see options below to get more)`
      : categoryClean
        ? ' (category templates — edit if you have a specific vertical in mind)'
        : ' (no validated alternatives, no clean category available — see options below for what to do instead)';

  // Option 1 is shown ONLY if finalQueries reaches exactly 3 — the CLI's
  // `--keywords` precondition rejects any other count. This is the 1.0.4
  // post-publish safety net: even if pool-topup (cmdInit) silently no-ops
  // (LLM error, no provider, all rejected), the panel never emits a
  // command that the gate would reject. Caught by cli-walkthrough skill
  // for cells D (pool=1+unclean) and F (pool=2+unclean).
  const showOption1 = finalQueries.length === 3;
  const optN = (n) => showOption1 ? n : n - 1;

  if (showOption1) {
    lines.push(`    ${c.bold}1.${c.reset} Rerun with hand-picked queries${poolNote}:`);
    lines.push(`         ${c.dim}aeo-platform init --yes \\${c.reset}`);
    lines.push(`         ${c.dim}  --brand=${brand} \\${c.reset}`);
    lines.push(`         ${c.dim}  --domain=${domain} \\${c.reset}`);
    lines.push(`         ${c.dim}  --keywords="${finalQueries.join(',')}"${c.reset}`);
    lines.push('');
  } else {
    // Option 1 suppressed because finalQueries.length !== 3 — the CLI's
    // --keywords gate would reject it. Surface this honestly so the
    // operator isn't left wondering whether the panel skipped a step.
    lines.push(`    ${c.dim}(pool insufficient for option 1 — see options below)${c.reset}`);
    lines.push('');
  }

  // Option 2 — category override. Sometimes wrong-intent queries are a
  // symptom of mis-inferred category. Real solution: re-run with explicit
  // category so different alternatives surface.
  lines.push(`    ${c.bold}${optN(2)}.${c.reset} Try again with an explicit category hint (different alternatives may surface):`);
  lines.push(`         ${c.dim}aeo-platform init --yes --auto \\${c.reset}`);
  lines.push(`         ${c.dim}  --brand=${brand} --domain=${domain} \\${c.reset}`);
  lines.push(`         ${c.dim}  --category="<your niche in one phrase>"${c.reset}`);
  lines.push('');

  // Callout: surface --manual prominently before its numbered option. Operators
  // who are truly stuck (brand unknown to LLM, all auto paths failing) benefit
  // from seeing the reliable escape hatch before reading through the full list.
  lines.push(`  ${c.bold}→ Stuck? Option ${optN(3)} below is the reliable fallback — no LLM needed, always works.${c.reset}`);
  lines.push('');

  // Option 3 (1.0.4 Fix C) — drop --yes, switch to interactive --manual.
  // Always-works escape hatch: skips the entire validator-recovery cycle by
  // prompting the operator for each query in turn. Recommended when
  // --auto/--keywords paths keep getting rejected (typically for brands too
  // new for LLM context to know).
  lines.push(`    ${c.bold}${optN(3)}.${c.reset} Drop --yes and switch to interactive mode (you'll type each query yourself):`);
  lines.push(`         ${c.dim}aeo-platform init --brand=${brand} --domain=${domain} --manual${c.reset}`);
  lines.push(`         ${c.dim}(no LLM cost; always works regardless of LLM-context coverage)${c.reset}`);
  lines.push('');

  // Option 4 — --force, the truly last resort. Was option 3 in 1.0.3; demoted
  // to last in 1.0.4 because option 3 above (--manual) is the actual safe
  // escape hatch. Yellow warning persists so operators don't pick this by
  // accident.
  lines.push(`    ${c.yellow}${c.bold}${optN(4)}.${c.reset} ${c.yellow}Keep the blocked queries anyway (truly last resort — degrades trend data):${c.reset}`);
  lines.push(`         ${c.dim}aeo-platform init --yes --auto --force \\${c.reset}`);
  lines.push(`         ${c.dim}  --brand=${brand} --domain=${domain}${c.reset}`);
  lines.push(`         ${c.yellow}  Why this hurts: 0% visibility on non-commercial queries looks identical${c.reset}`);
  lines.push(`         ${c.yellow}  to "brand invisible" in weekly diffs. The signal is contaminated.${c.reset}`);
  lines.push('');

  return lines;
}

/**
 * Compose a single warning line for --yes mode when auto-promotion succeeds.
 * Per senior review R1: disclose measurement-semantics shift so the user
 * knows their visibility score now tracks a different intent than intended.
 *
 * @param {Substitution} sub
 * @param {boolean} [useColor]
 * @returns {string[]}
 */
export function formatAutoPromoteWarning(sub, useColor = true) {
  const c = useColor
    ? { yellow: YELLOW, green: GREEN, dim: DIM, bold: BOLD, reset: RESET }
    : { yellow: '', green: '', dim: '', bold: '', reset: '' };

  const intentShift = sub.originalIntent && sub.replacementIntent
    ? `${sub.originalIntent} → ${sub.replacementIntent}`
    : `search_behavior: ${sub.searchBehavior} → retrieval-triggered`;
  const blockLabel = sub.blockReason ? `LLM rejected: ${sub.blockReason}` : sub.searchBehavior;

  return [
    `${c.yellow}  ⚠ Query "${sub.original}" blocked (${blockLabel}).${c.reset}`,
    `${c.dim}    Auto-swapped with validated alternative:${c.reset} ${c.green}"${sub.replacement}"${c.reset}${sub.replacementIntent ? ` ${c.dim}(${sub.replacementIntent}, score ${sub.score})${c.reset}` : ''}`,
    `${c.dim}    Measurement shifts (${intentShift}) — your visibility score tracks the new question.${c.reset}`,
    `${c.dim}    Keep original: add --force. Pick your own 3 queries: use --keywords="...".${c.reset}`,
  ];
}
