/**
 * Measurement-surface disclaimer — one source of truth for "what this tool
 * actually measures" (review #3, AP-DISCLAIMER-API-SURFACE).
 *
 * The tool queries each engine's **API surface** with the user's own keys
 * (OpenAI `gpt-5-mini` + Responses `web_search` tool, Perplexity `sonar*`,
 * Gemini `generateContent` + grounding). That is a reproducible, auditable proxy —
 * but it is NOT the same retrieval pipeline, model version, personalization,
 * or locale that a human sees on the consumer apps (chatgpt.com,
 * perplexity.ai, the Gemini app). It also does not cover Google AI Overviews /
 * AI Mode or Microsoft Copilot, which have no first-party query API.
 *
 * Stamped into `_summary.json` (`measurement`) so the artifact is honest about
 * its own scope, and rendered in the report header. Kept here — not inlined —
 * so the JSON field and the rendered string can never drift apart.
 */
export const MEASUREMENT_DISCLAIMER = Object.freeze({
  surface: 'api',
  disclaimer:
    "Measures each engine's API surface via your own keys — a reproducible " +
    'proxy, NOT a guarantee of what the consumer app (chatgpt.com, ' +
    'perplexity.ai, the Gemini app) shows to a human; excludes Google AI ' +
    'Overviews / AI Mode and Microsoft Copilot.',
});

/**
 * Short one-line form for the dense report masthead, where the full sentence
 * would crowd the date/version row. Same meaning, fewer words.
 */
export const MEASUREMENT_DISCLAIMER_SHORT =
  'API surface (your keys) — a reproducible proxy, not the consumer apps; no AI Overviews / Copilot.';
