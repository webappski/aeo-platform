/**
 * LLM-based competitor extraction with two-model parallel cross-check.
 *
 * Replaces the old regex extractor + aggregate classifier with a single
 * semantic step: ask two cheap models to list brands-mentioned-as-recommendations
 * in each response, then merge their answers.
 *
 * Merge semantics (case-insensitive, first-seen canonical form):
 *   - Both models list the name  → verified  (strong signal)
 *   - Only one model lists it    → unverified (weaker signal, rendered dashed)
 *   - Neither lists it           → dropped (never surfaces)
 *
 * Hallucination guard: each returned name must appear verbatim (case-insensitive)
 * in the source response text. A model that invents "HubSpot" when the text
 * doesn't mention it gets its invented entry silently filtered before merge.
 *
 * Cost: ~$0.001 per cell × 9 cells = ~$0.008 per run at gpt-5.4-mini +
 * gemini-2.5-flash pricing.
 */

import { extractUsage, calcCost } from '../providers/pricing.js';

/**
 * Strict-JSON prompt. Low temperature expected at call site.
 * Identical for both models so responses are directly comparable.
 *
 * `category` is the user's competitive category (e.g. "Answer Engine Optimization
 * services" or "Customer Relationship Management software"). It turns the extractor
 * from "any brand mentioned as a recommendation" into "direct alternative in the
 * user's category" — otherwise methodology queries ("how to get recommended by AI")
 * flood the output with Reddit, G2, Trustpilot, LinkedIn etc., which are mentioned
 * as useful platforms but are not COMPETITORS to the user's product.
 */
export function buildExtractorPrompt({ text, brand, domain, category }) {
  const categoryLine = category
    ? `\nUSER CATEGORY: ${category}\nFor each candidate name, silently ask: "Is this entity a VENDOR or PRODUCT in the same category as ${brand} — i.e., '${category}'?" If the answer is NO (including "mentioned in passing", "retailer using the category as a customer", "infrastructure provider one tier below the category", "unrelated industry"), exclude it. Only DIRECT ALTERNATIVES to the user's offering in this category qualify as competitors.`
    : '';

  return `You extract COMPETITOR brand/product/agency names from an AI answer-engine response.

The user's brand is "${brand}" (domain: ${domain}).${categoryLine}

A COMPETITOR is a real company, product, or service that a buyer could choose INSTEAD OF the user's brand, in the SAME category. The category test is binary: vendor/product in this category → competitor; everything else → not a competitor.

EXCLUDE (not competitors, even if mentioned as useful or prominent):
  - The user's own brand
  - AI-engines themselves when they're the subject (ChatGPT, Gemini, Claude, Perplexity) unless the user's category is "AI assistants"
  - Big Tech and major retailers mentioned as EXAMPLES, CUSTOMERS, or CASE STUDIES of the category — NOT vendors in the category themselves. e.g. "Amazon, Walmart, and Starbucks integrate voice UX into their apps" → NONE of those are voice-UX vendors, they are retailers who USE the category. Exclude unless the user's category is "e-commerce platforms" / "coffee chains" / etc.
  - Infrastructure/API providers ONE TIER BELOW the user's category (e.g. for a voice-form-filling product: Whisper, AssemblyAI, Deepgram, Web Speech API, OpenAI Realtime API are STT/voice-input building blocks, not voice-form competitors). Include them ONLY if the user's category IS that infrastructure layer (e.g. category = "speech-to-text API").
  - Consulting agencies, integrators, system houses mentioned as "X built this for client Y" UNLESS they ship a productised offering in the user's category.
  - Data sources / review platforms / social networks / publications (Reddit, G2, Trustpilot, Quora, LinkedIn, Slack, Discord, YouTube, Wikipedia, TechCrunch, Wired, Yelp, Capterra) unless the user's category is "review platforms" or similar
  - Tooling unrelated to the user's category (Upwork, Toptal, Shopify, WhatsApp, Zoom)
  - Companies in a different industry that happen to be name-dropped (e.g. a fintech mentioned for context when the user's category is voice forms)
  - Metrics, KPIs, methodologies ("Citation Rate", "Share of Voice")
  - Process steps / imperatives ("Build a Prompt Library", "Establish a Baseline")
  - Section headers / generic categories ("Content Freshness", "Technical Optimization")
  - Names mentioned only as contrast ("Unlike X, we ...") — those are not recommendations

EXAMPLES:
  Category: "Answer Engine Optimization services"
    "Top AEO agencies: NoGood, Minuttia, Optimist"
      → brands: ["NoGood", "Minuttia", "Optimist"]
    "To get recommended by AI, get reviews on G2 and be mentioned on Reddit and TechCrunch"
      → brands: []   (G2, Reddit, TechCrunch are data sources, not AEO competitors)

  Category: "CRM software"
    "Leading CRMs include Salesforce, HubSpot, Pipedrive"
      → brands: ["Salesforce", "HubSpot", "Pipedrive"]

  Category: "voice form filling solution for e-commerce checkout"
    "Retailers like Amazon, Walmart, and Starbucks integrate voice UX into shopping. Tools that power this include Whisper and AssemblyAI. Vellis is a fintech exploring conversational checkout."
      → brands: []   (Amazon/Walmart/Starbucks = retailers as customers; Whisper/AssemblyAI = STT infra one tier below; Vellis = unrelated industry mentioned in passing)
    "Voice form vendors include VoiceForm, SpeakEasy Forms, and Typeform's voice beta"
      → brands: ["VoiceForm", "SpeakEasy Forms", "Typeform"]

RULES:
  1. Return canonical form (original casing/punctuation from source).
  2. Do NOT invent names — every returned name must appear verbatim in the source text.
  3. Deduplicate.
  4. When in doubt — return empty. Empty is correct and useful.

Return STRICT JSON, no markdown, no prose:
{ "brands": ["Name1", "Name2", ...] }

SOURCE TEXT:
${text}`;
}

/**
 * Parse strict JSON from the LLM with a tolerant fallback (strips code fences,
 * extracts first balanced {...} block). Throws on malformed output — no silent
 * fallthrough, the caller decides how to recover.
 */
export function parseExtractorResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('extractor returned empty response');
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('extractor response is not JSON and contains no {...} block');
    try { parsed = JSON.parse(m[0]); }
    catch (err) { throw new Error(`extractor response unparseable: ${err.message}`); }
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.brands)) {
    throw new Error('extractor JSON missing "brands" array');
  }
  return parsed.brands
    .filter(b => typeof b === 'string')
    .map(b => b.trim())
    .filter(b => b.length > 0);
}

/**
 * Drops names that don't appear verbatim (case-insensitive) in the source text.
 * Catches hallucinations where a model invents a plausible-sounding brand that
 * the response never mentioned.
 */
export function filterHallucinations(brands, sourceText) {
  const lowerSource = (sourceText || '').toLowerCase();
  return brands.filter(name => lowerSource.includes(name.toLowerCase()));
}

/**
 * Removes the user's own brand / domain (case-insensitive substring match) so
 * a response that mentions the user's own product doesn't list them as
 * competitor to themselves.
 */
export function applyBrandSelfFilter(brands, brand, domain) {
  const brandLower = (brand || '').toLowerCase();
  const domainCore = (domain || '').toLowerCase().replace(/\.[a-z]{2,}$/i, '');
  return brands.filter(name => {
    const n = name.toLowerCase();
    if (brandLower && n.includes(brandLower)) return false;
    if (domainCore && domainCore.length >= 4 && n.includes(domainCore)) return false;
    return true;
  });
}

/**
 * Single-model extraction. Pure except for the provider call (which is an
 * injected dependency — tests pass in a deterministic stub).
 */
export async function extractWithSingleModel({
  text, brand, domain, category,
  providerCall, providerName, apiKey, model,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { brands: [], costInfo: null };
  }
  const prompt = buildExtractorPrompt({ text, brand, domain, category });
  const { text: responseText, raw } = await providerCall(prompt, apiKey, model, { webSearch: false });

  const parsed = parseExtractorResponse(responseText);
  const verified = applyBrandSelfFilter(filterHallucinations(parsed, text), brand, domain);

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0,
  };
  const costInfo = {
    provider: providerName,
    model,
    label: 'competitor-extraction',
    requests: 1,
    inputTokens:  costDetail.inputTokens,
    outputTokens: costDetail.outputTokens,
    costUsd:      costDetail.costUsd,
  };
  return { brands: verified, costInfo };
}

/**
 * Normalise a name for case-insensitive equality (keeps the first-seen
 * original-case version when merging).
 */
function canonKey(name) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Merge two brand lists into verified (intersection) and unverified (symmetric
 * difference). Canonical casing: whichever list mentioned the name first wins.
 *
 * Pure — no I/O. Same pattern as mergeCrossCheck for query validation, but
 * simpler: no confidence scores, no reasons, just set operations.
 */
export function mergeExtractions(a, b) {
  const aMap = new Map();
  for (const name of a || []) {
    const k = canonKey(name);
    if (!aMap.has(k)) aMap.set(k, name);
  }
  const bMap = new Map();
  for (const name of b || []) {
    const k = canonKey(name);
    if (!bMap.has(k)) bMap.set(k, name);
  }

  const verified = [];
  const unverified = [];
  for (const [k, original] of aMap) {
    if (bMap.has(k)) verified.push(original);
    else unverified.push(original);
  }
  for (const [k, original] of bMap) {
    if (!aMap.has(k)) unverified.push(original);
  }
  return { verified, unverified };
}

/**
 * Parallel two-model extraction with merge. If one model fails, degrades to
 * single-model output (all brands land in unverified tier) and reports the
 * failure in the result so the caller can surface it.
 *
 * @returns {{
 *   verified: string[],
 *   unverified: string[],
 *   sources: { primary: {model,brands,error?}, secondary: {model,brands,error?} },
 *   costInfo: { inputTokens, outputTokens, costUsd }
 * }}
 */
export async function extractWithTwoModels({
  text, brand, domain, category,
  primary, secondary,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      verified: [], unverified: [],
      sources: { primary: { model: primary?.model, brands: [] }, secondary: { model: secondary?.model, brands: [] } },
      costInfo: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }

  const runOne = async (p) => {
    try {
      const r = await extractWithSingleModel({
        text, brand, domain, category,
        providerCall: p.providerCall,
        providerName: p.name,
        apiKey: p.apiKey,
        model: p.model,
      });
      return { ok: true, brands: r.brands, costInfo: r.costInfo };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, brands: [], costInfo: null, error: message };
    }
  };

  // Single-key mode (1.1.8): secondary may be null — run primary alone. The
  // merge below then routes every brand to `unverified`, which is the honest
  // signal: nothing can be "verified" without a second model to agree.
  const [pRes, sRes] = await Promise.all([
    runOne(primary),
    secondary ? runOne(secondary) : Promise.resolve({ ok: false, brands: [], costInfo: null, skipped: true }),
  ]);

  let verified, unverified;
  if (pRes.ok && sRes.ok) {
    ({ verified, unverified } = mergeExtractions(pRes.brands, sRes.brands));
  } else if (pRes.ok) {
    // Secondary failed — all primary's brands land in unverified (no cross-check confirmation)
    verified = []; unverified = pRes.brands;
  } else if (sRes.ok) {
    verified = []; unverified = sRes.brands;
  } else {
    verified = []; unverified = [];
  }

  const sumCost = (a, b) => (a || 0) + (b || 0);
  const costInfo = {
    inputTokens:  sumCost(pRes.costInfo?.inputTokens,  sRes.costInfo?.inputTokens),
    outputTokens: sumCost(pRes.costInfo?.outputTokens, sRes.costInfo?.outputTokens),
    costUsd:      sumCost(pRes.costInfo?.costUsd,      sRes.costInfo?.costUsd),
  };

  return {
    verified, unverified,
    sources: {
      primary:   { model: primary.model, brands: pRes.brands, ...(pRes.error ? { error: pRes.error } : {}) },
      secondary: secondary
        ? { model: secondary.model, brands: sRes.brands, ...(sRes.error ? { error: sRes.error } : {}) }
        : { model: null, brands: [], skipped: 'single-key mode — no cross-check' },
    },
    costInfo,
  };
}
