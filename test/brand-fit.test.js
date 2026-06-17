/**
 * AP-FIX-BRANDFIT — brand-capability fit classifier (Gcore root-cause 2026-06-17).
 *
 * The pipeline checked query→industry fit but never query→brand-capability fit,
 * so an off-target basket (e.g. "VPC for healthcare" against a CDN brand)
 * produced a brand-irrelevant 0%. This classifier labels each candidate
 * core/adjacent/aspirational/unknown as a RANKING signal — never a blocker.
 *
 * These tests cover the pure module + its non-destructive batch annotator. The
 * NEGATIVE-REGRESSION cases lock the two invariants Архип set: (1) brand-fit
 * never penalises an un-groundable basket (degraded → unknown, neutral rank),
 * (2) single-provider mode is always unknown (no one-model basket bias).
 */

import test from 'node:test';
import assert from 'node:assert';
import {
  BRAND_FIT, brandFitRank, classifyByOverlap, classifyBrandFit, annotateBrandFit,
} from '../lib/init/research/brand-fit.js';

test('BRAND_FIT labels are the four expected values', () => {
  assert.deepEqual(
    Object.values(BRAND_FIT).sort(),
    ['adjacent', 'aspirational', 'core', 'unknown'],
  );
});

test('rank ordering: core > adjacent == unknown > aspirational', () => {
  assert.ok(brandFitRank(BRAND_FIT.CORE) > brandFitRank(BRAND_FIT.ADJACENT));
  assert.equal(brandFitRank(BRAND_FIT.UNKNOWN), brandFitRank(BRAND_FIT.ADJACENT),
    'unknown must be NEUTRAL — never ranked below a genuinely-aspirational query');
  assert.ok(brandFitRank(BRAND_FIT.ADJACENT) > brandFitRank(BRAND_FIT.ASPIRATIONAL));
});

test('rank of an unrecognised label falls back to neutral (adjacent)', () => {
  assert.equal(brandFitRank('garbage'), brandFitRank(BRAND_FIT.ADJACENT));
});

// ── cross-model verdict precedence ──────────────────────────────────────────

test('a valid llm brand_fit verdict is authoritative', () => {
  assert.equal(classifyBrandFit({ queryText: 'anything', llmFit: 'core' }).fit, BRAND_FIT.CORE);
  assert.equal(classifyBrandFit({ queryText: 'anything', llmFit: 'ASPIRATIONAL' }).fit, BRAND_FIT.ASPIRATIONAL,
    'llm label is case-insensitive');
  const r = classifyBrandFit({ queryText: 'x', llmFit: 'adjacent', llmConfidence: 'high' });
  assert.equal(r.source, 'llm');
  assert.equal(r.confidence, 'high');
});

test('an unrecognised llm label is ignored, falls through to local logic', () => {
  // llmFit garbage + product-line overlap → overlap path, not the bad label.
  const r = classifyBrandFit({ queryText: 'best CDN providers', llmFit: 'sorta-maybe', productLines: ['CDN'] });
  assert.equal(r.fit, BRAND_FIT.CORE);
  assert.equal(r.source, 'overlap');
});

// ── local overlap fallback ──────────────────────────────────────────────────

test('overlap classifier promotes to core only on a product-line hit', () => {
  const hit = classifyByOverlap('best DDoS protection services', ['DDoS Protection', 'CDN']);
  assert.equal(hit.fit, BRAND_FIT.CORE);
  const miss = classifyByOverlap('best email marketing platforms 2026', ['DDoS Protection', 'CDN']);
  assert.equal(miss.fit, BRAND_FIT.ADJACENT, 'no overlap → adjacent, never aspirational from local signal alone');
});

test('overlap classifier ignores stopwords (no false core on "best"/"for"/"tools")', () => {
  // "best ... tools for ..." shares only stopwords with the line — must NOT hit core.
  const r = classifyByOverlap('best tools for teams', ['Customer Relationship Management']);
  assert.notEqual(r.fit, BRAND_FIT.CORE);
});

test('overlap classifier returns unknown when there are no product lines', () => {
  assert.equal(classifyByOverlap('best CDN', []).fit, BRAND_FIT.UNKNOWN);
});

// ── NEGATIVE REGRESSION: never penalise an un-groundable basket ──────────────

test('NEGATIVE REGRESSION: no product lines AND no llm verdict → unknown (basket not penalised)', () => {
  const r = classifyBrandFit({ queryText: 'best VPC for healthcare', productLines: [] });
  assert.equal(r.fit, BRAND_FIT.UNKNOWN,
    'an un-groundable query must be unknown — NEVER aspirational from an empty H2');
  assert.equal(brandFitRank(r.fit), brandFitRank(BRAND_FIT.ADJACENT),
    'and its rank must be neutral so selection falls back to score alone');
});

test('NEGATIVE REGRESSION: single-provider mode is always unknown', () => {
  // Even WITH product lines that would overlap, single-provider must not assert
  // fit — one model brainstormed the basket, so a one-model fit call is biased.
  const r = classifyBrandFit({ queryText: 'best CDN providers', productLines: ['CDN'], singleProvider: true });
  assert.equal(r.fit, BRAND_FIT.UNKNOWN);
  assert.equal(r.source, 'none');
});

// ── batch annotator (non-destructive; used by research.js Phase 4) ───────────

test('annotateBrandFit attaches fit fields without mutating inputs', () => {
  const input = [{ text: 'best CDN providers', score: 80, validation: 'ok' }];
  const out = annotateBrandFit(input, { productLines: ['CDN'] });
  assert.equal(out[0].brandFit, BRAND_FIT.CORE);
  assert.equal(typeof out[0].brandFitRank, 'number');
  assert.equal(out[0].score, 80, 'pre-existing fields preserved');
  assert.equal(out[0].validation, 'ok', 'validation field untouched — brand-fit is not a blocker');
  assert.equal(input[0].brandFit, undefined, 'input object NOT mutated');
});

test('annotateBrandFit prefers the llm verdict map over local overlap', () => {
  const input = [{ text: 'best CDN providers', score: 80 }];
  // CDN would overlap locally → core, but the llm map says aspirational; llm wins.
  const llmByText = new Map([['best CDN providers', { brand_fit: 'aspirational', confidence: 'high' }]]);
  const out = annotateBrandFit(input, { productLines: ['CDN'], llmByText });
  assert.equal(out[0].brandFit, BRAND_FIT.ASPIRATIONAL);
  assert.equal(out[0].brandFitSource, 'llm');
});

test('NEGATIVE REGRESSION: annotateBrandFit on degraded grounding → all unknown, all neutral rank', () => {
  const input = [
    { text: 'best VPC for healthcare', score: 90 },
    { text: 'enterprise fintech orchestration', score: 85 },
  ];
  // No product lines, no llm map, cross-model present (singleProvider:false default).
  const out = annotateBrandFit(input, { productLines: [] });
  assert.ok(out.every(c => c.brandFit === BRAND_FIT.UNKNOWN), 'every candidate unknown');
  assert.ok(out.every(c => c.brandFitRank === brandFitRank(BRAND_FIT.ADJACENT)),
    'every rank neutral → selection order identical to pre-fix (score only)');
});

console.log('brand-fit.test.js — all assertions passed');
