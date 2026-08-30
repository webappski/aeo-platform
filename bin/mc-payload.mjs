#!/usr/bin/env node
/**
 * mc-payload.mjs — build the privacy-stripped Mission Control ingest payload from
 * a tracker run's `_summary.json` and write it as `mc-payload.json` RIGHT NEXT TO
 * `_summary.json`, in the same run folder. This makes the client-facing payload a
 * findable file that lives alongside the raw run data — no HTML report, no skill,
 * no clipboard step required to locate it.
 *
 * It runs the same `buildMcMetadata()` emitter the report/bridge use, and the
 * privacy allow-list holds identically: cost/tokens/paths/outreach stay stripped —
 * this is the safe-to-paste client projection, not the raw dump.
 *
 * The full snapshot history is loaded from the sibling dated run folders, the
 * same way `aeo-platform report` does — the helper used to pass `[]` here,
 * which put `basket.trendCutoff` / `queriesAddedSince` on the latest run
 * instead of the earliest. Since v1.2 of the payload the stakes are higher:
 * `comparison` is derived FROM that history, so an empty array would emit a
 * first-run payload for a client on their tenth run.
 *
 * `lang` resolution (fixed 2026-08-30 — this exact gap was flagged
 * 2026-07-11 and never closed): explicit CLI arg > `.aeo-tracker.json`'s
 * own `"lang"` field > bare `'en'`. The bare fallback is a LAST resort, not
 * a normal path — it silently produces a payload whose `identity.lang` can
 * disagree with whatever `planV1.lang` a plan-generation pass lands on next,
 * and the portal's paste-form rejects that mismatch with no partial credit
 * ("Plan lang 'X' does not match snapshot lang 'Y'"). Set `"lang"` once in
 * the project's `.aeo-tracker.json` and every future run resolves correctly
 * without anyone having to remember a CLI flag. A multi-locale basket (own
 * queries in several languages, like webappski's) still needs exactly one
 * `"lang"` value — it is not "the basket's language", it is "the language
 * this project's MC content/plan is authored in".
 *
 * Usage:
 *   node bin/mc-payload.mjs <run-folder | _summary.json path> [lang]
 * Examples:
 *   node bin/mc-payload.mjs ~/Projects/aeo-tracker-runs/merchpilot/aeo-responses/2026-06-25
 *   node bin/mc-payload.mjs ~/Projects/aeo-tracker-runs/acme/aeo-responses/2026-07-10/_summary.json ru
 */
import { buildMcMetadata } from '../lib/report/mc-metadata.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
const langArg = process.argv[3];

if (!arg) {
  console.error('usage: node bin/mc-payload.mjs <run-folder | _summary.json> [lang]');
  process.exit(1);
}

// Accept either the run folder or a direct _summary.json path.
let summaryPath = arg;
if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
  summaryPath = path.join(arg, '_summary.json');
}
if (!fs.existsSync(summaryPath)) {
  console.error('no _summary.json found at', summaryPath);
  process.exit(1);
}
const runDir = path.dirname(summaryPath);

// Walk up from the run folder to find the client's .aeo-tracker.json config
// (usually at the client root: <client>/.aeo-tracker.json, two levels above the
// dated run folder). Optional — buildMcMetadata tolerates a null config.
let config = null;
let dir = runDir;
for (let i = 0; i < 6 && dir !== path.dirname(dir); i++) {
  const cfg = path.join(dir, '.aeo-tracker.json');
  if (fs.existsSync(cfg)) {
    config = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    break;
  }
  dir = path.dirname(dir);
}

const lang = langArg || config?.lang || 'en';
if (!langArg && !config?.lang) {
  console.error(
    `⚠️  lang defaulted to 'en' — no [lang] arg given and no "lang" field in ` +
    `${config ? '.aeo-tracker.json' : '(no .aeo-tracker.json found)'}. ` +
    `If this project has a real content/audience language, this is very likely ` +
    `wrong. Fix once: add "lang": "xx" to .aeo-tracker.json — every future run ` +
    `then resolves correctly with no flag. A wrong lang here is exactly what ` +
    `makes the MC paste-form reject the plan later with "Plan lang does not ` +
    `match snapshot lang".`,
  );
}

const trackerVersion = JSON.parse(
  fs.readFileSync(path.join(here, '../package.json'), 'utf8'),
).version;
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

/**
 * Every dated sibling run of this one, oldest first, up to and INCLUDING it.
 *
 * Runs newer than the target are dropped for the same reason `report
 * --for-date` truncates: a payload rebuilt for an April run must not compare
 * against data that did not exist yet. Sorting is by the snapshot's own `date`
 * field, not by folder name, so a legacy flat layout and the current
 * `<domain>/<date>/` layout order identically.
 */
function loadSnapshotHistory(targetDir, targetSummary) {
  const responsesRoot = (() => {
    let d = path.dirname(targetDir);
    for (let i = 0; i < 3; i++) {
      if (path.basename(d) === 'aeo-responses') return d;
      d = path.dirname(d);
    }
    return null;
  })();
  if (!responsesRoot) return [targetSummary];

  const found = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === '_summary.json') {
        try { found.push(JSON.parse(fs.readFileSync(full, 'utf8'))); }
        catch { /* an unreadable sibling must not sink the payload */ }
      }
    }
  };
  walk(responsesRoot, 0);

  const domain = String(targetSummary.domain || '');
  const cutoff = String(targetSummary.date || '');
  const history = found
    // Never blend another brand's runs into this one's trend.
    .filter((s) => !domain || String(s.domain || '') === domain)
    .filter((s) => !cutoff || String(s.date || '') <= cutoff)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  // The target itself must be the last element even if a sibling folder holds
  // a same-dated copy — the caller asked for THIS file.
  const withoutTarget = history.filter((s) => String(s.date || '') !== cutoff);
  return [...withoutTarget, targetSummary];
}

const snapshots = loadSnapshotHistory(runDir, summary);
const payload = buildMcMetadata(summary, snapshots, { trackerVersion, lang, config });

const outPath = path.join(runDir, 'mc-payload.json');
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(
  `✅ wrote ${outPath} (${kb} KB) — brand=${payload.identity?.brand} ` +
  `domain=${payload.identity?.domain} lang=${lang} ` +
  `runs=${payload.comparison?.runCount ?? 0}` +
  `${payload.comparison?.pair ? ` (compared with ${payload.comparison.pair.prevDate})` : ' (first run — no comparison)'}`,
);
