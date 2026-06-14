// Live key-authentication probe for `init` (fail-branch #1 + #3, AP-FAILBRANCH-REMAINDER).
//
// PROBLEM this solves: until now `init` only ran a FORMAT check on each key
// (regex prefix + length). A key that is the right SHAPE but revoked / typo'd /
// from the wrong project sailed through init and only blew up later at `run` —
// after the client had invested in queries/competitors. For our trump-card
// product the install bar is "no install problems in principle"
// (founder, 2026-06-11) — so we confirm each present key actually
// AUTHENTICATES before init declares success.
//
// DESIGN (founder + architect approved):
//   - ONE lightweight live discovery GET per present key (reuses discoverModels,
//     which hits /v1/models — small JSON, no token cost, no model call).
//   - ALWAYS on by default; `--no-key-check` opts out for offline / CI.
//   - probe goes through discoverModels() ONLY (never the raw fetchers — those
//     THROW on non-auth). discoverModels maps every outcome to
//     { models, authError } and never throws.
//
// OUTCOME MAPPING (the never-fail contract — invariants I-1 / I-3):
//   authError === true                 → hard fail: key does not authenticate.
//                                        Caller prints ONE actionable step +
//                                        exit(1). Identical in --yes.
//   models === null && authError===false → network / 5xx / shape change: the
//                                        key MIGHT be fine, we just couldn't
//                                        reach the provider. SILENT degrade to
//                                        the existing format-only check. Network
//                                        NEVER fails init.
//   models is an array                  → key authenticates. pass.
//
// I-4 (#3 heuristic disambiguation) is handled by the CALLER: it runs the probe
// over the heuristic-accepted candidates and drops the ones that come back
// authError, keeping the first that authenticates — the probe itself is a pure
// per-key verdict, it does not pick between candidates.

/**
 * @typedef {Object} ProbeVerdict
 * @property {string}  provider
 * @property {string}  envVar               the env var NAME holding the key
 * @property {'ok'|'auth-fail'|'unreachable'} status
 */

/**
 * Probe every present key IN PARALLEL (I-6: Promise.all, never serial — a
 * 4-key client must not wait 4×10s). Each task is wrapped so one rejection
 * can never reject the whole batch (defensive — discoverModels already
 * swallows, this is belt-and-suspenders).
 *
 * @param {Object} providerKey  { provider: envVarName } — present keys only
 * @param {Object} [deps]
 * @param {(provider:string, apiKey:string)=>Promise<{models:any,authError:boolean}>} [deps.discoverFn]
 *        injectable for tests; defaults to the real discoverModels.
 * @param {NodeJS.ProcessEnv} [deps.env]   injectable env (tests); default process.env
 * @returns {Promise<ProbeVerdict[]>}
 */
export async function probeKeys(providerKey, deps = {}) {
  const env = deps.env || process.env;
  let discoverFn = deps.discoverFn;
  if (!discoverFn) {
    // Lazy import keeps this module loadable in tests without a network stack,
    // and lets us pass { quiet: true } so the always-on [discover-warn] line
    // (discover.js:300) does not surface a misleading "response shape changed"
    // message when the real cause is an offline network (I-8).
    const mod = await import('../providers/discover.js');
    discoverFn = (provider, apiKey) => mod.discoverModels(provider, apiKey, undefined, { quiet: true });
  }

  const entries = Object.entries(providerKey);
  return Promise.all(
    entries.map(async ([provider, envVar]) => {
      try {
        const apiKey = env[envVar];
        if (!apiKey) {
          // Caller already verified presence; if it's gone now, treat as
          // unreachable (silent degrade) rather than a false auth failure.
          return { provider, envVar, status: 'unreachable' };
        }
        const { models, authError } = await discoverFn(provider, apiKey);
        if (authError === true) return { provider, envVar, status: 'auth-fail' };
        if (models == null) return { provider, envVar, status: 'unreachable' };
        return { provider, envVar, status: 'ok' };
      } catch {
        // discoverModels is contracted not to throw; if some future edit
        // breaks that, fail SAFE — never let the probe wall a valid key.
        return { provider, envVar, status: 'unreachable' };
      }
    }),
  );
}

/**
 * Reduce a batch of verdicts to the single decision the init flow needs.
 *
 * @param {ProbeVerdict[]} verdicts
 * @returns {{ authFailed: ProbeVerdict[], anyUnreachable: boolean, allOk: boolean }}
 */
export function summarizeProbe(verdicts) {
  const authFailed = verdicts.filter(v => v.status === 'auth-fail');
  const anyUnreachable = verdicts.some(v => v.status === 'unreachable');
  const allOk = verdicts.length > 0 && verdicts.every(v => v.status === 'ok');
  return { authFailed, anyUnreachable, allOk };
}

/**
 * The ONE actionable step shown when a key fails to authenticate (I-1 / I-3:
 * exit(1) with a single next step, identical in --yes). Provider-aware key URL.
 *
 * @param {ProbeVerdict} verdict  a status:'auth-fail' verdict
 * @param {Object<string,string>} labels  PROVIDER_LABELS
 * @returns {string[]} printable lines
 */
export function authFailLines(verdict, labels) {
  const KEY_URLS = {
    openai: 'https://platform.openai.com/api-keys',
    gemini: 'https://aistudio.google.com/apikey',
    anthropic: 'https://console.anthropic.com/settings/keys',
    perplexity: 'https://www.perplexity.ai/settings/api',
  };
  const label = labels[verdict.provider] || verdict.provider;
  const url = KEY_URLS[verdict.provider];
  return [
    `${label}: the key in $${verdict.envVar} did not authenticate (the provider rejected it with 401/403).`,
    `  Fix: issue a fresh key${url ? ` at ${url}` : ''} and update $${verdict.envVar}, then re-run: aeo-platform init`,
  ];
}
