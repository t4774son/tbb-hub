#!/usr/bin/env node
// Screenshots of the home page in every state: the home, each drawer, a chat room, and the admin panel with its moderation screens (queue, people, log) —
// at four sizes, dark and light. Real server with fake feeds, real Chromium.
//   node scripts/shots.js                 → shots/<theme>-<size>-<state>.png
//   node scripts/shots.js --only home     → one state;  --sizes 1440x900,390x844  → some sizes;  --theme dark;  --out shots/before
//   node scripts/shots.js --launch        → what visitors see at launch: exactly the production switches (every *_OPEN flag
//                                           unset, Sign in with X unset), home · Learn (What is $TBB) · Links, dark and light,
//                                           1440x900 / 390x844 / 360x640 / 320x640, into shots/launch/ (the default run opens every area instead)
//   states: home story links season live chat chat-empty chat-refused chat-muted chat-banned
//           signin signup recovery recovery-code account learn learn-poster learn-staking learn-safety learn-lore help disclaimer
//           ideas lost maintenance fit (home at 390x664 / 360x640 with browser chrome, and at 125% zoom)
//           admin admin-status admin-areas admin-banner admin-story admin-maint admin-sections admin-links admin-lore admin-audit
//           admin-queue admin-people admin-ban admin-ipbans admin-log
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';
import { seed, DEMO_IDS } from './seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = (() => { for (const p of ['playwright-core', process.env.PLAYWRIGHT_CORE].filter(Boolean)) { try { return require(p); } catch { /* next */ } } throw new Error('playwright-core not found'); })();
const CHROME = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const LAUNCH = process.argv.includes('--launch');
const ONLY = arg('--only') ? arg('--only').split(',') : LAUNCH ? ['home', 'learn', 'links'] : null;
const THEMES = arg('--theme') ? [arg('--theme')] : ['dark', 'light'];
const SIZES = (arg('--sizes') || (LAUNCH ? '1440x900,390x844,360x640,320x640' : '1440x900,1280x720,1024x768,390x844,360x740,320x640')).split(',').map((s) => s.split('x').map(Number));
const OUT = path.resolve(ROOT, arg('--out') || (LAUNCH ? 'shots/launch' : 'shots')); fs.mkdirSync(OUT, { recursive: true });

const MINT = '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump';
const rpc = async (method) => {
  if (method === 'getAccountInfo') { const b = Buffer.alloc(237); b.writeBigUInt64LE(52_714_377_755_956n, 104); b.writeBigUInt64LE(169n, 120); return { value: { owner: '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT', data: [b.toString('base64'), 'base64'] } }; }
  if (method === 'getTokenSupply') return { value: { uiAmount: 999_996_129 } };
  throw new Error('rpc ' + method);
};
const TEAM = 'example-team'; const AUD = 'e'.repeat(64); const ADMIN_EMAIL = 'admin@example.com';
const RSA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (b) => Buffer.from(b).toString('base64url');
const token = () => { const now = Math.floor(Date.now() / 1000); const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' })); const body = b64u(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: ADMIN_EMAIL, iat: now, nbf: now, exp: now + 3600 })); return `${head}.${body}.${b64u(crypto.sign('sha256', Buffer.from(`${head}.${body}`), RSA.privateKey))}`; };
const fakeFetch = async (url) => {
  const u = String(url);
  const body = u.includes('/cdn-cgi/access/certs') ? { keys: [{ kid: 'kid-1', kty: 'RSA', alg: 'RS256', use: 'sig', ...RSA.publicKey.export({ format: 'jwk' }) }] }
    : u.includes('/api/board') ? { mint: MINT, season: { start: Date.now() - 5 * 86400_000, end: Date.now() + 25 * 86400_000, overtimeHours: 0, prizeTbb: 4206900, stakeApr: 0.08 }, totals: { buyers: 308, buys: 789, volumeUsd: 187421.07 }, leaderboard: [{ wallet: 'TestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAone', score: 10044.14 }, { wallet: 'TestWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBtwo', score: 6200 }, { wallet: 'TestWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCthree', score: 3100.5 }] }
    : u.includes('geckoterminal') ? { data: { attributes: { ohlcv_list: Array.from({ length: 24 }, (_, i) => [Math.floor(Date.now() / 1000) - i * 3600, 0, 0, 0, 0.0079 + Math.sin(i / 3) * 0.0002, 1]) } }, meta: { base: { address: MINT } } }
    : u.includes('dexscreener') ? { pairs: [{ baseToken: { address: MINT }, priceUsd: '0.008122', priceChange: { h24: 2.56 }, liquidity: { usd: 1 }, marketCap: 8122066, pairAddress: '6unnG2hL8udPjDpu3TchvAtptu3dq8AS7tymrWDN2LLC' }] }
    : u.includes('prices') ? { USD: 98250 } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbshots-'));
const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://localhost:${PORT}`; const ADMIN_BASE = `http://admin.localhost:${PORT}`;
// Launch mode runs the server with the production switches: no *_OPEN flag at all (every area "coming soon"), no X settings.
const app = createApp({ env: { PORT: String(PORT), LORE_WORKER: 'off', POW_BITS: '6', DB_FILE: path.join(dir, 's.db'), PUBLIC_ORIGIN: BASE, ...(LAUNCH ? {} : { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1' }),
  ADMIN_HOST: `admin.localhost:${PORT}`, ACCESS_TEAM: TEAM, ADMIN_ACCESS_AUD: AUD, ADMIN_EMAIL_SHA256: crypto.createHash('sha256').update(ADMIN_EMAIL).digest('hex') }, rpc, fetchImpl: fakeFetch, log: () => {} });
seed(app.db, { demo: true });
{ // a few plain chat lines for the chat shots (the seed writes no messages): the fake accounts from the demo seed
  const W = DEMO_IDS;
  const lines = [['general', 0, 'Morning. Anyone watching the block height tonight?'], ['general', 1, 'Staked a little more this week.'], ['general', 2, 'The Season 1 board updated an hour ago.'],
    ['builds', 1, 'Working on a bot that posts the TBB price once per block. Repo once it is tidy.'], ['builds', 3, 'Drafting a holder map that shows shapes only, no addresses.'], ['general', 3, 'Staked a little more this week too.']];
  const t = Date.now();
  lines.forEach(([r, w, b], i) => app.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', r, W[w], b, t - (lines.length - i) * 300_000));
}
app.db.run("INSERT OR IGNORE INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(0,'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f','tx0','coinbase','The Times 03/Jan/2009 Chancellor on brink of second bailout for banks',?, 'approved')", Date.now());
if (!LAUNCH) app.settings.set('areas', { chat: true, accounts: true }); // chat and accounts are open, so the Chat drawer and the sign-in dialog have something to show (launch mode: the server keeps everything shut whatever the panel says)
app.settings.set('story_title', 'How the bull got up the mountain');
app.settings.set('story_body', 'I did not start this to get rich. I started it because **every chart I had ever trusted** had lied to me at least once, and the one thing that never lied was the block height.\n\nSo I bought the dip. Then I bought *the dip of the dip*. The herd laughed, then the herd followed, then the herd stopped laughing.\n\nThis page is for them. Numbers first, feelings second, and the bull stays on the summit. The board is at https://tbb-buyer-board.garden-equity-field-0042.workers.dev/ if you want to see who is climbing.');
// Demo moderation data for the panel shots (fake accounts and names from the demo seed): a held message, a report, an
// automatic mute, a message hidden by community reports, and a few log lines.
{
  const W = DEMO_IDS;
  const t = Date.now();
  app.db.run("INSERT OR IGNORE INTO users(uid,name,created_at,adult_confirmed_at,via) VALUES('DemoEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE5','tbb_helpdesk99',?,?,'legacy')", t - 2 * 3600_000, t - 2 * 3600_000);
  const held = app.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', 'general', 'DemoEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE5', 'is there a telegram group for holders? asking for a friend', t - 9 * 60_000).lastInsertRowid;
  app.mod.hold(held, { actor: 'auto', reason: 'scam filter: offsite_app' });
  const spam = app.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', 'general', W[3], 'who else got their bags stolen by that fake staking site last week', t - 25 * 60_000).lastInsertRowid;
  app.db.run('INSERT INTO reports(kind,target,uid,reason,created_at) VALUES(?,?,?,?,?)', 'message', String(spam), W[0], 'he keeps posting this in every room', t - 20 * 60_000);
  app.db.run('INSERT INTO reports(kind,target,uid,reason,created_at) VALUES(?,?,?,?,?)', 'message', String(spam), W[1], 'spam', t - 18 * 60_000);
  const comm = app.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', 'builds', W[2], 'my bot can double your stake, serious people only', t - 50 * 60_000).lastInsertRowid;
  app.mod.hold(comm, { actor: 'community', reason: '3 reports from different accounts' });
  for (const k of ['link', 'link', 'secret', 'link']) app.mod.recordHit(W[3], k);
  const hid = app.mod.hide(Number(app.db.get("SELECT id FROM messages WHERE body LIKE 'Staked a little more this week.'").id), { actor: 'panel', reason: 'testing the hide button' }); app.mod.undo(hid, { actor: 'panel' });
  app.mod.mute(W[1], 60, { actor: 'panel', reason: 'cool off after the argument' });
  // A username account, a banned spammer whose connection is blocked too (hashed; the IPs here are documentation examples)
  app.db.run("INSERT OR IGNORE INTO users(uid,name,username,pass_hash,created_at,adult_confirmed_at,via) VALUES('u_demoSpammer01','free_tbb_claims','free_tbb_claims','scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',?,?,'password')", t - 6 * 3600_000, t - 6 * 3600_000);
  app.db.run("INSERT OR IGNORE INTO users(uid,name,username,pass_hash,created_at,adult_confirmed_at,via) VALUES('u_demoNeighbour1','quietcow','quietcow','scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',?,?,'password')", t - 9 * 86400_000, t - 9 * 86400_000);
  app.db.run("INSERT OR IGNORE INTO users(uid,name,username,x_id,x_handle,created_at,adult_confirmed_at,via) VALUES('u_demoXperson01','hornsup','hornsup','900001','hornsup_tbb',?,?,'x')", t - 2 * 86400_000, t - 2 * 86400_000);
  for (const [uid, ip, kind] of [['u_demoSpammer01', '203.0.113.42', 'signup'], ['u_demoSpammer01', '203.0.113.42', 'post'], ['u_demoSpammer01', '198.51.100.7', 'signin'], ['u_demoNeighbour1', '203.0.113.42', 'signin'], ['DemoCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3', '203.0.113.42', 'post'], ['u_demoXperson01', '192.0.2.9', 'signin']]) app.logIp(uid, ip, kind);
  app.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', 'general', 'u_demoSpammer01', 'claim your free TBB, dm me for the link', t - 5 * 3600_000);
  app.mod.ban('u_demoSpammer01', { actor: 'panel', reason: 'drainer bait in three rooms', days: null, ip: true, ipDays: 7 });
}
await app.listen(PORT); app.feeds.lore.tip = 921_337;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const want = (s) => !ONLY || ONLY.includes(s);
let n = 0;
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); n++; console.log('  ', name); };
for (const theme of THEMES) for (const [w, hgt] of SIZES) {
  const mobile = w < 700; const size = `${w}x${hgt}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'no-preference', timezoneId: 'UTC', locale: 'en-US', extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token() } });
  // launch mode: fresh storage apart from the theme (a first visit); the default run is a returning member whose browser remembers the account confirmation
  await ctx.addInitScript(([th, launch]) => { try { localStorage.setItem('tbb-theme', th); if (!launch) localStorage.setItem('tbb-adult', '1'); } catch { /* */ } }, [theme, LAUNCH]);
  const page = await ctx.newPage(); page.on('pageerror', (e) => console.log('  ! page error', e.message)); page.on('crash', () => console.log('  ! page crashed'));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) console.log('  ! api', r.status(), r.url().replace(BASE, '')); });
  if (['home', 'ideas-soon', 'story', 'links', 'season', 'live'].some(want)) {
    await page.goto(BASE); await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M' && document.documentElement.classList.contains('live'), null, { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(600);
    if (want('home')) await shot(page, `${theme}-${size}-home`);
    if (want('ideas-soon')) { // the Ideas card, by address (the tab is off the dock while closed)
      await page.evaluate(() => { location.hash = '#/build'; }); await page.waitForSelector('#sheet:not([hidden]) .soon-t:has-text("Ideas are coming soon")'); await page.waitForTimeout(650);
      await shot(page, `${theme}-${size}-ideas-soon`);
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden); await page.waitForTimeout(300);
    }
    for (const d of ['story', 'links', 'season', 'live']) {
      if (!want(d)) continue;
      await page.evaluate((x) => { location.hash = '#/' + x; }, d); await page.waitForSelector(`#drawer:not([hidden]) .dw[data-dw="${d}"]:not([hidden])`); await page.waitForTimeout(650);
      await shot(page, `${theme}-${size}-drawer-${d}`);
    }
  }
  // a sheet view by deep link on its own page (a hash-only hop from the drawers left the sheet half-loaded now and then)
  const view = async (hash, waitSel, name, { signedIn = false, fn = null } = {}) => {
    if (!want(name)) return;
    const cp = await ctx.newPage(); cp.on('pageerror', (e) => console.log('  ! page error', e.message));
    cp.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) console.log('  ! api', r.status(), r.url().replace(BASE, '')); });
    if (signedIn) { await cp.goto(BASE); await signUpAs(cp, 'ridge' + Math.random().toString(36).slice(2, 6)); }
    await cp.goto(BASE + '/' + hash); await cp.waitForSelector(waitSel, { timeout: 15_000 }); await cp.waitForTimeout(500);
    if (fn) await fn(cp);
    await shot(cp, `${theme}-${size}-${name}`); await cp.close();
  };
  // create an account through the dialog (the browser solves the small proof of work)
  const signUpAs = async (p, name) => {
    app.db.run("DELETE FROM ip_log WHERE kind='signup'"); // every pass signs up from this one machine; the 3-per-connection-per-day rule would stop the fourth
    await p.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1' }, body: '{}' })); // the context may still hold an earlier session
    await p.goto(BASE); await p.waitForFunction(() => document.querySelector('.account-label').textContent === 'Sign in', null, { timeout: 15_000 });
    await p.click('#accountBtn'); await p.click('.auth-tabs .tab:has-text("Create account")');
    await p.fill('.modal input[aria-label="Username"]', name); await p.fill('.modal input[aria-label="Password"]', 'fog on the ridge 2026'); await p.check('#adultTick'); await p.click('.modal button[type=submit]');
    await p.waitForSelector('.code-box', { timeout: 20_000 }); await p.check('#savedTick'); await p.click('.modal button:has-text("Continue")');
    await p.waitForFunction((x) => document.querySelector('.account-label').textContent === x, name);
    app.db.run('UPDATE users SET created_at=? WHERE username=?', Date.now() - 2 * 86400_000, name); // past the slow start, so the account may post
    return name;
  };
  await view('#/chat/general', '.composer-note', 'chat');
  if (want('chat-empty')) { // a room with nothing in it yet
    app.db.run("UPDATE messages SET room='_parked' WHERE room='builds'");
    await view('#/chat/builds', '.composer-note', 'chat-empty');
    app.db.run("UPDATE messages SET room='builds' WHERE room='_parked'");
  }
  await view('#/chat/general', '.composer-note', 'chat-refused', { signedIn: true, fn: async (p) => { await p.fill('.composer textarea', 'free TBB at claim-tbb dot xyz'); await p.keyboard.press('Enter'); await p.waitForSelector('.toast-error'); await p.waitForTimeout(250); } });
  await view('#/chat/general', '.composer-note', 'chat-muted', { signedIn: true, fn: async (p) => { const name = await p.textContent('.account-label'); app.mod.mute(app.db.get('SELECT uid FROM users WHERE username=?', name).uid, 60, { actor: 'panel', reason: 'screenshot' }); await p.fill('.composer textarea', 'gm herd'); await p.keyboard.press('Enter'); await p.waitForSelector('.toast-error'); await p.waitForTimeout(250); } });
  await view('#/chat/general', '.composer-note', 'chat-banned', { signedIn: true, fn: async (p) => { await p.waitForSelector('html.live', { timeout: 30_000 }).catch(() => {}); const name = await p.textContent('.account-label'); app.mod.ban(app.db.get('SELECT uid FROM users WHERE username=?', name).uid, { actor: 'panel', reason: 'screenshot', days: 1 }); await p.waitForSelector('.toast', { timeout: 10_000 }).catch(() => {}); await p.waitForTimeout(250); } });
  await view('#/learn', '#sheet .tab', 'learn', { fn: async (p) => { await p.waitForFunction(() => { const i = document.querySelector('#sheet .wp-poster img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15_000 }); } }); // Learn opens on What is $TBB: wait for the poster await view('#/learn/tbb', '#sheet .wp-poster img', 'learn-poster', { fn: async (p) => { await p.click('#sheet .wp-poster'); await p.waitForSelector('#modal .modal.poster img'); await p.waitForTimeout(300); } }); await view('#/learn/staking', '#sheet .rules', 'learn-staking'); await view('#/learn/safety', '#sheet .notice', 'learn-safety'); await view('#/learn/lore', '#sheet .timeline', 'learn-lore');
  await view('#/help', '#sheet .faq', 'help'); await view('#/disclaimer', '#sheet h3', 'disclaimer');
  await view('#/build', '#sheet .card.idea', 'ideas');
  await view('#/nowhere', '#sheet .empty', 'lost');
  if (want('maintenance')) { app.settings.set('maintenance', { on: true, text: 'Back by 18:15 UTC.' }); const mp = await ctx.newPage(); await mp.goto(BASE); await mp.waitForSelector('.soon-box'); await mp.waitForTimeout(400); await shot(mp, `${theme}-${size}-maintenance`); await mp.close(); app.settings.set('maintenance', { on: false, text: '' }); }
  if (want('fit') && mobile) { // the visible area with mobile browser chrome, and 125% zoom
    for (const [fw, fh, zoom] of [[w, hgt - 180, 1], [w, hgt - 180, 1.25]]) {
      const fctx = await browser.newContext({ viewport: { width: fw, height: fh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US' });
      await fctx.addInitScript((th) => { try { localStorage.setItem('tbb-theme', th); localStorage.setItem('tbb-adult', '1'); } catch { /* */ } }, theme);
      const fp = await fctx.newPage(); await fp.goto(BASE); await fp.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M', null, { timeout: 30_000 }).catch(() => {});
      if (zoom !== 1) await fp.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
      await fp.waitForTimeout(400); await shot(fp, `${theme}-${fw}x${fh}${zoom !== 1 ? '-zoom125' : ''}-fit`); await fctx.close();
    }
  }
  if (['signin', 'signup', 'recovery', 'recovery-code', 'account'].some(want)) {
    await page.goto(BASE); await page.waitForFunction(() => document.querySelector('.account-label').textContent === 'Sign in', null, { timeout: 15_000 });
    await page.click('#accountBtn'); await page.waitForSelector('.modal .auth-tabs'); await page.waitForTimeout(350);
    if (want('signin')) await shot(page, `${theme}-${size}-signin`);
    if (want('signup')) { await page.click('.auth-tabs .tab:has-text("Create account")'); await page.fill('.modal input[aria-label="Username"]', 'ridgerunner'); await page.waitForTimeout(250); await shot(page, `${theme}-${size}-signup`); }
    if (want('recovery')) { await page.click('.auth-tabs .tab:has-text("Sign in")'); await page.click('.modal button:has-text("Have a recovery code?")'); await page.waitForSelector('.modal input[aria-label="Recovery code"]'); await page.fill('.modal input[aria-label="Username"]', 'ridgerunner'); await page.fill('.modal input[aria-label="Recovery code"]', 'K7Q2M-9XJ4A-R3TUW-B8CD5-H6NPV'); await page.waitForTimeout(250); await shot(page, `${theme}-${size}-recovery`); }
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    if (['recovery-code', 'account'].some(want)) { // the one-time recovery code screen right after sign-up, then the account menu
      app.db.run("DELETE FROM ip_log WHERE kind='signup'");
      await page.click('#accountBtn'); await page.click('.auth-tabs .tab:has-text("Create account")');
      const name = 'ridge' + Math.random().toString(36).slice(2, 6);
      await page.fill('.modal input[aria-label="Username"]', name); await page.fill('.modal input[aria-label="Password"]', 'fog on the ridge 2026'); await page.check('#adultTick'); await page.click('.modal button[type=submit]');
      await page.waitForSelector('.code-box', { timeout: 20_000 }); await page.waitForTimeout(250); if (want('recovery-code')) await shot(page, `${theme}-${size}-recovery-code`);
      await page.check('#savedTick'); await page.click('.modal button:has-text("Continue")'); await page.waitForFunction((x) => document.querySelector('.account-label').textContent === x, name);
      await page.click('#accountBtn'); await page.waitForSelector('.modal .modal-title'); await page.waitForTimeout(250); if (want('account')) await shot(page, `${theme}-${size}-account`);
      await page.click('.modal button:has-text("Sign out everywhere")'); await page.waitForTimeout(300);
    }
  }
  const ADMIN_PANELS = [['admin-status', 'Status'], ['admin-areas', 'Launch areas'], ['admin-banner', 'Announcement banner'], ['admin-story', 'Story'], ['admin-maint', 'Maintenance mode'], ['admin-sections', 'Sections shown'], ['admin-links', 'Links'], ['admin-lore', 'Block chain messages'], ['admin-audit', 'Recent changes'], ['admin-rules', 'Chat rules']];
  if (['admin', 'admin-queue', 'admin-people', 'admin-ban', 'admin-ipbans', 'admin-log', ...ADMIN_PANELS.map((x) => x[0])].some(want)) {
    await page.goto(ADMIN_BASE + '/'); await page.waitForSelector('#queue .q-item'); await page.waitForTimeout(300);
    if (want('admin')) await shot(page, `${theme}-${size}-admin`);
    for (const [state, sel] of [['admin-queue', '#queue'], ['admin-people', '#people'], ['admin-ipbans', '#ipbans'], ['admin-log', '#modlog']]) {
      if (!want(state)) continue;
      await page.locator(sel).scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
      await page.locator(sel).screenshot({ path: path.join(OUT, `${theme}-${size}-${state}.png`) }); n++; console.log('  ', `${theme}-${size}-${state}`);
    }
    for (const [state, title] of ADMIN_PANELS) {
      if (!want(state)) continue;
      const sec = page.locator('#panel > .panel', { has: page.locator('.h3', { hasText: title }) }).first();
      await sec.scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
      await sec.screenshot({ path: path.join(OUT, `${theme}-${size}-${state}.png`) }); n++; console.log('  ', `${theme}-${size}-${state}`);
    }
    if (want('admin-ban')) { // the ban chooser open on one person: account / account + IP, the lengths, the reason
      const row = page.locator('#people .u-row', { hasText: 'quietcow' }).first(); await row.scrollIntoViewIfNeeded();
      await row.locator('button:has-text("Ban…")').click(); await row.locator('.ban-ctl select').first().selectOption('ip'); await row.locator('.ban-ctl input').fill('drainer links after a warning'); await page.waitForTimeout(200);
      await row.screenshot({ path: path.join(OUT, `${theme}-${size}-admin-ban.png`) }); n++; console.log('  ', `${theme}-${size}-admin-ban`);
    }
  }
  await ctx.close();
}
await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${n} screenshots to ${path.relative(ROOT, OUT)}/`);
