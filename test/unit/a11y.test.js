// Accessibility basics of the shell: the block-message ticker is a plain block with a real toggle button and a link
// outside it (no interactive content inside a button, no live region chattering every 20 s); every id is unique; menu
// buttons say whether they are open; the page behind a sheet, drawer or dialog is inert while it is open (the dock stays
// reachable: its tabs switch drawers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the ticker: a div holding a toggle button (aria-expanded, aria-controls) and the meta line with the link beside it; no aria-live', () => {
  const html = read('public/index.html');
  const m = /<div class="lore" id="lore">\s*<button class="lore-btn" type="button" aria-expanded="false" aria-controls="loreMeta"><span class="lore-text">[^<]+<\/span><\/button><span class="lore-meta" id="loreMeta"><\/span>\s*<\/div>/.exec(html);
  assert.ok(m, 'ticker structure: ' + /<[^>]*id="lore"[^>]*>[\s\S]{0,300}/.exec(html)?.[0]);
  assert.ok(!/<button class="lore"/.test(html) && !/id="lore"[^>]*aria-live/.test(html), 'not a button, not a live region');
  const app = read('public/js/app.js');
  assert.ok(/\.lore-btn/.test(app) && /aria-expanded/.test(app), 'the script keeps aria-expanded in step with the open state');
  assert.ok(/\.lore-btn \{/.test(read('public/css/app.css')), 'the inner button inherits the ticker’s look');
});

test('every id in the shell is unique (the tall bull’s eye gradient has its own), and the generator writes it that way', () => {
  const ids = [...read('public/index.html').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dup, [], 'duplicate ids: ' + dup.join(','));
  assert.ok(ids.includes('eyeGlow') && ids.includes('eyeGlowTall'));
  const gen = read('scripts/make-bull.py');
  assert.ok(/eyeGlowTall/.test(gen), 'scripts/make-bull.py writes a distinct id for the tall SVG');
});

test('menu buttons carry aria-expanded, kept in step by the script; the page behind a sheet, drawer or dialog is made inert, the dock excepted', () => {
  const html = read('public/index.html'); const app = read('public/js/app.js');
  const menuBtns = [...html.matchAll(/<button class="menu-btn"[^>]*>/g)].map((m) => m[0]);
  assert.equal(menuBtns.length, 3); for (const b of menuBtns) assert.ok(/aria-haspopup="true"/.test(b) && /aria-expanded="false"/.test(b), b);
  assert.ok(/aria-expanded/.test(/function closeMenus[\s\S]{0,400}/.exec(app)[0]), 'closeMenus() resets aria-expanded');
  assert.ok(/\.inert = /.test(app), 'inert is set from the script');
  assert.ok(/\.home > :not\(\.dock\)/.test(app), 'the dock is left reachable behind a drawer or sheet');
  assert.ok(/const behind = \(\) => \[\$\('#win'\), sheet, drawer\]/.test(app) && /for \(const el of behind\(\)\) el\.inert = true/.test(app), 'a dialog makes the whole window behind it inert');
});
