// The first impression: what a visitor, a crawler and a share preview get from the launch home. No live visitor count
// anywhere; no opening animation; no outbound link to the staking site; the closed areas off the navigation; a title,
// Open Graph tags and a self-hosted preview image; a web app manifest; every path but / a 404; the first load small.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';
import { SETTINGS } from '../../lib/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HOST = 'hub.example.com'; const ORIGIN = `https://${HOST}`;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbfirst-'));
let app; let port;
before(async () => {
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', PUBLIC_ORIGIN: ORIGIN, CLIENT_IP_HEADER: 'cf-connecting-ip', ADMIN_HOST: `admin.${HOST}`, ACCESS_TEAM: 'example-team', ADMIN_ACCESS_AUD: 'e'.repeat(64), ADMIN_EMAIL_SHA256: crypto.createHash('sha256').update('admin@example.com').digest('hex'), DB_FILE: path.join(dir, 'f.db') },
    rpc: async () => { throw new Error('no rpc'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });
  port = (await app.listen(0)).port; await app.assets.ready;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
let ipN = 0;
function raw(method, p, { host = HOST, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, 'cf-connecting-ip': `203.0.113.${1 + (ipN++ % 200)}`, ...headers } }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() }); }); });
    r.on('error', reject); r.end();
  });
}
const SERVED = () => ['public/index.html', 'public/css/app.css', ...fs.readdirSync(path.join(ROOT, 'public/js')).map((f) => 'public/js/' + f), 'admin/admin.js', 'admin/index.html'];

// ---- B. no live visitor count, ever
test('no live visitor count leaves the server: not in /api/state, not in the stream, not in the admin panel, not in any served script or page', async () => {
  const st = (await raw('GET', '/api/state')).json;
  assert.ok(!('connections' in st), '/api/state carries no connection count');
  assert.ok(!('intro' in st), 'and no reveal flag');
  const first = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/stream', headers: { host: HOST, 'cf-connecting-ip': '203.0.113.250' } }, (res) => { res.once('data', (c) => { resolve(String(c)); res.destroy(); }); });
    r.on('error', reject); r.end();
  });
  const hello = JSON.parse(/event: hello\ndata: (.*)\n/.exec(first)[1]);
  assert.deepEqual(Object.keys(hello).sort(), ['height', 'ttl'], 'hello: the block height and how long the stream lives, nothing about who else is here');
  const src = read('lib/app.js');
  assert.ok(!/emit\('presence'/.test(src) && !/presence/.test(src.replace(/\/\/.*$/gm, '')), 'no presence event in the server');
  assert.ok(!/connections: clients\.size/.test(src), 'the client count is never put in a payload (the admin status included)');
  const panel = read('lib/admin.js') + read('admin/admin.js');
  assert.ok(!/Live visitors|status\.connections|s\.connections/.test(panel), 'the admin panel shows no visitor count');
  for (const f of SERVED()) {
    const s = read(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (f === 'admin/admin.js') continue; // the panel's moderation screens speak of "hashed connections" (IP labels), a different thing, checked above
    assert.ok(!/\bonline\b|\bpresence\b|S\.connections|connections:|\} connection/i.test(s), f + ' speaks of a visitor count'); // "hashed connections" (IP labels) is a different thing
  }
  assert.ok(!/sb-conn|boardOnline/.test(read('public/index.html') + read('public/js/app.js') + read('public/css/app.css')), 'the "N online" / "N connections" slots are gone');
});

// ---- C. no opening animation
test('no opening reveal: no intro script, no reveal class or session flag, no admin switch, no shell variant; the head rests in its final pose', async () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/intro.js')), 'intro.js is gone');
  assert.ok(!('intro_on' in SETTINGS), 'no admin switch');
  assert.throws(() => app.settings.set('intro_on', false), /Unknown setting/);
  const html = (await raw('GET', '/')).text;
  assert.ok(!/intro|reveal|data-intro/.test(html), 'the shell never mentions the reveal');
  for (const f of ['public/js/theme.js', 'public/js/app.js', 'public/css/app.css', 'lib/app.js', 'lib/settings.js', 'lib/admin.js', 'admin/admin.js', 'scripts/verify-live.js', 'scripts/shots.js', 'scripts/make-bull.py']) {
    assert.ok(!/tbb-seen|\breveal(ed)?\b|intro_on|data-intro|INTRO_OFF|intro\.js|\bpulse\(/.test(read(f)), f + ' still knows about the reveal');
  }
  assert.ok(!/variant\(/.test(read('lib/app.js').replace(/export function variant/, '')) || !/function variant/.test(read('lib/app.js')), 'no second prebuilt shell');
  // the head is in the markup in its final pose with the eyes lit: no script is needed to show it
  assert.ok(/<svg class="bull-head bull-wide"/.test(html) && /class="bh-eye"[^>]*opacity="1\.00"/.test(html), 'the head and its lit eyes are in the shell');
  const css = read('public/css/app.css');
  assert.ok(!/html\.reveal|html\.revealed|@keyframes settle|animation: settle|animation: rise \.[69]s|animation: fadein 1\.2s/.test(css), 'no reveal or entrance animation on the home: content shows at once');
  assert.ok(!/bull-head \{[^}]*visibility: hidden/.test(css), 'the head is never hidden');
});

// ---- 12. only / serves the page
test('only / serves the page: every other extension-less path is the plain 404, dot paths and files stay as they were; hash routes are untouched', async () => {
  for (const p of ['/admin', '/admin/', '/nowhere', '/%ff%fe', '/index.html', '/learn', '/story', '/help/', '/.env']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await raw(method, p);
      assert.equal(r.status, 404, `${method} ${p}`);
      assert.ok(!r.text.includes('<'), `${method} ${p}: not the page`);
      if (method === 'GET') assert.equal(r.text, 'This page has moved on to other things.', p + ': one fixed 404 sentence');
    }
  }
  for (const p of ['/', '/?utm=1', '/?admin']) { const r = await raw('GET', p); assert.equal(r.status, 200, p); assert.ok(r.text.includes('<main id="main"'), p + ' is the page'); }
  assert.equal((await raw('GET', '/api/state')).status, 200);
  assert.equal((await raw('GET', '/css/app.css')).status, 200);
  // the page under its fingerprinted name, and the maintenance page by its plain name, are not second addresses
  const hashedIndex = app.assets.hashedFor('/index.html'); const hashedSoon = app.assets.hashedFor('/back-soon.html');
  assert.ok(/^\/index\.[0-9a-f]{10}\.html$/.test(hashedIndex) && /^\/back-soon\.[0-9a-f]{10}\.html$/.test(hashedSoon));
  for (const p of [hashedIndex, '/back-soon.html']) { const r = await raw('GET', p); assert.equal(r.status, 404, p); assert.equal(r.text, 'This page has moved on to other things.'); }
  assert.equal((await raw('GET', hashedSoon)).status, 200, 'the fingerprinted maintenance page stays: it is one of the files the live verifier checks');
  // files answer GET and HEAD only
  for (const p of ['/css/app.css', '/js/app.js', hashedSoon, '/img/favicon.svg']) { const r = await raw('POST', p); assert.equal(r.status, 404, 'POST ' + p); assert.ok(!r.text.includes('<') && !/[{}]/.test(r.text.slice(0, 2)), 'the plain sentence'); }
});

// ---- A. Stake out: no outbound link to the staking site anywhere; Learn is the hero action; the numbers stay
test('no link to the staking site anywhere: Learn is the primary hero button, the staked number is plain text, the Links row is gone (migration), Learn names the program as text', async () => {
  const html = (await raw('GET', '/')).text;
  const hero = /<div class="hero-actions">[\s\S]*?<\/div>/.exec(html)[0];
  assert.ok(/<a class="btn btn-primary hero-btn" href="#\/learn"[^>]*data-k="learn"/.test(hero), 'Learn is the primary hero button: ' + hero);
  assert.equal((hero.match(/btn-primary/g) || []).length, 1, 'one primary action');
  assert.ok(!/stake/i.test(hero), 'no Stake button');
  assert.ok(/<div class="stat stat-staked" id="st-staked"/.test(html) && !/id="st-staked"[^>]*href/.test(html), 'TBB staked is a plain stat, not a link');
  for (const f of ['public/index.html', 'public/css/app.css', ...fs.readdirSync(path.join(ROOT, 'public/js')).map((f) => 'public/js/' + f), 'lib/app.js', 'scripts/seed.js']) assert.ok(!/https:\/\/stakethebull/.test(read(f).split('\n').filter((l) => !/DELETE FROM allies/.test(l)).join('\n')), f + ' links to the staking site (the migration that deletes the row is the one allowed mention)');
  assert.ok(!/stakethebull/i.test(html), 'the shell never names the staking site');
  const views = read('public/js/views.js');
  assert.ok(/stakethebull\.xyz/.test(views) && !/ext\('https:\/\/stakethebull/.test(views), 'Learn names the program in plain text');
  assert.ok(/1 month 5% · 3 months 8% · 6 months 12% · 12 months 18% APR/.test(views), 'the staking numbers and explanations stay');
  assert.ok(!/'stake'\]/.test(read('public/js/app.js')) && !/row\('https:\/\/stakethebull/.test(views), 'no stake icon rule, no Stake row in More');
  // the Links table: the staking row left by an earlier seed is removed once (allies_rev 6) and never seeded again
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbmig-'));
  const mk = () => createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(d2, 'm.db') }, log: () => {} });
  let a = mk();
  a.db.run("INSERT INTO allies(title,url,blurb,sort) VALUES('Staking site','https://stakethebull.xyz','x',0)"); a.db.run("INSERT INTO allies(title,url,blurb,sort) VALUES('TBB Time Machine','https://tbbtimemachine.xyz','y',1)"); a.db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','5')");
  a.db.close();
  a = mk();
  assert.deepEqual(a.db.all('SELECT url FROM allies ORDER BY sort').map((r) => r.url), ['https://tbbtimemachine.xyz'], 'the staking row is gone');
  assert.equal(a.db.get("SELECT v FROM kv WHERE k='allies_rev'").v, '6');
  a.db.close(); fs.rmSync(d2, { recursive: true, force: true });
  const { ALLIES } = await import('../../scripts/seed.js').catch(() => ({ ALLIES: null }));
  assert.ok(!/stakethebull\.xyz'/.test(read('scripts/seed.js').split('\n').filter((l) => /^\s*\['/.test(l) && /https:/.test(l)).join('\n')), 'the seed has no staking link'); void ALLIES;
});

// ---- 4 + 5 + 6. the kicker, the fine print, the closed areas off the navigation, the title
test('the home says what it is: the kicker line, a title that says what the site is, the fine print not hidden on phones, Soon tabs hidden while closed, no tiles or bars for removed areas', async () => {
  const html = (await raw('GET', '/')).text;
  assert.ok(/<title>The Bitcoin Bull · \$TBB community dashboard<\/title>/.test(html), 'title');
  assert.ok(/<p class="kicker"[^>]*>Read-only community dashboard\. Never asks for your wallet, a signature or money\.<\/p>/.test(html), 'the kicker');
  const css = read('public/css/app.css');
  assert.ok(!/html\[data-theme='dark'\] \.fine \{ display: none; \}/.test(css) && !/html\[data-theme='dark'\] \.footline \{ display: none; \}/.test(css) && !/html\[data-theme='light'\] \.fine \{ display: none; \}/.test(css.slice(css.indexOf('.tiles .tile.is-soon'))), 'the fine print is not hidden on phones');
  // closed areas: off the dock (hidden in the shell, so no flash); a flag brings them back
  const dock = /<nav class="dock"[\s\S]*?<\/nav>/.exec(html)[0];
  const tabs = [...dock.matchAll(/<a class="dk([^"]*)" href="#\/(\w+)" data-dk="\w+"([^>]*)>/g)].map((m) => [m[2], /\bhidden\b/.test(m[3])]);
  assert.deepEqual(tabs, [['story', false], ['links', false], ['season', false], ['learn', false], ['build', true], ['live', true]], JSON.stringify(tabs));
  assert.ok(!/dk-soon|is-soon/.test(dock) && !/Soon/.test(dock), 'no Soon mark in the dock');
  const tiles = /<nav class="tiles"[\s\S]*?<\/nav>/.exec(html)[0];
  assert.deepEqual([...tiles.matchAll(/data-k="(\w+)"/g)].map((m) => m[1]), ['learn', 'help'], 'the 2009 list view has Learn and Help only');
  assert.ok(!/addrbar|myaddr|copy-mine/.test(html), 'no address bar in the 2009 chrome');
  const app = read('public/js/app.js');
  assert.ok(/function soonMark\(el, closed\) \{ el\.hidden = closed; /.test(app), 'the flags toggle the tab back');
  assert.ok(/btn\.hidden = !S\.me && !S\.features\?\.accounts/.test(app), 'the account button follows the accounts flag');
  assert.ok(/<button class="account-btn" id="accountBtn" hidden>/.test(html), 'the account button is hidden in the shell: nothing to sign in to at launch');
  assert.ok(!/Sign-in coming soon/.test(app + html), 'nothing says "Sign-in coming soon"');
});

// ---- 8 + 9. numbers already fetched, and a share line
test('numbers already fetched are shown: BTC price in /api/state for the sats line, market cap, 7-day staked trend, Season prize/APR from the board; a share button with the clipboard fallback', async () => {
  const st = (await raw('GET', '/api/state')).json;
  assert.ok('btcUsd' in st.stats, 'the BTC price (already fetched for the sats line) rides along in /api/state');
  const html = (await raw('GET', '/')).text; const app = read('public/js/app.js'); const views = read('public/js/views.js');
  assert.ok(/id="st-sub"/.test(html) && /sats/.test(app) && /marketCap/.test(app), 'a sats + market cap line under the price');
  assert.ok(/change7d/.test(read('lib/feeds.js')) && /change7d/.test(app) && /7d/.test(app), 'the 7-day staked trend');
  assert.ok(/prizeTbb/.test(views) && /stakeApr/.test(views), 'Learn shows the prize and APR from the board when the board answers');
  assert.ok(/id="shareBtn"/.test(html) && /navigator\.share/.test(app) && /copy\(/.test(app), 'Web Share with a copy fallback');
  for (const f of ['public/index.html', 'public/js/app.js']) assert.ok(!/platform\.twitter|sharethis|addthis|facebook\.com\/plugins/i.test(read(f)), f + ': no third-party share widget');
});

// ---- 1. share previews: Open Graph + X card tags and a self-hosted 1200x630 image with no metadata
const ORIGIN_PUBLIC = 'https://thebitcoinbull.club';
function jpegInfo(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'JPEG magic');
  let i = 2; const markers = []; let size = null;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff) break; const m = buf[i + 1]; const len = buf.readUInt16BE(i + 2); markers.push(m);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { size = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; break; }
    i += 2 + len;
  }
  return { markers, size };
}
const pngSize = (buf) => { assert.equal(buf.toString('latin1', 1, 4), 'PNG'); return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; };
test('share previews: Open Graph + X card tags with absolute URLs on the canonical origin; a 1200x630 self-hosted JPEG under 300 KB with no EXIF, XMP or path inside', async () => {
  const html = (await raw('GET', '/')).text;
  const meta = Object.fromEntries([...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  assert.equal(meta['og:type'], 'website'); assert.equal(meta['og:site_name'], 'The Bitcoin Bull');
  assert.equal(meta['og:title'], 'The Bitcoin Bull · $TBB community dashboard'); assert.equal(meta['twitter:title'], meta['og:title']);
  assert.equal(meta['og:description'], meta.description); assert.equal(meta['twitter:description'], meta.description);
  assert.ok(/not financial advice/i.test(meta.description) && /read-only/i.test(meta.description), 'the description says what it is: ' + meta.description);
  assert.equal(meta['og:url'], ORIGIN_PUBLIC + '/'); assert.equal(meta['og:image'], ORIGIN_PUBLIC + '/img/og.jpg'); assert.equal(meta['twitter:image'], meta['og:image']);
  assert.equal(meta['og:image:width'], '1200'); assert.equal(meta['og:image:height'], '630'); assert.ok(meta['og:image:alt']);
  assert.equal(meta['twitter:card'], 'summary_large_image');
  assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN_PUBLIC}/">`), 'canonical');
  assert.ok(!/twitter:site|twitter:creator|fb:app_id/.test(html), 'no account handles or app ids');
  const img = await raw('GET', '/img/og.jpg');
  assert.equal(img.status, 200); assert.match(String(img.headers['content-type']), /^image\/jpeg/);
  assert.ok(img.buf.length < 300 * 1024, `under 300 KB (${img.buf.length})`);
  const info = jpegInfo(img.buf);
  assert.deepEqual(info.size, { w: 1200, h: 630 });
  assert.ok(!info.markers.includes(0xe1) && !info.markers.includes(0xe2), 'no APP1 (EXIF/XMP) or APP2 (ICC) segment');
  const text = img.buf.toString('latin1');
  assert.ok(!/exif|ns\.adobe\.com|\/home\/|\/Users\/|Photoshop|Pillow|PIL/i.test(text), 'no metadata text inside the image');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/make-social.py')), 'the image is made by a script in the repo');
});

// ---- 7. a web app manifest and icons from the existing art, no service worker
test('web app manifest + icons: same-origin, PNG icons at the stated sizes, linked from the shell by its hashed name; no service worker anywhere', async () => {
  const html = (await raw('GET', '/')).text;
  const link = /<link rel="manifest" href="(\/manifest\.[0-9a-f]{10}\.webmanifest)">/.exec(html); assert.ok(link, 'manifest linked by its hashed name');
  const m = await raw('GET', link[1]); assert.equal(m.status, 200); assert.match(String(m.headers['content-type']), /^application\/manifest\+json/);
  const man = m.json; assert.ok(man, 'valid JSON');
  assert.equal(man.name, 'The Bitcoin Bull'); assert.equal(man.short_name, 'TBB'); assert.equal(man.start_url, '/'); assert.equal(man.display, 'standalone');
  assert.equal(man.background_color, '#0B0B0C'); assert.equal(man.theme_color, '#0B0B0C');
  assert.ok(/community dashboard/.test(man.description) && !/wallet|stake/i.test(man.description), 'description: ' + man.description);
  assert.ok(Array.isArray(man.icons) && man.icons.length >= 2);
  for (const ic of man.icons) {
    assert.ok(ic.src.startsWith('/img/'), 'same-origin icon: ' + ic.src); assert.equal(ic.type, 'image/png');
    const r = await raw('GET', ic.src); assert.equal(r.status, 200, ic.src); assert.match(String(r.headers['content-type']), /^image\/png/);
    const [w, h] = ic.sizes.split('x').map(Number); assert.deepEqual(pngSize(r.buf), { w, h }, ic.src + ' is ' + ic.sizes);
    assert.ok(!/tEXt|iTXt|zTXt|eXIf/.test(r.buf.toString('latin1')), ic.src + ': no text or EXIF chunk');
    // truecolor RGB, 8 bits, no palette (lossless as made from the art) and compressed as small as that allows
    assert.deepEqual([r.buf[24], r.buf[25]], [8, 2], ic.src + ': 8-bit RGB, no palette reduction'); assert.ok(!r.buf.toString('latin1').includes('PLTE'), ic.src + ': no PLTE chunk');
    assert.ok(r.buf.length <= { 192: 64_000, 512: 340_000 }[w], `${ic.src}: ${r.buf.length} bytes`);
  }
  assert.ok(/<link rel="apple-touch-icon" href="\/img\/icon-192\.[0-9a-f]{10}\.png">/.test(html), 'apple-touch-icon');
  assert.ok(!Object.keys(man).some((k) => /serviceworker|service_worker/i.test(k)), 'no service worker in the manifest');
  for (const f of fs.readdirSync(path.join(ROOT, 'public/js'))) assert.ok(!/serviceWorker|workbox/.test(read('public/js/' + f)), f + ' registers a service worker');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/sw.js')) && !fs.existsSync(path.join(ROOT, 'public/service-worker.js')), 'no worker script');
  assert.ok(/manifest-src 'self'/.test(read('lib/http.js')), 'CSP allows the same-origin manifest');
});

// ---- 13 + 17. grain.png gone (the data-URI noise already in the CSS), dead code gone
test('grain.png is gone (one data-URI noise for every grain), and the dead calculator code too', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/img/grain.png')), 'grain.png deleted');
  const css = read('public/css/app.css');
  assert.ok(!/grain\.png/.test(css), 'no reference to grain.png');
  assert.ok(/--noise: url\("data:image\/svg\+xml,/.test(css), 'one noise texture as a custom property');
  assert.ok((css.match(/var\(--noise\)/g) || []).length >= 3, 'used for the page grain, the cards and the drawer');
  assert.ok(!/\.big-input|\.result-sub|\.result \{|banner-unused/.test(css), 'the calculator and the unused banner styles are gone');
  assert.ok(!/CALCULATOR|void shortAddr/.test(read('public/js/views.js')) && !/void loreTimer/.test(read('public/js/app.js')), 'no placeholder section or kept-alive imports');
});

// ---- 11. the first load carries the open site only: closed views and the account dialogs load on demand
test('first load: no closed-area code and no account dialogs until something needs them; preloads match; the static script graph is small', async () => {
  const html = (await raw('GET', '/')).text;
  const pre = [...html.matchAll(/<link rel="modulepreload" href="\/js\/([a-z-]+)\.[0-9a-f]{10}\.js">/g)].map((m) => m[1]).sort();
  assert.deepEqual(pre, ['storytext', 'ui', 'views'], 'preloads: what app.js imports statically, nothing that loads on demand');
  const js = (f) => read('public/js/' + f);
  const statics = (src) => [...src.matchAll(/^import [^;]* from '\.\/([a-z-]+)\.js';/gm)].map((m) => m[1]);
  assert.deepEqual(statics(js('app.js')).sort(), ['ui', 'views'], 'app.js imports ui and views only: ' + statics(js('app.js')));
  assert.deepEqual(statics(js('views.js')).sort(), ['app', 'ui'], 'views.js: ' + statics(js('views.js')));
  assert.deepEqual(statics(js('ui.js')), ['storytext']);
  assert.ok(/import\('\.\/views-closed\.js'\)/.test(js('views.js')) && /import\('\.\/account\.js'\)/.test(js('app.js')), 'the closed views and the dialogs are dynamic imports');
  const dynamic = (src) => [...src.matchAll(/import\('\.\/([a-z-]+)\.js'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fs.readdirSync(path.join(ROOT, 'public/js')).flatMap((f) => dynamic(js(f))))].sort(), ['account', 'pow', 'views-closed'], 'the only modules loaded on demand');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'public/js')).sort(), ['account.js', 'app.js', 'pow.js', 'storytext.js', 'theme.js', 'ui.js', 'views-closed.js', 'views.js'], 'every script the site has');
  for (const name of ['chat', 'ideasTab', 'ideaDetail']) assert.ok(!new RegExp(`async function ${name}\\(`).test(js('views.js')) && new RegExp(`(async )?function ${name}\\(`).test(js('views-closed.js')), name + ' lives in views-closed.js');
  assert.ok(/async function build\(ctx\) \{\n  if \(!S\.features\?\.ideas\)/.test(js('views.js')) && /async function build\(\{ body/.test(js('views-closed.js')), 'the Build view is a card in views.js and the board in views-closed.js');
  assert.ok(/async function inbox\(ctx\) \{\n  if \(!S\.me && !S\.features\?\.accounts\)/.test(js('views.js')) && /async function inbox\(\{ body/.test(js('views-closed.js')), 'the Inbox view: a card in views.js, the list in views-closed.js');
  for (const name of ['signInFlow', 'recoverFlow', 'askCredentials', 'changePasswordFlow', 'ensureAdult', 'askName', 'xReturn', 'accountMenu']) assert.ok(!new RegExp(`function ${name}\\(`).test(js('app.js')) && new RegExp(`function ${name}\\(`).test(js('account.js')), name + ' lives in account.js');
  // the first load's scripts, compressed: well under what the old graph cost (about 55 KB gzip)
  const graph = ['/js/theme.js', '/js/app.js', '/js/ui.js', '/js/views.js', '/js/storytext.js'];
  const gz = graph.reduce((n, u) => n + (app.assets.get(u).gz?.length || app.assets.get(u).buf.length), 0);
  assert.ok(gz < 36 * 1024, `first-load scripts ${Math.round(gz / 1024)} KB gzip`);
  // what still has to work: the open views by address and the sign-in path once accounts open are reached through the loaders
  assert.ok(/VIEWS = \{ chat: lazy\('chat'\)/.test(js('views.js')) && /export const VIEWS/.test(js('views.js')), 'the route table keeps every name');
});
