/**
 * E2E — what the report's "Webappski plan" card offers is what webappski.com
 * offers (AP-1, 2026-10-24).
 *
 * Until 1.16.1 the card promised "First 10 founding clients free" in three
 * places while webappski.com had stopped saying it (the site's own guard is
 * `e2e/pricing-two-cards-ssr.spec.ts` in webappka). The card now says what the
 * live `/aeo-plan-invoice` page says: €129 one-time, ask for an invoice,
 * nothing is charged until the reader says yes. The free pilot is a different
 * offer (three places a month, by application) and lives only in the CLI line
 * that `run` / `run-manual` print — pinned in run-replay.test.js and
 * run-manual.test.js.
 *
 *   G1 — no "first 10 / founding client" promise anywhere a reader can see it:
 *        the card in all four report languages AND the whole replay-rendered
 *        report.html (the CSS is inlined there, so its comments count), and no
 *        trace of the old pricing keys in the card's source.
 *   G2 — the three replacement texts sit where the old promise sat
 *        (`.setup-second`, the Trade-offs list of `.fk-tip-cur`, `.pr-promo`),
 *        with the price substituted — not the literal `${price}`.
 *   G3 — the paragraph under the headline says "hand-build" once; the old copy
 *        said it twice in a row.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeMarkup } from '../../lib/report/mc-bridge.js';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  reportsDateDir,
  todayDateString,
  offlineFetchEnv,
} from './_helpers.js';

// Literal copy of FIRST10 from webappka e2e/pricing-two-cards-ssr.spec.ts:484 —
// the pattern the site's guard uses for "first 10 / founding client" in en, de,
// pl and ru. Another repo cannot be imported; keep the two in step by hand.
const FIRST10 = /first 10|ersten 10|pierwsz\S* 10|первы\S* 10|founding client|Gründungskund|klient\p{L}*-założyc|клиент\p{L}*-основател/iu;

const LANGS = ['en', 'de', 'ru', 'pl'];
const cardFor = (lang) => bridgeMarkup({ metadata: { identity: { lang } } });
const BRIDGE_ANCHOR = /<article[^>]*\bid="mc-bridge"/;

const SETUP_SECOND = /<p class="setup setup-second">([\s\S]*?)<\/p>/;
const PR_PROMO = /<p class="pr-promo">([\s\S]*?)<\/p>/;
const TIP_CUR_TRADEOFFS = /<div class="fk-tip fk-tip-cur"[\s\S]*?<div class="fk-tip-section tradeoffs">([\s\S]*?)<\/ul>/;

const WANT_SETUP_SECOND =
  '<b>Or skip the DIY step</b> — we hand-build the plan for you: <b>€129 per plan</b>, one-time. Ask for an invoice and we\'ll email it over.';
const WANT_TRADEOFF =
  '<li><span><b>Not free</b> — €129 per plan, one-time; the DIY route is the free one.</span></li>';
const WANT_PROMO =
  'A person reads every request and replies — <b>nothing is charged until you say yes.</b>';

function squash(s) {
  return s.replace(/\s+/g, ' ').trim();
}

test('G1 — the card makes no "first 10 / founding client" promise in any of the four report languages', () => {
  for (const lang of LANGS) {
    const html = cardFor(lang);
    // 0 matches proves nothing if the card is not there at all.
    assert.match(html, BRIDGE_ANCHOR, `${lang}: the mc-bridge card must be rendered`);
    const hit = html.match(FIRST10);
    assert.strictEqual(hit, null, `${lang}: card must not promise "first 10 / founding client" — found "${hit && hit[0]}"`);
  }
});

test('G1 — the card source carries no early-bird / founding keys', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../lib/report/mc-bridge.js', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(src, /earlyBird|founding/i, 'mc-bridge.js must not keep the early-bird pricing keys');
});

test('G1 — the whole replay-rendered report.html has no "first 10 / founding client" promise', async () => {
  await withTmpProject('aeo-e2e-offer-alignment-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const env = offlineFetchEnv({ GEMINI_API_KEY: 'test-key-do-not-use-real' });
    const run = spawnCli(['run', '--replay', '--replay-from=2026-05-13'], { cwd: dir, env });
    assertExitCode(run, 0, 'stable replay should exit 0');
    const rep = spawnCli(['report', '--no-open', '--offline'], { cwd: dir, env });
    assertExitCode(rep, 0, 'report --no-open --offline should exit 0');

    const html = readFileSync(join(reportsDateDir(dir, 'testbrand.com', todayDateString()), 'report.html'), 'utf8');
    assert.match(html, BRIDGE_ANCHOR, 'report.html must contain the mc-bridge card, or the check below proves nothing');
    const hit = html.match(FIRST10);
    assert.strictEqual(hit, null, `report.html must not promise "first 10 / founding client" — found "${hit && hit[0]}"`);
  });
});

test('G2 — the replacement texts sit under the headline, in Trade-offs and under the button, price filled in', () => {
  for (const lang of LANGS) {
    const html = cardFor(lang);

    const setup = html.match(SETUP_SECOND);
    assert.ok(setup, `${lang}: .setup-second paragraph is missing`);
    assert.strictEqual(squash(setup[1]), WANT_SETUP_SECOND, `${lang}: .setup-second text`);

    const tradeoffs = html.match(TIP_CUR_TRADEOFFS);
    assert.ok(tradeoffs, `${lang}: Trade-offs list of .fk-tip-cur is missing`);
    assert.ok(
      squash(tradeoffs[1]).includes(WANT_TRADEOFF),
      `${lang}: Trade-offs must carry the "Not free" line — got ${squash(tradeoffs[1])}`,
    );

    const promo = html.match(PR_PROMO);
    assert.ok(promo, `${lang}: .pr-promo paragraph is missing`);
    assert.strictEqual(squash(promo[1]), WANT_PROMO, `${lang}: .pr-promo text`);

    for (const [where, text] of [['.setup-second', setup[1]], ['trade-offs', tradeoffs[1]], ['.pr-promo', promo[1]]]) {
      assert.ok(!text.includes('${'), `${lang}: ${where} leaked an unfilled template placeholder`);
    }
  }
});

test('G3 — the paragraph under the headline says "hand-build" exactly once', () => {
  for (const lang of LANGS) {
    const setup = cardFor(lang).match(SETUP_SECOND);
    assert.ok(setup, `${lang}: .setup-second paragraph is missing`);
    const n = setup[1].split('hand-build').length - 1;
    assert.strictEqual(n, 1, `${lang}: "hand-build" must appear once in .setup-second, got ${n}`);
  }
});
