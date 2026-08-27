#!/usr/bin/env node
/**
 * npm `version` lifecycle script — keep the README's Schema.org entity in step
 * with the version being released.
 *
 * WHY THIS EXISTS. `test/e2e/readme-schema-truth.test.js` pins the README's
 * `softwareVersion` to package.json's version, and `.githooks/pre-commit` runs
 * the full suite with no bypass. Without this script that pin would BREAK THE
 * RELEASE: `npm version minor` bumps package.json and then makes its own git
 * commit, at which moment the README is one version behind and the hook fails
 * the release with a confusing message about a README field.
 *
 * npm runs the `version` script AFTER the bump and BEFORE that commit, and
 * includes anything the script `git add`s in it. So the pin keeps its teeth —
 * a hand-edited README that disagrees with package.json still goes red — while
 * the release path heals itself.
 *
 * Reads/writes relative to `process.cwd()`, which npm sets to the package root
 * for lifecycle scripts. That is also what makes the script testable: point cwd
 * at a directory holding a package.json and a README.md.
 *
 * Fails loudly and changes NOTHING unless it can make exactly one substitution
 * per field. Silent partial edits to a published entity are the failure mode
 * worth being paranoid about.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkgPath = join(root, 'package.json');
const readmePath = join(root, 'README.md');

const version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
if (!version) {
  console.error('sync-readme-version: package.json has no version');
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);

const before = readFileSync(readmePath, 'utf-8');
let after = before;

/** Replace exactly one `"field": "value"` pair; refuse to guess otherwise. */
function setField(text, field, value) {
  const re = new RegExp(`("${field}":\\s*")([^"]*)(")`, 'g');
  const hits = text.match(re) || [];
  if (hits.length !== 1) {
    console.error(
      `sync-readme-version: expected exactly 1 "${field}" in README.md, found ${hits.length}. ` +
      'Refusing to edit — the Schema.org block is not in the shape this script knows.',
    );
    process.exit(1);
  }
  return text.replace(re, `$1${value}$3`);
}

after = setField(after, 'softwareVersion', version);
after = setField(after, 'dateModified', today);

if (after === before) {
  console.log(`sync-readme-version: README already current (softwareVersion ${version}, dateModified ${today})`);
} else {
  writeFileSync(readmePath, after);
  console.log(`sync-readme-version: README updated → softwareVersion ${version}, dateModified ${today}`);
}
