const STANDARD = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
};

// Heuristic regexes to catch non-standard env var names like OPENAI_API_KEY_DEV,
// CLAUDE_KEY, GOOGLE_AI_TOKEN, PPLX_API_KEY, etc.
const HEURISTIC_PATTERNS = {
  openai: /^(OPENAI|GPT)[_A-Z0-9]*(?:API|KEY|TOKEN)/i,
  anthropic: /^(CLAUDE|ANTHROPIC)[_A-Z0-9]*(?:API|KEY|TOKEN)/i,
  gemini: /^(GEMINI|GOOGLE_?AI|GOOGLE_GENAI)[_A-Z0-9]*(?:API|KEY|TOKEN)/i,
  perplexity: /^(PERPLEXITY|PPLX)[_A-Z0-9]*(?:API|KEY|TOKEN)/i,
};

const MIN_KEY_LEN = 20;

/**
 * Check env for standard API key names. Returns { provider: envName | null }.
 */
export function detectStandardKeys(env = process.env) {
  const out = {};
  for (const [provider, name] of Object.entries(STANDARD)) {
    out[provider] = env[name] ? name : null;
  }
  return out;
}

/**
 * Scan env for non-standard names matching provider heuristics.
 * Returns { provider: [candidateEnvName, ...] } — multi-match possible.
 */
export function heuristicKeyMatch(env = process.env) {
  const out = { openai: [], gemini: [], anthropic: [], perplexity: [] };
  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== 'string' || value.length < MIN_KEY_LEN) continue;
    if (STANDARD.openai === key || STANDARD.gemini === key ||
        STANDARD.anthropic === key || STANDARD.perplexity === key) continue; // skip standard (already handled)
    for (const [provider, pattern] of Object.entries(HEURISTIC_PATTERNS)) {
      if (pattern.test(key)) out[provider].push(key);
    }
  }
  return out;
}

export const PROVIDER_LABELS = {
  openai: 'OpenAI (ChatGPT)',
  gemini: 'Google (Gemini)',
  anthropic: 'Anthropic (Claude)',
  perplexity: 'Perplexity',
};

/**
 * Platform-aware key-setup instructions (1.1.8, AP-FAIL-BRANCHES).
 * The old hard-coded `~/.zshrc` lines read as gibberish to Windows clients —
 * the largest first-run audience after macOS. One set of copy-paste lines per
 * platform, ONE next step each.
 *
 * @param {string} [platform=process.platform]
 * @returns {string[]} printable lines
 */
export function keySetupLines(platform = process.platform) {
  if (platform === 'win32') {
    return [
      'Set them (PowerShell — run once):',
      '  setx OPENAI_API_KEY "sk-proj-..."',
      '  setx GEMINI_API_KEY "AIzaSy..."',
      'Then open a NEW terminal and run: aeo-platform init',
    ];
  }
  return [
    'Add to ~/.zshrc (or your shell profile):',
    '  export OPENAI_API_KEY=sk-proj-...',
    '  export GEMINI_API_KEY=AIzaSy...',
    'Then: source ~/.zshrc && aeo-platform init',
  ];
}
