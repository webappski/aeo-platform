#!/usr/bin/env node
/**
 * What every stored run scores under UVI v2 — without re-rendering anything.
 *
 * WHY THIS EXISTS. `uviVersion: 2` (1.15.0) changed the composite: an axis
 * measured on one or two cells is reported but no longer counted, and the
 * remaining weights re-normalise. That makes every number published under v1
 * incomparable with a v2 one — the 31.10 "after" point needs a v2 reading of
 * the same runs, not a subtraction of the two.
 *
 * The obvious way to get it is to re-render each old report. That way is wrong
 * twice over, measured 2026-09-21: `report --for-date` makes PAID classify-tier
 * calls on a cold cache even with every `--no-*` flag set, and it writes its
 * cache back into the source `_summary.json` — so it would both spend money and
 * edit historical records that were handed to clients.
 *
 * So this does none of that. `lib/report/visibility-index.js` is a pure module;
 * the stored `_summary.json` already holds every per-cell field the composite
 * needs. Read each summary, compute in memory, print a table. No network, no
 * writes, no report regenerated, nothing sent to anyone.
 *
 * The call order is the canonical one, copied from `mc-metadata.js#scores()`
 * rather than re-derived — a second implementation of the formula is the exact
 * drift this module was centralised to end.
 *
 * Usage:
 *   node scripts/uvi-v2-baseline.mjs <dir> [<dir>...]   # markdown to stdout
 *
 * A <dir> is scanned recursively for `_summary.json`. The client name is taken
 * from the path segment under the scanned root, so `~/Projects/clients` yields
 * one row per client per date.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { computeComponents, computeUVI, smallSampleGuard, UVI_VERSION } from '../lib/report/visibility-index.js';

/** Every `_summary.json` under `dir`, depth-first. Symlinks are not followed. */
export function findSummaries(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findSummaries(p));
    else if (e.name === '_summary.json') out.push(p);
  }
  return out;
}

/**
 * One table row for one stored run. Pure: takes the parsed summary, returns
 * numbers. Computes nothing itself — delegates to the canonical module so this
 * script cannot become a second implementation of the composite.
 */
export function rowFor(summary) {
  const components = computeComponents(summary);
  const guarded = smallSampleGuard(components);
  return {
    date: summary.date || '?',
    domain: summary.domain || '?',
    // The run's own stored headline. It is a plain MENTION RATE, not the
    // composite: `scores` was never persisted (verified null on all 32 stored
    // runs), so the v1 UVI a client was actually shown cannot be read back from
    // disk. Printed for orientation, never subtracted from the composite —
    // differencing the two would compare a rate with an index.
    storedHeadline: typeof summary.score === 'number' ? summary.score : null,
    v2: computeUVI(components),
    // The ONLY runs where v1 and v2 differ, by construction: v2 is v1 plus the
    // small-sample guard, so a run the guard never touched scores identically
    // under both. Where it did fire, the delivered number was HIGHER — those
    // axes counted then and do not now.
    uncounted: [...guarded.values()].map(g => `${g.key} (n=${g.n})`),
    guardFired: guarded.size > 0,
    cells: (summary.results || []).length,
    sample: components.sample,
  };
}

function main(dirs) {
  if (dirs.length === 0) {
    console.error('usage: node scripts/uvi-v2-baseline.mjs <dir> [<dir>...]');
    process.exit(2);
  }
  const rows = [];
  for (const root of dirs) {
    for (const file of findSummaries(root)) {
      let summary;
      try { summary = JSON.parse(readFileSync(file, 'utf-8')); }
      catch (err) { rows.push({ error: `${file}: ${err.message}` }); continue; }
      const who = relative(root, file).split(sep)[0] || root;
      try { rows.push({ who, file, ...rowFor(summary) }); }
      catch (err) { rows.push({ error: `${file}: ${err.message}` }); }
    }
  }

  const ok = rows.filter(r => !r.error);
  ok.sort((a, b) => (a.who || '').localeCompare(b.who || '') || String(a.date).localeCompare(String(b.date)));
  const affected = ok.filter(r => r.guardFired);

  console.log(`# Каждый сохранённый прогон под UVI v${UVI_VERSION} — ${ok.length} прогонов\n`);
  console.log('Считано из сохранённых `_summary.json` чистым модулем `lib/report/visibility-index.js`.');
  console.log('Ни одного сетевого вызова, ни одной записи, ни одного перегенерированного отчёта.\n');
  console.log('**Чего в этой таблице нет и почему.** Числа v1, которое видел клиент, на диске НЕ существует:');
  console.log('поле `scores` пусто во всех 32 сводках — композит считался в момент рендера и нигде не сохранялся.');
  console.log('Столбец «сохранённый заголовок» — это доля упоминаний, ДРУГАЯ величина; вычитать её из UVI нельзя,');
  console.log('получится разность ставки и индекса. Поэтому колонки Δ здесь нет.\n');
  console.log('**Что зато выводится строго.** v2 — это v1 плюс гейт малой выборки, значит прогон, которого гейт не коснулся,');
  console.log('под обеими версиями даёт ОДНО число. Расходятся ровно те строки, где столбец гейта непустой, и расходятся');
  console.log('в одну сторону: отданный документ показывал БОЛЬШЕ, потому что тогда эти оси считались.\n');
  console.log('| ⚠ | Кто | Дата | v2 (UVI) | сохранённый заголовок (доля упоминаний, не композит) | Оси, снятые гейтом малой выборки | Ячеек | Выборка |');
  console.log('|---|---|---|---:|---:|---|---:|---:|');
  for (const r of ok) {
    console.log(`| ${r.guardFired ? '⚠' : ''} | ${r.who} | ${r.date} | ${r.v2 ?? '—'} | ${r.storedHeadline ?? '—'} | ${r.uncounted.length ? r.uncounted.join(', ') : '—'} | ${r.cells} | ${r.sample ?? '—'} |`);
  }
  const bad = rows.filter(r => r.error);
  if (bad.length) {
    console.log(`\n## Не прочитано (${bad.length})\n`);
    for (const r of bad) console.log(`- ${r.error}`);
  }
  console.log(`\n⚠ — ${affected.length} прогонов, где гейт малой выборки сработал: ТОЛЬКО по ним отданный клиенту документ показывает завышенное число.`);
  console.log('Остальные ' + (ok.length - affected.length) + ' под v1 и v2 дают одно и то же, пересматривать их незачем.');
}

// Only run when invoked directly — importable for the test.
if (process.argv[1] && process.argv[1].endsWith('uvi-v2-baseline.mjs')) {
  main(process.argv.slice(2));
}
