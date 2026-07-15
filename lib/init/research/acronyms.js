/**
 * Shared acronym dictionary for the init research pipeline — the SINGLE source of
 * truth for which acronyms must be expanded vs. left alone.
 *
 * Used by:
 *   - filter.js / score.js — reject / penalise a bare AMBIGUOUS acronym that
 *     lacks its expansion in the same query.
 *   - brainstorm.js — builds the prompt's acronym rule from these lists so the
 *     GENERATOR expands exactly what the filter would reject, and NOT the
 *     universally-understood ones. Previously the prompt said "expand EVERY
 *     acronym", which ballooned "AI" into "Artificial Intelligence" — a phrasing
 *     no real user searches, and one the filter never even flagged (AI was
 *     deliberately absent from AMBIGUOUS_ACRONYMS). Anchoring both sides on this
 *     file removes that contradiction.
 */

// Genuinely ambiguous industry acronyms — the same token means different things
// in different fields (e.g. AEO = Answer Engine Optimization OR Authorized
// Economic Operator; GEO = Generative Engine Optimization OR geography). These
// MUST be spelled out so downstream answer engines don't answer for the wrong
// industry.
export const AMBIGUOUS_ACRONYMS = [
  { abbr: 'AEO', expansion: 'Answer Engine Optimization' },
  { abbr: 'GEO', expansion: 'Generative Engine Optimization' },
  { abbr: 'CRO', expansion: 'Conversion Rate Optimization' },
  { abbr: 'CDP', expansion: 'Customer Data Platform' },
  { abbr: 'CRM', expansion: 'Customer Relationship Management' },
  { abbr: 'ERP', expansion: 'Enterprise Resource Planning' },
  { abbr: 'ROI', expansion: 'Return on Investment' },
  { abbr: 'KPI', expansion: 'Key Performance Indicator' },
];

// Universally-understood acronyms — a general audience reads these correctly and
// there is nothing to disambiguate. They must NOT be expanded: real users search
// "best AI voice tools", never "best Artificial Intelligence voice tools".
export const UNIVERSAL_ACRONYMS = ['AI', 'API', 'SaaS', 'SEO', 'HR', 'IT', 'B2B', 'B2C'];
