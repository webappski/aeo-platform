/**
 * AP-MENTION-ROLE-VENDOR-VS-SOURCE — being NAMED and being RECOMMENDED are not
 * the same event, and the score counted them the same.
 *
 * Found 2026-09-16 reading the bodies of a real run. Cells Q8, Q29 (PL) and
 * Q36 (DE) were scored `mention: 'yes'`, which is formally correct — the brand
 * is in the answer text. The ROLE was the opposite of the one we measure for.
 * Q36, verbatim: the answer lists four suppliers a buyer could hire (First
 * Principle Impact, NobleJackal, UnFoldMart, IQONEX) and then writes
 * «Webappski – listet in einem aktuellen DACH-Ranking mehrere AEO-Agenturen mit
 * SaaS-Fokus» — we are the AUTHOR OF THE RANKING ABOUT THEM, not an agency to
 * engage. Q8 and Q29: our own article stands in the sources beside widoczni.com
 * and goodfirms as material ABOUT OTHERS, while Whites is the recommendation.
 *
 * The consequence is not academic: the headline «ChatGPT 6 → 8» from that run
 * is not a gain in recommendations, and an answer that names us as the author
 * of a list of rival agencies sends the buyer to a rival WHILE RAISING OUR
 * SCORE. That is the class of lie D4 closed on the basket and denominator
 * axes, on the axis of meaning.
 *
 * WHY A SEPARATE FIELD AND NOT A NEW `mention` VALUE. Seven-plus consumers do
 * `results.find(...)` on `mention` and branch on 'yes' | 'src' | 'no'; adding a
 * value there breaks every one of them, and the existing axis does not help
 * anyway — 'src' means «cited but not named», while these cells ARE named, just
 * in another role.
 *
 * WHY ITS OWN CLASSIFIER PASS. The alternative was a hint inside the sentiment
 * classifier's prompt. That is an edit to a live prompt whose labels feed the
 * UVI sentiment axis, so R54 would require a baseline measurement against main
 * to prove the tone labels did not shift — paying for a measurement to save a
 * fraction of a cent in calls. This pass is built exactly like AP-PROSE-RANK:
 * one classify-tier call in the SAME parallel batch as sentiment and competitor
 * extraction, only on cells where the brand was actually mentioned, no existing
 * prompt touched.
 *
 * Absent the pass, a cell simply carries no `mentionRole` field, every
 * published number is byte-identical to before, and the report says the role
 * was not classified rather than reporting «0 recommended» — an unclassified
 * run must never read as a run where nobody recommended us.
 */

import { extractUsage, calcCost } from '../providers/pricing.js';
import { CLASSIFY_OPTIONS_BY_PROVIDER } from '../providers/main-options.js';
import { isHitMention } from '../score.js';

/**
 * The three roles a naming can have, and the one non-answer.
 *
 * `recommended`     — named as a supplier the asker could engage.
 * `cited-as-source` — named as the author/publisher of material about others.
 * `mentioned-other` — named, but neither: an aside, a customer, an example.
 * `unknown`         — not classified, or the models disagreed. NEVER guessed.
 */
export const MENTION_ROLE = Object.freeze({
  RECOMMENDED: 'recommended',
  CITED_AS_SOURCE: 'cited-as-source',
  MENTIONED_OTHER: 'mentioned-other',
  UNKNOWN: 'unknown',
});

const KNOWN_ROLES = new Set([
  MENTION_ROLE.RECOMMENDED,
  MENTION_ROLE.CITED_AS_SOURCE,
  MENTION_ROLE.MENTIONED_OTHER,
]);

/** Is this a role worth storing? `unknown` is not — absence says the same
 *  thing without adding a field to every cell (the lean-JSON convention
 *  `proseRankField` follows). */
export function persistableMentionRole(mr) {
  return !!(mr && KNOWN_ROLES.has(mr.role));
}

/**
 * The exact `mentionRole` field-spread both run sinks stamp onto a cell.
 * Centralised for the same reason `proseRankField` is: two hand-copied literals
 * in cmdRun and cmdRunManual drift, and the JSON forks between the live and
 * manual surfaces.
 *
 * @param {{role?:string, confidence?:string, rationale?:string}|null|undefined} mr
 * @returns {{mentionRole?: {role:string, confidence:string, rationale:string}}}
 */
export function mentionRoleField(mr) {
  if (!persistableMentionRole(mr)) return {};
  return { mentionRole: { role: mr.role, confidence: mr.confidence, rationale: mr.rationale } };
}

/** Does this cell need the role pass at all? Only a cell that actually named
 *  or cited the brand has a role to classify. */
export function needsMentionRole(mention) {
  return isHitMention(mention);
}

/**
 * Is the role pass switched ON for this project?
 *
 * OFF unless the config says otherwise, and `=== true` rather than truthy: an
 * unrecognised value must not start spending. The pass adds a classify-tier
 * call per mentioned cell — measured from lib/providers/pricing.js at
 * $0.0045–0.015 for a run with 11–25 mentions, against $1.88 for the whole
 * 2026-09-16 run — and money in this workspace is never spent by default
 * (see `classifyMentionRole` in DEFAULT_CONFIG). Turning it on is one line in
 * `.aeo-tracker.json`, and the decision belongs to whoever pays for the run,
 * taken at the run, not baked in here.
 *
 * @param {{classifyMentionRole?: boolean}|null|undefined} config
 */
export function mentionRoleEnabled(config) {
  return config?.classifyMentionRole === true;
}

/**
 * Strict-JSON prompt. Deliberately asks the model to distinguish the two
 * failure modes we have actually seen, in the words the answers used, rather
 * than an abstract taxonomy it has to map onto.
 */
export function buildMentionRolePrompt({ text, brand, domain }) {
  return `You read an AI answer-engine response that mentions a specific brand, and decide WHAT ROLE the brand plays in that answer.

Brand: "${brand}" (domain: ${domain})

The question the role answers is: would a reader of this answer come away thinking they could HIRE/USE this brand, or thinking this brand is a source of information about OTHER providers?

Roles:
- "recommended"     — the answer presents the brand as a supplier/tool/service the asker could engage or use. It is one of the options being offered.
- "cited-as-source" — the answer presents the brand as the author, publisher or host of information ABOUT other providers (a ranking, a comparison, a directory, a study, an article). The actual recommendations are other names.
- "mentioned-other" — named, but neither of the above: an aside, an example, a customer of someone else, a parent company, an unrelated use of the same word.

Rules:
- Judge the ROLE IN THIS ANSWER, not the brand's real-world business.
- A brand can be BOTH listed as an option and cited as a source; if it is genuinely offered as an option, answer "recommended".
- If the answer names other suppliers as the options and refers to this brand only as where a list/ranking/comparison came from, answer "cited-as-source" — even when the brand appears in the same sentence or list.
- If you cannot tell, answer "unknown". Do NOT guess.

Return STRICT JSON, no markdown, no prose:
{ "role": "recommended" | "cited-as-source" | "mentioned-other" | "unknown", "rationale": "one short sentence (max 20 words), quoting the deciding words if possible" }

RESPONSE TEXT:
${text}`;
}

/**
 * Parse the strict-JSON role response. Throws on unparseable input so the
 * caller's try/catch records a model failure (mirrors parseProseRankResponse).
 * A well-formed `"unknown"` is a VALID answer, not an error.
 */
export function parseMentionRoleResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('mention-role classifier returned empty response');
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('mention-role response is not JSON and contains no {...} block');
    try { parsed = JSON.parse(m[0]); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`mention-role response unparseable: ${msg}`);
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('mention-role JSON malformed');
  }

  // An unrecognised label is 'unknown', never the nearest guess: a classifier
  // that answers "vendor" or "author" must not be silently read as a verdict
  // it did not give.
  const raw_role = typeof parsed.role === 'string' ? parsed.role.trim().toLowerCase() : '';
  const role = KNOWN_ROLES.has(raw_role) ? raw_role : MENTION_ROLE.UNKNOWN;

  const rationale = typeof parsed.rationale === 'string'
    ? parsed.rationale.trim().slice(0, 200)
    : '';
  return { role, rationale };
}

/**
 * Merge two independent role classifications.
 *
 * The rule is stricter than prose-rank's, because the cost of being wrong runs
 * the other way: a fabricated `recommended` re-creates exactly the lie this
 * field exists to expose. So only AGREEMENT produces a role. Disagreement is
 * `unknown` — we would rather measure nothing than measure a guess.
 *
 *   - Both agree on a known role   → that role, confidence 'high'
 *   - Both answered, but differ    → unknown, confidence 'low', both recorded
 *   - One model failed             → the other's role, confidence 'single-model'
 *   - Both failed                  → null (no field at all)
 */
export function mergeMentionRoles(primary, secondary) {
  const pOk = primary && primary.ok;
  const sOk = secondary && secondary.ok;

  const pRole = pOk ? primary.role : null;
  const sRole = sOk ? secondary.role : null;

  if (pOk && sOk) {
    if (pRole === sRole) {
      return {
        role: pRole,
        confidence: pRole === MENTION_ROLE.UNKNOWN ? 'none' : 'high',
        rationale: primary.rationale || secondary.rationale || '',
        sources: { primary: pRole, secondary: sRole },
      };
    }
    return {
      role: MENTION_ROLE.UNKNOWN,
      confidence: 'low',
      rationale: `Models disagreed on role (${pRole} vs ${sRole}); neither is recorded as the verdict.`,
      sources: { primary: pRole, secondary: sRole },
    };
  }
  if (pOk) {
    return {
      role: pRole,
      confidence: pRole === MENTION_ROLE.UNKNOWN ? 'none' : 'single-model',
      rationale: primary.rationale || '',
      sources: { primary: pRole, secondary: null },
    };
  }
  if (sOk) {
    return {
      role: sRole,
      confidence: sRole === MENTION_ROLE.UNKNOWN ? 'none' : 'single-model',
      rationale: secondary.rationale || '',
      sources: { primary: null, secondary: sRole },
    };
  }
  return null;
}

/** Single-model role classification. Same provider-call contract as
 *  `proseRankWithSingleModel`. */
export async function mentionRoleWithSingleModel({
  text, brand, domain,
  providerCall, providerName, apiKey, model,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { role: MENTION_ROLE.UNKNOWN, rationale: 'empty response', costInfo: null };
  }
  const prompt = buildMentionRolePrompt({ text, brand, domain });
  const { text: responseText, raw } = await providerCall(prompt, apiKey, model, {
    ...CLASSIFY_OPTIONS_BY_PROVIDER[providerName],
    webSearch: false,
  });
  const { role, rationale } = parseMentionRoleResponse(responseText);

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0,
  };
  return {
    role,
    rationale,
    costInfo: {
      provider: providerName,
      model,
      label: 'mention-role-classification',
      requests: 1,
      inputTokens:  costDetail.inputTokens,
      outputTokens: costDetail.outputTokens,
      costUsd:      costDetail.costUsd,
    },
  };
}

/** Parallel two-model role classification. Same shape/contract as
 *  `extractProseRankWithTwoModels`, so the sinks integrate identically. */
export async function classifyMentionRoleWithTwoModels({
  text, brand, domain,
  primary, secondary,
}) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return {
      role: MENTION_ROLE.UNKNOWN, confidence: 'empty', rationale: 'empty response',
      sources: { primary: null, secondary: null },
      costInfo: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }

  const runOne = async (p) => {
    try {
      const r = await mentionRoleWithSingleModel({
        text, brand, domain,
        providerCall: p.providerCall,
        providerName: p.name,
        apiKey: p.apiKey,
        model: p.model,
      });
      return { ok: true, role: r.role, rationale: r.rationale, costInfo: r.costInfo };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, role: null, rationale: null, costInfo: null, error: message };
    }
  };

  const [pRes, sRes] = await Promise.all([
    runOne(primary),
    secondary ? runOne(secondary) : Promise.resolve({ ok: false, role: null, rationale: null, costInfo: null, skipped: true }),
  ]);
  const merged = mergeMentionRoles(pRes, sRes);

  const sum = (a, b) => (a || 0) + (b || 0);
  const costInfo = {
    inputTokens:  sum(pRes.costInfo?.inputTokens,  sRes.costInfo?.inputTokens),
    outputTokens: sum(pRes.costInfo?.outputTokens, sRes.costInfo?.outputTokens),
    costUsd:      sum(pRes.costInfo?.costUsd,      sRes.costInfo?.costUsd),
  };

  if (!merged) {
    return {
      role: MENTION_ROLE.UNKNOWN, confidence: 'failed',
      rationale: `Both models failed: ${pRes.error || ''} | ${sRes.error || ''}`.trim(),
      sources: { primary: null, secondary: null, errors: { primary: pRes.error, secondary: sRes.error } },
      costInfo,
    };
  }
  return { ...merged, costInfo };
}

// ─── Read side ──────────────────────────────────────────────────────────────

/** The stored role of a cell, or `unknown` when the pass did not run or the
 *  models disagreed. Never infers a role from any other field. */
export function roleOf(cell) {
  const role = cell?.mentionRole?.role;
  return KNOWN_ROLES.has(role) ? role : MENTION_ROLE.UNKNOWN;
}

/**
 * Split a run's MENTIONS by role.
 *
 * `classified` is the count the report must gate on: with zero classified
 * cells there is no honest «of which recommended» line to print, and printing
 * «0 recommended» would state a finding the run never made.
 *
 * @param {Array<Object>} results
 * @returns {{mentions:number, classified:number, unknown:number,
 *            recommended:number, citedAsSource:number, mentionedOther:number}}
 */
export function summariseMentionRoles(results) {
  const out = {
    mentions: 0, classified: 0, unknown: 0,
    recommended: 0, citedAsSource: 0, mentionedOther: 0,
    // How many of the classified cells rest on ONE model because the other
    // failed. Counted separately because the line below is founder- and
    // client-facing: two independent models agreeing and one model answering
    // alone are not the same evidence, and a surface that prints them as one
    // number is the kind of claim this whole field exists to stop.
    singleModel: 0,
  };
  for (const r of (results || [])) {
    if (!needsMentionRole(r?.mention)) continue;
    out.mentions++;
    const role = roleOf(r);
    if (role === MENTION_ROLE.UNKNOWN) { out.unknown++; continue; }
    out.classified++;
    if (r?.mentionRole?.confidence === 'single-model') out.singleModel++;
    if (role === MENTION_ROLE.RECOMMENDED) out.recommended++;
    else if (role === MENTION_ROLE.CITED_AS_SOURCE) out.citedAsSource++;
    else out.mentionedOther++;
  }
  return out;
}

/**
 * The report line that splits the headline count by role.
 *
 * Returns null when no cell in the run carries a classified role — the caller
 * renders nothing rather than a zero. When only SOME cells are classified the
 * line says how many were not, so the split is never read as covering the
 * whole basket.
 *
 * @param {Array<Object>} results
 * @returns {string|null}
 */
export function buildMentionRoleLine(results) {
  const s = summariseMentionRoles(results);
  if (s.mentions === 0 || s.classified === 0) return null;

  const parts = [`**${s.recommended} of ${s.mentions}** named you as a supplier the asker could engage`];
  if (s.citedAsSource > 0) {
    parts.push(`${s.citedAsSource} cited you as the SOURCE of information about other providers — those answers raise your mention count while pointing the buyer elsewhere`);
  }
  if (s.mentionedOther > 0) {
    parts.push(`${s.mentionedOther} named you in passing, in neither role`);
  }
  if (s.unknown > 0) {
    parts.push(`${s.unknown} could not be classified and are counted in none of the above`);
  }
  // How the split was arrived at, in the same sentence that states it. Two
  // models had to agree for a cell to be placed at all; where one model failed
  // the surviving verdict stands on one reading, and the reader is told how
  // many of the counts above rest on that.
  const basis = s.singleModel > 0
    ? ` Each role is a verdict two independent models agreed on, except ${s.singleModel} where one model failed and the other's reading stands alone.`
    : ' Each role is a verdict two independent models agreed on; where they disagreed the answer is left unclassified rather than guessed.';
  return `**Named is not recommended.** ${parts.join('; ')}.${basis}`;
}
