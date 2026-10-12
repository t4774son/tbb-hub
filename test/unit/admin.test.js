// the admin panel: only on ADMIN_HOST, only with a valid Access token; settings, links, messages, audit, maintenance, moderation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../lib/app.js';
import http from 'node:http';
import { seed } from '../../scripts/seed.js';
import { newUid, plantUser, sessionFor } from './helpers.js';

const LOCKED = 'Locked — opens after the outside audit (server setting)';
const TEAM = 'example-team'; const AUD = 'c'.repeat(64); const EMAIL = 'admin@example.com';
const EMAIL_SHA = crypto.createHash('sha256').update(EMAIL).digest('hex');
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (b) => Buffer.from(b).toString('base64url');
function jwt(claims = {}, { key = KEY.privateKey, kid = 'kid-1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })); const body = b64u(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: EMAIL, iat: now, nbf: now, exp: now + 600, ...claims }));
  return `${head}.${body}.${b64u(crypto.sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}
let certsCalls = 0;
const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('cloudflareaccess.com/cdn-cgi/access/certs')) { certsCalls++; return new Response(JSON.stringify({ keys: [{ kid: 'kid-1', kty: 'RSA', alg: 'RS256', use: 'sig', ...KEY.publicKey.export({ format: 'jwk' }) }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  const body = u.includes('dexscreener') ? { pairs: [{ baseToken: { address: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump' }, priceUsd: '0.0004', priceChange: { h24: 5.2 }, liquidity: { usd: 100 }, marketCap: 400000, pairAddress: 'x' }] } : { USD: 100000 };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const rpc = async () => { throw new Error('no rpc in this test'); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbadmin-'));
let app; let base; let port;
const ADMIN_HOST = () => `admin.localhost:${port}`;
const PUBLIC_HOST = () => `localhost:${port}`;
before(async () => {
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(dir, 'a.db'), PUBLIC_ORIGIN: 'http://localhost:3000', ADMIN_HOST: 'admin.localhost:3000', ACCESS_TEAM: TEAM, ADMIN_ACCESS_AUD: AUD, ADMIN_EMAIL_SHA256: EMAIL_SHA }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db);
  app.db.run("INSERT INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(1,'h','t1','coinbase','Hello from block one',?, 'approved')", Date.now());
  const a = await app.listen(0); port = a.port; base = `http://127.0.0.1:${port}`;
  // the app was configured for port 3000 hostnames; point it at the real port
  app.config.adminHost = ADMIN_HOST(); app.config.adminOrigin = `http://${ADMIN_HOST()}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// fetch() silently drops a custom Host header, so talk to the server with node:http (which honours it).
function req(p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { connection: 'close', ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null }, text: async () => text, json: async () => JSON.parse(text) }); });
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const adm = (p, { method = 'GET', body, token = jwt(), headers = {}, raw } = {}) => req(p, { method: body || raw ? 'POST' : method, headers: { host: ADMIN_HOST(), ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...(body ? { 'content-type': 'application/json', 'x-admin': '1', origin: `http://${ADMIN_HOST()}` } : {}), ...headers }, body: body ? JSON.stringify(body) : raw });
const pub = (p, headers = {}) => req(p, { headers: { host: PUBLIC_HOST(), ...headers } });
const json = async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) });

test('on the public host every admin path is a plain 404 and nothing admin-ish is served', async () => {
  for (const p of ['/api/panel/panel', '/admin.js', '/admin.css', '/api/panel/setting']) assert.equal((await pub(p)).status, 404, p);
  const html = await (await pub('/')).text(); assert.ok(!/admin\.js|admin/.test(html), 'no admin references in the public page');
  const js = await (await pub('/js/app.js')).text(); assert.ok(!js.includes('/api/' + 'admin') && !js.includes('/api/panel'), 'no admin API in the public bundle');
});

test('admin host: no token / bad token / wrong person → 403; the right token → the panel', async () => {
  assert.equal((await adm('/api/panel/panel', { token: null })).status, 403);
  assert.equal((await adm('/api/panel/panel', { token: 'not.a.jwt' })).status, 403);
  assert.equal((await adm('/api/panel/panel', { token: jwt({ email: 'intruder@example.com' }) })).status, 403);
  assert.equal((await adm('/api/panel/panel', { token: jwt({ aud: ['d'.repeat(64)] }) })).status, 403);
  assert.equal((await adm('/', { token: null })).status, 403, 'the page itself needs the token too');
  const r = await adm('/api/panel/panel'); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const d = await r.json();
  assert.deepEqual(d.settings.banner, { on: false, text: '', tone: 'info' });
  assert.deepEqual(d.settings.sections, { season: true, chart: true, learn: true, lore: true });
  assert.ok(d.links.length >= 4 && d.lore.length >= 1 && Array.isArray(d.audit) && d.audit.length === 0);
  assert.deepEqual(d.launch.map((l) => [l.id, l.env, l.open, l.effective, l.locked]), [['chat', false, false, false, LOCKED], ['accounts', false, false, false, LOCKED]]);
  assert.ok(!('intro_on' in d.settings), 'no reveal switch'); assert.equal(d.settings.story_title, ''); assert.equal(d.settings.story_body, '');
  assert.deepEqual(d.settings.areas, { chat: false, accounts: false });
  assert.equal(d.limits.storyBody, 20_000);
  assert.ok(d.status.uptimeS >= 0 && d.status.memory.rss > 0 && d.status.feeds && typeof d.status.node === 'string');
  assert.equal(certsCalls, 1, 'keys fetched once');
  const page = await adm('/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/); assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await page.text(); assert.ok(html.includes('/admin.js') && /\/css\/app\.[0-9a-f]{10}\.css/.test(html), 'panel page uses the site stylesheet (hashed)');
  assert.equal((await adm('/admin.js')).status, 200); assert.equal((await adm('/css/app.css')).status, 200);
  assert.equal((await adm('/api/state')).status, 404, 'public API is not on the admin host');
  assert.equal((await adm('/js/app.js')).status, 404, 'public bundle is not on the admin host');
  assert.equal((await adm('/js/storytext.js')).status, 200, 'the story parser is shared with the editor preview');
  assert.equal((await adm('/js/ui.js')).status, 404);
});

test('writes: JSON only, same-origin Origin, X-Admin header, small body', async () => {
  const no = await adm('/api/panel/setting', { raw: '{}', headers: { 'content-type': 'application/json' } }); assert.equal(no.status, 403, 'missing X-Admin');
  const cross = await adm('/api/panel/setting', { raw: '{}', headers: { 'content-type': 'application/json', 'x-admin': '1', origin: 'https://evil.example' } }); assert.equal(cross.status, 403, 'wrong Origin');
  const noOrigin = await adm('/api/panel/setting', { raw: '{}', headers: { 'content-type': 'application/json', 'x-admin': '1' } }); assert.equal(noOrigin.status, 403, 'no Origin');
  const form = await adm('/api/panel/setting', { raw: 'key=banner', headers: { 'content-type': 'text/plain', 'x-admin': '1', origin: `http://${ADMIN_HOST()}` } }); assert.equal(form.status, 415, 'not JSON');
  const big = await adm('/api/panel/setting', { method: 'POST', body: { key: 'banner', value: { text: 'x'.repeat(100_000) } } }); assert.equal(big.status, 413);
  const bigLink = await adm('/api/panel/link', { method: 'POST', body: { title: 'x'.repeat(20_000), url: 'https://example.com', blurb: 'b' } }); assert.equal(bigLink.status, 413, 'other writes stay small');
  const unknown = await adm('/api/panel/nope', { method: 'POST', body: {} }); assert.equal(unknown.status, 404);
  const get = await adm('/api/panel/setting'); assert.equal(get.status, 404, 'GET on a write path');
});

test('settings: strict shapes; banner and sections reach the public site; every change is audited as "panel"', async () => {
  const bad = async (value, re, key = 'banner') => { const r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key, value } })); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.error, re); };
  await bad({ on: true, text: '' }, /Write the announcement/);
  await bad({ on: false, text: 'x'.repeat(161) }, /too long/);
  await bad({ on: true, text: 'see http://example.com' }, /https/);
  await bad({ on: true, text: 'see https://user:pw@example.com' }, /link/);
  await bad({ on: true, text: 'see javascript:alert(1)' }, /not a link/);
  await bad({ on: 'yes', text: 'hi' }, /on or off/);
  await bad({ on: true, text: 'hi', tone: 'danger' }, /Tone/);
  await bad('string', /object/);
  await bad({ season: 'no' }, /on or off/, 'sections'); await bad({ chat: false }, /Unknown section/, 'sections');
  assert.equal((await adm('/api/panel/setting', { method: 'POST', body: { key: 'chatOpen', value: true } })).status, 404, 'launch switches are not settings');
  assert.equal((await adm('/api/panel/setting', { method: 'POST', body: { key: 'areas', value: { chat: true } } })).status, 400, 'areas only flip one at a time, through the area route');
  assert.equal((await adm('/api/panel/setting', { method: 'POST', body: { key: '__proto__', value: {} } })).status, 404);
  let r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'banner', value: { on: true, text: '  Season 1 ends Nov 4 — see https://example.com/board  ', tone: 'warn' } } }));
  assert.equal(r.status, 200); assert.deepEqual(r.value, { on: true, text: 'Season 1 ends Nov 4 — see https://example.com/board', tone: 'warn' });
  let st = await (await pub('/api/state')).json(); assert.deepEqual(st.banner, { text: 'Season 1 ends Nov 4 — see https://example.com/board', tone: 'warn' });
  r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'sections', value: { season: false, chart: true } } }));
  assert.deepEqual(r.value, { season: false, chart: true, learn: true, lore: true });
  st = await (await pub('/api/state')).json(); assert.equal(st.sections.season, false);
  r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'banner', value: { on: false, text: 'kept' } } })); assert.equal(st.banner.tone, 'warn');
  st = await (await pub('/api/state')).json(); assert.equal(st.banner, null, 'off = not sent to visitors');
  const d = await (await adm('/api/panel/panel')).json();
  assert.ok(d.audit.length >= 3 && d.audit.every((a) => a.actor === 'panel'), 'audited');
  assert.equal(d.audit[0].action, 'setting:banner'); assert.ok(d.audit[0].before.includes('"on":true') && d.audit[0].after.includes('"on":false'));
  assert.ok(!JSON.stringify(d.audit).includes(EMAIL), 'no e-mail anywhere');
  assert.equal(app.db.get('SELECT v FROM settings WHERE k=?', 'sections') !== undefined, true, 'persisted');
});

test('story: validated and reaches the public site; the page shell has one form (no reveal switch, no variant)', async () => {
  const bad = async (key, value, re) => { const r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key, value } })); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.error, re); };
  assert.equal((await adm('/api/panel/setting', { method: 'POST', body: { key: 'intro_on', value: false } })).status, 404, 'the reveal switch is gone');
  await bad('story_title', 'x'.repeat(81), /too long/);
  await bad('story_body', 'x'.repeat(20_001), /too long/);
  await bad('story_body', 'see http://example.com', /https/);
  await bad('story_body', 'see javascript:alert(1)', /not a link/);
  await bad('story_body', ['no'], /must be text/);
  const body = 'Chapter one.\r\n\r\nI bought the **dip** at https://example.com/board.\u0007 \n\nThe end.  ';
  let r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'story_body', value: body } }));
  assert.equal(r.status, 200); assert.equal(r.value, 'Chapter one.\n\nI bought the **dip** at https://example.com/board.\n\nThe end.', 'line breaks kept, control characters and trailing spaces dropped');
  r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'story_title', value: '  How it  started ' } })); assert.equal(r.value, 'How it started');
  const long = 'word '.repeat(3990).trim(); r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'story_body', value: long } })); assert.equal(r.status, 200, 'a 20,000-character story fits in one request');
  const st = await (await pub('/api/state')).json(); assert.deepEqual(st.story, { title: 'How it started', body: long }); assert.ok(!('intro' in st));
  const on = await pub('/'); assert.equal(on.status, 200); assert.ok(!(await on.text()).includes('data-intro'), 'one shell, no reveal attribute');
  assert.equal((await pub('/', { 'if-none-match': on.headers.get('etag') })).status, 304);
  assert.equal((await pub('/#/learn')).status, 200);
  const d = await (await adm('/api/panel/panel')).json();
  assert.ok(d.audit.some((a) => a.action === 'setting:story_body'), 'audited');
});

test('area switches: the server setting is the ceiling; the panel opens and closes what the server allows; each flip is audited and pushed to open pages', async () => {
  const flip = async (id, open) => json(await adm('/api/panel/area', { method: 'POST', body: { id, open } }));
  // everything closed on the server: the panel cannot open anything
  let r = await flip('chat', true); assert.equal(r.status, 403); assert.match(r.error, /Locked — opens after the outside audit/);
  assert.equal((await flip('nope', true)).status, 404);
  assert.equal((await json(await adm('/api/panel/area', { method: 'POST', body: { id: 'chat', open: 'yes' } }))).status, 400);
  r = await flip('chat', false); assert.equal(r.status, 200, 'closing is always allowed'); assert.equal(r.effective, false);
  // the server opens chat and accounts: the panel is still closed by default, so visitors still see "soon"
  app.config.chatOpen = true; app.config.accountsOpen = true;
  let st = await (await pub('/api/state')).json(); assert.equal(st.features.chat, false); assert.equal(st.features.accounts, false);
  assert.equal((await pub('/api/rooms/general/messages')).status, 503, 'route still closed');
  let d = await (await adm('/api/panel/panel')).json();
  assert.deepEqual(d.launch.find((l) => l.id === 'chat'), { id: 'chat', name: 'Chat', env: true, open: false, effective: false, locked: null });
  // an open page listens on the live stream; the flip arrives there without a reload
  const got = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: PUBLIC_HOST(), accept: 'text/event-stream' } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; const m = /event: settings\ndata: (.*)\n/.exec(buf); if (m) { res.destroy(); resolve(JSON.parse(m[1])); } });
    }); req.on('error', reject); req.end(); setTimeout(() => reject(new Error('no settings event')), 5000).unref();
  });
  await new Promise((r2) => setTimeout(r2, 150));
  r = await flip('chat', true); assert.equal(r.status, 200); assert.deepEqual(r, { status: 200, ok: true, open: true, effective: true });
  const ev = await got; assert.equal(ev.features.chat, true); assert.equal(ev.features.accounts, false, 'accounts still closed on the panel'); assert.ok(!('intro' in ev)); assert.ok(ev.story && 'title' in ev.story);
  st = await (await pub('/api/state')).json(); assert.equal(st.features.chat, true); assert.equal(st.features.accounts, false);
  assert.equal((await pub('/api/rooms/general/messages')).status, 200, 'route open now');
  r = await flip('accounts', true); assert.equal(r.status, 200);
  st = await (await pub('/api/state')).json(); assert.equal(st.features.accounts, true); assert.equal(st.features.ideas, true, 'ideas come with accounts');
  // a former area is not an area at all
  for (const id of ['store', 'club', 'boun' + 'ties', 'wallet']) { r = await flip(id, true); assert.equal(r.status, 404, id); }
  app.config.accountsOpen = false; st = await (await pub('/api/state')).json(); assert.equal(st.features.accounts, false, 'the server setting is the ceiling, whatever the panel says');
  // close chat again: effective immediately
  r = await flip('chat', false); assert.equal(r.status, 200);
  st = await (await pub('/api/state')).json(); assert.equal(st.features.chat, false);
  assert.equal((await pub('/api/rooms/general/messages')).status, 503);
  d = await (await adm('/api/panel/panel')).json();
  const flips = d.audit.filter((a) => a.action.startsWith('area:')).map((a) => `${a.action} ${JSON.parse(a.before)}→${JSON.parse(a.after)}`).reverse();
  assert.deepEqual(flips, ['area:chat closed→closed', 'area:chat closed→open', 'area:accounts closed→open', 'area:chat open→closed']);
  assert.deepEqual(d.settings.areas, { chat: false, accounts: true });
  app.config.chatOpen = false; r = await flip('accounts', false); assert.equal(r.status, 200);
});

test('links: add, edit, reorder, delete with the https-only rules; messages: hide/show', async () => {
  const bad = async (body, re) => { const r = await json(await adm('/api/panel/link', { method: 'POST', body })); assert.equal(r.status, 400, JSON.stringify(r)); assert.match(r.error, re); };
  await bad({ title: 'x', url: 'http://example.com', blurb: 'b' }, /https/);
  await bad({ title: 'x', url: 'https://localhost/x', blurb: 'b' }, /https/);
  await bad({ title: '', url: 'https://example.com', blurb: 'b' }, /Title/);
  await bad({ title: 'x', url: 'https://example.com', blurb: 'b'.repeat(161) }, /too long/);
  let r = await json(await adm('/api/panel/link', { method: 'POST', body: { title: 'Example', url: 'https://example.com/path', blurb: 'An example' } })); assert.equal(r.status, 200);
  const id = r.id; let links = (await (await pub('/api/allies')).json()).allies; assert.equal(links[links.length - 1].title, 'Example', 'new links go last');
  r = await json(await adm('/api/panel/link', { method: 'POST', body: { id, title: 'Example 2', url: 'https://example.com/other', blurb: 'Edited' } })); assert.equal(r.status, 200);
  links = (await (await pub('/api/allies')).json()).allies; assert.equal(links.find((l) => l.id === id).title, 'Example 2');
  const ids = links.map((l) => l.id); const reordered = [ids[ids.length - 1], ...ids.slice(0, -1)];
  r = await json(await adm('/api/panel/links/order', { method: 'POST', body: { ids: reordered } })); assert.equal(r.status, 200);
  links = (await (await pub('/api/allies')).json()).allies; assert.deepEqual(links.map((l) => l.id), reordered, 'order applied');
  assert.equal((await adm('/api/panel/links/order', { method: 'POST', body: { ids: reordered.slice(1) } })).status, 400, 'must list every id');
  assert.equal((await adm('/api/panel/links/order', { method: 'POST', body: { ids: [...reordered, 999] } })).status, 400);
  r = await json(await adm('/api/panel/link', { method: 'POST', body: { id, delete: true } })); assert.equal(r.status, 200);
  links = (await (await pub('/api/allies')).json()).allies; assert.ok(!links.some((l) => l.id === id));
  assert.equal((await adm('/api/panel/link', { method: 'POST', body: { id, delete: true } })).status, 404);
  const lore = (await (await adm('/api/panel/panel')).json()).lore[0];
  r = await json(await adm('/api/panel/lore', { method: 'POST', body: { id: lore.id, status: 'hidden' } })); assert.equal(r.status, 200);
  assert.equal(app.db.get('SELECT status FROM lore WHERE id=?', lore.id).status, 'hidden');
  assert.equal((await adm('/api/panel/lore', { method: 'POST', body: { id: lore.id, status: 'gone' } })).status, 400);
  r = await json(await adm('/api/panel/lore', { method: 'POST', body: { id: lore.id, status: 'approved' } })); assert.equal(r.status, 200);
  const d = await (await adm('/api/panel/panel')).json();
  assert.deepEqual(d.audit.slice(0, 6).map((a) => a.action).reverse(), ['link:add', 'link:edit', 'links:order', 'link:delete', 'lore:hidden', 'lore:approved']);
});

test('maintenance: visitors get a calm 503 page and the API answers 503; assets still load; the admin host is unaffected', async () => {
  let r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'maintenance', value: { on: true, text: 'Back in an hour.' } } })); assert.equal(r.status, 200);
  const page = await pub('/'); assert.equal(page.status, 503); assert.equal(page.headers.get('retry-after'), '120'); assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text(); assert.ok(html.includes('Back soon') && /\/css\/app\.[0-9a-f]{10}\.css/.test(html), 'calm page with the site stylesheet');
  assert.ok(html.includes('Back in an hour.') && !html.includes('<p class="soon-note"></p>'), 'the admin note is on the page');
  await adm('/api/panel/setting', { method: 'POST', body: { key: 'maintenance', value: { on: true, text: 'see <b>x</b> & "y"' } } });
  const esc = await (await pub('/')).text(); assert.ok(esc.includes('see &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;') && !esc.includes('<b>x</b>'), 'note is escaped');
  await adm('/api/panel/setting', { method: 'POST', body: { key: 'maintenance', value: { on: true, text: 'costs $& more, see $` and $\'' } } });
  const dollars = await (await pub('/')).text(); assert.ok(dollars.includes('costs $&amp; more, see $` and $&#39;'), 'replacement patterns in the note are shown as typed, never expanded: ' + /soon-note">[^<]*/.exec(dollars)?.[0]);
  assert.equal((await pub('/#/learn')).status, 503); assert.equal((await pub('/learn')).status, 503);
  const api = await pub('/api/state'); assert.equal(api.status, 503); assert.deepEqual(await api.json(), { error: 'Back soon.', maintenance: true });
  assert.equal((await pub('/api/stream')).status, 503);
  assert.equal((await pub('/css/app.css')).status, 200, 'styles still served'); assert.equal((await pub('/img/favicon.svg')).status, 200);
  assert.equal((await adm('/api/panel/panel')).status, 200, 'admin unaffected'); assert.equal((await adm('/')).status, 200);
  r = await json(await adm('/api/panel/setting', { method: 'POST', body: { key: 'maintenance', value: { on: false } } })); assert.equal(r.status, 200);
  assert.equal((await pub('/')).status, 200); assert.equal((await pub('/api/state')).status, 200);
});

test('missing configuration = the admin host answers 404 to everything, with a valid token too', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbadmin2-'));
  for (const env of [{ ADMIN_HOST: 'admin.localhost:3000' }, { ADMIN_HOST: 'admin.localhost:3000', ACCESS_TEAM: TEAM, ADMIN_ACCESS_AUD: AUD }, { ADMIN_HOST: 'admin.localhost:3000', ACCESS_TEAM: TEAM, ADMIN_ACCESS_AUD: AUD, ADMIN_EMAIL_SHA256: 'nope' }]) {
    const app2 = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(d2, 'b.db'), PUBLIC_ORIGIN: 'http://localhost:3000', ...env }, rpc, fetchImpl: fakeFetch, log: () => {} });
    const a = await app2.listen(0); app2.config.adminHost = `admin.localhost:${a.port}`;
    const savedPort = port; port = a.port;
    try {
      assert.equal((await adm('/api/panel/panel')).status, 404, JSON.stringify(env));
      assert.equal((await adm('/')).status, 404, JSON.stringify(env));
    } finally { port = savedPort; await app2.close(); }
  }
  // no ADMIN_HOST at all: that hostname is just a wrong host
  const app3 = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(d2, 'c.db'), PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  const a = await app3.listen(0);
  { const savedPort = port; port = a.port; try { assert.equal((await adm('/api/panel/panel')).status, 421); } finally { port = savedPort; await app3.close(); } }
  assert.throws(() => createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(d2, 'd.db'), PUBLIC_ORIGIN: 'http://localhost:3000', ADMIN_HOST: 'localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} }), /must differ/);
  fs.rmSync(d2, { recursive: true, force: true });
});

// ---- moderation routes: same guards as every admin write; actions need a reason; audit + undo
test('moderation: queue, people, actions with reasons, undo', async () => {
  await new Promise((r) => setTimeout(r, 2600)); // the admin write limiter (120/min, burst 60) refills 2/s; the tests above spent part of the burst and this one needs most of it
  app.config.chatOpen = true; app.config.accountsOpen = true; app.settings.set('areas', { chat: true, accounts: true });
  // a member on the public host posts
  let cookie = '';
  const pubCall = async (method, p, body) => { const r = await req(p, { method, headers: { host: PUBLIC_HOST(), 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0]; return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const k = plantUser(app.db, newUid('mod')); cookie = sessionFor(app.db, k);
  assert.equal((await pubCall('POST', '/api/me/name', { name: 'modtarget' })).status, 200);
  const m = await pubCall('POST', '/api/rooms/general/messages', { body: 'hello from the target' }); assert.equal(m.status, 200, JSON.stringify(m));
  await new Promise((r) => setTimeout(r, 2100));
  const held = await pubCall('POST', '/api/rooms/general/messages', { body: 'any telegram group?' }); assert.equal(held.held, true);
  // the panel: counts + the moderation data
  const panel = await (await adm('/api/panel/panel')).json(); assert.equal(panel.mod.queue, 1); assert.ok(!('post_' + 'min_tbb' in panel.settings));
  let md = await (await adm('/api/panel/mod')).json();
  assert.equal(md.queue[0].kind, 'held'); assert.equal(md.queue[0].message.body, 'any telegram group?'); assert.equal(md.queue[0].user.name, 'modtarget'); assert.deepEqual(md.muteMinutes, [10, 60, 1440, 10080]);
  const me = md.users.find((u) => u.name === 'modtarget'); assert.ok(me && me.msgs === 2 && me.status === 'ok' && me.short.includes('…'));
  assert.equal((await (await adm('/api/panel/mod?q=modtar')).json()).users.length, 1);
  const msgs = await (await adm(`/api/panel/mod/messages?uid=${k}`)).json(); assert.equal(msgs.messages.length, 2); assert.equal(msgs.messages[0].held, true);
  // guards: the same as every admin write
  assert.equal((await adm('/api/panel/mod/action', { raw: '{}', headers: { 'content-type': 'application/json' } })).status, 403, 'missing X-Admin');
  assert.equal((await adm('/api/panel/mod', { token: null })).status, 403);
  assert.equal((await pub('/api/panel/mod')).status, 404, 'not on the public host');
  // actions: a reason is required where it matters; everything is audited and undoable
  const act = async (body) => json(await adm('/api/panel/mod/action', { method: 'POST', body }));
  let r = await act({ action: 'hide', id: m.message.id }); assert.equal(r.status, 400); assert.match(r.error, /reason/);
  r = await act({ action: 'nope', id: 1 }); assert.equal(r.status, 404);
  r = await act({ action: 'mute', uid: k, minutes: 5, reason: 'x' }); assert.equal(r.status, 400);
  r = await act({ action: 'approve', id: held.message.id, qid: md.queue[0].qid }); assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(app.db.get('SELECT hidden, held FROM messages WHERE id=?', held.message.id).hidden, 0);
  assert.equal((await (await adm('/api/panel/mod')).json()).queue.length, 0, 'queue item closed');
  r = await act({ action: 'hide', id: m.message.id, reason: 'test hide' }); assert.equal(r.status, 200);
  assert.equal(app.db.get('SELECT hidden FROM messages WHERE id=?', m.message.id).hidden, 1);
  r = await act({ action: 'mute', uid: k, minutes: 60, reason: 'cool off' }); assert.equal(r.status, 200);
  const muted = await pubCall('POST', '/api/rooms/general/messages', { body: 'still here?' }); assert.equal(muted.status, 403); assert.match(muted.error, /muted/);
  md = await (await adm('/api/panel/mod')).json();
  assert.equal(md.users.find((u) => u.name === 'modtarget').status, 'muted');
  const muteAction = md.recent.find((a) => a.action === 'mute'); assert.ok(muteAction.undoable && muteAction.actor === 'panel' && muteAction.reason === 'cool off');
  r = await json(await adm('/api/panel/mod/undo', { method: 'POST', body: { id: muteAction.id } })); assert.equal(r.status, 200);
  assert.equal((await (await adm('/api/panel/mod')).json()).users.find((u) => u.name === 'modtarget').status, 'ok');
  r = await json(await adm('/api/panel/mod/undo', { method: 'POST', body: { id: muteAction.id } })); assert.equal(r.status, 409, 'not twice');
  r = await act({ action: 'kick', uid: k, reason: 'bye' }); assert.equal(r.status, 200);
  assert.equal((await pubCall('GET', '/api/state')).me, null, 'kicked: signed out');
  r = await act({ action: 'ban', uid: k, reason: 'scammer' }); assert.equal(r.status, 200);
  cookie = sessionFor(app.db, k); assert.equal((await pubCall('GET', '/api/state')).me, null, 'a banned account has no session, however it got one');
  r = await act({ action: 'unban', uid: k }); assert.equal(r.status, 200);
  const audit = (await (await adm('/api/panel/panel')).json()).audit.map((a) => a.action);
  for (const a of ['mod:approve', 'mod:hide', 'mod:mute', 'mod:undo', 'mod:kick', 'mod:ban', 'mod:unban']) assert.ok(audit.includes(a), a);
  assert.ok(!JSON.stringify(await (await adm('/api/panel/panel')).json()).includes(k), 'the audit log keeps account ids short');
  // the former on-chain posting gate is no setting at all
  assert.equal((await adm('/api/panel/setting', { method: 'POST', body: { key: 'post_' + 'min_tbb', value: '1,000' } })).status, 404);
  app.config.chatOpen = false; app.config.accountsOpen = false; app.settings.set('areas', { chat: false, accounts: false });
});

// The Help page's "Report a problem" notes are read and cleared in the Access panel only (the public host has no admin page).
test('Help notes: listed on the admin host with a valid Access token only; 404 on the public host; clearing one or all deletes the text and writes an audit row without it', async () => {
  const note = (text, ip) => req('/api/report', { method: 'POST', headers: { host: PUBLIC_HOST(), 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', 'x-forwarded-for': ip }, body: JSON.stringify({ kind: 'problem', target: 'help', reason: text }) });
  assert.equal((await note('The chart looks stuck on my phone.', '203.0.113.71')).status, 200);
  assert.equal((await note('Season 1 says ended but the board says 3 days left.', '203.0.113.72')).status, 200);
  // the public host: no route at all, like any admin thing (JSON 404, not a page)
  for (const p of ['/api/panel/help', '/api/panel/help/clear']) { const r = await pub(p); assert.equal(r.status, 404, p); assert.ok(!(await r.text()).includes('<'), 'JSON'); }
  // the admin host: nothing without the token or with the wrong person; the list with the admin's token
  assert.equal((await adm('/api/panel/help', { token: null })).status, 403);
  assert.equal((await adm('/api/panel/help', { token: jwt({ email: 'intruder@example.com' }) })).status, 403);
  const r = await adm('/api/panel/help'); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const d = await r.json();
  assert.equal(d.total, 2); assert.deepEqual(d.notes.map((n) => [n.text, n.member]), [['Season 1 says ended but the board says 3 days left.', false], ['The chart looks stuck on my phone.', false]], 'newest first, anonymous');
  assert.ok(d.notes.every((n) => typeof n.id === 'number' && typeof n.at === 'number' && Object.keys(n).sort().join() === 'at,id,member,text'), 'id, time, member flag and text — nothing else (no IP, no account id)');
  // clear one (audited), then the rest (audited), then nothing is left; a made-up id is 404; a write needs the header + origin
  await new Promise((r) => setTimeout(r, 2600)); // the admin write limiter refills 2/s; the moderation test above drained its burst
  assert.equal((await adm('/api/panel/help/clear', { body: { id: d.notes[0].id } })).status, 200);
  assert.equal((await adm('/api/panel/help/clear', { body: { id: d.notes[0].id } })).status, 404, 'already cleared');
  assert.equal((await adm('/api/panel/help/clear', { body: { id: 999999 } })).status, 404);
  assert.equal((await (await adm('/api/panel/help')).json()).total, 1);
  const all = await (await adm('/api/panel/help/clear', { body: { all: true } })).json(); assert.deepEqual(all, { ok: true, cleared: 1 });
  assert.deepEqual(await (await adm('/api/panel/help')).json(), { notes: [], total: 0 });
  // gone from the file too, not only from the table: secure_delete overwrites the freed bytes and the log is truncated
  const onDisk = Buffer.concat(['a.db', 'a.db-wal'].map((f) => { try { return fs.readFileSync(path.join(dir, f)); } catch { return Buffer.alloc(0); } }));
  for (const t of ['chart looks stuck', 'board says 3 days']) assert.ok(!onDisk.includes(t), `cleared note text still in the database file: ${t}`);
  const audit = app.db.all("SELECT action, before, after FROM admin_audit WHERE action LIKE 'help:%' ORDER BY id").map((a) => ({ ...a }));
  assert.deepEqual(audit.map((a) => a.action), ['help:clear', 'help:clear_all']);
  // the audit row records only that a note was cleared and which one: never its text (a cleared note is gone for good)
  assert.equal(audit[0].before, JSON.stringify({ id: d.notes[0].id }), JSON.stringify(audit[0])); assert.equal(audit[0].after, '{"cleared":1}');
  assert.deepEqual([audit[1].before, audit[1].after], ['{"open":1}', '{"cleared":1}']);
  assert.ok(!audit.some((a) => /Season 1|chart looks/.test(a.before + a.after)), 'no note text in the audit log');
  assert.equal(app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem'").n, 0, 'clearing deletes the rows (not a resolved flag)');
  assert.equal((await req('/api/panel/help/clear', { method: 'POST', headers: { host: ADMIN_HOST(), 'cf-access-jwt-assertion': jwt(), 'content-type': 'application/json' }, body: '{"all":true}' })).status, 403, 'no X-Admin header, no origin: refused');
});

test('an older audit log that copied Help-note text is rewritten to the id alone when the app starts', async () => {
  const dbFile = path.join(dir, 'legacy-audit.db');
  const first = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: dbFile, PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  first.db.run("DELETE FROM kv WHERE k='audit_rev'");
  first.db.run("INSERT INTO admin_audit(at,action,before,after,actor) VALUES(?,?,?,?,?)", 1, 'help:clear', '{"id":7,"note":"my phone number is 555 0100"}', '{"cleared":1}', 'panel');
  first.db.run("INSERT INTO admin_audit(at,action,before,after,actor) VALUES(?,?,?,?,?)", 2, 'link:add', null, '{"id":1,"title":"x"}', 'panel');
  first.db.run("INSERT INTO reports(kind,target,uid,reason,created_at,resolved) VALUES('problem','help',NULL,'an old cleared note',3,1)");
  first.db.close();
  const again = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: dbFile, PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  try {
    const rows = again.db.all('SELECT action, before, after FROM admin_audit ORDER BY id').map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ action: 'help:clear', before: '{"id":7}', after: '{"cleared":1}' }, { action: 'link:add', before: null, after: '{"id":1,"title":"x"}' }]);
    assert.equal(again.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem' AND resolved=1").n, 0, 'notes cleared under the old flag are deleted too');
  } finally { again.db.close(); }
});

// A reported idea is hidden from the queue: same host, same token, same write guards, same audit log.
test('the panel hides a reported idea from the queue — a reason required, the report resolved, audited; only with a valid Access token, never on the public host', async () => {
  await new Promise((r) => setTimeout(r, 2600)); // the admin write limiter refills 2/s
  app.config.chatOpen = true; app.config.accountsOpen = true; app.settings.set('areas', { chat: true, accounts: true });
  const member = () => {
    let cookie = '';
    const call = async (method, p, body) => { const r = await req(p, { method, headers: { host: PUBLIC_HOST(), 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = String(Array.isArray(sc) ? sc[0] : sc).split(';')[0]; return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
    return { call, async signIn(name) { const uid = plantUser(app.db, newUid('pm')); cookie = sessionFor(app.db, uid); assert.equal((await call('POST', '/api/me/name', { name })).status, 200); return uid; } };
  };
  const post = async (p, body, opts = {}) => json(await adm(p, { method: 'POST', body, ...opts }));
  // the guards, the same as every other admin route
  assert.equal((await pub('/api/panel/mod/action')).status, 404, 'not on the public host');
  assert.equal((await adm('/api/panel/mod/action', { raw: '{}', headers: { 'content-type': 'application/json' } })).status, 403, 'missing X-Admin');
  assert.equal((await adm('/api/panel/mod/action', { raw: '{}', headers: { 'content-type': 'application/json', 'x-admin': '1', origin: 'http://localhost:3000' } })).status, 403, 'wrong origin');
  const author = member(); await author.signIn('ideaauthor');
  const idea = await author.call('POST', '/api/ideas', { title: 'Spam idea', body: 'x' }); assert.equal(idea.status, 200, JSON.stringify(idea));
  const reporter = member(); await reporter.signIn('reporter');
  assert.equal((await reporter.call('POST', '/api/report', { kind: 'idea', target: String(idea.idea.id), reason: 'spam' })).status, 200);
  let md = await (await adm('/api/panel/mod')).json();
  const qi = md.queue.find((q) => q.kind === 'report' && q.target === 'idea'); assert.ok(qi, 'the report is in the queue: ' + JSON.stringify(md.queue.map((q) => [q.kind, q.target])));
  assert.equal((await post('/api/panel/mod/action', { action: 'hide_idea', id: Number(qi.targetId), qid: qi.qid })).status, 400, 'a reason is required');
  const r = await post('/api/panel/mod/action', { action: 'hide_idea', id: Number(qi.targetId), qid: qi.qid, reason: 'spam' }); assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(app.db.get('SELECT hidden FROM ideas WHERE id=?', idea.idea.id).hidden, 1);
  assert.ok(!(await author.call('GET', '/api/ideas')).ideas.some((i) => i.id === idea.idea.id), 'off the board');
  md = await (await adm('/api/panel/mod')).json(); assert.ok(!md.queue.some((q) => q.kind === 'report' && q.target === 'idea'), 'the report is resolved');
  assert.equal((await post('/api/panel/mod/action', { action: 'hide_idea', id: 999999, reason: 'x' })).status, 404);
  for (const action of ['remove_' + 'list' + 'ing', 'approve_' + 'image', 'reject_' + 'image']) assert.equal((await post('/api/panel/mod/action', { action, id: 1, reason: 'x' })).status, 404, action + ' is no action');
  const panel = await (await adm('/api/panel/panel')).json(); const audit = panel.audit.map((a) => a.action);
  assert.ok(audit.includes('mod:hide_idea'), 'audited: ' + audit.join(','));
  assert.ok(!/u_pm[0-9a-f]{16}/.test(JSON.stringify(panel)), 'the audit log keeps account ids short');
  app.config.chatOpen = false; app.config.accountsOpen = false; app.settings.set('areas', { chat: false, accounts: false });
});
