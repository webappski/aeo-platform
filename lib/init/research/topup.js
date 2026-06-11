// One-round candidate top-up for the init pipeline (1.1.8).
//
// Problem it solves: brainstorm produces 5 candidates; the two-stage validator
// can fail 3+ of them, leaving fewer than 3 passing queries. The old flow
// dead-ended into the recovery panel even though the pipeline had computed
// machine-readable rejection reasons — and then threw them away. This module
// closes the loop: ONE extra brainstorm round with those reasons fed back as
// negative guidance, then validation of only the genuinely new texts.
//
// Hard bounds (cost guard): exactly one round, one brainstorm call, one
// validation call. If the top-up still doesn't reach 3 passing queries the
// caller falls back to the recovery panel as before.

import { runBrainstorm } from './brainstorm.js';
import { SEARCH_BEHAVIORS } from './validate-query-llm.js';

/**
 * @param {Object} opts
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {Object} opts.site                parsed site content (may be empty-shape)
 * @param {string} opts.categoryDescription
 * @param {string[]} [opts.audienceTags]
 * @param {string[]} [opts.geoTags]
 * @param {Array<{query:string,reason:string}>} opts.avoidFeedback
 *        rejection reasons from the failed round — fed into the brainstorm prompt
 * @param {Iterable<string>} opts.existingTexts  all candidate texts already seen (dedup)
 * @param {Object} opts.provider            research provider {providerCall, apiKey, model}
 * @param {(queries: string[]) => Promise<Array>} opts.validateBatch
 *        injected validator — returns verdict objects ({query, valid, search_behavior, ...})
 * @param {Function} [opts.runBrainstormImpl]  injectable for tests
 * @returns {Promise<{added: Array, verdicts: Array, attempted: string[]}>}
 *        added    = passing candidates ({text, intent, score:0, topUp:true, valid, search_behavior, confidence})
 *        verdicts = ALL new verdicts (callers merge into the validation seed cache)
 *        attempted = the deduped new texts that were validated
 */
export async function topUpCommercialCandidates({
  brand, domain, site, categoryDescription, audienceTags = [], geoTags = [],
  avoidFeedback = [], existingTexts = [],
  provider, validateBatch,
  runBrainstormImpl = runBrainstorm,
}) {
  const seen = new Set([...existingTexts].map(t => String(t).toLowerCase()));

  const shape = await runBrainstormImpl({
    brand, domain, site, categoryDescription, audienceTags, geoTags,
    providerCall: provider.providerCall,
    apiKey: provider.apiKey,
    model: provider.model,
    avoidFeedback,
  });

  const fresh = (shape.flat || []).filter(c => c?.text && !seen.has(c.text.toLowerCase()));
  if (fresh.length === 0) return { added: [], verdicts: [], attempted: [] };

  const attempted = fresh.map(c => c.text);
  const verdicts = await validateBatch(attempted);
  const byQuery = new Map((verdicts || []).map(v => [v.query, v]));

  const added = [];
  for (const cand of fresh) {
    const v = byQuery.get(cand.text);
    if (!v) continue; // no verdict → fail closed for top-ups (they exist to be safe)
    if (v.valid === true && v.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL) {
      added.push({
        text: cand.text,
        intent: cand.intent || 'commercial',
        score: 0,          // rank below originally-scored candidates
        topUp: true,       // traceability flag (existing 1.0.4 convention)
        valid: v.valid,
        search_behavior: v.search_behavior,
        confidence: v.confidence,
      });
    }
  }

  return { added, verdicts: verdicts || [], attempted };
}
