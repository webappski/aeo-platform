/**
 * Phase 3 of the v0.5 keyword research pipeline — local filter.
 *
 * Rejects candidates before the scoring/validation steps to save API cost
 * and keep the surviving pool clean.
 *
 * Hard filters (all produce explicit rejection reasons, no silent drops):
 *   - Contains brand or domain core
 *   - Duplicate (case-insensitive)
 *   - Below 3 words or above 12 words
 *   - Bare ambiguous acronym without its expansion present in the same query
 */

import { queryText } from '../../config/queries-normalize.js';

export const AMBIGUOUS_ACRONYMS = [
  { abbr: 'AEO', expansion: 'Answer Engine Optimization' },
  { abbr: 'GEO', expansion: 'Generative Engine Optimization' },
  { abbr: 'CRO', expansion: 'Conversion Rate Optimization' },
  { abbr: 'CDP', expansion: 'Customer Data Platform' },
  { abbr: 'CRM', expansion: 'Customer Relationship Management' },
  { abbr: 'ERP', expansion: 'Enterprise Resource Planning' },
  { abbr: 'ROI', expansion: 'Return on Investment' },
  { abbr: 'KPI', expansion: 'Key Performance Indicator' },
];

/**
 * Filter a flat candidate list produced by brainstorm.
 *
 * @param {Array<{ text: string, intent: string }>} flat
 * @param {Object} opts
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {Array} [opts.ambiguousAcronyms]  override default list if needed
 * @returns {{ kept: Array, rejected: Array }}
 */
export function filterCandidates(flat, { brand, domain, ambiguousAcronyms = AMBIGUOUS_ACRONYMS } = {}) {
  const kept = [];
  const rejected = [];
  const seen = new Set();

  const brandLower = (brand || '').toLowerCase().trim();
  const domainCore = (domain || '').toLowerCase().replace(/\.[a-z]{2,}$/i, '').trim();

  for (const cand of flat) {
    const text = typeof cand.text === 'string' ? cand.text.trim() : '';
    const intent = cand.intent;
    if (!text) {
      rejected.push({ ...cand, reason: 'empty' });
      continue;
    }
    const lower = text.toLowerCase();

    if (brandLower && lower.includes(brandLower)) {
      rejected.push({ text, intent, reason: `contains brand "${brand}"` });
      continue;
    }
    if (domainCore && domainCore.length >= 4 && lower.includes(domainCore)) {
      rejected.push({ text, intent, reason: `contains domain core "${domainCore}"` });
      continue;
    }

    if (seen.has(lower)) {
      rejected.push({ text, intent, reason: 'duplicate' });
      continue;
    }
    seen.add(lower);

    const wc = text.split(/\s+/).length;
    if (wc < 3) {
      rejected.push({ text, intent, reason: `too short (${wc} words)` });
      continue;
    }
    if (wc > 12) {
      rejected.push({ text, intent, reason: `too long (${wc} words)` });
      continue;
    }

    // Ambiguous acronym present without its expansion
    let ambiguous = null;
    for (const { abbr, expansion } of ambiguousAcronyms) {
      const abbrRegex = new RegExp(`\\b${abbr}\\b`, 'i');
      if (abbrRegex.test(text) && !lower.includes(expansion.toLowerCase())) {
        ambiguous = { abbr, expansion };
        break;
      }
    }
    if (ambiguous) {
      rejected.push({ text, intent, reason: `bare "${ambiguous.abbr}" without "${ambiguous.expansion}"` });
      continue;
    }

    // Rule A: comparison queries must not compare AI engine channels
    const IS_COMPARISON = /\b(vs\.?|versus|alternative|compared to|better than|instead of)\b/i;
    const AI_CHANNEL = /\b(chatgpt|gemini|claude|perplexity|copilot|llama|grok|mistral|bard|openai|gpt-?[34-9])\b/i;
    if (IS_COMPARISON.test(text) && AI_CHANNEL.test(text)) {
      rejected.push({ text, intent, reason: 'comparison query compares AI engine channels, not vendors' });
      continue;
    }

    kept.push({ text, intent });
  }

  return { kept, rejected };
}

/**
 * Vertical-intent diversity check (Guard 2).
 * Returns { ok, industries: [...], warning }.
 * If fewer than 3 distinct industries present across vertical-tagged candidates,
 * ok = false and warning string is populated for the user.
 */
export function checkVerticalDiversity(kept) {
  const verticals = kept.filter(c => c.intent === 'vertical');
  const INDUSTRY_KEYWORDS = {
    healthcare: /\b(healthcare|clinics?|hospitals?|medical|patients?|doctors?|nursing)\b/i,
    finance: /\b(fintech|finance|banking|banks?|insurance|trading|wealth)\b/i,
    ecommerce: /\b(ecommerce|e-commerce|retail|shopify|woocommerce|online stores?)\b/i,
    saas: /\bsaas\b/i,
    education: /\b(education|schools?|universities|edtech|learning|students?)\b/i,
    hospitality: /\b(hotels?|hospitality|travel|booking|airbnb|restaurants?)\b/i,
    legal: /\b(legal|law firms?|lawyers?|attorneys?|compliance)\b/i,
    manufacturing: /\b(manufacturing|factories|industrial|logistics|supply chain)\b/i,
    'real-estate': /\b(real estate|realtors?|property|landlords?|rentals?)\b/i,
    marketing: /\b(marketing|advertising|brand|growth teams?)\b/i,
    startups: /\b(startups?|founders?|early-stage|seed|pre-seed)\b/i,
  };

  const industriesHit = new Set();
  for (const v of verticals) {
    for (const [name, re] of Object.entries(INDUSTRY_KEYWORDS)) {
      if (re.test(v.text)) industriesHit.add(name);
    }
  }

  if (verticals.length === 0) {
    return { ok: false, industries: [], warning: 'No vertical-intent candidates survived filtering' };
  }
  if (industriesHit.size < 3) {
    return {
      ok: false,
      industries: [...industriesHit],
      warning: `Vertical candidates span only ${industriesHit.size} industry(ies): ${[...industriesHit].join(', ') || '(unclassified)'}. Guard 2 expects ≥3. Consider regenerating or broadening category description.`,
    };
  }
  return { ok: true, industries: [...industriesHit], warning: '' };
}

/**
 * Validate a final list of queries (e.g. read from .aeo-tracker.json before run).
 * Single chokepoint that catches ambiguous-acronym queries no matter how they
 * entered the config: --keywords flag, --manual mode, sample-config, hand-edited file.
 *
 * Accepts both the historical string form AND the AP-SEGMENT-LIVE `{q,brandFit}`
 * object form — the text is read via queryText so an object-shaped basket entry
 * is still acronym-checked (a bare `typeof q !== 'string'` skip would have
 * silently dropped the safety check for brand-fit-tagged queries).
 *
 * Returns a list of issues; caller decides whether to warn or hard-fail.
 *
 * @param {Array<string|{q:string}>} queries
 * @returns {Array<{ query, kind, abbr?, expansion?, message }>}
 */
export function validateQueries(queries, { ambiguousAcronyms = AMBIGUOUS_ACRONYMS } = {}) {
  const issues = [];
  for (const item of queries || []) {
    const q = queryText(item);
    if (!q || !q.trim()) continue;
    const lower = q.toLowerCase();
    for (const { abbr, expansion } of ambiguousAcronyms) {
      const abbrRegex = new RegExp(`\\b${abbr}\\b`, 'i');
      if (abbrRegex.test(q) && !lower.includes(expansion.toLowerCase())) {
        issues.push({
          query: q,
          kind: 'ambiguous-acronym',
          abbr,
          expansion,
          message: `bare "${abbr}" without "${expansion}" — likely matches the wrong industry in some geographies`,
        });
        break;
      }
    }
  }
  return issues;
}
