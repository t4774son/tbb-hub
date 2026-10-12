// The launch surface: the site as it ships — every launch switch closed, Sign in with X unset,
// the production-like start (https origin, CLIENT_IP_HEADER, admin host behind Access). Proves, route by route, that the
// public host is a read-only dashboard: every write/auth/chat/admin route answers closed (503), unauthorised (401/403)
// or 404; no admin asset or path exists on the public host; /api/state and the live stream carry public numbers only;
// the headers name no software; the page talks to no outside host by itself; and administration has no route here
// (test/unit/admin-host-only.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = 'hub.example.com'; const ORIGIN = `https://${HOST}`;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbblaunch-'));
let app; let port;
before(async () => {
  // exactly the launch environment: no *_OPEN flag at all, no X_* setting, the production-like plumbing
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', PUBLIC_ORIGIN: ORIGIN, CLIENT_IP_HEADER: 'cf-connecting-ip', ADMIN_HOST: `admin.${HOST}`, ACCESS_TEAM: 'example-team', ADMIN_ACCESS_AUD: 'e'.repeat(64), ADMIN_EMAIL_SHA256: crypto.createHash('sha256').update('admin@example.com').digest('hex'), DB_FILE: path.join(dir, 'a3.db') },
    rpc: async () => { throw new Error('no rpc at launch'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });
  port = (await app.listen(0)).port;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// fetch() drops a custom Host header, so the probes use node:http (the server checks the host like Cloudflare will send it)
let ipN = 0;
function raw(method, p, { body = null, host = HOST, headers = {}, ip = `203.0.113.${1 + (ipN++ % 200)}` } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host, 'cf-connecting-ip': ip, ...(method !== 'GET' && method !== 'HEAD' ? { 'content-type': 'application/json', 'x-tbb': '1', origin: ORIGIN } : {}), ...headers };
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (data) h['content-length'] = Buffer.byteLength(data); // Node refuses a chunked DELETE body outright (400, no handler runs); the browser always sends a length
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d, json: (() => { try { return JSON.parse(d); } catch { return null; } })() })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const PUBLIC_READS = ['/api/state', '/api/lore', '/api/chart', '/api/allies'];
// the two POSTs that answer 200 to a stranger, each on purpose
const OPEN_WRITES = { '/api/auth/logout': 'clears the caller’s own cookie; nothing to clear', '/api/report': 'the Help page’s “Report a problem” note: anonymous, 1000 chars, 10/min burst 5 per IP, 500 unresolved cap' };
const BODIES = { '/api/report': { kind: 'problem', target: 'help', reason: 'launch check' } };

test('launch: every API route is a public read, a deliberate open POST, or closed/unauthorised/404; nothing is written', async () => {
  assert.ok(app.routes.length >= 25, 'the route table is exported');
  const counts = () => ['users', 'sessions', 'messages', 'ideas', 'votes', 'inbox', 'allies', 'ip_log', 'reports'].map((t) => [t, app.db.get(`SELECT COUNT(*) n FROM ${t}`).n]);
  const before0 = Object.fromEntries(counts());
  const seen = {};
  for (const { method, pattern } of app.routes) {
    const p = pattern.replace(':room', 'general').replace(/:\w+/g, '1');
    const r = await raw(method, p, { body: method === 'GET' ? null : (BODIES[pattern] || {}) });
    seen[`${method} ${pattern}`] = r.status;
    if (method === 'GET' && PUBLIC_READS.includes(pattern)) assert.equal(r.status, 200, `${method} ${pattern} is a public read`);
    else if (method === 'POST' && OPEN_WRITES[pattern]) assert.equal(r.status, 200, `${method} ${pattern}: ${OPEN_WRITES[pattern]}`);
    else assert.ok([401, 403, 404, 503].includes(r.status), `${method} ${pattern} answered ${r.status} ${r.text.slice(0, 80)} — must be closed (503), unauthorised (401/403) or 404`);
    if (r.status === 503 || r.status === 404) assert.ok(!r.text.includes('<'), 'JSON error, not a page');
  }
  assert.ok(!app.routes.some((r) => /admin/.test(r.pattern)), 'no admin route on the public host at all');
  // closed areas answer exactly "coming soon" (503), not a hint about what is behind them
  for (const k of ['POST /api/rooms/:room/messages', 'PATCH /api/messages/:id', 'DELETE /api/messages/:id', 'POST /api/ideas', 'POST /api/auth/signup', 'POST /api/auth/login', 'POST /api/auth/recover', 'GET /api/auth/pow', 'POST /api/me/name', 'GET /api/ideas', 'GET /api/inbox']) assert.equal(seen[k], 503, k);
  assert.equal(seen['GET /api/auth/x/pending'], 404, 'X is unset: its routes do not exist'); assert.equal(seen['POST /api/auth/x/finish'], 404);
  // the sweep wrote exactly one row anywhere: the Help note
  const after0 = Object.fromEntries(counts());
  for (const [t, n] of Object.entries(after0)) {
    if (t === 'reports') assert.equal(n, before0[t] + 1, 'one Help note stored');
    else assert.equal(n, before0[t], `${t} untouched`);
  }
  const note = app.db.get('SELECT kind, target, uid, reason FROM reports ORDER BY id DESC LIMIT 1');
  assert.deepEqual({ ...note }, { kind: 'problem', target: 'help', uid: null, reason: 'launch check' });
});

test('launch: no door on the public host — an admin path is the 404 of an unknown path; the page has no admin view, flag or back door', async () => {
  const strip = (r) => ({ status: r.status, text: r.text, type: r.headers['content-type'], cache: r.headers['cache-control'], len: r.headers['content-length'] });
  for (const p of ['/api/' + 'admin', '/api/' + 'admin/ban', '/api/panel/panel']) assert.deepEqual(strip(await raw('GET', p)), strip(await raw('GET', '/api/nope')), p + ' is the same 404 as an unknown path');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM users').n, 0, 'no account, no session'); assert.equal(app.db.get('SELECT COUNT(*) n FROM sessions').n, 0);
  // the page has no ?admin back door, no admin view and no admin role: an admin address typed in is "Not found" like any missing address
  const js = [fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'public/js/views.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'public/js/views-closed.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'public/js/account.js'), 'utf8')].join('\n');
  assert.ok(!/has\('admin'\)|\?admin/.test(js), 'no ?admin in the page script');
  assert.ok(!/admin: lazy\(|me\?\.admin|me\.admin|\.admin\b/.test(js), 'no admin view, no admin flag read anywhere in the page');
  assert.ok(!/Admins only/.test(js), 'no "Admins only" wording that would admit an admin page exists');
});

test('launch: the closed areas are off the dock (hidden tabs, no Soon mark, nothing disabled); Learn and Share are the hero actions; no grouped Soon tab', async () => {
  const html = (await raw('GET', '/')).text;
  assert.ok(!/soonTab|soonPop|soon-item|dk-more|dk-soon|aria-disabled/.test(html), 'no grouped Soon tab, no Soon mark, nothing aria-disabled');
  const dock = /<nav class="dock"[\s\S]*?<\/nav>/.exec(html)[0];
  const tabs = [...dock.matchAll(/<a class="dk([^"]*)" href="#\/(\w+)" data-dk="\w+"([^>]*)>/g)].map((m) => [m[2], /\bhidden\b/.test(m[3])]);
  assert.deepEqual(tabs, [['story', false], ['links', false], ['season', false], ['learn', false], ['build', true], ['live', true]], 'dock order; the two closed tabs hidden in the shell: ' + JSON.stringify(tabs));
  const hero = /<div class="hero-actions">[\s\S]*?<\/div>/.exec(html)[0];
  assert.ok(/class="btn btn-primary hero-btn" href="#\/learn"[^>]*data-k="learn"/.test(hero), 'Learn is the primary action');
  assert.ok(/<button class="btn hero-btn" id="shareBtn" type="button"/.test(hero), 'Share is the other');
  assert.equal((hero.match(/<a |<button /g) || []).length, 2, 'two hero actions, nothing leaving the site');
  assert.ok(!/Buy<|Stake|https:/.test(hero), 'no Buy or Stake button, no outside link');
  // the script brings a tab back from the server's switches; a closed address typed in still says "Coming soon." and goes nowhere
  const js = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.ok(/soonMark\(\$\('\.dk\[data-dk="live"\]'\), !chat\)/.test(js) && /soonMark\(\$\('\.dk\[data-dk="build"\]'\), !ideas\)/.test(js), 'the two tabs follow the switches, and nothing else');
  for (const p of ['#/chat', '#/live']) assert.ok(new RegExp(`\\['${p.replace('/', '\\/')}', \\(\\) => [^\\]]*'Coming soon\\.'\\]`).test(js), p + ' toasts "Coming soon."');
  assert.ok(/VIEWS\.comingSoon/.test(js), 'typed addresses keep the calm card');
});

test('there is no Swap: no hero button, route, feature flag, view, icon, style, panel switch or server setting mentions it', async () => {
  const html = (await raw('GET', '/')).text;
  assert.ok(!/swap/i.test(html), 'the shell never says swap');
  const served = ['public/js/app.js', 'public/js/views.js', 'public/js/ui.js', 'public/css/app.css', 'public/index.html', 'admin/admin.js', 'admin/index.html', 'admin/admin.css', 'lib/app.js', 'lib/admin.js', 'lib/settings.js', 'server.js', 'scripts/shots.js', '.env.example'];
  for (const f of served) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/font-display: swap/g, '');
    assert.ok(!/swap/i.test(src), f + ' mentions swap');
  }
  const st = (await raw('GET', '/api/state')).json;
  assert.ok(!('swap' in st.features), 'no swap feature flag');
  assert.ok(!('swapOpen' in app.config), 'no swap server setting');
});

test('launch: nothing admin on the public host; dot paths, source maps and uploads are 404; the admin host without Access is refused', async () => {
  for (const p of ['/admin.js', '/admin.css', '/admin/index.html', '/api/panel/panel', '/api/panel/mod', '/api/panel/setting', '/upl' + 'oads/abcdefghijk.png', '/js/app.js.map', '/css/app.css.map', '/.env', '/.git/HEAD', '/.git/config', '/.well-known/other.txt', '/.well-known/', '/.well-known', '/.hidden/x', '/index.html', '/server.js', '/lib/app.js', '/package.json', '/data/hub.db', '/..%2fserver.js']) {
    const r = await raw('GET', p); assert.equal(r.status, 404, p); assert.ok(!r.text.includes('<html'), p + ' is not the page');
  }
  // unknown extension-less paths are the plain 404 (the page lives at / only), never the panel
  for (const p of ['/admin', '/admin/', '/nowhere', '/%ff%fe']) { const r = await raw('GET', p); assert.equal(r.status, 404, p); assert.ok(!r.text.includes('<html') && !r.text.includes('admin.js') && !r.text.includes('/api/panel/'), p + ' is the plain 404'); }
  // the admin host answers nothing without a valid Access token: no HTML, no asset, no API
  for (const p of ['/', '/admin.js', '/api/panel/panel', '/css/app.css']) { const r = await raw('GET', p, { host: `admin.${HOST}` }); assert.equal(r.status, 403, 'admin host ' + p); assert.ok(!r.text.includes('<'), 'JSON only'); }
  assert.equal((await raw('GET', '/', { host: 'evil.example' })).status, 421, 'any other host');
  // the HTML the public gets names no admin-side thing
  const html = (await raw('GET', '/')).text;
  for (const bad of [/admin\./i, /cloudflareaccess/i, /workers\.dev\/api/i, /e{64}/, /sourceMappingURL/, /\/home\//, /TODO|FIXME/]) assert.ok(!bad.test(html), String(bad));
});

test('launch: /api/state and the live stream carry public numbers and copy only', async () => {
  const st = (await raw('GET', '/api/state')).json;
  assert.deepEqual(Object.keys(st).sort(), ['alerts', 'banner', 'features', 'genesis', 'lore', 'me', 'operator', 'rooms', 'sections', 'stats', 'story', 'x'].sort());
  assert.equal(st.me, null); assert.equal(st.x, false, 'no X button');
  assert.deepEqual(st.features, { chat: false, accounts: false, ideas: false });
  assert.deepEqual(Object.keys(st.stats).sort(), ['at', 'btcHeight', 'btcUsd', 'change24h', 'fdv', 'feeds', 'holders', 'marketCap', 'price', 'season', 'staked'].sort()); // btcUsd: the BTC price, for the price in sats
  for (const k of Object.keys(st.stats.feeds)) assert.deepEqual(Object.keys(st.stats.feeds[k]).sort(), ['at', 'ttl'], 'feed ages carry a time and a period, not a URL or an error');
  const s = JSON.stringify(st); for (const bad of [/cloudflareaccess|example-team|admin\.hub|e{64}|sha256|helius|api_key|apikey|\/home\//i]) assert.ok(!bad.test(s), String(bad));
  // the stream: a hello with the block height (never a visitor count), then only pings until a feed changes
  const first = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/stream', headers: { host: HOST, 'cf-connecting-ip': '203.0.113.250' } }, (res) => { res.once('data', (c) => { resolve({ status: res.statusCode, headers: res.headers, chunk: String(c) }); res.destroy(); }); });
    r.on('error', reject); r.end();
  });
  assert.equal(first.status, 200); assert.equal(first.headers['content-type'], 'text/event-stream'); assert.equal(first.headers['cache-control'], 'no-store');
  const hello = JSON.parse(/event: hello\ndata: (.*)\n/.exec(first.chunk)[1]);
  assert.deepEqual(Object.keys(hello).sort(), ['height', 'ttl']); assert.equal(hello.ttl, 3600_000); // ttl: how long this stream lives
});

test('launch: the headers name no software, carry the CSP everywhere, and the ETag is a content hash', async () => {
  for (const [p, type] of [['/', 'text/html'], ['/css/app.css', 'text/css'], ['/js/app.js', 'text/javascript'], ['/img/summit-wide.jpg', 'image/jpeg'], ['/art/tbb-whitepaper.png', 'image/png'], ['/api/chart', 'application/json'], ['/nowhere.txt', 'text/plain'], ['/api/nope', 'application/json']]) {
    for (const method of ['GET', 'HEAD']) {
      const r = await raw(method, p);
      assert.ok(!('server' in r.headers) && !('x-powered-by' in r.headers) && !('via' in r.headers), `${method} ${p}: no software header`);
      assert.match(String(r.headers['content-type']), new RegExp('^' + type.replace('/', '\\/')), `${method} ${p}`);
      assert.ok(String(r.headers['content-security-policy']).includes("default-src 'self'") && String(r.headers['content-security-policy']).includes("connect-src 'self'"), `${method} ${p}: CSP`);
      assert.equal(r.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains', `${method} ${p}: HSTS on the https origin`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.equal(r.headers['x-frame-options'], 'DENY');
      if (r.status === 200 && !p.startsWith('/api/')) assert.match(String(r.headers.etag), /^"[A-Za-z0-9_-]{22}"$/, `${method} ${p}: content-hash ETag, no inode or time`);
      if (method === 'GET') { if (p === '/' || p === '/api/chart') assert.equal(r.headers['cache-control'], 'no-cache', p + ': revalidated, never stale'); if (p === '/api/nope' || p === '/nowhere.txt') assert.equal(r.headers['cache-control'], 'no-store'); }
      if (method === 'HEAD' && p.startsWith('/api/')) assert.equal(r.status, 404, 'API routes are GET-only');
      if (method === 'HEAD') assert.equal(r.text, '', 'HEAD has no body');
    }
  }
  const bad = await raw('GET', '/nowhere.txt'); assert.equal(bad.text, 'This page has moved on to other things.', 'one fixed 404 sentence');
  assert.equal((await raw('GET', '/api/nope')).text, '{"error":"Not found"}');
});

test('launch: the shipped front end fetches nothing from outside; outside hosts appear only as links a visitor must click', () => {
  const files = ['public/index.html', 'public/back-soon.html', 'public/css/app.css', ...fs.readdirSync(path.join(ROOT, 'public/js')).map((f) => 'public/js/' + f)];
  // thebitcoinbull.club is this site's own canonical origin (the share-preview tags need absolute URLs); stakethebull.xyz is not linked any more
  const ALLOWED_LINK_HOSTS = new Set(['thebitcoinbull.club', 'tbb-buyer-board.garden-equity-field-0042.workers.dev', 'tbbtimemachine.xyz', 'store.bitcoinhard.money', 'mempool.space', 'solscan.io', 'satoshi.nakamotoinstitute.org', 'www.w3.org']);
  const hosts = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
    // nothing the browser loads by itself points outside: no absolute URL in src=, srcset, url(), fetch(), EventSource, import or @import
    for (const m of src.matchAll(/(?:src|srcset|href)=["']https?:\/\/|url\(["']?https?:\/\/|fetch\(\s*["'`]https?:|EventSource\(\s*["'`]https?:|import\(\s*["'`]https?:|@import\s+["']?https?:/gi)) {
      const ctx = src.slice(Math.max(0, m.index - 120), m.index + 120);
      assert.ok(/target: '_blank'|target="_blank"|rel=.noopener/.test(ctx) || /rel="canonical" href="https:\/\/thebitcoinbull\.club\/"/.test(ctx) || /href=["']https?:\/\/tbb-buyer-board/.test(m[0] + ctx), `${f}: ${m[0]} — an outside URL the browser would load on its own`); // the canonical link is a label, not a fetch
    }
  }
  for (const h of hosts) assert.ok(ALLOWED_LINK_HOSTS.has(h), `unexpected outside host in the front end: ${h}`);
  // and the CSP forbids the browser from fetching anywhere but this site, so a slip could not run
  const csp = fs.readFileSync(path.join(ROOT, 'lib/http.js'), 'utf8');
  assert.ok(/connect-src 'self'/.test(csp) && /img-src 'self' data:;/.test(csp) && /script-src 'self'/.test(csp) && /font-src 'self'/.test(csp), 'CSP keeps every fetch on this site');
});

test('launch: scripts/shots.js has a launch mode that runs with exactly the production switches (all closed, X unset)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/shots.js'), 'utf8');
  assert.ok(src.includes("includes('--launch')"), 'a --launch flag');
  const launchEnv = /LAUNCH \? \{\} : \{ CHAT_OPEN: '1', ACCOUNTS_OPEN: '1' \}/.test(src);
  assert.ok(launchEnv, 'in launch mode no *_OPEN flag is set');
  assert.ok(!/X_CLIENT_ID/.test(src), 'X is never configured for screenshots');
  assert.ok(/shots\/launch/.test(src) && /'home', 'learn', 'links'/.test(src) && !/'soon'/.test(src), 'launch shots: home, Learn, Links into shots/launch (the Ideas card has no tab while closed)');
  assert.ok(/'1440x900,390x844,360x640,320x640'/.test(src), 'launch sizes include 320x640');
});

test('no first-visit age card — the shell, the styles and the scripts carry no gate; nothing a visitor reads mentions 18+ or adults; the dormant account-side confirmation stays', async () => {
  const html = (await raw('GET', '/')).text;
  assert.ok(!/ageGate|age-gate|age-card|ageTitle|ageYes|ageLeave|data-gate/.test(html), 'no age-card markup in the shell');
  assert.ok(!/18\+|18 or older|18 and over|\badults?\b|age-/i.test(html), 'no 18+ / adult wording anywhere in the shell (the mesh keys data-k="18" are not words)');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const theme = read('public/js/theme.js'); const intro = ''; const app = read('public/js/app.js'); const css = read('public/css/app.css'); const views = read('public/js/views.js');
  assert.ok(!/data-gate|dataset\.gate|tbb:adult|ageGate|age-gate|age-card|ageYes|ageLeave|gateShow|tbb-adult/.test(theme + intro + css), 'no gate decision before paint, no waiting reveal, no card styles');
  assert.ok(!/dataset\.gate|tbb:adult|ageGate|ageYes|ageLeave|gateShow/.test(app), 'no gate wiring in the page script');
  assert.ok(!/18 or older|18 and over|18\+|\badults\b|Age and location/.test(views), 'the read-only views (disclaimer included) say nothing about age (the `adult` error code is not wording)');
  // what stays dormant until accounts and chat open: the sign-up / X welcome tick and a plain dialog before a first post
  const account = read('public/js/account.js'); // the dialogs load on demand
  assert.ok(/id: 'adultTick'/.test(account) && /I’m 18 or older/.test(account) && /export function ensureAdult/.test(account) && /modal\('Confirm your age'/.test(account), 'the account-side confirmation is still there, as a plain modal');
  // the server still refuses a post without the account confirmation (lib/ untouched)
  assert.ok(/adult/.test(read('lib/rules.js')) && /\/api\/me\/adult/.test(read('lib/app.js')), 'server-side checks untouched');
});

// A crafted #/?x=… link must not wake the closed account code while accounts are closed: the X return is gated on the state.
test('the X return runs only when the state says accounts are open', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const app = read('public/js/app.js');
  assert.ok(!/^\s*if \(\/\^#.*account\(\)\.then\(\(a\) => a\.xReturn\(\)\)/m.test(app), 'no unconditional xReturn at boot');
  assert.ok(/function xHash\(\)[\s\S]*?S\.x \|\| S\.features\?\.accounts \|\| S\.me[\s\S]*?replaceState/.test(app), 'xHash: account code only when open, else the hash is stripped');
});

// RFC 9116: where to report a problem, as a plain-text file at the well-known address (the only dot path that is served).
test('/.well-known/security.txt: text/plain, the four fields, an expiry in the future; served by its hashed name too (the live verifier compares it); nothing else under a dot', async () => {
  const r = await raw('GET', '/.well-known/security.txt');
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  const lines = r.text.trim().split('\n');
  assert.deepEqual(lines.filter((l) => !l.startsWith('#')).map((l) => l.split(':')[0]), ['Contact', 'Policy', 'Expires', 'Preferred-Languages'], r.text);
  assert.ok(lines.includes('Contact: https://github.com/t4774son/tbb-hub/security/advisories/new') && lines.includes('Policy: https://github.com/t4774son/tbb-hub/blob/main/SECURITY.md') && lines.includes('Preferred-Languages: en'), r.text);
  const exp = /^Expires: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/.exec(lines.find((l) => l.startsWith('Expires:')))?.[1];
  assert.ok(exp && Date.parse(exp) > Date.now() && Date.parse(exp) < Date.now() + 366 * 86400_000, 'expires within the year ahead: ' + exp);
  assert.equal((await raw('HEAD', '/.well-known/security.txt')).status, 200);
  const hashed = app.assets.hashedFor('/.well-known/security.txt');
  assert.match(hashed, /^\/\.well-known\/security\.[0-9a-f]{10}\.txt$/);
  const h = await raw('GET', hashed); assert.equal(h.status, 200); assert.equal(h.text, r.text);
  assert.equal(h.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await raw('POST', '/.well-known/security.txt')).status, 404, 'reads only');
});
