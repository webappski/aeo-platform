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
 * ⚠️ WIP — KNOWN BUG (tracked: pending-review/2026-07-11/aeo-tracker-mc-payload-fix.md,
 * for Платонович / director-aeo-platform to fix under /morning gates). `snapshots` is
 * passed as `[]` at the buildMcMetadata call below, so for the common config shape
 * (`basketHistory: null` — every current client) `basket.trendCutoff` /
 * `queriesAddedSince` DIVERGE from the real report path (they read the latest run
 * instead of the earliest). Output is therefore NOT yet byte-identical to the report
 * on those two date fields — do not rely on basket dates from this helper until fixed.
 * Fix = scan every dated run folder for snapshots (like the `report` command) + add an
 * E2E test.
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
const lang = process.argv[3] || 'en';

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

const trackerVersion = JSON.parse(
  fs.readFileSync(path.join(here, '../package.json'), 'utf8'),
).version;
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
// ⚠️ KNOWN BUG (see file header): `[]` must become the full array of dated-run
// snapshots — else basket.trendCutoff/queriesAddedSince are wrong for basketHistory:null.
const payload = buildMcMetadata(summary, [], { trackerVersion, lang, config });

const outPath = path.join(runDir, 'mc-payload.json');
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(
  `✅ wrote ${outPath} (${kb} KB) — brand=${payload.identity?.brand} ` +
  `domain=${payload.identity?.domain} lang=${lang}`,
);
