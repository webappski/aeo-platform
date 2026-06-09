// Regression test for the non-expert PASTE_PROMPT rewrite (CHANGELOG [Unreleased]).
// Guards the mandated shape so a future trim can't silently revert the prompt to
// the terse expert form: plain-language audience, two-tier output (overview table
// + per-mission card), and the community-platform eligibility gate.
import { readFileSync } from 'node:fs';

const src = readFileSync('lib/report/mc-bridge.js', 'utf8');

const required = [
  ['vibe-coder', 'plain-language audience framing (non-expert reader)'],
  ['30-row overview table', 'tier 1 — at-a-glance overview table'],
  ['detailed CARD', 'tier 2 — per-mission detailed card'],
  ['Done when:', 'each card carries a checkable done-condition'],
  ['Only if:', 'community-platform (Reddit/HN/PH/Wikidata) eligibility gate'],
  ['What NOT to do', 'anti-pattern guidance retained'],
];

let failed = false;
for (const [needle, why] of required) {
  if (!src.includes(needle)) {
    console.error(`FAIL: PASTE_PROMPT missing "${needle}" — ${why}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('OK: PASTE_PROMPT carries the non-expert two-tier shape + eligibility gate');
