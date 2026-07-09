/**
 * LLM-based citation domain classifier.
 *
 * Sends the top cited hostnames to an LLM and asks whether each belongs
 * to the brand's category or a different industry. Universal — works for
 * any language, country-specific domains, acronym collisions (e.g. AEO =
 * customs vs Answer Engine Optimization), etc.
 *
 * Result is cached in _summary.json so repeated `aeo-tracker report` runs
 * cost $0 after the first classification.
 */

import { CLASSIFY_OPTIONS_BY_PROVIDER } from '../providers/main-options.js';

/**
 * Extract unique hostnames from topCanonicalSources, strip tracking params,
 * return top N by count.
 */
export function extractHostnames(topCanonicalSources = [], limit = 10) {
  const seen = new Set();
  const result = [];
  for (const s of topCanonicalSources) {
    if (!s.url) continue;
    try {
      const host = new URL(s.url).hostname.replace(/^www\./, '');
      if (!seen.has(host)) {
        seen.add(host);
        result.push({ hostname: host, count: s.count || 1 });
      }
    } catch {
      // malformed URL — skip
    }
    if (result.length >= limit) break;
  }
  return result;
}

export function buildClassificationPrompt({ brand, category, hostnames }) {
  const numbered = hostnames
    .map((h, i) => `  ${i}. ${h.hostname}`)
    .join('\n');

  return `You are classifying website domains for an AEO visibility tracker.

The brand being tracked:
  BRAND: ${brand}
  CATEGORY: ${category}

These domains were cited by AI engines when answering queries about the brand.
Your job: identify domains from a COMPLETELY DIFFERENT, UNRELATED industry that
appeared due to keyword/acronym collision — NOT to filter broadly.

Mark onCategory: FALSE only when the domain clearly belongs to an unrelated industry:
  - Customs / trade compliance / import-export certification
  - Healthcare / medical / pharmaceutical
  - Financial services / banking / insurance (unless the brand is in fintech)
  - Legal / regulatory compliance
  - Heavy industry / manufacturing / logistics

Mark onCategory: TRUE for everything in the broader tech/SaaS/marketing ecosystem:
  - SaaS product review platforms (G2, Capterra, Product Hunt)
  - SEO, content marketing, growth agencies
  - General tech blogs, newsletters, thought leadership
  - Reddit, Wikipedia, Quora, news sites (these are legitimate AI authority sources)
  - Any agency, tool, or blog adjacent to digital marketing, software, or AI

The goal is to remove NOISE (wrong industry due to acronym collision), not to
narrow down to only exact-match sites. Be generous — if in doubt, mark true.

  industry: one short phrase describing what the domain is about. Be specific.
  confidence: "high" if obvious, "low" if genuinely ambiguous.

Domains to classify:

${numbered}

Return STRICT JSON:
{
  "results": [
    { "index": 0, "hostname": "g2.com",       "onCategory": true,  "industry": "SaaS software review platform", "confidence": "high" },
    { "index": 1, "hostname": "customs.pl",   "onCategory": false, "industry": "EU customs certification", "confidence": "high" },
    { "index": 2, "hostname": "simpletiger.com", "onCategory": true, "industry": "SEO agency for SaaS", "confidence": "high" }
  ]
}

Every domain must have exactly one result entry. Never skip an index.`;
}

export function parseClassificationResponse(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty classification response');
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
      catch { throw new Error(`Could not parse JSON from classification response: ${firstErr.message}`); }
    } else {
      throw new Error(`Could not parse JSON from classification response: ${firstErr.message}`);
    }
  }

  if (!Array.isArray(parsed?.results)) {
    throw new Error('Classification response missing results array');
  }
  return parsed;
}

/**
 * Run classification end-to-end.
 *
 * @param {Object} opts
 * @param {string}   opts.brand
 * @param {string}   opts.category
 * @param {Array}    opts.topCanonicalSources   from _summary.json
 * @param {Function} opts.providerCall          LLM caller (provider-agnostic)
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @returns {{ results, offCategoryDomains, onCategoryDomains, ranAt }}
 */
export async function classifyCitations({ brand, category, topCanonicalSources, providerCall, providerName, apiKey, model }) {
  if (!brand || !brand.trim()) throw new Error('brand is required');
  if (!category || !category.trim()) throw new Error('category is required');

  const hostnames = extractHostnames(topCanonicalSources, 10);
  if (hostnames.length === 0) {
    return { results: [], offCategoryDomains: [], onCategoryDomains: [], ranAt: new Date().toISOString() };
  }

  const prompt = buildClassificationPrompt({ brand, category, hostnames });

  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { text } = await providerCall(prompt, apiKey, model, {
        ...CLASSIFY_OPTIONS_BY_PROVIDER[providerName],
        webSearch: false,
      });
      // parseClassificationResponse already validates results array presence
      const parsed = parseClassificationResponse(text);

      const byIndex = new Map(parsed.results.map(r => [r.index, r]));
      const offCategoryDomains = [];
      const onCategoryDomains = [];

      hostnames.forEach((h, idx) => {
        const verdict = byIndex.get(idx);
        if (!verdict) {
          // LLM skipped this index — treat conservatively as off-category to avoid false negatives
          offCategoryDomains.push({ hostname: h.hostname, industry: 'unclassified (LLM skipped)', confidence: 'low' });
          return;
        }
        // Strict boolean check — reject "false" strings or null
        const isOff = verdict.onCategory === false;
        const entry = {
          hostname: h.hostname,
          industry: verdict.industry || 'unknown',
          confidence: verdict.confidence || 'low',
        };
        if (isOff) {
          offCategoryDomains.push(entry);
        } else {
          onCategoryDomains.push(entry);
        }
      });

      return { results: parsed.results, offCategoryDomains, onCategoryDomains, ranAt: new Date().toISOString() };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}
