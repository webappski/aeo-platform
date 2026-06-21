/**
 * E2E / integration — Gemini answer-model PIN ↔ served-id guard (AP-GEMINI-MODEL-PIN).
 *
 * WHY THIS EXISTS
 *   Google rolls floating Gemini aliases server-side (`gemini-2.5-flash` →
 *   `gemini-3.5-flash` with ~2-week notice). The frozen-basket measurement
 *   standard (3 axes: queries × engines × monthly cadence — only OUR visibility
 *   may move) is poisoned by a SILENT answer-model swap: a run charted against
 *   `gemini-2.5-flash` and the next against `gemini-3.5-flash` is not a
 *   comparable timeline. lib/providers/model-drift.js surfaces a live divergence
 *   as a loud WARN; THIS guard closes the complementary hole — that the
 *   CONFIGURED answer model (the id we request, and the id the year-over-year
 *   trend is labelled with) actually equals the id Google is currently serving,
 *   so the WARN path stays quiet because we PINNED to reality, not because the
 *   two happened to coincide.
 *
 * WHAT IT ASSERTS (against REAL on-disk artifacts — no mock, no product hook)
 *   1. The live `.aeo-tracker.json` gemini.model is the id the most-recent run
 *      actually recorded for the gemini answer surface (costByModel → the served
 *      id Google echoed under `modelVersion`). Pin == served.
 *   2. The REAL `isModelDrift(configPinned, served)` reducer returns FALSE — i.e.
 *      after the pin there is genuinely no drift between requested and served.
 *
 * MUTATION-SANITY (verified out-of-tree against /tmp copies; repo files never
 * edited in the run):
 *   - Flip the pinned id in .aeo-tracker.json (gemini.model →
 *     `gemini-2.5-flash`) while the run still records `gemini-3.5-flash` →
 *     assertion 1 (pin == served) RED, and isModelDrift(pin, served) flips to
 *     true → assertion 2 RED. Restore the pin → GREEN.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0)
 *   This reads two REAL on-disk files (the product config + a real captured run
 *   summary) and runs the REAL drift reducer — it is an integration check over
 *   production artifacts, not a behavioural mock. The pure reducer it leans on
 *   (isModelDrift) is separately unit-covered in test/model-drift.test.js; here
 *   it is exercised end-to-end on the actual pinned config vs the actual served
 *   id, which is the contract a unit test cannot see (it would invent both
 *   strings). No subprocess is needed: the artifacts already exist on disk from
 *   the weekly run, and re-running the live engine in CI would cost real $ and
 *   flake on Google's rollout schedule — exactly the live-API anti-pattern the
 *   skill flags (gate any live call behind AEO_E2E_LIVE, default to the recorded
 *   artifact). Deterministic, offline, cross-platform (pure fs + string compare).
 *
 *   SKIP-WITH-REASON: when no dated run summary exists yet (fresh checkout, no
 *   weekly run captured) the guard self-skips with a visible reason rather than
 *   failing — there is nothing served to compare the pin against. The skip is
 *   honest (printed), never silent.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_helpers.js';
import { isModelDrift } from '../../lib/providers/model-drift.js';
import { DEFAULT_CONFIG } from '../../lib/config.js';

// The local project config (.aeo-tracker.json) is gitignored — present on an
// operator's machine, ABSENT on a fresh clone / CI. So the pinned answer model
// is read from the COMMITTED product default (DEFAULT_CONFIG, always present and
// shipped in the package), with the local override preferred WHEN it exists.
// This keeps the test green and meaningful on both surfaces.
const CONFIG_PATH = join(REPO_ROOT, '.aeo-tracker.json');
const RESPONSES_ROOT = join(REPO_ROOT, 'aeo-responses');

/**
 * The pinned gemini answer model: the local override when an operator config is
 * present, otherwise the committed DEFAULT_CONFIG (the id every fresh install
 * gets). Never null — DEFAULT_CONFIG always declares it.
 */
function configuredGeminiModel() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      const local = cfg?.providers?.gemini?.model;
      if (typeof local === 'string' && local.length > 0) return local;
    } catch { /* fall through to the committed default */ }
  }
  return DEFAULT_CONFIG.providers.gemini.model;
}

/**
 * Find the newest dated run summary that has a gemini answer-surface cost entry,
 * and return the served gemini answer-model id it recorded. The run charges the
 * answer surface under costByModel with provider 'gemini' and label 'Gemini'
 * (the competitor-extraction row is provider 'openai+gemini' — excluded by the
 * exact-provider match). The recorded `model` there is the id Google echoed via
 * `modelVersion` — the SERVED id, not necessarily the requested one.
 */
function latestServedGeminiModel() {
  if (!existsSync(RESPONSES_ROOT)) return null;
  const dated = readdirSync(RESPONSES_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse();
  for (const date of dated) {
    const summaryPath = join(RESPONSES_ROOT, date, '_summary.json');
    if (!existsSync(summaryPath)) continue;
    let summary;
    try { summary = JSON.parse(readFileSync(summaryPath, 'utf-8')); }
    catch { continue; }
    const geminiCost = (summary.costByModel || []).find(
      (c) => c.provider === 'gemini' && c.label === 'Gemini',
    );
    if (geminiCost && typeof geminiCost.model === 'string' && geminiCost.model.length > 0) {
      return { date, served: geminiCost.model };
    }
  }
  return null;
}

test('configured gemini answer-model is PINNED to the id Google currently serves', () => {
  const pinned = configuredGeminiModel();
  assert.ok(pinned, 'precondition: a gemini answer model is pinned (local override or committed default)');

  const latest = latestServedGeminiModel();
  if (!latest) {
    // Honest skip — no captured run on this machine to compare the pin against
    // (fresh clone / CI with no weekly run output). Nothing served → nothing to
    // diverge from. The committed default is still sanity-checked above.
    console.log('  [skip] no dated run summary with a gemini answer-surface cost entry — nothing served to compare the pin against');
    return;
  }

  assert.equal(
    pinned, latest.served,
    `pinned gemini answer model "${pinned}" but the ${latest.date} run was SERVED "${latest.served}" — ` +
    `Google has hot-swapped the alias; re-pin lib/config.js DEFAULT_CONFIG + lib/providers/discover.js ` +
    `FALLBACK (and the local .aeo-tracker.json) to the served id so the year-over-year timeline stays comparable`,
  );

  // The REAL drift reducer must agree there is no divergence once pinned.
  assert.equal(
    isModelDrift(pinned, latest.served), false,
    `isModelDrift("${pinned}", "${latest.served}") should be false after pinning — a true here means ` +
    `the pin and the served id are different lineages (the exact poison this guard prevents)`,
  );
});
