/**
 * LLM-based PROSE rank extraction (AP-PROSE-RANK).
 *
 * `mention.js findPosition` only returns a rank when the answer is a STRUCTURED
 * list (≥3 numbered / bulleted items). AI answers are increasingly prose — a
 * paragraph that names several tools in an order that carries real ordinal
 * meaning ("The leading option is X, followed by Y, with Z as a budget pick")
 * but has no list markup. For those, `findPosition` returns null and the rank
 * axis of the UVI is systematically under-filled.
 *
 * This module recovers the ordinal for prose answers with a cheap classify-tier
 * LLM call: "among the comparable named options in this answer, what position is
 * BRAND given?". The result is reported SEPARATELY from list-rank and at LOWER
 * confidence — prose ordering is softer than an explicit numbered list, so the
 * two must never be silently merged.
 *
 * Design mirrors sentiment-classify.js exactly (same two-model parallel
 * cross-check, same provider-call shape) so the run loop integrates it the same
 * way and there is one classify-tier pattern to reason about. Zero new runtime
 * deps (R4) — only the shared pricing helper, same as sentiment.
 *
 * Cost: ~$0.0008 per prose-mention cell. Fired ONLY on cells where the brand is
 * mentioned in the body AND list-rank came back null — never on list answers
 * (their rank is already exact) and never on non-mentions.
 */

import { extractUsage, calcCost } from '../providers/pricing.js';

/**
 * Should a merged prose-rank verdict be PERSISTED onto a result cell's
 * `proseRank` field in _summary.json?
 *
 * The two run sinks (the live loop and `run-manual` in bin/aeo-tracker.js) write
 * `proseRank` only when the verdict carries a usable positive ordinal — a
 * null-rank verdict ("no comparative order") has no axis signal, so omitting it
 * keeps the year-over-year JSON lean and a run without the prose pass has no
 * field at all. Both sinks share THIS predicate (instead of a hand-copied
 * `typeof …rank === 'number' && rank > 0` literal at each site) so the persist
 * condition can never drift between the two paths — and a test can assert
 * against the exact same gate the sink applies.
 *
 * Note: this is the WRITE-side gate (is there an ordinal worth storing?). The
 * READ-side gate that decides whether a stored ordinal counts toward the rank
 * axis is `usableProseRank` in visibility-index.js, which additionally requires
 * the confidence to clear the floor. The two are deliberately distinct.
 *
 * @param {{rank?:number}|null|undefined} pr a merged verdict (or null)
 * @returns {boolean}
 */
export function persistableProseRank(pr) {
  return !!(pr && typeof pr.rank === 'number' && pr.rank > 0);
}

/**
 * The exact `proseRank` field-spread both run sinks stamp onto a result cell.
 *
 * BOTH the live run loop (cmdRun) and the manual paste path (cmdRunManual) in
 * bin/aeo-tracker.js used to inline the identical ternary
 *   `...(persistableProseRank(pr) ? { proseRank: { rank, confidence, rationale } } : {})`
 * at their own sink. Two hand-copied literals can silently drift — e.g. one path
 * starts persisting `comparableCount` and the other does not, and the
 * year-over-year JSON forks between the live and manual surfaces. Centralising
 * the field-build here means a test exercises the SAME function the manual sink
 * calls (not a re-implementation), and the two sinks can never diverge.
 *
 * Returns an object suitable for object-spread: `{ proseRank: {...} }` when the
 * verdict carries a usable ordinal, or `{}` (no field) otherwise — preserving
 * the lean-JSON convention (absence == no prose signal).
 *
 * @param {{rank?:number, confidence?:string, rationale?:string}|null|undefined} pr
 * @returns {{proseRank?: {rank:number, confidence:string, rationale:string}}}
 */
export function proseRankField(pr) {
  if (!persistableProseRank(pr)) return {};
  return { proseRank: { rank: pr.rank, confidence: pr.confidence, rationale: pr.rationale } };
}

/**
 * Strict-JSON prompt. The model returns the brand's ordinal among COMPARABLE
 * named options (other tools/brands/services in the same category), or null
 * when the answer does not put the brand in any comparative order (e.g. it is
 * named once in passing, or it is the only option named).
 */
export function buildProseRankPrompt({ text, brand, domain }) {
  return `You read an AI answer-engine response and decide the ORDINAL POSITION a specific brand is given AMONG COMPARABLE NAMED OPTIONS, when the answer is written as prose (not a numbered or bulleted list).

Brand: "${brand}" (domain: ${domain})

Rules:
- Count only COMPARABLE options — other tools / brands / services named in the same category as the brand. Ignore generic nouns, the user's own company, and unrelated mentions.
- Position is 1-based in the order the answer presents/recommends them (the first/leading option is 1).
- Return null for "rank" if: the brand is the ONLY comparable option named, OR it is mentioned without any comparative ordering (a passing reference), OR you cannot tell its order.
- "comparableCount" = how many comparable options the answer named in total (the denominator). 0 or 1 means no meaningful ranking.

Return STRICT JSON, no markdown, no prose:
{ "rank": <integer ≥1> | null, "comparableCount": <integer ≥0>, "rationale": "one short sentence (max 20 words)" }

RESPONSE TEXT:
${text}`;
}

/**
 * Parse the strict-JSON prose-rank response. Throws on unparseable / malformed
 * input so the caller's try/catch records a model failure (mirrors
 * parseSentimentResponse). A well-formed `{ rank: null }` is a VALID answer
 * ("no meaningful prose ordering"), not an error.
 */
export function parseProseRankResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('prose-rank classifier returned empty response');
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('prose-rank response is not JSON and contains no {...} block');
    try { parsed = JSON.parse(m[0]); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`prose-rank response unparseable: ${msg}`);
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('prose-rank JSON malformed');
  }

  // rank: integer ≥1, or null. Anything else (0, negative, non-numeric) → null
  // (the model declined to give a usable order — treat as "no rank", never a
  // fabricated position).
  let rank = null;
  if (parsed.rank !== null && parsed.rank !== undefined) {
    const n = Math.floor(Number(parsed.rank));
    rank = Number.isFinite(n) && n >= 1 ? n : null;
  }

  let comparableCount = 0;
  if (parsed.comparableCount !== null && parsed.comparableCount !== undefined) {
    const n = Math.floor(Number(parsed.comparableCount));
    comparableCount = Number.isFinite(n) && n >= 0 ? n : 0;
  }

  // A rank with fewer than 2 comparable options is not a real ranking — drop it
  // to null so a model that says "rank: 1, comparableCount: 1" (brand named
  // alone) never produces a misleading «#1». Mirrors findPosition's "≥3 items"
  // guard in spirit: there must be something to rank against.
  if (rank !== null && comparableCount < 2) rank = null;

  const rationale = typeof parsed.rationale === 'string'
    ? parsed.rationale.trim().slice(0, 200)
    : '';
  return { rank, comparableCount, rationale };
}

/**
 * Single-model prose-rank classification. Same provider-call contract as
 * classifyWithSingleModel in sentiment-classify.js.
 */
export async function proseRankWithSingleModel({
  text, brand, domain,
  providerCall, providerName, apiKey, model,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { rank: null, comparableCount: 0, rationale: 'empty response', costInfo: null };
  }
  const prompt = buildProseRankPrompt({ text, brand, domain });
  const { text: responseText, raw } = await providerCall(prompt, apiKey, model, { webSearch: false });
  const { rank, comparableCount, rationale } = parseProseRankResponse(responseText);

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0,
  };
  const costInfo = {
    provider: providerName,
    model,
    label: 'prose-rank-extraction',
    requests: 1,
    inputTokens:  costDetail.inputTokens,
    outputTokens: costDetail.outputTokens,
    costUsd:      costDetail.costUsd,
  };
  return { rank, comparableCount, rationale, costInfo };
}

/**
 * Merge two prose-rank classifications into one verdict with a confidence
 * label. Prose ordering is inherently soft, so even agreement is capped at
 * 'med' (never 'high') — list-rank is the only 'high'-confidence rank signal.
 *
 *   - Both give the SAME rank → that rank, confidence 'med'
 *   - Both give a rank but DIFFER → the LOWER (stronger) rank, confidence 'low'
 *     (we keep a signal but flag the disagreement)
 *   - Both agree the answer has NO rank (null) → rank null, confidence 'none'
 *   - One has a rank, the other null → the rank, confidence 'low'
 *   - One model failed → other's verdict, confidence 'single-model' (capped at
 *     'low' if it carries a rank — one soft model is weak evidence)
 *   - Both failed → null
 */
export function mergeProseRanks(primary, secondary) {
  const pOk = primary && primary.ok;
  const sOk = secondary && secondary.ok;

  const pRank = pOk ? primary.rank : null;
  const sRank = sOk ? secondary.rank : null;

  if (pOk && sOk) {
    if (pRank === null && sRank === null) {
      return { rank: null, confidence: 'none', rationale: primary.rationale || secondary.rationale || '', sources: { primary: null, secondary: null } };
    }
    if (pRank !== null && sRank !== null) {
      if (pRank === sRank) {
        return { rank: pRank, confidence: 'med', rationale: primary.rationale || secondary.rationale || '', sources: { primary: pRank, secondary: sRank } };
      }
      // disagree on the number — keep the lower (stronger) rank, flag low
      const lower = Math.min(pRank, sRank);
      return {
        rank: lower,
        confidence: 'low',
        rationale: `Models disagreed on prose order (${pRank} vs ${sRank}); ${primary.rationale || ''}`.trim(),
        sources: { primary: pRank, secondary: sRank },
      };
    }
    // one says ranked, one says no-rank → weak signal
    const rank = pRank !== null ? pRank : sRank;
    return { rank, confidence: 'low', rationale: (pRank !== null ? primary.rationale : secondary.rationale) || '', sources: { primary: pRank, secondary: sRank } };
  }
  if (pOk) {
    return { rank: pRank, confidence: pRank === null ? 'none' : 'single-model', rationale: primary.rationale || '', sources: { primary: pRank, secondary: null } };
  }
  if (sOk) {
    return { rank: sRank, confidence: sRank === null ? 'none' : 'single-model', rationale: secondary.rationale || '', sources: { primary: null, secondary: sRank } };
  }
  return null;
}

/**
 * Parallel two-model prose-rank extraction. Same shape/contract as
 * classifySentimentWithTwoModels so the caller integrates identically.
 */
export async function extractProseRankWithTwoModels({
  text, brand, domain,
  primary, secondary,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      rank: null, confidence: 'empty', rationale: 'empty response',
      sources: { primary: null, secondary: null },
      costInfo: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }

  const runOne = async (p) => {
    try {
      const r = await proseRankWithSingleModel({
        text, brand, domain,
        providerCall: p.providerCall,
        providerName: p.name,
        apiKey: p.apiKey,
        model: p.model,
      });
      return { ok: true, rank: r.rank, comparableCount: r.comparableCount, rationale: r.rationale, costInfo: r.costInfo };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, rank: null, rationale: null, costInfo: null, error: message };
    }
  };

  const [pRes, sRes] = await Promise.all([
    runOne(primary),
    secondary ? runOne(secondary) : Promise.resolve({ ok: false, rank: null, rationale: null, costInfo: null, skipped: true }),
  ]);
  const merged = mergeProseRanks(pRes, sRes);

  const sumCost = (a, b) => (a || 0) + (b || 0);
  const costInfo = {
    inputTokens:  sumCost(pRes.costInfo?.inputTokens,  sRes.costInfo?.inputTokens),
    outputTokens: sumCost(pRes.costInfo?.outputTokens, sRes.costInfo?.outputTokens),
    costUsd:      sumCost(pRes.costInfo?.costUsd,      sRes.costInfo?.costUsd),
  };

  if (!merged) {
    return {
      rank: null, confidence: 'failed',
      rationale: `Both models failed: ${pRes.error || ''} | ${sRes.error || ''}`.trim(),
      sources: { primary: null, secondary: null, errors: { primary: pRes.error, secondary: sRes.error } },
      costInfo,
    };
  }
  return { ...merged, costInfo };
}
