// Actionable output when every engine in `run` returned mention === 'error'.
// Distinct from research-failure-panel.js because:
//   - run has MULTIPLE queries × MULTIPLE engines, so we group by engine
//   - the user already has a valid .aeo-tracker.json; the fix is about
//     restoring access to engines, not reconfiguring queries
//   - skipping the run entirely (analog of --keywords in init) isn't an
//     option; instead we nudge toward fixing billing or removing engines

import { classifyProviderError, PROVIDER_BILLING_URLS } from '../providers/classify-error.js';
import { deriveTrainingModel } from '../providers/non-search-model.js';
import { PROVIDER_LABELS } from '../init/keys.js';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/**
 * Build the "all engines failed" panel.
 *
 * @param {Object} opts
 * @param {Array<{provider:string,label:string,model:string,error:string}>} opts.errorResults
 *   Subset of `results` where mention === 'error'. Same shape as summary.results.
 * @param {Object=} opts.providerConfig  From config.providers — gives env var names
 * @param {boolean} opts.useColor
 * @returns {string[]}  Lines ready for console.log
 */
export function formatAllEnginesFailedPanel({ errorResults, providerConfig = {}, useColor = true }) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', dim: '', bold: '', reset: '' };

  // Group errors by (provider, model) — same engine likely fails the same way
  // across all queries, so we dedupe and show the most informative message.
  const grouped = new Map();
  for (const r of errorResults) {
    const key = `${r.provider}/${r.model}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        provider: r.provider,
        label: r.label || PROVIDER_LABELS[r.provider] || r.provider,
        model: r.model,
        count: 0,
        firstError: r.error || 'no error message',
        classified: classifyProviderError(new Error(r.error || '')),
      });
    }
    grouped.get(key).count++;
  }

  const byEngine = [...grouped.values()];
  const lines = [];

  lines.push('');
  lines.push(`${c.red}${c.bold}  All engines failed — no mentions could be recorded this run.${c.reset}`);

  // Surface model-deprecated banner up-front if any engine returned 404
  // / "model not found" — that's a config-time fix the user needs to do
  // before any retry has a chance.
  const deprecatedEngines = [...grouped.values()].filter(g => g.classified.category === 'model-deprecated');
  if (deprecatedEngines.length > 0) {
    lines.push('');
    lines.push(`${c.yellow}  ⚠ One or more configured models are no longer available at the provider.${c.reset}`);
    lines.push(`${c.yellow}    Run ${c.bold}aeo-platform init${c.reset}${c.yellow} to refresh model selection.${c.reset}`);
    for (const g of deprecatedEngines) {
      lines.push(`${c.dim}      Affected: ${g.label} (${g.model})${c.reset}`);
    }
  }
  lines.push('');
  lines.push(`${c.bold}  What broke (grouped by engine):${c.reset}`);

  for (const g of byEngine) {
    const reason = g.classified.reason;
    lines.push(`    ${c.yellow}✗ ${g.label}${c.reset} (${g.model}) — ${reason} · ${g.count} ${g.count === 1 ? 'query' : 'queries'} affected`);
    const shortErr = g.firstError.length > 160 ? g.firstError.slice(0, 160) + '...' : g.firstError;
    lines.push(`      ${c.dim}"${shortErr}"${c.reset}`);
    const envVar = providerConfig[g.provider]?.env;
    if (envVar) lines.push(`      ${c.dim}read from $${envVar}${c.reset}`);
  }

  lines.push('');
  lines.push(`${c.bold}  How to fix — pick one:${c.reset}`);
  lines.push('');

  // Walk fix-categories in order of likely first-action; sequential numbering
  // via a counter so re-ordering or skipping doesn't desync the labels.
  let step = 0;
  const numbered = (header, ...body) => {
    step++;
    lines.push(`    ${c.bold}${step}.${c.reset} ${header}`);
    for (const b of body) lines.push(b);
    lines.push('');
  };

  // 1. Model deprecated → re-init. Comes first: no other fix brings back a removed model.
  if (deprecatedEngines.length > 0) {
    numbered(
      `Re-run init to pick a current model (the deprecated one is gone for good):`,
      `         ${c.dim}aeo-platform init${c.reset}`,
    );
  }

  // Top up billing for engines that hit billing errors.
  const billingEngines = byEngine.filter(g => g.classified.category === 'billing');
  if (billingEngines.length > 0) {
    const urlLines = billingEngines
      .map(g => PROVIDER_BILLING_URLS[g.provider] && `         ${g.label}: ${PROVIDER_BILLING_URLS[g.provider]}`)
      .filter(Boolean);
    numbered('Top up billing on the failed providers:', ...urlLines);
  }

  // Regenerate keys for auth failures.
  const authEngines = byEngine.filter(g => g.classified.category === 'auth');
  if (authEngines.length > 0) {
    const keyLines = authEngines.map(g => {
      const envVar = providerConfig[g.provider]?.env;
      const hint = envVar ? ` (currently read from $${envVar})` : '';
      return `         ${g.label}${hint}`;
    });
    numbered(`Regenerate API keys for the failed providers (the old keys may be revoked or typo'd):`, ...keyLines);
  }

  // Wait + retry for rate-limits — plus a concrete model-swap suggestion when
  // the failed engine has a non-search counterpart with higher TPM headroom.
  const rateLimitedEngines = byEngine.filter(g => g.classified.category === 'rate-limit');
  if (rateLimitedEngines.length > 0) {
    // Build per-engine swap suggestions: only include engines whose training
    // counterpart differs from the current model (search-capable → base).
    // For OpenAI: gpt-5-search-api → gpt-5; for Anthropic/Gemini: same id (skip);
    // for Perplexity: returns null (skip — search-only by design).
    const swaps = rateLimitedEngines
      .map(g => {
        const alt = deriveTrainingModel(g.provider, g.model);
        if (!alt || alt === g.model) return null;
        return { provider: g.provider, currentModel: g.model, altModel: alt };
      })
      .filter(Boolean);

    if (swaps.length > 0) {
      // Combined command shows all swappable engines in one re-run line.
      const flagStr = swaps.map(s => `--${s.provider}-model ${s.altModel}`).join(' ');
      numbered(
        `Switch to non-search model(s) for higher TPM (no live web search, training-corpus signal only):`,
        `         ${c.dim}aeo-platform run ${flagStr}${c.reset}`,
        `         ${c.dim}This is a tokens-per-minute (TPM) limit, not a billing issue — your account balance is fine.${c.reset}`,
      );
    } else {
      numbered(
        `Wait 1-2 minutes and re-run — rate limits reset quickly:`,
        `         ${c.dim}aeo-platform run${c.reset}`,
        `         ${c.dim}This is a tokens-per-minute (TPM) limit, not a billing issue.${c.reset}`,
      );
    }
  }

  // Network/site-fetch: infrastructure issue. Rerun when restored.
  const infraEngines = byEngine.filter(g => ['network', 'site-fetch'].includes(g.classified.category));
  if (infraEngines.length > 0) {
    numbered(
      `Check your internet connection and retry — every engine reported a network-level failure:`,
      `         ${c.dim}aeo-platform run${c.reset}`,
    );
  }

  // Transient provider server errors (5xx): a provider-side hiccup. Wait + rerun.
  const serverErrorEngines = byEngine.filter(g => g.classified.category === 'server-error');
  if (serverErrorEngines.length > 0) {
    numbered(
      `Wait a moment and re-run — an engine returned a transient server error (5xx), usually a provider-side hiccup that clears on its own:`,
      `         ${c.dim}aeo-platform run${c.reset}`,
    );
  }

  // Always-on escape hatch — last option.
  numbered(
    `Temporarily remove a failing engine from .aeo-tracker.json (keep the others running):`,
    `         ${c.dim}edit the "providers" section, delete the entry for the failing provider${c.reset}`,
  );

  lines.push(`${c.dim}  No report was generated for this run — previous runs in aeo-responses/ are unaffected.${c.reset}`);

  return lines;
}
