/**
 * AP-RUNMANUAL-DECLARED-SUBSET — importing a leg that deliberately covers only
 * part of the basket.
 *
 * `run-manual --from-dir` refuses a directory missing any `q<N>.txt`, and that
 * refusal is right: silently skipping a file produces a partial `_summary.json`
 * that contaminates the weekly trend, with nothing in the artifact saying which
 * cells were never asked.
 *
 * What it could not express is a leg that is partial ON PURPOSE. The Claude leg
 * costs ~92k tokens per question — a full 50-question pass is ~4.6M — so from
 * 2026-09-16 it runs on a FIXED 15-question subsample, the same 15 every time,
 * for continuity between reports. The answers existed on disk and could not be
 * imported at all.
 *
 * So: the refusal stays the default, and partiality becomes DECLARABLE. With
 * `--declared-subset=<name>` the uncovered questions are written as real cells
 * with `mention: 'missing'` — never asked, therefore not a hit, not a miss, and
 * not in any denominator (lib/score.js `cellCounts`, lib/diff.js
 * `isCoveredMention`) — and the summary carries a stamp naming the subsample,
 * its coverage, and the selection-bias warning that belongs next to it.
 *
 * WHY THE WARNING IS NOT OPTIONAL. The 2026-09-16 subsample was chosen from
 * questions where the brand was ALREADY visible, so "0 of 15" from that leg is
 * not a visibility rate for the basket — it is a rate over a deliberately
 * non-random slice. A number that cannot be read as a percentage must not ship
 * without the sentence that says so.
 *
 * Pure functions, no I/O (the caller passes its own existence check), so the
 * whole pre-flight is unit-testable without running the CLI.
 */
import { providerLabel } from './report/instrument-caveat.js';

/** Marker written on questions the declared subsample did not cover. */
export const MISSING_MENTION = 'missing';

/**
 * Read `--declared-subset=<name>` / `--declared-subset <name>` out of argv.
 *
 * @param {string[]} argv
 * @returns {string|null} the subsample name, or null when not declared
 */
export function parseDeclaredSubset(argv) {
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('--declared-subset=')) {
      const name = arg.slice('--declared-subset='.length).trim();
      return name || null;
    }
    if (arg === '--declared-subset') {
      const next = list[i + 1];
      if (typeof next === 'string' && !next.startsWith('--')) return next.trim() || null;
      return null;
    }
  }
  return null;
}

/**
 * Split the basket into the questions this paste directory covers and the ones
 * it does not.
 *
 * @param {Object} args
 * @param {string[]} args.queries the config's query texts, in basket order
 * @param {(index: number) => boolean} args.hasFile 1-based query number → is its paste file on disk
 * @returns {{covered: number[], uncovered: number[]}} 1-based query numbers
 */
export function planSubsetCoverage({ queries, hasFile }) {
  const covered = [];
  const uncovered = [];
  for (let i = 0; i < (queries?.length || 0); i++) {
    const n = i + 1;
    (hasFile(n) ? covered : uncovered).push(n);
  }
  return { covered, uncovered };
}

/**
 * The selection-bias sentence that travels with every declared subsample.
 *
 * @param {string} name
 * @param {number} covered
 * @param {number} total
 * @returns {string}
 */
export function subsetBiasWarning(name, covered, total) {
  return `This leg covered ${covered} of ${total} questions — the fixed subsample "${name}", not a random sample of the basket. `
    + `Read its result as a count over those ${covered} questions; it is not a visibility percentage for the basket, `
    + `and the questions it leaves out are not misses.`;
}

/**
 * The stamp written into `_summary.json` when a leg was imported as a declared
 * subsample. Present only on such runs — a full leg writes nothing, so its
 * summary is byte-identical to one produced before this feature existed.
 *
 * @param {Object} args
 * @param {string} args.name
 * @param {string} args.provider
 * @param {number[]} args.covered 1-based query numbers actually pasted
 * @param {number} args.total questions in the basket
 * @returns {{name:string, provider:string, covered:number, total:number, questions:number[], warning:string}}
 */
export function buildDeclaredSubsetStamp({ name, provider, covered, total }) {
  return {
    name,
    provider,
    covered: covered.length,
    total,
    questions: [...covered],
    warning: subsetBiasWarning(name, covered.length, total),
  };
}

/**
 * A cell for a question the declared subsample never asked.
 *
 * It is a REAL row, not an omission: the matrix has to show a gap where the
 * engine was not asked, and every count that walks `results` has to be able to
 * tell "asked and absent" from "never asked". Carrying `queryId` keeps it
 * identity-comparable with the same question measured by another leg (MEAS-1),
 * and there is no `sentiment`, `position` or `canonicalCitations` because none
 * were observed — a zero here would be a measurement we did not make.
 *
 * @param {Object} args
 * @returns {Object} a `_summary.json` result row
 */
export function buildMissingCell({ index, queryText, queryId, provider, label, model, market, tag, brandFit, subsetName }) {
  return {
    query: `Q${index}`,
    queryText,
    ...(queryId ? { queryId } : {}),
    ...(market ? { market } : {}),
    provider,
    label,
    model,
    source: 'manual-paste',
    mention: MISSING_MENTION,
    notAskedReason: `declared-subset:${subsetName}`,
    position: null,
    citationCount: 0,
    canonicalCitations: [],
    competitors: [],
    competitorsUnverified: [],
    ...(tag ? { tag } : {}),
    ...(brandFit ? { brandFit } : {}),
    hasBrandInCitations: false,
    responseExcerpt: null,
    elapsedMs: null,
  };
}

/**
 * The report-surface caveat for a declared subsample, shaped like the basket
 * and coverage caveats it sits beside (lib/report/instrument-caveat.js) so a
 * renderer treats all three the same way.
 *
 * @param {Object|null|undefined} stamp `summary.declaredSubset`
 * @returns {{title:string, sentences:string[]}|null}
 */
export function buildDeclaredSubsetCaveat(stamp) {
  if (!stamp || !stamp.name || !stamp.total) return null;
  const { name, covered, total, provider } = stamp;
  return {
    // NORMALISED, not repaired: run-manual already fills this field with
    // `PROVIDERS[name].label`, so today's stamps arrive as «Claude» and
    // `providerLabel` passes them straight through. The trap is the field NAME
    // — it says `provider`, which everywhere else in this codebase means the id
    // (`anthropic`, `openai`). A caller who reads the name and passes `r.provider`
    // would print «anthropic answered 15 of 50» on a page that says Claude in
    // every table beside it, and two names for one engine read as two engines.
    // One shared mapper closes that for both shapes; it is not a second dictionary.
    title: `${providerLabel(provider)} answered ${covered} of ${total} questions — the declared subsample "${name}"`,
    sentences: [
      `The other ${total - covered} questions were never put to this engine, so they count as neither a mention nor a miss, and they are absent from every rate this report publishes.`,
      stamp.warning,
    ],
  };
}
