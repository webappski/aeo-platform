#!/usr/bin/env node

/**
 * aeo-platform v1.0.0-rc.1
 * Open-source AEO platform — measure, audit, diagnose, recommend, and plan-generate
 * brand visibility across ChatGPT, Claude, Gemini, and Perplexity.
 * https://webappski.com | MIT License
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { CONFIG_FILE, DEFAULT_CONFIG, PROVIDER_PRIORITY, applyCliModelOverrides } from '../lib/config.js';
import { PROVIDERS } from '../lib/providers/index.js';
import { detectMention, findPosition, extractUrls } from '../lib/mention.js';
import { diff } from '../lib/diff.js';
import { renderMarkdown, parseRawResponse } from '../lib/report/markdown.js';
import { renderHtml } from '../lib/report/html.js';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';
import { classifyCitations } from '../lib/report/classify-citations.js';
import { discoverModels, FALLBACK as MODEL_FALLBACK } from '../lib/providers/discover.js';
import { MAIN_OPTIONS_BY_PROVIDER, detectThinkingActive } from '../lib/providers/main-options.js';
import { extractUsage, calcCost, estimateWeeklyCost } from '../lib/providers/pricing.js';
import { formatTpmHint, estimateRunDuration } from '../lib/util/cost-estimate.js';
import { planSchedule, runScheduled } from '../lib/util/scheduler.js';
import { estimatePerRequest, getLearnedOrTierLimit } from '../lib/providers/tpm-ledger.js';
import { createLiveRows } from '../lib/util/live-rows.js';
// Stable dependencies used in hot paths (init + run + queries-only) — promoted
// from dynamic imports for clarity and cold-start speed.
import { runTwoStageValidation, formatValidationResult, hasBlockers } from '../lib/init/research/run-validation.js';
import { classifyResponseQuality } from '../lib/report/response-quality.js';
import { extractWithTwoModels } from '../lib/report/extract-competitors-llm.js';
import { classifySentimentWithTwoModels } from '../lib/report/sentiment-classify.js';
import { detectAdsInResponse, summariseAdsAcrossResults } from '../lib/report/ads-detector.js';
import { normalizeQueries } from '../lib/config/queries-normalize.js';
import { parseGeoFlag, wrapQueryForRegion, listRegionCodes } from '../lib/report/geo-context.js';
import { computeTopDomains } from '../lib/report/top-domains.js';
import { isOwnDomain } from '../lib/report/own-domain.js';
// `report`-only and `export`-only modules are dynamically imported inside their
// command handlers to keep cold-start fast for `--help`, `--version`, `init`
// and `run` paths (saved ~9 eager imports / ~250–300 ms on a cold disk).
import { deriveTrainingModel, daysSinceLastFullRun } from '../lib/providers/non-search-model.js';
import { PROVIDER_LABELS, detectStandardKeys, heuristicKeyMatch, keySetupLines, classifyKeyMode, RESEARCH_CAPABLE } from '../lib/init/keys.js';
import { checkNodeVersion } from '../lib/util/node-version.js';
import { atomicWriteJson } from '../lib/util/atomic-write.js';

// Node version gate — BEFORE any command runs. package.json `engines` is only
// an npm warning; on Node < 20 the first runtime gap (e.g. global fetch on 16)
// used to surface as a bare cryptic error. One sentence, one next step.
// Note: ESM hoisting means ALL imports in this file (including those written
// below) evaluate before this block — it gates command dispatch, not imports.
// No module in lib/ uses Node-20+-only APIs at load time, so the gate is
// reachable on old Node.
{
  const nv = checkNodeVersion(process.versions.node);
  if (!nv.ok) {
    console.error(nv.message);
    process.exit(1);
  }
}
import { detectGeography } from '../lib/init/fetch-site.js';
import { classifyProviderError } from '../lib/providers/classify-error.js';
import { formatResearchFailurePanel } from '../lib/init/research-failure-panel.js';
import { formatAllEnginesFailedPanel } from '../lib/errors/all-engines-failed-panel.js';
import { formatUnexpectedErrorPanel } from '../lib/errors/unexpected-error-panel.js';
import { createSpinner } from '../lib/util/spinner.js';
import { sanitizeForFilename } from '../lib/util/safe-filename.js';

/**
 * Safely extract a human-readable message from any caught value.
 * `catch (err)` receives an `unknown` — err may be a string, a number, null,
 * or a proper Error. `.message` is only defined on Error subclasses, so guard.
 */
const errMsg = (err) => (err instanceof Error ? err.message : String(err));

// ─── ANSI colors (zero-dep) ───
// Disable ANSI when stdout is not a TTY (piped to file, CI logs) or NO_COLOR is set (no-color.org convention).
// This keeps CI log files clean — no \x1b[...m noise in GitHub Actions / GitLab CI output.
const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = USE_COLOR
  ? {
      reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
      red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
      blue: '\x1b[34m', cyan: '\x1b[36m', white: '\x1b[37m',
    }
  : {
      reset: '', bold: '', dim: '',
      red: '', green: '', yellow: '',
      blue: '', cyan: '', white: '',
    };

// Status glyphs. The Unicode set (✓ ⚠ ✗) renders fine on Windows Terminal,
// macOS Terminal, and any modern Linux terminal — but old cmd.exe with the
// default cp866/cp1251 codepage shows them as ?? boxes. We tie the fallback
// to the same USE_COLOR signal: terminals that don't do ANSI usually don't
// do Unicode glyphs either, so the ASCII set keeps the output readable.
const SYM = USE_COLOR
  ? { ok: '✓', warn: '⚠', err: '✗' }
  : { ok: '+', warn: '!', err: 'x' };

// ─── Stale artifact cleanup ─────────────────────────────────────────
//
// `aeo-platform report` writes to aeo-reports/<latest-date>/. Older date
// directories accumulate orphaned report.md / report.html from previous tool
// versions or out-of-cycle runs — those become misleading after a layout
// rewrite (e.g. v0.5 bento) because the old reports still render the old
// layout, and a reader who opens the wrong file thinks the new code is broken.
// Called from cmdReport after the latest artifacts are written.
async function cleanupStaleReportArtifacts(latestDate) {
  const reportsDir = 'aeo-reports';
  if (!existsSync(reportsDir)) return { removedFiles: 0, removedDirs: 0 };
  const { readdirSync, rmdirSync } = await import('node:fs');
  const { unlink } = await import('node:fs/promises');
  let removedFiles = 0;
  let removedDirs = 0;
  for (const entry of readdirSync(reportsDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;  // only date-named dirs
    if (entry === latestDate) continue;                 // never touch the latest
    const dirPath = join(reportsDir, entry);
    for (const fname of ['report.html', 'report.md']) {
      const p = join(dirPath, fname);
      if (existsSync(p)) {
        try { await unlink(p); removedFiles++; } catch { /* skip */ }
      }
    }
    // Remove the date dir if it's now empty (no custom files left).
    try {
      if (readdirSync(dirPath).length === 0) {
        rmdirSync(dirPath);
        removedDirs++;
      }
    } catch { /* skip */ }
  }
  return { removedFiles, removedDirs };
}

// ─── Atomic JSON persist for cache updates ───
//
// All cmdReport cache writers (citation classification, LLM actions, authority,
// crawlability, outreach) follow the same write-tmp + rename pattern. Centralised
// here so the random suffix is unique across pid+ms+random (avoids collisions on
// double-press) and the helper is one line to call.
async function persistSnapshot(latest) {
  const summaryPath = join('aeo-responses', latest.date, '_summary.json');
  await atomicWriteJson(summaryPath, latest);
}

/**
 * Read + parse .aeo-tracker.json with client-grade failures (AP-FAIL-BRANCHES):
 * missing file and hand-edit JSON syntax errors each get ONE plain next step
 * instead of a bare ENOENT / SyntaxError through the top-level panel.
 */
async function readConfigOrExit() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-platform init${c.reset}`);
    } else {
      console.error(`${c.red}${CONFIG_FILE} has a JSON syntax error (usually a missing/extra comma after hand-editing).${c.reset}`);
      console.error(`${c.red}Fix the file in an editor — or regenerate it: aeo-platform init${c.reset}`);
    }
    process.exit(1);
  }
}

// ─── LLM-based action recommendations ───

async function deriveActionsWithLLM(latest, prev, category, { providerName, providerCall, apiKey, model }) {
  const PLABELS = { openai: 'ChatGPT', gemini: 'Gemini', anthropic: 'Claude', perplexity: 'Perplexity' };
  const providers = [...new Set(latest.results.map(r => r.provider))];

  const engineLines = providers.map(p => {
    const rs = latest.results.filter(r => r.provider === p && r.mention !== 'error');
    const hits = rs.filter(r => r.mention === 'yes' || r.mention === 'src').length;
    const perQuery = rs.map(r => `    Q: "${r.queryText || r.query}" → ${r.mention}`).join('\n');
    return `  ${PLABELS[p] || p}: ${hits}/${rs.length} mentions\n${perQuery}`;
  }).join('\n');

  const compLines = (latest.topCompetitors || []).slice(0, 8)
    .map(c => `  - ${c.name} (${c.count} checks)`).join('\n') || '  (none detected)';

  // Strip the user's own domain (and subdomains) BEFORE the prompt is built —
  // without this filter, deriveActionsWithLLM's «recommend pitching this source
  // specifically» rule produces self-pitch actions when the brand's own pages
  // are its most-cited sources (May-2026 typelessform.com dogfood run).
  const ownDom = latest.domain || '';
  const externalSources = (latest.topCanonicalSources || []).filter(s => {
    if (!s || typeof s.url !== 'string') return false;
    let host;
    try { host = new URL(s.url).hostname; }
    catch { return true; } // keep malformed entries; downstream guards handle them
    return !isOwnDomain(host, ownDom);
  });
  const srcLines = externalSources.slice(0, 8)
    .map(s => `  ${s.count}× ${s.url}`).join('\n') || '  (none)';

  const prevNote = prev
    ? `Previous score: ${prev.score}% (${latest.score >= prev.score ? '+' : ''}${latest.score - prev.score}pp change)`
    : 'First run — no historical comparison available.';

  const prompt = `You are a senior AEO (Answer Engine Optimization) consultant. Analyse this visibility data and write 3–5 concrete, specific, actionable recommendations.

BRAND: ${latest.brand}
DOMAIN: ${latest.domain}
CATEGORY: ${category}
CURRENT SCORE: ${latest.score}% (${latest.mentions}/${latest.total} checks returned a mention)
${prevNote}

RESULTS BY ENGINE:
${engineLines}

COMPETITORS FOUND IN AI ANSWERS:
${compLines}

TOP SOURCES AI KEEPS CITING FOR THIS VERTICAL:
${srcLines}

Rules:
- Be specific. Name the exact query, source, or competitor — not generic advice.
- Each action must be completable this week by one person.
- Prioritise gaps (brand invisible) over polish.
- If a canonical source appears ≥2×, recommend pitching it specifically.
- If a competitor dominates, explain exactly where and how to displace them.

Return STRICT JSON only:
{
  "actions": [
    {
      "kind": "gap|compete|defend|win",
      "priority": "high|med|low",
      "engines": ["openai"],
      "title": "Max 8 words",
      "detail": "1–2 sentences, specific and actionable."
    }
  ]
}

engines = array of provider names (openai/gemini/anthropic/perplexity), empty if cross-engine.`;

  const { text, raw } = await providerCall(prompt, apiKey, model, { webSearch: false });

  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('Could not parse actions response');
  }
  if (!Array.isArray(parsed?.actions) || parsed.actions.length === 0) {
    throw new Error('LLM returned empty actions array');
  }

  const usage = extractUsage(providerName, raw);
  const costDetail = calcCost(model, usage) || { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0 };
  return {
    actions: parsed.actions,
    costInfo: {
      provider: providerName, model, label: 'action-recommendations',
      requests: 1,
      inputTokens: costDetail.inputTokens,
      outputTokens: costDetail.outputTokens,
      costUsd: costDetail.costUsd,
    },
  };
}

// ─── Provider helpers ───

const PROVIDER_MODULES = {
  openai:    '../lib/providers/openai.js',
  anthropic: '../lib/providers/anthropic.js',
  gemini:    '../lib/providers/gemini.js',
};
const PROVIDER_CALL_FN = { openai: 'callOpenAI', anthropic: 'callAnthropic', gemini: 'callGemini' };

// ─── Replay mode ───
// Serves cached raw provider responses from aeo-responses/DATE/*.json instead
// of hitting the live APIs. Two legitimate use-cases:
//   1. Iterating on report/parser/UI locally without burning API credits.
//   2. Re-generating a summary with new extractor logic from historical data.
// Stale-data caveat: the raw engine responses reflect the capture date, not
// today — citations and competitor sets may have drifted. Activated by:
//   aeo-platform run --replay                    # replay the most recent snapshot
//   aeo-platform run --replay-from=2026-04-22    # replay a specific date

function _extractFromRaw(providerName, raw) {
  if (providerName === 'anthropic') {
    const text = (raw.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const citations = (raw.content || [])
      .filter(b => b.type === 'web_search_tool_result')
      .flatMap(b => (b.content || []).map(c => c.url).filter(Boolean));
    return { text, citations };
  }
  if (providerName === 'openai') {
    const text = raw.choices?.[0]?.message?.content || '';
    const citations = (raw.choices?.[0]?.message?.annotations || [])
      .filter(a => a.url_citation).map(a => a.url_citation.url);
    return { text, citations };
  }
  if (providerName === 'gemini') {
    const text = (raw.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
    const citations = (raw.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map(ch => {
        const web = ch.web; if (!web?.uri) return null;
        const isRedirect = /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(web.uri);
        if (isRedirect) {
          const t = web.title;
          if (t && /^[\w-]+(?:\.[\w-]+)+(?:\/|$)/.test(t)) return t.startsWith('http') ? t : `https://${t}`;
          return null;
        }
        return web.uri;
      })
      .filter(Boolean);
    return { text, citations };
  }
  if (providerName === 'perplexity') {
    const text = raw.choices?.[0]?.message?.content || '';
    const citations = raw.citations || raw.choices?.[0]?.message?.citations || [];
    return { text, citations };
  }
  return { text: '', citations: [] };
}

async function _tryReplay(qi, provider, srcDate) {
  const safeModel = sanitizeForFilename(provider.model);
  const replayPath = join('aeo-responses', srcDate, `q${qi}-${provider.name}-${safeModel}.json`);
  if (!existsSync(replayPath)) return null;
  // Malformed cache → treat as miss; caller falls back to live call (or fails
  // through replaySrcDate gate). Prevents an uncaught SyntaxError from crashing
  // the run when a fixture file is half-written / hand-edited.
  let raw;
  try {
    raw = JSON.parse(await readFile(replayPath, 'utf-8'));
  } catch {
    return null;
  }
  const { text, citations } = _extractFromRaw(provider.name, raw);
  return { text, citations, raw };
}

/**
 * Look across `aeo-responses/<date>/_summary.json` for the most recent
 * `lastFullRun` field and return its age in days. Returns null if no prior
 * full run is recorded — caller treats null as "always prompt".
 *
 * Used by `aeo-platform run --depth=auto` to decide when training-data
 * baseline is due for a refresh.
 */
async function _readLastFullRunStaleness() {
  const responsesDir = 'aeo-responses';
  if (!existsSync(responsesDir)) return null;
  const { readdirSync } = await import('node:fs');
  const dates = readdirSync(responsesDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const date of dates) {
    const summaryPath = join(responsesDir, date, '_summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(await readFile(summaryPath, 'utf-8'));
      if (summary.lastFullRun) {
        return daysSinceLastFullRun(summary.lastFullRun);
      }
    } catch { /* corrupt — keep scanning */ }
  }
  return null;
}

async function _resolveReplaySource(explicitDate) {
  if (explicitDate) return explicitDate;
  const { readdirSync } = await import('node:fs');
  if (!existsSync('aeo-responses')) return null;
  const dates = readdirSync('aeo-responses')
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates[dates.length - 1] || null;
}

/**
 * Build a resolved provider descriptor ready for research/brainstorm calls.
 * @param {string} name              Provider key — 'openai' | 'anthropic' | 'gemini'
 * @param {string} envVarName        The env var name holding the API key
 */
async function makeResearchProvider(name, envVarName, providerConfig = DEFAULT_CONFIG.providers) {
  const callFn = (await import(PROVIDER_MODULES[name]))[PROVIDER_CALL_FN[name]];
  const cfg = providerConfig?.[name] || DEFAULT_CONFIG.providers[name] || {};
  const main = cfg.model || DEFAULT_CONFIG.providers[name]?.model;
  const classify = cfg.classifyModel || cfg.model || DEFAULT_CONFIG.providers[name]?.classifyModel
    || DEFAULT_CONFIG.providers[name]?.model;
  // MAIN_OPTIONS_BY_PROVIDER injects thinking/reasoning_effort ONLY into mainCall.
  // classifyCall stays pure (no overhead for extraction/sentiment hot path).
  // See lib/providers/main-options.js for rationale.
  const mainOptions = MAIN_OPTIONS_BY_PROVIDER[name] || {};
  return {
    name,
    providerCall: callFn,                                          // legacy alias — still works (= classifyCall)
    classifyCall: callFn,                                          // explicit: no mainOptions injection
    mainCall: (q, k, m, opts = {}) => callFn(q, k, m, { ...mainOptions, ...opts }),
    apiKey: process.env[envVarName],
    model: main,                // generation tier — used for brainstorm/research
    classifyModel: classify,    // classification tier — used by runValidationFlow
    mainOptions,                // exposed for tests / debug
    label: PROVIDER_LABELS[name],
  };
}

/**
 * List all available research providers in PROVIDER_PRIORITY order. The retry
 * loop in init walks this array on billing/auth/rate-limit errors — first
 * provider that returns a successful research result wins; if all fail, the
 * actionable error panel enumerates what was tried.
 * @param {Object} providerKeyMap   { providerName: envVarName } — any subset
 * @param {Object} [providerConfig] cfg.providers from .aeo-tracker.json (or
 *                                  DEFAULT_CONFIG.providers as fallback when
 *                                  invoked before init has written a config)
 * @returns {Promise<Array>} zero or more provider descriptors in priority order
 */
async function listResearchProviders(providerKeyMap, providerConfig = DEFAULT_CONFIG.providers) {
  const hasKey = (name) => providerKeyMap[name] && process.env[providerKeyMap[name]];
  const available = PROVIDER_PRIORITY.filter(hasKey);
  return Promise.all(available.map(name => makeResearchProvider(name, providerKeyMap[name], providerConfig)));
}

/**
 * Build { primary, validator } for the research pipeline. Backwards-compatible
 * wrapper over listResearchProviders — picks first as primary, second as
 * cross-model validator. Used by validation paths that don't need retry logic
 * (they're already defensive via runValidationFlow).
 * @param {Object} providerKeyMap   { providerName: envVarName } — any subset of providers
 * @param {Object} [providerConfig] cfg.providers from .aeo-tracker.json
 * Returns { primary: null } if no key is available in the environment.
 */
async function buildResearchProviders(providerKeyMap, providerConfig = DEFAULT_CONFIG.providers) {
  const providers = await listResearchProviders(providerKeyMap, providerConfig);
  return {
    primary: providers[0] || null,
    validator: providers[1] || null,
  };
}

/**
 * Resolve the two-model competitor-extraction providers (OpenAI + Gemini at
 * their classify tier), in RESEARCH_CAPABLE preference order. Two available →
 * parallel cross-check; one → single-model extraction (callers mark results
 * unverified — single-key mode, 1.1.8); zero → throw with one next step.
 */
async function buildExtractionProviders(providerConfig) {
  const mkProvider = async (name) => {
    const cfg = providerConfig?.[name] || DEFAULT_CONFIG.providers[name];
    const envVar = cfg?.env || `${name.toUpperCase()}_API_KEY`;
    const apiKey = process.env[envVar];
    if (!apiKey) return null;
    const callFn = (await import(PROVIDER_MODULES[name]))[PROVIDER_CALL_FN[name]];
    // Extraction is a structured-classification task — use the cheap classify
    // tier from the user's config (or DEFAULT_CONFIG fallback).
    const classifyModel = cfg?.classifyModel
      || DEFAULT_CONFIG.providers[name]?.classifyModel
      || cfg?.model
      || DEFAULT_CONFIG.providers[name]?.model;
    return {
      name,
      providerCall: callFn,
      apiKey,
      model: classifyModel,
      label: PROVIDER_LABELS[name],
    };
  };
  // Single-key mode (1.1.8, founder decision): build whatever research-capable
  // providers exist, in preference order. Two → parallel cross-check as before;
  // one → single-model extraction (callers mark results unverified); zero →
  // the only remaining hard failure, with one next step.
  const built = (await Promise.all(RESEARCH_CAPABLE.map(mkProvider))).filter(Boolean);
  if (built.length === 0) {
    throw new Error('Competitor extraction needs at least ONE research-capable API key (OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY). Set one and re-run — see README for setup.');
  }
  return { primary: built[0], secondary: built[1] || null };
}

/**
 * Shared two-stage validation flow used by init, init --queries-only, and run.
 * Handles console I/O, cost display, interactive y/N fallback, and abort logic.
 * Returns the validation object (includes updatedCache to persist in config).
 */
async function runValidationFlow({
  queries, brand, domain, category, geography = [],
  primary, secondary = null, validationCache = [],
  nonInteractive = false, force = false, strictValidation = false,
  onAbort,
  // 0.2.4 recovery hook: when true, caller wants to inspect blockers and
  // attempt auto-recovery via validator-recovery.js before any abort. The
  // flow still prints the validation lines and cost; it just skips the final
  // interactive prompt / exit call. Default false preserves backward
  // compatibility for every existing call site.
  returnBlockersInsteadOfAbort = false,
  // Prompt callback for the "Save/run anyway? [y/N]" question. Passed in by
  // the caller — same shared prompter the whole command uses, so we don't
  // create a competing readline on the same stdin.
  ask,
}) {
  const willCallLLM = primary && (validationCache || []).length === 0
    ? queries.length > 0
    : queries.some(q => !(validationCache || []).find(c => c.query === q));

  // Use the classify-tier model (Haiku / 4o-mini equivalent) — structured
  // classification task, not generation. ~10× cheaper than the flagship
  // model at equivalent accuracy for binary/structured judgements.
  // primary.classifyModel is set by makeResearchProvider from cfg.classifyModel.
  const classifyPrimary = primary
    ? { ...primary, model: primary.classifyModel || primary.model }
    : null;
  const classifySecondary = (strictValidation && secondary)
    ? { ...secondary, model: secondary.classifyModel || secondary.model }
    : null;

  if (willCallLLM && classifyPrimary) {
    const who = classifySecondary
      ? `${classifyPrimary.label} + ${classifySecondary.label} (strict cross-check)`
      : classifyPrimary.label;
    process.stdout.write(`${c.dim}  Validating queries via ${who}... ${c.reset}`);
  }

  const v = await runTwoStageValidation({
    queries, brand, domain, category, geography,
    primary: classifyPrimary, secondary: classifySecondary, validationCache,
  });

  if (willCallLLM) {
    const cost = v.costInfo?.costUsd ? `$${v.costInfo.costUsd.toFixed(4)}` : '';
    console.log(`${c.dim}${cost ? `(${cost})` : ''}${c.reset}`);
  } else if (v.cacheHits > 0) {
    console.log(`${c.dim}  ${SYM.ok} validation cache hit for all ${v.cacheHits} query/queries (no LLM cost)${c.reset}`);
  }

  const lines = formatValidationResult(v);
  for (const line of lines) console.log(`  ${c.yellow}${line}${c.reset}`);

  if (!hasBlockers(v)) {
    if (lines.length === 0) console.log(`${c.green}  ${SYM.ok} All queries pass validation${c.reset}`);
    return v;
  }

  if (force) {
    console.log(`${c.yellow}  --force set — proceeding despite blockers.${c.reset}`);
    return v;
  }
  if (returnBlockersInsteadOfAbort) {
    // Caller will decide: auto-recover, prompt, or fall back to panel.
    return v;
  }
  if (nonInteractive) {
    console.error(`${c.red}${SYM.err} Aborted — queries failed validation. Fix queries or pass --force.${c.reset}`);
    if (onAbort) onAbort(); else process.exit(1);
    return v;
  }

  const ans = ask
    ? (await ask(`${c.yellow}Save/run anyway? [y/N] ${c.reset}`, 'n')).trim()
    : 'n';
  if (!/^y/i.test(ans)) {
    console.log(`${c.yellow}Aborted. Tip: aeo-platform init --queries-only to regenerate.${c.reset}`);
    if (onAbort) onAbort(); else process.exit(0);
  }
  return v;
}

/**
 * Wraps runValidationFlow with auto-recovery for informationalIssues blockers.
 * Goal (per no-silent-fatal-aborts rule): if the validator blocks queries and
 * we already have validated alternatives in the candidatePool, try to swap
 * blocked → alternative with intent-diversity ranking, and re-validate (free
 * cache hit). Falls back to actionable panel when recovery is not possible.
 *
 * Behavior matrix:
 *   no blockers                     → pass-through
 *   any static/llm blocker          → actionable panel + exit (substitution unsafe)
 *   1 informational-blocker + pool  → --yes: auto-promote + warning; TTY: prompt
 *   2+ informational-blockers  +yes → panel (safer default per senior review)
 *   2+ informational-blockers  +TTY → prompt for each
 *   pool exhausted / 0 substitutes  → actionable panel + exit
 *
 * Returns the final validation object (with substituted queries reflected in
 * v.updatedCache) and the possibly-modified queries array. Never calls
 * process.exit on the happy-path; caller handles error exit when
 * recoveryFailed is true.
 */
async function runValidationWithRecovery({
  queries, queryIntents = [], candidatePool = [],
  brand, domain, category, geography = [],
  primary, secondary = null, validationCache = [],
  nonInteractive = false, force = false, strictValidation = false,
  ask, useColor = true,
  commercialPassingCount = null,  // 1.0.6: threaded from cmdInit substitution block
}) {
  const v = await runValidationFlow({
    queries, brand, domain, category, geography,
    primary, secondary, validationCache,
    nonInteractive, force, strictValidation,
    returnBlockersInsteadOfAbort: true,
    ask,
  });

  const info = v.informationalIssues || [];
  const hasStatic = (v.staticIssues || []).length > 0;
  const hasLlm = (v.llmIssues || []).length > 0;
  const hasInfo = info.length > 0;

  if (force || (!hasStatic && !hasLlm && !hasInfo)) {
    return { v, queries, recoveryFailed: false };
  }

  const {
    tryAutoRecover, formatRecoveryPanel, formatAutoPromoteWarning,
    promptBlockedQueryReplacement, isVerifiedSubstitute, dedupeBlockersByQuery,
  } = await import('../lib/init/validator-recovery.js');

  const printPanel = (allBlockers) => {
    // 1.0.4 Fix A: candidatePool entries arrive already enriched with
    // search_behavior. 1.0.6: also pass commercialPassingCount for the
    // honest "X of 5 commercial candidates" header — when present (from
    // cmdInit substitution block), recovery panel uses it; when undefined
    // (legacy callers / --keywords mode), recovery panel falls back to
    // the existing wording.
    const lines = formatRecoveryPanel({
      allBlockers, candidatePool, currentQueries: queries,
      brand, domain, category, useColor,
      commercialPassingCount,
    });
    for (const ln of lines) console.log(ln);
  };

  // Static blockers (acronym ambiguity) stay terminal — a substitution cannot
  // prove it avoids the same ambiguity class.
  if (hasStatic) {
    printPanel([...(v.staticIssues || []), ...(v.llmIssues || []), ...info]);
    return { v, queries, recoveryFailed: true };
  }

  // 1.1.8: llm blockers (valid:false verdicts) are recoverable too — but only
  // with VERIFIED substitutes (pool entry's own verdict: valid:true AND
  // retrieval-triggered). The old blanket "llm → panel" rule threw away
  // validated alternatives while aborting the whole init. Informational-only
  // blocker sets keep the legacy pool (entries carry search_behavior but may
  // predate the `valid` field).
  const blockers = dedupeBlockersByQuery([...(v.llmIssues || []), ...info]);
  const effectivePool = hasLlm ? candidatePool.filter(isVerifiedSubstitute) : candidatePool;

  const queriesWithIntent = queries.map((t, i) => ({ text: t, intent: queryIntents[i] || '' }));
  const recover = tryAutoRecover({
    blockers, queries: queriesWithIntent, candidatePool: effectivePool,
  });

  if (recover.unresolvedBlockers.length > 0) {
    printPanel(blockers);
    return { v, queries, recoveryFailed: true };
  }

  // --yes + single blocker → auto-promote silently. --yes + multi → panel.
  if (nonInteractive) {
    if (blockers.length > 1) {
      printPanel(blockers);
      return { v, queries, recoveryFailed: true };
    }
    for (const sub of recover.substitutions) {
      for (const ln of formatAutoPromoteWarning(sub, useColor)) console.log(ln);
    }
  } else {
    // TTY: prompt for each blocker. User may override the auto-recovered pick.
    const newQueries = [...queries];
    const usedTexts = new Set(newQueries);
    for (const blocker of blockers) {
      const available = effectivePool.filter(c => !usedTexts.has(c.text));
      const choice = await promptBlockedQueryReplacement({
        blocker, available, ask, useColor,
      });
      if (choice.action === 'abort') {
        printPanel(blockers);
        return { v, queries, recoveryFailed: true };
      }
      if (choice.action === 'manual') {
        const typed = (await ask('  Type your replacement: ')).trim();
        if (!typed) {
          printPanel(blockers);
          return { v, queries, recoveryFailed: true };
        }
        const idx = newQueries.indexOf(blocker.query);
        if (idx >= 0) newQueries[idx] = typed;
        usedTexts.add(typed);
      } else {
        const idx = newQueries.indexOf(blocker.query);
        if (idx >= 0) newQueries[idx] = choice.text;
        usedTexts.add(choice.text);
      }
    }
    recover.newQueries = newQueries;
  }

  // Re-validate substituted queries. Free: all substitutes came from the
  // pool which is already in validationCache → cache hit on every query.
  const v2 = await runValidationFlow({
    queries: recover.newQueries, brand, domain, category, geography,
    primary, secondary, validationCache: v.updatedCache || validationCache,
    nonInteractive, force: true /* substitutes are pre-validated */,
    strictValidation, returnBlockersInsteadOfAbort: true,
    ask,
  });

  return { v: v2, queries: recover.newQueries, recoveryFailed: false };
}

/**
 * Wraps a research() logPhase callback so that long-running phases (brainstorm,
 * validate, simulate) show a live TTY spinner between 'started' and
 * 'done'/'failed'/'skipped'. Non-TTY output stays identical to the pre-spinner
 * flat log — no \r tricks, no animated frames — which keeps CI logs grep-able.
 *
 * Caller owns the final-line format (same parts builder as before, preserved
 * byte-for-byte). Spinner only occupies the "live" render between events.
 *
 * @param {ReturnType<typeof createSpinner>} spinner
 * @returns {(evt: {phase:string,status:string,details?:object}) => void}
 */
function makePipelineReporter(spinner) {
  const isTTY = !!process.stdout.isTTY;
  return ({ phase, status, details }) => {
    const parts = [`${c.dim}  [${phase}]`, status];
    if (details?.count !== undefined) parts.push(`(${details.count})`);
    if (details?.kept !== undefined) parts.push(`kept=${details.kept} rejected=${details.rejected}`);
    if (details?.topScore !== undefined) parts.push(`topScore=${details.topScore}`);
    if (details?.validator) parts.push(`via ${details.validator}`);
    if (details?.passed !== undefined) parts.push(`passed=${details.passed} rejected=${details.rejected ?? details.failed}`);
    if (details?.reason) parts.push(`— ${details.reason}`);
    const line = parts.join(' ') + c.reset;

    if (status === 'started') {
      spinner.start(`[${phase}] running...`);
      if (!isTTY) console.log(line);
    } else if (status === 'attempt') {
      const pos = details?.attempt && details?.total
        ? ` attempt ${details.attempt}/${details.total}`
        : ' attempt';
      spinner.update(`[${phase}]${pos}`);
      if (!isTTY) console.log(line);
    } else {
      // done | failed | skipped — caller-owned final line
      spinner.stop(line);
    }
  };
}

// ─── Commands ───

async function cmdInit(opts = {}) {
  const nonInteractive = opts.yes === true;

  // The shared prompter owns process.stdin / readline lifecycle for the whole
  // command. The top-level dispatcher creates it once and threads it into
  // every command — a second createPrompter() in here would mean two readline
  // interfaces racing on the same stdin (the exact regression that 1.0.2 fixed).
  // Direct callers (tests, programmatic embedding) must inject their own
  // prompter — see test/prompt-lifecycle.test.js for the contract.
  if (!opts.prompter) {
    throw new Error('cmdInit: opts.prompter is required (the dispatcher in bin/aeo-tracker.js wires this; tests must pass createPrompter({...}))');
  }
  const ask = opts.prompter.ask;

  console.log(`\n${c.bold}aeo-platform — init${opts.queriesOnly ? ' --queries-only' : ''}${c.reset}\n`);

  // ── --queries-only: re-suggest queries without touching the rest of config ──
  if (opts.queriesOnly) {
    if (!existsSync(CONFIG_FILE)) {
      console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-platform init${c.reset}`);
      process.exit(1);
    }
    const existing = await readConfigOrExit();
    const { brand, domain: existingDomain, providers: existingProviders } = existing;
    if (!brand || !existingDomain) {
      console.error(`${c.red}Config is missing brand or domain — run aeo-platform init first${c.reset}`);
      process.exit(1);
    }

    console.log(`${c.dim}  Brand: ${brand} | Domain: ${existingDomain}${c.reset}`);
    console.log(`${c.dim}  Existing queries:${c.reset}`);
    (existing.queries || []).forEach((q, i) => console.log(`    Q${i + 1}: ${q}`));

    // Build provider key map from existing config + standard env var names
    const standard = detectStandardKeys();
    const existingKeyMap = {};
    for (const p of PROVIDER_PRIORITY) {
      const envName = existingProviders?.[p]?.env || standard[p];
      if (envName) existingKeyMap[p] = envName;
    }
    const { primary, validator } = await buildResearchProviders(existingKeyMap);
    if (!primary) {
      console.error(`${c.red}No API key found. Ensure at least one provider key is in the environment.${c.reset}`);
      process.exit(1);
    }

    const { normalizeUrl, fetchSite, parseSiteContent, detectAudience } = await import('../lib/init/fetch-site.js');
    const fullUrl = normalizeUrl(existingDomain);

    console.log(`\n${c.dim}  Fetching ${fullUrl}...${c.reset}`);
    let site;
    try {
      const { html } = await fetchSite(fullUrl);
      site = parseSiteContent(html);
    } catch (err) {
      console.error(`${c.red}Failed to fetch site: ${errMsg(err)}${c.reset}`);
      process.exit(1);
    }

    const categoryDescription = existing.category || '';
    const audienceTags = detectAudience(site);
    const geoTags = detectGeography(existingDomain, site);

    const { research } = await import('../lib/init/research/research.js');
    const { selectTopThree, formatSelection } = await import('../lib/init/research/select.js');
    console.log(`${c.dim}  [brainstorm → filter → score → validate]${c.reset}\n`);

    let newQueries = [];
    let newCandidatePool = [];
    const queriesOnlySpinner = createSpinner();
    try {
      const researchResult = await research({
        brand, domain: existingDomain, site, category: categoryDescription,
        audienceTags, geoTags, primary, validator,
        logPhase: makePipelineReporter(queriesOnlySpinner),
      });
      const selectResult = selectTopThree(researchResult.candidates, { validationSkipped: !validator });
      console.log(`\n${c.dim}  pipeline cost ~$${researchResult.trace.estimatedCostUsd.toFixed(4)}${c.reset}\n`);

      // 1.0.6 — commercial-only over-generate + silent substitution
      // (symmetric with main cmdInit; uses existing.validationCache for hits).
      const primaryQOnly = primary;
      const allFiveQOnly = [
        ...selectResult.selected.map(s => s.candidate),
        ...selectResult.alternatives,
      ];
      let commercialPassingCountQOnly = null;
      if (allFiveQOnly.length >= 3 && primaryQOnly?.providerCall) {
        try {
          const { runTwoStageValidation, SEARCH_BEHAVIORS } =
            await import('../lib/init/research/run-validation.js');
          const validationQOnly = await runTwoStageValidation({
            queries: allFiveQOnly.map(c => c.text),
            brand, domain: existingDomain, category: categoryDescription,
            geography: geoTags || [],
            primary: primaryQOnly,
            secondary: null,
            validationCache: existing.validationCache || [],
            commercialOnly: false,
          });
          const verdictsQOnly = validationQOnly.updatedCache || [];
          if (verdictsQOnly.length === 0) {
            throw new Error('Validation returned no verdicts');
          }
          for (const c of allFiveQOnly) {
            const verdict = verdictsQOnly.find(v => v.query === c.text);
            if (verdict) {
              c.search_behavior = verdict.search_behavior;
              c.confidence = verdict.confidence;
            }
          }
          // 1.0.8: same rules as main validation (run-validation.js:186 + :194).
          // valid === true AND retrieval-triggered. Legacy cache without `valid`
          // field fails closed. See main path for full rationale.
          const PASS = (c) => {
            const verdict = verdictsQOnly.find(v => v.query === c.text);
            if (!verdict) return true;  // graceful: no verdict → pass through
            return verdict.valid === true
                && verdict.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL;
          };
          const passing = allFiveQOnly.filter(PASS);
          commercialPassingCountQOnly = passing.length;
          if (commercialPassingCountQOnly >= 3) {
            passing.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            selectResult.selected = passing.slice(0, 3).map(c => ({
              intent: c.intent || 'commercial',
              candidate: c,
              fallbackUsed: null,
            }));
            selectResult.alternatives = passing.slice(3).map(c => ({ ...c }));
          }
        } catch (err) {
          console.error(`${c.yellow}  Validation skipped: ${errMsg(err)}${c.reset}`);
        }
      }
      selectResult.commercialPassingCount = commercialPassingCountQOnly;

      for (const line of formatSelection(selectResult)) console.log(line);

      const accept = (nonInteractive ? 'y' : (await ask(`\nReplace queries? [Y]es / [e]dit / [n]o: `, 'y'))).trim();
      if (/^e/i.test(accept)) {
        for (let i = 0; i < selectResult.selected.length; i++) {
          const cand = selectResult.selected[i].candidate;
          const v = (await ask(`  Q${i + 1} [${cand.text}]: `, cand.text)).trim();
          newQueries.push(v || cand.text);
        }
      } else if (!/^n/i.test(accept)) {
        newQueries = selectResult.selected.map(s => s.candidate.text);
      }
      if (selectResult.alternatives.length > 0) {
        newCandidatePool = selectResult.alternatives.slice(0, 5).map(a => ({
          text: a.text,
          intent: a.intent,
          score: a.score,
          unverified: !!a.unverified,
          ...(a.search_behavior ? {
            search_behavior: a.search_behavior,
            confidence: a.confidence,
          } : {}),
          ...(a.topUp ? { topUp: true } : {}),
        }));
      }
    } catch (err) {
      console.error(`${c.red}Research failed: ${errMsg(err)}${c.reset}`);
      process.exit(1);
    }

    if (newQueries.length !== 3) {
      console.log(`${c.yellow}Aborted — no queries saved.${c.reset}`);
      return;
    }

    // Two-stage validation (same contract as full init path).
    const validationQ = await runValidationFlow({
      queries: newQueries,
      brand, domain: existingDomain,
      category: categoryDescription,
      geography: geoTags || [],
      primary, secondary: validator,
      validationCache: existing.validationCache || [],
      nonInteractive,
      force: opts.force,
      strictValidation: opts.strictValidation,
      onAbort: () => { process.exit(nonInteractive ? 1 : 0); },
      ask,
    });

    // v0.7 — basket versioning. Decide additive vs replace mode.
    //   --add-queries     → preserve old queries, append new (skipping dupes)
    //   --replace-queries → forget old queries entirely (forks history)
    //   neither flag      → ask interactively, default to ADDITIVE (preserves trends)
    const { readBasket, recordExpansion, recordReplacement, mergeQueries, initialBasket } =
      await import('../lib/init/basket-history.js');

    let mode = 'replace'; // default before flag/prompt logic
    if (opts.addQueries && opts.replaceQueries) {
      console.error(`${c.red}--add-queries and --replace-queries are mutually exclusive${c.reset}`);
      process.exit(1);
    } else if (opts.addQueries) {
      mode = 'add';
    } else if (opts.replaceQueries) {
      mode = 'replace';
    } else if (!nonInteractive && (existing.queries || []).length > 0) {
      const ans = (await ask(
        `\n${c.yellow}Existing basket detected (${(existing.queries || []).length} queries).${c.reset}\n  [a]dd new alongside existing (preserve trends)\n  [r]eplace all (fork history)\n  [c]ancel\nChoice [a/r/c, default=a]: `,
        'a'
      )).trim().toLowerCase();
      if (/^c/.test(ans)) {
        console.log('Aborted.');
        return;
      }
      mode = /^r/.test(ans) ? 'replace' : 'add';
    }

    const today = new Date().toISOString().slice(0, 10);
    let finalQueries;
    let basketUpdate;
    if (mode === 'add') {
      finalQueries = mergeQueries(existing.queries || [], newQueries);
      // First time touching basket logic on a legacy config — synthesise v1
      // entry from existing queries before recording the v2 expansion.
      const hadHistory = Array.isArray(existing.basketHistory) && existing.basketHistory.length > 0;
      const baseConfig = hadHistory
        ? existing
        : { ...existing, ...initialBasket(existing.queries || [], today) };
      basketUpdate = recordExpansion(baseConfig, finalQueries, today);
    } else {
      finalQueries = newQueries;
      basketUpdate = recordReplacement(existing, finalQueries, today);
    }

    const updated = { ...existing, queries: finalQueries, ...basketUpdate };
    if (newCandidatePool.length > 0) updated.candidatePool = newCandidatePool;
    if (validationQ?.updatedCache?.length > 0) {
      updated.validationCache = validationQ.updatedCache;
    }
    const tmpPath = CONFIG_FILE + '.tmp';
    await writeFile(tmpPath, JSON.stringify(updated, null, 2));
    await rename(tmpPath, CONFIG_FILE);

    console.log(`\n${c.green}${SYM.ok} Queries updated in ${CONFIG_FILE}${c.reset}`);
    if (mode === 'add') {
      console.log(`  ${c.dim}Mode: additive — original Q1-Q${(existing.queries || []).length} preserved, new queries appended${c.reset}`);
    } else {
      console.log(`  ${c.yellow}Mode: replace — basket forked at v${basketUpdate.basketVersion} (prior versions kept in basketHistory)${c.reset}`);
    }
    finalQueries.forEach((q, i) => console.log(`  Q${i + 1}: ${q}`));
    console.log(`\nNext: ${c.cyan}aeo-platform run${c.reset}\n`);
    return;
  }

  // P0.1 preconditions for non-interactive mode
  if (nonInteractive) {
    if (!opts.brand || !opts.domain) {
      console.error(`${c.red}--yes requires --brand and --domain${c.reset}`);
      process.exit(1);
    }
    if (!opts.auto && !opts.manual && !opts.keywords) {
      console.error(`${c.red}--yes requires --auto, --manual, or --keywords="q1,q2,q3"${c.reset}`);
      console.error(`${c.dim}  --auto       Let the LLM pipeline brainstorm and validate queries${c.reset}`);
      console.error(`${c.dim}  --manual     Type queries interactively (skipped in --yes; provide --keywords instead)${c.reset}`);
      console.error(`${c.dim}  --keywords   Supply your own 3 queries, skip brainstorm (zero LLM cost)${c.reset}`);
      process.exit(1);
    }
    if (process.env.AEO_TRACKER_DRY_RUN === '1') {
      console.log('precondition-ok');
      process.exit(0);
    }
  }

  // A7: existing config
  if (existsSync(CONFIG_FILE)) {
    if (nonInteractive) {
      console.log(`${c.yellow}${CONFIG_FILE} exists — overwriting (--yes mode)${c.reset}`);
    } else {
      const ans = (await ask(`${c.yellow}${CONFIG_FILE} already exists. Overwrite? [y/N] ${c.reset}`, 'n')).trim();
      if (!/^y/i.test(ans)) { console.log('Aborted.'); return; }
    }
  }

  // Step 1 — brand + domain
  const brand = (opts.brand || (await ask(`Brand name (e.g. webappski): `, ''))).trim();
  if (!brand) { console.error(`${c.red}Brand is required${c.reset}`); process.exit(1); }

  // P2.2: short brand warning
  if (brand.length <= 3) {
    console.log(`${c.yellow}${SYM.warn} Brand "${brand}" is very short. Mention detection may produce false positives (e.g. "AI" matches every "ai" word in answers).${c.reset}`);
    if (!nonInteractive) {
      const cont = (await ask(`Continue anyway? [y/N] `, 'n')).trim();
      if (!/^y/i.test(cont)) { process.exit(0); }
    }
  }

  const domainRaw = (opts.domain || (await ask(`Domain (e.g. webappski.com, or full URL): `, ''))).trim();
  if (!domainRaw) { console.error(`${c.red}Domain is required${c.reset}`); process.exit(1); }

  const { normalizeUrl, extractDomain, fetchSite, parseSiteContent, detectSiteIssues, inferCategory, detectAudience } = await import('../lib/init/fetch-site.js');
  const fullUrl = normalizeUrl(domainRaw);
  const domain = extractDomain(domainRaw);

  // Step 2 — detect API keys
  const providerKey = {};
  const standard = detectStandardKeys();
  const heuristic = heuristicKeyMatch();

  console.log(`\n${c.bold}Checking environment for API keys...${c.reset}`);

  const standardFound = Object.entries(standard).filter(([, n]) => n);
  if (standardFound.length > 0) {
    for (const [p, n] of standardFound) {
      console.log(`  ${c.green}${SYM.ok}${c.reset} ${PROVIDER_LABELS[p]}: ${n}`);
      providerKey[p] = n;
    }
  } else {
    console.log(`  ${c.dim}Standard names not set${c.reset}`);
  }

  const missingAfterStandard = Object.keys(PROVIDER_LABELS).filter(p => !providerKey[p]);
  const heuristicCandidates = missingAfterStandard
    .map(p => [p, heuristic[p]])
    .filter(([, names]) => names.length > 0);

  if (heuristicCandidates.length > 0) {
    console.log(`\n  ${c.bold}Heuristic match — these look like API keys under non-standard names:${c.reset}`);
    for (const [p, names] of heuristicCandidates) {
      console.log(`    ${c.yellow}?${c.reset} ${PROVIDER_LABELS[p]}: ${names.join(', ')}`);
    }
    const use = (nonInteractive ? 'y' : (await ask(`Use these? [Y/n] `, 'y'))).trim();
    if (!/^n/i.test(use)) {
      for (const [p, names] of heuristicCandidates) {
        if (names.length === 1 || nonInteractive) {
          providerKey[p] = names[0];
        } else {
          console.log(`  Multiple candidates for ${PROVIDER_LABELS[p]}:`);
          names.forEach((n, i) => console.log(`    [${i + 1}] ${n}`));
          const pick = (await ask(`  Pick [1-${names.length}] or Enter to skip: `, '')).trim();
          const idx = Number(pick) - 1;
          if (idx >= 0 && idx < names.length) providerKey[p] = names[idx];
        }
      }
    }
  }

  // Step 3 — interactive per-provider fallback for anything stages 1+2 missed.
  // Runs even when SOME providers were found — so a user with OpenAI under the
  // standard name + Gemini under a non-matching custom name is still prompted for
  // the missing required provider (instead of silently proceeding → hard-failing
  // later at `run` because the two-model extractor can't start).
  const REQUIRED_PROVIDERS = ['openai', 'gemini'];
  const OPTIONAL_PROVIDERS = ['anthropic', 'perplexity'];
  const MAX_ATTEMPTS = 3;

  // Detect when a user pastes an ACTUAL API key instead of an env var NAME.
  // This is the most common confusion — the prompt says "env var name" but
  // someone under time pressure just pastes what's in their clipboard.
  // All major AI providers use recognisable prefixes for their key values.
  const looksLikeActualKey = (s) =>
    /^(sk-[a-z]|AIzaSy|sk-ant-|pplx-|ya29\.|gsk_)/i.test(s);

  const verifyEnvVar = (name) => {
    // Safety: user pasted the KEY VALUE instead of the env var NAME.
    // Never log the value; just nudge them toward the correct input.
    if (looksLikeActualKey(name)) {
      return {
        ok: false,
        reason: `that looks like an API key value, not an env var name. Please type the NAME of the variable that holds your key (e.g. OPENAI_API_KEY or MY_OPENAI_KEY) — your actual key stays in your shell env, aeo-tracker only needs to know which variable to read`,
      };
    }
    // Env var names must be [A-Z_][A-Z0-9_]* (POSIX). Detect invalid chars early.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, reason: `"${name}" isn't a valid env var name — names can only contain letters, digits, and underscores, and cannot start with a digit` };
    }
    const value = process.env[name];
    if (value === undefined) return { ok: false, reason: `$${name} is not set in your shell — check the name (case-sensitive) or set the variable first${process.platform === 'win32' ? ' (PowerShell: setx, then open a new terminal)' : ' via ~/.zshrc'}` };
    if (value.length < 20) return { ok: false, reason: `$${name} is set, but the value is too short (${value.length} chars) — real API keys are 40+ chars, so this looks like a typo` };
    return { ok: true, length: value.length };
  };

  if (!nonInteractive) {
    const missingRequired = REQUIRED_PROVIDERS.filter(p => !providerKey[p]);
    const missingOptional = OPTIONAL_PROVIDERS.filter(p => !providerKey[p]);

    if (missingRequired.length > 0 || missingOptional.length > 0) {
      console.log(`\n${c.yellow}Some API keys weren't auto-detected. Type the env var name (not the key itself) — or Enter to skip optional providers:${c.reset}`);
    }

    // Required: loop until entered OR attempts exhausted.
    for (const p of missingRequired) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !providerKey[p]; attempt++) {
        const tag = attempt === 1 ? '(required)' : `(required, attempt ${attempt}/${MAX_ATTEMPTS})`;
        const name = (await ask(`  ${PROVIDER_LABELS[p]} env var name ${tag}: `, '')).trim();
        if (!name) {
          // Single-key mode (1.1.8): with at least one research-capable key
          // already present, the second one is an upgrade, not a wall.
          if (classifyKeyMode(providerKey).mode !== 'none') {
            console.log(`    ${c.yellow}${SYM.warn} Skipping ${PROVIDER_LABELS[p]} — continuing in single-key mode (no cross-model verification).${c.reset}`);
            break;
          }
          console.log(`    ${c.yellow}${SYM.warn} ${PROVIDER_LABELS[p]} cannot be skipped yet — at least ONE research-capable key (OpenAI, Gemini, or Anthropic) is required.${c.reset}`);
          continue;
        }
        const v = verifyEnvVar(name);
        if (!v.ok) {
          console.log(`    ${c.red}${SYM.err} ${name}: ${v.reason}${c.reset}`);
          continue;
        }
        providerKey[p] = name;
        console.log(`    ${c.green}${SYM.ok} verified (${v.length} chars)${c.reset}`);
      }
    }

    // Optional: one shot per provider, Enter to skip.
    for (const p of missingOptional) {
      const name = (await ask(`  ${PROVIDER_LABELS[p]} env var name (Enter to skip — optional): `, '')).trim();
      if (!name) continue;
      const v = verifyEnvVar(name);
      if (!v.ok) {
        console.log(`    ${c.yellow}${SYM.warn} ${name}: ${v.reason} — skipping ${PROVIDER_LABELS[p]}${c.reset}`);
        continue;
      }
      providerKey[p] = name;
      console.log(`    ${c.green}${SYM.ok} verified (${v.length} chars)${c.reset}`);
    }
  }

  // Single-key mode (1.1.8, founder decision 2026-06-11): the old wall — hard
  // exit unless BOTH OpenAI and Gemini are present — turned away every client
  // with one key before their first taste. Now: zero research-capable keys is
  // the only hard failure; exactly one degrades honestly with a banner.
  const keyMode = classifyKeyMode(providerKey);
  if (keyMode.mode === 'none') {
    console.log(`\n${c.red}No research-capable API key found — aeo-platform needs at least ONE of: OpenAI, Gemini, or Anthropic.${c.reset}`);
    console.log(`Two keys (OpenAI + Gemini) are recommended: they enable cross-model verification of competitor mentions.`);
    console.log(`\nGet a key (2 minutes):`);
    console.log(`  OpenAI: https://platform.openai.com/api-keys`);
    console.log(`  Gemini: https://aistudio.google.com/apikey`);
    console.log(`  Anthropic: https://console.anthropic.com/settings/keys`);
    console.log('');
    for (const line of keySetupLines()) console.log(line);
    console.log('');
    process.exit(1);
  }
  if (keyMode.mode === 'single') {
    const missingPair = REQUIRED_PROVIDERS.filter(p => !providerKey[p]).map(p => PROVIDER_LABELS[p]).join(' or ') || 'OpenAI or Gemini';
    console.log(`\n${c.yellow}${SYM.warn} Single-key mode (${PROVIDER_LABELS[keyMode.present[0]]} only): query validation and competitor extraction run on ONE model.${c.reset}`);
    console.log(`${c.yellow}  Competitor mentions will be marked "unverified" — no second model to cross-check them.${c.reset}`);
    console.log(`${c.yellow}  Add a ${missingPair} key any time to upgrade verification.${c.reset}`);
  }

  console.log(`\n${c.green}Configured providers: ${Object.keys(providerKey).map(p => PROVIDER_LABELS[p]).join(', ')}${c.reset}`);

  // Init no longer chooses models. Models are discovered fresh at each
  // `aeo-tracker run` via lib/providers/discover.js (HTTP fetch of /v1/models
  // per provider + regex sort). Init just seeds `.aeo-tracker.json` with
  // FALLBACK defaults — used only if discovery fails (provider down / network).
  console.log(`\n${c.dim}Models will be discovered dynamically at each \`run\` (HTTP fetch of /v1/models per provider).${c.reset}`);

  /** @type {Object<string,{model:string,classifyModel:string,env:string}>} */
  const selectedProviders = {};
  for (const [p, envName] of Object.entries(providerKey)) {
    const fb = MODEL_FALLBACK[p];
    if (!fb) continue;
    selectedProviders[p] = {
      model: fb.main,
      classifyModel: fb.classify,
      env: envName,
    };
  }

  // Step 4 — manual or auto
  let mode;
  if (nonInteractive) {
    mode = opts.auto ? 'auto' : 'manual';
  } else {
    const modeAns = (await ask(
      `\nHow should I configure queries and competitors?\n  [1] Manual — I'll type them\n  [2] Auto — analyze my site with an LLM and suggest\nChoose [1/2]: `,
      '1'
    )).trim();
    mode = modeAns === '2' ? 'auto' : 'manual';
  }

  let queries = [];
  let categoryDescription = '';
  let suggestionLang = '';
  let config_candidatePool = [];
  // 1.1.8: verdicts from the substitution-block validation, threaded into the
  // main validation as its cache. ONE validation, one source of truth — the
  // old `validationCache: []` re-roll let a non-deterministic classifier flip
  // a borderline verdict between two calls ("validated then re-rejected").
  let config_validationSeedCache = [];
  // Parallel to `queries`, carries the intent bucket per selected query.
  // Used by validator-recovery to enforce intent-diversity when auto-swapping
  // blocked queries. Populated only in the --auto research pipeline path;
  // stays empty in manual / --keywords / single-shot modes — recovery falls
  // back to highest-score ranking when intents are unknown.
  let config_queryIntents = [];
  // 1.0.6: count of commercial candidates passing both validator stages.
  // Set inside the silent-substitution block; threaded into recovery panel
  // so the "X of 5 commercial candidates" header is honest.
  let config_commercialPassingCount = null;

  // P2: BYO keywords (`--keywords="q1,q2,q3"`) — skip brainstorm entirely, $0 LLM cost
  if (opts.keywords) {
    const list = String(opts.keywords).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length !== 3) {
      console.error(`${c.red}--keywords requires exactly 3 comma-separated queries (got ${list.length})${c.reset}`);
      process.exit(1);
    }
    queries = list;
    console.log(`\n${c.green}Using --keywords (BYO mode, $0 LLM cost):${c.reset}`);
    queries.forEach((q, i) => console.log(`  Q${i + 1}: ${q}`));
    mode = 'keywords';
  }

  if (mode === 'auto') {
    const researchProviders = await listResearchProviders(providerKey, selectedProviders);
    if (researchProviders.length === 0) {
      console.log(`${c.yellow}No LLM-capable provider configured (need OpenAI, Anthropic, or Gemini). Falling back to manual.${c.reset}`);
    } else {
      const primaryForDisplay = researchProviders[0];
      // P1.6: privacy reassurance
      console.log(`\n${c.bold}Auto-suggest will:${c.reset}`);
      console.log(`  1. Fetch ${fullUrl} from your machine`);
      console.log(`  2. Extract title, meta, headings, first 2KB of body text`);
      console.log(`  3. Send that excerpt to ${primaryForDisplay.label} (${primaryForDisplay.model}) via YOUR API key`);
      if (researchProviders.length > 1) {
        const fallbacks = researchProviders.slice(1).map(p => p.label).join(', ');
        console.log(`     ${c.dim}(falls back to ${fallbacks} if the primary provider has a billing/auth/rate-limit issue)${c.reset}`);
      }
      console.log(`  4. Show you the suggested queries + competitors before saving`);
      console.log(`  ${c.dim}Your API key never leaves this machine. No telemetry. No analytics. No traffic to webappski.com.${c.reset}`);
      const go = (nonInteractive ? 'y' : (await ask(`Continue? [Y/n] `, 'y'))).trim();
      if (!/^n/i.test(go)) {
        try {
          process.stdout.write(`${c.dim}  Fetching ${fullUrl}...${c.reset} `);
          // 1.1.8 (F4): fetchSite now climbs a resilience ladder (retry →
          // browser-UA → paused retry) instead of dying on the first attempt.
          // Last rung lives here: --auto + --category can proceed WITHOUT the
          // site excerpt; only a truly unanchorable run aborts — with ONE
          // copy-paste next command instead of a wall of options.
          let html = '';
          let degradedNoSite = false;
          {
            let fetchResult = null;
            try {
              fetchResult = await fetchSite(fullUrl);
            } catch (fetchErr) {
              console.log(`${c.yellow}fetch failed: ${errMsg(fetchErr)}${c.reset}`);
              if (nonInteractive && opts.category) {
                degradedNoSite = true;
                console.log(`${c.yellow}  ${SYM.warn} Proceeding WITHOUT site content (brand + domain + --category only). Query precision is reduced — consider re-running init when the site is reachable.${c.reset}`);
              } else if (nonInteractive) {
                console.error(`${c.red}Site unreachable and no --category given — nothing to anchor query generation.${c.reset}`);
                console.error(`${c.red}Rerun with your niche as the anchor:${c.reset}`);
                console.error(`${c.dim}  aeo-platform init --yes --auto --brand=${brand} --domain=${domain} --category="<your niche in one phrase>"${c.reset}`);
                process.exit(1);
              } else {
                throw fetchErr; // TTY → existing manual-input fallback
              }
            }
            if (fetchResult) {
              html = fetchResult.html;
              console.log(`(${html.length.toLocaleString()} bytes, via ${fetchResult.finalUrl})`);
              if (fetchResult.botBlocked) {
                console.log(`${c.yellow}  ${SYM.warn} AEO finding #1: ${fullUrl} rejected our declared bot User-Agent but served a browser UA.${c.reset}`);
                console.log(`${c.yellow}    AI crawlers (GPTBot, ClaudeBot, PerplexityBot) are likely blocked the same way — fix the bot rules first; they gate ALL AI visibility.${c.reset}`);
              }
            }
          }

          const site = parseSiteContent(html);
          const issues = degradedNoSite ? [] : detectSiteIssues(site, html);
          if (issues.includes('BOT_PROTECTED')) console.log(`  ${c.yellow}${SYM.warn} Bot protection detected (Cloudflare). Content may be unreliable.${c.reset}`);
          if (issues.includes('SPA_OR_EMPTY')) console.log(`  ${c.yellow}${SYM.warn} Site looks JS-rendered (SPA). Auto-suggest may produce generic results.${c.reset}`);
          if (issues.includes('TINY_HTML')) console.log(`  ${c.yellow}${SYM.warn} Very little HTML returned (${html.length} bytes).${c.reset}`);
          if (issues.length > 0 && !nonInteractive) {
            const cont = (await ask(`Continue anyway? [y/N] `, 'n')).trim();
            if (!/^y/i.test(cont)) throw new Error('user aborted after site issues');
          }

          // P0.4: brand-on-site check (skipped when running without site content)
          const allSiteText = `${site.title} ${site.metaDesc} ${(site.h1 || []).join(' ')} ${(site.h2 || []).join(' ')} ${site.text || ''}`.toLowerCase();
          if (!degradedNoSite && !allSiteText.includes(brand.toLowerCase())) {
            console.log(`${c.yellow}${SYM.warn} Brand "${brand}" not found anywhere on ${fullUrl}.${c.reset}`);
            console.log(`  Possible: typo in brand, wrong domain, or brand not on homepage.`);
            if (!nonInteractive) {
              const cont = (await ask(`Continue anyway? [y/N] `, 'n')).trim();
              if (!/^y/i.test(cont)) throw new Error('aborted: brand not found on site');
            }
          }

          // P1: category description — the single most important disambiguator.
          // Webappski case showed that a brand like "AEO services" can match the wrong industry
          // (customs) without an explicit category. Priority: --category flag > interactive prompt > auto-infer.
          let autoCategory = inferCategory(site, brand);
          // 1.1.8 (F5): inferCategory returns a title+meta marketing sentence —
          // compress it to a 2-5 word noun phrase via one tiny LLM call. A clean
          // phrase anchors the brainstorm better AND survives the recovery
          // panel's ≤4-word category-filler guard. Falls back to the raw string.
          if (!opts.category && autoCategory && autoCategory.split(/\s+/).length > 4 && researchProviders[0]) {
            const { cleanCategory } = await import('../lib/init/clean-category.js');
            const rp = researchProviders[0];
            const compact = await cleanCategory({
              rawCategory: autoCategory, site, brand,
              provider: { ...rp, model: rp.classifyModel || rp.model },
            });
            if (compact) autoCategory = compact;
          }
          const audienceTags = detectAudience(site);
          const geoTags = detectGeography(domain, site);
          if (opts.category) {
            categoryDescription = opts.category.trim();
            console.log(`${c.dim}  Category (from --category flag): ${categoryDescription}${c.reset}`);
          } else if (nonInteractive) {
            categoryDescription = autoCategory;
            console.log(`${c.yellow}  No --category flag — using auto-inferred from site:${c.reset}`);
            console.log(`    "${categoryDescription}"`);
            console.log(`${c.dim}  Pass --category="..." next time to override if this is off.${c.reset}`);
          } else {
            console.log(`\n${c.bold}What does your company do?${c.reset} (one sentence — used to disambiguate queries)`);
            console.log(`${c.dim}  Auto-inferred from your site:${c.reset}`);
            console.log(`    "${autoCategory}"`);
            const answer = (await ask(`  Press Enter to accept, or type a custom description: `, '')).trim();
            categoryDescription = answer || autoCategory;
          }
          if (audienceTags.length > 0) console.log(`${c.dim}  Detected audience: ${audienceTags.join(', ')}${c.reset}`);
          if (geoTags.length > 0) console.log(`${c.dim}  Detected geography: ${geoTags.join(', ')}${c.reset}`);

          // LLM retry loop: walk researchProviders in priority order. Success
          // on any provider sets `llmSucceeded = true` and exits the loop.
          // Billing/auth/rate-limit errors are logged and we try the next
          // provider. Non-retryable errors (real bugs, malformed requests)
          // bubble to the outer catch so they're not silently swallowed.
          const attempts = [];
          let llmSucceeded = false;

          for (let i = 0; i < researchProviders.length; i++) {
            const primary = researchProviders[i];
            const validator = researchProviders.find((_, j) => j !== i) || null;

            if (i === 0 && !validator) {
              console.log(`${c.yellow}  ${SYM.warn} Cross-model validation skipped — only one LLM provider available (single-model bias risk).${c.reset}`);
            }
            if (i > 0) {
              console.log(`${c.dim}  Retrying brainstorm with ${primary.label}...${c.reset}`);
            }

            try {
              // --light flag: fall back to v0.4.x single-shot suggest (faster, cheaper, less thorough)
              if (opts.light) {
                const { suggestConfig, detectAmbiguousQueries } = await import('../lib/init/suggest.js');
                if (i === 0) console.log(`${c.dim}  [light mode] single-shot suggest — no brainstorm, no validation${c.reset}`);
                const s = await suggestConfig({
                  brand, domain, site, categoryDescription,
                  providerCall: (p, k, m) => primary.providerCall(p, k, m, { webSearch: false }),
                  apiKey: primary.apiKey, model: primary.model,
                  onAttempt: ({ estimate }) => console.log(`${c.dim}  Asking ${primary.label}... (~$${estimate.usd.toFixed(4)})${c.reset}`),
                });
                queries = s.queries;
                suggestionLang = s.language || site.lang;
                const ambiguous = detectAmbiguousQueries(queries);
                if (ambiguous.length > 0) {
                  console.log(`${c.yellow}  ${SYM.warn} ${ambiguous.length} ambiguous acronyms detected — consider --auto (full research) next time${c.reset}`);
                }
              } else {
                // Full research pipeline (v0.5 default)
                const { research } = await import('../lib/init/research/research.js');
                const { selectTopThree, formatSelection } = await import('../lib/init/research/select.js');

                if (i === 0) console.log(`${c.dim}  [full pipeline] brainstorm → filter → score → cross-model validate${c.reset}`);
                const t0 = Date.now();
                const autoSpinner = createSpinner();
                const researchResult = await research({
                  brand, domain, site, category: categoryDescription,
                  audienceTags, geoTags,
                  primary, validator,
                  logPhase: makePipelineReporter(autoSpinner),
                });
                const selectResult = selectTopThree(researchResult.candidates, { validationSkipped: !validator });
                const elapsed = Date.now() - t0;

                console.log(`\n${c.dim}  pipeline complete in ${elapsed}ms, est cost ~$${researchResult.trace.estimatedCostUsd.toFixed(4)}${c.reset}\n`);

                // 1.0.6 — commercial-only over-generate + silent substitution.
                // Replaces 1.0.4 Fix A (pool validation) + 1.0.5 top-up. With
                // brainstorm now producing only 5 commercial candidates (3 needed
                // + 2 spares), we validate all 5 through both stages here and
                // silently substitute failing top-3 with passing spares. User
                // sees ONLY the final 3 — no recovery panel for the common case.
                const primaryForValidation = researchProviders[0];
                const allFive = [
                  ...selectResult.selected.map(s => s.candidate),
                  ...selectResult.alternatives,
                ];
                let commercialPassingCount = null;
                if (allFive.length >= 3 && primaryForValidation?.providerCall) {
                  try {
                    const { runTwoStageValidation, SEARCH_BEHAVIORS } =
                      await import('../lib/init/research/run-validation.js');
                    const validation = await runTwoStageValidation({
                      queries: allFive.map(c => c.text),
                      brand, domain, category: categoryDescription,
                      geography: geoTags || [],
                      primary: primaryForValidation,
                      secondary: null,
                      validationCache: [],
                      commercialOnly: false,
                    });
                    const verdicts = validation.updatedCache || [];
                    if (verdicts.length === 0) {
                      // Empty verdicts (validator returned nothing without throwing
                      // — e.g. throttled). Treat as skipped to avoid silently
                      // accepting un-validated queries.
                      throw new Error('Validation returned no verdicts');
                    }
                    // Attach the full verdict on each candidate. `valid` is
                    // required by isVerifiedSubstitute (llm-blocker recovery).
                    for (const c of allFive) {
                      const verdict = verdicts.find(v => v.query === c.text);
                      if (verdict) {
                        c.search_behavior = verdict.search_behavior;
                        c.confidence = verdict.confidence;
                        c.valid = verdict.valid;
                      }
                    }
                    // 1.1.8: these verdicts seed the main validation's cache.
                    config_validationSeedCache = verdicts;
                    // 1.0.8 silent-substitution PASS — must use the SAME rules
                    // as main validation (run-validation.js:186 + :194). Earlier
                    // versions checked only search_behavior, which allowed
                    // valid:false queries through substitution; main validation
                    // then rejected them, breaking the contract.
                    //
                    // Rules now in lockstep:
                    //   - main llmIssues filter: !valid → block
                    //   - main informationalIssues filter: search_behavior !== RETRIEVAL → block
                    //   - substitution PASS: NOT in either filter
                    //
                    // Legacy graceful: if no verdict entry exists (cache miss),
                    // pass through — same as 1.0.7 behaviour. If verdict exists
                    // but lacks `valid` (legacy pre-1.0.8 cache shape), fail
                    // closed — `verdict.valid === true` is false for undefined.
                    const PASS = (c) => {
                      const verdict = verdicts.find(v => v.query === c.text);
                      if (!verdict) return true;  // graceful: no verdict → pass through
                      return verdict.valid === true
                          && verdict.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL;
                    };
                    const passing = allFive.filter(PASS);
                    commercialPassingCount = passing.length;

                    // 1.1.8 top-up: fewer than 3 passing → ONE extra brainstorm
                    // round steered by the rejection reasons (which used to be
                    // computed, printed, and thrown away). Bounded: one round,
                    // then the recovery panel fires as before if still short.
                    if (passing.length < 3) {
                      try {
                        const { topUpCommercialCandidates } = await import('../lib/init/research/topup.js');
                        const isPass = (vd) => vd.valid === true && vd.search_behavior === SEARCH_BEHAVIORS.RETRIEVAL;
                        const avoidFeedback = verdicts.filter(vd => !isPass(vd)).map(vd => ({
                          query: vd.query,
                          reason: vd.reason
                            || (vd.search_behavior && vd.search_behavior !== SEARCH_BEHAVIORS.RETRIEVAL
                              ? `non-commercial (search_behavior: ${vd.search_behavior})`
                              : 'failed validation'),
                        }));
                        console.log(`${c.dim}  Only ${passing.length} of ${allFive.length} candidates passed — running one top-up round with rejection feedback...${c.reset}`);
                        const topUp = await topUpCommercialCandidates({
                          brand, domain, site, categoryDescription, audienceTags, geoTags,
                          avoidFeedback,
                          existingTexts: allFive.map(cand => cand.text),
                          provider: primaryForValidation,
                          validateBatch: async (qs) => {
                            const vTop = await runTwoStageValidation({
                              queries: qs, brand, domain, category: categoryDescription,
                              geography: geoTags || [], primary: primaryForValidation,
                              secondary: null, validationCache: [], commercialOnly: false,
                            });
                            return vTop.updatedCache || [];
                          },
                        });
                        config_validationSeedCache = [...config_validationSeedCache, ...topUp.verdicts];
                        if (topUp.added.length > 0) {
                          console.log(`${c.dim}  Top-up added ${topUp.added.length} validated candidate(s).${c.reset}`);
                          passing.push(...topUp.added);
                          allFive.push(...topUp.added);
                          commercialPassingCount = passing.length;
                        } else if (topUp.attempted.length > 0) {
                          console.log(`${c.yellow}  Top-up round produced no passing candidates (${topUp.attempted.length} tried).${c.reset}`);
                        }
                      } catch (topUpErr) {
                        console.error(`${c.yellow}  Top-up skipped: ${errMsg(topUpErr)}${c.reset}`);
                      }
                    }

                    if (commercialPassingCount >= 3) {
                      // Happy path — re-sort passing by score, take top-3.
                      passing.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
                      selectResult.selected = passing.slice(0, 3).map(c => ({
                        intent: c.intent || 'commercial',
                        candidate: c,
                        fallbackUsed: null,
                      }));
                      selectResult.alternatives = passing.slice(3).map(c => ({ ...c }));
                    }
                    // ELSE <3 passing: leave selectResult as-is; recovery panel
                    // will fire downstream with the honest "X of 5" message.
                  } catch (err) {
                    console.error(`${c.yellow}  Validation skipped: ${errMsg(err)}${c.reset}`);
                  }
                }
                selectResult.commercialPassingCount = commercialPassingCount;
                config_commercialPassingCount = commercialPassingCount;

                // Display selected + alternatives — formatSelection sees the
                // post-substitution result. All commercial intent.
                for (const line of formatSelection(selectResult)) console.log(line);

                const accept = (nonInteractive ? 'y' : (await ask(`\nAccept selected queries? [Y]es / [e]dit / [n]o: `, 'y'))).trim();
                if (/^e/i.test(accept)) {
                  const edited = [];
                  for (let j = 0; j < selectResult.selected.length; j++) {
                    const cand = selectResult.selected[j].candidate;
                    const v = (await ask(`  Q${j + 1} [${cand.text}]: `, cand.text)).trim();
                    edited.push(v || cand.text);
                  }
                  queries = edited;
                } else if (!/^n/i.test(accept)) {
                  queries = selectResult.selected.map(s => s.candidate.text);
                }

                // Capture intent per final query for validator-recovery. When user
                // edited a query by hand, text may not match any candidate — intent
                // falls back to the slot's selected candidate intent (best effort).
                config_queryIntents = queries.map((qt, i) => {
                  const match = selectResult.selected.find(s => s.candidate.text === qt);
                  return match?.candidate.intent || selectResult.selected[i]?.candidate.intent || '';
                });

                // Persist candidate pool for future swap-without-LLM (D3).
                // 1.0.4 Fix A.1b: include search_behavior + confidence when
                // pool-validation succeeded so the recovery panel filter and
                // the (validated) tag stay honest after reload.
                // 1.0.4 pool-topup: carry topUp flag for traceability —
                // distinguishes appended top-up entries from original research
                // candidates in diff/report tooling.
                if (selectResult.alternatives.length > 0) {
                  config_candidatePool = selectResult.alternatives.slice(0, 5).map(a => ({
                    text: a.text,
                    intent: a.intent,
                    score: a.score,
                    unverified: !!a.unverified,
                    ...(a.search_behavior ? {
                      search_behavior: a.search_behavior,
                      confidence: a.confidence,
                    } : {}),
                    // 1.1.8: carry the verdict's valid flag — required by
                    // isVerifiedSubstitute for llm-blocker recovery.
                    ...(typeof a.valid === 'boolean' ? { valid: a.valid } : {}),
                    ...(a.topUp ? { topUp: true } : {}),
                  }));
                }
                suggestionLang = site.lang || 'en';
              }

              llmSucceeded = true;
              break;
            } catch (llmErr) {
              const classified = classifyProviderError(llmErr);
              attempts.push({
                provider: primary.name,
                label: primary.label,
                envVar: providerKey[primary.name] || null,
                rawError: errMsg(llmErr),
                classified,
              });

              if (!classified.retryable) {
                // Not a billing/auth/rate-limit issue — this is a real bug.
                // Surface the full context (which providers we tried first,
                // and why each failed) BEFORE rethrowing, so the user sees
                // the same actionable panel they'd see for all-retryable
                // failures — just followed by the raw bug for the developer
                // to file. Previously this block dropped `attempts` on the
                // floor and the user saw only the final TypeError.
                if (attempts.length > 1) {
                  for (const line of formatResearchFailurePanel({
                    attempts, brand, domain: fullUrl, useColor: USE_COLOR,
                  })) {
                    console.log(line);
                  }
                  console.log(`${c.dim}  The last attempt above (${primary.label}) failed with an unclassified error that's likely a bug in aeo-tracker. Raw message follows.${c.reset}`);
                  console.log('');
                }
                throw llmErr;
              }

              console.log(`${c.yellow}  ${primary.label} failed: ${classified.reason}${c.reset}`);
              if (i < researchProviders.length - 1) {
                console.log(`${c.dim}  Trying next provider in priority order...${c.reset}`);
              }
            }
          }

          if (!llmSucceeded) {
            // Every research provider returned a billing/auth/rate-limit error.
            // Show the actionable panel so the user has a copy-pastable path
            // to success instead of a bare "aborting" message.
            for (const line of formatResearchFailurePanel({
              attempts, brand, domain: fullUrl, useColor: USE_COLOR,
            })) {
              console.log(line);
            }
            if (nonInteractive) {
              console.error(`${c.red}Non-interactive mode — cannot prompt for manual input. Aborting.${c.reset}`);
              process.exit(1);
            }
            console.log(`${c.dim}  Falling back to manual input.${c.reset}`);
          }
        } catch (err) {
          // Non-retryable errors from LLM loop (real bugs) OR errors from the
          // fetch/parse/category steps above. Both land here; we show the same
          // message, since it's a hard failure either way.
          console.log(`${c.yellow}  Auto-suggest failed: ${errMsg(err)}${c.reset}`);
          if (nonInteractive) {
            console.error(`${c.red}Cannot fall back to manual in non-interactive mode. Aborting.${c.reset}`);
            process.exit(1);
          }
          console.log(`${c.dim}  Falling back to manual input.${c.reset}`);
        }
      }
    }
  }

  // Manual fallback
  if (queries.length === 0) {
    if (nonInteractive) {
      console.error(`${c.red}No queries — non-interactive --manual mode requires pre-configured queries (not yet supported via flags). Use --auto or drop --yes.${c.reset}`);
      process.exit(1);
    }
    console.log(`\n${c.bold}Enter 3 unbranded test queries:${c.reset}`);
    console.log(`${c.dim}  Templates:${c.reset}`);
    console.log(`${c.dim}    Commercial:    "best <your category> 2026"${c.reset}`);
    console.log(`${c.dim}    Informational: "how to <problem you solve>"${c.reset}`);
    console.log(`${c.dim}    Vertical:      "<your category> for <audience>"${c.reset}`);
    for (let i = 1; i <= 3; i++) {
      const label = i === 1 ? 'commercial' : i === 2 ? 'informational' : 'vertical';
      const q = (await ask(`  Q${i} (${label}): `, '')).trim();
      if (q) queries.push(q);
    }
  }

  // P0.2: final queries guard
  if (queries.length !== 3) {
    console.error(`${c.red}Error: need exactly 3 queries, got ${queries.length}. Aborting without saving config.${c.reset}`);
    process.exit(1);
  }

  // Two-stage validation (static acronym + LLM industry-fit). Single shared helper —
  // see lib/init/research/run-validation.js. Cache written to config below so `run`
  // can trust verdicts without re-paying $0.005 on every invocation.
  const validationProviders = await buildResearchProviders(providerKey, selectedProviders);
  const _geoForValidation = (typeof geoTags !== 'undefined' && geoTags) ? geoTags : detectGeography(domain, {});
  const recovery = await runValidationWithRecovery({
    queries,
    queryIntents: config_queryIntents,
    candidatePool: config_candidatePool,
    brand, domain,
    category: categoryDescription,
    geography: _geoForValidation,
    primary: validationProviders.primary,
    secondary: validationProviders.validator,
    // 1.1.8 (F1): seeded with the substitution-block verdicts — ONE validation,
    // one source of truth. The old `[]` re-roll let a non-deterministic
    // classifier flip a borderline verdict between two calls, so the pipeline
    // selected a trio and then rejected its own selection. Strict mode skips
    // the seed: its contract is a fresh two-model cross-check, which a cache
    // hit would short-circuit.
    validationCache: opts.strictValidation ? [] : config_validationSeedCache,
    nonInteractive,
    force: opts.force,
    strictValidation: opts.strictValidation,
    ask, useColor: !!c.red,
    commercialPassingCount: config_commercialPassingCount,  // 1.0.6
  });
  if (recovery.recoveryFailed) {
    // Panel already printed. Exit with code 1 — validation failed, user has
    // a copy-paste command to retry.
    process.exit(1);
  }
  queries = recovery.queries;
  const validation = recovery.v;

  // Persist provider defaults. `selectedProviders` was seeded from FALLBACK
  // constants in lib/providers/discover.js — these defaults are the safety net
  // when `aeo-tracker run` discovery cannot reach a provider's /v1/models endpoint.
  // Actual model selection happens fresh at each run via discoverModels.
  const providers = selectedProviders;

  // v0.7 — initialise basket version on first save
  const { initialBasket } = await import('../lib/init/basket-history.js');
  const basketInit = initialBasket(queries, new Date().toISOString().slice(0, 10));

  const config = {
    brand, domain, category: categoryDescription || '',
    queries, regressionThreshold: 10, providers,
    ...basketInit,
  };
  if (config_candidatePool.length > 0) {
    config.candidatePool = config_candidatePool;
  }
  // Persist validation verdicts so `run` can trust them without re-paying per invocation.
  if (validation?.updatedCache?.length > 0) {
    config.validationCache = validation.updatedCache;
  }

  // D2: atomic write
  const tmpPath = CONFIG_FILE + '.tmp';
  await writeFile(tmpPath, JSON.stringify(config, null, 2));
  await rename(tmpPath, CONFIG_FILE);

  console.log(`\n${c.green}${SYM.ok} Created ${CONFIG_FILE}${c.reset}`);
  console.log(`  Brand: ${brand} | Domain: ${domain}`);
  console.log(`  Queries: ${queries.length}, Providers: ${Object.keys(providers).length}`);
  console.log(`\nNext: ${c.cyan}aeo-platform run${c.reset}\n`);
}

// Maps model ID prefixes to short display labels. More specific entries first.
const MODEL_SHORT_LABELS = [
  [/^gpt-5-search-api/,          'gpt/5-search'],
  [/^gpt-5\.(\d+)-(mini|nano|pro)/, (_, v, t) => `gpt/5.${v}-${t}`],
  [/^gpt-5\.(\d+)/,              (_, v) => `gpt/5.${v}`],
  [/^gpt-5-(mini|nano)/,         (_, t) => `gpt/5-${t}`],
  [/^gpt-5/,                     'gpt/5'],
  [/^gpt-4o-(mini|search)/,      (_, t) => `gpt/4o-${t}`],
  [/^gpt-4o/,                    'gpt/4o'],
  [/^gpt-/,                      'gpt/'],
  [/^claude-(haiku|sonnet|opus)/, (_, t) => `claude/${t}`],
  [/^gemini-(\d+\.\d+)-(pro|flash)/, (_, v, t) => `gemini/${v}-${t}`],
  [/^gemini-(\d+\.\d+)/,         (_, v) => `gemini/${v}`],
  [/^sonar-(reasoning-pro|pro)/,  (_, t) => `sonar/${t}`],
  [/^sonar/,                     'sonar'],
];

function _modelColLabel(provider, modelId) {
  const clean = modelId
    .replace(/-preview$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
  for (const [pattern, label] of MODEL_SHORT_LABELS) {
    if (pattern.test(clean)) {
      return typeof label === 'function' ? clean.replace(pattern, label) : label;
    }
  }
  return `${provider}/${clean}`;
}

async function cmdRun(options = {}) {
  const silent = options.json === true;
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  if (silent) {
    console.log = () => {};
    process.stdout.write = () => true;
  }

  // Shared prompter for the only interactive prompt in this command — the
  // --depth=auto stale-baseline confirmation. The top-level dispatcher always
  // creates this; a fallback createPrompter() here would be a second readline
  // on the same stdin (the exact regression that 1.0.2 fixed). Direct callers
  // (tests, programmatic embedding) must inject their own prompter.
  if (!options.prompter) {
    throw new Error('cmdRun: options.prompter is required (the dispatcher in bin/aeo-tracker.js wires this; tests must pass createPrompter({...}))');
  }
  const ask = options.prompter.ask;

  // Load config
  if (!existsSync(CONFIG_FILE)) {
    console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-platform init${c.reset}`);
    process.exit(1);
  }

  const config = await readConfigOrExit();
  // Apply --openai-model / --gemini-model / etc. overrides BEFORE destructuring
  // providerConfig — overrides mutate config.providers in place so downstream
  // provider discovery picks up the user's chosen model. Disk config is not
  // touched; this is per-run only.
  applyCliModelOverrides(config, {
    openaiModel:     options.openaiModel,
    geminiModel:     options.geminiModel,
    anthropicModel:  options.anthropicModel,
    perplexityModel: options.perplexityModel,
  });
  const { brand, domain, queries: rawQueries, providers: providerConfig } = config;

  if (!brand || !domain || !rawQueries?.length) {
    console.error(`${c.red}Invalid config. brand, domain, and queries are required.${c.reset}`);
    process.exit(1);
  }

  // v0.4 — normalise queries to support both string and {q, tag} forms.
  // The `texts` array is what the rest of the run loop iterates over (no
  // structural change downstream); `tags` are looked up by index when results
  // are written.
  const { texts: queries, tags: queryTags, hasTags } = normalizeQueries(rawQueries);
  if (hasTags) {
    console.log(`${c.dim}Funnel/intent tags: ${[...new Set(queryTags.filter(Boolean))].join(', ')}${c.reset}`);
  }

  // v0.4 — parse --geo flag here; the cost-warn line is emitted *after*
  // provider discovery so we can include activeProviders.length in the message
  // (referencing it before the const declaration would TDZ-crash).
  let regionsToRun = [null];
  let parsedGeo = null;
  if (options.geo) {
    parsedGeo = parseGeoFlag(options.geo);
    if (parsedGeo.invalid && parsedGeo.invalid.length > 0) {
      console.warn(`${c.yellow}  Unknown geo codes ignored: ${parsedGeo.invalid.join(', ')} (valid: ${listRegionCodes()})${c.reset}`);
    }
    if (parsedGeo.regions && parsedGeo.regions.length > 0) {
      regionsToRun = parsedGeo.regions;
    }
  }

  // Resolve replay mode early — when active, we skip the live `/v1/models`
  // discovery HTTP and build providers from `.aeo-tracker.json` cfg.model
  // directly. Rationale: `--replay [--replay-from=DATE]` is a user-explicit
  // contract ("use cached responses, don't hit live APIs"); discovery is a
  // live API hit. Skipping it in replay mode keeps the offline contract
  // coherent. The replay seam at line ~2026 (`_tryReplay`) is filename-keyed
  // by `provider.model`, so the configured model name is all we need.
  // See PITFALLS.md "2026-05-20 — Replay mode НЕ skip live model discovery".
  let replaySrcDate = null;
  if (options.replay) {
    replaySrcDate = await _resolveReplaySource(options.replayFrom);
    if (!replaySrcDate) {
      console.error(`${c.red}--replay: no prior aeo-responses/YYYY-MM-DD folder found${c.reset}`);
      process.exit(1);
    }
    console.log(`${c.yellow}  [replay] serving cached responses from aeo-responses/${replaySrcDate}/${c.reset}\n`);
  }

  const activeProviders = [];
  if (replaySrcDate) {
    // Replay mode: skip live `/v1/models` discovery — use cfg.model from
    // .aeo-tracker.json verbatim. activeProviders shape must match the live
    // branch below (used by `_tryReplay`, per-cell loop, scheduler).
    // apiKey is still read from env so downstream extraction calls have a
    // value to send; if the user has fake keys, extraction will 401 inside
    // the per-cell try/catch → mention='error' → exit 3 (NOT exit 1).
    console.log(`\n${c.dim}Replay mode: skipping live model discovery (using cfg.model from config).${c.reset}`);
    for (const [name, cfg] of Object.entries(providerConfig || DEFAULT_CONFIG.providers)) {
      const envKey = cfg.env || `${name.toUpperCase()}_API_KEY`;
      const apiKey = process.env[envKey];
      if (!apiKey) {
        console.log(`${c.dim}  skip ${name} — no ${envKey}${c.reset}`);
        continue;
      }
      const modelId = cfg.model;
      if (!modelId) {
        console.log(`${c.dim}  skip ${name} — no cfg.model in .aeo-tracker.json (re-run: aeo-platform init)${c.reset}`);
        continue;
      }
      const trainingModel = deriveTrainingModel(name, modelId);
      console.log(`  ${c.green}${SYM.ok}${c.reset} ${name}: ${modelId} ${c.dim}(replay)${c.reset}`);
      activeProviders.push({
        name,
        model: modelId,
        trainingModel,
        classifyModel: cfg.classifyModel || MODEL_FALLBACK[name]?.classify,
        mainOptions: MAIN_OPTIONS_BY_PROVIDER[name] || {},
        colLabel: _modelColLabel(name, modelId),
        apiKey,
        ...PROVIDERS[name],
      });
    }
  } else {
    // Live mode: discover current search-capable models for each configured
    // provider. Parallel HTTP fetch of /v1/models (~1-2s total with 10s
    // per-provider timeout). Fallback chain on failure:
    //   - 401/403 (authError) → skip provider entirely (same bad key for run
    //                          would fail too)
    //   - other failure → fallback to cfg.model from .aeo-tracker.json
    //   - cfg.model also missing → skip with hint to re-init
    console.log(`\n${c.dim}Discovering current models…${c.reset}`);
    const discoveryResults = await Promise.all(
      Object.entries(providerConfig || DEFAULT_CONFIG.providers).map(async ([name, cfg]) => {
        try {
          const envKey = cfg.env || `${name.toUpperCase()}_API_KEY`;
          const apiKey = process.env[envKey];
          if (!apiKey) return { name, cfg, skip: 'no-key', envKey };
          const { models, authError } = await discoverModels(name, apiKey, cfg.baseURL);
          return { name, cfg, apiKey, models, authError };
        } catch (err) {
          // Defensive per-task catch: ensures one crash doesn't break Promise.all.
          return { name, cfg, skip: 'crash', err };
        }
      }),
    );

    for (const r of discoveryResults) {
      if (r.skip === 'no-key') {
        console.log(`${c.dim}  skip ${r.name} — no ${r.envKey}${c.reset}`);
        continue;
      }
      if (r.skip === 'crash') {
        console.error(`  ${c.yellow}${SYM.warn}${c.reset} ${r.name} — discovery crashed: ${r.err?.message}. Skipping.${c.reset}`);
        continue;
      }
      if (r.authError) {
        console.error(`  ${c.red}${SYM.err}${c.reset} ${r.name} — invalid API key (HTTP 401/403). Skipping this provider.${c.reset}`);
        continue;
      }
      // Discovery success → use discovered. Discovery soft-fail → fallback to cfg.model.
      const finalModels = r.models ?? (r.cfg.model ? [r.cfg.model] : null);
      if (!finalModels?.length) {
        console.log(`${c.dim}  skip ${r.name} — discovery failed and no fallback (re-run: aeo-platform init)${c.reset}`);
        continue;
      }
      const sourceLabel = r.models ? '' : ` ${c.dim}(fallback)${c.reset}`;
      console.log(`  ${c.green}${SYM.ok}${c.reset} ${r.name}: ${finalModels.join(', ')}${sourceLabel}`);
      for (const modelId of finalModels) {
        // trainingModel = the no-search variant, used by `--depth=full`. null
        // means the provider has no training-data mode (e.g. Perplexity).
        const trainingModel = deriveTrainingModel(r.name, modelId);
        activeProviders.push({
          name: r.name,
          model: modelId,
          trainingModel,
          classifyModel: r.cfg.classifyModel || MODEL_FALLBACK[r.name]?.classify,
          mainOptions: MAIN_OPTIONS_BY_PROVIDER[r.name] || {},
          colLabel: _modelColLabel(r.name, modelId),
          apiKey: r.apiKey,
          ...PROVIDERS[r.name],
        });
      }
    }
  }

  if (activeProviders.length === 0) {
    console.error(`${c.red}No API keys found. Set at least one: OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or PERPLEXITY_API_KEY${c.reset}`);
    process.exit(1);
  }

  // v0.4 — geo cost warning, deferred until after provider discovery so the
  // message can include the real provider count.
  if (parsedGeo && parsedGeo.regions && parsedGeo.regions.length > 0) {
    const codes = regionsToRun.map(r => r.code).join(', ');
    const multiplier = regionsToRun.length;
    console.log(`${c.yellow}  --geo=${codes} → ${multiplier}× cost (${multiplier} regions × ${queries.length} queries × ${activeProviders.length} providers)${c.reset}`);
  }

  // v0.3 — depth selection: web (default) | full | auto.
  //   web   → current behaviour, single web-search pass per cell.
  //   full  → adds a training-data pass (webSearch:false) where the provider
  //           supports it. Cost ~doubles for the supported providers.
  //   auto  → defaults to `web`, but prompts the user once if the last
  //           training-data baseline is stale (>14 days) so corpus drift
  //           gets re-measured at a sparse cadence.
  const requestedDepth = (options.depth || 'web').toLowerCase();
  let depth = requestedDepth === 'full' ? 'full' : 'web';
  if (requestedDepth === 'auto') {
    const stalenessDays = await _readLastFullRunStaleness();
    const shouldPrompt = stalenessDays === null || stalenessDays >= 14;
    if (shouldPrompt) {
      const trainingProviders = activeProviders.filter(p => p.trainingModel);
      const ageHint = stalenessDays === null
        ? 'never run'
        : `${stalenessDays}d ago`;
      const ans = (await ask(
        `${c.yellow}Last training-data baseline ${ageHint}. ` +
        `Refresh now? +${trainingProviders.length}× provider calls per cell. [y/N] ${c.reset}`,
        'n',
      )).trim().toLowerCase();
      if (ans === 'y' || ans === 'yes') depth = 'full';
    }
  }
  const modesToRun = depth === 'full' ? ['web', 'training'] : ['web'];
  if (depth === 'full') {
    const trainingProviders = activeProviders.filter(p => p.trainingModel).map(p => p.name);
    const skippedProviders = activeProviders.filter(p => !p.trainingModel).map(p => p.name);
    console.log(`${c.yellow}  --depth=full → 2 passes per cell (web + training-data on ${trainingProviders.join(', ')}; ${skippedProviders.length > 0 ? `skipped: ${skippedProviders.join(', ')}` : 'all providers covered'}). Cost ~2× web-only.${c.reset}`);
  }

  const date = new Date().toISOString().split('T')[0];
  const responseDir = join('aeo-responses', date);
  await mkdir(responseDir, { recursive: true });

  console.log(`\n${c.bold}aeo-platform — run${c.reset}`);
  console.log(`${c.dim}Brand: ${brand} | Domain: ${domain} | Date: ${date}${c.reset}`);
  console.log(`${c.dim}Models: ${activeProviders.map(p => p.colLabel).join(', ')}${c.reset}`);
  console.log(`${c.dim}Queries: ${queries.length}${c.reset}\n`);

  // Pre-flight ETA: warn if any selected model has TPM headroom too small for
  // this run (will be paced across multiple 60s windows). Tone: honest "this
  // will take ~N seconds", not panicking ⚠ — the adaptive scheduler (below)
  // guarantees the run COMPLETES regardless.
  if (!options.json) {
    const cmdKey = options.depth === 'full' ? 'run-depth-full'
      : options.strictValidation ? 'run-strict' : 'run';
    const pacedLines = [];
    for (const p of activeProviders) {
      // thinkingActive — single source of truth in main-options.js.
      // Same predicate used by any future init/preview hint, so ETA shown
      // upfront matches actual runtime spend.
      const eta = estimateRunDuration(p.name, p.model, cmdKey, {
        thinkingActive: detectThinkingActive(p.name, p.model),
      });
      if (eta.mode === 'paced') {
        pacedLines.push(`${p.name}/${p.model}: paced across ~${eta.etaSeconds}s (tier 1: ${eta.limit.tpm.toLocaleString()} TPM)`);
      }
    }
    if (pacedLines.length > 0) {
      process.stderr.write(`${c.dim}Pacing to fit rate limits:${c.reset}\n`);
      for (const line of pacedLines) process.stderr.write(`${c.dim}  ${line}${c.reset}\n`);
      process.stderr.write(`${c.dim}  Tip: --openai-model gpt-5 (no web search, 15× higher TPM) skips pacing.${c.reset}\n\n`);
    }
  }

  // Pre-flight: two-stage validation with cache lookup.
  // Cache-hit (validated at init) → trust, no LLM cost.
  // Cache-miss (user hand-edited .aeo-tracker.json) → auto-run LLM validator inline
  // with visible cost, abort if any query fails. --force skips the whole gate.
  {
    const runProviders = await buildResearchProviders(Object.fromEntries(
      Object.entries(providerConfig || {}).map(([name, cfg]) => [name, cfg.env || `${name.toUpperCase()}_API_KEY`])
    ));
    await runValidationFlow({
      queries,
      brand, domain,
      category: config.category || '',
      geography: [], // run-time has no site context; cache usually covers this
      primary: runProviders.primary,
      secondary: runProviders.validator,
      validationCache: config.validationCache || [],
      nonInteractive: true,       // run is always "CI-like" — no interactive prompt during API spend
      force: options.force,
      strictValidation: options.strictValidation,
      ask,
    });
  }

  // Resolve competitor-extraction providers (see buildExtractionProviders:
  // two → cross-check, one → single-model unverified, zero → throw). Done
  // up-front so a no-key client sees the error BEFORE any paid API calls.
  let extractionProviders;
  try {
    extractionProviders = await buildExtractionProviders(providerConfig);
  } catch (err) {
    console.error(`\n${c.red}${SYM.err} ${errMsg(err)}${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.dim}  Extractor: ${extractionProviders.secondary
    ? `${extractionProviders.primary.model} + ${extractionProviders.secondary.model} (parallel cross-check)`
    : `${extractionProviders.primary.model} (single-model — competitor mentions will be unverified)`}${c.reset}\n`);

  // Load today's existing _summary.json — skip checks that already succeeded.
  // --force bypasses this entirely: every cell runs fresh, the new summary
  // overwrites the old one, and the merge block below stays a no-op because
  // existingSummary remains null.
  const summaryPath = join(responseDir, '_summary.json');
  let existingSummary = null;
  const skipKeys = new Set();
  if (options.force && existsSync(summaryPath)) {
    console.log(`${c.yellow}  --force set — bypassing today's response cache, every cell will be re-queried${c.reset}\n`);
  } else if (existsSync(summaryPath)) {
    try {
      existingSummary = JSON.parse(await readFile(summaryPath, 'utf-8'));
      for (const r of existingSummary.results || []) {
        // 5-component key (query:region:provider:model:mode) — matches the
        // lookup format below. region empty for non-geo runs; mode defaults
        // to 'web' for legacy results that pre-date --depth=full.
        if (r.mention !== 'error') {
          skipKeys.add(`${r.query}:${r.region || ''}:${r.provider}:${r.model}:${r.mode || 'web'}`);
        }
      }
    } catch {
      // Corrupt summary → start fresh, but SAY so — a silent reset reads as
      // "my morning run vanished" (AP-FAIL-BRANCHES: no silent recoveries).
      console.log(`${c.yellow}  Today's _summary.json was unreadable (likely an interrupted earlier run) — starting fresh.${c.reset}`);
    }
  }
  if (skipKeys.size > 0) {
    console.log(`${c.dim}  ${skipKeys.size} check${skipKeys.size !== 1 ? 's' : ''} already succeeded today — retrying only errors${c.reset}\n`);
  }

  // Replay mode: replaySrcDate was resolved earlier (before model discovery)
  // so the replay branch could skip the live `/v1/models` HTTP. See the block
  // ~1720 for the resolution + provider-build logic.

  // Run all checks via the adaptive scheduler. Tasks are collected with their
  // (provider, model) ledger key — `planSchedule` packs each (provider, model)
  // bucket into 60s TPM windows. Buckets run in parallel; tasks within a
  // bucket fire per the plan, semaphore-limited downstream.
  //
  // Live-row UI: each task gets a row that animates while running and shows
  // live cooldown/pacing countdowns. `--json` mode skips live entirely (stdout
  // reserved for the JSON blob). Non-TTY consumers get a structured start/finish
  // log per task via the manager's non-animate path.
  const results = [];
  /** @type {Map<string, Array<{fn: () => Promise<void>, estimatedTokens: number}>>} */
  const tasksByCdKey = new Map();
  // Extraction cost accumulates across all cells (each cell fires two LLM calls).
  const extractionCostTotal = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const live = options.json ? null : createLiveRows({ stream: process.stderr });

  for (let qi = 0; qi < queries.length; qi++) {
    const baseQuery = queries[qi];
    for (const region of regionsToRun) {
      const query = wrapQueryForRegion(baseQuery, region);
      for (const provider of activeProviders) {
        for (const mode of modesToRun) {
          // training-data pass is skipped for providers that don't support it
          // (e.g. Perplexity is search-only by design).
          if (mode === 'training' && !provider.trainingModel) continue;
          const cellModelForKey = mode === 'training' ? provider.trainingModel : provider.model;
          const cdKey = `${provider.name}:${cellModelForKey}`;
          const regionTag = region ? `[${region.code.toUpperCase()}]` : '';
          const modeTag   = mode === 'training' ? '[T]' : '';
          const tag = `Q${qi + 1}${regionTag}${modeTag}/${provider.colLabel}`;
          // taskId includes region for --geo uniqueness — same (cdKey, queryIdx)
          // appears twice with --geo=us,uk and we'd otherwise overwrite each other.
          const taskId = `${cdKey}#${qi}#${region?.code || ''}#${mode}`;
          live?.add(taskId, tag);
          const taskFn = async () => {
            const cellModel = mode === 'training' ? provider.trainingModel : provider.model;
            // Main query call: inject mainOptions (reasoning_effort=high for
            // OpenAI, thinking-enabled for Anthropic). Training call: keep clean
            // (measure base training-corpus knowledge without reasoning influence).
            // Per-provider regex gate in openai.js/anthropic.js silently drops
            // incompatible options если model не поддерживает.
            const callOpts  = mode === 'training'
              ? { webSearch: false }
              : { ...(provider.mainOptions || {}) };
            const skipKey = `Q${qi + 1}:${region?.code || ''}:${provider.name}:${cellModel}:${mode}`;
            if (skipKeys.has(skipKey)) {
              // Skip: nothing to do. Remove the row (don't leave it stuck in queued).
              live?.finish(taskId, { status: 'done', detail: 'cached from earlier run today' });
              return;
            }
            const t0 = Date.now();
            try {
              // In --json mode (live === null) stay silent — stdout is reserved
              // for the final JSON blob, any human-readable line corrupts the
              // consumer's parser. Live manager handles UI in interactive mode.
              if (live) live.update(taskId, { status: 'running', detail: 'firing…' });

              // Per-task status reporter: cooldown / ledger-wait / firing / retrying /
              // tokens events from withProviderCall + withRetry → row updates.
              const onStatus = live ? (ev) => {
                if (ev.kind === 'cooldown') {
                  // 1.0.7: clear labels + live countdown. Operator sees the
                  // seconds tick down (60s → 59s → 58s …) every render frame.
                  // Clamp ms against negative / NaN so countdown never displays
                  // "NaNs remaining" if upstream emits garbage.
                  const ms = Math.max(0, Number.isFinite(ev.ms) ? ev.ms : 0);
                  const sec = Math.ceil(ms / 1000);
                  const prefix = 'provider cooldown (post-429 backoff) — ';
                  live.update(taskId, {
                    status: 'cooldown',
                    labelPrefix: prefix,
                    detail: `${prefix}${sec}s remaining`,
                    deadlineMs: Date.now() + ms,
                  });
                } else if (ev.kind === 'ledger-wait') {
                  const ms = Math.max(0, Number.isFinite(ev.ms) ? ev.ms : 0);
                  const sec = Math.ceil(ms / 1000);
                  const prefix = 'TPM rate-limit — ';
                  live.update(taskId, {
                    status: 'ledger-wait',
                    labelPrefix: prefix,
                    detail: `${prefix}${sec}s until token-bucket refill`,
                    deadlineMs: Date.now() + ms,
                  });
                } else if (ev.kind === 'firing') {
                  // 1.0.7: replace cryptic "firing…" with concrete action.
                  live.update(taskId, { status: 'running', detail: 'calling provider API (network in-flight)' });
                } else if (ev.kind === 'retrying') {
                  live.update(taskId, { status: 'running', detail: `retrying (attempt ${ev.attempt})` });
                } else if (ev.kind === 'tokens' && process.env.AEO_LOG_TOKENS === '1') {
                  live.log(`  [tokens] ${ev.cdKey}: input=${ev.input} output=${ev.output} total=${ev.input + ev.output}`);
                }
              } : undefined;

              // Replay mode (see replay-mode block at top of file)
              const replayed = replaySrcDate ? await _tryReplay(qi + 1, provider, replaySrcDate) : null;
              // End replay
              const { text, citations, raw } = replayed
                || await provider.call(query, provider.apiKey, cellModel, { ...callOpts, onStatus });
              const elapsedMs = Date.now() - t0;

              // Save raw response — region + mode suffixes in filename so
              // multi-region / dual-pass runs don't collide.
              const safeModel = sanitizeForFilename(cellModel);
              const regionSuffix = region ? `-${region.code}` : '';
              const modeSuffix = mode === 'training' ? '-training' : '';
              const rawFile = join(responseDir, `q${qi + 1}${regionSuffix}${modeSuffix}-${provider.name}-${safeModel}.json`);
              await writeFile(rawFile, JSON.stringify(raw, null, 2));

              const mention = detectMention(text, citations, brand, domain);
              const position = mention === 'yes' ? findPosition(text, brand, domain) : null;
              const adSignal = detectAdsInResponse(text, citations);

              // Two-model LLM extraction + sentiment cross-check run in parallel
              // — both hit classify-tier endpoints, no shared state. Sentiment is
              // skipped (resolves to null) when the brand wasn't mentioned, saving
              // ~$0.0008 per non-mention cell.
              //   extraction.verified  = both models agreed (strong signal)
              //   extraction.unverified = only one model agreed (weaker — dashed badge)
              //
              // Replay mode (1.1.1): extractor + sentiment are LIVE classify-tier
              // calls — they hit OpenAI + Gemini even when the main provider.call
              // was served from cache. Under `--network none` (Docker, air-gapped
              // CI) they retry DNS failures as transient and hang for the full
              // retry budget. Mirror the discovery-skip pattern from 1.1.0: when
              // replay is active, short-circuit to empty shapes that the
              // downstream code already handles (verified/unverified arrays both
              // empty → `storeSources` is false → no source-list bloat;
              // sentiment=null is already guarded everywhere it's read).
              let extraction, sentiment;
              if (replaySrcDate) {
                extraction = {
                  verified: [],
                  unverified: [],
                  sources: {
                    primary:   { model: '', brands: [] },
                    secondary: { model: '', brands: [] },
                  },
                  costInfo: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
                };
                sentiment = null;
              } else {
                const sentimentTask = (mention === 'yes' || mention === 'src')
                  ? classifySentimentWithTwoModels({
                      text, brand, domain,
                      primary: extractionProviders.primary,
                      secondary: extractionProviders.secondary,
                    })
                  : Promise.resolve(null);
                [extraction, sentiment] = await Promise.all([
                  extractWithTwoModels({
                    text, brand, domain,
                    category: config.category || '',
                    primary: extractionProviders.primary,
                    secondary: extractionProviders.secondary,
                  }),
                  sentimentTask,
                ]);
              }
              const competitors = extraction.verified;
              const competitorsUnverified = extraction.unverified;
              const canonicalCitations = [...new Set(citations)];
              // Categorise the response so the UI can distinguish "engine refused / returned nothing"
              // from "engine wrote prose but no extractable list". The extraction union (verified +
              // unverified) is the full set of names either model saw — best signal for quality.
              const responseQuality = classifyResponseQuality({
                text, citations,
                competitors: [...competitors, ...competitorsUnverified],
              });

              const usage = extractUsage(provider.name, raw);
              let costInfo = calcCost(cellModel, usage) || { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: 0 };
              // Replay mode (see replay-mode block at top of file)
              if (replayed) costInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
              // End replay

              // Extraction cost for this cell — tracked separately so we can report it
              // aggregated at the bottom instead of per-cell.
              extractionCostTotal.inputTokens  += extraction.costInfo.inputTokens  || 0;
              extractionCostTotal.outputTokens += extraction.costInfo.outputTokens || 0;
              extractionCostTotal.costUsd      += extraction.costInfo.costUsd      || 0;
              if (sentiment && sentiment.costInfo) {
                extractionCostTotal.inputTokens  += sentiment.costInfo.inputTokens  || 0;
                extractionCostTotal.outputTokens += sentiment.costInfo.outputTokens || 0;
                extractionCostTotal.costUsd      += sentiment.costInfo.costUsd      || 0;
              }

              // Store per-model extractionSources ONLY when the two models disagreed
              // (something landed in the unverified tier). On unanimous agreement both
              // source-lists equal `competitors`, so storing them is redundant and bloats
              // the summary JSON ~3× across a year of weekly snapshots.
              const storeSources = competitorsUnverified.length > 0
                || !!extraction.sources.primary?.error
                || !!extraction.sources.secondary?.error;
              results.push({
                query: `Q${qi + 1}`,
                queryText: baseQuery,
                provider: provider.name,
                label: provider.label,
                model: cellModel,
                mode,                              // 'web' | 'training'
                mention,
                position,
                citationCount: citations.length,
                canonicalCitations,
                competitors,
                competitorsUnverified,
                ...(storeSources ? { extractionSources: extraction.sources } : {}),
                ...(sentiment ? { sentiment: { label: sentiment.label, confidence: sentiment.confidence, rationale: sentiment.rationale } } : {}),
                ...(queryTags[qi] ? { tag: queryTags[qi] } : {}),
                ...(region ? { region: region.code, regionLabel: region.label } : {}),
                ...(adSignal.hasAdSignal ? { adMarkers: adSignal.adMarkers, adNetworkCitations: adSignal.adNetworkCitations } : {}),
                responseQuality,
                hasBrandInCitations: citations.some(u =>
                  u.toLowerCase().includes(domain.toLowerCase())
                ),
                responseExcerpt: String(text || '').slice(0, 1500),
                elapsedMs,
                inputTokens: costInfo.inputTokens,
                outputTokens: costInfo.outputTokens,
                costUsd: costInfo.costUsd,
              });
              const icon = mention === 'yes' ? `${c.green}YES` : mention === 'src' ? `${c.yellow}SRC` : `${c.red}NO`;
              const costStr = costInfo.costUsd > 0 ? ` $${costInfo.costUsd.toFixed(4)}` : '';
              // Replay mode (see replay-mode block at top of file)
              const replayTag = replayed ? ` ${c.yellow}[replay]${c.reset}` : '';
              // End replay
              if (live) {
                const plainIcon = mention === 'yes' ? 'YES' : mention === 'src' ? 'SRC' : 'NO';
                live.finish(taskId, {
                  status: 'done',
                  detail: `${plainIcon}${replayed ? ' [replay]' : ''} (${citations.length} citations, ${elapsedMs}ms${costStr})`,
                });
              }
              // --json mode (live === null): silent — result already pushed to
              // results[] above. Consumer parses JSON from stdout, no human text.
            } catch (err) {
              const elapsedMs = Date.now() - t0;
              // For model-deprecated errors, append an inline hint to the ERR
              // line — re-run init is the only fix, no point in retrying.
              const cls = classifyProviderError(err);
              if (live) {
                live.finish(taskId, {
                  status: 'error',
                  detail: `${errMsg(err)}${cls.category === 'model-deprecated' ? ' — re-run `aeo-platform init`' : ''}`,
                });
              }
              // --json mode: error is captured in results[].mention='error' below.
              results.push({
                query: `Q${qi + 1}`, queryText: baseQuery,
                provider: provider.name, label: provider.label,
                model: cellModel, mode, mention: 'error',
                position: null, citationCount: 0,
                canonicalCitations: [],
                competitors: [],
                ...(region ? { region: region.code, regionLabel: region.label } : {}),
                elapsedMs,
                error: errMsg(err),
              });
            }
          };  // end of taskFn

          // Estimated token cost — fed into planSchedule so each (provider, model)
          // bucket can size its 60s windows. Pulled from the same ledger that the
          // ledger-throttle uses, so estimates and reservations agree.
          const est = estimatePerRequest(cdKey);
          if (!tasksByCdKey.has(cdKey)) tasksByCdKey.set(cdKey, []);
          tasksByCdKey.get(cdKey).push({ fn: taskFn, estimatedTokens: est });
        }
      }
    }
  }

  // Per-(provider, model) scheduling: each cdKey gets its own pacing plan,
  // sized by the learned-or-tier limit. Buckets run in parallel since their
  // TPM windows are independent (cross-provider AND cross-model).
  //
  // Pre-compute schedules so we can print all pacing lines BEFORE live.start().
  // If we wrote them inside the map below, the writes would race with live
  // render frames (live starts before Promise.all awaits the map's promises).
  const cdKeySchedules = [...tasksByCdKey.entries()].map(([cdKey, taskMetas]) => {
    const [provName, modelId] = cdKey.split(':');
    const limit = getLearnedOrTierLimit(provName, modelId);
    const schedule = planSchedule(taskMetas, limit);
    return { cdKey, taskMetas, schedule };
  });
  if (!options.json) {
    for (const { cdKey, taskMetas, schedule } of cdKeySchedules) {
      const lastWindow = schedule[schedule.length - 1]?.fireAt || 0;
      if (lastWindow === 0) continue;
      // Real wall-clock ETA = lastWindow + ~5s for the final call to round-trip.
      const etaSec = Math.round(lastWindow / 1000) + 5;
      process.stderr.write(
        `  ${c.dim}Pacing ${taskMetas.length} ${cdKey} ${taskMetas.length === 1 ? 'task' : 'tasks'} across ~${etaSec}s${c.reset}\n`,
      );
    }
  }

  // 1.0.7: surface the abort hint above the live region. Operator now knows
  // the process is interruptible — and what `60s remaining` countdowns mean.
  const totalCells = cdKeySchedules.reduce((sum, c) => sum + c.taskMetas.length, 0);
  const distinctProviders = new Set(cdKeySchedules.map(c => c.cdKey.split(':')[0])).size;
  live?.start(`(running ${totalCells} ${totalCells === 1 ? 'cell' : 'cells'} across ${distinctProviders} ${distinctProviders === 1 ? 'provider' : 'providers'} — press Ctrl+C to abort cleanly)`);
  try {
    const schedulingPromises = cdKeySchedules.map(({ taskMetas, schedule }) =>
      runScheduled(taskMetas.map(t => t.fn), schedule),
    );
    await Promise.all(schedulingPromises);
  } finally {
    // Always restore terminal state — even if a task throws (Promise.all rejects),
    // we MUST stop the animation timer, restore the cursor, flush log buffer,
    // and deregister signal handlers. Otherwise the terminal is left broken
    // (hidden cursor, half-drawn rows) for the user's next shell prompt.
    live?.stop();
  }

  // Merge newly-run results with successful results carried over from prior run today
  if (existingSummary) {
    const keptOld = (existingSummary.results || []).filter(r => r.mention !== 'error');
    results.push(...keptOld);
  }

  // ─── Summary ───
  const total = results.filter(r => r.mention !== 'error').length;
  const mentions = results.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  const score = total > 0 ? Math.round((mentions / total) * 100) : 0;
  const errors = results.filter(r => r.mention === 'error').length;

  console.log(`\n${c.bold}${'═'.repeat(60)}${c.reset}`);
  console.log(`${c.bold}  AEO VISIBILITY REPORT — ${brand}${c.reset}`);
  console.log(`${c.bold}${'═'.repeat(60)}${c.reset}\n`);

  // Per-query table
  const colW = 16;
  console.log(`${c.bold}  Query                                      ${activeProviders.map(p => p.colLabel.slice(0, colW - 1).padEnd(colW)).join('')}${c.reset}`);
  console.log(`  ${'─'.repeat(44)}${activeProviders.map(() => '─'.repeat(colW)).join('')}`);

  for (let qi = 0; qi < queries.length; qi++) {
    const label = `Q${qi + 1}: ${queries[qi].slice(0, 40)}`;
    const cells = activeProviders.map(p => {
      const r = results.find(r => r.query === `Q${qi + 1}` && r.provider === p.name && r.model === p.model);
      if (!r) return c.dim + 'skip'.padEnd(colW) + c.reset;
      if (r.mention === 'yes') return c.green + c.bold + 'YES'.padEnd(colW) + c.reset;
      if (r.mention === 'src') return c.yellow + 'SRC'.padEnd(colW) + c.reset;
      if (r.mention === 'error') return c.red + 'ERR'.padEnd(colW) + c.reset;
      return c.red + 'no'.padEnd(colW) + c.reset;
    });
    console.log(`  ${label.padEnd(44)}${cells.join('')}`);
  }

  console.log(`\n${c.bold}  Score: ${score}%${c.reset} (${mentions}/${total} checks returned a mention)`);
  if (errors > 0) console.log(`  ${c.yellow}${errors} checks failed (API errors)${c.reset}`);

  // Aggregate per-cell LLM-extracted brand lists. Both models agreed → r.competitors
  // (strong). Only one agreed → r.competitorsUnverified (weaker, dashed badge).
  // No aggregate classifier step needed — filtering happened at extract time.
  const verifiedCounts = {};
  const unverifiedCounts = {};
  for (const r of results) {
    for (const name of r.competitors || [])            verifiedCounts[name]   = (verifiedCounts[name]   || 0) + 1;
    for (const name of r.competitorsUnverified || [])  unverifiedCounts[name] = (unverifiedCounts[name] || 0) + 1;
  }
  const classifiedCompetitors = Object.entries(verifiedCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Unverified entries that were never verified in ANY cell — surfaced separately
  // in stdout and stored in summary for audit.
  const verifiedSet = new Set(Object.keys(verifiedCounts));
  const unverifiedOnlyEntries = Object.entries(unverifiedCounts)
    .filter(([name]) => !verifiedSet.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const classificationCostInfo = extractionCostTotal.costUsd > 0 ? {
    provider: [extractionProviders.primary.name, extractionProviders.secondary?.name].filter(Boolean).join('+'),
    model:    [extractionProviders.primary.model, extractionProviders.secondary?.model].filter(Boolean).join('+'),
    label:    'competitor-extraction',
    requests: results.length * (extractionProviders.secondary ? 2 : 1),
    inputTokens:  extractionCostTotal.inputTokens,
    outputTokens: extractionCostTotal.outputTokens,
    costUsd:      extractionCostTotal.costUsd,
  } : null;
  console.log(`${c.dim}  Extraction: ${extractionProviders.secondary
    ? `${Object.keys(verifiedCounts).length} brands verified (both models), ${unverifiedOnlyEntries.length} unverified (one model only)`
    : `${unverifiedOnlyEntries.length} competitor name(s) found — single-key mode, all unverified (no second model to cross-check)`} — $${extractionCostTotal.costUsd.toFixed(4)}${c.reset}`);

  if (classifiedCompetitors.length > 0) {
    console.log(`\n${c.bold}  Top competitors mentioned instead:${c.reset}`);
    for (const [name, count] of classifiedCompetitors) {
      console.log(`    ${c.cyan}${name}${c.reset} (${count} checks)`);
    }
  }

  // Audit log: unverified-only names (exactly one model found them). Useful for
  // spotting model disagreements — if a known brand keeps landing here, one of the
  // extractor models has a systematic blind spot worth investigating.
  if (unverifiedOnlyEntries.length > 0) {
    console.log(`\n${c.dim}  Unverified (${extractionProviders.secondary ? 'only one of two models found' : 'single-key mode — no cross-check available'}):${c.reset}`);
    for (const { name, count } of unverifiedOnlyEntries.slice(0, 10)) {
      console.log(`    ${c.dim}- ${name}  (${count} cell${count !== 1 ? 's' : ''})${c.reset}`);
    }
    if (unverifiedOnlyEntries.length > 10) {
      console.log(`    ${c.dim}(+ ${unverifiedOnlyEntries.length - 10} more — see _summary.json)${c.reset}`);
    }
  }

  // Canonical sources (URLs AI engines keep citing for our vertical)
  const sourceMap = {};
  for (const r of results) {
    for (const url of (r.canonicalCitations || [])) {
      sourceMap[url] = (sourceMap[url] || 0) + 1;
    }
  }
  const topCanonicalSources = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([url, count]) => ({ url, count }));

  // Domain-level share-of-voice aggregation. Groups all URLs by hostname so
  // the report can show "G2 captures 19% of citations" (OneGlanse-style table)
  // — domain share is what matters for outreach planning, not individual URLs.
  const topDomains = computeTopDomains(results, 10);

  if (topCanonicalSources.length > 0) {
    console.log(`\n${c.bold}  Top canonical sources (pages AI cites for your vertical):${c.reset}`);
    for (const { url, count } of topCanonicalSources.slice(0, 5)) {
      const short = url.length > 80 ? url.slice(0, 77) + '...' : url;
      console.log(`    ${c.dim}${count}×${c.reset} ${short}`);
    }
    if (topCanonicalSources.length > 5) {
      console.log(`    ${c.dim}(${topCanonicalSources.length - 5} more in _summary.json)${c.reset}`);
    }
  }

  console.log(`\n${c.dim}  Raw responses saved to: ${responseDir}/${c.reset}`);
  console.log(`${c.dim}  Run weekly for trends. Full methodology: webappski.com/blog/aeo-visibility-challenge-week-1${c.reset}\n`);

  const regressionThreshold = typeof config.regressionThreshold === 'number' ? config.regressionThreshold : 10;

  // Session cost breakdown
  const costMap = {};
  for (const r of results) {
    if (!r.costUsd) continue;
    const key = `${r.provider}/${r.model}`;
    if (!costMap[key]) costMap[key] = { provider: r.provider, model: r.model, label: r.label || r.provider, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    costMap[key].requests++;
    costMap[key].inputTokens  += r.inputTokens  || 0;
    costMap[key].outputTokens += r.outputTokens || 0;
    costMap[key].costUsd      += r.costUsd      || 0;
  }
  const costByModel = Object.values(costMap);
  if (classificationCostInfo) costByModel.push(classificationCostInfo);
  const sessionCostUsd = Math.round(costByModel.reduce((s, v) => s + v.costUsd, 0) * 1_000_000) / 1_000_000;

  if (sessionCostUsd > 0) {
    console.log(`\n${c.bold}  Session cost: $${sessionCostUsd.toFixed(4)}${c.reset}`);
    for (const m of costByModel) {
      console.log(`    ${c.dim}${m.model}${c.reset}  ${m.inputTokens + m.outputTokens} tok  $${m.costUsd.toFixed(4)}`);
    }
  }

  // Save summary JSON
  const summary = {
    date,
    brand,
    domain,
    score,
    mentions,
    total,
    errors,
    regressionThreshold,
    sessionCostUsd,
    costByModel,
    // single-key mode marker (1.1.8) — the report renderer needs it to phrase
    // «unverified» honestly (no second model ≠ model disagreement).
    extractorMode: extractionProviders.secondary ? 'dual' : 'single',
    results: results.map(({ raw, ...r }) => r),
    topCompetitors: classifiedCompetitors.map(([name, count]) => ({ name, count })),
    // Unverified-only tier: names where only one of the two extractor models agreed.
    // Aggregated here for audit logs / dashboards — per-cell info is in results[].competitorsUnverified.
    unverifiedOnly: unverifiedOnlyEntries,
    topCanonicalSources,
    topDomains,
    adsDetected: summariseAdsAcrossResults(results),
    // Track when we last ran a training-data baseline so `--depth=auto`
    // can prompt the user when the corpus signal is stale (>14 days).
    ...(depth === 'full' ? { lastFullRun: date } : {}),
  };
  // Atomic — a Ctrl+C mid-write must never leave a half-written summary that
  // silently corrupts the next run/report/diff (AP-FAIL-BRANCHES).
  await atomicWriteJson(join(responseDir, '_summary.json'), summary);

  // ─── Exit code decision ───
  // 0 = score stable or improved
  // 1 = score dropped more than regressionThreshold (default 10pp)
  // 2 = all checks returned zero mentions
  // 3 = all providers errored
  let previousScore = null;
  try {
    const { readdirSync } = await import('node:fs');
    const allDates = readdirSync('aeo-responses')
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
      .sort();
    const prevDate = allDates[allDates.length - 1];
    if (prevDate) {
      const prev = JSON.parse(await readFile(join('aeo-responses', prevDate, '_summary.json'), 'utf-8'));
      if (typeof prev.score === 'number') previousScore = prev.score;
    }
  } catch {
    // no previous data — first run
  }

  let exitCode;
  if (results.length > 0 && errors === results.length) {
    exitCode = 3;
  } else if (mentions === 0) {
    exitCode = 2;
  } else if (previousScore !== null && score - previousScore < -regressionThreshold) {
    exitCode = 1;
  } else {
    exitCode = 0;
  }

  // Exit code 3: every engine returned mention === 'error'. Show the
  // actionable panel so the user has copy-pastable fixes instead of exiting
  // silently with just a non-zero status code. Skipped in --json mode
  // because JSON consumers parse stdout programmatically — the exitCode +
  // per-result .error fields in the JSON already tell them everything.
  if (exitCode === 3 && !silent) {
    const errorResults = results.filter(r => r.mention === 'error');
    for (const line of formatAllEnginesFailedPanel({
      errorResults,
      providerConfig: config.providers || {},
      useColor: USE_COLOR,
    })) {
      console.error(line);
    }
  }

  if (silent) {
    console.log = origLog;
    process.stdout.write = origWrite;
    const jsonOut = {
      ...summary,
      exitCode,
      previousScore,
      scoreDelta: previousScore !== null ? score - previousScore : null,
    };
    origWrite(JSON.stringify(jsonOut, null, 2) + '\n');
  } else if (exitCode !== 3) {
    // Next-step hint. Mirrors init's "Next: aeo-platform run" convention.
    // Skipped on exitCode 3 (all engines errored — no data to report) and in
    // --json mode (programmatic consumers parse the JSON only).
    console.log(`\nNext: ${c.cyan}aeo-platform report --html${c.reset}  ${c.dim}(or 'aeo-platform report' for markdown-only)${c.reset}\n`);
  }

  process.exit(exitCode);
}


// ─── HTML report helpers ───


function buildHtmlSummary(snapshots, rawResponses) {
  const latest = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const brand = latest.brand || '';
  const domain = latest.domain || '';

  // Unique, ordered query list (Q1…Qn from the latest run)
  const queryOrder = [];
  for (const r of latest.results) {
    if (!queryOrder.find(q => q.id === r.query)) {
      queryOrder.push({ id: r.query, text: r.queryText || r.query });
    }
  }

  // Unique engines, one column per provider (deduplicated by provider only)
  const engineList = [];
  for (const r of latest.results) {
    if (!engineList.find(e => e.provider === r.provider)) {
      engineList.push({ provider: r.provider, label: r.label || r.provider, model: r.model || '' });
    }
  }

  // Bare host form for matching citation URLs against the brand's own domain.
  // Strip protocol / www. / trailing slash so "https://www.foo.com/" and
  // "foo.com" both match a citation URL containing "foo.com".
  const ownDomainBare = (domain || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const isOwnDomainCite = (u) =>
    typeof u === 'string' && ownDomainBare && u.toLowerCase().includes(ownDomainBare);

  // Per-engine visibility + delta + tiny trend series (per provider+model)
  const engines = engineList.map(en => {
    const rows = latest.results.filter(r => r.provider === en.provider && r.model === en.model);
    const hits = rows.filter(r => r.mention === 'yes' || r.mention === 'src').length;
    const total = rows.length;
    const pct = total ? Math.round((hits / total) * 100) : 0;
    // v0.5 — citations to OWN domain only (used by hero copy + engine cards
    // that say "cited YOU N times"). r.citationCount is total-cited-anywhere
    // and would lie when AI cited only competitor pages.
    const citations = rows.reduce((s, r) => s + (r.citations || []).filter(isOwnDomainCite).length, 0);
    const cells = queryOrder.map(q => {
      const c = rows.find(r => r.query === q.id);
      if (!c) return 'missing';
      if (c.mention === 'error' && c.error) return { status: 'error', message: c.error };
      return c.mention;
    });
    const series = snapshots.map(s => {
      const er = (s.results || []).filter(r => r.provider === en.provider && r.model === en.model);
      const h = er.filter(r => r.mention === 'yes' || r.mention === 'src').length;
      return er.length ? Math.round((h / er.length) * 100) : 0;
    });
    const prevPct = prev ? (function () {
      const pr = (prev.results || []).filter(r => r.provider === en.provider && r.model === en.model);
      const h = pr.filter(r => r.mention === 'yes' || r.mention === 'src').length;
      return pr.length ? Math.round((h / pr.length) * 100) : null;
    })() : null;
    const delta = prevPct == null ? null : pct - prevPct;
    return {
      provider: en.provider, model: en.model,
      label: en.label, kind: en.model,
      cells, pct, hits, total, citations, delta, series,
    };
  });

  // Coverage buckets for the hero mini-bar
  const coverage = latest.results.reduce((acc, r) => {
    acc.total += 1;
    if (r.mention === 'yes')        acc.yes += 1;
    else if (r.mention === 'src')   acc.src += 1;
    else if (r.mention === 'error') acc.error += 1;
    else                            acc.no += 1;
    return acc;
  }, { yes: 0, src: 0, no: 0, error: 0, total: 0 });

  // Competitors
  const compList = latest.topCompetitors || [];
  const competitors = [
    { name: domain, count: coverage.yes + coverage.src, accent: true },
    ...compList.map(c => ({ name: c.name, count: c.count })),
  ];

  // Canonical sources — flag rows whose host matches our domain
  const sources = (latest.topCanonicalSources || []).slice(0, 10).map(s => ({
    url: s.url,
    count: s.count,
    accent: s.url.toLowerCase().includes(domain.toLowerCase()),
  }));

  const actions = latest.llmActions || [];

  // Per-cell verified/unverified brands come straight from the two-model LLM extractor:
  //   r.competitors            — both models agreed (strong signal, solid badge)
  //   r.competitorsUnverified  — only one model agreed (weaker signal, dashed badge)
  // Legacy summaries (pre-two-model extractor) had a single "competitors" list —
  // those still render, just without the unverified tier.
  const positionMatrix = queryOrder.map(q => {
    const columns = engineList.map(en => {
      const r = latest.results.find(x => x.query === q.id && x.provider === en.provider);
      const verifiedCells  = (r?.competitors           || []).map(name => ({ name, unverified: false }));
      const unverifiedCells = (r?.competitorsUnverified || []).map(name => ({ name, unverified: true  }));
      return {
        provider: en.provider,
        label: en.label,
        mention: r?.mention ?? 'missing',
        position: r?.position ?? null,
        sentiment: r?.sentiment ?? null,
        competitors: [...verifiedCells, ...unverifiedCells].slice(0, 4),
        // Total citations the engine returned for this cell — useful in
        // mention='no' cells to communicate "engine answered with N sources,
        // none of which named you" instead of a bare dash.
        citationCount: r?.citationCount ?? 0,
        responseExcerpt: r?.responseExcerpt ?? null,
        responseQuality: r?.responseQuality ?? null,
        // Surface the underlying provider error message for cells that errored.
        // Used by the matrix view to attach a tooltip instead of blending the
        // err state into the empty-cell visual.
        errorMessage: r?.error ?? null,
      };
    });
    return { query: q.text, columns };
  });

  // Cost data from latest run
  const costBreakdown = latest.costByModel || [];
  const sessionCostUsd = latest.sessionCostUsd || 0;
  const costTrend = snapshots.map(s => Math.round((s.sessionCostUsd || 0) * 10000) / 10000);
  const totalCostUsd = Math.round(costTrend.reduce((s, v) => s + v, 0) * 1_000_000) / 1_000_000;

  // v0.5 — citation count to OWN domain this run + delta vs prev run.
  // Hero KPI ("cited you N times") needs own-domain only; the raw r.citationCount
  // counts citations to any URL (competitors, sources) and would inflate the
  // headline by mixing "they cited goforgeai.com" into "they cited you".
  const totalCitations = latest.results.reduce((s, r) => s + (r.citations || []).filter(isOwnDomainCite).length, 0);
  const totalCitationsPrev = prev ? (function () {
    const prevDomainBare = (prev.domain || domain || '').toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    return prev.results.reduce((s, r) => s + (r.citations || []).filter(u =>
      typeof u === 'string' && prevDomainBare && u.toLowerCase().includes(prevDomainBare)
    ).length, 0);
  })() : null;

  // v0.5 — region count for the diagnostics tile.
  // Multi-region runs (--geo) tag each result with `region`; single-region default → 1.
  const regions = [...new Set(latest.results.map(r => r.region).filter(Boolean))];
  const regionCount = regions.length || 1;

  // v0.5 — pass-through of latest-snapshot enrichment fields (computed during run / report).
  // Pre-derived in /run + /report so the renderer doesn't need to re-compute or re-fetch.
  return {
    meta: {
      brand, domain,
      date: latest.date,
      prevDate: prev?.date || null,
      runId: `run_${latest.date.replace(/-/g, '').slice(-6)}`,
      queryCount: queryOrder.length,
      providerCount: engineList.length,
    },
    score: latest.score,
    scorePrev: prev?.score ?? null,
    coverage,
    trend: snapshots.map(s => s.score),
    trendDates: snapshots.map(s => s.date),
    queries: queryOrder.map(q => q.text),
    queryTexts: queryOrder.map(q => q.text), // alias for renderers that prefer the longer name
    engines,
    competitors,
    sources,
    positionMatrix,
    totalCitations,
    totalCitationsPrev,
    regionCount,
    regions,
    sessionCostUsd,
    totalCostUsd,
    costBreakdown,
    costTrend,
    quotes: [],
    citationOnly: [],
    actions,
    // Pass-through fields (already cached in _summary.json by /run + /report).
    // Backwards-compat: snapshots from v0.2.x and earlier didn't pre-compute
    // topDomains during run. Derive from canonicalCitations on the fly so
    // Section 04 (Domain share-of-voice) renders for legacy data.
    topDomains:        (latest.topDomains && latest.topDomains.length > 0)
      ? latest.topDomains
      : computeTopDomains(latest.results || [], 10),
    topCanonicalSources: latest.topCanonicalSources || [],
    crawlability:      latest.crawlability || null,
    authorityPresence: latest.authorityPresence || null,
    adsDetected:       latest.adsDetected || null,
    outreachTemplates: latest.outreachTemplates || [],
    citationClassification: latest.citationClassification || null,
    // Raw cell data, used for per-cell sentiment overlay in the matrix sub-toggle.
    cells: latest.results.map(r => ({
      query: r.query,
      provider: r.provider,
      mention: r.mention,
      position: r.position,
      sentiment: r.sentiment || null,
      citationCount: r.citationCount || 0,
      region: r.region || null,
    })),
  };
}

// ─── Commands (report) ───

async function cmdReport(args = {}) {
  // Lazy-load report-only modules so `--help` / `--version` / `init` / `run`
  // don't pay their import cost. See top-of-file comment about cold-start.
  const [
    { generateOutreachTemplates },
    { auditCrawlability },
    { checkAuthorityPresence },
    { checkPageSignals },
    { checkEntityGraph },
    { classifyCompetitorPricing },
    { checkRegionContext },
    { checkResponseFreshness },
  ] = await Promise.all([
    import('../lib/report/outreach-templates.js'),
    import('../lib/report/crawlability-audit.js'),
    import('../lib/report/authority-presence.js'),
    import('../lib/report/page-signals.js'),
    import('../lib/report/entity-graph.js'),
    import('../lib/report/competitor-pricing.js'),
    import('../lib/report/region-context.js'),
    import('../lib/report/response-freshness.js'),
  ]);

  const { readdirSync } = await import('node:fs');
  const responsesDir = 'aeo-responses';

  if (!existsSync(responsesDir)) {
    console.error(`${c.red}No aeo-responses/ directory found. Run: aeo-platform run${c.reset}`);
    process.exit(1);
  }

  const dates = readdirSync(responsesDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  const snapshots = [];
  for (const date of dates) {
    const p = join(responsesDir, date, '_summary.json');
    if (existsSync(p)) snapshots.push(JSON.parse(await readFile(p, 'utf-8')));
  }

  if (snapshots.length === 0) {
    console.error(`${c.red}No _summary.json files found in aeo-responses/. Run: aeo-platform run${c.reset}`);
    process.exit(1);
  }

  const latest = snapshots[snapshots.length - 1];

  // ─── Refresh-cache (--refresh-cache <csv|all>) ───
  // Invalidate cached fields BEFORE the cache-or-fetch blocks below so
  // they refetch fresh data instead of reading stale data from
  // _summary.json. Without this flag, fields like pageSignals /
  // authorityPresence persist across report runs — efficient for
  // iteration but stale when the client's site changes.
  //
  // Usage: aeo-platform report --refresh-cache=pageSignals,authorityPresence
  //        aeo-platform report --refresh-cache=all
  const REFRESHABLE_FIELDS = [
    'pageSignals',          // own-domain H1/H2/schema-org crawl
    'authorityPresence',    // wikipedia/reddit/github
    'crawlability',         // robots.txt/llms.txt/sitemap audit
    'citationClassification', // LLM-classified citation domains
    'outreachTemplates',    // LLM-generated pitch templates
    'entityGraph',          // sameAs reciprocity check
    'competitorPricing',    // LLM-classified competitor pricing tiers
    'llmActions',           // LLM-generated recommended actions
    'adsDetected',          // sponsored-content scan
  ];
  if (args.refreshCache) {
    const requested = String(args.refreshCache)
      .split(',').map(s => s.trim()).filter(Boolean);
    const expand = (f) => f === 'all' ? REFRESHABLE_FIELDS.slice() : [f];
    const expanded = requested.flatMap(expand);
    const unknown = expanded.filter(f => !REFRESHABLE_FIELDS.includes(f));
    if (unknown.length > 0) {
      console.error(`${c.red}Unknown --refresh-cache fields: ${unknown.join(', ')}${c.reset}`);
      console.error(`Valid fields: ${REFRESHABLE_FIELDS.join(', ')}, or "all"`);
      process.exit(1);
    }
    const cleared = [];
    for (const f of expanded) {
      if (latest[f] !== undefined) {
        delete latest[f];
        cleared.push(f);
      }
    }
    if (cleared.length > 0) {
      await persistSnapshot(latest);
      console.log(`  ${c.dim}Cache invalidated: ${cleared.join(', ')}${c.reset}`);
    } else {
      console.log(`  ${c.dim}--refresh-cache: nothing to clear (none of the requested fields was cached)${c.reset}`);
    }
  }

  const rawResponses = {};
  for (const r of latest.results) {
    const qi = String(r.query).replace(/^Q/, '');
    const key = `${r.query}|${r.provider}`;
    try {
      if (r.source === 'manual-paste') {
        const txtPath = join(responsesDir, latest.date, `q${qi}-${r.provider}-manual.txt`);
        if (existsSync(txtPath)) rawResponses[key] = await readFile(txtPath, 'utf-8');
      } else {
        const jsonPath = join(responsesDir, latest.date, `q${qi}-${r.provider}.json`);
        if (existsSync(jsonPath)) {
          const raw = JSON.parse(await readFile(jsonPath, 'utf-8'));
          rawResponses[key] = parseRawResponse(r.provider, raw);
        }
      }
    } catch {
      // raw missing or malformed — skip; sections degrade gracefully
    }
  }

  // ─── Wave 1: independent blocks run in parallel ───────────────────────
  // Citation classification (LLM) | LLM actions (LLM) | Page signals (HTTP)
  // | Crawlability (HTTP) | Entity graph (HTTP) | Competitor pricing (heuristic).
  // Authority presence is the only dependency — it reads pageSignals — so it
  // runs sequentially after this wave. Each task has its own try/catch so a
  // single failure doesn't cancel the others. Logs may interleave (each line
  // carries its own block-prefix marker, so output stays readable).
  await Promise.all([
    // ─── Citation classification (LLM-based, cached) ───
    // Classify top cited domains against brand's category. Universal — works for any
    // language or country. Result cached in _summary.json; costs $0 on subsequent runs.
    (async () => {
      if (!latest.citationClassification && (latest.topCanonicalSources || []).length > 0) {
        let cfg = {};
        let cfgReadError = null;
        try {
          cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
        } catch (err) {
          cfgReadError = err;
        }

        const brand = latest.brand || cfg.brand || '';
        const category = cfg.category || '';
        const providersCfg = { ...DEFAULT_CONFIG.providers, ...(cfg.providers || {}) };

        if (cfgReadError) {
          console.log(`  ${c.dim}Citation classification skipped: could not read ${CONFIG_FILE} (${errMsg(cfgReadError)})${c.reset}`);
        } else if (!category) {
          console.log(`  ${c.dim}Citation classification skipped: no category in ${CONFIG_FILE}. Re-run: aeo-platform init${c.reset}`);
        } else {
          // Pick first provider with an available API key
          const providerEntry = Object.entries(providersCfg).find(([, p]) => process.env[p.env]);

          if (!providerEntry) {
            console.log(`  ${c.dim}Citation classification skipped: no API key found in environment${c.reset}`);
          } else {
            const [providerKey, providerCfg] = providerEntry;
            const providerCall = PROVIDERS[providerKey]?.call;
            if (providerCall) {
              console.log(`  ${c.dim}Classifying citations via ${PROVIDERS[providerKey].label}...${c.reset}`);
              try {
                const classification = await classifyCitations({
                  brand, category,
                  topCanonicalSources: latest.topCanonicalSources,
                  providerCall,
                  apiKey: process.env[providerCfg.env],
                  model: providerCfg.model,
                });
                latest.citationClassification = classification;
                await persistSnapshot(latest);
                const off = classification.offCategoryDomains.length;
                if (off > 0) {
                  console.log(`  ${c.yellow}${SYM.warn} ${off} cited domain${off !== 1 ? 's' : ''} classified as off-category${c.reset}`);
                } else {
                  console.log(`  ${c.green}${SYM.ok} All cited domains match brand category${c.reset}`);
                }
              } catch (err) {
                console.log(`  ${c.dim}Citation classification skipped: ${errMsg(err)}${c.reset}`);
                if (process.env.DEBUG) console.error(err.stack);
              }
            }
          }
        }
      } else if (latest.citationClassification) {
        console.log(`  ${c.dim}Citation classification loaded from cache${c.reset}`);
      }
    })(),

    // ─── LLM action recommendations (cached) ───
    (async () => {
      if (!latest.llmActions) {
        let cfg = {};
        try { cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8')); } catch { /* skip */ }
        const category = cfg.category || '';
        const providersCfg = { ...DEFAULT_CONFIG.providers, ...(cfg.providers || {}) };
        const providerEntry = Object.entries(providersCfg).find(([, p]) => process.env[p.env]);
        if (providerEntry && category) {
          const [providerKey, providerCfg] = providerEntry;
          const providerCall = PROVIDERS[providerKey]?.call;
          if (providerCall) {
            const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
            console.log(`  ${c.dim}Generating recommendations via ${PROVIDERS[providerKey].label}...${c.reset}`);
            try {
              const { actions, costInfo } = await deriveActionsWithLLM(latest, prev, category, {
                providerName: providerKey,
                providerCall,
                apiKey: process.env[providerCfg.env],
                // LLM actions = generation task → use the user's flagship model.
                model: providerCfg.model,
              });
              latest.llmActions = actions;
              if (!latest.costByModel) latest.costByModel = [];
              latest.costByModel.push(costInfo);
              latest.sessionCostUsd = Math.round(
                (latest.costByModel.reduce((s, v) => s + (v.costUsd || 0), 0)) * 1_000_000
              ) / 1_000_000;
              await persistSnapshot(latest);
              console.log(`  ${c.green}${SYM.ok} ${actions.length} recommendations generated${c.reset}`);
            } catch (err) {
              console.log(`  ${c.yellow}${SYM.warn} Recommendations skipped: ${errMsg(err)}${c.reset}`);
            }
          }
        }
      } else {
        console.log(`  ${c.dim}Recommendations loaded from cache${c.reset}`);
      }
    })(),

    // ─── v1.1: Page signals (own-domain HTML crawl, cached) ───
    // Surfaces H1/H2 patterns, answer-capsule coverage, Schema.org block
    // count + types, FAQ count. Pure HTTP fetch, no LLM cost.
    // Authority presence (Wave 2 below) reads latest.pageSignals.
    (async () => {
      if (!latest.pageSignals && latest.domain && !args.noPageSignals) {
        console.log(`  ${c.dim}Crawling own-domain page signals (${latest.domain})...${c.reset}`);
        try {
          latest.pageSignals = await checkPageSignals(latest.domain);
          await persistSnapshot(latest);
          const ps = latest.pageSignals.homepage;
          if (ps?.ok) {
            console.log(`  ${c.green}${SYM.ok}${c.reset} h1:${ps.headings.h1.count} h2:${ps.headings.h2.count} capsules:${ps.answerCapsules.coverage}% schemas:${ps.schemaOrg.blockCount}`);
          } else {
            console.log(`  ${c.yellow}${SYM.warn} Page signals: ${ps?.error || 'unavailable'}${c.reset}`);
          }
        } catch (err) {
          console.log(`  ${c.yellow}${SYM.warn} Page signals skipped: ${errMsg(err)}${c.reset}`);
        }
      } else if (latest.pageSignals) {
        console.log(`  ${c.dim}Page signals loaded from cache${c.reset}`);
      } else if (args.noPageSignals) {
        console.log(`  ${c.dim}Page signals skipped (--no-page-signals)${c.reset}`);
      }
    })(),

    // ─── AI-bot crawlability audit (cached) ───
    // Pure HTTP fetches, no LLM cost. Surfaces robots.txt blocks and missing
    // /llms.txt / sitemap.xml — common root causes of "AI doesn't see me".
    (async () => {
      if (!latest.crawlability && latest.domain) {
        console.log(`  ${c.dim}Auditing AI-bot crawlability for ${latest.domain}...${c.reset}`);
        try {
          latest.crawlability = await auditCrawlability(latest.domain);
          await persistSnapshot(latest);
          const s = latest.crawlability.summary;
          const flag = s.blockedCount > 0 ? `${c.red}${s.blockedCount} bot${s.blockedCount !== 1 ? 's' : ''} blocked${c.reset}` : `${c.green}all bots OK${c.reset}`;
          console.log(`  ${c.green}${SYM.ok}${c.reset} robots:${s.hasRobots ? SYM.ok : SYM.err} llms.txt:${s.hasLlmsTxt ? SYM.ok : SYM.err} sitemap:${s.hasSitemap ? SYM.ok : SYM.err} — ${flag}`);
        } catch (err) {
          console.log(`  ${c.yellow}${SYM.warn} Crawlability audit skipped: ${errMsg(err)}${c.reset}`);
        }
      } else if (latest.crawlability) {
        console.log(`  ${c.dim}Crawlability audit loaded from cache${c.reset}`);
      }
    })(),

    // ─── v1.1: Entity graph (cross-platform sameAs reciprocity, cached) ───
    // Reuses homepage HTML from pageSignals if available — avoids re-fetch.
    (async () => {
      if (!latest.entityGraph && latest.domain && !args.noEntityGraph) {
        console.log(`  ${c.dim}Verifying cross-platform sameAs chain...${c.reset}`);
        try {
          latest.entityGraph = await checkEntityGraph(latest.domain);
          await persistSnapshot(latest);
          const eg = latest.entityGraph;
          if (eg.ok) {
            console.log(`  ${c.green}${SYM.ok}${c.reset} sameAs:${eg.sameAsCount} reciprocity:${eg.summary.reciprocityRate}%`);
          } else {
            console.log(`  ${c.yellow}${SYM.warn} Entity graph: ${eg.error || 'unavailable'}${c.reset}`);
          }
        } catch (err) {
          console.log(`  ${c.yellow}${SYM.warn} Entity graph skipped: ${errMsg(err)}${c.reset}`);
        }
      } else if (latest.entityGraph) {
        console.log(`  ${c.dim}Entity graph loaded from cache${c.reset}`);
      } else if (args.noEntityGraph) {
        console.log(`  ${c.dim}Entity graph skipped (--no-entity-graph)${c.reset}`);
      }
    })(),

    // ─── v1.1: Competitor pricing tiers (cached, top-5) ───
    // Heuristic only — no LLM cost. Uses citations from this run.
    (async () => {
      if (!latest.competitorPricing && Array.isArray(latest.topCompetitors) && latest.topCompetitors.length > 0 && !args.noPricing) {
        console.log(`  ${c.dim}Classifying competitor pricing tiers (top-5)...${c.reset}`);
        try {
          const allCitations = (latest.results || []).flatMap(r => r.canonicalCitations || []);
          latest.competitorPricing = await classifyCompetitorPricing(latest.topCompetitors, allCitations, { limit: 5 });
          await persistSnapshot(latest);
          const tiers = latest.competitorPricing.map(c => `${c.name}=${c.tier}`).join(' ');
          console.log(`  ${c.green}${SYM.ok}${c.reset} ${tiers}`);
        } catch (err) {
          console.log(`  ${c.yellow}${SYM.warn} Competitor pricing skipped: ${errMsg(err)}${c.reset}`);
        }
      } else if (latest.competitorPricing) {
        console.log(`  ${c.dim}Competitor pricing loaded from cache${c.reset}`);
      } else if (args.noPricing) {
        console.log(`  ${c.dim}Competitor pricing skipped (--no-pricing)${c.reset}`);
      }
    })(),
  ]);

  // ─── Wave 2: Authority presence — depends on pageSignals from Wave 1 ───
  // Off-page signals AI engines weight heavily. APIs are free public
  // endpoints with no auth — we run once per report and cache.
  if (!latest.authorityPresence && latest.brand && !args.noAuthority) {
    console.log(`  ${c.dim}Checking authority signals for ${latest.brand}...${c.reset}`);
    try {
      // Pass domain + category + pageSignals so getAuthorityProfile() can
      // promote a dev-tool brand to also check GitHub (alongside wiki+reddit).
      // pageSignals.homepage.headings is the strongest signal when init
      // didn't fill category — it's brand-authored text.
      // GITHUB_TOKEN env var is read directly when present (60→5000 req/h).
      latest.authorityPresence = await checkAuthorityPresence(latest.brand, {
        domain: latest.domain,
        category: latest.category,
        pageSignals: latest.pageSignals,
      });
      await persistSnapshot(latest);
      const ap = latest.authorityPresence;
      const wiki = ap.wikipedia.found ? `${c.green}wiki${SYM.ok}${c.reset}` : `${c.yellow}wiki${SYM.err}${c.reset}`;
      const red = ap.reddit.found ? `${c.green}reddit${SYM.ok}${c.reset} (${ap.reddit.mentionCount})` : `${c.yellow}reddit${SYM.err}${c.reset}`;
      const gh = ap.github
        ? (ap.github.found ? `${c.green}gh${SYM.ok}${c.reset}` : `${c.yellow}gh${SYM.err}${c.reset}`)
        : '';
      console.log(`  ${wiki} · ${red}${gh ? ' · ' + gh : ''}`);
    } catch (err) {
      console.log(`  ${c.yellow}${SYM.warn} Authority check skipped: ${errMsg(err)}${c.reset}`);
    }
  } else if (latest.authorityPresence) {
    console.log(`  ${c.dim}Authority presence loaded from cache${c.reset}`);
  } else if (args.noAuthority) {
    console.log(`  ${c.dim}Authority check skipped (--no-authority)${c.reset}`);
  }

  // ─── v1.1: Region context (per-engine geo signals, derived) ───
  // Pure derivation from existing results — no fetch. Always recompute.
  try {
    latest.regionContext = checkRegionContext(latest);
    await persistSnapshot(latest);
    const rc = latest.regionContext.aggregate;
    if (rc.dominantRegion) {
      console.log(`  ${c.green}${SYM.ok}${c.reset} dominant region: ${rc.dominantRegion} (${rc.confidence})`);
    }
  } catch (err) {
    console.log(`  ${c.yellow}${SYM.warn} Region context skipped: ${errMsg(err)}${c.reset}`);
  }

  // ─── v1.1: Response freshness (training cutoff inference, derived) ───
  // Pure derivation from existing results. Always recompute.
  try {
    latest.responseFreshness = checkResponseFreshness(latest);
    await persistSnapshot(latest);
    const rf = latest.responseFreshness.aggregate;
    console.log(`  ${c.green}${SYM.ok}${c.reset} freshness: ${rf.overall} (fresh:${rf.counts.fresh} stale:${rf.counts.stale} unknown:${rf.counts.unknown})`);
  } catch (err) {
    console.log(`  ${c.yellow}${SYM.warn} Response freshness skipped: ${errMsg(err)}${c.reset}`);
  }

  // ─── Outreach email templates for top-3 cited domains (cached) ───
  if (!latest.outreachTemplates && Array.isArray(latest.topDomains) && latest.topDomains.length > 0) {
    let cfg = {};
    try { cfg = JSON.parse(await readFile(CONFIG_FILE, 'utf-8')); } catch { /* skip */ }
    const category = cfg.category || '';
    const providersCfg = { ...DEFAULT_CONFIG.providers, ...(cfg.providers || {}) };
    const providerEntry = Object.entries(providersCfg).find(([, p]) => process.env[p.env]);
    if (providerEntry && category) {
      const [providerKey, providerCfg] = providerEntry;
      const providerCall = PROVIDERS[providerKey]?.call;
      if (providerCall) {
        console.log(`  ${c.dim}Drafting outreach emails for top-${Math.min(3, latest.topDomains.length)} domains...${c.reset}`);
        try {
          const { templates, costInfo } = await generateOutreachTemplates({
            brand: latest.brand, domain: latest.domain, category,
            topDomains: latest.topDomains,
            providerName: providerKey,
            providerCall,
            apiKey: process.env[providerCfg.env],
            // Outreach templates = structured generation; classify-tier is enough.
            model: providerCfg.classifyModel || providerCfg.model,
          });
          if (templates.length > 0) {
            latest.outreachTemplates = templates;
            if (!latest.costByModel) latest.costByModel = [];
            if (costInfo) latest.costByModel.push(costInfo);
            await persistSnapshot(latest);
            console.log(`  ${c.green}${SYM.ok} ${templates.length} outreach template${templates.length !== 1 ? 's' : ''} generated${c.reset}`);
          }
        } catch (err) {
          console.log(`  ${c.yellow}${SYM.warn} Outreach templates skipped: ${errMsg(err)}${c.reset}`);
        }
      }
    }
  } else if (latest.outreachTemplates) {
    console.log(`  ${c.dim}Outreach templates loaded from cache${c.reset}`);
  }

  // v0.7 — AEO Mission Control metadata payload (privacy-stripped allow-list).
  // Skipped entirely when --no-mc-block is passed.
  // Read package metadata once — version feeds MC bridge + footer colophon,
  // repository URL feeds the «open source» footer link. Hoisted out of the
  // noMcBlock branch so the footer always shows them.
  let trackerVersion = '0.0.0';
  let trackerRepoUrl = '';
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    trackerVersion = pkg.version || trackerVersion;
    // package.json "repository" can be a string or an { url, type } object.
    // npm convention strips "git+" prefix and ".git" suffix for display.
    const rawRepo = typeof pkg.repository === 'string'
      ? pkg.repository
      : (pkg.repository && pkg.repository.url) || '';
    trackerRepoUrl = String(rawRepo).replace(/^git\+/, '').replace(/\.git$/, '');
  } catch { /* package metadata unreadable — falls through to defaults */ }

  let mcMetadata = null;
  let daysSinceRun = 0;
  if (!args.noMcBlock) {
    let cfgLang = 'en';
    let cfgRaw = null;
    try {
      cfgRaw = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
      cfgLang = cfgRaw.lang || cfgRaw.language || 'en';
    } catch { /* config missing — default 'en', no basket history available */ }
    mcMetadata = buildMcMetadata(latest, snapshots, {
      trackerVersion,
      lang: cfgLang,
      config: cfgRaw,
    });

    // Compute age in days (ceiling). latest.date is "YYYY-MM-DD" UTC.
    const runDateMs = Date.parse(latest.date + 'T00:00:00Z');
    if (Number.isFinite(runDateMs)) {
      daysSinceRun = Math.max(0, Math.floor((Date.now() - runDateMs) / 86400000));
    }
  }

  const md = renderMarkdown(snapshots, rawResponses, { mcMetadata, noMcBlock: args.noMcBlock });

  const outDir = join('aeo-reports', latest.date);
  await mkdir(outDir, { recursive: true });
  const outPath = args.output || join(outDir, 'report.md');
  await writeFile(outPath, md);

  // v0.8 — HTML bento report is the default; --no-html skips it for CI/email-only.
  // The legacy `cmdPreview` markdown→TMP-HTML path was removed in v0.8 — the
  // single-file bento HTML in `lib/report/html.js` is the canonical view.
  let htmlOutPath = null;
  if (!args.noHtml) {
    htmlOutPath = args.output
      ? args.output.replace(/\.md$/, '') + '.html'
      : join(outDir, 'report.html');
    const html = renderHtml(
      buildHtmlSummary(snapshots, rawResponses),
      snapshots,
      { mcMetadata, daysSinceRun, noMcBlock: args.noMcBlock, pkgVersion: trackerVersion, repoUrl: trackerRepoUrl },
    );
    await writeFile(htmlOutPath, html);
  }

  // v0.5 — sweep stale orphaned report.{md,html} from older date dirs so they
  // don't mislead a reader after a layout rewrite. Only fires when writing to
  // the default location (custom --output paths skip cleanup since the user
  // controls where artifacts land).
  let cleanupResult = { removedFiles: 0, removedDirs: 0 };
  if (!args.output) {
    cleanupResult = await cleanupStaleReportArtifacts(latest.date);
  }

  const loadedQuotes = Object.keys(rawResponses).length;
  console.log(`\n${c.bold}aeo-platform — report${c.reset}`);
  console.log(`  ${snapshots.length} run${snapshots.length !== 1 ? 's' : ''} loaded (${snapshots[0].date} → ${latest.date})`);
  console.log(`  ${loadedQuotes} raw response${loadedQuotes !== 1 ? 's' : ''} available for verbatim quotes`);
  console.log(`  Latest score: ${c.bold}${latest.score}%${c.reset}`);
  if (cleanupResult.removedFiles > 0 || cleanupResult.removedDirs > 0) {
    const f = cleanupResult.removedFiles;
    const d = cleanupResult.removedDirs;
    const fStr = `${f} stale report file${f !== 1 ? 's' : ''}`;
    const dStr = d > 0 ? ` and ${d} empty director${d !== 1 ? 'ies' : 'y'}` : '';
    console.log(`  ${c.dim}Cleanup: removed ${fStr}${dStr}.${c.reset}`);
  }
  console.log(`\n${c.green}Report written: ${outPath}${c.reset}`);
  if (htmlOutPath) console.log(`${c.green}HTML report:   ${htmlOutPath}${c.reset}`);

  if (args.noOpen) {
    console.log(`${c.dim}(browser open skipped — pass without --no-open to open automatically)${c.reset}\n`);
  } else if (htmlOutPath) {
    const { openInBrowser } = await import('../lib/util/open-browser.js');
    const ok = await openInBrowser(htmlOutPath);
    if (ok) {
      console.log(`${c.green}Opened in browser: ${htmlOutPath}${c.reset}\n`);
    } else {
      // Headless Linux without xdg-open, sandboxed env, etc. Print the path
      // so the user can open it themselves instead of staring at silence.
      console.log(`${c.dim}(could not auto-open — open this file manually: ${htmlOutPath})${c.reset}\n`);
    }
  } else {
    console.log(`${c.dim}(--no-html: only ${outPath} written; drop --no-html to open the bento HTML)${c.reset}\n`);
  }

  process.exit(0);
}

// ─── Commands (preview) — REMOVED in v0.8 ───

// ─── Commands (run-manual) ───

async function cmdRunManual(argv) {
  // Parse: aeo-platform run-manual <provider> --from-dir <dir>
  let providerName = null;
  let fromDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-dir' && argv[i + 1]) { fromDir = argv[i + 1]; i++; }
    else if (!argv[i].startsWith('--') && !providerName) { providerName = argv[i]; }
  }

  if (!providerName) {
    console.error(`${c.red}Usage: aeo-platform run-manual <provider> --from-dir <dir>${c.reset}`);
    console.error(`${c.dim}Providers: ${Object.keys(PROVIDERS).join(', ')}${c.reset}`);
    process.exit(1);
  }
  if (!PROVIDERS[providerName]) {
    console.error(`${c.red}Unknown provider: ${providerName}${c.reset}`);
    console.error(`${c.dim}Valid: ${Object.keys(PROVIDERS).join(', ')}${c.reset}`);
    process.exit(1);
  }
  if (!fromDir || !existsSync(fromDir)) {
    console.error(`${c.red}--from-dir <dir> required; directory must exist and contain q1.txt, q2.txt, q3.txt${c.reset}`);
    process.exit(1);
  }
  if (!existsSync(CONFIG_FILE)) {
    console.error(`${c.red}No ${CONFIG_FILE} found. Run: aeo-platform init${c.reset}`);
    process.exit(1);
  }

  const config = await readConfigOrExit();
  const { brand, domain, queries: rawQueriesManual } = config;
  const { texts: queries, tags: queryTagsManual } = normalizeQueries(rawQueriesManual);
  const providerCfg = (config.providers || DEFAULT_CONFIG.providers)[providerName] || PROVIDERS[providerName];
  const providerLabel = PROVIDERS[providerName].label;
  const modelUsed = providerCfg.model || 'manual';

  // Pre-flight: every query needs its own paste file. Refuse partial runs —
  // silent skip-per-file produces confusing partial _summary.json that
  // contaminates the weekly trend. Hard-fail BEFORE any heavy work
  // (buildExtractionProviders, mkdir, etc.) so the operator gets an instant
  // diagnostic instead of waiting for an unrelated API-key error.
  const expectedFiles = queries.map((_, i) => join(fromDir, `q${i + 1}.txt`));
  const missingFiles = expectedFiles.filter(f => !existsSync(f));
  if (missingFiles.length > 0) {
    console.error(`\n${c.red}${SYM.err} Missing query response files in ${fromDir}:${c.reset}`);
    missingFiles.forEach(f => console.error(`  ${c.red}✗${c.reset} ${f}`));
    console.error(`\n${c.dim}Each query needs its own paste file (q1.txt for query 1, q2.txt for query 2, …).${c.reset}`);
    console.error(`${c.dim}Paste the AI engine's response into the missing file(s) and re-run.${c.reset}`);
    process.exit(1);
  }

  const date = new Date().toISOString().split('T')[0];
  const responseDir = join('aeo-responses', date);
  await mkdir(responseDir, { recursive: true });

  console.log(`\n${c.bold}aeo-platform — run-manual${c.reset}`);
  console.log(`${c.dim}Provider: ${providerLabel} | Source: ${fromDir}${c.reset}\n`);

  let extractionProvidersManual;
  try {
    extractionProvidersManual = await buildExtractionProviders(config.providers);
  } catch (err) {
    console.error(`\n${c.red}${SYM.err} ${errMsg(err)}${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.dim}  Extractor: ${extractionProvidersManual.secondary
    ? `${extractionProvidersManual.primary.model} + ${extractionProvidersManual.secondary.model} (parallel)`
    : `${extractionProvidersManual.primary.model} (single-model — competitor mentions will be unverified)`}${c.reset}\n`);

  const newResults = [];
  for (let qi = 0; qi < queries.length; qi++) {
    const query = queries[qi];
    const queryFile = join(fromDir, `q${qi + 1}.txt`);
    const tag = `Q${qi + 1}/${providerName}`;

    const text = await readFile(queryFile, 'utf-8');
    const citations = extractUrls(text);
    const mention = detectMention(text, citations, brand, domain);
    const position = mention === 'yes' ? findPosition(text, brand, domain) : null;
    // Extraction and sentiment run in parallel (independent classify-tier calls).
    const sentimentTaskManual = (mention === 'yes' || mention === 'src')
      ? classifySentimentWithTwoModels({
          text, brand, domain,
          primary:   extractionProvidersManual.primary,
          secondary: extractionProvidersManual.secondary,
        })
      : Promise.resolve(null);
    const [extractionManual, sentimentManual] = await Promise.all([
      extractWithTwoModels({
        text, brand, domain,
        category: config.category || '',
        primary:   extractionProvidersManual.primary,
        secondary: extractionProvidersManual.secondary,
      }),
      sentimentTaskManual,
    ]);
    const competitors           = extractionManual.verified;
    const competitorsUnverified = extractionManual.unverified;
    const canonicalCitations = [...new Set(citations)];
    const responseQuality = classifyResponseQuality({
      text, citations,
      competitors: [...competitors, ...competitorsUnverified],
    });

    // Save raw paste for audit
    const rawFile = join(responseDir, `q${qi + 1}-${providerName}-manual.txt`);
    await writeFile(rawFile, text);

    const storeManualSources = competitorsUnverified.length > 0
      || !!extractionManual.sources.primary?.error
      || !!extractionManual.sources.secondary?.error;
    newResults.push({
      query: `Q${qi + 1}`,
      queryText: query,
      provider: providerName,
      label: providerLabel,
      model: modelUsed,
      source: 'manual-paste',
      mention,
      position,
      citationCount: citations.length,
      canonicalCitations,
      competitors,
      competitorsUnverified,
      ...(storeManualSources ? { extractionSources: extractionManual.sources } : {}),
      ...(sentimentManual ? { sentiment: { label: sentimentManual.label, confidence: sentimentManual.confidence, rationale: sentimentManual.rationale } } : {}),
      ...(queryTagsManual[qi] ? { tag: queryTagsManual[qi] } : {}),
      responseQuality,
      hasBrandInCitations: citations.some(u => u.toLowerCase().includes(domain.toLowerCase())),
      elapsedMs: null,
    });

    const icon = mention === 'yes' ? `${c.green}YES` : mention === 'src' ? `${c.yellow}SRC` : `${c.red}NO`;
    console.log(`  ${icon}${c.reset} ${tag} (${citations.length} URLs extracted)`);
  }

  if (newResults.length === 0) {
    console.error(`\n${c.red}No query files found in ${fromDir}. Expected q1.txt, q2.txt, q3.txt${c.reset}`);
    process.exit(1);
  }

  // ─── Merge with existing _summary.json for today (if any) ───
  const summaryPath = join(responseDir, '_summary.json');
  let existing = null;
  if (existsSync(summaryPath)) {
    try {
      existing = JSON.parse(await readFile(summaryPath, 'utf-8'));
    } catch {
      // A half-written summary from an interrupted run used to crash run-manual
      // with a bare SyntaxError. Merge from scratch instead — and say so.
      console.log(`${c.yellow}  Today's _summary.json was unreadable (likely an interrupted earlier run) — rebuilding it from this paste.${c.reset}`);
    }
  }

  // Remove prior results for this provider (overwrite behaviour)
  const keptResults = (existing?.results || []).filter(r => r.provider !== providerName);
  const allResults = [...keptResults, ...newResults];

  // Recompute aggregates
  const total = allResults.filter(r => r.mention !== 'error').length;
  const mentions = allResults.filter(r => r.mention === 'yes' || r.mention === 'src').length;
  const score = total > 0 ? Math.round((mentions / total) * 100) : 0;
  const errors = allResults.filter(r => r.mention === 'error').length;

  const allCompetitors = {};
  for (const r of allResults) {
    for (const comp of (r.competitors || [])) allCompetitors[comp] = (allCompetitors[comp] || 0) + 1;
  }
  const sortedCompetitors = Object.entries(allCompetitors).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const sourceMap = {};
  for (const r of allResults) {
    for (const url of (r.canonicalCitations || [])) sourceMap[url] = (sourceMap[url] || 0) + 1;
  }
  const topCanonicalSources = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([url, count]) => ({ url, count }));

  const topDomains = computeTopDomains(allResults, 10);

  const regressionThreshold = existing?.regressionThreshold
    ?? (typeof config.regressionThreshold === 'number' ? config.regressionThreshold : 10);

  const summary = {
    date,
    brand,
    domain,
    score,
    mentions,
    total,
    errors,
    regressionThreshold,
    extractorMode: extractionProvidersManual.secondary ? 'dual' : 'single',
    results: allResults,
    topCompetitors: sortedCompetitors.map(([name, count]) => ({ name, count })),
    topCanonicalSources,
    topDomains,
    adsDetected: summariseAdsAcrossResults(allResults),
  };
  await atomicWriteJson(summaryPath, summary);

  console.log(`\n${c.bold}  Merged into: ${summaryPath}${c.reset}`);
  console.log(`  Score: ${c.bold}${score}%${c.reset} (${mentions}/${total} across ${new Set(allResults.map(r => r.provider)).size} providers)\n`);

  // Exit-code parity with `run` (README contract). run-manual doesn't call APIs,
  // so code 3 (all providers errored) is unreachable here.
  let previousScore = null;
  try {
    const { readdirSync } = await import('node:fs');
    const allDates = readdirSync('aeo-responses')
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < date)
      .sort();
    const prevDate = allDates[allDates.length - 1];
    if (prevDate) {
      const prev = JSON.parse(await readFile(join('aeo-responses', prevDate, '_summary.json'), 'utf-8'));
      if (typeof prev.score === 'number') previousScore = prev.score;
    }
  } catch { /* no previous run — first one */ }

  let exitCode;
  if (mentions === 0) exitCode = 2;
  else if (previousScore !== null && score - previousScore < -regressionThreshold) exitCode = 1;
  else exitCode = 0;

  // Next-step hint (mirrors cmdRun). run-manual has no exitCode 3 or silent
  // mode, so no guards needed.
  console.log(`\nNext: ${c.cyan}aeo-platform report --html${c.reset}  ${c.dim}(or 'aeo-platform report' for markdown-only)${c.reset}\n`);

  process.exit(exitCode);
}

// ─── Commands (diff) ───

/**
 * v0.6 — flatten every snapshot in aeo-responses/ to CSV (or JSON array) for
 * BI ingestion. One row per result cell. Writes to stdout if --output is
 * omitted, or to the file otherwise.
 */
async function cmdExport(args = {}) {
  // Lazy-load CSV / JSON serialiser only when this command runs.
  const { snapshotsToCsv, snapshotsToJson } = await import('../lib/report/csv-export.js');

  const { readdirSync } = await import('node:fs');
  const responsesDir = 'aeo-responses';
  if (!existsSync(responsesDir)) {
    console.error(`${c.red}No aeo-responses/ directory. Run: aeo-platform run${c.reset}`);
    process.exit(1);
  }
  const dates = readdirSync(responsesDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const snapshots = [];
  for (const date of dates) {
    const summaryPath = join(responsesDir, date, '_summary.json');
    if (existsSync(summaryPath)) {
      try { snapshots.push(JSON.parse(await readFile(summaryPath, 'utf-8'))); }
      catch { /* skip malformed */ }
    }
  }
  if (snapshots.length === 0) {
    console.error(`${c.red}No _summary.json files found in aeo-responses/.${c.reset}`);
    process.exit(1);
  }

  const fmt = (args.format || 'csv').toLowerCase();
  if (fmt !== 'csv' && fmt !== 'json') {
    console.error(`${c.red}Unknown format: ${fmt}. Use --format=csv or --format=json.${c.reset}`);
    process.exit(1);
  }

  const output = fmt === 'csv' ? snapshotsToCsv(snapshots) : snapshotsToJson(snapshots);

  if (args.output) {
    await writeFile(args.output, output);
    const rows = output.split('\n').length - 1;
    console.log(`${c.green}${SYM.ok} Exported ${snapshots.length} run${snapshots.length !== 1 ? 's' : ''} (${rows} rows) → ${args.output}${c.reset}`);
  } else {
    process.stdout.write(output);
  }
}

/**
 * v0.6 — parse Apache/nginx access log to count AI bot crawl frequency.
 * User pipes their server's access.log through --log-file. We extract
 * User-Agent strings, match against AI_BOTS, count requests per bot.
 */
async function cmdCrawlStats(args = {}) {
  if (!args.logFile) {
    console.error(`${c.red}--log-file=path required. Example: aeo-platform crawl-stats --log-file=/var/log/nginx/access.log${c.reset}`);
    process.exit(1);
  }
  if (!existsSync(args.logFile)) {
    console.error(`${c.red}Log file not found: ${args.logFile}${c.reset}`);
    process.exit(1);
  }

  // Stream-parse line-by-line so 500MB+ access logs don't OOM the Node heap.
  // Memory is O(1) regardless of file size. The 100MB threshold is the
  // typical-vs-large boundary — surface a "this may take a while" line so
  // the operator knows it's not hung.
  const { parseLogLine, summariseBotCrawls } = await import('../lib/report/log-parser.js');
  const { createReadStream, statSync } = await import('node:fs');
  const { createInterface: createReadline } = await import('node:readline');

  const size = statSync(args.logFile).size;
  if (size > 100 * 1024 * 1024) {
    console.log(`${c.dim}  Streaming ${Math.round(size / 1024 / 1024)}MB log — this may take 30-60s${c.reset}`);
  }

  const entries = [];
  try {
    const stream = createReadStream(args.logFile, { encoding: 'utf-8' });
    const rl = createReadline({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const entry = parseLogLine(line);
      if (entry) entries.push(entry);
    }
  } catch (err) {
    console.error(`${c.red}${SYM.err} Failed to stream-read ${args.logFile}: ${errMsg(err)}${c.reset}`);
    process.exit(1);
  }
  const stats = summariseBotCrawls(entries);

  if (stats.totalBotHits === 0) {
    console.log(`${c.yellow}No AI bot hits found in ${entries.length} log entries.${c.reset}`);
    console.log(`${c.dim}This could mean: (1) AI bots haven't crawled yet, or (2) log format isn't Combined/CLF — check User-Agent field.${c.reset}`);
    return;
  }

  console.log(`\n${c.bold}AI Bot Crawl Stats — ${args.logFile}${c.reset}`);
  console.log(`${c.dim}${entries.length} log lines parsed · ${stats.totalBotHits} AI bot hits · ${Object.keys(stats.byBot).length} distinct bots${c.reset}\n`);

  const sortedBots = Object.entries(stats.byBot).sort((a, b) => b[1].hits - a[1].hits);
  for (const [bot, info] of sortedBots) {
    const days = info.firstSeen && info.lastSeen ? `${info.firstSeen} → ${info.lastSeen}` : '';
    console.log(`  ${c.cyan}${bot.padEnd(20)}${c.reset} ${String(info.hits).padStart(6)} hits   ${c.dim}${days}${c.reset}`);
  }

  if (args.output) {
    await writeFile(args.output, JSON.stringify(stats, null, 2));
    console.log(`\n${c.green}${SYM.ok} Saved to ${args.output}${c.reset}`);
  }
}

async function cmdDiff(argv) {
  const { readdirSync } = await import('node:fs');
  const responsesDir = 'aeo-responses';

  if (!existsSync(responsesDir)) {
    console.error(`${c.red}No aeo-responses/ directory found. Run: aeo-platform run${c.reset}`);
    process.exit(1);
  }

  const allDates = readdirSync(responsesDir)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  // Parse args: aeo-platform diff [dateA] [dateB] | --last N | --since DATE
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--last' && argv[i + 1]) { args.last = Number(argv[i + 1]); i++; }
    else if (argv[i] === '--since' && argv[i + 1]) { args.since = argv[i + 1]; i++; }
    else if (!argv[i].startsWith('--')) {
      if (!args.dateA) args.dateA = argv[i];
      else if (!args.dateB) args.dateB = argv[i];
    }
  }

  let dateA, dateB;
  if (args.last) {
    if (allDates.length < args.last) {
      console.error(`${c.yellow}Only ${allDates.length} runs found, need ${args.last}.${c.reset}`);
      process.exit(1);
    }
    dateA = allDates[allDates.length - args.last];
    dateB = allDates[allDates.length - 1];
  } else if (args.since) {
    dateA = args.since;
    dateB = allDates[allDates.length - 1];
  } else if (args.dateA && args.dateB) {
    dateA = args.dateA; dateB = args.dateB;
  } else {
    if (allDates.length < 2) {
      console.error(`${c.yellow}Need at least 2 runs to diff. Found ${allDates.length}.${c.reset}`);
      process.exit(1);
    }
    dateA = allDates[allDates.length - 2];
    dateB = allDates[allDates.length - 1];
  }

  // Pre-check: caller-supplied dates (from --since or positional A B) may not
  // exist in the snapshots directory. Raw `No _summary.json for X` errors are
  // unhelpful; list available dates so the operator can pick one.
  const missingDates = [dateA, dateB].filter(d => !allDates.includes(d));
  if (missingDates.length > 0) {
    console.error(`${c.red}${SYM.err} No run found for: ${missingDates.join(', ')}${c.reset}`);
    console.error(`${c.dim}Available dates: ${allDates.join(', ')}${c.reset}`);
    console.error(`${c.dim}Use one of those, or \`aeo-platform diff --last 2\` for the most recent pair.${c.reset}`);
    process.exit(1);
  }

  const load = async (d) => {
    const p = join(responsesDir, d, '_summary.json');
    if (!existsSync(p)) throw new Error(`No _summary.json for ${d}`);
    return JSON.parse(await readFile(p, 'utf-8'));
  };

  let summaryA, summaryB;
  try {
    [summaryA, summaryB] = await Promise.all([load(dateA), load(dateB)]);
  } catch (err) {
    console.error(`${c.red}${errMsg(err)}${c.reset}`);
    process.exit(1);
  }

  const result = diff(summaryA, summaryB);

  console.log(`\n${c.bold}aeo-platform — diff${c.reset}`);
  console.log(`${c.dim}Brand: ${summaryA.brand}${c.reset}`);
  console.log(`${c.dim}From: ${dateA} — score ${summaryA.score}% (${summaryA.mentions}/${summaryA.total})${c.reset}`);
  console.log(`${c.dim}To:   ${dateB} — score ${summaryB.score}% (${summaryB.mentions}/${summaryB.total})${c.reset}`);
  const deltaColor = result.scoreDelta > 0 ? c.green : result.scoreDelta < 0 ? c.red : c.dim;
  const deltaSign = result.scoreDelta > 0 ? '+' : '';
  console.log(`${c.bold}Score delta: ${deltaColor}${deltaSign}${result.scoreDelta}pp${c.reset}\n`);

  if (result.cellChanges.length > 0) {
    console.log(`${c.bold}  Cell changes:${c.reset}`);
    for (const ch of result.cellChanges) {
      const gained = (ch.was === 'no' || ch.was === 'missing') && (ch.now === 'yes' || ch.now === 'src');
      const lost = (ch.was === 'yes' || ch.was === 'src') && (ch.now === 'no' || ch.now === 'missing');
      const arrow = gained ? `${c.green}↑ Gained${c.reset}` : lost ? `${c.red}↓ Lost  ${c.reset}` : `${c.yellow}~ Moved ${c.reset}`;
      console.log(`    ${arrow}  ${ch.provider.padEnd(10)} ${ch.query.padEnd(4)} ${String(ch.was).padEnd(7)} → ${ch.now}`);
    }
  } else {
    console.log(`${c.dim}  No cell changes between runs.${c.reset}`);
  }

  if (result.newCompetitors.length > 0) {
    console.log(`\n${c.bold}  New competitors:${c.reset}`);
    for (const { name, count } of result.newCompetitors) {
      console.log(`    ${c.cyan}+ ${name}${c.reset} (${count} mentions)`);
    }
  }
  if (result.lostCompetitors.length > 0) {
    console.log(`\n${c.bold}  Competitors that fell off:${c.reset}`);
    for (const { name, count } of result.lostCompetitors) {
      console.log(`    ${c.dim}- ${name} (was ${count})${c.reset}`);
    }
  }
  if (result.sourcesMovement.gained.length > 0) {
    console.log(`\n${c.bold}  New canonical sources:${c.reset}`);
    for (const { url, count } of result.sourcesMovement.gained.slice(0, 5)) {
      const short = url.length > 70 ? url.slice(0, 67) + '...' : url;
      console.log(`    ${c.green}+${c.reset} ${short} (${count}×)`);
    }
  }
  if (result.sourcesMovement.lost.length > 0) {
    console.log(`\n${c.bold}  Sources no longer cited:${c.reset}`);
    for (const { url, count } of result.sourcesMovement.lost.slice(0, 5)) {
      const short = url.length > 70 ? url.slice(0, 67) + '...' : url;
      console.log(`    ${c.dim}- ${short} (was ${count}×)${c.reset}`);
    }
  }
  console.log('');

  const regressionThreshold =
    summaryB.regressionThreshold ?? summaryA.regressionThreshold ?? 10;
  if (result.scoreDelta < -regressionThreshold) process.exit(1);
  process.exit(0);
}

// ─── CLI Entry ───

const HELP = `
${c.bold}aeo-platform${c.reset} — Track brand visibility in AI answer engines

${c.bold}Usage:${c.reset}
  aeo-platform init                    Create .aeo-tracker.json config
  aeo-platform init --queries-only     Re-suggest queries without changing brand/domain/providers
  aeo-platform run          Run visibility audit (reads config, calls APIs)
  aeo-platform run --json   Same, but print structured JSON to stdout (for CI pipelines)
  aeo-platform run --replay [--replay-from=YYYY-MM-DD]
                           Replay mode — rebuild today's summary from cached raw responses
                           instead of calling APIs. Zero API cost. Useful for: iterating on
                           the report/parser locally, re-generating a summary with updated
                           extractor logic against historical data. Defaults to the most
                           recent captured snapshot unless --replay-from is given.
  aeo-platform run-manual P --from-dir D   Import manual paste responses for provider P
                                          from directory D containing q1.txt, q2.txt, q3.txt
                                          (for engines without a usable API: Perplexity, Copilot,
                                          ChatGPT Pro UI, Claude.ai). Merges into today's summary.
  aeo-platform diff A B     Compare two runs by date (YYYY-MM-DD); shows delta table
  aeo-platform diff --last N       Compare the last N runs (default: 2)
  aeo-platform diff --since DATE   Compare a date with the latest run
  aeo-platform report       Generate the report. Writes report.md (markdown) AND report.html
                           (single-file bento layout — offline-ready, embedded fonts, vanilla JS)
                           and opens the HTML in your browser.
                           Output: aeo-reports/<date>/report.{md,html}
  aeo-platform report --output path.md   Custom output path (paired .html written alongside)
  aeo-platform report --no-html          Markdown only — skips HTML write and browser open.
                                        Use for CI / email diffs / lightweight automation.
  aeo-platform report --no-open          Write report.{md,html} but don't auto-open the browser.
  aeo-platform report [--no-authority] [--no-entity-graph] [--no-page-signals] [--no-pricing]
                           Skip optional fetch-heavy checks (Wikipedia/Reddit/GitHub authority,
                           sameAs reciprocity, own-domain HTML crawl, competitor pricing pages).
                           Use behind a corp VPN, when rate-limited, or for a fully offline report.
                           Cached results still load.
  aeo-platform report --refresh-cache=<fields>
                           Force-refresh cached fields before report runs. Use when client's site
                           changed and you want fresh signals without rerunning a full snapshot.
                           Fields (CSV): pageSignals, authorityPresence, crawlability,
                                         citationClassification, outreachTemplates, entityGraph,
                                         competitorPricing, llmActions, adsDetected
                           Shortcut:     --refresh-cache=all (refresh every cached field)
                           Examples:     --refresh-cache=pageSignals,authorityPresence
                                         --refresh-cache=all
  aeo-platform export       Flatten all aeo-responses/*/_summary.json to CSV (default) or JSON.
  aeo-platform export --format=json --output=runs.json
  aeo-platform crawl-stats --log-file=path   Parse Apache/nginx access log → AI bot crawl frequency
  aeo-platform --help       Show this help
  aeo-platform --version    Show version

${c.bold}Query validation:${c.reset}
  Queries are validated at init (static acronym + LLM industry-fit check). Verdicts are
  cached in .aeo-tracker.json so run doesn't re-pay. If you hand-edit queries, run will
  auto-validate the new ones inline (shows cost). Known failure mode: "AEO consultants
  Poland" means customs in Poland, not Answer Engine Optimization — always expand acronyms.
  ${c.bold}--force${c.reset}                Bypass validation gate AND today's response cache (re-queries every cell)
  ${c.bold}--strict-validation${c.reset}    Cross-check query validation with 2 LLM providers (unanimous approve OR flag as split).
                         2× validation cost. Use when reliability > latency (e.g. CI pipelines).
  ${c.bold}--geo=us,uk,de${c.reset}         Run each query under multiple regional contexts (multiplies cost by region count).
                         Valid codes: us, uk, de, fr, es, it, ca, au, in, br, jp, nl. Adds "Visibility by Region" section.
  ${c.bold}--depth=<mode>${c.reset}         web (default) — single web-search pass per cell.
                         full — adds a training-data pass (no web search) where supported. Cost ~2×.
                         auto — defaults to web; prompts you if last training-data baseline is stale (>14 days).
                         Use full|auto to distinguish "absent from current SERPs" from "absent from training corpus".

${c.bold}Per-run model overrides${c.reset} (no config rewrite — in-memory only):
  ${c.bold}--openai-model=<id>${c.reset}     Override providers.openai.model for this run
  ${c.bold}--gemini-model=<id>${c.reset}     Override providers.gemini.model
  ${c.bold}--anthropic-model=<id>${c.reset}  Override providers.anthropic.model
  ${c.bold}--perplexity-model=<id>${c.reset} Override providers.perplexity.model

  When you hit rate limits, switch from a search-capable model (e.g. gpt-5-search-api,
  6k TPM on OpenAI tier 1) to its base counterpart (gpt-5, 90k TPM). Tradeoff: no live
  web search, only training-corpus signal. See --depth=full for both passes side-by-side.
  --replay caveat: cached responses are filename-keyed by (query, provider, model). An
  override that doesn't match the recorded model will miss cache and hit live API.

${c.bold}Exit codes (after run):${c.reset}
  0                        Score stable or improved
  1                        Score dropped more than regressionThreshold (default: 10pp vs previous run)
  2                        All checks returned zero mentions
  3                        All providers errored

${c.bold}Environment variables:${c.reset}
  ${c.bold}Research keys${c.reset} (minimum ONE; two recommended — enables the cross-model check):
    OPENAI_API_KEY           OpenAI API key (ChatGPT column + extractor)
    GEMINI_API_KEY           Google AI API key (Gemini column + extractor)
    ANTHROPIC_API_KEY        Anthropic API key (Claude column + extractor)
  ${c.bold}Optional${c.reset} (adds one engine column to the report):
    PERPLEXITY_API_KEY       Perplexity API key (Perplexity column)
  ${c.bold}Debug${c.reset}:
    AEO_DEBUG=1              Print raw stack traces alongside actionable panels
                             (for bug reports — see github.com/webappski/aeo-platform/issues)
    AEO_LOG_TOKENS=1         Log per-call token usage to stderr (calibrate rate-limit
                             scheduler — pipe to "grep tokens" to see real numbers)
    NO_COLOR=1               Strip ANSI escape codes from output (auto-detected
                             on non-TTY; set explicitly in CI logs if you see garbage)

${c.bold}Quick start:${c.reset}
  export OPENAI_API_KEY=sk-...        # required
  export GEMINI_API_KEY=AIza...       # required
  aeo-platform init --yes --brand=X --domain=x.com --auto
  aeo-platform run
  aeo-platform report

${c.bold}About:${c.reset}
  Built by Webappski (https://webappski.com), an AEO agency.
  We use this tool ourselves for our public AEO Visibility Challenge.
  Read Week 1: webappski.com/blog/aeo-visibility-challenge-week-1

  Source: github.com/webappski/aeo-platform
  License: MIT
`;

const { values, positionals } = parseArgs({
  options: {
    help:    { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
    yes:     { type: 'boolean', short: 'y', default: false },
    brand:   { type: 'string' },
    domain:  { type: 'string' },
    category:{ type: 'string' },
    auto:    { type: 'boolean', default: false },
    manual:  { type: 'boolean', default: false },
    light:   { type: 'boolean', default: false },
    keywords:{ type: 'string' },
    'queries-only': { type: 'boolean', default: false },
    output:  { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    html:    { type: 'boolean', default: false },
    json:    { type: 'boolean', default: false },
    last:    { type: 'string' },
    since:   { type: 'string' },
    'from-dir': { type: 'string' },
    force:   { type: 'boolean', default: false },
    'strict-validation': { type: 'boolean', default: false },
    geo:     { type: 'string' },
    depth:   { type: 'string' },                 // web | full | auto (default: web)
    format:  { type: 'string' },
    'log-file': { type: 'string' },
    // Replay mode (see replay-mode block at top of file)
    replay:  { type: 'boolean', default: false },
    'replay-from': { type: 'string' },
    // End replay
    // v0.7 — AEO Mission Control bridge opt-out
    'no-mc-block': { type: 'boolean', default: false },
    // v0.8 — bento HTML is the default; --no-html skips it for CI/email-only flows.
    // `--html` is kept (no-op) for backwards-compat with existing scripts.
    'no-html':       { type: 'boolean', default: false },
    // Optional `report` fetches — skip when offline / behind corp VPN / rate-limited
    'no-authority':    { type: 'boolean', default: false },
    'no-entity-graph': { type: 'boolean', default: false },
    'no-page-signals': { type: 'boolean', default: false },
    'no-pricing':      { type: 'boolean', default: false },
    // v0.4 — invalidate one or more cached fields before report runs so
    // their fetchers re-run (instead of reading stale data from
    // _summary.json). Comma-separated field names, or "all" to refresh
    // every refreshable field. See REFRESHABLE_FIELDS in cmdReport.
    'refresh-cache':   { type: 'string' },
    // v0.7 — basket versioning (additive vs replace on --queries-only)
    'add-queries': { type: 'boolean', default: false },
    'replace-queries': { type: 'boolean', default: false },
    // Per-run model overrides (in-memory only — config file not rewritten).
    // Use to swap a search-capable model (low TPM on tier 1) for its base
    // counterpart without re-running init or editing .aeo-tracker.json.
    'openai-model':     { type: 'string' },
    'gemini-model':     { type: 'string' },
    'anthropic-model':  { type: 'string' },
    'perplexity-model': { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
});
const command = positionals[0];

// Top-level dispatcher wrapped in try/catch. Any error that escapes the
// command-specific error handling (config corruption, filesystem issues,
// unclassified provider edge cases, real bugs) lands here — formatUnexpectedErrorPanel
// turns the raw stack into an actionable panel before exiting with code 1.
// Exceptions: process.exit() from inside a command won't trigger this catch
// (that's intentional — the command already handled its own exit).
// Single prompter for every interactive prompt across init/run. Owned by
// the dispatcher so the two commands don't create competing readlines on
// the same stdin. Lifecycle handled by process.on('exit') inside the
// module — the dispatcher's process.exit(0|1) on every code path
// guarantees that hook fires.
const { createPrompter } = await import('../lib/util/prompt.js');
const prompter = createPrompter({ nonInteractive: values.yes });

try {
  if (values.help || (!command && !values.version)) {
    console.log(HELP);
  } else if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
  } else if (command === 'init') {
    await cmdInit({
      ...values,
      strictValidation: values['strict-validation'],
      queriesOnly: values['queries-only'],
      addQueries: values['add-queries'],
      replaceQueries: values['replace-queries'],
      prompter,
    });
  } else if (command === 'run') {
    await cmdRun({
      json: values.json,
      force: values.force,
      strictValidation: values['strict-validation'],
      geo: values.geo,
      depth: values.depth,                       // web | full | auto (default: web)
      // Per-run model overrides — applied via applyCliModelOverrides()
      openaiModel:     values['openai-model'],
      geminiModel:     values['gemini-model'],
      anthropicModel:  values['anthropic-model'],
      perplexityModel: values['perplexity-model'],
      // Replay mode (see replay-mode block at top of file)
      replay: values.replay,
      replayFrom: values['replay-from'],
      // End replay
      prompter,
    });
  } else if (command === 'run-manual') {
    await cmdRunManual(process.argv.slice(3));
  } else if (command === 'diff') {
    await cmdDiff(process.argv.slice(3));
  } else if (command === 'report') {
    await cmdReport({
      output: values.output,
      noOpen: values['no-open'],
      noHtml: values['no-html'],
      noMcBlock: values['no-mc-block'],
      noAuthority:    values['no-authority'],
      noEntityGraph:  values['no-entity-graph'],
      noPageSignals:  values['no-page-signals'],
      noPricing:      values['no-pricing'],
      refreshCache:   values['refresh-cache'],
    });
  } else if (command === 'export') {
    await cmdExport({ format: values.format || 'csv', output: values.output });
  } else if (command === 'crawl-stats') {
    await cmdCrawlStats({ logFile: values['log-file'], output: values.output });
  } else {
    console.error(`${c.red}Unknown command: ${command}${c.reset}`);
    console.log(HELP);
    process.exit(1);
  }
  // CLI is done. Force-terminate so we don't depend on perfect resource
  // hygiene across lib/ — spinner setInterval, readline on stdin, undici
  // keep-alive socket pool, anything a future contributor adds. Node
  // flushes stdout/stderr synchronously on process.exit, and the 'exit'
  // event fires synchronously which runs every registered hook (e.g.
  // prompter.close in lib/util/prompt.js).
  process.exit(0);
} catch (err) {
  for (const line of formatUnexpectedErrorPanel({ err, command, useColor: USE_COLOR })) {
    console.error(line);
  }
  // Emit raw stack to stderr for debugging when requested — keeps the panel
  // clean by default, but doesn't hide the stack from developers who need it.
  if (process.env.AEO_DEBUG === '1' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
