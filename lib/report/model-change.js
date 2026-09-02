// Did the INSTRUMENT change between two runs?
//
// WHY THIS MODULE EXISTS
// ----------------------
// The comparison engine already refuses to be fooled along the question axis:
// when the basket of questions shifts, `coverageAllowsDelta` (trend-model.js)
// declines to state a delta at all, because the two runs stopped measuring the
// same thing. There was no equivalent along the MODEL axis. A run measured on
// `gpt-5-search-api` and the next measured on `gpt-5.4-mini` produced a delta
// that read as the brand moving, and nothing anywhere said the ruler had been
// swapped.
//
// That is not a theoretical hole. On 2026-08-13, one brand, one set of three
// questions, one day, two OpenAI SKUs:
//
//   gpt-5-search-api   32 / 7 / 12 brand mentions   answers 8.5k / 6.5k / 6.7k chars
//   gpt-5.4-mini        8 / 0 /  0 brand mentions   answers 2.7k / 2.6k / 1.8k chars
//
// 3 of 3 questions versus 1 of 3 — 2 cells out of 12, ~17 percentage points,
// produced by the choice of model alone. The September run then went out on
// `gpt-5.4-mini`, the report said visibility fell 18 points, and its "where you
// lost ground" table named six competitors as having taken the space. The names
// were real strings in the answers; the story was not. The newer SKU had read
// the same question as being about browser extensions and listed those instead.
// Every link in that chain looked plausible and none of it was a fact about the
// brand's visibility.
//
// WHY THIS IS ATTRIBUTION AND NOT A GATE
// --------------------------------------
// The obvious move — copy `coverageAllowsDelta` and refuse to compare — is
// wrong here, and the founder said so explicitly on 2026-09-01: «пользователей
// не интересует, поменялась ли модель. Пользователей интересует его показатель:
// он улучшился или ухудшился. Это мы можем потом объяснить… Но никак мы не
// можем не сравнивать его движение».
//
// The two axes genuinely differ. When the question basket shifts there is
// literally nothing to compare — different questions, no shared quantity. When
// the model changes, the questions are identical and the movement is real; what
// is uncertain is HOW MUCH of it belongs to the brand. So the delta is always
// computed and always shown, and this module supplies the sentence that sits
// next to it naming the swap. A customer paying to watch a number may not be
// told the number is unavailable; they must be told what else moved.
//
// Pure functions, no I/O.

/** @type {string} Same id both runs. */
export const CHANGE_NONE = 'none';
/** @type {string} Same pointer, different dated snapshot (`…-mini` → `…-mini-2026-03-17`). */
export const CHANGE_SNAPSHOT = 'snapshot';
/** @type {string} Same family and tier, minor version step (`3.5-flash` → `3.6-flash`). */
export const CHANGE_MINOR = 'minor';
/** @type {string} Same family and tier, major version step (`gemini-3.x` → `gemini-4.x`). */
export const CHANGE_GENERATION = 'generation';
/** @type {string} Different product line / tier (`gpt-5-search-api` → `gpt-5.4-mini`). */
export const CHANGE_LINE = 'line';
/**
 * @type {string} The measurement SURFACE moved, not the model: a column switched
 * between a human-pasted answer from the engine's own app (`manual`) and a live
 * API call. `manual` is our own sentinel, not a vendor id, so this is a thing we
 * KNOW rather than a pair we failed to parse — and it is a bigger break in
 * comparability than any model step, since the two surfaces differ in retrieval,
 * personalisation and locale (see measurement-disclaimer.js).
 */
export const CHANGE_SURFACE = 'surface';
/** @type {string} Ids too dissimilar to relate (different vendor prefix, unparseable version). */
export const CHANGE_UNKNOWN = 'unknown';

/** The sentinel a pasted-answer cell records instead of a model id. */
const MANUAL = 'manual';

/**
 * How much of a movement a change of this kind can plausibly explain.
 *
 * CALIBRATED, not guessed, on the 2026-08-13 same-day pair above:
 *   line       - `gpt-5-search-api` → `gpt-5.4-mini` flipped 2 of 3 questions and
 *                cut answer length ~3×. A different product line answers a
 *                different question. STRONG.
 *   generation - a major-version step is at least as large a rewrite as a line
 *                change, and usually larger. STRONG.
 *   minor      - `gemini-3.5-flash` → `gemini-3.6-flash`, same day, same
 *                questions: 11/26/0 → 3/9/0 mentions. Every question kept its
 *                yes/no verdict; only the density moved. Enough to shift a rank
 *                or a tone average, not enough to explain a presence flip on its
 *                own. MODERATE.
 *   snapshot   - a pinned date under a stable pointer. Vendors ship these as
 *                bug-fix rollouts. NEGLIGIBLE — reported for provenance, never
 *                offered as an explanation.
 * @type {Readonly<Record<string, string>>}
 */
export const CHANGE_STRENGTH = Object.freeze({
  [CHANGE_NONE]: 'none',
  [CHANGE_SNAPSHOT]: 'negligible',
  [CHANGE_MINOR]: 'moderate',
  [CHANGE_GENERATION]: 'strong',
  [CHANGE_LINE]: 'strong',
  [CHANGE_SURFACE]: 'strong',
  [CHANGE_UNKNOWN]: 'moderate',
});

/** Kinds a report may offer as a partial explanation of a movement. */
const EXPLANATORY = new Set([
  CHANGE_MINOR, CHANGE_GENERATION, CHANGE_LINE, CHANGE_SURFACE, CHANGE_UNKNOWN,
]);

/**
 * A model id, taken apart far enough to compare two of them.
 *
 * Deliberately vendor-agnostic pattern matching rather than a table of known
 * ids: a table is the thing that goes stale the week a vendor renames its line,
 * which is the failure this whole module exists to catch.
 *
 * @param {string} id
 * @returns {{vendor: string, major: number|null, minor: number|null,
 *            variant: string, snapshot: string|null}|null}
 */
export function parseModelId(id) {
  if (typeof id !== 'string' || id.trim() === '') return null;
  const raw = id.trim().toLowerCase();
  // A trailing YYYY-MM-DD is a snapshot pin, never part of the variant.
  const snapMatch = raw.match(/-(\d{4}-\d{2}-\d{2})$/);
  const snapshot = snapMatch ? snapMatch[1] : null;
  const body = snapshot ? raw.slice(0, -(snapshot.length + 1)) : raw;

  const tokens = body.split('-').filter(Boolean);
  if (tokens.length === 0) return null;
  const vendor = tokens[0];

  let major = null;
  let minor = null;
  const variantParts = [];
  for (const tok of tokens.slice(1)) {
    // Anthropic writes `claude-haiku-4-5` (family first, then two version
    // tokens); OpenAI and Google write `gpt-5.4-mini` / `gemini-3.5-flash`
    // (one dotted version token). Both land here: the first number seen is the
    // major, a following bare number is the minor, and anything alphabetic
    // stays with the variant — `gpt-4o` keeps its trailing "o".
    const num = tok.match(/^(\d+)(?:\.(\d+))?([a-z]*)$/);
    if (num) {
      if (major === null) {
        major = Number(num[1]);
        if (num[2] !== undefined) minor = Number(num[2]);
      } else if (minor === null && num[2] === undefined && num[3] === '') {
        minor = Number(num[1]);
      } else {
        variantParts.push(tok);
        continue;
      }
      if (num[3]) variantParts.push(num[3]);
      continue;
    }
    variantParts.push(tok);
  }
  return { vendor, major, minor, variant: variantParts.join('-'), snapshot };
}

/**
 * Classify the step from one model id to another.
 *
 * @param {string|null} before
 * @param {string|null} after
 * @returns {{kind: string, strength: string, before: string|null, after: string|null}}
 */
export function classifyModelChange(before, after) {
  const mk = (kind) => ({ kind, strength: CHANGE_STRENGTH[kind], before: before ?? null, after: after ?? null });
  if (!before || !after) return mk(CHANGE_UNKNOWN);
  if (before === after) return mk(CHANGE_NONE);

  // A column moving between pasted-app answers and live API calls is a change of
  // SURFACE, and we know it exactly — `manual` is our own sentinel. Checked
  // first: parsed as a model id it would come out `unknown`, and the report
  // would then describe a methodology change with the copy written for "we
  // couldn't tell how big this was".
  if (before === MANUAL || after === MANUAL) return mk(CHANGE_SURFACE);

  const a = parseModelId(before);
  const b = parseModelId(after);
  if (!a || !b) return mk(CHANGE_UNKNOWN);
  if (a.vendor !== b.vendor) return mk(CHANGE_UNKNOWN);

  // Same pointer, different (or newly added) snapshot pin.
  if (a.variant === b.variant && a.major === b.major && a.minor === b.minor) {
    return mk(a.snapshot !== b.snapshot ? CHANGE_SNAPSHOT : CHANGE_NONE);
  }
  // A different tier or product line is the biggest step there is — it is a
  // different product, whatever the version numbers say. Checked BEFORE the
  // version comparison so `gpt-5-search-api` → `gpt-5.4-mini` is reported as
  // the line change it is, not as a minor version bump.
  if (a.variant !== b.variant) return mk(CHANGE_LINE);
  // Version comparison requires BOTH sides to have a version. Anthropic has
  // historically shipped family-only dated ids (`claude-sonnet-2026-04-19`, the
  // convention discover.js's own sort chain is written to survive), which parse
  // to `major: null`. Falling through would evaluate `null !== 4` as true and
  // assert a confident "generation change, strong" about a pair we cannot
  // actually order — a strong claim manufactured out of a missing field.
  if (a.major === null || b.major === null) return mk(CHANGE_UNKNOWN);
  if (a.major !== b.major) return mk(CHANGE_GENERATION);
  return mk(CHANGE_MINOR);
}

/**
 * The answer-surface model ids one run used, per provider.
 *
 * Reads `requestedModel` when present and falls back to `model`: runs recorded
 * before 2026-09-01 carry only the latter, and a comparison that ignored them
 * would be blind on exactly the historical pairs it is needed for. Training-mode
 * cells are excluded — `--depth=full` measures those on a deliberately different
 * base model, and counting them would report a change on every full run.
 *
 * @param {{results?: Array<Object>}} snapshot
 * @returns {Map<string, Set<string>>} provider → model ids
 */
export function modelsByProvider(snapshot) {
  const out = new Map();
  for (const row of snapshot?.results || []) {
    if (!row || row.mode === 'training') continue;
    const provider = row.provider;
    const model = row.requestedModel || row.model;
    if (!provider || !model) continue;
    if (!out.has(provider)) out.set(provider, new Set());
    out.get(provider).add(model);
  }
  return out;
}

/**
 * The providers one run measured at all, whether or not their rows recorded a
 * model id.
 *
 * Deliberately NOT derived from `modelsByProvider`: that map drops a provider
 * whose rows carry no `model`/`requestedModel` (legacy captures, a hand-seeded
 * fixture), and a coverage check built on it would then report a still-present
 * engine as having disappeared — inventing the exact false absence the coverage
 * sentence exists to prevent. Training-mode cells are excluded for the same
 * reason they are there: `--depth=full` measures those on a different base
 * model and they are not part of the tracked basket. `segmentCells` does NOT
 * skip them, so a provider appearing in a run ONLY as training rows would be
 * called "not measured this run" while its cells exist. `--depth=full` adds
 * training rows alongside the normal ones rather than instead of them, so that
 * shape is not reachable today; it is the thing to re-check if training-only
 * runs ever become a mode.
 *
 * @param {{results?: Array<Object>}} snapshot
 * @returns {Set<string>}
 */
export function providersIn(snapshot) {
  const out = new Set();
  for (const row of snapshot?.results || []) {
    if (!row || row.mode === 'training' || !row.provider) continue;
    out.add(row.provider);
  }
  return out;
}

/**
 * Per-provider engine changes between two runs.
 *
 * A provider present in only one of the two runs is NOT reported as a model
 * change — that is a coverage change, not an instrument swap, and classifying
 * it as one would double-count what the segment model already routes to
 * `indeterminate`. It is still NAMED, in `droppedProviders`/`addedProviders`:
 * until 2026-09-02 the distinction was drawn correctly and then nothing
 * rendered the coverage side, so an engine measured last run and skipped this
 * run left no trace in any sentence of any report.
 *
 * @param {{results?: Array<Object>}} prevSnapshot
 * @param {{results?: Array<Object>}} currSnapshot
 * @returns {{entries: Array<Object>, changedProviders: string[],
 *            explanatoryProviders: string[], noOverlapProviders: string[],
 *            droppedProviders: string[], addedProviders: string[],
 *            hasExplanatoryChange: boolean}}
 */
export function buildModelChanges(prevSnapshot, currSnapshot) {
  const prev = modelsByProvider(prevSnapshot);
  const curr = modelsByProvider(currSnapshot);
  const prevProviders = providersIn(prevSnapshot);
  const currProviders = providersIn(currSnapshot);
  const entries = [];

  for (const provider of [...curr.keys()].sort()) {
    if (!prev.has(provider)) continue;
    const beforeSet = prev.get(provider);
    const afterSet = curr.get(provider);
    const before = [...beforeSet].sort();
    const after = [...afterSet].sort();
    const overlap = before.filter((m) => afterSet.has(m));

    // The pair to describe: the newest run's primary id against the previous
    // run's. Both are single-valued on every run the tracker writes (one main
    // model per provider per run); the sets exist so a multi-model run is
    // reported honestly rather than crashing or silently picking one.
    const change = classifyModelChange(before[0], after[0]);
    const sameSet = before.length === after.length && before.every((m) => afterSet.has(m));

    entries.push({
      provider,
      before,
      after,
      kind: sameSet ? CHANGE_NONE : change.kind,
      strength: sameSet ? CHANGE_STRENGTH[CHANGE_NONE] : change.strength,
      changed: !sameSet,
      // No shared model at all — there is not one comparable cell on this
      // engine, as opposed to "the model moved but both runs saw the same one
      // somewhere". Gemini across 2026-08 → 2026-09 was exactly this: 3.5 and
      // 3.6 in August, 3.7 in September, zero intersection. The findings insist
      // this be named rather than folded into the general caveat.
      hasLikeForLike: overlap.length > 0,
      overlap,
    });
  }

  const changed = entries.filter((e) => e.changed);
  return {
    entries,
    changedProviders: changed.map((e) => e.provider),
    explanatoryProviders: changed.filter((e) => EXPLANATORY.has(e.kind)).map((e) => e.provider),
    noOverlapProviders: changed.filter((e) => !e.hasLikeForLike).map((e) => e.provider),
    droppedProviders: [...prevProviders].filter((p) => !currProviders.has(p)).sort(),
    addedProviders: [...currProviders].filter((p) => !prevProviders.has(p)).sort(),
    hasExplanatoryChange: changed.some((e) => EXPLANATORY.has(e.kind)),
  };
}

/**
 * "gpt-5-search-api → gpt-5.4-mini" for one entry — the «было → стало» the
 * founder asked for, in the only form that lets a reader verify it.
 * @param {{before: string[], after: string[]}} entry
 * @returns {string}
 */
export function formatModelTransition(entry) {
  return `${(entry?.before || []).join(' + ')} → ${(entry?.after || []).join(' + ')}`;
}
