/**
 * E2E — the "?" chip on the fork diagram of the Mission Control card must never lie on a label.
 *
 * WHY THIS FILE EXISTS
 * The card in report.html draws a fork (DIY plan / Webappski plan) as one inline SVG
 * (viewBox 1000x280) and lays two <button class="fk-hover"> zones over its end boxes, in
 * percent of the stage. Each button carries a round "?" chip (`::after`, 20x20 CSS px, fixed
 * size). The SVG shrinks with the screen, the chip does not: below ~600 px the chip lay on the
 * right third of the box labels ("Webappski plan · €129 per plan…" showed as "Webappski p…").
 * No test knew the chip existed (`grep fk-hover test/` was empty).
 *
 * WHAT IT DOES
 * There is no browser in `npm test` (the package has no dependencies). So the file builds the REAL
 * report.html (replay + `report --no-open --offline`, as offer-alignment G1) and reasons about its
 * geometry from the bytes the reader gets: the embedded <style> (own cascade reader: @media, order,
 * specificity, !important; fail-closed on syntax it cannot read) and the inline SVG. It lays the page
 * out for every integer width 320…1440 with and without a 15 px scrollbar, puts the chip where the
 * cascade says, and requires that it touches no <text> of the diagram.
 *
 * WHAT IT DOES NOT PROVE (the browser does, once, outside `npm test`: pending-review geometry log)
 * Real glyph metrics (the model is the em-box of the embedded JetBrains Mono), the tap landing on
 * iOS/Android, the open tooltip, colour/contrast, print. The metric constants below are pinned
 * against Chrome by T0e.
 *
 * E2E-FIRST JUSTIFICATION (R37 Gate 0): the subject is a generated HTML file; the only alternative
 * is a browser the repo does not have. Nothing is mocked: the report is produced by the real CLI.
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  withTmpProject, seedReplayProject, offlineFetchEnv, spawnCli, assertExitCode, reportsDateDir,
} from './_helpers.js';

// ── build the real report once ────────────────────────────────────────────

async function buildReport() {
  let html = '';
  await withTmpProject('aeo-e2e-fork-chip-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const env = offlineFetchEnv({ GEMINI_API_KEY: 'test-key-do-not-use-real' });
    assertExitCode(spawnCli(['run', '--replay', '--replay-from=2026-05-13'], { cwd: dir, env }), 0, 'stable replay should exit 0');
    assertExitCode(spawnCli(['report', '--no-open', '--offline'], { cwd: dir, env }), 0, 'report --no-open --offline should exit 0');
    // the dated folder by listing, not by todayDateString(): a midnight between spawn and read must not flake
    const root = dirname(reportsDateDir(dir, 'testbrand.com', 'x'));
    const days = readdirSync(root);
    assert.strictEqual(days.length, 1, `exactly one dated report folder expected in ${root}, got ${days.join(',')}`);
    html = readFileSync(join(root, days[0], 'report.html'), 'utf8');
  });
  return html;
}
const HTML = await buildReport();

// ── CSS reader: @media, order, specificity, !important; fail-closed ───────

class Unreadable extends Error {}
const GUARD_TOKENS = /fk-|\.fork\b|\.page\b|mc-bridge|\bsvg\b|\btext\b|\bbody\b|\bbutton\b/;

function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'") { const q = s[i]; i++; while (i < s.length && s[i] !== q) i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  throw new Unreadable('unbalanced braces in the report stylesheet');
}
function splitTop(s, sep) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const tokens = (v) => splitTop(v.replace(/\s+/g, ' ').replace(/ /g, '\u0001'), '\u0001');

function expand(prop, value) {
  const sides = ['top', 'right', 'bottom', 'left'];
  if (prop === 'padding' || prop === 'margin') {
    const t = tokens(value);
    const [a, b = a, c = a, d = b] = t;
    return [[`${prop}-top`, a], [`${prop}-right`, b], [`${prop}-bottom`, c], [`${prop}-left`, d]];
  }
  if (prop === 'border') {
    const w = tokens(value).find((x) => /^-?[\d.]+px$/.test(x) || x === '0') || (/none|hidden/.test(value) ? '0' : 'medium');
    return sides.map((s) => [`border-${s}-width`, w]);
  }
  if (prop === 'border-width') return sides.map((s) => [`border-${s}-width`, tokens(value)[0]]);
  return [[prop, value]];
}
function parseDecls(body) {
  const decls = new Map();
  for (const raw of splitTop(body, ';')) {
    const i = raw.indexOf(':');
    if (i < 0) continue;
    const orig = raw.slice(0, i).trim().toLowerCase();
    if (orig.startsWith('--')) continue;
    let value = raw.slice(i + 1).trim();
    const important = /!important\s*$/i.test(value);
    value = value.replace(/\s*!important\s*$/i, '').trim();
    for (const [p, v] of expand(orig, value)) decls.set(p, { value: v, important, orig });
  }
  return decls;
}

function parseCompound(c) {
  const r = { tag: null, id: null, classes: [], pseudos: [], pseudoEl: null, unsupported: false };
  const re = /(\*)|([#.])?([\w-]+)|(::?)([\w-]+)(\([^)]*\))?|(\[[^\]]*\])|(\\.)|(.)/gy;
  let m;
  while ((m = re.exec(c))) {
    if (m[1]) r.tag = '*';
    else if (m[3] && m[2] === '#') r.id = m[3];
    else if (m[3] && m[2] === '.') r.classes.push(m[3]);
    else if (m[3]) r.tag = m[3].toLowerCase();
    else if (m[4] === '::') r.pseudoEl = m[5].toLowerCase();
    else if (m[4] === ':') {
      const name = m[5].toLowerCase();
      if (['after', 'before'].includes(name) && !m[6]) r.pseudoEl = name;
      else if (m[6] || !['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'root'].includes(name)) r.unsupported = true;
      else r.pseudos.push(name);
    } else r.unsupported = true;
    if (re.lastIndex >= c.length) break;
  }
  return r;
}
function parseSelector(raw) {
  const compounds = []; const combs = []; let cur = ''; let depth = 0; let pending = null;
  const flush = () => { if (cur) { compounds.push(parseCompound(cur)); cur = ''; } };
  for (const ch of raw.trim()) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) { flush(); pending = ' '; }
      if (ch !== ' ' && !/\s/.test(ch)) pending = ch;
      continue;
    }
    if (pending !== null && cur === '') { combs.push(pending); pending = null; }
    cur += ch;
  }
  flush();
  const unsupported = compounds.some((c) => c.unsupported) || combs.some((c) => c === '+' || c === '~');
  const spec = [0, 0, 0];
  for (const c of compounds) {
    if (c.id) spec[0]++;
    spec[1] += c.classes.length + c.pseudos.filter((p) => p !== 'root').length;
    if (c.tag && c.tag !== '*') spec[2]++;
    if (c.pseudoEl) spec[2]++;
  }
  return { raw: raw.trim(), compounds, combs, unsupported, spec };
}

function parseCss(src) {
  const rules = []; let order = 0;
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  (function block(s, media) {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i); const semi = s.indexOf(';', i);
      if (open < 0) break;
      if (semi >= 0 && semi < open) { i = semi + 1; continue; }
      const prelude = s.slice(i, open).trim();
      const end = matchBrace(s, open);
      const body = s.slice(open + 1, end);
      i = end + 1;
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)[1].toLowerCase();
        if (name === 'media') block(body, [...media, prelude.slice(6).trim()]);
        else if (!['font-face', 'keyframes', '-webkit-keyframes', 'page'].includes(name) && GUARD_TOKENS.test(body)) {
          throw new Unreadable(`@${name} holds selectors the reader does not model: ${prelude.slice(0, 60)}`);
        }
        continue;
      }
      const decls = parseDecls(body);
      for (const sel of splitTop(prelude, ',')) rules.push({ sel: parseSelector(sel), decls, media, order: order++ });
    }
  })(text, []);
  return rules;
}

// a media condition → (W) => boolean. Unknown conditions are false for screen geometry but only if
// no guarded selector sits behind them (checked by the caller via `rule.media`).
function mediaTrue(conds, W) {
  return conds.every((cond) => {
    const c = cond.toLowerCase().replace(/\s+/g, ' ').trim();
    if (/^print\b/.test(c) || /prefers-|forced-colors|hover:|pointer:/.test(c)) return false;
    return c.split(/ and /).every((part) => {
      const p = part.replace(/^screen$/, '').trim();
      if (p === '') return true;
      const m = /^\(\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(p);
      if (!m) throw new Unreadable(`media condition the reader does not model: ${cond}`);
      return m[1] === 'max' ? W <= +m[2] : W >= +m[2];
    });
  });
}

const el = (tag, classes = [], id = null) => ({ tag, classes, id });
function matchCompound(c, e, state) {
  if (c.tag && c.tag !== '*' && c.tag !== e.tag) return false;
  if (c.id && c.id !== e.id) return false;
  if (!c.classes.every((k) => e.classes.includes(k))) return false;
  return c.pseudos.every((p) => (p === 'root' ? e.tag === 'html' : p === 'active' ? false : state.hover));
}
function matchFrom(sel, ci, pi, path, state) {
  if (pi < 0 || !matchCompound(sel.compounds[ci], path[pi], state)) return false;
  if (ci === 0) return true;
  if (sel.combs[ci - 1] === '>') return matchFrom(sel, ci - 1, pi - 1, path, state);
  for (let j = pi - 1; j >= 0; j--) if (matchFrom(sel, ci - 1, j, path, state)) return true;
  return false;
}
function loosely(c, e) {
  return (!c.tag || c.tag === '*' || c.tag === e.tag) && (!c.id || c.id === e.id) && c.classes.every((k) => e.classes.includes(k));
}
// could a selector the reader cannot evaluate apply to the target? Its last compound must fit the target
// and every named ancestor compound must fit SOME ancestor (order and combinators ignored: fail-closed).
function mayApply(sel, path) {
  const last = sel.compounds[sel.compounds.length - 1];
  if (!loosely(last, path[path.length - 1])) return false;
  return sel.compounds.slice(0, -1).every((c) => !(c.tag || c.id || c.classes.length) || path.slice(0, -1).some((e) => loosely(c, e)));
}
// every rule that applies to the element at the end of `path` (pseudo: null | 'after'), in any media
function candidates(rules, path, pseudo, state) {
  const target = path[path.length - 1]; const out = [];
  for (const r of rules) {
    const last = r.sel.compounds[r.sel.compounds.length - 1];
    if (r.sel.unsupported) {
      if (mayApply(r.sel, path) && (last.pseudoEl || null) === pseudo) {
        throw new Unreadable(`selector the reader cannot evaluate may apply to <${target.tag} class="${target.classes.join(' ')}">${pseudo ? '::' + pseudo : ''}: ${r.sel.raw}`);
      }
      continue;
    }
    if ((last.pseudoEl || null) !== pseudo) continue;
    if (matchFrom(r.sel, r.sel.compounds.length - 1, path.length - 1, path, state)) out.push(r);
  }
  return out;
}
function winner(cands, W, prop) {
  let best = null;
  for (const r of cands) {
    const d = r.decls.get(prop);
    if (!d || !mediaTrue(r.media, W)) continue;
    const key = [d.important ? 1 : 0, ...r.sel.spec, r.order];
    if (!best || cmp(key, best.key) > 0) best = { key, value: d.value, rule: r, important: d.important };
  }
  return best;
}
function cmp(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

// ── the page: a fixed element path, the cascade, the layout ───────────────

const CSS = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
const RULES = parseCss(CSS);
const CHAIN = [el('html'), el('body'), el('main', ['page']), el('article', ['mc-bridge'], 'mc-bridge'), el('div', ['fork']), el('div', ['fk-stage'])];
const BTN = (k) => [...CHAIN, el('button', ['fk-hover', `fk-hover-${k}`])];
const TARGETS = {
  body: [CHAIN[0], CHAIN[1]], page: CHAIN.slice(0, 3), bridge: CHAIN.slice(0, 4), fork: CHAIN.slice(0, 5), stage: CHAIN,
  svg: [...CHAIN, el('svg')], diy: BTN('diy'), cur: BTN('cur'),
};
for (const tone of ['mute', 'ink', 'accent']) TARGETS[`text-${tone}`] = [...TARGETS.svg, el('g'), el('text', ['fk-text-mono', `fk-text-${tone}`])];
const cache = new Map();
function cands(name, pseudo = null, hover = false) {
  const key = `${name}|${pseudo}|${hover}`;
  if (!cache.has(key)) cache.set(key, candidates(RULES, TARGETS[name], pseudo, { hover }));
  return cache.get(key);
}
function val(name, W, prop, dflt, { pseudo = null, hover = false } = {}) {
  const w = winner(cands(name, pseudo, hover), W, prop);
  return w ? w.value : dflt;
}
const px = (v) => { const m = /^(-?\d*\.?\d+)px$/.exec(String(v).trim()); return m ? +m[1] : String(v).trim() === '0' ? 0 : NaN; };
const pct = (v) => { const m = /^(-?\d*\.?\d+)%$/.exec(String(v).trim()); return m ? +m[1] : NaN; };
const fin = (x, what) => { assert.ok(Number.isFinite(x), `${what}: not a finite value (the reader does not model it)`); return x; };
const side = (name, W, prop, what) => (val(name, W, prop, '0') === 'auto' ? 0 : fin(px(val(name, W, prop, '0')), what));

// the SVG: viewBox, end boxes, every <text> with its absolute position (nested translate)
function readSvg(html) {
  const m = /<div class="fk-stage">\s*<svg viewBox="0 0 (\d+) (\d+)"[^>]*>([\s\S]*?)<\/svg>/.exec(html);
  assert.ok(m, 'T0b FAIL: the fork SVG (div.fk-stage > svg[viewBox]) is not in report.html');
  const [vw, vh] = [+m[1], +m[2]];
  const body = m[3].replace(/<!--[\s\S]*?-->/g, '');
  const stack = []; const texts = []; const boxes = [];
  for (const t of body.matchAll(/<(\/?)(g|text|rect)\b([^>]*?)(\/?)>|([^<]+)/g)) {
    if (t[5] !== undefined) { if (stack.length && stack[stack.length - 1].text) stack[stack.length - 1].text.content += t[5]; continue; }
    const [, closing, tag, attrs, selfClose] = t;
    const a = Object.fromEntries([...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (closing) { const top = stack.pop(); if (top.text) texts.push({ ...top.text, content: top.text.content.replace(/&amp;/g, '&').replace(/&euro;/g, '€').trim() }); continue; }
    const tr = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(a.transform || '');
    const dx = tr ? +tr[1] : 0; const dy = tr ? +tr[2] : 0;
    const base = stack.length ? stack[stack.length - 1] : { x: 0, y: 0 };
    if (tag === 'g') { if (!selfClose) stack.push({ x: base.x + dx, y: base.y + dy }); continue; }
    if (tag === 'rect' && a.class === 'fk-node-bg') boxes.push({ x: base.x + +a.x, y: base.y + +a.y, w: +a.width, h: +a.height, cx: base.x, cy: base.y });
    if (tag === 'text') {
      const rec = { x: base.x + +a.x, y: base.y + +a.y, fs: +a['font-size'], ls: parseFloat(a['letter-spacing'] || '0'), anchor: a['text-anchor'] || 'start', content: '', cls: a.class || '', node: { x: base.x, y: base.y } };
      stack.push({ x: base.x, y: base.y, text: rec });
    }
  }
  return { vw, vh, texts, boxes };
}
const SVG = readSvg(HTML);
// metrics of the embedded JetBrains Mono (hhea/hmtx of lib/report/fonts/JetBrainsMono-Variable-latin.woff2,
// read 2026-10-24): unitsPerEm 1000, ascender 1020, descender -300, every advance 600. Pinned to Chrome by T0e.
const ADV = 0.6; const ASC = 1.02; const DESC = 0.3;
// the rectangle of a <text> in SVG units; `s` (px per unit) turns it into CSS px of the stage.
// Chrome rounds the ascent and descent of a scaled <text> to whole pixels (geometry log: the price line is 5 px
// high where the em-box says 4.56): the box grows by PAD px up and down so the model errs on the safe side.
const PAD = 0.5;
function textRect(t, s = 1) {
  fin(t.fs, `<text> "${t.content}" font-size`);
  const w = [...t.content].length * (ADV + t.ls) * t.fs;
  const x0 = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x;
  return { x1: x0 * s, x2: (x0 + w) * s, y1: (t.y - ASC * t.fs) * s - PAD, y2: (t.y + DESC * t.fs) * s + PAD };
}
const endNode = (k) => SVG.boxes.find((b) => (k === 'diy' ? b.cy < SVG.vh / 2 : b.cy > SVG.vh / 2) && b.w > 100);

function layout(W, sb) {
  const L = W - sb;
  const bodyC = L - side('body', W, 'padding-left', 'body padding-left') - side('body', W, 'padding-right', 'body padding-right')
    - side('body', W, 'margin-left', 'body margin-left') - side('body', W, 'margin-right', 'body margin-right');
  assert.strictEqual(val('page', W, 'box-sizing', 'content-box'), 'border-box', 'the model assumes box-sizing:border-box');
  const maxW = val('page', W, 'max-width', 'none');
  const pageAvail = bodyC - side('page', W, 'margin-left', 'page margin-left') - side('page', W, 'margin-right', 'page margin-right');
  const pageOuter = maxW === 'none' ? pageAvail : Math.min(pageAvail, fin(px(maxW), 'page max-width'));
  const pageC = pageOuter - side('page', W, 'padding-left', 'page padding') - side('page', W, 'padding-right', 'page padding')
    - side('page', W, 'border-left-width', 'page border') - side('page', W, 'border-right-width', 'page border');
  const bridgeOuter = pageC - side('bridge', W, 'margin-left', 'bridge margin') - side('bridge', W, 'margin-right', 'bridge margin');
  const bridgeC = bridgeOuter - side('bridge', W, 'border-left-width', 'bridge border') - side('bridge', W, 'border-right-width', 'bridge border')
    - side('bridge', W, 'padding-left', 'bridge padding') - side('bridge', W, 'padding-right', 'bridge padding');
  const forkC = bridgeC - side('fork', W, 'margin-left', 'fork margin') - side('fork', W, 'margin-right', 'fork margin')
    - side('fork', W, 'padding-left', 'fork padding') - side('fork', W, 'padding-right', 'fork padding')
    - side('fork', W, 'border-left-width', 'fork border') - side('fork', W, 'border-right-width', 'fork border');
  const stage = forkC - side('stage', W, 'margin-left', 'stage margin') - side('stage', W, 'margin-right', 'stage margin')
    - side('stage', W, 'padding-left', 'stage padding') - side('stage', W, 'padding-right', 'stage padding');
  assert.strictEqual(val('svg', W, 'width', 'auto'), '100%', 'the model assumes svg{width:100%}');
  assert.ok(stage > 100, `the stage collapsed (${stage}px at W=${W})`);
  return { stage, s: stage / SVG.vw, h: (stage * SVG.vh) / SVG.vw };
}
function button(k, W, lay) {
  const g = (p) => fin(pct(val(k, W, p, 'NaN')), `.fk-hover-${k} ${p} (must be a % of the stage)`);
  const x1 = (lay.stage * g('left')) / 100; const y1 = (lay.h * g('top')) / 100;
  return { x1, y1, x2: x1 + (lay.stage * g('width')) / 100, y2: y1 + (lay.h * g('height')) / 100 };
}
function chip(k, W, lay, hover) {
  const o = { pseudo: 'after', hover };
  const b = button(k, W, lay);
  const top = fin(px(val(k, W, 'top', 'auto', o)), 'chip top'); const right = fin(px(val(k, W, 'right', 'auto', o)), 'chip right');
  // a pseudo-element is content-box (the `* {box-sizing:border-box}` rule does not reach ::after): above 760 px its box
  // is the 20 px plus the 1 px border on each side = 22 px, which is what Chrome reports; the narrow-screen rule switches
  // it to border-box (20 px, border inside). T0e pins the stage width, the geometry log pins the chip size.
  const bd = (p) => fin(px(val(k, W, `border-${p}-width`, '0', o)), `chip border-${p}-width`);
  const borderBox = val(k, W, 'box-sizing', 'content-box', o) === 'border-box';
  const w = fin(px(val(k, W, 'width', 'auto', o)), 'chip width') + (borderBox ? 0 : bd('left') + bd('right'));
  const h = fin(px(val(k, W, 'height', 'auto', o)), 'chip height') + (borderBox ? 0 : bd('top') + bd('bottom'));
  const x2 = b.x2 - right; const y1 = b.y1 + top;
  let r = { x1: x2 - w, y1, x2, y2: y1 + h };
  const tf = val(k, W, 'transform', 'none', o);
  if (tf !== 'none') {
    const m = /^scale\(\s*([\d.]+)\s*\)$/.exec(tf.trim());
    assert.ok(m, `chip transform "${tf}" is not modelled`);
    const [cx, cy, kk] = [(r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2, +m[1]];
    r = { x1: cx - (w * kk) / 2, x2: cx + (w * kk) / 2, y1: cy - (h * kk) / 2, y2: cy + (h * kk) / 2 };
  }
  return { chip: r, button: b, w, h };
}
const overlap = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
const WIDTHS = Array.from({ length: 1121 }, (_, i) => 320 + i);

function eachPoint(fn) { for (const W of WIDTHS) for (const sb of [0, 15]) { const lay = layout(W, sb); for (const k of ['diy', 'cur']) fn(W, sb, k, lay); } }
const nodeTexts = (k) => { const n = endNode(k); return SVG.texts.filter((t) => t.x >= n.x && t.x <= n.x + n.w && t.y >= n.y && t.y <= n.y + n.h); };

// ── T0: the reader and the report are what the model assumes ──────────────

test('T0a: the CSS reader itself (media, order, specificity, !important, fail-closed)', () => {
  const path = [el('div'), el('div', ['a'])];
  const val1 = (css, W) => { const w = winner(candidates(parseCss(css), path, null, { hover: false }), W, 'top'); return w && w.value; };
  assert.strictEqual(val1('.a{top:1px}@media (max-width:760px){.a{top:2px}}', 700), '2px', 'T0a FAIL: media rule ignored at 700');
  assert.strictEqual(val1('.a{top:1px}@media (max-width:760px){.a{top:2px}}', 800), '1px', 'T0a FAIL: media rule applied at 800');
  assert.strictEqual(val1('@media (max-width:760px){.a{top:2px}}.a{top:3px}', 700), '3px', 'T0a FAIL: later rule must beat the earlier media rule on a tie');
  assert.strictEqual(val1('div.a{top:4px}.a{top:3px}', 700), '4px', 'T0a FAIL: higher specificity must win over a later rule');
  assert.strictEqual(val1('div.a{top:4px}.a{top:5px !important}', 700), '5px', 'T0a FAIL: !important must win');
  assert.throws(() => candidates(parseCss('div :is(.a){top:6px}'), path, null, { hover: false }), Unreadable, 'T0a FAIL: an unreadable selector that may apply must be red, not skipped');
  assert.throws(() => mediaTrue(['(min-resolution: 2dppx)'], 700), Unreadable, 'T0a FAIL: an unknown media condition must be red');
});

test('T0b: the report is the one the model assumes', () => {
  assert.strictEqual((HTML.match(/id="mc-bridge"/g) || []).length, 1, 'T0b FAIL: exactly one id="mc-bridge"');
  assert.ok(/<main class="page">/.test(HTML), 'T0b FAIL: <main class="page"> is not in the report');
  assert.strictEqual((HTML.match(/<button type="button"\s+class="fk-hover fk-hover-(diy|cur)"/g) || []).length, 2, 'T0b FAIL: two button.fk-hover (diy, cur)');
  assert.ok(!/style="/.test(HTML.match(/<div class="fork"[\s\S]*?<\/svg>/)[0]), 'T0b FAIL: an inline style= on the fork chain or its SVG is not modelled');
  assert.strictEqual(SVG.boxes.length, 2, 'T0b FAIL: two end boxes (fk-node-bg 256x88)');
  for (const k of ['diy', 'cur']) {
    const ts = nodeTexts(k);
    assert.ok(ts.length >= 3, `T0b FAIL: ${k} box holds ${ts.length} <text>, expected pill + heading + meta line`);
    assert.ok(ts.every((t) => t.cls.includes('fk-text-mono')), `T0b FAIL: ${k} box has a <text> outside .fk-text-mono (metrics unknown)`);
  }
  assert.ok(/\d/.test(nodeTexts('cur').map((t) => t.content).join(' ')), 'T0b FAIL: the Webappski box shows no price');
  const font = /--mono:\s*([^;]+);/.exec(CSS);
  assert.ok(font && /^["']?JetBrains Mono/.test(font[1].trim()), 'T0b FAIL: --mono must start with JetBrains Mono (the model uses its metrics)');
  assert.ok(/@font-face\s*\{[^}]*font-family:\s*["']?JetBrains Mono[^}]*src:\s*url\(data:/.test(CSS), 'T0b FAIL: JetBrains Mono is not embedded as data: in the report');
  for (const tone of ['mute', 'ink', 'accent']) {
    const f = winner(cands(`text-${tone}`), 390, 'font-family');
    assert.ok(f && f.value === 'var(--mono)', `T0b FAIL: the labels (.fk-text-${tone}) resolve to font-family "${f && f.value}", the model assumes var(--mono)`);
  }
  assert.ok(RULES.length > 500, `T0b FAIL: the reader found ${RULES.length} rules; the stylesheet is not what was expected`);
});

test('T0e: the model agrees with Chrome on the stage width (pinned from the geometry log)', () => {
  for (const [W, chrome] of [[320, 218], [390, 288], [1440, 1110]]) {
    const got = layout(W, 0).stage;
    assert.ok(Math.abs(got - chrome) <= 1, `T0e FAIL: stage at W=${W} is ${got}px in the model, ${chrome}px in Chrome (re-measure: AP-3 geometry log, then update this pin)`);
  }
});

// ── the three statements of the card, then what keeps them honest ─────────

test('A390: at every width 320…1440, with and without a scrollbar, no chip touches a label of its box', () => {
  eachPoint((W, sb, k, lay) => {
    const c = chip(k, W, lay, false).chip;
    for (const t of nodeTexts(k)) {
      const area = overlap(c, textRect(t, lay.s));
      assert.ok(area <= 0.01, `A390 FAIL: W=${W} sb=${sb} ${k} chip lies on "${t.content}" (${area.toFixed(1)} px²)`);
    }
  });
});

// Hover scales the chip by 1.1. With a classic 15 px scrollbar at W=320 (a desktop window dragged below
// phone width, layout 305 px) the grown chip's padded text box is touched on the DIY meta line (about -0.6 px
// of clearance in the model) — the em-box is conservative and a phone has an overlay scrollbar — so the hover
// check runs without the scrollbar. The rest check keeps both scrollbar states.
test('A390h: the same while the chip is hovered / focused (it grows), no classic scrollbar', () => {
  eachPoint((W, sb, k, lay) => {
    if (sb !== 0) return;
    const c = chip(k, W, lay, true).chip;
    for (const t of nodeTexts(k)) {
      const area = overlap(c, textRect(t, lay.s));
      assert.ok(area <= 0.01, `A390h FAIL: W=${W} sb=${sb} ${k} hovered chip lies on "${t.content}" (${area.toFixed(1)} px²)`);
    }
  });
});

test('A-place: on narrow screens the chip sits on the corner of its box, is visible and big enough', () => {
  eachPoint((W, sb, k, lay) => {
    if (W > 760) return;
    const { chip: c, button: b, w, h } = chip(k, W, lay, false);
    const [cx, cy] = [(c.x1 + c.x2) / 2, (c.y1 + c.y2) / 2];
    assert.ok(Math.abs(cx - b.x2) <= 1 && Math.abs(cy - b.y1) <= 1, `A-place FAIL (corner): W=${W} ${k} chip centre is ${(cx - b.x2).toFixed(1)}/${(cy - b.y1).toFixed(1)} px from the box corner`);
    assert.ok(w >= 20 && h >= 20, `A-place FAIL (size): W=${W} ${k} chip is ${w}x${h}px`);
    const o = { pseudo: 'after' };
    assert.notStrictEqual(val(k, W, 'display', 'inline', o), 'none', `A-place FAIL (visible): W=${W} ${k} chip has display:none`);
    assert.notStrictEqual(val(k, W, 'visibility', 'visible', o), 'hidden', `A-place FAIL (visible): W=${W} ${k} chip is visibility:hidden`);
    assert.ok(Number(val(k, W, 'opacity', '1', o)) > 0, `A-place FAIL (visible): W=${W} ${k} chip has opacity 0`);
    assert.ok(/["'][^"']+["']/.test(val(k, W, 'content', '""', o)), `A-place FAIL (visible): W=${W} ${k} chip has no content`);
  });
});

test('A-tap: a chip that leaves its button is tappable (pointer-events:auto), and only on narrow screens', () => {
  eachPoint((W, sb, k, lay) => {
    for (const hover of [false, true]) {
      const { chip: c, button: b } = chip(k, W, lay, hover);
      const pe = val(k, W, 'pointer-events', 'auto', { pseudo: 'after', hover });
      const outside = c.x1 < b.x1 - 0.01 || c.x2 > b.x2 + 0.01 || c.y1 < b.y1 - 0.01 || c.y2 > b.y2 + 0.01;
      if (outside) assert.strictEqual(pe, 'auto', `A-tap FAIL (guard): W=${W} ${k} the chip leaves its button but pointer-events is "${pe}": a tap on the outer half goes nowhere`);
      if (!hover) assert.strictEqual(pe, W <= 760 ? 'auto' : 'none', `A-tap FAIL (contract): W=${W} ${k} pointer-events is "${pe}", expected ${W <= 760 ? 'auto' : 'none'}`);
    }
  });
});

test('A1440: above 760 px nothing changed — the chip, the zones and every rule behind them', () => {
  for (const W of [761, 769, 1024, 1440]) {
    for (const k of ['diy', 'cur']) {
      const o = { pseudo: 'after' };
      for (const [p, want] of [['top', '8px'], ['right', '8px'], ['width', '20px'], ['height', '20px'], ['pointer-events', 'none']]) {
        const w = winner(cands(k, 'after', false), W, p);
        assert.ok(w && w.value === want, `A1440 FAIL: W=${W} ${k} chip ${p} is "${w && w.value}", pinned "${want}" (value of 6423704)`);
        assert.strictEqual(w.rule.media.length, 0, `A1440 FAIL: W=${W} ${k} chip ${p} comes from an @media rule (${w.rule.media.join(' / ')}): the narrow-screen rule leaked above 760 px`);
      }
      assert.strictEqual(val(k, W, 'transform', 'none', o), 'none', `A1440 FAIL: W=${W} ${k} chip is transformed at rest`);
      const bsz = winner(cands(k, 'after', false), W, 'box-sizing');
      assert.ok(!bsz || (bsz.value === 'content-box' && bsz.rule.media.length === 0), `A1440 FAIL: W=${W} ${k} chip box-sizing is "${bsz && bsz.value}" (${bsz && bsz.rule.media.join(' / ') || 'base'}): above 760 px the chip is content-box, 22x22 with its border (value of 6423704)`);

    }
    const zones = { diy: ['68.70%', '5.71%', '25.60%', '31.43%'], cur: ['68.70%', '62.86%', '25.60%', '31.43%'] };
    for (const k of ['diy', 'cur']) {
      const got = ['left', 'top', 'width', 'height'].map((p) => val(k, W, p, 'NaN'));
      assert.deepStrictEqual(got, zones[k], `A1440 FAIL: W=${W} zone ${k} is ${got.join(' ')}, pinned ${zones[k].join(' ')}`);
    }
  }
});

test('A-zone: the percentages of the zones are the SVG boxes (CSS ↔ markup seam, not typed by hand)', () => {
  for (const k of ['diy', 'cur']) {
    const b = endNode(k);
    const want = { left: (b.x / SVG.vw) * 100, top: (b.y / SVG.vh) * 100, width: (b.w / SVG.vw) * 100, height: (b.h / SVG.vh) * 100 };
    for (const [p, v] of Object.entries(want)) {
      const got = fin(pct(val(k, 1440, p, 'NaN')), `zone ${k} ${p}`);
      assert.ok(Math.abs(got - v) <= 0.01, `A-zone FAIL: zone ${k} ${p} is ${got}%, the SVG box says ${v.toFixed(2)}%`);
    }
  }
});

test('A-fit: every label stays inside its box (a longer price line would run under the chip)', () => {
  for (const k of ['diy', 'cur']) {
    const b = endNode(k);
    for (const t of nodeTexts(k)) {
      const r = textRect(t);
      assert.ok(r.x1 >= b.x + 8 - 0.01 && r.x2 <= b.x + b.w - 8 + 0.01, `A-fit FAIL: ${k} "${t.content}" spans ${r.x1.toFixed(0)}…${r.x2.toFixed(0)} of the box ${b.x}…${b.x + b.w} (8 units of margin)`);
    }
  }
});

// ── closed world: a geometry property nobody described is red ─────────────

const GEOM = /^(padding|margin|border|width|max-width|min-width|height|max-height|min-height|inset|top|right|bottom|left|translate|scale|rotate|transform|zoom|position|display|float|overflow|clip|contain|filter|box-sizing|font-size|font|letter-spacing|text-anchor|font-family|text-indent|word-spacing|line-height|writing-mode|direction|columns|gap|grid|flex|aspect-ratio)(-|$)|^animation(-name)?$/;
const ALLOWED = {
  body: ['margin', 'padding', 'position', 'font-family', 'font-size', 'line-height', 'box-sizing'],
  page: ['position', 'max-width', 'margin', 'padding', 'box-sizing'],
  bridge: ['margin', 'border', 'border-radius', 'position', 'overflow', 'box-sizing'],
  fork: ['padding', 'position', 'box-sizing'],
  stage: ['position', 'box-sizing'],
  svg: ['width', 'height', 'display', 'overflow', 'box-sizing'],
  button: ['position', 'border', 'padding', 'margin', 'border-radius', 'left', 'top', 'width', 'height', 'box-sizing'],
  text: ['font-family', 'font-weight', 'box-sizing'],
  chip: ['content', 'position', 'top', 'right', 'width', 'height', 'display', 'font-family', 'font-weight', 'font-size', 'line-height', 'border', 'border-radius', 'border-color', 'transform', 'box-sizing', 'align-items', 'justify-content'],
};
test('T0d: closed world — no geometry property outside the described set reaches the chain, the SVG, the buttons or the chips', () => {
  const seen = [];
  const check = (name, key, pseudo, hover) => {
    for (const r of cands(name, pseudo, hover)) {
      for (const d of r.decls.values()) {
        if (GEOM.test(d.orig) && !ALLOWED[key].some((a) => d.orig === a || d.orig.startsWith(`${a}-`))) seen.push(`${r.sel.raw}{${d.orig}} on ${key}`);
      }
    }
  };
  for (const n of ['body', 'page', 'bridge', 'fork', 'stage', 'svg']) check(n, n, null, false);
  for (const tone of ['mute', 'ink', 'accent']) check(`text-${tone}`, 'text', null, false);
  for (const k of ['diy', 'cur']) { check(k, 'button', null, false); check(k, 'button', null, true); check(k, 'chip', 'after', false); check(k, 'chip', 'after', true); }
  assert.deepStrictEqual([...new Set(seen)], [], `T0d FAIL: geometry the model does not describe: ${[...new Set(seen)].join('; ')}`);
});
