/**
 * One re-ask when a report's classify-tier call comes back un-parseable.
 *
 * WHY THIS EXISTS
 * The report's LLM sections (competitor extraction, sentiment) ask two models
 * in parallel and cross-check them. When ONE of the two returns something that
 * is not JSON, that slot was simply lost: the section degraded to single-model
 * for that cell, every name fell into the `unverified` tier, and the run paid
 * for a call it threw away. A malformed body is the one provider failure that a
 * second ask reliably fixes — it is a sampling accident, not a broken key.
 *
 * WHAT IS AND IS NOT RETRIED — the distinction this module exists to hold.
 * Only `LlmParseError` (empty body, un-parseable JSON, missing field) is
 * re-asked. Provider / network / rate-limit failures are ALREADY retried
 * exhaustively inside `providerCall` (`withRetry`); re-running the whole
 * classification on top of that multiplies an exhausted chain, which is the
 * storm `lib/init/research/parse-error.js` was written to stop. Same rule, same
 * error class, same one-extra-attempt budget as `runBrainstorm` and
 * `runSimulation` — this module is that pattern made reusable, not a new policy.
 *
 * WHICH MODEL ANSWERS THE RE-ASK
 * A DIFFERENT vendor when one is available, because a model that just failed to
 * produce JSON is the model most likely to fail again on the same text. The
 * third research-capable provider is exactly the one `buildExtractionProviders`
 * builds and then drops on the floor (`built[2]`) — so on a three-key install
 * the re-ask costs nothing new to arrange. With two keys (our own runs) there is
 * no third vendor and the re-ask goes back to the same model, which is the house
 * pattern above and still fixes a one-off malformed body.
 *
 * INDEPENDENCE IS NOT FAKED. The re-ask replaces ONE SLOT's answer. The
 * cross-check is still slot-vs-slot, two different vendors, exactly as before —
 * a repaired primary is compared against the untouched secondary, never against
 * itself. No path here can turn one model's two samples into "both models
 * agreed".
 *
 * COST. At most one extra classify-tier call per failed cell, and only on a
 * parse failure — ~$0.0008 at the cheap tier. The first, failed call is already
 * paid for and its usage is unrecoverable (the throw loses the raw body); the
 * returned `costInfo` is the re-ask's, which is what actually produced the
 * value.
 */
import { LlmParseError } from '../init/research/parse-error.js';

/**
 * Who answers the re-ask for `slot`: the first fallback from a DIFFERENT vendor,
 * or `slot` itself when there is none.
 *
 * Pure. `fallbacks` is whatever the caller has spare — `buildExtractionProviders`
 * passes the research-capable providers that did not get one of the two seats.
 *
 * @param {{name: string}} slot
 * @param {Array<{name: string}>} [fallbacks]
 * @returns {{name: string}} never null — the same slot is a valid answer
 */
export function retryProviderFor(slot, fallbacks = []) {
  const other = (fallbacks || []).find((p) => p && p.name && p.name !== slot.name);
  return other || slot;
}

/**
 * Run one classify-tier attempt, and on an un-parseable response run exactly one
 * more (see the header for who answers it).
 *
 * `attempt(provider)` performs the call and returns `{ value, costInfo }`, or
 * throws. Section-specific shape stays in the section — this module only owns
 * "ask again, once, and only for this reason".
 *
 * @param {Object} args
 * @param {{name: string}} args.slot        the provider that owns this seat
 * @param {Array<{name: string}>} [args.fallbacks]
 * @param {(p: Object) => Promise<{value: any, costInfo: any}>} args.attempt
 * @returns {Promise<{
 *   ok: boolean, value?: any, costInfo?: any, error?: string,
 *   errorKind?: 'parse'|'provider', servedBy: string, retriedOn?: string
 * }>}  `retriedOn` is the vendor id of the re-ask, or 'same-model' when the slot
 *      answered again — present ONLY when a re-ask actually happened, so its
 *      absence means the first answer parsed.
 */
export async function runWithParseRetry({ slot, fallbacks = [], attempt }) {
  const msgOf = (e) => (e instanceof Error ? e.message : String(e));
  try {
    const first = await attempt(slot);
    return { ok: true, value: first.value, costInfo: first.costInfo, servedBy: slot.name };
  } catch (err) {
    if (!(err instanceof LlmParseError)) {
      // Provider / network / auth — already retried where retrying helps.
      return { ok: false, error: msgOf(err), errorKind: 'provider', servedBy: slot.name };
    }
    const retry = retryProviderFor(slot, fallbacks);
    const retriedOn = retry.name === slot.name ? 'same-model' : retry.name;
    try {
      const second = await attempt(retry);
      return { ok: true, value: second.value, costInfo: second.costInfo, servedBy: retry.name, retriedOn };
    } catch (err2) {
      return {
        ok: false,
        error: msgOf(err2),
        // The kind of the SECOND failure: a re-ask that died on the network is
        // not evidence that the model cannot produce JSON, and the degradation
        // marker downstream reads this field to name the cause.
        errorKind: err2 instanceof LlmParseError ? 'parse' : 'provider',
        servedBy: retry.name,
        retriedOn,
      };
    }
  }
}
