// Recovery layer for two "declined and stuck" prompts in init --auto: a
// too-short brand name, and a brand that isn't found anywhere on the fetched
// site. Both used to be a bare "Continue anyway? [y/N]" — declining either
// one aborted the whole init (the short-brand case even called
// process.exit(0) directly), with no way to just fix the typo that triggered
// the warning in the first place. The only recovery was Ctrl+C and starting
// init over. These give the user a way to re-enter the brand in place.

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function colors(useColor) {
  return useColor
    ? { red: RED, yellow: YELLOW, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', dim: '', bold: '', reset: '' };
}

/**
 * Interactive TTY prompt after a "brand name is very short" warning. Caller
 * loops while brand.length <= 3; this handles one round of that loop.
 *
 * @param {Object} opts
 * @param {string} opts.brand
 * @param {(q: string, d?: string) => Promise<string>} opts.ask  matches the init ask helper
 * @param {boolean} [opts.useColor]
 * @returns {Promise<{action:'continue'}|{action:'reenter', brand:string}>}
 */
export async function promptShortBrand({ brand, ask, useColor = true }) {
  const c = colors(useColor);
  console.log(`${c.yellow}⚠${c.reset} Brand "${brand}" is very short. Mention detection may produce false positives (e.g. "AI" matches every "ai" word in answers).`);
  const choice = (await ask(
    `  [1] Re-enter brand name (default)\n  [2] Continue anyway\nChoose [1/2]: `,
    '1'
  )).trim();
  if (choice === '2') return { action: 'continue' };
  const next = (await ask(`Brand name (e.g. webappski): `, brand)).trim();
  return { action: 'reenter', brand: next || brand };
}

/**
 * Interactive TTY prompt after a "brand not found on fetched site" warning.
 * Caller loops while the (possibly re-entered) brand still doesn't match the
 * already-fetched site content — no re-fetch needed, since the fetched text
 * doesn't depend on the brand name.
 *
 * @param {Object} opts
 * @param {string} opts.brand
 * @param {string} opts.fullUrl
 * @param {(q: string, d?: string) => Promise<string>} opts.ask  matches the init ask helper
 * @param {boolean} [opts.useColor]
 * @returns {Promise<{action:'continue'}|{action:'manual'}|{action:'reenter', brand:string}>}
 */
export async function promptBrandNotFound({ brand, fullUrl, ask, useColor = true }) {
  const c = colors(useColor);
  console.log(`${c.yellow}⚠${c.reset} Brand "${brand}" not found anywhere on ${fullUrl}.`);
  console.log(`  Possible: typo in brand, wrong domain, or brand not on homepage.`);
  const choice = (await ask(
    `  [1] Re-enter brand name (default)\n  [2] Enter queries manually\n  [3] Continue anyway\nChoose [1/2/3]: `,
    '1'
  )).trim();
  if (choice === '2') return { action: 'manual' };
  if (choice === '3') return { action: 'continue' };
  const next = (await ask(`Brand name (e.g. webappski): `, brand)).trim();
  return { action: 'reenter', brand: next || brand };
}
