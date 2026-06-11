// E2E — single-key mode gate (1.1.8, founder decision 2026-06-11).
//
// Uses a CLEAN environment (not spawnCli, which auto-injects OPENAI_API_KEY
// and inherits the developer's heuristic-matchable *_DEV keys) so the key
// census is exactly what each test declares. Hermetic: the domain is
// `example.invalid` (RFC 2606 — DNS always fails), so runs die deterministically
// on the site-unreachable rung AFTER the key gate, with no live LLM calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { BIN, withTmpProject } from './_helpers.js';

const FAKE_KEY = 'test-key-do-not-use-real-0123456789abcdef';

function spawnClean(args, cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', TZ: 'UTC', ...extraEnv },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

const INIT_ARGS = ['init', '--yes', '--auto', '--brand=acme', '--domain=example.invalid'];

test('S1 — ONE OpenAI key passes the gate in single-key mode (no two-key wall)', async () => {
  await withTmpProject('aeo-single-key-', async (dir) => {
    const r = spawnClean(INIT_ARGS, dir, { OPENAI_API_KEY: FAKE_KEY });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /Missing required keys/);
    assert.doesNotMatch(out, /No research-capable/);
    assert.match(out, /Single-key mode/);
    assert.match(out, /unverified/);
    // …and the run still ends with the never-fail ladder's one-step abort
    // (site fetch of example.invalid fails, no --category to anchor on):
    assert.match(out, /Site unreachable and no --category/);
    assert.equal(r.status, 1);
  });
});

test('S2 — ZERO research keys → one plain hard-stop with setup lines', async () => {
  await withTmpProject('aeo-zero-key-', async (dir) => {
    const r = spawnClean(INIT_ARGS, dir);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /No research-capable API key found/);
    assert.match(out, /OPENAI_API_KEY/);
    assert.equal(r.status, 1);
  });
});

test('S3 — Anthropic-only also counts as a research-capable single key', async () => {
  await withTmpProject('aeo-anthropic-key-', async (dir) => {
    const r = spawnClean(INIT_ARGS, dir, { ANTHROPIC_API_KEY: FAKE_KEY });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /No research-capable/);
    assert.match(out, /Single-key mode \(Anthropic/);
    assert.equal(r.status, 1); // dies later on the unreachable site, not on keys
  });
});
