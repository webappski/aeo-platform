// Runtime Node version gate (1.1.8, AP-FAIL-BRANCHES).
//
// package.json `engines` only produces an npm WARNING at install time — most
// clients never see it. On Node < 20 the CLI used to die mid-run with a bare
// runtime error (e.g. `fetch is not a function` on Node 16) — a cryptic death
// on the very first command. This gate turns that into one plain sentence
// with one next step, before any network/provider code runs.

/**
 * @param {string} versionString  e.g. process.versions.node → '18.19.1'
 * @param {number} [minMajor=20]
 * @returns {{ok: boolean, message?: string}}
 */
export function checkNodeVersion(versionString, minMajor = 20) {
  const major = Number(String(versionString || '').split('.')[0]);
  if (Number.isFinite(major) && major >= minMajor) return { ok: true };
  return {
    ok: false,
    message: `aeo-platform requires Node.js >= ${minMajor} — you are running v${versionString}.\nInstall the current LTS from https://nodejs.org and re-run this command.`,
  };
}
