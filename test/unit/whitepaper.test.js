// The whitepaper is the creator's poster on this site, not a link to an outside page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, LINK_WORDING } from '../../lib/app.js';
import { seed, ALLIES } from '../../scripts/seed.js';
import { buildAssets } from '../../lib/assets.js';

const ROOT = new URL('../../', import.meta.url);
const env = (d) => ({ PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(d, 'h.db') });
const quiet = { rpc: async () => { throw new Error('no rpc'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} };

test('links migration rev 5: the outside "whitepaper" row is deleted from an older install, nothing else is touched', () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbp8-'));
  const a0 = createApp({ env: env(d), ...quiet });
  seed(a0.db);
  a0.db.run('INSERT INTO allies(title,url,blurb,sort) VALUES(?,?,?,?)', 'TBB whitepaper', 'https://bitcoinhard.money/tbb', 'Twelve points, on Bitcoin Hard Money.', 2);
  a0.db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','4')");
  const n0 = a0.db.get('SELECT COUNT(*) n FROM allies').n; a0.db.close();
  const a1 = createApp({ env: env(d), ...quiet });
  try {
    assert.equal(a1.db.get("SELECT COUNT(*) n FROM allies WHERE url LIKE '%bitcoinhard.money/tbb%'").n, 0, 'gone');
    assert.equal(a1.db.get('SELECT COUNT(*) n FROM allies').n, n0 - 1, 'only that row');
    assert.equal(a1.db.get("SELECT v FROM kv WHERE k='allies_rev'").v, '6');
    assert.equal(a1.db.get("SELECT COUNT(*) n FROM allies WHERE url='https://store.bitcoinhard.money'").n, 1, 'the book store link stays');
  } finally { a1.db.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('nothing seeds or words a link to bitcoinhard.money/tbb any more; the page copy has no outside whitepaper link', () => {
  assert.ok(!ALLIES.some(([, u]) => /bitcoinhard\.money\/tbb/.test(u)), 'seed');
  assert.ok(!LINK_WORDING.some(([u]) => /bitcoinhard\.money\/tbb/.test(u)), 'wording');
  for (const f of ['lib/app.js', 'scripts/seed.js', 'public/js/views.js', 'public/js/app.js']) {
    const src = fs.readFileSync(new URL(f, ROOT), 'utf8');
    const refs = src.split('\n').filter((l) => l.includes('bitcoinhard.money/tbb') && !/DELETE FROM allies/.test(l));
    assert.deepEqual(refs, [], f);
  }
});

test('the poster ships in three formats, at its own size, with no metadata, and is served as a hashed immutable asset', () => {
  const art = new URL('public/art/', ROOT);
  const marks = ['Exif', 'EXIF', 'XMP', 'xpacket', 'c2pa', 'jumb', 'caBX', 'tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'IPTC', 'Photoshop', 'colrprof', 'colrrICC'];
  const png = fs.readFileSync(new URL('tbb-whitepaper.png', art));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [567, 847], 'the poster is 567x847, never resized');
  for (const ext of ['png', 'webp', 'avif']) {
    const buf = fs.readFileSync(new URL(`tbb-whitepaper.${ext}`, art)); const s = buf.toString('latin1');
    assert.deepEqual(marks.filter((m) => s.includes(m)), [], `${ext}: no metadata`);
  }
  const A = buildAssets(new URL('public/', ROOT).pathname);
  for (const ext of ['png', 'webp', 'avif']) assert.match(A.hashedFor(`/art/tbb-whitepaper.${ext}`) || '', new RegExp(`^/art/tbb-whitepaper\\.[0-9a-f]{10}\\.${ext}$`), ext);
  const views = A.get(A.hashedFor('/js/views.js')).buf.toString();
  assert.ok(/\/art\/tbb-whitepaper\.[0-9a-f]{10}\.avif/.test(views) && !/'\/art\/tbb-whitepaper\.png'/.test(views), 'the Learn view references the hashed names');
});

test('the twelve points are the poster\'s own lines, verbatim', () => {
  const src = fs.readFileSync(new URL('public/js/views.js', ROOT), 'utf8');
  const block = src.slice(src.indexOf('const WHITEPAPER = ['), src.indexOf('];', src.indexOf('const WHITEPAPER = [')));
  const lines = ['Built on authenticity and organic community growth.', 'Reach beyond boundaries. Global access. Infinite penetration.', 'The majority stays with the community. Power to the people.',
    'Transparency. Accountability. Trust. No anons. No games.', 'We build for the holders, not the profiteers.', 'Smart, fair, and sustainable emission. Built to last.',
    'Strong hands. Long-term vision. Immutable foundation.', 'Deep liquidity. Stronger charts. Health in every candle.', 'More nodes. More cities. More minds.',
    'Mainstream visibility. Massive exposure.', 'One mission. Many cultures. Bitcoin connects us all.', 'Discipline. Focus. Execution. We work. We grind. We win.'];
  for (const l of lines) assert.ok(block.includes(`'${l}'`), l);
  assert.equal((block.match(/\['\d\d', /g) || []).length, 12, 'twelve, no more');
  for (const t of ['Develop a Programmatic Monetary Policy for Distribution', 'Core Diamond Holders Supply Control', 'Reward Community Not Insiders', 'Work That Bag Mentality']) assert.ok(block.includes(t), t);
  assert.ok(!/bull post like never|bull run continues|people.s coin/i.test(src), 'the bonus line and the slogan stay in the picture, not in the site’s copy');
});
