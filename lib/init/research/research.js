/**
 * Orchestrator — runs all 4 research phases end-to-end and returns a
 * structured result ready for selection (C7) and user review.
 *
 * Phases:
 *   1. Brainstorm (LLM call #1, primary provider)
 *   2. Filter + dedup + validate shape (local)
 *   3. Intent reconciliation + scoring (local, language-aware)
 *   4. Cross-model category validation (LLM call #2, DIFFERENT provider if possible)
 *   5. Result simulation (LLM call #3, validator provider) — predicts what AI engines
 *      would actually cite for each query; rejects queries whose predicted results are
 *      off-category (geographic + acronym collision detection)
 *
 * Note: buyer-intent filtering was intentionally removed. In AEO context even
 * "informational" queries are valuable — the AI may cite vendors in its answer.
 *
 * Returns the full trace so the caller (cmdInit) can show users what happened
 * at each phase, not just the final queries.
 */

import { runBrainstorm } from './brainstorm.js';
import { filterCandidates } from './filter.js';
import { reconcileIntent } from './classify-intent.js';
import { scoreAll } from './score.js';
import { runValidation } from './validate-category.js';
import { runSimulation } from './simulate.js';
import { deriveProductLines } from './product-lines.js';
import { annotateBrandFit } from './brand-fit.js';

/**
 * @param {Object} opts
 * @param {string} opts.brand
 * @param {string} opts.domain
 * @param {Object} opts.site          parseSiteContent output
 * @param {string} opts.category      CATEGORY_DESCRIPTION (required)
 * @param {Array}  opts.audienceTags  from detectAudience
 * @param {Array}  opts.geoTags       from detectGeography
 *
 * Provider configuration — at least `primary` must be set. `validator` enables
 * cross-model validation; if omitted, validation is skipped with a warning.
 *
 * @param {Object} opts.primary       { providerCall, apiKey, model, label }
 * @param {Object} [opts.validator]   { providerCall, apiKey, model, label } — different provider
 *
 * @param {Function} [opts.logPhase]  reporter: ({ phase, status, details }) => void
 */
export async function research(opts) {
  const {
    brand, domain, site, category,
    audienceTags = [], geoTags = [],
    primary, validator,
    logPhase = () => {},
  } = opts;

  if (!primary || !primary.providerCall) {
    throw new Error('research() requires opts.primary.providerCall');
  }

  const trace = {
    phases: {},
    estimatedCostUsd: 0,
    startedAt: Date.now(),
  };

  // Derive the brand's product lines ONCE — shared by coverage-axis scoring
  // (Phase 3) and brand-fit classification (Phase 4). Honest degradation: when
  // the site doesn't enumerate its lines we get an empty list + a flag, and
  // brand-fit becomes `unknown` rather than penalising the basket.
  const productLineInfo = deriveProductLines(site);
  const productLines = productLineInfo.lines;
  trace.productLines = { lines: productLines, source: productLineInfo.source, degraded: productLineInfo.degraded };
  if (productLineInfo.degraded) {
    logPhase({ phase: 'product-lines', status: 'warning', details: { reason: 'could not extract product lines from H2/H1 — brand-fit will be unknown (basket not penalised)' } });
  }

  // ─── Phase 1 — Brainstorm ───
  logPhase({ phase: 'brainstorm', status: 'started' });
  const brainstormResult = await runBrainstorm({
    brand, domain, site, categoryDescription: category,
    audienceTags, geoTags,
    providerCall: primary.providerCall,
    apiKey: primary.apiKey,
    model: primary.model,
    onAttempt: ({ attempt, total, estimate }) => {
      logPhase({ phase: 'brainstorm', status: 'attempt', details: { attempt, total, estimate } });
      if (attempt === 1) trace.estimatedCostUsd += estimate.usd;
    },
  });
  trace.phases.brainstorm = {
    candidatesByBucket: brainstormResult.buckets,
    totalCandidates: brainstormResult.totalAcross,
    provider: primary.label || 'primary',
  };
  logPhase({ phase: 'brainstorm', status: 'done', details: { count: brainstormResult.totalAcross } });

  // ─── Phase 2 — Filter ───
  logPhase({ phase: 'filter', status: 'started' });
  const { kept: filtered, rejected: filteredOut } = filterCandidates(brainstormResult.flat, { brand, domain });
  // 1.0.6: dropped checkVerticalDiversity — only `commercial` intent remains
  // in INTENT_BUCKETS so the vertical-diversity check would emit a spurious
  // "no vertical-intent candidates" warning on every run.
  trace.phases.filter = {
    kept: filtered.length,
    rejected: filteredOut,
  };
  logPhase({ phase: 'filter', status: 'done', details: { kept: filtered.length, rejected: filteredOut.length } });

  // 1.0.6: threshold lowered from < 6 to < 3 — brainstorm now produces 5
  // commercial candidates total (was 20 across 4 buckets). The pipeline
  // needs at least 3 to fill the top-3 slots.
  if (filtered.length < 3) {
    throw new Error(`Only ${filtered.length} candidates survived filtering; need at least 3 to continue.`);
  }

  // ─── Phase 3 — Classify + Score ───
  logPhase({ phase: 'score', status: 'started' });
  const reconciled = filtered.map(c => reconcileIntent(c, site.lang || 'en'));
  const scored = scoreAll(reconciled.map(r => ({ text: r.text, intent: r.intentFinal })), { lang: site.lang || 'en', productLines });
  // Sort descending, then attach the reconciliation metadata for audit
  const scoredWithMeta = scored
    .map((s, i) => ({ ...s, intentAgreement: reconciled[i].intentAgreement }))
    .sort((a, b) => b.score - a.score);
  trace.phases.score = {
    topN: scoredWithMeta.slice(0, 5).map(s => ({ text: s.text, intent: s.intent, score: s.score })),
    total: scoredWithMeta.length,
  };
  logPhase({ phase: 'score', status: 'done', details: { total: scoredWithMeta.length, topScore: scoredWithMeta[0]?.score } });

  // ─── Phase 4 — Cross-model validation ───
  let finalPool = scoredWithMeta;
  if (validator && validator.providerCall) {
    logPhase({ phase: 'validate', status: 'started', details: { validator: validator.label || 'validator' } });
    try {
      const { validated, rejected: validationRejected } = await runValidation({
        candidates: scoredWithMeta,
        brand, category, productLines,
        providerCall: validator.providerCall,
        apiKey: validator.apiKey,
        model: validator.model,
        onAttempt: ({ estimate }) => {
          trace.estimatedCostUsd += estimate.usd;
        },
      });
      // Attach brand-fit as a RANKING signal (core > adjacent > aspirational),
      // grounded on the cross-model brand_fit verdict + product lines. Never a
      // blocker: this does not touch `validation`/`valid`/search_behavior.
      const llmByText = new Map(
        validated
          .filter(v => v.brand_fit)
          .map(v => [v.text, { brand_fit: v.brand_fit, confidence: v.confidence }])
      );
      finalPool = annotateBrandFit(validated, { productLines, llmByText, singleProvider: false });
      const fitCounts = finalPool.reduce((acc, c) => { acc[c.brandFit] = (acc[c.brandFit] || 0) + 1; return acc; }, {});
      trace.phases.validate = {
        validatedCount: validated.length,
        rejected: validationRejected,
        validatorProvider: validator.label || 'validator',
        brandFitCounts: fitCounts,
      };
      logPhase({ phase: 'validate', status: 'done', details: { validated: validated.length, rejected: validationRejected.length, brandFit: fitCounts } });
    } catch (err) {
      trace.phases.validate = { skipped: true, reason: err.message };
      logPhase({ phase: 'validate', status: 'failed', details: { reason: err.message } });
    }
  } else {
    // Single-provider mode: brand-fit cannot be cross-checked. Tag every
    // candidate `unknown` (neutral rank) + WARN — the basket is NOT penalised.
    finalPool = annotateBrandFit(scoredWithMeta, { productLines, singleProvider: true });
    trace.phases.validate = { skipped: true, reason: 'no second provider available — single-model bias risk', brandFit: 'unknown (not cross-checked)' };
    logPhase({ phase: 'validate', status: 'skipped', details: { reason: 'no second provider configured — brand-fit not checked' } });
  }

  // ─── Phase 5 — Result simulation ───
  if (validator && validator.providerCall) {
    logPhase({ phase: 'simulate', status: 'started', details: { provider: validator.label || 'validator' } });
    try {
      const { passed, failed, skippedAboveLimit } = await runSimulation({
        candidates: finalPool,
        brand, category,
        providerCall: validator.providerCall,
        apiKey: validator.apiKey,
        model: validator.model,
      });

      // Auto-correct failed candidates: if LLM provided a suggestedFix, replace the
      // original query text with the unambiguous version and keep it in the pool.
      // Candidates with no fix are dropped silently.
      const autoFixed = failed
        .filter(c => c.simulationDetails?.suggestedFix)
        .map(c => ({
          ...c,
          text: c.simulationDetails.suggestedFix,
          simulation: 'auto-fixed',
          originalText: c.text,
        }));

      finalPool = [...passed, ...autoFixed, ...skippedAboveLimit];

      trace.phases.simulate = {
        passed: passed.length,
        failed: failed.map(c => ({
          query: c.text,
          dominantIndustry: c.simulationDetails?.dominantIndustry || '',
          predictedDomains: c.simulationDetails?.predictedDomains || [],
          suggestedFix: c.simulationDetails?.suggestedFix || null,
        })),
        skippedAboveLimit: skippedAboveLimit.length,
      };
      logPhase({ phase: 'simulate', status: 'done', details: { passed: passed.length, failed: failed.length } });
    } catch (err) {
      trace.phases.simulate = { skipped: true, reason: err.message };
      logPhase({ phase: 'simulate', status: 'failed', details: { reason: err.message } });
    }
  } else {
    trace.phases.simulate = { skipped: true, reason: 'no validator provider — simulation requires second LLM' };
    logPhase({ phase: 'simulate', status: 'skipped', details: { reason: 'no validator provider' } });
  }

  trace.elapsedMs = Date.now() - trace.startedAt;

  return {
    candidates: finalPool,
    trace,
  };
}
