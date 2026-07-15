// Last-resort panel invoked by the top-level try/catch in bin/aeo-tracker.js.
// Any error that escapes the command-specific catches lands here — config file
// corruption, filesystem issues, unhandled provider edge cases, real bugs.
//
// The panel's job is to turn a raw Node stack trace into something a non-dev
// user can act on: what command they ran, what category the error belongs to,
// one concrete next step, and a link for filing a bug when we can't classify.

import { classifyAeoError, errToString } from '../providers/classify-error.js';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const CATEGORY_GUIDANCE = {
  network: {
    headline: 'Network error',
    steps: [
      'Check your internet connection (try loading a website in your browser).',
      'If you\'re on a corporate/VPN network, check that api.openai.com / generativelanguage.googleapis.com / api.anthropic.com are reachable.',
      'Rerun the same command once connectivity is restored.',
    ],
  },
  'bot-protection': {
    headline: 'Site is behind bot protection',
    steps: [
      'Your site\'s Cloudflare / captcha layer is blocking aeo-platform\'s fetch.',
      'Temporarily whitelist the aeo-platform User-Agent in your Cloudflare firewall rules.',
      'Or skip site fetch entirely: pass queries via --keywords="q1,q2,q3" during init.',
    ],
  },
  'site-fetch': {
    headline: 'Could not fetch your site',
    steps: [
      'Check the domain is live (load it in a browser from this machine).',
      'If the site uses a self-signed certificate, use http:// instead of https://.',
      'You can skip site fetch entirely with --keywords="q1,q2,q3" during init.',
    ],
  },
  config: {
    headline: 'Config file issue',
    steps: [
      'Check .aeo-tracker.json for JSON syntax errors (a missing comma or quote).',
      'Or regenerate a fresh config — pick one:',
      '  `aeo-platform init --yes --brand=... --domain=... --auto`         (LLM brainstorm)',
      '  `aeo-platform init --yes --brand=... --domain=... --manual --keywords="q1,q2,q3"`   (BYO queries, $0)',
    ],
  },
  filesystem: {
    headline: 'Filesystem error',
    steps: [
      'Check the current directory is writable (`ls -la` should show your user as owner).',
      'Check disk space (`df -h .`).',
      'If running in a Docker/CI container, mount the working directory read-write.',
    ],
  },
  billing: {
    headline: 'Provider billing issue',
    steps: [
      'Top up billing on the provider whose key you\'re using.',
      'See `aeo-platform --help` for the billing dashboard URLs per provider.',
    ],
  },
  auth: {
    headline: 'API key issue',
    steps: [
      'Regenerate the API key in the provider\'s console.',
      'Update the env var in your shell profile (~/.zshrc or ~/.bashrc) and `source` it.',
    ],
  },
  'rate-limit': {
    headline: 'Rate-limit hit',
    steps: [
      'Wait 1-2 minutes and rerun — rate limits reset quickly.',
      'If it persists, check your provider\'s rate-limit settings.',
    ],
  },
  'server-error': {
    headline: 'Provider server error',
    steps: [
      'The provider returned a transient 5xx (server-side hiccup) — aeo-platform already retried a few times.',
      'Wait a moment and rerun — these usually clear on their own.',
      'If it persists, the provider may be having an outage — check their status page, or use a different provider.',
    ],
  },
  'model-deprecated': {
    headline: 'Configured model is no longer available',
    steps: [
      'The provider removed (or renamed) the model in your .aeo-tracker.json.',
      'Re-run init to pick a current model — the init wizard will enumerate what\'s available now: `aeo-platform init`',
      'After init writes the new selection to .aeo-tracker.json, re-run your command.',
    ],
  },
  other: {
    headline: 'Unexpected error',
    steps: [
      'This is likely a bug in aeo-platform — the tool did not recognize this error.',
      'Please file a bug with the message above + your command: https://github.com/webappski/aeo-platform/issues',
      'Include: the command you ran, aeo-platform --version, and the error above.',
    ],
  },
};

/**
 * @param {Object} opts
 * @param {unknown} opts.err      The caught value from the top-level try
 * @param {string=} opts.command  Name of the subcommand that crashed ('init' / 'run' / ...)
 * @param {boolean} opts.useColor
 * @returns {string[]}  Lines for console.error
 */
export function formatUnexpectedErrorPanel({ err, command, useColor = true }) {
  const c = useColor
    ? { red: RED, yellow: YELLOW, dim: DIM, bold: BOLD, reset: RESET }
    : { red: '', yellow: '', dim: '', bold: '', reset: '' };

  const classified = classifyAeoError(err);
  const guidance = CATEGORY_GUIDANCE[classified.category] || CATEGORY_GUIDANCE.other;
  const rawMsg = errToString(err);
  const shortMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + '...' : rawMsg;

  const lines = [];
  lines.push('');
  lines.push(`${c.red}${c.bold}  ${guidance.headline}${command ? ` during \`aeo-platform ${command}\`` : ''}${c.reset}`);
  lines.push('');
  lines.push(`  ${c.dim}${shortMsg}${c.reset}`);
  lines.push('');
  lines.push(`${c.bold}  What to do:${c.reset}`);
  for (let i = 0; i < guidance.steps.length; i++) {
    lines.push(`    ${i + 1}. ${guidance.steps[i]}`);
  }

  // Always include a bug-report link — if the classification was wrong, we want
  // to know about it.
  if (classified.category !== 'other') {
    lines.push('');
    lines.push(`${c.dim}  If none of the above help, file a bug: https://github.com/webappski/aeo-platform/issues${c.reset}`);
  }
  lines.push('');

  return lines;
}
