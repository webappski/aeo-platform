// Local-vs-global mismatch detector (1.2.x, version-awareness package).
//
// The exact trap: a project carries aeo-platform vNEW in node_modules, but a
// bare `aeo-platform` in the shell resolves the GLOBAL vOLD binary — and the
// client has no idea which one ran. When the project copy is NEWER than the
// running build, the CLI warns and points at `npx` / `npm exec`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cmpVersions } from './update-check.js';

/**
 * @param {Object} opts
 * @param {string} [opts.cwd]
 * @param {string} opts.runningVersion  version of the binary currently executing
 * @param {string} [opts.runningUrl]    import.meta.url of the running bin —
 *                                      suppresses the warning when the running
 *                                      binary IS the project-local copy
 * @returns {{localVersion: string}|null}  null = no warning needed
 */
export function detectNewerLocalCopy({ cwd = process.cwd(), runningVersion, runningUrl }) {
  try {
    const localRoot = join(cwd, 'node_modules', 'aeo-platform');
    const pkgPath = join(localRoot, 'package.json');
    if (!existsSync(pkgPath)) return null;
    if (runningUrl && runningUrl.startsWith(pathToFileURL(localRoot).href)) return null;
    const localVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    if (cmpVersions(localVersion, runningVersion) === 1) return { localVersion };
    return null;
  } catch {
    return null; // detector must never break a command
  }
}
