/**
 * E2E — the model id the README and `--help` print as OpenAI's default is the
 * model the code actually defaults to (AP-7, design §1.3).
 *
 * WHY THIS FILE EXISTS (seam guard, R67 п.3 / R68 п.2)
 *   `FALLBACK.openai.main` (lib/providers/discover.js) and
 *   `DEFAULT_CONFIG.providers.openai` (lib/config.js) are what a new user gets.
 *   The README names that id in seven places and `--help` in one. Each reader is
 *   a separate copy of the same value; a change of the default that forgot one
 *   of them shipped a README that sent users to a model the tool no longer used.
 *   The value is taken FROM THE CODE here (import), never typed as a literal:
 *   a literal would agree with itself and survive a default that moved.
 *
 * EVERY ANCHOR IS COUNTED (G4): an anchor that matches nothing would pass by
 * emptiness after a rewording of the README. 0 matches is red.
 *
 * Old wording is NOT searched for here (a standing test on a historical phrase
 * is a cost); that those phrases are gone is checked once by `grep -c` in the
 * commit log.
 *
 * CROSS-PLATFORM: files are read as text, `--help` through a file descriptor
 * (as in run-model-selection-safety.test.js), no shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { withTmpProject, BIN, REPO_ROOT } from './_helpers.js';
import { FALLBACK } from '../../lib/providers/discover.js';
import { DEFAULT_CONFIG } from '../../lib/config.js';

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
const MAIN = FALLBACK.openai.main;

// anchor → how many times README is expected to carry it. Each capture group is
// the model id the README claims.
const ANCHORS = [
  ['G1a', '163/272 ChatGPT (`<id>` + the Responses', /ChatGPT \(`([\w.-]+)` \+ the Responses/g, 2],
  ['G1b', '276 table row ChatGPT (OpenAI)', /\| ChatGPT \(OpenAI\) \| `([\w.-]+)`/g, 1],
  ['G1c', '367 table row OpenAI + Responses', /\| OpenAI `([\w.-]+)` \+ Responses/g, 1],
  ['G1d', '557 switch from the default', /switch from the default `([\w.-]+)`/g, 1],
  ['G1e', '722 **ChatGPT**', /\*\*ChatGPT\*\* \(`([\w.-]+)`/g, 1],
  ['G1f', '1127 ChatGPT (<id> with the Responses', /ChatGPT \(([\w.-]+) with the Responses/g, 1],
];

for (const [id, name, re, expected] of ANCHORS) {
  test(`${id} · ${name}: README names FALLBACK.openai.main (${expected}x)`, () => {
    const found = [...README.matchAll(re)].map((m) => m[1]);
    assert.equal(found.length, expected,
      `G4: anchor ${re} must match exactly ${expected} time(s) in README.md, matched ${found.length} — a rewording moved it`);
    for (const id of found) {
      assert.equal(id, MAIN, `README says the default is ${id}; FALLBACK.openai.main is ${MAIN}`);
    }
  });
}

test('G2 · README JSON example carries the DEFAULT_CONFIG openai model and classify model', () => {
  const m = /"openai":\s*\{\s*"model":\s*"([\w.-]+)",\s*"classifyModel":\s*"([\w.-]+)"/.exec(README);
  assert.ok(m, 'G4: the `"openai": { "model": …, "classifyModel": … }` example was not found in README.md');
  assert.equal(m[1], DEFAULT_CONFIG.providers.openai.model);
  assert.equal(m[2], DEFAULT_CONFIG.providers.openai.classifyModel);
});

function helpText() {
  return withTmpProject('aeo-readme-help-', (dir) => {
    const file = join(dir, 'help.txt');
    const fd = openSync(file, 'w');
    let r;
    try {
      r = spawnSync(process.execPath, [BIN, '--help'], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
    } finally {
      closeSync(fd);
    }
    assert.equal(r.status, 0, r.stderr);
    const help = readFileSync(file, 'utf-8');
    assert.ok(help.length > 9000, `the whole help must be there (got ${help.length} chars)`);
    return help;
  });
}

test("G3 · `--help` names FALLBACK.openai.main as OpenAI's default main", async () => {
  const help = await helpText();
  const found = [...help.matchAll(/OpenAI's default main is [^(]+\(([\w.-]+)/g)].map((m) => m[1]);
  assert.equal(found.length, 1, `G4: the "OpenAI's default main is … (<id>" anchor must match once in --help, matched ${found.length}`);
  assert.equal(found[0], MAIN);
});

test('G5a · the no-cheap-tier paragraph speaks of a FAMILY and names a family example, not the 6.1 flagship', async () => {
  const help = await helpText();
  const anchor = 'ships NO recognised cheap tier';
  assert.equal(help.split(anchor).length - 1, 1, `G4: "${anchor}" must occur exactly once in --help`);
  const start = help.indexOf(anchor);
  const from = help.lastIndexOf('\n\n', start);
  const to = help.indexOf('\n\n', start);
  const para = help.slice(from === -1 ? 0 : from, to === -1 ? undefined : to);
  assert.match(para, /family/, `the paragraph must speak of a family:\n${para}`);
  assert.match(para, /gpt-7-astra/, `the example must be a family with no cheap tier (gpt-7-astra):\n${para}`);
  assert.doesNotMatch(para, /gpt-6\.1-sol/, `gpt-6.1-sol now descends to gpt-6-luna; it is no longer the example:\n${para}`);
});

test('G5b · README `--openai-model` row (line of the `switch from the default` anchor) speaks of a family', () => {
  const line = README.split('\n').find((l) => l.includes('switch from the default `'));
  assert.ok(line, 'G4: the `--openai-model=<id>` README row was not found');
  assert.match(line, /family/);
});
