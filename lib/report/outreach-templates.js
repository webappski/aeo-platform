/**
 * LLM-generated outreach email templates for the top-cited domains in a run.
 *
 * After every weekly run, the top-3 domains by share-of-voice are publishers
 * whose articles AI engines repeatedly cite. Pitching them to add the user's
 * brand is the highest-leverage outreach move surfaced by the data — but
 * "write a pitch" is the hard step that stops most users acting.
 *
 * This module asks a single classify-tier LLM (gpt-5.4-mini-class) to draft
 * one specific email per domain. Output is short (under 150 words body),
 * grounded in the actual citation count, and references the brand's category.
 *
 * Cost: ~$0.001 × 3 domains = ~$0.003 per report. Cached in _summary.json
 * so re-running `aeo-tracker report` doesn't re-spend.
 */

import { extractUsage, calcCost } from '../providers/pricing.js';
import { isOwnDomain } from './own-domain.js';
import { isDenyListedOutreachHost, isCompetitorOwnedHost } from './sections.js';

const MAX_DOMAINS = 3;

/**
 * Strip the user's own domain (and subdomains thereof) from the topDomains
 * list before either the prompt is built or the LLM is called. Without this,
 * a brand whose `topDomains[0]` is its own canonical site ends up drafting
 * an outreach email addressed to itself — surfaced in the May-2026 dogfood
 * run on `typelessform.com` (see `lib/report/own-domain.js` for context).
 *
 * Also strips OUTREACH_HOST_DENY_LIST hosts (github.io tenant containers,
 * teamtreehouse.com tutorials, etc.) — those have no editor to email and
 * drafting a pitch to them just burns ~$0.001/draft and clutters the report.
 *
 * Pure — exported for unit-tests.
 *
 * Also strips competitor-OWNED hosts (fail-branch #10): drafting an email
 * asking a direct competitor's own site to «add you alongside» a rival is
 * absurd. `competitorHosts` is a Set from sections.competitorOwnedHosts().
 *
 * @param {Array<{host:string}>} topDomains
 * @param {string} ownDomain
 * @param {Set<string>} [competitorHosts]
 * @returns {Array<{host:string}>}
 */
export function filterOwnDomainFromTopDomains(topDomains, ownDomain, competitorHosts) {
  if (!Array.isArray(topDomains)) return [];
  return topDomains.filter(d =>
    d && !isOwnDomain(d.host, ownDomain) && !isDenyListedOutreachHost(d.host)
      && !isCompetitorOwnedHost(d.host, competitorHosts)
  );
}

export function buildOutreachPrompt({ brand, domain, category, topDomains }) {
  const list = topDomains
    .slice(0, MAX_DOMAINS)
    .map((d, i) => `${i + 1}. ${d.host} — cited ${d.count}× (${(d.share * 100).toFixed(1)}% of all citations)`)
    .join('\n');

  return `You are an experienced AEO outreach specialist. Draft ${Math.min(MAX_DOMAINS, topDomains.length)} short, specific email pitches to publishers whose articles AI answer engines cite when describing the user's category.

USER:
  Brand: ${brand}
  Domain: ${domain}
  Category: ${category}

TOP-CITED PUBLISHERS (in order of citation share):
${list}

For each publisher, write one email. Constraints:
  - Subject line: under 60 chars, specific to the publisher (no generic "quick question").
  - Body: under 150 words. Reference WHY they're being contacted (their article was cited Nx by AI for our category). State the value (a missing perspective, a data point, a customer story). Soft CTA — propose a contribution, not a link request.
  - Tone: peer-to-peer, not vendor-asking-favor.
  - DO NOT fabricate the publisher's article URL or claim to know specific posts. Reference the topic only.
  - Why-line: one sentence stating the strategic reason this domain matters (e.g. "captures 19% of AI citations in your category").

Return STRICT JSON, no markdown, no prose:
{
  "templates": [
    {
      "host": "domain.com",
      "subject": "...",
      "body": "...",
      "why": "..."
    },
    ...
  ]
}`;
}

export function parseOutreachResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('outreach generator returned empty response');
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('outreach response is not JSON');
    parsed = JSON.parse(m[0]);
  }
  if (!parsed || !Array.isArray(parsed.templates)) {
    throw new Error('outreach JSON missing "templates" array');
  }
  return parsed.templates
    .filter(t => t && typeof t.host === 'string' && typeof t.subject === 'string' && typeof t.body === 'string')
    .map(t => ({
      host: t.host.trim(),
      subject: t.subject.trim().slice(0, 200),
      body: t.body.trim(),
      why: typeof t.why === 'string' ? t.why.trim().slice(0, 200) : '',
    }));
}

/**
 * Generate outreach email templates for the top-3 domains.
 *
 * Returns { templates: [...], costInfo } where templates may be empty if the
 * LLM call fails or topDomains is empty. Caller decides whether to surface
 * the section.
 */
export async function generateOutreachTemplates({
  brand, domain, category, topDomains, competitorHosts,
  providerName, providerCall, apiKey, model,
}) {
  if (!brand || !category) {
    return { templates: [], costInfo: null };
  }
  // Strip own domain (and competitor-owned hosts, fail-branch #10) BEFORE the
  // empty check so a list that contained only the user's own / competitor
  // domains collapses to [] and returns early (no LLM call, no self- or
  // competitor-pitch email drafted).
  const filteredDomains = filterOwnDomainFromTopDomains(topDomains, domain, competitorHosts);
  if (filteredDomains.length === 0) {
    return { templates: [], costInfo: null };
  }

  const prompt = buildOutreachPrompt({ brand, domain, category, topDomains: filteredDomains });
  const { text: responseText, raw } = await providerCall(prompt, apiKey, model, { webSearch: false });
  const templates = parseOutreachResponse(responseText);

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0,
  };
  const costInfo = {
    provider: providerName,
    model,
    label: 'outreach-templates',
    requests: 1,
    inputTokens: costDetail.inputTokens,
    outputTokens: costDetail.outputTokens,
    costUsd: costDetail.costUsd,
  };

  return { templates, costInfo };
}
