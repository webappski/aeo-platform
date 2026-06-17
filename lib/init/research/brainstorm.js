/**
 * Phase 2 of the keyword research pipeline — brainstorm (1.0.6 commercial-only).
 *
 * Generates 5 commercial vendor-listing queries via a single LLM call. The
 * 4-bucket model (commercial / problem / vertical / comparison) was retired in
 * 1.0.6: vertical / problem / comparison queries reliably fail the downstream
 * commercial-only validator and produced the recurring trust failure from 1.0.2
 * through 1.0.5 (recovery panel suggesting commands that the CLI itself rejects).
 *
 * Over-generation: we ask for 5 (3 needed + 2 spares) so the silent-substitution
 * step in cmdInit can swap failing top-3 with passing spares — operator sees
 * only the final 3, no recovery panel for the typical case.
 *
 * Hard requirements enforced in the prompt:
 *   - Guard 1: ALWAYS expand industry acronyms at generation time.
 *   - Unbranded: never include brand name or domain core.
 *   - Language: match the site's detected language.
 */

import { deriveProductLines } from './product-lines.js';

const INTENT_BUCKETS = ['commercial'];

// Output-shape buckets — kept for backward compatibility with consumers that
// destructure by bucket name (e.g. `buckets.problem`, `buckets.vertical`).
// validateBrainstormShape seeds these as empty arrays so the shape remains
// stable even though INTENT_BUCKETS contains only 'commercial'.
const OUTPUT_BUCKET_KEYS = ['commercial', 'problem', 'vertical', 'comparison'];

const TARGET_PER_BUCKET = 5;     // 3 needed + 2 spares for silent substitution
const TARGET_TOTAL_MIN = 5;       // shape-validator threshold (was implicit 10)

/**
 * Build the brainstorm prompt — commercial-only, 5 candidates.
 *
 * `avoidFeedback` (top-up mode): array of { query, reason } from validator
 * rejections of a previous round. The new round must not repeat those texts
 * and must steer away from the rejection reasons — this closes the loop where
 * rejection reasons were computed, displayed, and then thrown away.
 */
export function buildBrainstormPrompt({ brand, domain, site, categoryDescription, audienceTags = [], geoTags = [], avoidFeedback = [] }) {
  const audienceLine = audienceTags.length > 0
    ? `Audience markers detected on the site: ${audienceTags.join(', ')}.`
    : '';
  const geoLine = geoTags.length > 0
    ? `Geographic signals: ${geoTags.join(', ')}. Consider region-specific terminology where relevant.`
    : '';
  const avoidBlock = avoidFeedback.length > 0
    ? `\nPREVIOUSLY REJECTED in an earlier round — do NOT repeat these texts, and steer away from their failure reasons:\n${avoidFeedback.map(f => `  - "${f.query}" — rejected because: ${f.reason || 'failed validation'}`).join('\n')}\n`
    : '';

  // AP-FIX-COVERAGE-AXIS: the coverage axis is the brand's PRODUCT LINES, not
  // client industries. Derived from the same source as brand-fit so the two
  // stay consistent. When lines can't be extracted, fall back to the soft
  // industry-diversity guidance (no product-line list to anchor on).
  const { lines: productLines } = deriveProductLines(site);
  const hasLines = productLines.length > 0;
  const productLinesText = hasLines ? productLines.join(', ') : '';

  return `You are a keyword research specialist configuring an AEO (Answer Engine Optimization) visibility tracker.

BRAND: ${brand}
DOMAIN: ${domain}
LANGUAGE: ${site.lang || 'en'}
CATEGORY_DESCRIPTION (user-provided, authoritative): "${categoryDescription}"
${audienceLine}
${geoLine}

SITE CONTEXT:
  Title: ${site.title || '(none)'}
  Meta: ${site.metaDesc || '(none)'}
  H1: ${(site.h1 || []).join(' | ') || '(none)'}
  H2: ${(site.h2 || []).join(' | ') || '(none)'}
  Body excerpt: ${String(site.text || '').slice(0, 1200)}
${avoidBlock}
TASK — generate exactly ${TARGET_PER_BUCKET} UNBRANDED COMMERCIAL vendor-listing queries.

Each query must:
  - Show explicit buying intent: "best X 2026", "top X for Y", "X consultants for Z",
    "X services for <segment>", "X tools for <industry>"
  - Be phrased the way real users search when comparing vendors
  - Trigger live web retrieval (NOT parametric-only knowledge, NOT comparison
    of brand alternatives — those fail the commercial-only validator)
  - NOT be informational ("what is X", "how does X work") — those have zero buying intent
  - NOT be problem-statement ("why is my X broken") — those produce tutorial answers
  - NOT compare AI engine channels (ChatGPT vs Gemini etc.) — channels, not products

WHY 5: the downstream validator runs an industry-fit check + a commercial-only
check on each query. Generating 5 (instead of 3) gives 2 spares so the tool can
silently substitute on validation failures and show the operator only the final
3 — no recovery panel for the typical case.

NON-NEGOTIABLE RULES (violations are rejected):

  A. **Acronym expansion.** EVERY query must spell out industry acronyms in full.
     Never output "AEO" alone — write "Answer Engine Optimization".
     Never output "CRM" alone — write "Customer Relationship Management".
     Never "ERP", "SEO-as-AEO", "GEO", "CRO", "CDP", "ROI", "KPI", "ML" without expansion.
     This applies EVEN IF the CATEGORY_DESCRIPTION above uses the abbreviation.

  B. **Product-line coverage.** ${hasLines
    ? `The 5 candidates SHOULD spread across the brand's actual PRODUCT LINES — ${productLinesText} — so the tool tracks where the brand genuinely competes, not industries it merely touches. One query per major line is ideal. Do NOT pivot the queries onto client industries (healthcare, finance, e-commerce) where the brand has no product; that produces queries the brand can never rank for. This is a soft guideline — commercial intent is the hard requirement.`
    : `The 5 candidates SHOULD spread across the brand's distinct offerings / use-cases so the tool tracks across what it actually sells, not a single narrow slice. Avoid pivoting onto unrelated client industries the brand has no product for. This is a soft guideline — commercial intent is the hard requirement.`}

  C. **Unbranded.** Never include "${brand}" or the core of "${domain}".

  D. **Language.** Write in ${site.lang || 'en'}. If the site hints at a specific
     region, adapt to regional terminology (e.g., Polish users might search
     "Answer Engine Optimization usługi" not "AEO services").

  E. **Length.** 3–10 words per query.

Return STRICT JSON. No markdown fences. No prose. Format:
{
  "commercial": ["...", "...", "...", "...", "..."]
}`;
}

/**
 * Tolerant JSON parser — strips code fences, extracts first {...}, retries.
 */
export function parseBrainstormResponse(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty brainstorm response');
  let cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  throw new Error('Could not parse JSON from brainstorm response');
}

/**
 * Validate the shape of a parsed brainstorm output.
 *
 * Returns { buckets: {commercial: [...], problem: [], vertical: [], comparison: []}, flat: [{text, intent}, ...] }
 *
 * 1.0.6: only `commercial` carries entries from the LLM. The other bucket keys
 * are seeded as empty arrays for backward-compatibility with consumers that
 * destructure by bucket name. The `flat` array contains only commercial-intent
 * entries (since they're the only ones generated).
 */
export function validateBrainstormShape(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Brainstorm output is not a JSON object');
  }

  // Seed all four output keys; only `commercial` will receive entries below.
  const buckets = {};
  for (const key of OUTPUT_BUCKET_KEYS) buckets[key] = [];

  const flat = [];
  let totalAcross = 0;

  for (const intent of INTENT_BUCKETS) {
    const arr = Array.isArray(parsed[intent]) ? parsed[intent] : [];
    const cleaned = arr
      .filter(q => typeof q === 'string' && q.trim().length >= 3)
      .map(q => q.trim());
    buckets[intent] = cleaned;
    totalAcross += cleaned.length;
    for (const text of cleaned) flat.push({ text, intent });
  }

  if (totalAcross < TARGET_TOTAL_MIN) {
    throw new Error(`Brainstorm produced only ${totalAcross} commercial queries — need at least ${TARGET_TOTAL_MIN}`);
  }

  return { buckets, flat, totalAcross };
}

/**
 * Run the brainstorm phase end-to-end with one retry on bad output.
 *
 * @param {Object} opts
 * @param {Function} opts.providerCall  LLM caller (prompt, apiKey, model, options) => { text, ... }
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Function} [opts.onAttempt]   reporter: ({ attempt, total, estimate }) => void
 */
export async function runBrainstorm({
  brand, domain, site, categoryDescription, audienceTags, geoTags,
  providerCall, apiKey, model, onAttempt = null, avoidFeedback = [],
}) {
  const prompt = buildBrainstormPrompt({ brand, domain, site, categoryDescription, audienceTags, geoTags, avoidFeedback });
  const estimate = {
    tokens: Math.ceil(prompt.length / 4),
    usd: (Math.ceil(prompt.length / 4) / 1_000_000) * 3,
  };

  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (onAttempt) onAttempt({ attempt, total: MAX_ATTEMPTS, estimate });
    try {
      const { text } = await providerCall(prompt, apiKey, model, { webSearch: false });
      const parsed = parseBrainstormResponse(text);
      return validateBrainstormShape(parsed);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }
  }
  throw lastErr;
}

export { INTENT_BUCKETS, OUTPUT_BUCKET_KEYS, TARGET_PER_BUCKET, TARGET_TOTAL_MIN };
