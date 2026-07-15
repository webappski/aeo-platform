// Category compression for init auto-mode (1.1.8).
//
// Problem it solves: inferCategory() concatenates title + meta + h1 into a
// marketing sentence up to 160 chars. That string then (a) blurs the
// brainstorm prompt's CATEGORY_DESCRIPTION and (b) gets discarded by the
// recovery panel's ≤4-word guard, killing the category-filler fallback. This
// module asks the LLM (one tiny classify-tier call inside an init that is
// already paying for LLM calls) for a 2-5 word noun phrase instead.
//
// Contract: returns the clean phrase, or null on ANY failure — callers always
// fall back to the raw inferCategory() string. Never throws.

import { CLASSIFY_OPTIONS_BY_PROVIDER } from '../providers/main-options.js';

/**
 * @param {Object} opts
 * @param {string} opts.rawCategory   inferCategory() output (fallback text)
 * @param {Object} opts.site          parsed site content {title, metaDesc, h1}
 * @param {string} opts.brand
 * @param {Object} opts.provider      {providerCall, apiKey, model}
 * @param {number} [opts.maxWords=5]
 * @returns {Promise<string|null>}
 */
export async function cleanCategory({ rawCategory, site, brand, provider, maxWords = 5 }) {
  if (!provider?.providerCall) return null;
  const prompt = `Name this company's product category as a SHORT NOUN PHRASE of 2-${maxWords} words — the way a user would name the market in a search query (e.g. "AI conversational booking widget", "answer engine optimization tracker").

SITE TITLE: ${site?.title || '(none)'}
META: ${site?.metaDesc || '(none)'}
H1: ${(site?.h1 || []).join(' | ') || '(none)'}
RAW DESCRIPTION: ${rawCategory || '(none)'}

Rules: no brand names, no quotes, no trailing punctuation, 2-${maxWords} words.
Return ONLY the phrase, nothing else.`;

  try {
    const { text } = await provider.providerCall(prompt, provider.apiKey, provider.model, {
      ...CLASSIFY_OPTIONS_BY_PROVIDER[provider.name],
      webSearch: false,
    });
    if (!text || typeof text !== 'string') return null;
    const phrase = text.trim()
      .split('\n')[0]
      .replace(/^["'`«»\s]+|["'`«»\s.!]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!phrase) return null;
    const words = phrase.split(' ');
    if (words.length < 2 || words.length > maxWords + 1) return null;
    if (phrase.length > 60) return null;
    if (brand && phrase.toLowerCase().includes(String(brand).toLowerCase())) return null;
    return phrase;
  } catch {
    return null;
  }
}
