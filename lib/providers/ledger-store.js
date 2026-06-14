// Cross-run persistence for the learned TPM ledger (AP-RATELIMIT-UX).
//
// The tpm-ledger learns each engine's real token-per-minute ceiling from 429
// bodies and 200 headers during a run — then forgets it when the process
// exits. So every weekly run re-discovers the same limits by hitting them
// again (an avoidable 429 + cooldown each time). This module persists the
// learned ceilings to a small JSON file beside the responses dir and seeds the
// ledger on the next run.
//
// Robustness contract: a missing / corrupt / unreadable ledger file must NEVER
// break a run. A persisted limit is an optimisation, not correctness — load
// failures degrade to "learn from scratch this run" (the pre-existing
// behaviour), silently.

import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../util/atomic-write.js';
import { exportLearnedLimits, importLearnedLimits } from './tpm-ledger.js';

export const LEDGER_FILE = 'aeo-responses/.tpm-ledger.json';

/**
 * Load persisted learned limits into the in-memory ledger.
 * @param {string} [path=LEDGER_FILE]
 * @returns {Promise<number>} count of limits seeded (0 on any failure)
 */
export async function loadLedger(path = LEDGER_FILE) {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    // Tolerate both the bare map and a { limits: {...} } envelope.
    const limits = parsed && parsed.limits && typeof parsed.limits === 'object'
      ? parsed.limits
      : parsed;
    return importLearnedLimits(limits);
  } catch {
    return 0; // missing or corrupt — learn from scratch this run
  }
}

/**
 * Persist the current learned limits. Atomic write (tmp+rename) so an
 * interrupted save never leaves a half-file the next load would choke on.
 * No-op (no file written) when nothing has been learned yet.
 * @param {string} [path=LEDGER_FILE]
 * @returns {Promise<number>} count of limits written
 */
export async function saveLedger(path = LEDGER_FILE) {
  const limits = exportLearnedLimits();
  const count = Object.keys(limits).length;
  if (count === 0) return 0;
  try {
    await atomicWriteJson(path, { updatedAt: new Date().toISOString(), limits });
  } catch {
    // Saving the ledger is best-effort — never surface a write failure as a
    // run failure (the run already produced its report).
    return 0;
  }
  return count;
}
