/**
 * E2E — the two competitor comparison sections must not contradict themselves.
 *
 * Why this file exists. Both `## Comparison vs hosted AEO platforms` and
 * `## Comparison vs open-source AEO trackers` make a counted claim in PROSE
 * about rows in a TABLE a few lines above ("a live re-check of 19 tools",
 * "the eight ✳ hosted platforms ... (names)"). Nothing regenerates either
 * side. Edit one and the other silently becomes a lie — and unlike a stale
 * version string, a wrong competitor count is a claim about work we did.
 *
 * Observed drift that motivated these pins (2026-09-04): the first draft of
 * the rebuilt table put a ✳ on the Semrush row (meaning "its linked page was
 * read on 4 September") while the prose forty lines below said Semrush was
 * the one ✳ row that had NOT been capability-checked. Both sentences shipped
 * in the same commit-in-progress. A reader hitting that pair has no way to
 * know which half to believe, so the honest fix was to make them derive from
 * each other — and then to pin that they still do.
 *
 * Second wave of drift, and the reason the last three pins exist (2026-09-07):
 * a **Webappski (agency)** row was added to the hosted table. That single row
 * falsified four sentences written when every row but one was a competitor —
 * "the only row in this table" in our own Portable cell, "the one MIT row",
 * and the "18 tools" total repeated in the FAQ prose AND in the Schema.org
 * FAQ answer. A self-inclusive comparison table has a failure mode a purely
 * competitive one does not: the author's own row quietly breaks the
 * uniqueness claims the table was built to make. Hence the pins are now
 * ownership-aware, and ownership is derived from the row's own href rather
 * than from a hard-coded name list.
 *
 * The pins deliberately derive the expected numbers from the MARKUP rather
 * than restating them, so the next competitor added cannot re-open the hole:
 *   - the set of ✳ rows must equal the set of names the prose enumerates;
 *   - the re-check total must equal ✳ rows + open-source rows + the projects
 *     the section explicitly excludes;
 *   - no row of ours may carry a ✳ — the mark means "we read the vendor's
 *     page live", which is not a claim anyone can make about themselves, and
 *     a ✳ on our own row would also silently inflate the re-check total above;
 *   - every counted claim about the hosted table ("N rows in that table",
 *     "N third-party products in that table") must equal what the table
 *     actually holds, on every surface that repeats it — prose and JSON-LD;
 *   - a Yes in the Portable column may only appear on a row of ours, because
 *     the day a third-party vendor ships one, the wedge sentences elsewhere
 *     in the README stop being true and must be rewritten, not left standing.
 *
 * MUTATION-SANITY (each verified RED before commit): delete the ✳ from any
 * hosted row, change "19 tools" to any other number, put a ✳ on the Webappski
 * row, edit either counted claim off the row count, or flip a competitor's
 * Portable cell to Yes — and the corresponding assertion fails naming both
 * sides of the mismatch.
 *
 * Pure file read + string parsing — no fixtures, no subprocess, no network
 * and no mocks (R37: a heavier harness would measure nothing extra here).
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_helpers.js';

const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');

const HOSTED = '## Comparison vs hosted AEO platforms';
const OSS = '## Comparison vs open-source AEO trackers';

/** The named section only, so a coincidental match elsewhere in a 1000-line
 *  README cannot make one of these assertions pass by accident. */
function section(heading) {
  const start = README.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `README must contain the section heading "${heading}"`);
  const after = README.indexOf('\n## ', start + 1);
  return README.slice(start, after === -1 ? README.length : after);
}

/** Markdown table body rows whose first cell is a link — i.e. the tool rows,
 *  skipping the header and the `|---|` separator. Returns the link TEXT, which
 *  is the tool name as a reader sees it. */
function toolRows(sectionText) {
  return sectionText
    .split('\n')
    .filter(l => /^\|\s*\*{0,2}\[/.test(l))
    .map(l => {
      const firstCell = l.split('|')[1];
      const name = firstCell.match(/\[([^\]]+)\]/)?.[1];
      assert.ok(name, `could not read a tool name out of table row: ${l.slice(0, 80)}`);
      return { name: name.replace(/`/g, '').trim(), row: l };
    });
}

/** A row is OURS when its link points at something Webappski publishes. Derived
 *  from the href, not from a name list, so a future rename cannot orphan it. */
const OURS = /github\.com\/webappski\/|webappski\.com/;

/** Body cells of a markdown table row, in column order. */
function cells(row) {
  return row.split('|').slice(1, -1).map(s => s.trim());
}

test('every ✳ hosted row is named in the prose enumeration, and vice versa', () => {
  const hosted = section(HOSTED);
  const starred = toolRows(hosted).filter(r => r.row.includes('✳')).map(r => r.name);
  assert.ok(starred.length > 0, 'the hosted table must mark the rows that were re-checked live');

  // The claim lives in the open-source section, where the combined total is
  // decomposed for the reader.
  const enumerated = section(OSS)
    .match(/hosted platforms whose own pages were read that day \(([^)]+)\)/)?.[1];
  assert.ok(enumerated, 'the README must enumerate the re-checked hosted platforms by name');
  const named = enumerated.split(',').map(s => s.trim());

  assert.deepEqual(
    [...starred].sort(), [...named].sort(),
    `the ✳ rows in the hosted table and the names listed in the prose have diverged.\n` +
    `  ✳ in table : ${[...starred].sort().join(', ')}\n` +
    `  named in prose: ${[...named].sort().join(', ')}`,
  );
});

test('the re-check total equals what the two sections actually list', () => {
  const hosted = section(HOSTED);
  const oss = section(OSS);

  const starredHosted = toolRows(hosted).filter(r => r.row.includes('✳')).length;
  // Every row of the open-source table except our own is a tool we checked.
  const ossPeers = toolRows(oss).filter(r => !r.name.includes('aeo-platform')).length;

  // Projects the section names and then explicitly leaves out, each with a
  // printed reason — they were checked in order to be excluded, so they count.
  const excludedPara = oss.match(/\*\*Deliberately not in the table[^\n]*\n?[^\n]*/)?.[0];
  assert.ok(excludedPara, 'the open-source section must keep its "deliberately not in the table" note');
  const excluded = new Set(
    [...excludedPara.matchAll(/github\.com\/([^/)\s]+\/[^/)\s]+)/g)].map(m => m[1]),
  );
  assert.ok(excluded.size > 0, 'the exclusion note must name the projects it excludes, with links');

  const claimed = Number(oss.match(/live re-check of (\d+) tools/)?.[1]);
  assert.ok(Number.isInteger(claimed), 'the open-source section must state the re-check total');

  assert.equal(
    claimed, starredHosted + ossPeers + excluded.size,
    `the README claims a live re-check of ${claimed} tools, but the sections list ` +
    `${starredHosted + ossPeers + excluded.size}: ${starredHosted} ✳ hosted rows + ` +
    `${ossPeers} open-source peers + ${excluded.size} explicitly excluded projects. ` +
    `A count nobody can decompose is a claim about work, not a record of it.`,
  );
});

test('no row of ours is marked ✳ — that mark is a claim about reading someone else\'s page', () => {
  const selfStarred = toolRows(section(HOSTED))
    .filter(r => OURS.test(r.row) && r.row.includes('✳'))
    .map(r => r.name);

  assert.deepEqual(
    selfStarred, [],
    `these rows are Webappski's own and carry a ✳: ${selfStarred.join(', ')}. ` +
    `✳ means "we read the vendor's linked page live on the stamp date" — self-applied ` +
    `it says nothing, and it would also add our own rows to the audited re-check total.`,
  );
});

test('every counted claim about the hosted table equals what the table holds', () => {
  const rows = toolRows(section(HOSTED));
  const total = rows.length;
  const thirdParty = rows.filter(r => !OURS.test(r.row)).length;

  // Both claims are repeated on two surfaces a reader/parser can hit
  // independently — the FAQ prose and the Schema.org FAQ answer — plus the
  // note under the table itself. Collect EVERY occurrence: one surface healed
  // while another stays stale is the exact drift this file exists to stop.
  const check = (re, expected, label) => {
    const found = [...README.matchAll(re)].map(m => Number(m[1]));
    assert.ok(
      found.length >= 2,
      `expected the "${label}" claim on at least the prose and the JSON-LD surface, found ${found.length}`,
    );
    for (const claimed of found) {
      assert.equal(
        claimed, expected,
        `the README claims ${claimed} ${label}, but the hosted table holds ${expected}. ` +
        `Occurrences found: ${found.join(', ')} — every surface repeating the number must move together.`,
      );
    }
  };

  check(/(\d+) rows in th(?:at|is) table/g, total, 'rows in that table');
  check(/(\d+) third-party products in th(?:at|is) table/g, thirdParty,
    'third-party products in that table');
});

test('a Yes in the Portable column appears only on rows we own', () => {
  const hosted = section(HOSTED);
  const header = hosted.split('\n').find(l => l.startsWith('| Tool |'));
  const portableIdx = cells(header).findIndex(c => /Portable paste-into-AI plan/.test(c));
  assert.ok(portableIdx > 0, 'the hosted table must keep a Portable paste-into-AI plan column');

  const foreignYes = toolRows(hosted)
    .filter(r => !OURS.test(r.row) && /^\*{0,2}Yes\b/.test(cells(r.row)[portableIdx] || ''))
    .map(r => r.name);

  assert.deepEqual(
    foreignYes, [],
    `${foreignYes.join(', ')} now shows Yes in the Portable column. That is allowed to be ` +
    `true — but the moment it is, the wedge sentences ("no hosted vendor ships", "none of the ` +
    `N third-party products ... shipped a portable plan") are false and must be rewritten in ` +
    `the same commit. Update the prose, then this pin.`,
  );
});

test('the wedge claim says "portable" everywhere it is made', () => {
  // Waikay ships an in-dashboard action plan, so the unqualified form of this
  // claim ("no vendor ships a paste-into-AI plan") became false on 2026-09-04.
  // The narrowing word has to survive in every place the claim is repeated,
  // or the table and the machine-readable entity contradict each other.
  const hostedHeader = section(HOSTED).split('\n').find(l => l.startsWith('| Tool |'));
  assert.match(hostedHeader, /Portable paste-into-AI plan/,
    'the hosted table column header must keep the "Portable" qualifier');

  const ossHeader = section(OSS).split('\n').find(l => l.startsWith('| Project |'));
  assert.match(ossHeader, /Portable paste-into-AI plan/,
    'the open-source table column header must keep the "Portable" qualifier');

  assert.ok(
    README.includes('the portable wedge no hosted vendor ships'),
    'the 30-mission section heading must keep the narrowed claim',
  );
});
