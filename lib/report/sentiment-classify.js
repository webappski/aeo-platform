/**
 * LLM-based sentiment classification with two-model parallel cross-check.
 *
 * For each AI response that mentions the user's brand, classify how the brand
 * is described: positive, neutral, or negative. Two cheap classify-tier models
 * (gpt-5.4-mini + gemini-2.5-flash, the same pair used by the competitor
 * extractor) score independently, then results merge:
 *
 *   - Both agree → label is the agreed value, confidence "high"
 *   - Models disagree → label degrades to "neutral", confidence "low"
 *   - One model fails → other's label, confidence "single-model"
 *
 * The rationale field comes from the model that picked the final label (or
 * primary's when degraded to neutral). It's a one-line "why" for the report,
 * not a paragraph.
 *
 * Cost: ~$0.0008 per cell × ~3 cells with mentions = ~$0.0025 per run.
 */

import { extractUsage, calcCost } from '../providers/pricing.js';
import { CLASSIFY_OPTIONS_BY_PROVIDER } from '../providers/main-options.js';

const VALID_LABELS = new Set(['positive', 'neutral', 'negative']);

/**
 * Strict-JSON prompt. Brand is interpolated so the classifier knows whose
 * sentiment to score (vs the response's general tone, which can differ —
 * a glowing description of competitors with the user's brand listed once
 * dismissively is "negative for ${brand}", not "positive for the response").
 */
export function buildSentimentPrompt({ text, brand, domain }) {
  return `You classify how an AI answer-engine response describes a SPECIFIC BRAND.

Brand: "${brand}" (domain: ${domain})

Read the response below and decide ONLY how this brand is portrayed:
  - "positive": brand is recommended, praised, listed as a top choice, or described as a leader
  - "neutral": brand is mentioned factually without judgement (e.g. listed alongside others, described by what it does without recommendation)
  - "negative": brand is criticised, dismissed, listed only as contrast ("unlike X..."), or framed as inferior

If the response does not mention the brand at all, return "neutral" with rationale "brand not mentioned".

Return STRICT JSON, no markdown, no prose:
{ "label": "positive" | "neutral" | "negative", "rationale": "one short sentence (max 20 words) explaining why" }

RESPONSE TEXT:
${text}`;
}

export function parseSentimentResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('sentiment classifier returned empty response');
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('sentiment response is not JSON and contains no {...} block');
    try { parsed = JSON.parse(m[0]); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`sentiment response unparseable: ${msg}`);
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('sentiment JSON malformed');
  }
  const label = String(parsed.label || '').toLowerCase().trim();
  if (!VALID_LABELS.has(label)) {
    throw new Error(`sentiment label "${parsed.label}" not in {positive, neutral, negative}`);
  }
  const rationale = typeof parsed.rationale === 'string'
    ? parsed.rationale.trim().slice(0, 200)
    : '';
  return { label, rationale };
}

export async function classifyWithSingleModel({
  text, brand, domain,
  providerCall, providerName, apiKey, model,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { label: 'neutral', rationale: 'empty response', costInfo: null };
  }
  const prompt = buildSentimentPrompt({ text, brand, domain });
  const { text: responseText, raw } = await providerCall(prompt, apiKey, model, {
    ...CLASSIFY_OPTIONS_BY_PROVIDER[providerName],
    webSearch: false,
  });
  const { label, rationale } = parseSentimentResponse(responseText);

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0,
  };
  const costInfo = {
    provider: providerName,
    model,
    label: 'sentiment-classification',
    requests: 1,
    inputTokens:  costDetail.inputTokens,
    outputTokens: costDetail.outputTokens,
    costUsd:      costDetail.costUsd,
  };
  return { label, rationale, costInfo };
}

/**
 * Merge two sentiment classifications.
 *
 *   - Both agree → that label, confidence "high", primary's rationale
 *   - Disagree   → "neutral",   confidence "low",  primary's rationale prefixed
 *   - One failed → other's label, confidence "single-model"
 *   - Both failed → null (caller can omit field from result)
 */
export function mergeSentiments(primary, secondary) {
  const pOk = primary && primary.ok;
  const sOk = secondary && secondary.ok;

  if (pOk && sOk) {
    if (primary.label === secondary.label) {
      return {
        label: primary.label,
        confidence: 'high',
        rationale: primary.rationale || secondary.rationale || '',
        sources: { primary: primary.label, secondary: secondary.label },
      };
    }
    return {
      label: 'neutral',
      confidence: 'low',
      rationale: `Models disagreed (${primary.label} vs ${secondary.label}); ${primary.rationale || ''}`.trim(),
      sources: { primary: primary.label, secondary: secondary.label },
    };
  }
  if (pOk) {
    return {
      label: primary.label,
      confidence: 'single-model',
      rationale: primary.rationale || '',
      sources: { primary: primary.label, secondary: null },
    };
  }
  if (sOk) {
    return {
      label: secondary.label,
      confidence: 'single-model',
      rationale: secondary.rationale || '',
      sources: { primary: null, secondary: secondary.label },
    };
  }
  return null;
}

/**
 * Parallel two-model sentiment classification. Same shape as extractWithTwoModels
 * so the caller integrates identically.
 */
export async function classifySentimentWithTwoModels({
  text, brand, domain,
  primary, secondary,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      label: 'neutral',
      confidence: 'empty',
      rationale: 'empty response',
      sources: { primary: null, secondary: null },
      costInfo: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }

  const runOne = async (p) => {
    try {
      const r = await classifyWithSingleModel({
        text, brand, domain,
        providerCall: p.providerCall,
        providerName: p.name,
        apiKey: p.apiKey,
        model: p.model,
      });
      return { ok: true, label: r.label, rationale: r.rationale, costInfo: r.costInfo };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, label: null, rationale: null, costInfo: null, error: message };
    }
  };

  // Single-key mode (1.1.8): secondary may be null — mergeSentiments already
  // returns confidence 'single-model' when only the primary verdict exists.
  const [pRes, sRes] = await Promise.all([
    runOne(primary),
    secondary ? runOne(secondary) : Promise.resolve({ ok: false, label: null, rationale: null, costInfo: null, skipped: true }),
  ]);
  const merged = mergeSentiments(pRes, sRes);

  const sumCost = (a, b) => (a || 0) + (b || 0);
  const costInfo = {
    inputTokens:  sumCost(pRes.costInfo?.inputTokens,  sRes.costInfo?.inputTokens),
    outputTokens: sumCost(pRes.costInfo?.outputTokens, sRes.costInfo?.outputTokens),
    costUsd:      sumCost(pRes.costInfo?.costUsd,      sRes.costInfo?.costUsd),
  };

  if (!merged) {
    return {
      label: 'neutral',
      confidence: 'failed',
      rationale: `Both models failed: ${pRes.error || ''} | ${sRes.error || ''}`.trim(),
      sources: { primary: null, secondary: null, errors: { primary: pRes.error, secondary: sRes.error } },
      costInfo,
    };
  }
  return { ...merged, costInfo };
}

/**
 * Map sentiment label to a 0-100 score (for radar chart aggregation).
 */
export function sentimentToScore(label) {
  if (label === 'positive') return 100;
  if (label === 'negative') return 0;
  return 50;
}
