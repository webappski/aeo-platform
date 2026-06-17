/**
 * AP-FIX-COVERAGE-AXIS — coverage axis = product lines, not client verticals
 * (Gcore root-cause 2026-06-17).
 *
 * Two upstream causes of the off-target basket:
 *   1. brainstorm rule B rewarded spanning 2+ client INDUSTRIES — wrong axis for
 *      a horizontal brand (Gcore: CDN/GPU/DDoS), so it generated healthcare/
 *      fintech queries the brand can't rank for.
 *   2. score.js gave +10 (and a +10 long-tail) for ANY vertical marker, floating
 *      those off-target queries into the top-3.
 *
 * The fix derives the brand's product lines once (product-lines.js) and:
 *   - brainstorm rule B steers across product lines when they're known;
 *   - the score specificity bonus is gated on product-line overlap (legacy
 *     behaviour preserved when lines can't be extracted — no regression);
 *   - the shared select comparator keeps brand-fit a tiebreaker, score primary.
 */

import test from 'node:test';
import assert from 'node:assert';
import { deriveProductLines } from '../lib/init/research/product-lines.js';
import { scoreCandidate } from '../lib/init/research/score.js';
import { compareCandidates } from '../lib/init/research/select.js';
import { buildBrainstormPrompt } from '../lib/init/research/brainstorm.js';

// ── product-line derivation ─────────────────────────────────────────────────

test('deriveProductLines extracts a real product list from H2', () => {
  const r = deriveProductLines({ h2: ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage'] });
  assert.deepEqual(r.lines, ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage']);
  assert.equal(r.source, 'h2');
  assert.equal(r.degraded, false);
});

test('deriveProductLines de-dupes case-insensitively', () => {
  const r = deriveProductLines({ h2: ['CDN', 'cdn', 'GPU Cloud', 'GPU Cloud'] });
  assert.deepEqual(r.lines, ['CDN', 'GPU Cloud']);
});

test('NEGATIVE REGRESSION: slogan-only H2 degrades to empty + flag (never junk lines)', () => {
  // Horizontal-infra landing pages: H2 is marketing chrome, not a product list.
  const r = deriveProductLines({
    h2: ['Build without limits', 'Trusted by thousands of teams', 'Get started today'],
    h1: ['The platform for everyone'],
  });
  assert.deepEqual(r.lines, [], 'must NOT treat slogans as product lines');
  assert.equal(r.degraded, true, 'must flag degraded so brand-fit becomes unknown, basket not penalised');
});

test('deriveProductLines drops sentences/questions/over-long headings', () => {
  const r = deriveProductLines({
    h2: ['Edge Network', 'How does our pricing work?', 'We help you ship faster than ever before today'],
  });
  // Only the short noun-phrase line survives; degraded because <2 clean lines.
  assert.deepEqual(r.lines, [], 'one clean line is below the 2-line confidence floor → degraded');
  assert.equal(r.degraded, true);
});

test('deriveProductLines falls back to H1 when H2 is slogan-heavy but H1 lists offerings', () => {
  const r = deriveProductLines({
    h2: ['Build without limits'],
    h1: ['Managed Kubernetes', 'Serverless Functions'],
  });
  assert.deepEqual(r.lines, ['Managed Kubernetes', 'Serverless Functions']);
  assert.equal(r.source, 'h1');
});

// ── score gating (the core Gcore fix) ───────────────────────────────────────

test('NEGATIVE REGRESSION: off-target vertical query earns NO specificity/long-tail bonus when product lines are known', () => {
  // "VPC for healthcare" against a CDN/DDoS brand — the exact Gcore failure.
  // Before the fix this earned +10 specificity AND +10 long-tail (= +20),
  // floating it into the top-3. After the fix: zero, because it overlaps no line.
  const r = scoreCandidate(
    { text: 'best VPC for healthcare companies', intent: 'commercial' },
    { productLines: ['CDN', 'DDoS Protection', 'GPU Cloud'] },
  );
  const specOrLongtail = r.scoreReasons.filter(x => /product-line|specificity|long-tail/.test(x));
  assert.deepEqual(specOrLongtail, [],
    'off-target vertical must earn no product-line/specificity/long-tail bonus');
});

test('on-target product-line query earns the gated bonus + long-tail', () => {
  const r = scoreCandidate(
    { text: 'best CDN providers for enterprise', intent: 'commercial' },
    { productLines: ['CDN', 'DDoS Protection'] },
  );
  assert.ok(r.scoreReasons.some(x => x.includes('+10 product-line match')));
  assert.ok(r.scoreReasons.some(x => x.includes('+10 long-tail structure')));
});

test('NO REGRESSION: when product lines are unknown, a specificity marker is still rewarded', () => {
  // Single-vertical brand whose offering we couldn't enumerate — must keep the
  // legacy +10 so we don't silently down-rank legitimate vertical queries.
  const r = scoreCandidate(
    { text: 'best tools for healthcare', intent: 'commercial' },
    {}, // no productLines
  );
  assert.ok(r.scoreReasons.some(x => x.includes('+10 specificity marker')),
    'legacy specificity bonus preserved when lines unknown');
});

test('score gating does not touch unrelated bonuses (word-count, recency, comparison)', () => {
  const r = scoreCandidate(
    { text: 'best CDN alternative to competitor 2026', intent: 'commercial' },
    { productLines: ['CDN'] },
  );
  assert.ok(r.scoreReasons.some(x => x.includes('word-count sweet-spot')));
  assert.ok(r.scoreReasons.some(x => x.includes('recency marker')));
  assert.ok(r.scoreReasons.some(x => x.includes('comparison structure')));
});

// ── shared selection comparator ─────────────────────────────────────────────

test('compareCandidates: score is the primary key', () => {
  const sorted = [
    { text: 'lower', score: 70, brandFitRank: 2 },
    { text: 'higher', score: 90, brandFitRank: 0 },
  ].sort(compareCandidates);
  assert.equal(sorted[0].text, 'higher', 'higher score wins even with worse brand-fit');
});

test('compareCandidates: brand-fit breaks a score tie (core over aspirational)', () => {
  const sorted = [
    { text: 'aspirational', score: 80, brandFitRank: 0 },
    { text: 'core', score: 80, brandFitRank: 2 },
  ].sort(compareCandidates);
  assert.equal(sorted[0].text, 'core');
});

test('compareCandidates: a candidate without brandFitRank sorts at neutral rank', () => {
  const sorted = [
    { text: 'aspirational', score: 80, brandFitRank: 0 },
    { text: 'legacy-no-rank', score: 80 },
  ].sort(compareCandidates);
  assert.equal(sorted[0].text, 'legacy-no-rank', 'legacy candidate (neutral) beats aspirational on a tie');
});

// ── brainstorm rule B (prompt steering) ─────────────────────────────────────

test('NEGATIVE REGRESSION: rule B steers across product lines (not industries) when lines are known', () => {
  const prompt = buildBrainstormPrompt({
    brand: 'gcore', domain: 'gcore.com',
    site: { lang: 'en', title: 'Gcore', h2: ['CDN', 'DDoS Protection', 'GPU Cloud', 'Object Storage'] },
    categoryDescription: 'cloud and edge infrastructure',
  });
  assert.match(prompt, /PRODUCT LINES/);
  assert.match(prompt, /CDN, DDoS Protection, GPU Cloud, Object Storage/);
  // The old wording explicitly told the LLM to span client industries — gone
  // when lines are present.
  assert.doesNotMatch(prompt, /span 2\+ industries/);
});

test('rule B falls back to offering-diversity guidance when product lines cannot be extracted', () => {
  const prompt = buildBrainstormPrompt({
    brand: 'acme', domain: 'acme.com',
    site: { lang: 'en', title: 'Acme', h2: ['Build without limits', 'Get started'] }, // slogans → no lines
    categoryDescription: 'some product',
  });
  assert.match(prompt, /Product-line coverage/);
  assert.match(prompt, /distinct offerings/);
});

console.log('coverage-axis.test.js — all assertions passed');
