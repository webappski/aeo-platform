// Atomic JSON write — tmp file + rename (1.1.8, AP-FAIL-BRANCHES).
//
// A plain writeFile interrupted by Ctrl+C / crash / power loss leaves a
// PARTIAL file. For _summary.json that is the worst failure class: the next
// run/report/diff reads corrupted JSON and the client never learns why.
// rename() is atomic on POSIX and effectively-atomic on Windows for
// same-directory moves, so readers see either the old file or the new one —
// never a half-written state.

import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/**
 * @param {string} path        destination file path
 * @param {any}    obj         JSON-serializable value
 * @param {number} [indent=2]
 */
export async function atomicWriteJson(path, obj, indent = 2) {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tmpPath = `${path}.tmp-${suffix}`;
  await writeFile(tmpPath, JSON.stringify(obj, null, indent));
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // rename failed (cross-device move, permissions, dest is a dir, ENOSPC):
    // the tmp file would otherwise linger forever next to the real file and
    // accumulate on every retry. Best-effort cleanup, then re-throw the
    // original error so the caller still learns the write failed.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
