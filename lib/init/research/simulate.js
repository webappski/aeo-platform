/**
 * Phase 5 — Result simulation.
 *
 * For each validated candidate query, asks an LLM:
 * "What 5 websites would AI engines most likely cite when answering this query?"
 *
 * If ≥2 predicted sites are off-category, the query is marked simulationFailed
 * and a suggestedFix (unambiguous rewrite) is returned.
 *
 * This catches geographic + acronym collisions that pass text-level validation:
 * e.g. "AEO consultants Poland" looks like AEO marketing but AI engines return
 * Polish customs certification sites.
 */

import { LlmParseError } from './parse-error.js';

export function buildSimulationPrompt({ brand, category, candidates }) {
  const numbered = candidates.map((c, i) => `  ${i}. ${c.text}`).join('\n');

  return `You are testing search queries for an AEO (Answer Engine Optimization) visibility tracker.

Brand: ${brand}
Category: ${category}

For each query below, do TWO things:

1. Predict the 5 domain names an AI search engine (ChatGPT, Gemini, Perplexity) would most
   likely cite when answering that query. Be realistic — predict what the engine would
   actually return, not what the user intends.

2. Assess: are those predicted domains primarily about the brand's CATEGORY above,
   or about a DIFFERENT industry?

CRITICAL rules:
- If a query uses an ABBREVIATION + COUNTRY/REGION, evaluate the dominant meaning of that
  abbreviation in that geography. Example: "AEO" in Poland / EU context = Authorized
  Economic Operator (customs certification), NOT Answer Engine Optimization. Such queries
  are off-category.
- If predicted domains are a mix of industries, consider the MAJORITY (≥3 of 5).
- If the query is off-category, suggest a rewritten version that uses the FULL TERM
  (not abbreviation) to remove ambiguity.

Queries to simulate:

${numbered}

Return STRICT JSON:
{
  "results": [
    {
      "index": 0,
      "predictedDomains": ["example.pl", "other.com", "third.eu", "fourth.de", "fifth.sk"],
      "onCategory": false,
      "dominantIndustry": "EU customs certification (Authorized Economic Operator)",
      "suggestedFix": "Answer Engine Optimization consultants Poland"
    },
    {
      "index": 1,
      "predictedDomains": ["seo-blog.com", "searchengineland.com", "ahrefs.com", "semrush.com", "moz.com"],
      "onCategory": true,
      "dominantIndustry": "SEO and search optimization",
      "suggestedFix": null
    }
  ]
}

Every query must have exactly one result. Never skip an index. suggestedFix must be null when onCategory is true.`;
}

export function parseSimulationResponse(text) {
  if (!text || typeof text !== 'string') throw new LlmParseError('Empty simulation response');
  let cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (firstErr) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); }
      catch { throw new LlmParseError(`Could not parse simulation JSON: ${firstErr.message}`); }
    } else {
      throw new LlmParseError(`Could not parse simulation JSON: ${firstErr.message}`);
    }
  }

  if (!Array.isArray(parsed?.results)) {
    throw new LlmParseError('Simulation response missing results array');
  }
  return parsed;
}

/**
 * Run simulation for a batch of candidates.
 *
 * @param {Object} opts
 * @param {Array}    opts.candidates      validated candidates from Phase 4
 * @param {string}   opts.brand
 * @param {string}   opts.category
 * @param {Function} opts.providerCall
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @returns {{ passed, failed, skippedAboveLimit }}
 *   passed  — candidates where simulation confirmed on-category results
 *   failed  — candidates where predicted results were off-category (with suggestedFix)
 *   skippedAboveLimit — candidates not simulated (beyond cap), returned as-is
 */
export async function runSimulation({ candidates, brand, category, providerCall, apiKey, model }) {
  // Only simulate top-15 by score — controls cost
  const batch = candidates.slice(0, 15);
  const beyond = candidates.slice(15).map(c => ({ ...c, simulation: 'skipped-beyond-cap' }));

  const prompt = buildSimulationPrompt({ brand, category, candidates: batch });

  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { text } = await providerCall(prompt, apiKey, model, { webSearch: false });
      const parsed = parseSimulationResponse(text);
      const byIndex = new Map(parsed.results.map(r => [r.index, r]));

      const passed = [];
      const failed = [];

      batch.forEach((cand, idx) => {
        const result = byIndex.get(idx);
        if (!result) {
          // LLM missed this index — conservative: treat as passed (not penalise)
          passed.push({ ...cand, simulation: 'missing-verdict' });
          return;
        }
        if (result.onCategory === false) {
          failed.push({
            ...cand,
            simulation: 'failed',
            simulationDetails: {
              predictedDomains: result.predictedDomains || [],
              dominantIndustry: result.dominantIndustry || '',
              suggestedFix: result.suggestedFix || null,
            },
          });
        } else {
          passed.push({
            ...cand,
            simulation: 'ok',
            simulationDetails: {
              predictedDomains: result.predictedDomains || [],
              dominantIndustry: result.dominantIndustry || '',
            },
          });
        }
      });

      return { passed, failed, skippedAboveLimit: beyond };
    } catch (err) {
      // Only re-ask on a bad/un-parseable LLM response. Provider/network/rate-
      // limit errors are already retried inside providerCall (withRetry) — retrying
      // them here would just re-run the whole exhausted chain.
      if (!(err instanceof LlmParseError)) throw err;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}
