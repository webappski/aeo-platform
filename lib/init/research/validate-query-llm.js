/**
 * Phase 6 — LLM-based industry-fit validator.
 *
 * Catches ambiguity classes the static AMBIGUOUS_ACRONYMS list can't: novel acronyms,
 * geography-dependent interpretations, regular words with multiple industry meanings.
 *
 * Anti-hallucination guards:
 *   - Strict JSON output (no prose/markdown).
 *   - Model must LIST ≥2 alternate meanings BEFORE verdict — flips the default from
 *     "yes" to "justify", since enumerating plausible alternatives forces the model
 *     to consider failure modes instead of rubber-stamping.
 *   - Few-shot counter-example ("AEO consultants Poland" → customs) concretises the
 *     failure mode we've actually observed in production.
 *   - Confidence floor: caller decides threshold (recommended: 0.7).
 *
 * Cost: ~$0.0005 per init at Haiku/4o-mini prices. Offsets one bad $0.15 run at
 * 1% hit-rate — 1000× ROI.
 */

import { extractUsage, calcCost } from '../../providers/pricing.js';
import { CLASSIFY_OPTIONS_BY_PROVIDER } from '../../providers/main-options.js';

/**
 * Confidence floor below which a verdict is treated as "uncertain" and
 * upgraded to a warning/block. Single source of truth.
 */
export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Single source of truth for the `search_behavior` discriminant. The LLM is
 * instructed to return one of these literal strings; the validator + run-time
 * flow match on these constants instead of string literals sprinkled across files.
 *
 *   - RETRIEVAL:  the query will trigger live retrieval of fresh web content
 *     (ranked lists, "best X 2026", commercial comparisons). AEO visibility is
 *     measurable here — if you're not in the list, you're genuinely absent.
 *   - PARAMETRIC: AI answers from training data alone, no live retrieval
 *     ("what is AEO", "history of search engines"). "0% visibility" here means
 *     "the model didn't learn the brand", NOT "the brand doesn't rank".
 *   - MIXED:      could go either way; conservative policy treats it like PARAMETRIC.
 */
export const SEARCH_BEHAVIORS = Object.freeze({
  RETRIEVAL:  'retrieval-triggered',
  PARAMETRIC: 'parametric-only',
  MIXED:      'mixed',
});

export function buildValidatorPrompt({ brand, domain, category, geography, queries }) {
  const geoLine = Array.isArray(geography) && geography.length > 0
    ? `GEOGRAPHY SIGNALS: ${geography.join(', ')}`
    : 'GEOGRAPHY SIGNALS: none inferred (assume global English-speaking audience)';

  const numbered = queries.map((q, i) => `  ${i + 1}. "${q}"`).join('\n');

  return `You are a strict query validator for an AEO (Answer Engine Optimization) visibility tracker.
Your sole job: determine whether each search query is LIKELY to return results from the CORRECT industry for this brand, in the specified geography.

BRAND:    ${brand}
DOMAIN:   ${domain}
CATEGORY: ${category || '(not specified)'}
${geoLine}

WHY THIS MATTERS:
Wrong-industry queries waste API budget and produce misleading "0% visibility" numbers.
A user reading "0% mentions for AEO consultants Poland" should be able to trust that number means
"the brand isn't cited by AI for Answer Engine Optimization in Poland" — NOT "the query accidentally
measured Polish customs consultancies because 'AEO' = Authorized Economic Operator in that region".

FAILURE MODES TO CATCH (three distinct classes):

  A. Geography-dependent acronym.
     "AEO consultants Poland" — in Poland "AEO" = Authorized Economic Operator (customs)
     → INVALID for an Answer Engine Optimization brand. Rewrite: "Answer Engine Optimization consultants Poland".

  B. Concept-vs-vendor confusion (informational query disguised as commercial).
     "best machine learning" — AI returns course/tutorial recommendations, not vendors.
     → INVALID for a SaaS/tooling brand. Rewrite: "best machine learning platforms for enterprise".

  C. Domain collision (brand-like word with dominant non-brand meaning).
     "apple integrations" for a fruit-distribution company — AI returns Apple Inc. integrations.
     → INVALID. Rewrite: "apple fruit distribution partners".

  Also watch for: parametric-only queries ("history of CRM software") where AI answers from memory
  without live retrieval — these measure model training data, not live search visibility.

WHAT IS NOT A FAILURE (do NOT reject these):

  D. Adjacent-market commercial query (broader category, same industry) → VALID.
     "best appointment scheduling services for salons" for a conversational booking widget
     configurable for salons → VALID, even though AI will list general scheduling platforms
     rather than conversational widgets specifically. The brand legitimately competes for
     citations in the broader vendor list of ITS OWN target vertical — measuring presence
     there is exactly what an AEO tracker is for. Reject ONLY when the dominant
     interpretation belongs to a DIFFERENT industry (classes A/C above), never because the
     query is merely broader than the brand's exact product class.

RETRIEVABILITY CLASSIFICATION (new requirement):
  For each query, decide whether an AI answer engine would trigger LIVE WEB RETRIEVAL or
  answer from parametric (training) knowledge alone:
    - "retrieval-triggered": query demands fresh/specific info (ranked lists, "2026", "best X for Y")
    - "parametric-only":     concepts/definitions ("what is AEO", "history of SEO")
    - "mixed":                could go either way

  parametric-only queries produce "0% visibility" not because the brand doesn't rank — they produce
  it because the model didn't learn about the brand. Flag them so the user understands what's measured.

PROCESS FOR EACH QUERY (follow strictly, in order):
  1. LIST at least 2 plausible meanings/interpretations of the query in the target geography.
  2. DETERMINE which interpretation is DOMINANT for an AI answer engine in that geography.
  3. COMPARE the dominant interpretation against BRAND + CATEGORY. Does it align?
  4. CLASSIFY search_behavior (retrieval-triggered / parametric-only / mixed).
  5. ASSIGN confidence 0.00–1.00. Use <${CONFIDENCE_THRESHOLD} if multiple meanings are plausible.
  6. WRITE a short reason (≤25 words) referencing what an AI engine would actually return.

QUERIES TO VALIDATE:
${numbered}

Return STRICT JSON only. No markdown fences. No prose outside the JSON. Format:
{
  "results": [
    {
      "index": 1,
      "query": "...",
      "alternate_meanings": ["Meaning A (industry/context)", "Meaning B (industry/context)"],
      "dominant_interpretation": "string",
      "search_behavior": "retrieval-triggered",
      "valid": true,
      "confidence": 0.85,
      "reason": "short explanation referencing what AI would return"
    }
  ]
}`;
}

function parseValidatorJson(text) {
  if (!text || typeof text !== 'string') throw new Error('empty validator response');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fall through */ }
  }
  throw new Error('validator returned unparseable JSON');
}

/**
 * @param {Object} opts
 * @param {string[]} opts.queries
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {string} opts.category
 * @param {string[]} [opts.geography]
 * @param {Function} opts.providerCall  (prompt, apiKey, model, options) => { text, raw }
 * @param {string} opts.providerName    'openai' | 'anthropic' | 'gemini' — for cost calc
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @returns {Promise<{ results: Array, costInfo: object }>}
 */
export async function validateQueriesWithLLM({
  queries, brand, domain, category, geography = [],
  providerCall, providerName, apiKey, model,
}) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return { results: [], costInfo: null };
  }

  const prompt = buildValidatorPrompt({ brand, domain, category, geography, queries });
  const { text, raw } = await providerCall(prompt, apiKey, model, {
    ...CLASSIFY_OPTIONS_BY_PROVIDER[providerName],
    webSearch: false,
  });

  const parsed = parseValidatorJson(text);
  if (!Array.isArray(parsed?.results)) {
    throw new Error('validator JSON missing "results" array');
  }

  const results = parsed.results.map(r => {
    const idx = Number(r.index);
    const fromIdx = Number.isFinite(idx) && idx >= 1 && idx <= queries.length
      ? queries[idx - 1]
      : null;
    const searchBehavior = typeof r.search_behavior === 'string'
      ? r.search_behavior.toLowerCase()
      : '';
    return {
      query: r.query || fromIdx || '',
      valid: r.valid === true,
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
      alternate_meanings: Array.isArray(r.alternate_meanings) ? r.alternate_meanings.slice(0, 5) : [],
      dominant_interpretation: typeof r.dominant_interpretation === 'string' ? r.dominant_interpretation : '',
      search_behavior: ['retrieval-triggered', 'parametric-only', 'mixed'].includes(searchBehavior)
        ? searchBehavior
        : 'mixed',
      reason: typeof r.reason === 'string' ? r.reason : '',
    };
  });

  const usage = extractUsage(providerName, raw);
  const cost = calcCost(model, usage) || { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0 };
  const costInfo = {
    provider: providerName,
    model,
    label: 'query-validation',
    requests: 1,
    inputTokens:  cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUsd:      cost.costUsd,
  };

  return { results, costInfo };
}
