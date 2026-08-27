/**
 * E2E — the README's Schema.org `@graph` must describe the package that
 * actually ships.
 *
 * Why this file exists. The README block is the machine-readable entity we
 * publish to npmjs.com, GitHub, and every mirror that renders a README. It is
 * the surface AI crawlers read to answer "what is aeo-platform, what version,
 * who publishes it". Nothing regenerates it — every field is hand-maintained
 * prose that goes stale silently, and a stale entity is worse than no entity:
 * it is a confident wrong answer.
 *
 * Observed drift that motivated these pins (2026-08-27):
 *   - `softwareVersion` read `1.1.4` while npm served `1.8.0` — six minor
 *     releases behind, and no test noticed across all of them.
 *   - the `featureList` advertised "12 locales" the same day the region map
 *     grew to 15.
 *   - the Organization node declared `@id: https://webappski.com/#org` while
 *     the live canonical page declares `#webappski-org`, so the two nodes
 *     never merged — while an adjacent comment asserted the chain was "fully
 *     reciprocal".
 *
 * Each pin below derives the expected value from a LIVE in-repo source
 * (package.json, lib/report/geo-context.js) rather than restating a constant,
 * so the next release cannot re-open the same hole. `prepublishOnly` already
 * runs `npm test`, which makes these pins a publish gate by construction.
 *
 * MUTATION-SANITY: each assertion fails when the README value is edited away
 * from its source of truth (e.g. set `softwareVersion` back to `1.1.4`, or
 * `across 12 locales`, and the corresponding test goes RED naming both sides).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_helpers.js';
import { REGIONS } from '../../lib/report/geo-context.js';

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));

/** Pull the Schema.org `@graph` out of the README's fenced json block. There is
 *  exactly one such block; selecting it by CONTENT (`@context` + `@graph`)
 *  rather than by position keeps this stable if fenced json is added elsewhere. */
function schemaGraph() {
  const fences = [...README.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => m[1]);
  const parsed = [];
  for (const body of fences) {
    try { parsed.push(JSON.parse(body)); } catch { /* not every json fence is the entity block */ }
  }
  const doc = parsed.find(d => d && d['@context'] === 'https://schema.org' && Array.isArray(d['@graph']));
  assert.ok(doc, 'README must carry exactly one parseable Schema.org @graph block');
  return doc['@graph'];
}

function nodeOfType(graph, type) {
  const hit = graph.find(n => n && n['@type'] === type);
  assert.ok(hit, `README @graph must contain a ${type} node`);
  return hit;
}

test('README Schema.org block is valid JSON and carries the expected node types', () => {
  const graph = schemaGraph();
  for (const t of ['SoftwareApplication', 'Organization', 'FAQPage']) nodeOfType(graph, t);
});

test('softwareVersion matches the version that actually ships', () => {
  const app = nodeOfType(schemaGraph(), 'SoftwareApplication');
  assert.equal(
    app.softwareVersion, PKG.version,
    `README schema advertises softwareVersion ${app.softwareVersion} but package.json ships ` +
    `${PKG.version} — the published entity would state a version that does not exist`,
  );
});

test('dateModified is present, well-formed, and not older than datePublished', () => {
  const app = nodeOfType(schemaGraph(), 'SoftwareApplication');
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  assert.ok(app.datePublished && ISO.test(app.datePublished),
    'SoftwareApplication must keep a well-formed datePublished');
  assert.ok(app.dateModified, 'SoftwareApplication must carry dateModified — freshness is the ' +
    'signal an answer engine uses to decide whether this entity is still current');
  assert.ok(ISO.test(app.dateModified), `dateModified must be YYYY-MM-DD, got "${app.dateModified}"`);
  assert.ok(app.dateModified >= app.datePublished,
    `dateModified (${app.dateModified}) must not predate datePublished (${app.datePublished})`);
});

test('featureList locale count matches the shipped REGIONS map', () => {
  const app = nodeOfType(schemaGraph(), 'SoftwareApplication');
  const line = (app.featureList || []).find(f => /locales/.test(f));
  assert.ok(line, 'featureList must advertise the region-context locale count');
  const claimed = Number(line.match(/(\d+)\s+locales/)?.[1]);
  assert.equal(
    claimed, Object.keys(REGIONS).length,
    `README advertises ${claimed} locales, lib/report/geo-context.js ships ` +
    `${Object.keys(REGIONS).length} (${Object.keys(REGIONS).join(', ')})`,
  );
});

test('the publisher reference resolves to the Organization node in the same graph', () => {
  const graph = schemaGraph();
  const app = nodeOfType(graph, 'SoftwareApplication');
  const org = nodeOfType(graph, 'Organization');
  // A dangling publisher @id is the classic JSON-LD own-goal: the software and
  // the org look linked to a human reader but stay two unrelated nodes to a
  // parser. Pin them equal so a future @id edit has to move both.
  assert.ok(app.publisher && app.publisher['@id'],
    'SoftwareApplication must reference its publisher by @id');
  assert.equal(
    app.publisher['@id'], org['@id'],
    `publisher @id "${app.publisher['@id']}" does not match the Organization node ` +
    `@id "${org['@id']}" — the reference dangles and the two nodes never merge`,
  );
});
