// Regression test for Phase 1 audit P0 #1 (lang-aware URL) + the 2026-07-16
// waitlist→invoice retarget: the €129 "Webappski plan" CTA opens the open-entry
// request-invoice page (webappski.com/<lang>/aeo-plan-invoice), never the retired
// pre-release / mission-control waitlist. Guards both the lang-templating and the
// no-waitlist-regression at once.
import { readFileSync } from 'node:fs';

const src = readFileSync('lib/report/mc-bridge.js', 'utf8');

// The CTA URL must be lang-aware, never hardcoded to a single locale.
if (src.includes('webappski.com/ru/aeo-plan-invoice')) {
  console.error('FAIL: mc-bridge.js still contains hardcoded /ru/aeo-plan-invoice');
  process.exit(1);
}

// Must use the request-invoice page, derived per-locale.
if (!src.includes('${lang}/aeo-plan-invoice')) {
  console.error('FAIL: mc-bridge.js does not use the ${lang}/aeo-plan-invoice template');
  process.exit(1);
}

// No-regression: the waitlist / pre-release ENTRY point is retired (open entry
// via invoice as of 2026-07-16). Mission Control stays the delivery surface —
// the plan is generated into the customer's dashboard there — but the /aeo-
// mission-control URL must not come back as this card's CTA (entry = invoice).
if (src.includes('aeo-mission-control')) {
  console.error('FAIL: mc-bridge.js references aeo-mission-control (retired waitlist dead-end)');
  process.exit(1);
}
if (/join the waitlist/i.test(src)) {
  console.error('FAIL: mc-bridge.js still says "Join the waitlist" (retired — entry is open via invoice)');
  process.exit(1);
}

// The plan is open / hand-built now — "pre-release" framing is retired everywhere
// on this card (the visible diptych tag AND the hover tooltip tag). This guard
// covers the string class the aeo-mission-control / waitlist guards above miss.
if (/pre-release/i.test(src)) {
  console.error('FAIL: mc-bridge.js still carries "pre-release" framing (retired — the plan is open/hand-built)');
  process.exit(1);
}

// Delivery surface is the Mission Control dashboard, not email — the plan is
// generated into the customer's admin panel (live demo: /aeo-mission-control).
// "inbox" framing promises a channel we do not deliver on.
if (/inbox/i.test(src)) {
  console.error('FAIL: mc-bridge.js promises delivery to an "inbox" — the plan lands in the Mission Control dashboard');
  process.exit(1);
}

// Must still derive lang from metadata.identity.lang (or fallback).
if (!src.match(/metadata\s*&&\s*metadata\.identity\s*&&\s*metadata\.identity\.lang/)) {
  console.error('FAIL: mc-bridge.js does not derive lang from metadata.identity.lang');
  process.exit(1);
}

console.log('OK: mc-bridge.js uses lang-aware /aeo-plan-invoice CTA; no waitlist/mission-control regression');
