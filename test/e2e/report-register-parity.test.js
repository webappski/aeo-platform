/**
 * E2E — the report speaks ONE design language, through the real `report`
 * command.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The 2026-08 redesign gave the report a loud spine (`lr-*`) but left the
 * bento tail of every section on the previous register: it did not consume
 * the depth ladder declared in `:root`, its type was tuned for a serif that
 * is no longer embedded, and its "quiet" card was painted the colour of the
 * page. The result was two dialects on one page rather than two volumes of
 * one voice. 2026-09-01 pulled the bento level onto the same tokens.
 *
 * Nothing in the suite could have caught that drift, and nothing would catch
 * it coming back: it is entirely a matter of which CSS *ships inside the
 * generated report*. So this file asserts against the `<style>` block of a
 * report the CLI actually wrote — not against `lib/report/styles.css` on
 * disk, which is only one of the two stylesheets that end up in there
 * (`mc-bridge.css` is concatenated in at html.js:346-349, and a check that
 * reads the source file alone silently skips the revenue card).
 *
 * WHAT IT PINS
 *   1. Zero `font-variation-settings` in the shipped CSS. Those axes
 *      (`opsz`/`SOFT`) belong to Fraunces; the embedded face is Geist, which
 *      carries only `wght`, so every such declaration was inert. This is the
 *      binary anchor — it is also the assertion the mutation check flips.
 *   2. A named list of card shells consumes the depth ladder, rather than the
 *      ladder being declared in `:root` and used by two components.
 *   3. A card is never painted the colour of the page, and an inset well is
 *      never painted the colour of its own parent. Both directions, not just
 *      "these two differ" — the loose form survives the flip it exists to
 *      catch.
 *   4. The same rank of heading is set the same way in both registers.
 *   5. The CTA card's elevation is the SAME EXPRESSION as the dominant bento
 *      card. `mc-bridge.css` used to claim this in a code comment while
 *      holding a hand-copied literal; the claim is now machine-checked.
 *
 * ZERO paid API calls: the run is seeded from `_summary.json` files on disk,
 * so `run` is never invoked, and `offlineFetchEnv()` fails every outbound
 * request in the subprocess deterministically.
 */
import test from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  offlineFetchEnv,
  responsesDateDir,
  reportsDateDir,
} from './_helpers.js';

const DOMAIN = 'testbrand.com';
const ENV = offlineFetchEnv({
  OPENAI_API_KEY: 'test-key-do-not-use-real',
  GEMINI_API_KEY: 'test-key-do-not-use-real',
});

const ENGINES = [
  { provider: 'openai', label: 'ChatGPT', model: 'gpt-5' },
  { provider: 'gemini', label: 'Gemini', model: 'gemini-3.5-flash' },
];
const dateOfRun = (i) => `2026-03-0${i + 1}`;

function summaryFor(runIndex, score) {
  const results = ENGINES.map((e, ei) => ({
    query: 'Q1', queryText: 'best test tools',
    provider: e.provider, label: e.label, model: e.model, mode: 'web',
    mention: (runIndex === 2 && ei === 1) ? 'no' : 'yes',
    position: null, citationCount: 1,
    canonicalCitations: ['https://testbrand.com/a', 'https://g2.com/x'],
    competitors: ['RivalCo'], responseQuality: 'ok', hasBrandInCitations: true,
    responseExcerpt: 'An answer about test tools.',
    elapsedMs: 10, inputTokens: 10, outputTokens: 10, costUsd: 0,
  }));
  return {
    date: dateOfRun(runIndex), brand: 'TestBrand', domain: DOMAIN, score,
    mentions: results.filter(r => r.mention === 'yes').length,
    total: results.length, errors: 0, sessionCostUsd: 0,
    llmActions: [
      { title: 'Publish a comparison page', detail: 'Target the query a rival wins.', priority: 'high', kind: 'gap' },
    ],
    topCompetitors: [{ name: 'RivalCo', count: 3 }],
    topDomains: [
      { host: DOMAIN, count: 2, share: 0.5 },
      { host: 'g2.com', count: 2, share: 0.5 },
    ],
    topCanonicalSources: [{ url: 'https://g2.com/x', count: 2 }],
    results,
  };
}

/** Seed three runs — enough for the report to render its full bento tail. */
function seedRuns(dir, n = 3) {
  for (let i = 0; i < n; i++) {
    const dd = responsesDateDir(dir, DOMAIN, dateOfRun(i));
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, '_summary.json'), JSON.stringify(summaryFor(i, 50 + i)));
  }
  writeFileSync(join(dir, '.aeo-tracker.json'), JSON.stringify({
    brand: 'TestBrand', domain: DOMAIN, queries: ['best test tools'],
    providers: { openai: { model: 'gpt-5', classifyModel: 'gpt-5-mini', env: 'OPENAI_API_KEY' } },
  }));
  return dateOfRun(n - 1);
}

/**
 * Render once and hand back the CSS the reader's browser will actually see:
 * the concatenation of styles.css + mc-bridge.css that html.js writes into
 * the single `<style>` block, with comments stripped so a rule quoted in
 * prose can never be mistaken for a live declaration.
 */
function shippedCss(dir) {
  const latest = seedRuns(dir);
  const r = spawnCli(['report', '--no-open'], { cwd: dir, env: ENV });
  assertExitCode(r, 0, 'report should exit 0');
  const html = readFileSync(join(reportsDateDir(dir, DOMAIN, latest), 'report.html'), 'utf-8');

  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  assert.ok(blocks.length > 0, 'the report shipped no <style> block at all');
  // The revenue card's stylesheet is only concatenated when the card renders.
  // If it stopped rendering, assertion 5 would pass vacuously — so require it.
  assert.match(html, /class="mc-bridge"/,
    'the CTA card did not render, so its stylesheet is absent and this spec would pass vacuously');

  return { css: blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, ''), html };
}

// ─── Tiny CSS reader ────────────────────────────────────────────────────────
// Deliberately not a parser: it answers exactly two questions — "which rules
// carry this exact selector" and "what does the cascade end up declaring for
// this property" — which is all these invariants need.

/** Bodies of every rule whose selector list contains `sel` verbatim. */
function rulesFor(css, sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(',').map(s => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(sel)) out.push(m[2]);
  }
  return out;
}

/** Last value the cascade declares for `prop` on `sel` (null when never set). */
function declared(css, sel, prop) {
  const found = [];
  for (const body of rulesFor(css, sel)) {
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g');
    let m;
    while ((m = re.exec(body))) found.push(m[1].trim().replace(/\s+/g, ' '));
  }
  return found.length ? found[found.length - 1] : null;
}

/**
 * Resolve a value down to a literal by following `:root` custom properties.
 * Without this, "the quiet card is not the colour of the page" degrades into
 * "these two token NAMES differ" — which two aliases of the same colour would
 * satisfy, and which is precisely the bug being guarded.
 */
function resolve(css, value, depth = 0) {
  if (value == null || depth > 10) return value;
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!m) return value.trim();
  const root = rulesFor(css, ':root').join(';');
  const decl = new RegExp(`(?:^|;)\\s*${m[1]}\\s*:\\s*([^;]+)`).exec(root);
  return decl ? resolve(css, decl[1].trim(), depth + 1) : value.trim();
}

/**
 * The token names a value references at the TOP level, in declaration order.
 * Anything nested inside a `var(…, fallback)` is skipped on purpose: a
 * fallback is what renders when the token is absent, so counting it would
 * make two values look different for a reason that never reaches the reader.
 */
function tokensIn(value) {
  const s = String(value || '');
  const out = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (depth === 0 && s.startsWith('var(', i)) {
      const m = /^var\(\s*(--[\w-]+)/.exec(s.slice(i));
      if (m) out.push(m[1]);
    }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
  }
  return out;
}

// ─── 1. The dead typographic layer stays dead ───────────────────────────────

test('the shipped CSS carries no font-variation-settings — the axes have no face to drive', async () => {
  await withTmpProject('aeo-e2e-register-axes-', async (dir) => {
    const { css } = shippedCss(dir);
    const hits = css.match(/font-variation-settings/g) || [];
    assert.equal(hits.length, 0,
      `${hits.length} font-variation-settings declaration(s) shipped. The embedded face is ` +
      `Geist (wght only, see lib/report/fonts/index.js); "opsz"/"SOFT" are Fraunces axes and ` +
      `resolve to nothing, so such a declaration is decoration on a corpse.`);
  });
});

// ─── 2. The depth ladder has consumers ──────────────────────────────────────

test('every card shell reads the depth ladder instead of being flat', async () => {
  // Named explicitly rather than "everything inside .bento": a list that
  // derives itself would quietly stop covering new components.
  // .eng-card is deliberately absent. It is not a card shell any more: since
  // 2026-09-01 it matches the portal's report-v2 engine tile — flat, no
  // shadow, identified by a 3px top rule in the engine's own colour. Its own
  // invariant is asserted separately below.
  const SHELLS = ['.cell', '.cell.dominant', '.act-row'];
  await withTmpProject('aeo-e2e-register-depth-', async (dir) => {
    const { css } = shippedCss(dir);
    for (const sel of SHELLS) {
      const shadow = declared(css, sel, 'box-shadow');
      assert.ok(shadow, `${sel} declares no box-shadow at all — it sits flat on the page`);
      assert.ok(/var\(--depth-/.test(shadow),
        `${sel} carries a hand-written shadow (${shadow}) instead of a --depth-* step`);
    }
  });
});

// ─── 3. A card is never the colour of what it sits on ───────────────────────

test('the quiet card is not the page, and the engine well is not its own card', async () => {
  await withTmpProject('aeo-e2e-register-surfaces-', async (dir) => {
    const { css } = shippedCss(dir);
    const page = resolve(css, declared(css, 'body', 'background'));
    const quiet = resolve(css, declared(css, '.cell.quiet', 'background'));

    for (const [name, v] of [['body', page], ['.cell.quiet', quiet]]) {
      assert.ok(v && !/^var\(/.test(v), `${name} background did not resolve to a literal (got ${v})`);
    }
    assert.notEqual(quiet, page,
      `.cell.quiet is painted ${quiet}, the same as the page — a container the colour of the ` +
      `page reads as unstyled space, not as a quiet card`);
  });
});

// ─── 3b. The engine tile is identified by its rule, not by a box ────────────

test('the engine tile carries its engine colour as a top rule and stays flat', async () => {
  // The tile stopped being a raised well on 2026-09-01 and became the portal's
  // report-v2 engine tile: flat, bordered, identified by a 3px rule in the
  // engine's own colour. Without this assertion the previous register — a
  // shadowed card on a card — can drift back unnoticed, which is exactly what
  // e537ce4 did before the founder rejected it.
  await withTmpProject('aeo-e2e-engine-tile-', async (dir) => {
    const { css } = shippedCss(dir);
    const shadow = declared(css, '.eng-card', 'box-shadow');
    assert.ok(!shadow,
      `.eng-card declares box-shadow (${shadow}) — the tile is meant to be flat; a shadow on ` +
      `four tiles inside one card reads as four competing cards`);
    const topRule = declared(css, '.eng-card', 'border-top');
    assert.ok(topRule && /3px/.test(topRule) && /var\(--c/.test(topRule),
      `.eng-card must carry a 3px top rule in var(--c), the engine's own colour (got ${topRule}) — ` +
      `that rule is the only thing identifying which engine the tile belongs to`);
  });
});

// ─── 4. One heading rank, one setting ───────────────────────────────────────

test('the action title is set exactly like the loud heading of the same rank', async () => {
  await withTmpProject('aeo-e2e-register-heading-', async (dir) => {
    const { css } = shippedCss(dir);
    for (const prop of ['font-size', 'font-weight']) {
      const legacy = declared(css, '.act-title', prop);
      const loud = declared(css, '.lr-h3', prop);
      assert.ok(legacy && loud, `${prop} missing on .act-title or .lr-h3`);
      assert.equal(resolve(css, legacy), resolve(css, loud),
        `.act-title ${prop} is ${legacy}, .lr-h3 is ${loud} — section 06 is what the client ` +
        `pays for and must not be set below the headings above it`);
    }
  });
});

// ─── 5. The CTA card's comment becomes an invariant ─────────────────────────

test('the CTA card carries the same elevation expression as the dominant bento card', async () => {
  await withTmpProject('aeo-e2e-register-cta-', async (dir) => {
    const { css } = shippedCss(dir);
    const bridge = declared(css, '.mc-bridge', 'box-shadow');
    const dominant = declared(css, '.cell.dominant', 'box-shadow');
    assert.ok(bridge && dominant, 'one of .mc-bridge / .cell.dominant declares no box-shadow');

    // Compared by the tokens referenced, in order — NOT by string equality.
    // mc-bridge.css must keep literal fallbacks so the card still renders
    // standalone (no report `:root`), so the two strings legitimately differ
    // while the elevation they express is the same.
    assert.deepEqual(tokensIn(bridge), tokensIn(dominant),
      `.mc-bridge resolves its elevation from ${JSON.stringify(tokensIn(bridge))} while ` +
      `.cell.dominant uses ${JSON.stringify(tokensIn(dominant))}. mc-bridge.css states in ` +
      `prose that it shares the depth language of .cell.dominant; if that is to stay true, ` +
      `the CTA — the most commercially loaded block on the page — cannot be the one flat ` +
      `card while every other card is raised.`);
  });
});
