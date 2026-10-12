#!/usr/bin/env node
// End-to-end: real server + real Chromium. Members are planted straight into the database with a session cookie
// (the sign-up and sign-in dialogs are exercised by their own test). Screenshots live in scripts/shots.js.
// The Season board's JSON is faked here as the board publishes it (its own field names).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';
import { seed, DEMO_IDS } from '../../scripts/seed.js';
import { newUid, plantUser, sessionFor } from '../unit/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ['playwright-core', process.env.PLAYWRIGHT_CORE].filter(Boolean)) { try { return require(p); } catch { /* next */ } }
  throw new Error('playwright-core not found (npm i -D playwright-core)');
}
const { chromium } = loadPlaywright();
const CHROME = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');

const kp = () => newUid('e2e'); // a fresh member id, planted at sign-in
const USER = kp(); const RICH = kp();

const rpc = async (method) => {
  if (method === 'getAccountInfo') { const b = Buffer.alloc(237); b.writeBigUInt64LE(52_714_377_755_956n, 104); b.writeBigUInt64LE(169n, 120); return { value: { owner: '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT', data: [b.toString('base64'), 'base64'] } }; }
  if (method === 'getTokenSupply') return { value: { uiAmount: 999_996_129 } };
  throw new Error('rpc ' + method);
};
const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('/cdn-cgi/access/certs')) return new Response(JSON.stringify({ keys: [{ kid: 'kid-1', kty: 'RSA', alg: 'RS256', use: 'sig', ...RSA.publicKey.export({ format: 'jwk' }) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const body = u.includes('/api/board') ? { mint: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump', season: { start: 1791244200000, end: 1793836200000, overtimeHours: 0, prizeTbb: 4206900, stakeApr: 0.08 }, totals: { buyers: 308, buys: 789, volumeUsd: 187421.07 }, leaderboard: [{ wallet: 'TestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAone', score: 10044.14 }, { wallet: 'TestWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBtwo', score: 6200 }, { wallet: 'TestWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCCCCthree', score: 3100.5 }, { wallet: '4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT', score: 10 }] }
    : u.includes('geckoterminal') ? { data: { attributes: { ohlcv_list: Array.from({ length: 24 }, (_, i) => [1791460000 + (23 - i) * 3600, 0, 0, 0, 0.0079 + Math.sin(i / 3) * 0.0002, 1]) } }, meta: { base: { address: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump' } } }
    : u.includes('dexscreener') ? { pairs: [{ baseToken: { address: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump' }, priceUsd: '0.008122', priceChange: { h24: 2.56 }, liquidity: { usd: 1 }, marketCap: 8122066, pairAddress: '6unnG2hL8udPjDpu3TchvAtptu3dq8AS7tymrWDN2LLC' }] }
      : u.includes('prices') ? { USD: 98250 } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

// the admin panel: a locally generated RSA key stands in for Cloudflare Access; the browser sends the token header.
const TEAM = 'example-team'; const AUD = 'e'.repeat(64); const ADMIN_EMAIL = 'admin@example.com';
const RSA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (b) => Buffer.from(b).toString('base64url');
function accessToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' })); const body = b64u(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: ADMIN_EMAIL, iat: now, nbf: now, exp: now + 3600, ...claims }));
  return `${head}.${body}.${b64u(crypto.sign('sha256', Buffer.from(`${head}.${body}`), RSA.privateKey))}`;
}
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbe2e-'));
const net = await import('node:net');
const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://localhost:${PORT}`;
const ADMIN_BASE = `http://admin.localhost:${PORT}`; // Chromium resolves *.localhost to the loopback address by itself
const app2 = createApp({ env: { PORT: String(PORT), LORE_WORKER: 'off', POW_BITS: '6', DB_FILE: path.join(dir, 'e2e.db'), PUBLIC_ORIGIN: BASE, HELIUS_API_KEY: '', CLIENT_IP_HEADER: 'x-test-ip',
  ADMIN_HOST: `admin.localhost:${PORT}`, ACCESS_TEAM: TEAM, ADMIN_ACCESS_AUD: AUD, ADMIN_EMAIL_SHA256: crypto.createHash('sha256').update(ADMIN_EMAIL).digest('hex') }, rpc, fetchImpl: fakeFetch, log: () => {} });
seed(app2.db, { demo: true });
for (const [hgt, t] of [[0, 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks'], [124724, 'Hello from the early days of the block chain'], [233412, 'We are all Satoshi now. Run your own node']]) app2.db.run("INSERT OR IGNORE INTO lore(height,block_hash,txid,kind,text,found_at,status) VALUES(?,?,?,?,?,?,'approved')", hgt, '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'tx' + hgt, 'coinbase', t, Date.now());
await app2.listen(PORT);
app2.feeds.lore.tip = 921_337;

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
let passed = 0; let failed = 0; const errors = [];
const ONLY = process.env.ONLY || ''; // run a subset: ONLY="admin panel" node test/e2e/run.js
async function t(name, fn) {
  if (ONLY && !name.includes(ONLY) && !name.startsWith('no page errors')) return;
  try { await fn(); passed++; console.log('  ✔', name); } catch (e) { failed++; console.log('  ✖', name, '\n     ', e.message.split('\n').slice(0, process.env.VERBOSE ? 12 : 3).join(' | ')); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

async function newPage({ who = null, theme = 'dark', viewport = { width: 1440, height: 900 }, mobile = false, motion = 'reduce', adult = true, ip = null } = {}) {
  const ctx = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US', viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, reducedMotion: motion, ...(ip ? { extraHTTPHeaders: { 'x-test-ip': ip } } : {}) });
  // the remembered confirmation only matters once signed in (it is sent to the account); the first-visit test starts without it
  await ctx.addInitScript(([th, ad]) => { try { localStorage.setItem('tbb-theme', th); if (ad) localStorage.setItem('tbb-adult', '1'); } catch { /* */ } }, [theme, adult]);
  const page = await ctx.newPage(); page.who = who;
  page.on('pageerror', (e) => errors.push(`${theme}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${theme} console: ${m.text()}`); });
  return { page, ctx };
}
// A member of two days' standing (past the slow start), signed in: planted in the database with a session cookie the
// browser carries from here on. Without a name the page asks for one (the dialog is part of what is tested).
async function signIn(page, name, who = null) {
  const uid = who || page.who || kp();
  plantUser(app2.db, uid, { name: name || null, adult: !!app2.db.get('SELECT 1 FROM users WHERE uid=? AND adult_confirmed_at IS NOT NULL', uid) || true });
  if (name) app2.db.run('UPDATE users SET name=? WHERE uid=? AND name IS NULL', name, uid);
  await page.context().addCookies([{ name: 'tbb_s', value: sessionFor(app2.db, uid).slice('tbb_s='.length), url: BASE, httpOnly: true, sameSite: 'Strict' }]);
  const back = await page.evaluate(() => location.hash);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#accountBtn').classList.contains('on'));
  if (!name && !app2.db.get('SELECT name FROM users WHERE uid=?', uid).name) {
    // the name dialog opens from the home screen (a sheet's backdrop would sit over the account button)
    if (back && back !== '#/') { await page.evaluate(() => { location.hash = '#/'; }); await page.waitForFunction(() => document.querySelector('#sheet').hidden && document.querySelector('#drawer').hidden); }
    await page.click('#accountBtn'); await page.waitForSelector('.modal input[aria-label="Display name"]');
    const n = 'herd' + Math.random().toString(36).slice(2, 7);
    await page.fill('.modal input[aria-label="Display name"]', n); await page.click('.modal button[type=submit]');
    await page.waitForFunction((x) => document.querySelector('.account-label').textContent === x, n);
  }
  await page.waitForFunction(() => !document.querySelector('#modal').children.length);
  if (back && back !== '#/' && (await page.evaluate(() => location.hash)) !== back) { await page.evaluate((x) => { location.hash = x; }, back); }
  return uid;
}
// Create an account through the dialog (the browser solves the proof of work); returns the recovery code.
async function signUp(page, username, password = 'fog on the ridge 2026') {
  await page.click('#accountBtn');
  await page.click('.auth-tabs .tab:has-text("Create account")');
  await page.fill('.modal input[aria-label="Username"]', username); await page.fill('.modal input[aria-label="Password"]', password);
  await page.check('#adultTick'); await page.click('.modal button[type=submit]');
  await page.waitForSelector('.code-box', { timeout: 20_000 });
  const code = await page.textContent('.code-box');
  assert(await page.locator('.modal button:has-text("Continue")').isDisabled(), 'Continue waits for "I saved it"');
  await page.check('#savedTick'); await page.click('.modal button:has-text("Continue")');
  await page.waitForFunction((x) => document.querySelector('.account-label').textContent === x, username);
  return code;
}

console.log('e2e');
await t('home at launch: bull hero, price + chart + staked (plain text, no staking link), Learn + Share as the hero actions, the closed tabs off the dock, no Swap anywhere, hand-typed closed routes show the calm card, an admin address is Not found, disclaimer (dark)', async () => {
  const { page, ctx } = await newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#st-price .stat-v').textContent.startsWith('$'));
  assert((await page.textContent('#st-price .stat-v')).includes('0.00812'), 'price');
  assert((await page.textContent('#st-24h .stat-v')) === '+2.6%', '24h');
  assert((await page.textContent('.lore-text')).length > 10, 'lore line');
  await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
  assert((await page.textContent('#st-staked-d')).includes('5.3% of supply'), 'staked share (no 24h history yet)');
  assert((await page.$eval('#st-staked', (el) => el.tagName)) === 'DIV' && !(await page.locator('a[href*="stakethebull"]').count()) && !/stakethebull/i.test(await page.evaluate(() => document.body.innerText)), 'staked is a plain number; no link to or mention of the staking site on the home');
  assert((await page.title()) === 'The Bitcoin Bull · $TBB community dashboard', 'the title says what the site is');
  assert(await page.locator('#kicker').isVisible() && (await page.textContent('#kicker')) === 'Read-only community dashboard. Never asks for your wallet, a signature or money.', 'the kicker');
  await page.waitForFunction(() => !document.querySelector('#st-sub').hidden);
  assert((await page.textContent('#st-sub')) === '≈ 8.27 sats · Market cap $8.12M', 'sats + market cap under the price: ' + await page.textContent('#st-sub'));
  assert(await page.locator('.fine').isVisible() && (await page.textContent('.fine')).includes('Not financial advice'), 'the fine print');
  // the closed areas are off the dock: not visible, not reachable, no Soon mark anywhere
  assert(!(await page.locator('#soonTab, #soonPop, .dk-more, .soon-item, #soonLine, .dk-soon').count()), 'the grouped Soon tab, its popover, the old line under the dock and the Soon marks are gone');
  assert(!(await page.locator('#ageGate, .age-gate, .age-card, .modal').count()) && !/18\+|18 or older|18 and over|\badults?\b/i.test(await page.evaluate(() => document.body.innerText)), 'no age card and no age wording at launch');
  const dockTabs = await page.$$eval('.dock .dk', (as) => as.filter((a) => a.offsetParent).map((a) => [a.querySelector('.dk-label').textContent, a.classList.contains('is-soon'), a.getAttribute('aria-disabled'), a.querySelector('.dk-soon')?.offsetParent ? a.querySelector('.dk-soon').textContent : null]));
  assert(JSON.stringify(dockTabs) === JSON.stringify([['Story', false, null, null], ['Links', false, null, null], ['Season 1', false, null, null], ['Learn', false, null, null]]), 'dock: ' + JSON.stringify(dockTabs));
  assert(await page.$$eval('.dk[data-dk="live"], .dk[data-dk="build"]', (els) => els.length === 2 && els.every((el) => el.hidden && !el.offsetParent)), 'the two closed tabs are hidden, ready to come back when their area opens');
  assert(!/\bonline\b|connection/i.test(await page.evaluate(() => document.body.innerText)), 'no visitor count anywhere');
  // no Swap anywhere: Learn is the primary hero action, Share the other; the page never says swap or stake
  assert(await page.locator('.hero-btn.btn-primary', { hasText: 'Learn' }).isVisible() && (await page.locator('.hero-btn').count()) === 2 && await page.locator('#shareBtn').isVisible() && !(await page.locator('[data-k="swap"], a[href^="#/swap"], .swap-row, [data-k="stake"]').count()), 'Learn + Share are the hero actions, no Swap or Stake button');
  assert(!/swap/i.test(await page.evaluate(() => document.body.innerText)), 'the page never says swap');
  const look = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), op: parseFloat(getComputedStyle(el).opacity), cur: getComputedStyle(el).cursor, bg: getComputedStyle(el).backgroundImage, top: Math.round(r.top) }; });
  const learnBox = await look('.hero-btn[data-k="learn"]'); const shareBox = await look('#shareBtn');
  assert(learnBox.bg.includes('gradient') && learnBox.op === 1 && learnBox.h >= 38 && learnBox.w >= 150 && !shareBox.bg.includes('gradient') && shareBox.h === learnBox.h && shareBox.top === learnBox.top && shareBox.w >= 150, 'Learn the orange one, Share beside it, one row: ' + JSON.stringify([learnBox, shareBox]));
  // a scripted tap on a hidden closed tab still goes nowhere: a calm toast, the address and the page untouched
  const hashBefore = await page.evaluate(() => location.hash);
  for (const sel of ['.dk[data-dk="live"]']) {
    const n = await page.locator('.toast').count();
    await page.$eval(sel, (el) => el.click()); // hidden, so Playwright won't click it itself
    await page.waitForFunction((k) => document.querySelectorAll('#toasts[aria-live] .toast').length > k, n);
    assert((await page.locator('#toasts .toast').last().textContent()) === 'Coming soon.', sel + ': the toast');
    assert((await page.evaluate(() => location.hash)) === hashBefore && await page.isHidden('#sheet') && await page.isHidden('#drawer'), sel + ': no navigation');
  }
  // keyboard: Tab from the last live tab skips the hidden ones (nothing a keyboard reaches is ever a dead end)
  await page.focus('.dk[data-dk="learn"]'); await page.keyboard.press('Tab');
  assert(await page.evaluate(() => !document.activeElement?.closest('.dock')), 'no hidden tab is reachable by keyboard');
  assert((await page.locator('.home .tile:visible').count()) === 0 && !(await page.locator('.home .soon-tag:visible, .home .t-status:visible').count()), 'no "soon" tiles or tags on the home');
  // no admin page on this host: an admin address typed in reads "Not found" like any missing address; ?admin shows no Sign in button
  await page.evaluate(() => { location.hash = '#/' + 'admin'; }); await page.waitForSelector('#sheet:not([hidden]) .empty .serif:has-text("This page has moved on to other things.")');
  assert((await page.textContent('#sheetTitle')) === 'Not found' && !(await page.locator('#sheet .panel, #sheet input').count()), 'an admin address is a plain Not found');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  await page.goto(BASE + '/?admin'); await page.waitForFunction(() => document.querySelector('#st-price .stat-v').textContent.startsWith('$'));
  assert(await page.isHidden('#accountBtn'), '?admin shows no sign-in button');
  await page.goto(BASE); await page.waitForFunction(() => document.querySelector('#st-price .stat-v').textContent.startsWith('$'));
  // the same addresses typed in by hand show one calm card: no content, no links
  for (const hash of ['#/live', '#/chat/general', '#/chat/builds']) {
    await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForSelector('#sheet:not([hidden]) .soon-card .soon-t:has-text("Coming soon")');
    assert((await page.textContent('#sheetTitle')) === 'Coming soon' && !(await page.locator('#sheet a, #sheet button:not(.sheet-close):not(.sheet-back)').count()) && !(await page.locator('#sheet .card, #sheet .msg').count()), hash + ': the calm card, nothing to click');
    assert(!(await page.locator('#sheet .soon-list, #sheet .soon-badge').count()), hash + ': no bullet list, no doubled badge');
    assert(await page.isHidden('#drawer'), hash + ': no drawer');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  }
  assert(!(await page.locator('.tile[data-k="calc"]').count()), 'one calculator: the Time Machine link only');
  await page.waitForFunction(() => document.querySelector('#st-season .stat-v').textContent === '308 buyers');
  assert(/^\d+(d|h|m) left$|^Ended$/.test(await page.textContent('#st-season-d')), 'season time left');
  assert((await page.getAttribute('#st-season', 'href')) === 'https://tbb-buyer-board.garden-equity-field-0042.workers.dev/', 'season stat links to the board');
  // one screen: nothing to scroll to on the home page
  assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth), 'no page scroll on a desktop');
  // Season 1 leaders live in the Season drawer
  await page.click('.dk[data-dk="season"]'); await page.waitForSelector('#drawer:not([hidden]) .dw-season:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#seasonTop li').length === 3);
  const top = await page.$$eval('#seasonTop li', (li) => li.map((x) => x.textContent));
  assert(top[0].includes('Test…Aone') && top[0].includes('$10,044'), 'leader: ' + top[0]);
  assert(!(await page.content()).includes('TestWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAone'), 'full wallet never shown');
  assert(await page.$eval('.dk[data-dk="season"]', (el) => el.classList.contains('on')), 'season tab lit');
  await page.click('.dk[data-dk="season"]'); await page.waitForFunction(() => document.querySelector('#drawer').hidden); // tap again closes
  assert(!(await page.textContent('#boardSoon')).includes('moderation'), 'no long chat disclaimer');
  assert((await page.textContent('.community-note')).includes('not made, run or endorsed by the $TBB developer'), 'community note');
  assert(await page.isHidden('#accountBtn'), 'no sign-in button while accounts are closed');
  assert(await page.isHidden('#st-holders'), 'no Holders stat without a number');
  assert(await page.evaluate(() => [...document.querySelectorAll('.hero .stat-age')].every((e) => e.textContent === '')) && /^Updated (just now|\dm ago)$/.test(await page.textContent('#panelAge')), 'one freshness line: ' + await page.textContent('#panelAge'));
  assert((await page.textContent('#boardSoon')).includes('Chat and Ideas are coming soon'), 'one combined soon card');
  assert(await page.isHidden('#boardList'), 'no chat preview');
  assert(await page.isHidden('.ideas-card'), 'no second empty card');
  assert(!/inevitable/i.test(await page.content()), 'slogan removed');
  assert(!/One supply|One will/i.test(await page.content()), 'stamp removed');
  assert(!(await page.locator('.tiles .t-label', { hasText: 'Inbox' }).count()), 'no Inbox tile');
  for (const label of ['Story', 'Links', 'Season 1', 'Learn']) assert(await page.locator('.dock .dk-label', { hasText: label }).first().isVisible(), label);
  assert(await page.isHidden('.tiles'), 'the tile row belongs to the 2009 look only');
  // the Links drawer: the admin's links in order (no Instagram), the Season 1 row, the disclaimer
  await page.click('.dk[data-dk="links"]'); await page.waitForSelector('#drawer:not([hidden]) #linksList .link-row');
  assert((await page.getAttribute('.tile[data-k="season"]', 'href')) === 'https://tbb-buyer-board.garden-equity-field-0042.workers.dev/', 'Season 1 row');
  assert((await page.getAttribute('.tile[data-k="season"]', 'rel')).includes('noopener'), 'season noopener');
  for (const [label, href] of [['TBB Time Machine', 'https://tbbtimemachine.xyz'], ['Solscan', 'https://solscan.io/token/42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump']]) {
    const l = page.locator('#linksList .link-row', { hasText: label }); assert(await l.isVisible(), label); assert((await l.getAttribute('href')) === href, href);
    assert((await l.getAttribute('rel')).includes('noopener'), 'noopener');
  }
  const nLinks = await page.locator('#linksList .link-row').count(); assert(nLinks === 5, 'links ' + nLinks);
  assert(!(await page.locator('#drawer a[href*="stakethebull"]').count()), 'no staking link in the Links drawer');
  assert(!/instagram/i.test(await page.content()), 'no Instagram anywhere');
  // the whitepaper is a page on this site (the creator's poster), not a link out: first row, no new tab, opens Learn → What is $TBB
  const wp = page.locator('#linksList .link-row', { hasText: 'TBB whitepaper' });
  assert((await wp.getAttribute('href')) === '#/learn/tbb' && !(await wp.getAttribute('target')) && (await wp.textContent()).includes('On this site'), 'whitepaper row is on-site');
  assert((await page.$$eval('#linksList .link-row', (r) => r.map((x) => x.getAttribute('href')))).filter((h) => /bitcoinhard\.money\/tbb/.test(h)).length === 0, 'no outside whitepaper link');
  await wp.click(); await page.waitForSelector('#sheet:not([hidden]) .wp-poster img');
  assert((await page.evaluate(() => location.hash)) === '#/learn/tbb' && (await page.evaluate(() => document.querySelector('#drawer').hidden)), 'Links → whitepaper opens the Learn sheet');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  await page.click('.dk[data-dk="links"]'); await page.waitForSelector('#drawer:not([hidden]) #linksList .link-row');
  assert(await page.isVisible('#drawer .disclaimer:has-text("Disclaimer")') && (await page.textContent('#drawer .disclaimer')).includes('Nothing here is financial'), 'disclaimer in the Links drawer');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#drawer').hidden);
  // the Story drawer, empty for now
  await page.click('.dk[data-dk="story"]'); await page.waitForSelector('#drawer:not([hidden]) .dw-story:not([hidden])');
  assert((await page.textContent('#storyBody')).trim() === 'The story is coming.', 'empty story');
  await page.click('#drawerClose'); await page.waitForFunction(() => document.querySelector('#drawer').hidden);
  assert(await page.locator('.hero-btn', { hasText: 'Learn' }).isVisible() && (await page.locator('.hero-btn.btn-primary').count()) === 1, 'Learn is the one primary hero action');
  assert(!(await page.locator('.hero-btn', { hasText: 'Buy' }).count()), 'no Buy button on the home page');
  // the 2009 skin's chrome (light look) follows the same rule: its Chat / Ideas tools are gone while closed
  assert(await page.$eval('.toolbar', (el) => el.hidden) && await page.$eval('.toolbar .tool[href^="#/chat"]', (el) => el.hidden) && !(await page.locator('.menu-list [data-href^="#/s"]:not([data-href="#/story"])').count()), 'no Chat/Ideas tools in the 2009 skin while closed, and nothing in its menus but the kept pages');
  assert(!(await page.locator('.hero-btn', { hasText: /Buy/ }).count()) && !(await page.locator('.home a, .home button', { hasText: /^\s*Buy\s*$/ }).count()), 'no Buy button anywhere on the home page');
  assert(!(await page.locator('a[href^="#/swap"], [data-k="swap"]').count()), 'no Swap link or button anywhere');
  // the home talks to no outside host by itself (fonts, art, scripts, API: all this site); outside sites open only on a click
  const homeHosts = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').filter((r) => !/^(data|blob):/.test(r.name)).map((r) => new URL(r.name).host))]); // data: URLs (the CSS grain) never leave the page
  assert(homeHosts.length && homeHosts.every((h) => h === new URL(BASE).host), 'no request left this site from the home: ' + homeHosts.join(','));
  assert(!(await page.locator('.home', { hasText: /Exchanges & wallets|CoinZoom|Cake Wallet/i }).count()) && !/coinzoom|cakewallet/i.test(await page.content()), 'the outside-exchanges list is not on the public page');
  await page.waitForFunction(() => document.querySelector('.spark-line').getAttribute('d').length > 40);
  // the price block must not sit on top of the bull (right ~40% of a wide screen)
  const box = await page.locator('.hero-copy').boundingBox(); assert(box.x + box.width < 1280 * 0.6, `hero copy reaches ${Math.round(box.x + box.width)}px`);
  // the bull's head is in the scene, in the final pose (reduced motion: no reveal); no apples
  assert((await page.locator('.bull-wide polygon[data-k]').count()) >= 60, 'bull head');
  assert(!(await page.locator('.apples, .apple').count()) && !/apple/i.test((await page.content()).replace(/-apple-system|apple-touch-icon/g, '')), 'no apples anywhere');
  assert(await page.$eval('.bull-wide .bh-eye', (e) => getComputedStyle(e).opacity === '1'), 'eyes lit');
  assert(!(await page.locator('text=Liquidity').count()), 'no liquidity');
  assert(await page.evaluate(() => [...document.querySelectorAll('.stat-v')].every((v) => v.scrollWidth <= v.clientWidth + 1)), 'stat values not truncated');
  const html = await page.content(); assert(!/porsche|lamborghini|ferrari/i.test(html), 'no car trademarks');
  await ctx.close();
});
await t('light polling — one lore batch rotated locally (refill 15 min), no /api/state poll while the stream is open, every timer paused while hidden and caught up on return, the poll back once the stream is gone; the Ideas tab opens its card', async () => {
  const { page, ctx } = await newPage();
  const reqs = []; page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) reqs.push(u.pathname + u.search); });
  const count = (p) => reqs.filter((r) => r === p || r.startsWith(p + '?')).length;
  await page.clock.install(); // fake timers: the page's intervals run when the test moves the clock
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#st-price .stat-v').textContent.startsWith('$'));
  await page.waitForFunction(() => document.documentElement.classList.contains('live'));
  await page.waitForFunction(() => document.querySelector('.lore-text').textContent.length > 10);
  const lore0 = await page.textContent('.lore-text');
  assert(count('/api/lore') === 1 && reqs.includes('/api/lore?n=20'), 'one batch of 20 at start: ' + reqs.join(' '));
  const state0 = count('/api/state'); const chart0 = count('/api/chart');
  // one minute: three lore ticks rotate the line from the batch (no request); the state poll is skipped because the stream is open
  await page.clock.runFor(61_000);
  await page.waitForFunction((t) => document.querySelector('.lore-text').textContent !== t, lore0);
  assert(count('/api/lore') === 1, 'rotation is local: still one lore request');
  assert(count('/api/state') === state0, 'no /api/state poll while the stream is open');
  // hidden: the state poll, the lore rotation, the lore refill (15 min) and the sparkline (10 min) all wait
  const hide = (hidden) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { get: () => h, configurable: true }); Object.defineProperty(document, 'visibilityState', { get: () => (h ? 'hidden' : 'visible'), configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  await hide(true);
  const lore1 = await page.textContent('.lore-text');
  await page.clock.runFor(16 * 60_000);
  await page.waitForTimeout(300);
  assert((await page.textContent('.lore-text')) === lore1 && count('/api/lore') === 1 && count('/api/chart') === chart0 && count('/api/state') === state0, 'nothing moved while hidden: ' + reqs.join(' '));
  // back: one state read, the chart, a fresh lore batch (the 15 min refill was due) — at once, not at the next tick
  await hide(false);
  await page.waitForFunction(() => document.querySelector('.lore-text').textContent.length > 10);
  await page.waitForTimeout(500);
  assert(count('/api/state') === state0 + 1 && count('/api/chart') === chart0 + 1 && count('/api/lore') === 2 && reqs.filter((r) => r === '/api/lore?n=20').length === 2, 'caught up on return: ' + reqs.join(' '));
  // the stream refused (the generic 429): the page falls back to the 60 s poll
  await page.route('**/api/stream', (r) => r.fulfill({ status: 429, body: 'slow down' }));
  app2.server.closeAllConnections();
  await page.waitForFunction(() => !document.documentElement.classList.contains('live'));
  const state1 = count('/api/state');
  await page.clock.runFor(61_000); await page.waitForTimeout(300);
  assert(count('/api/state') === state1 + 1, 'the poll is back without the stream: ' + reqs.join(' '));
  await page.unroute('**/api/stream');
  // Ideas: the tab is off the dock while closed; #/build typed in opens its card, the same card at #/build/ideas
  const tab = page.locator('.dk[data-dk="build"]');
  assert(await tab.isHidden() && (await tab.locator('.dk-label').textContent()) === 'Build' && !(await tab.locator('.dk-soon').count()), 'the Build tab is hidden while closed, no Soon mark');
  await page.evaluate(() => { location.hash = '#/build'; });
  await page.waitForSelector('#sheet:not([hidden]) .soon-card .soon-t:has-text("Ideas are coming soon")');
  const card = async () => ({ title: await page.textContent('#sheetTitle'), text: await page.textContent('#sheet .soon-p'), points: await page.$$eval('#sheet .soon-list li', (ls) => ls.map((l) => l.textContent)), clicks: await page.locator('#sheet a, #sheet button:not(.sheet-close):not(.sheet-back)').count(), hash: await page.evaluate(() => location.hash) });
  let c = await card();
  assert(c.title === 'Ideas' && c.text === 'Post ideas for TBB and vote on the best ones. Details will be posted here before it opens.' && JSON.stringify(c.points) === JSON.stringify(['Post an idea', 'Vote on ideas']) && c.clicks === 0 && c.hash === '#/build', 'the card: ' + JSON.stringify(c));
  assert(!/paid|reward|\$|week|sign-in|accounts/i.test(await page.textContent('#sheet')), 'no promise about a reward, a schedule or how it opens');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  await page.evaluate(() => { location.hash = '#/build/ideas'; }); await page.waitForSelector('#sheet:not([hidden]) .soon-t:has-text("Ideas are coming soon")');
  c = await card(); assert(c.title === 'Ideas' && c.points.length === 2 && c.hash === '#/build/ideas', 'ideas: the same card');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  assert(!(await page.textContent('#boardSoon')).includes('Opens with') && (await page.textContent('#boardSoon')).includes('Chat and Ideas are coming soon'), 'the home note');
  await ctx.close();
});

await t('launch default: chat, ideas and the inbox show "coming soon"; the removed areas are plain Not found; disclaimer page', async () => {
  const { page, ctx } = await newPage(); await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#st-price .stat-v').textContent.startsWith('$'));
  await page.evaluate(() => { location.hash = '#/build/ideas'; }); await page.waitForSelector('.soon-t:has-text("Ideas are coming soon")');
  await page.evaluate(() => { location.hash = '#/inbox'; }); await page.waitForSelector('#sheet .empty:has-text("Inbox is coming soon")');
  // a closed section typed in by hand: the calm card, then on to the disclaimer
  for (const hash of ['#/chat/general', '#/live']) { await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForSelector('#sheet:not([hidden]) .soon-t:has-text("Coming soon")'); assert(!(await page.locator('#sheet .msg, #sheet .composer').count()), hash + ' shows nothing'); }
  // the addresses of the removed areas are what any unknown address is: "Not found", no card, no code loaded
  const loaded = []; page.on('request', (r) => { const p = new URL(r.url()).pathname; if (/\/js\/(account|views-closed|pow)\./.test(p)) loaded.push(p); });
  for (const hash of ['#/' + 'store', '#/' + 'store/item/1', '#/' + 'club', '#/' + 'swap' + 'x']) { await page.evaluate((x) => { location.hash = x; }, hash); await page.waitForSelector('#sheet:not([hidden]) .empty .serif:has-text("This page has moved on to other things.")'); assert((await page.textContent('#sheetTitle')) === 'Not found', hash); }
  assert(!loaded.length, 'nothing loaded for a removed address: ' + loaded.join(','));
  await page.evaluate(() => { location.hash = '#/disclaimer'; }); await page.waitForSelector('h3:has-text("Not financial advice")');
  assert(!/wallet-to-wallet|refund|checkout|purchase/i.test(await page.textContent('#sheet')), 'the disclaimer speaks of no purchase');
  // the chat and ideas APIs are shut with the default settings (CHAT_OPEN / ACCOUNTS_OPEN unset), reads and writes alike
  for (const p of ['/api/rooms/general/messages', '/api/rooms/builds/messages', '/api/ideas', '/api/inbox']) assert((await fetch(BASE + p)).status === 503, p);
  for (const p of ['/api/rooms/general/messages', '/api/ideas']) assert((await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: BASE }, body: '{}' })).status === 503, 'POST ' + p + ' is shut');
  const st = await (await fetch(BASE + '/api/state')).json();
  assert(!('swap' in st.features), 'no swap feature flag');
  assert(JSON.stringify(Object.keys(st.features).sort()) === JSON.stringify(['accounts', 'chat', 'ideas']), 'the feature flags: ' + Object.keys(st.features).join(','));
  assert(!st.alerts.some((a) => /idea|vote|message/i.test(a.kind)), 'no alerts for closed areas');
  assert(!(await page.locator('.msg-body').count()), 'no messages leak');
  await ctx.close();
});
await t('crafted links while accounts are closed (#/?x=linked, banned, error, constructor): no account code loads, no message, the hash is stripped', async () => {
  for (const code of ['linked', 'banned', 'error', 'constructor']) {
    const { page, ctx } = await newPage();
    const loaded = []; page.on('request', (r) => { const p = new URL(r.url()).pathname; if (/\/js\/(account|views-closed|pow)\./.test(p)) loaded.push(p); });
    await page.goto(BASE + '/#/?x=' + code);
    await page.waitForFunction(() => location.hash === '', null, { timeout: 10_000 }).catch(() => { throw new Error(code + ': the hash stays'); });
    await page.waitForTimeout(400);
    assert(!loaded.length, code + ': closed code loaded: ' + loaded.join(','));
    assert(!(await page.locator('.toast').count()), code + ': a message was shown');
    assert(await page.evaluate(() => document.querySelector('#sheet').hidden), code + ': a sheet opened');
    await ctx.close();
  }
});
await t('history: every link, tile, sheet and sub-tab on the home page — Back returns, Forward works, close and the back arrow pop instead of push, reopening works, closed items leave no trace (desktop + phone)', async () => {
  const CLOSED = ['#/chat', '#/live']; // #/build opens the Ideas card (a sheet), so it is checked like any other link
  for (const mobile of [false, true]) {
    const { page, ctx } = await newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, mobile });
    await page.goto(BASE); await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
    const state = () => page.evaluate(() => ({ hash: /^#\/?$/.test(location.hash) ? '' : location.hash, open: !document.querySelector('#sheet').hidden || !document.querySelector('#drawer').hidden, drawer: !document.querySelector('#drawer').hidden, title: document.querySelector('#sheetTitle').textContent, len: history.length }));
    const click = async (sel) => { await page.$eval(sel, (el) => el.click()); await page.waitForTimeout(220); };
    const hrefs = await page.$$eval('a[href^="#/"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))].filter((h) => h !== '#/'));
    const DRAWERS = ['#/story', '#/links', '#/season', '#/live'];
    assert(hrefs.length >= 8 && DRAWERS.every((d) => hrefs.includes(d)), 'home links: ' + hrefs.join(' '));
    for (const href of hrefs) {
      const sel = `a[href="${href}"]`; const before = await state(); const isDrawer = DRAWERS.includes(href);
      await click(sel);
      const after = await state();
      if (CLOSED.some((p) => href === p || href.startsWith(p + '/'))) { assert(!after.open && after.hash === '' && after.len === before.len, `${href}: closed item must go nowhere and touch nothing (${JSON.stringify(after)})`); await page.waitForSelector('.toast'); continue; }
      assert(after.open && after.hash === href && after.len <= before.len + 1 && after.drawer === isDrawer, `${href}: opens with at most one new history entry (${JSON.stringify(after)})`);
      await page.goBack(); await page.waitForTimeout(220);
      let s = await state(); assert(!s.open && s.hash === '', `${href}: Back returns home (${JSON.stringify(s)})`);
      await page.goForward(); await page.waitForTimeout(220);
      s = await state(); assert(s.open && s.hash === href, `${href}: Forward re-opens (${JSON.stringify(s)})`);
      await click(isDrawer ? '#drawerClose' : '#sheetClose');
      s = await state(); assert(!s.open && s.hash === '' && s.len === after.len, `${href}: close goes back instead of pushing (${JSON.stringify(s)} vs len ${after.len})`);
      await page.goForward(); await page.waitForTimeout(220); s = await state(); assert(s.open && s.hash === href, `${href}: Forward after close still works`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(220);
      s = await state(); assert(!s.open && s.hash === '', `${href}: Escape closes by going back (${JSON.stringify(s)})`);
      await click(sel); s = await state(); assert(s.open && s.hash === href, `${href}: opens a second time`);
      if (isDrawer) { // the drawer's own ways out: its backdrop, tapping its dock tab again, a swipe down
        await click('#drawerBackdrop'); s = await state(); assert(!s.open && s.hash === '' && s.len === after.len, `${href}: backdrop closes by going back (${JSON.stringify(s)})`);
        await click(sel); await click(sel + '.on'); s = await state(); assert(!s.open && s.hash === '', `${href}: tapping the lit tab again closes (${JSON.stringify(s)})`);
        await click(sel);
        await page.evaluate(() => { const d = document.querySelector('#drawer'); const t = (type, y) => d.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: d, clientX: 100, clientY: y })], changedTouches: [new Touch({ identifier: 1, target: d, clientX: 100, clientY: y })] })); t('touchstart', 300); t('touchmove', 380); t('touchend', 420); });
        await page.waitForTimeout(220); s = await state(); assert(!s.open && s.hash === '', `${href}: swipe down closes (${JSON.stringify(s)})`);
        await click(sel); s = await state(); assert(s.open && s.hash === href, `${href}: opens again after the swipe`);
      }
      await page.goBack(); await page.waitForTimeout(220); s = await state(); assert(!s.open && s.hash === '', `${href}: Back after reopening (${JSON.stringify(s)})`);
    }
    // sub-tabs inside Learn: Back goes to the previous tab; the sheet's back arrow goes up one level by popping, so Back then goes home
    await click('a[href="#/learn"]'); await page.waitForSelector('#sheet .tab');
    const n = await page.locator('#sheet .tab').count(); assert(n >= 3, 'learn tabs');
    for (let i = 1; i < n - 1; i++) { // the last tab is Help, its own address
      await page.locator('#sheet .tab').nth(i).click(); await page.waitForTimeout(220);
      let s = await state(); assert(s.open && (s.hash.startsWith('#/learn/') || s.hash === '#/help'), 'tab opened: ' + s.hash); // Help is the last tab of the Learn bar
      await page.goBack(); await page.waitForTimeout(220);
      s = await state(); const expect = i === 1 ? '#/learn' : await page.evaluate(() => location.hash); assert(s.open && s.hash === expect, `Back returns to the previous tab (${s.hash})`);
      await page.goForward(); await page.waitForTimeout(220);
    }
    const lenBefore = (await state()).len;
    await click('#sheetBack');
    let s = await state(); assert(s.open && s.hash === '#/learn' && s.len === lenBefore, 'back arrow goes up one level by going back: ' + JSON.stringify(s));
    await page.goBack(); await page.waitForTimeout(220);
    s = await state(); assert(!s.open && s.hash === '', 'Back after the arrow goes home, not to a tab: ' + JSON.stringify(s));
    // a drawer then a sheet: the drawer gives way; Back from the sheet returns to the drawer
    await click('a[href="#/story"]'); s = await state(); assert(s.drawer, 'story drawer');
    await page.evaluate(() => { location.hash = '#/help'; }); await page.waitForSelector('#sheet:not([hidden])'); await page.waitForTimeout(220);
    s = await state(); assert(s.open && !s.drawer && s.hash === '#/help', 'sheet replaces the drawer: ' + JSON.stringify(s));
    await page.goBack(); await page.waitForTimeout(260); s = await state(); assert(s.drawer && s.hash === '#/story', 'Back returns to the drawer: ' + JSON.stringify(s));
    await page.goBack(); await page.waitForTimeout(220); s = await state(); assert(!s.open && s.hash === '', 'and then home');
    // two levels deep via More → Learn: close goes all the way home in one step; Forward still walks back in
    await page.evaluate(() => { location.hash = '#/more'; }); await page.waitForSelector('#sheet .more-row'); await page.waitForTimeout(220);
    await click('#sheet .more-row[href="#/learn"]'); s = await state(); assert(s.open && s.hash === '#/learn', 'More → Learn');
    await click('#sheetClose'); s = await state(); assert(!s.open && s.hash === '', 'close from two levels goes home: ' + JSON.stringify(s));
    await page.goForward(); await page.waitForTimeout(220); s = await state(); assert(s.open && s.hash === '#/more', 'Forward → More again: ' + JSON.stringify(s));
    // a closed section typed in by hand from an open sheet: the calm "Coming soon" card; Back returns to the sheet, then home. No trap.
    await page.evaluate(() => { location.hash = '#/chat/general'; }); await page.waitForSelector('#sheet .soon-t:has-text("Coming soon")'); await page.waitForTimeout(220);
    s = await state(); assert(s.open && !s.drawer && s.hash === '#/chat/general' && s.title === 'Coming soon', 'closed route by hand: the card: ' + JSON.stringify(s));
    await page.goBack(); await page.waitForTimeout(220); s = await state(); assert(s.open && s.hash === '#/more', 'Back returns to More: ' + JSON.stringify(s));
    await page.goBack(); await page.waitForTimeout(220); s = await state(); assert(!s.open && s.hash === '', 'and then home: ' + JSON.stringify(s));
    // landing straight on a closed section: the card, and closing it leaves a plain home entry (nothing to get stuck on)
    await page.goto(BASE + '/#/chat/builds'); await page.waitForSelector('#sheet .soon-t:has-text("Coming soon")'); await page.waitForTimeout(300);
    s = await state(); assert(s.open && s.hash === '#/chat/builds' && s.title === 'Coming soon', 'direct closed link shows the card: ' + JSON.stringify(s));
    await click('#sheetClose'); s = await state(); assert(!s.open && s.hash === '', 'closing it goes home: ' + JSON.stringify(s));
    await ctx.close();
  }
});
// The rest exercises the full features, as they'll work once the admin opens them.
// The server allows every area and the admin panel opens them (both gates: see lib/app.js).
app2.config.chatOpen = true; app2.config.accountsOpen = true;
app2.settings.set('areas', { chat: true, accounts: true });
await t('once opened: the Chat drawer shows the small live chat preview, room chips, top ideas; the Chat and Build tabs are live (no Soon mark)', async () => {
  // the seed writes no chat messages: this test writes its own, plainly
  assert(app2.db.get("SELECT COUNT(*) n FROM messages WHERE uid='herd'").n === 0, 'no welcome posts from the seed');
  for (const [w, b, i] of [[DEMO_IDS[0], 'Anyone watching the block height tonight?', 3], [DEMO_IDS[1], 'Staked a little more this week.', 2]]) app2.db.run('INSERT INTO messages(room,uid,body,created_at) VALUES(?,?,?,?)', 'general', w, b, Date.now() - i * 60_000);
  const { page, ctx } = await newPage(); await page.goto(BASE);
  await page.waitForFunction(() => !document.querySelector('.dk[data-dk="live"]').hidden && !document.querySelector('.dk[data-dk="build"]').hidden, null, { timeout: 10000 });
  assert(await page.$$eval('.dk[data-dk="live"], .dk[data-dk="build"]', (els) => els.every((el) => !el.hasAttribute('aria-disabled') && !el.classList.contains('is-soon') && el.offsetParent)), 'nothing left to come: the two tabs are back and live');
  await page.click('.dk[data-dk="live"]'); await page.waitForSelector('#drawer:not([hidden]) #boardList li .bl-name');
  assert(await page.locator('.board-list li').count() <= 3, 'chat is a small preview');
  for (const label of ['Main', 'Builds']) assert(await page.locator('#boardChips .chip', { hasText: label }).isVisible(), label);
  assert((await page.locator('#boardChips .chip').count()) === 2, 'two rooms, no locked one');
  await page.waitForSelector('#topIdeas li a');
  assert((await page.textContent('.account-label')) === 'Sign in', 'sign-in open');
  await page.click('#boardChips .chip[data-room="builds"]'); await page.waitForFunction(() => document.querySelector('#boardOpen').getAttribute('href') === '#/chat/builds');
  assert(!(await page.locator('.more-row[href^="#/swap"], a[href^="#/swap"]').count()), 'no Swap row once everything is open either');
  await ctx.close();
});
// Every control in every view, at a desktop and a phone width: each click must do something (a hash change, a dialog, a
// toast, a re-render), no console errors, no failed requests other than the gated room, Back/Forward keep working and
// focus returns to what opened a sheet, drawer or dialog. State-changing buttons (post, pay, delete, sign out…) are
// exercised by the feature tests below; here they are only checked to exist and be enabled.
await t('sweep: every button, link and tab in every view at desktop and phone — nothing dead, no errors, no failed requests, Back/Forward, focus returns', async () => {
  const SKIP = /sign out|unlink|delete|remove|leave|^send|^post|pay with|^vote|claim|drop|unlist|relist|reset|create account|continue|apply|mark paid|needs work|approve|decline|^list|report|copy|generate|i’m 18/i;
  const ROUTES = ['#/story', '#/links', '#/season', '#/live', '#/learn', '#/learn/staking', '#/learn/safety', '#/learn/lore', '#/help', '#/disclaimer', '#/build', '#/build/idea/1', '#/chat/general', '#/chat/builds', '#/more', '#/inbox', '#/allies'];
  for (const mobile of [false, true]) {
    const { page, ctx } = await newPage({ who: USER, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, mobile, ip: mobile ? '203.0.113.6' : '203.0.113.5' });
    const label = mobile ? 'phone' : 'desktop';
    const failed = []; page.on('response', (r) => { const u = r.url(); if (r.status() >= 400 && !/favicon/.test(u) && !(r.status() === 429 && u.includes('/api/stream'))) failed.push(`${r.status()} ${u.replace(BASE, '')}`); });
    page.on('dialog', (d) => d.dismiss()); page.on('crash', () => errors.push(label + ' sweep: page crashed')); page.on('close', () => console.log('   (sweep page closed)'));
    await ctx.addInitScript(() => { window.__mut = 0; new MutationObserver((m) => { window.__mut += m.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
    await page.goto(BASE); await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
    await signIn(page, 'sweeper' + (mobile ? 'p' : 'd'));
    const dead = []; let clicked = 0;
    const settle = async () => { // close whatever a click opened, go back to where we were
      if (await page.evaluate(() => document.querySelector('#modal').children.length)) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
      if (await page.evaluate(() => document.querySelector('#modal').children.length)) { const c = page.locator('.modal button', { hasText: /cancel|not now|back|later|close|ok/i }).first(); if (await c.count()) await c.click(); await page.waitForTimeout(120); }
    };
    async function sweep(scope, route) {
      const sel = `${scope} :is(button, a[href], summary, [role=tab]):visible`;
      const n = await page.locator(sel).count();
      for (let i = 0; i < n; i++) {
        const loc = page.locator(sel).nth(i); if (!(await loc.count())) continue;
        const info = await loc.evaluate((el) => ({ text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), href: el.getAttribute('href'), target: el.getAttribute('target'), disabled: !!el.disabled, selected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('on') || el.classList.contains('chip-orange'), id: el.id, cls: el.className }));
        if (info.disabled || info.selected) continue;
        if (info.href && /^https:/.test(info.href)) { assert(info.target === '_blank' && /noopener/.test((await loc.getAttribute('rel')) || ''), `${label} ${route} ${info.text}: outside link opens a new tab with noopener`); continue; }
        if (SKIP.test(info.text)) continue;
        if (/theme|minimize|maximize|close \(back/i.test(info.text) || /wb-|menu-btn|skip/.test(info.cls)) continue;
        const before = await page.evaluate(() => ({ hash: location.hash, mut: window.__mut, toasts: document.querySelectorAll('.toast').length }));
        try { await loc.click({ timeout: 2000 }); } catch (e) { dead.push(`${label} ${route} “${info.text}”: not clickable (${e.message.split('\n')[0]})`); continue; }
        clicked++;
        await page.waitForTimeout(380);
        const after = await page.evaluate(() => ({ hash: location.hash, mut: window.__mut, toasts: document.querySelectorAll('.toast').length, modal: document.querySelector('#modal').children.length }));
        if (after.hash === before.hash && after.mut === before.mut && after.toasts === before.toasts && !after.modal) dead.push(`${label} ${route} “${info.text}” (#${info.id} .${info.cls}) did nothing`);
        await settle();
        if (await page.evaluate((r) => location.hash !== r, route)) { await page.evaluate((r) => { location.hash = r; }, route); await page.waitForTimeout(350); }
      }
    }
    // the home itself
    await sweep('.home', '#/'); await settle();
    // every drawer and sheet by address: open it, sweep it, check Back/Forward
    for (const route of ROUTES) {
      await page.evaluate((r) => { location.hash = r; }, route);
      const drawer = ['#/story', '#/links', '#/season', '#/live'].includes(route);
      await page.waitForSelector(drawer ? '#drawer:not([hidden])' : '#sheet:not([hidden])', { timeout: 8000 });
      await page.waitForTimeout(500);
      await page.goBack(); await page.waitForTimeout(260);
      assert(await page.evaluate(() => document.querySelector('#sheet').hidden && document.querySelector('#drawer').hidden), `${label} ${route}: Back closes it`);
      await page.goForward(); await page.waitForTimeout(400);
      assert(!(await page.evaluate(() => document.querySelector('#sheet').hidden && document.querySelector('#drawer').hidden)), `${label} ${route}: Forward reopens it`);
      await sweep(drawer ? '#drawer' : '#sheet', route);
      await page.evaluate(() => { location.hash = '#/'; }); await page.waitForTimeout(260);
    }
    // focus returns to the opener: a dock tab → drawer → close; a dock tab → sheet → close; the account button → dialog → Escape
    await page.goto(BASE); await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
    for (const [tab, closeSel] of [['story', '#drawerClose'], ['learn', '#sheetClose']]) {
      await page.focus(`.dk[data-dk="${tab}"]`); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
      assert(await page.evaluate((t) => document.querySelector(`.dk[data-dk="${t}"]`).getAttribute('aria-current') === 'true', tab), `${label} ${tab}: dock tab marked current`);
      const focusInside = await page.evaluate((d) => (d ? document.querySelector('#drawer') : document.querySelector('#sheet')).contains(document.activeElement), tab === 'story');
      assert(focusInside, `${label} ${tab}: focus moved inside`);
      await page.click(closeSel); await page.waitForTimeout(400);
      assert(await page.evaluate((t) => document.activeElement === document.querySelector(`.dk[data-dk="${t}"]`), tab), `${label} ${tab}: focus returned to the dock tab`);
    }
    await page.focus('#accountBtn'); await page.keyboard.press('Enter'); await page.waitForSelector('.modal'); await page.waitForTimeout(150);
    assert(await page.evaluate(() => document.querySelector('.modal').contains(document.activeElement)), `${label}: focus inside the dialog`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    assert(await page.evaluate(() => document.activeElement === document.querySelector('#accountBtn')), `${label}: focus back on the account button`);
    assert(clicked > (mobile ? 45 : 55), `${label}: swept ${clicked} controls`);
    assert(!dead.length, `${label}: dead controls: ` + dead.slice(0, 6).join(' | '));
    assert(!failed.length, `${label}: failed requests: ` + [...new Set(failed)].slice(0, 6).join(' | '));
    await ctx.close();
  }
});
await t('CA copy button, theme toggle to 2009 and back', async () => {
  const { page, ctx } = await newPage();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(BASE);
  await page.click('.ca'); await page.waitForSelector('.ca.copied');
  assert((await page.evaluate(() => navigator.clipboard.readText())) === '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump', 'clipboard');
  await page.click('#themeBtn');
  assert((await page.getAttribute('html', 'data-theme')) === 'light');
  assert(await page.isVisible('.win-title'), '2009 title bar');
  assert(!(await page.locator('.addrbar, #myaddr').count()), 'no address bar in the 2009 chrome');
  assert(await page.isVisible('#sb-blocks'), 'status bar');
  await page.click('.menu-btn:has-text("File")'); await page.click('.menu-list button:has-text("Exit")');
  assert((await page.getAttribute('html', 'data-theme')) === 'dark', 'File→Exit returns to dark');
  await ctx.close();
});
await t('sign in (a member with no display name yet), pick a name in the dialog, post in Crypto Builds, react', async () => {
  const { page, ctx } = await newPage({ who: USER });
  await page.goto(BASE + '/#/chat/builds');
  await page.waitForSelector('.room-blurb');
  assert((await page.textContent('.room-blurb')).includes('building'), 'builds blurb');
  await signIn(page, 'fogwalker');
  await page.fill('.composer textarea', 'Shipping a block-time bot tonight');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.mine .msg-body:has-text("block-time bot")');
  await page.hover('.msg.mine'); await page.click('.msg.mine .react:has-text("🔥")');
  await page.waitForSelector('.msg.mine .react.mine');
  await page.fill('.composer textarea', 'call me 555-555-0199');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.toast-error');
  await ctx.close();
});
await t('sign-in sends no age confirmation by itself (dormant until a post needs it); sign-out forgets the remembered tick', async () => {
  const { page, ctx } = await newPage({ who: kp() }); const calls = [];
  page.on('request', (r) => { if (r.url().includes('/api/me/adult')) calls.push(r.method()); });
  await page.goto(BASE); await page.waitForSelector('#accountBtn');
  await signIn(page, 'p12user');
  assert(calls.length === 0, 'no /api/me/adult call on sign-in: ' + calls.join(','));
  assert((await page.evaluate(() => localStorage.getItem('tbb-adult'))) === '1', 'the remembered tick is untouched while signed in');
  await page.click('#accountBtn'); await page.click('.modal button:text-is("Sign out")'); await page.waitForSelector('.toast:has-text("Signed out.")');
  assert((await page.evaluate(() => localStorage.getItem('tbb-adult'))) === null, 'sign-out forgets the tick');
  await ctx.close();
});
await t('Sign in with X return (#/?x=…): a message, never a page; an unknown or prototype code gets the plain error', async () => {
  const a = await newPage(); await a.page.goto(BASE + '/#/?x=error');
  await a.page.waitForSelector('.toast:has-text("Sign in with X didn’t work")');
  assert(await a.page.evaluate(() => document.querySelector('#sheet').hidden), 'no sheet opened for the x return');
  assert(await a.page.evaluate(() => document.querySelector('#sheetTitle').textContent !== 'Not found'), 'no Not found');
  assert((await a.page.evaluate(() => location.hash)) === '', 'hash cleared');
  await a.ctx.close();
  const b = await newPage(); await b.page.goto(BASE + '/#/?x=constructor');
  await b.page.waitForSelector('.toast:has-text("Sign in with X didn’t work")');
  assert(await b.page.evaluate(() => ![...document.querySelectorAll('.toast')].some((t) => /native code|function/.test(t.textContent))), 'no prototype text in a toast');
  await b.ctx.close();
});
await t('chat is text only: the note under the box, a pasted picture says "Pictures coming soon.", a link is refused with "coming soon", 👍 shows a count, a hidden message vanishes live', async () => {
  const { page, ctx } = await newPage({ who: kp() }); // a member of its own: the per-account chat pacing of the test before must not count here
  await page.goto(BASE + '/#/chat/general'); await signIn(page, 'textonly');
  await page.waitForSelector('.composer textarea');
  assert((await page.textContent('.composer-note')) === 'Links and pictures coming soon.', 'the quiet line under the box');
  // a pasted file
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'x.png', { type: 'image/png' })); document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await page.waitForSelector('.toast:has-text("Pictures coming soon.")');
  // a dropped file
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'y.png', { type: 'image/png' })); document.querySelector('.composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => document.querySelectorAll('.toast').length >= 2 || [...document.querySelectorAll('.toast')].every((t) => t.textContent === 'Pictures coming soon.'), null, { timeout: 3000 });
  assert((await page.locator('.toast:has-text("Pictures coming soon.")').count()) >= 1, 'drop says the same');
  // a link, in a disguise
  await page.fill('.composer textarea', 'free TBB at claim-tbb dot xyz'); await page.keyboard.press('Enter');
  await page.waitForSelector('.toast-error'); assert((await page.locator('.toast-error').last().textContent()) === 'Links aren’t allowed yet — coming soon.', 'the link refusal: ' + await page.locator('.toast-error').last().textContent());
  assert(!(await page.locator('.msg-body:has-text("claim-tbb")').count()), 'not posted');
  // a normal message, never linkified, 👍 with a count
  await page.waitForTimeout(2100);
  await page.fill('.composer textarea', 'gm herd, see you at 12:30'); await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.mine .msg-body:has-text("gm herd")');
  assert(!(await page.locator('.chat-scroll a').count()), 'no anchors in user text');
  await page.hover('.msg.mine'); await page.click('.msg.mine .react:has-text("👍")');
  await page.waitForSelector('.msg.mine .react.mine:has-text("👍")');
  assert((await page.textContent('.msg.mine .react.mine .n')) === '1', 'thumbs-up count');
  // another visitor sees the message; the admin hides it; it vanishes for the visitor without a reload
  const other = await newPage(); await other.page.goto(BASE + '/#/chat/general'); await other.page.waitForSelector('.msg-body:has-text("gm herd")');
  await other.page.waitForSelector('html.live', { timeout: 60_000 });
  const id = app2.db.get("SELECT id FROM messages WHERE body='gm herd, see you at 12:30'").id;
  app2.mod.hide(id, { actor: 'panel', reason: 'e2e' });
  await other.page.waitForFunction(() => !document.querySelector('.msg-body') || ![...document.querySelectorAll('.msg-body')].some((b) => b.textContent.includes('gm herd')), null, { timeout: 8000 });
  await other.ctx.close(); await ctx.close();
});
await t('first visit (fresh browser storage, motion allowed): the page shows at once — no reveal, no card, the head in its final pose with still eyes, nothing tappable ever invisible, nothing remembered; the dormant account-side confirmation is a plain dialog before a first post', async () => {
  const { page, ctx } = await newPage({ adult: false, motion: 'no-preference' });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // the very first frame: everything there, nothing faded, nothing hidden behind a timeline
  const first = await page.evaluate(() => ({ cls: document.documentElement.className, hero: getComputedStyle(document.querySelector('.hero')).opacity, top: getComputedStyle(document.querySelector('.top')).opacity, head: getComputedStyle(document.querySelector('.bull-wide')).visibility, eye: getComputedStyle(document.querySelector('.bull-wide .bh-eye')).opacity, glowAnims: document.querySelector('.bull-wide .bh-glow').getAnimations().length, seen: sessionStorage.getItem('tbb-seen'),
    // tappable = displayed and not clipped away (the lore line's "verify" link sits in a zero-height disclosure until the line is tapped)
    invisible: [...document.querySelectorAll('.home a, .home button')].filter((el) => el.offsetParent && !(() => { for (let e = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).overflow === 'hidden' && e.clientHeight === 0) return true; return false; })()).filter((el) => (() => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.opacity !== '1' || cs.visibility !== 'visible') return true; } return false; })()).map((el) => el.className || el.outerHTML.slice(0, 60)) }));
  assert(!/reveal/.test(first.cls) && first.hero === '1' && first.top === '1' && first.head === 'visible' && first.eye === '1' && first.glowAnims === 0 && first.seen === null, 'no reveal: ' + JSON.stringify(first));
  assert(!first.invisible.length, 'nothing tappable is invisible: ' + first.invisible.join(' | '));
  assert(!(await page.locator('#ageGate, .age-gate, .age-card, .modal').count()) && !(await page.evaluate(() => 'gate' in document.documentElement.dataset)), 'no card, no dialog, no gate flag');
  await page.waitForFunction(() => document.querySelector('#st-price .stat-v').textContent.startsWith('$'));
  const polys = await page.evaluate(() => document.querySelector('.bull-wide polygon[data-k="12"]').getAttribute('points'));
  await page.waitForTimeout(1500);
  assert((await page.evaluate(() => document.querySelector('.bull-wide polygon[data-k="12"]').getAttribute('points'))) === polys && (await page.evaluate(() => document.querySelector('.bull-wide .bh-glow').getAnimations().length)) === 0, 'the head rests: no turn, no pulse');
  assert(!/18\+|18 or older|18 and over|\badults?\b/i.test(await page.evaluate(() => document.body.innerText)), 'no age wording on the page');
  assert((await page.evaluate(() => localStorage.getItem('tbb-adult'))) === null && (await page.evaluate(() => sessionStorage.length)) === 0, 'nothing remembered: there was nothing to answer, no reveal to remember');
  await ctx.close();
  // the account side stays (dormant until accounts and chat open): signed in without the account confirmation, the server
  // asks, a small plain dialog confirms, the post goes through and the account carries it from then on
  const fresh = kp();
  const p2 = await newPage({ who: fresh, adult: true }); await p2.page.goto(BASE + '/#/chat/builds'); await signIn(p2.page, 'latecomer');
  app2.db.run('UPDATE users SET adult_confirmed_at=NULL WHERE uid=?', fresh); await p2.page.evaluate(() => localStorage.removeItem('tbb-adult'));
  await p2.page.waitForSelector('.composer textarea');
  await p2.page.fill('.composer textarea', 'first post from the latecomer'); await p2.page.keyboard.press('Enter');
  await p2.page.waitForSelector('.modal[data-title="Confirm your age"]');
  assert(!(await p2.page.locator('.age-gate, .age-card').count()), 'a plain dialog, not a full-screen card');
  await p2.page.click('#adultYes');
  await p2.page.waitForSelector('.msg.mine .msg-body:has-text("latecomer")');
  assert(app2.db.get('SELECT adult_confirmed_at FROM users WHERE uid=?', fresh).adult_confirmed_at > 0, 'stored on the account');
  assert(!(await p2.page.locator('.modal').count()), 'the dialog closed');
  await p2.ctx.close();
});
await t('accounts: create one in the dialog (browser proof of work, 18+, one-time recovery code), slow start, sign out everywhere, sign in, wrong password, recovery with a new code; the account menu (desktop + phone, dark + light)', async () => {
  for (const [mobile, theme] of [[false, 'dark'], [true, 'light']]) {
    const { page, ctx } = await newPage({ theme, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, mobile }); await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('.account-label').textContent === 'Sign in');
    const name = 'ridge' + Math.random().toString(36).slice(2, 7);
    // the dialog: two tabs, the recovery link, no "Link X" button (X is off until configured), no e-mail field anywhere
    await page.click('#accountBtn'); await page.waitForSelector('.modal .auth-tabs');
    assert((await page.locator('.modal .tab').allTextContents()).join('|') === 'Sign in|Create account', 'tabs');
    assert(await page.isVisible('.modal button:has-text("Have a recovery code?")'), 'recovery link');
    assert(!(await page.locator('.modal :text("Link X")').count()) && !(await page.locator('.modal :text("Sign in with X")').count()), 'no X button while X is off');
    assert(!(await page.locator('.modal input[type=email], .modal input[type=tel]').count()), 'no e-mail or phone fields');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#modal').children.length);
    // sign up
    const code = await signUp(page, name);
    assert(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/.test(code), 'recovery code shape: ' + code);
    const me = await (await page.evaluate(() => fetch('/api/state').then((r) => r.json()))).me;
    assert(me.username === name && me.hasPassword === true && !('wallet' in me), 'signed in with a username and nothing else: ' + JSON.stringify(me));
    // slow start: the first ten minutes are read-only
    await page.goto(BASE + '/#/chat/general'); await page.waitForSelector('.composer textarea');
    await page.fill('.composer textarea', 'first words from a new account'); await page.keyboard.press('Enter');
    await page.waitForSelector('.toast-error:has-text("first 10 minutes")');
    app2.db.run('UPDATE users SET created_at=? WHERE username=?', Date.now() - 3 * 86400_000, name);
    await page.fill('.composer textarea', 'first words from a new account'); await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.mine .msg-body:has-text("first words from a new account")');
    // the account menu: username chip, Change password, Inbox, Sign out everywhere; nothing that asks for anything else
    await page.evaluate(() => { location.hash = '#/'; }); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
    await page.click('#accountBtn'); await page.waitForSelector('.modal .modal-title');
    for (const label of ['@' + name, 'Change password', 'Inbox', 'Sign out everywhere']) assert(await page.locator('.modal', { hasText: label }).count(), label);
    assert(!/wallet|verify|address|purchase|sell/i.test(await page.textContent('.modal')), 'the menu offers nothing of the removed features');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#modal').children.length);
    // sign out everywhere, then back in with the password; a wrong password gets one calm message
    await page.click('#accountBtn'); await page.click('.modal button:has-text("Sign out everywhere")'); await page.waitForSelector('.toast:has-text("Signed out everywhere")');
    await page.waitForFunction(() => document.querySelector('.account-label').textContent === 'Sign in');
    await page.click('#accountBtn'); await page.fill('.modal input[aria-label="Username"]', name); await page.fill('.modal input[aria-label="Password"]', 'not the password'); await page.click('.modal button[type=submit]');
    await page.waitForSelector('.modal .form-err:has-text("Wrong username or password.")');
    await page.fill('.modal input[aria-label="Password"]', 'fog on the ridge 2026'); await page.click('.modal button[type=submit]');
    await page.waitForFunction((x) => document.querySelector('.account-label').textContent === x, name);
    await page.waitForSelector('.toast:has-text("Welcome back")');
    // recovery: the code + a new password; a new code is shown once
    await page.click('#accountBtn'); await page.click('.modal .row > button.btn:has-text("Sign out"):not(:has-text("everywhere"))'); await page.waitForFunction(() => document.querySelector('.account-label').textContent === 'Sign in');
    await page.click('#accountBtn'); await page.click('.modal button:has-text("Have a recovery code?")');
    await page.waitForSelector('.modal input[aria-label="Recovery code"]');
    await page.fill('.modal input[aria-label="Username"]', name); await page.fill('.modal input[aria-label="Recovery code"]', code.toLowerCase()); await page.fill('.modal input[aria-label="New password"]', 'a second passphrase here');
    await page.click('.modal button[type=submit]'); await page.waitForSelector('.code-box');
    const code2 = await page.textContent('.code-box'); assert(code2 !== code && /^[A-Z2-9-]{29}$/.test(code2), 'new code');
    await page.check('#savedTick'); await page.click('.modal button:has-text("Continue")');
    await page.waitForFunction((x) => document.querySelector('.account-label').textContent === x, name);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways overflow');
    await ctx.close();
    // the old password and the old code are dead; the new ones work (checked straight against the API)
    const login = async (password) => (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: BASE }, body: JSON.stringify({ username: name, password }) })).status;
    assert((await login('fog on the ridge 2026')) === 401 && (await login('a second passphrase here')) === 200, 'passwords after recovery');
  }
});
await t('ideas: post and vote from another member; weekly countdown', async () => {
  const a = await newPage({ who: USER }); await a.page.goto(BASE + '/#/build'); await signIn(a.page);
  await a.page.click('.btn:has-text("New idea")');
  await a.page.fill('.modal input', 'Ridge screensaver'); await a.page.fill('.modal textarea', 'The fog and the bull on the summit as a screensaver.');
  await a.page.click('.modal .btn-primary');
  await a.page.waitForSelector('text=Ridge screensaver');
  await a.ctx.close();
  const b = await newPage({ who: RICH }); await b.page.goto(BASE + '/#/build/ideas'); await signIn(b.page, 'quietbull');
  const card = b.page.locator('.card.idea', { hasText: 'Ridge screensaver' });
  await card.locator('.vote').click();
  await b.page.waitForFunction(() => [...document.querySelectorAll('.card.idea')].some((c) => c.textContent.includes('Ridge screensaver') && c.querySelector('.vote.on')));
  assert(await b.page.isVisible('text=/Vote closes in/'), 'countdown');
  await b.ctx.close();
});
await t('What is $TBB: the creator\'s poster (alt text, lazy, full size on tap, Escape closes), the twelve points verbatim, no outside whitepaper link', async () => {
  const { page, ctx } = await newPage(); await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
  const before = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /tbb-whitepaper/.test(n)));
  assert(before.length === 0, 'the poster is not fetched on the home: ' + before.join(','));
  await page.evaluate(() => { location.hash = '#/learn'; }); await page.waitForSelector('#sheet .wp-pt');
  const ALT = 'The Bitcoin Bull — $TBB white paper poster from the creator, with its twelve points';
  await page.waitForFunction(() => { const i = document.querySelector('#sheet .wp-poster img'); return i && i.complete && i.naturalWidth === 567 && i.naturalHeight === 847; });
  assert((await page.getAttribute('#sheet .wp-poster img', 'alt')) === ALT, 'alt text');
  assert((await page.getAttribute('#sheet .wp-poster img', 'loading')) === 'lazy', 'lazy');
  const shown = await page.$eval('#sheet .wp-poster img', (i) => ({ w: i.getBoundingClientRect().width, src: i.currentSrc }));
  assert(shown.w > 300 && shown.w <= 567 && /\/art\/tbb-whitepaper\.[0-9a-f]{10}\.(avif|webp)$/.test(shown.src), 'shown at its own size or smaller, from a hashed modern format: ' + JSON.stringify(shown));
  assert((await page.locator('#sheet .wp-pt').count()) === 12, 'twelve points');
  for (const line of ['Built on authenticity and organic community growth.', 'Develop a Programmatic Monetary Policy for Distribution', 'Discipline. Focus. Execution. We work. We grind. We win.']) assert(await page.isVisible(`#sheet >> text=${line}`), line);
  assert(await page.isVisible('#sheet >> text=From the creator’s white paper poster. This page is community-made, not from the dev. Not financial advice.'), 'bottom line');
  assert(!(await page.locator('#sheet a[href*="bitcoinhard.money/tbb"]').count()) && !(await page.content()).includes('bitcoinhard.money/tbb'), 'no link to the outside page anywhere');
  assert(!/bull post like never|bull run continues/i.test(await page.textContent('#sheet')), 'the poster’s bonus line and slogan are not site copy');
  // tap: full size in the dialog; Escape closes it and the sheet stays
  await page.click('#sheet .wp-poster'); await page.waitForSelector('#modal .modal.poster img');
  await page.waitForFunction(() => { const i = document.querySelector('#modal .modal.poster img'); return i && i.complete && i.naturalWidth === 567; });
  const full = await page.$eval('#modal .modal.poster img', (i) => { const r = i.getBoundingClientRect(); return { w: r.width, h: r.height, alt: i.alt, fits: r.right <= innerWidth && r.bottom <= innerHeight }; });
  assert(full.alt === ALT && full.fits && full.w >= shown.w, 'full size fits the screen and is no smaller than the preview: ' + JSON.stringify(full));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#modal').children.length);
  assert(!(await page.evaluate(() => document.querySelector('#sheet').hidden)) && (await page.evaluate(() => location.hash)) === '#/learn', 'Escape closes only the dialog');
  const hosts = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map((r) => new URL(r.name).host))]);
  assert(hosts.every((h) => h === new URL(BASE).host), 'no request left this site: ' + hosts.join(','));
  await page.click('#sheet .tab:has-text("Staking & Season 1")');
  await page.waitForSelector('#sheet h3:has-text("Season 1: the Biggest Buyer Board")');
  assert(await page.isVisible('#sheet >> text=12 months 18%'), 'staking rates');
  assert((await page.locator('#sheet .rules li').count()) === 8, 'eight rules');
  assert(await page.isVisible('#sheet >> text=308 buyers'), 'live totals');
  await ctx.close();
});
await t('easter eggs: running bitcoin, 21 clicks, generate coins, 404', async () => {
  const { page, ctx } = await newPage(); await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
  await page.keyboard.type('running bitcoin');
  await page.waitForSelector('.toast-egg:has-text("Hal Finney")');
  for (let i = 0; i < 21; i++) await page.click('#wordmark', { delay: 5 });
  await page.waitForSelector('.toast-egg:has-text("21,000,000")');
  await page.click('#themeBtn'); await page.click('.menu-btn:has-text("Options")'); await page.click('text=Generate Coins');
  await page.waitForSelector('text=No coins here. Only bulls.', { timeout: 8000 });
  await page.click('.modal .btn-primary');
  await page.goto(BASE + '/#/nowhere'); await page.waitForSelector('text=This page has moved on to other things.');
  await ctx.close();
});
await t('learn, help, allies all open; Esc closes back to home', async () => {
  const { page, ctx } = await newPage({ who: USER }); await page.goto(BASE); await signIn(page);
  for (const [h, txt] of [['#/learn/lore', 'Block 0'], ['#/learn/safety', 'recovery phrase'], ['#/help', 'Report a problem'], ['#/allies', 'TBB Time Machine']]) {
    await page.evaluate((x) => { location.hash = x; }, h); await page.waitForSelector(`#sheet >> text=${txt}`);
  }
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('#sheet').hidden);
  await ctx.close();
});
await t('one screen everywhere: no page scroll on desktops, laptops, tablets and phones (dark + light); no sideways overflow at 320px; tap targets ≥ 44px', async () => {
  const sizes = [[1440, 900], [1280, 720], [1024, 650], [820, 1180], [390, 844], [360, 740], [320, 568]];
  for (const theme of ['dark', 'light']) for (const [w, hgt] of sizes) {
    const mobile = w < 900;
    const { page, ctx } = await newPage({ theme, viewport: { width: w, height: hgt }, mobile }); await page.goto(BASE);
    await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M');
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight,
      small: [...document.querySelectorAll('.home .dk, .home .tiles .tile, .home .hero-btn')].filter((el) => el.offsetParent && (el.getBoundingClientRect().height < 44 || el.getBoundingClientRect().width < 44)).map((el) => el.className),
      text: [...document.querySelectorAll('.home .stat-v, .home .t-label, .home .dk-label, .home .hero-btn')].filter((el) => el.offsetParent && parseFloat(getComputedStyle(el).fontSize) < 12).length }));
    assert(m.sw <= w, `${theme} ${w}x${hgt}: scrollWidth ${m.sw}`);
    assert(await page.evaluate(() => [...document.querySelectorAll('.stat-v')].every((v) => v.scrollWidth <= v.clientWidth + 1)), `${theme} ${w}x${hgt}: stat values truncated`);
    // the dock: every label whole (no ellipsis, nothing cut), every Soon mark fully inside the dock; the hero button whole
    const dockCut = await page.evaluate(() => { const d = document.querySelector('.dock').getBoundingClientRect(); const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= d.left - 0.5 && r.right <= d.right + 0.5 && r.top >= d.top - 0.5 && r.bottom <= d.bottom + 0.5; };
      return [...document.querySelectorAll('.dock .dk-label, .dock .dk-soon, .hero-btn')].filter((el) => el.offsetParent).filter((el) => el.scrollWidth > el.clientWidth + 1 || (el.closest('.dock') && !inside(el))).map((el) => el.className + ':' + el.textContent); });
    assert(!dockCut.length, `${theme} ${w}x${hgt}: cut labels: ${dockCut.join(' | ')}`);
    if (theme === 'dark' || w >= 900) assert(m.sh <= hgt, `${theme} ${w}x${hgt}: page scrolls (${m.sh} > ${hgt})`);
    if (theme === 'dark' && w < 900) assert(!m.small.length, `${theme} ${w}x${hgt}: tap targets under 44px: ${m.small.join(' | ')}`);
    await ctx.close();
  }
});
await t('live numbers: every stat says when it was updated; stream pushes update in place; old data shows "delayed", never fake freshness', async () => {
  const { page, ctx } = await newPage(); await page.goto(BASE);
  const waitFn = async (label, fn, arg) => { try { await page.waitForFunction(fn, arg, { timeout: 15000, polling: 200 }); } catch { throw new Error('timed out waiting for: ' + label); } };
  await page.waitForSelector('#panelAge:not([hidden])');
  // this page's live stream must be connected before the server can push anything (earlier pages in this suite used up
  // the per-IP stream budget, so the page may be in its reconnect backoff for a few seconds)
  await page.waitForSelector('html.live', { timeout: 60_000 });
  // one "updated" line per panel; a stat only speaks up when its own source is late
  assert(/^Updated (just now|[1-4]m ago)$/.test(await page.textContent('#panelAge')) && !(await page.$('#panelAge.stale')), 'panel age: ' + await page.textContent('#panelAge'));
  for (const id of ['st-price', 'st-staked', 'st-season']) { assert((await page.textContent(`#${id} .stat-age`)) === '' && !(await page.$(`#${id} .stat-age.stale`)), `${id} quiet while fresh`); assert((await page.getAttribute(`#${id} .stat-age`, 'title')).includes('Last updated'), `${id} tooltip`); }
  assert((await page.textContent('#st-holders .stat-age')) === '' && await page.isHidden('#st-holders'), 'no holders feed → no stat, no fake age');
  const tip = await page.getAttribute('#panelAge', 'title');
  assert(tip.includes('Price:') && tip.includes('every 1 min') && tip.includes('TBB staked:') && tip.includes('every 5 min') && tip.includes('24h chart:'), 'every feed in the tooltip: ' + tip);
  // the server pushes fresh numbers over the live stream: the price changes in place, no reload
  const feeds = { market: { at: Date.now(), ttl: 60_000 }, staked: { at: Date.now(), ttl: 300_000 }, season: { at: Date.now(), ttl: 60_000 }, chart: { at: Date.now(), ttl: 600_000 }, holders: { at: null, ttl: 900_000 } };
  app2.emit('stats', { price: 0.0099, change24h: -1.2, feeds });
  await waitFn('pushed price', () => document.querySelector('#st-price .stat-v').textContent === '$0.0099');
  assert((await page.textContent('#st-24h .stat-v')) === '−1.2%', '24h updated');
  assert((await page.textContent('#st-sub')).includes('Market cap $8.12M'), 'market cap from the source: ' + await page.textContent('#st-sub'));
  app2.emit('stats', { marketCap: null, fdv: 5_000_000, change24h: null, feeds });
  await waitFn('FDV label', () => document.querySelector('#st-sub').textContent.includes('FDV $5.00M'));
  assert(!(await page.textContent('#st-sub')).includes('Market cap') && (await page.textContent('#st-24h .stat-v')) === '—', 'the fully diluted value is labelled FDV, a missing 24h change is —');
  app2.emit('stats', { marketCap: 8122066, change24h: -1.2, feeds });
  // a source that stopped answering: older than twice its interval → muted + "delayed"
  app2.emit('stats', { feeds: { ...feeds, market: { at: Date.now() - 7 * 60_000, ttl: 60_000 } } });
  await page.waitForSelector('#st-price .stat-age.stale');
  assert((await page.textContent('#st-price .stat-age')) === 'delayed · 7m ago', 'delayed label: ' + await page.textContent('#st-price .stat-age'));
  assert(await page.$eval('#st-price', (el) => el.classList.contains('is-stale')), 'stat muted');
  assert((await page.textContent('#panelAge')) === 'Updated 7m ago · delayed: price' && await page.$('#panelAge.stale'), 'panel line says so: ' + await page.textContent('#panelAge'));
  assert(!(await page.$('#st-staked .stat-age.stale')) && (await page.textContent('#st-staked .stat-age')) === '', 'other feeds unaffected');
  app2.emit('stats', { feeds });
  await page.waitForSelector('#st-price .stat-age.live', { state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#panelAge').classList.contains('stale'));
  // the stream itself: connected, and the page talks only to this site
  assert(await page.evaluate(() => typeof EventSource !== 'undefined'), 'sse');
  const hosts = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map((r) => new URL(r.name).host))]);
  assert(hosts.length >= 1 && hosts.every((h) => h === new URL(BASE).host), 'only this site: ' + hosts.join(','));
  await ctx.close();
});
await t('dialogs: the page behind a sheet or drawer is inert (the dock stays live), a dialog makes the window inert; menus and the ticker report their state', async () => {
  const { page, ctx } = await newPage({ who: kp(), theme: 'light', ip: '203.0.113.64' });
  await page.goto(BASE); await page.waitForSelector('#accountBtn:not([hidden])');
  const inert = (sel) => page.$eval(sel, (el) => el.inert === true);
  await page.evaluate(() => { location.hash = '#/learn'; }); await page.waitForSelector('#sheet:not([hidden])'); await page.waitForTimeout(100);
  assert(await inert('.hero') && await inert('.top') && await inert('.menubar') && !(await inert('.dock')) && !(await inert('#sheet')), 'sheet open: the page behind is inert, the dock and the sheet are not');
  await page.evaluate(() => { location.hash = '#/story'; }); await page.waitForSelector('#drawer:not([hidden])'); await page.waitForTimeout(100);
  assert(await inert('.hero') && !(await inert('.dock')) && !(await inert('#drawer')), 'drawer open: still inert behind, the dock reachable');
  await page.click('.dk[data-dk="story"].on'); await page.waitForFunction(() => document.querySelector('#drawer').hidden); await page.waitForTimeout(100);
  assert(!(await inert('.hero')) && !(await inert('.top')), 'closed: everything reachable again');
  await page.click('#accountBtn'); await page.waitForSelector('.modal');
  assert(await inert('#win') && await inert('#sheet'), 'a dialog: the window behind it is inert');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#modal').children.length);
  assert(!(await inert('#win')) && (await page.evaluate(() => document.activeElement === document.querySelector('#accountBtn'))), 'dialog closed: reachable, focus back on the opener');
  // menus (the 2009 look): the button says when its list is open
  const exp = () => page.getAttribute('.menu-btn:has-text("File")', 'aria-expanded');
  assert((await exp()) === 'false'); await page.click('.menu-btn:has-text("File")'); assert((await exp()) === 'true', 'open: aria-expanded true');
  await page.hover('.menu-btn:has-text("Options")'); await page.waitForTimeout(80); assert((await exp()) === 'false' && (await page.getAttribute('.menu-btn:has-text("Options")', 'aria-expanded')) === 'true', 'hovering the next menu moves the open state: one open at a time');
  await page.mouse.click(5, 400); assert((await page.getAttribute('.menu-btn:has-text("Options")', 'aria-expanded')) === 'false', 'closed on a click elsewhere');
  // the ticker: a toggle button, the link outside it
  assert((await page.$eval('#lore', (el) => el.tagName)) === 'DIV' && !(await page.getAttribute('#lore', 'aria-live')), 'the ticker is not a button and not a live region');
  assert((await page.getAttribute('#lore .lore-btn', 'aria-expanded')) === 'false' && !(await page.locator('#lore button a').count()), 'closed, no link inside the button');
  await page.click('#lore .lore-btn'); await page.waitForSelector('#lore.open');
  assert((await page.getAttribute('#lore .lore-btn', 'aria-expanded')) === 'true' && (await page.locator('#loreMeta a').count()) === 1 && (await page.getAttribute('#loreMeta', 'aria-hidden')) === 'false', 'open: the meta line with its link is shown');
  await ctx.close();
});
await t('a visitor whose clock is five minutes fast still sees fresh numbers: ages are measured against the server’s clock', async () => {
  const { page, ctx } = await newPage({ ip: '203.0.113.62' });
  await ctx.addInitScript(() => { const real = Date.now; Date.now = () => real() + 5 * 60_000; });
  await page.goto(BASE); await page.waitForSelector('#panelAge:not([hidden])');
  const line = await page.textContent('#panelAge');
  assert(/^Updated (just now|[1-4]m ago)$/.test(line) && !(await page.$('#panelAge.stale')) && !(await page.$('.stat-age.stale')), 'not delayed on a fast clock: ' + line);
  await ctx.close();
});
await t('Links drawer: when the links cannot be fetched the drawer says so instead of shimmering', async () => {
  const { page, ctx } = await newPage({ ip: '203.0.113.63' });
  await page.route('**/api/allies', (r) => r.fulfill({ status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"down"}' }));
  await page.goto(BASE); await page.evaluate(() => { location.hash = '#/links'; });
  await page.waitForSelector('#linksList .ti-empty');
  assert((await page.textContent('#linksList .ti-empty')) === 'Links unavailable right now.' && !(await page.locator('#linksList .link-skel').count()), 'a plain line replaces the skeleton');
  await ctx.close();
});
await t('admin panel: only on the admin host with a valid Access token; banner, sections, links, story and maintenance reach the public site; audit trail; area switches fail closed and flip live', async () => {
  // the launch state again for this test (the server ceiling closed, the panel closed)
  app2.config.chatOpen = false; app2.config.accountsOpen = false;
  app2.settings.set('areas', { chat: false, accounts: false });
  // public host: nothing admin-ish exists
  assert((await fetch(BASE + '/api/panel/panel')).status === 404 && (await fetch(BASE + '/admin.js')).status === 404, 'public 404s');
  // admin host without the Access header: refused, even for the page itself
  const anon = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  const p0 = await anon.newPage(); const r0 = await p0.goto(ADMIN_BASE + '/'); assert(r0.status() === 403, 'no token → 403, got ' + r0.status()); await anon.close();
  const bad = await browser.newContext({ viewport: { width: 1200, height: 900 }, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': accessToken({ email: 'someone-else@example.com' }) } });
  const p1 = await bad.newPage(); const r1 = await p1.goto(ADMIN_BASE + '/'); assert(r1.status() === 403, 'wrong person → 403'); await bad.close();
  // the admin, on a phone
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': accessToken() } });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push('admin: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('admin console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());
  const setSwitch = (loc, want) => loc.locator('input').evaluate((el, w) => { el.checked = w; el.dispatchEvent(new Event('change', { bubbles: true })); }, want);
  const r = await page.goto(ADMIN_BASE + '/'); assert(r.status() === 200, 'admin → panel');
  await page.waitForSelector('#panel .panel');
  for (const title of ['Status', 'Launch areas', 'Announcement banner', 'Story', 'Maintenance mode', 'Sections shown', 'Links', 'Block chain messages', 'Recent changes']) assert(await page.locator('#panel .h3', { hasText: title }).first().isVisible(), title);
  const launch = await page.$$eval('.launch', (rows) => rows.map((r) => r.textContent));
  assert(launch.length === 2 && launch.every((t) => t.endsWith('Locked — opens after the outside audit (server setting)')), 'every area locked by the server: ' + launch.join(' | '));
  assert(!/wallet|bount|\bmakers?\b/i.test(await page.content()), 'the panel names none of the removed features: ' + JSON.stringify(/.{0,40}(wallet|bount|\bmakers?\b).{0,40}/i.exec(await page.content())?.[0]));
  assert(!(await page.locator('.launch input').count()), 'no switches while the server keeps them shut');
  assert(!/swap/i.test(await page.content()), 'the panel never says swap');
  assert(await page.locator('.feed', { hasText: 'Price (DexScreener)' }).isVisible() && (await page.locator('.feed', { hasText: 'Price (DexScreener)' }).textContent()).includes('last good refresh'), 'feed status');
  assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'panel fits a phone');
  assert(!(await page.content()).includes(ADMIN_EMAIL), 'e-mail never on the page');
  // announcement banner → shows on the public site, links clickable, plain text
  const banner = page.locator('#panel .panel', { hasText: 'Announcement banner' });
  await banner.locator('textarea').fill('Season 1 ends soon <b>bold?</b> see https://example.com/board');
  await banner.locator('select').selectOption('warn');
  await setSwitch(banner.locator('.switch'), true);
  await banner.locator('button:has-text("Save banner")').click(); await page.waitForSelector('.toast:has-text("Saved")');
  const pub = await newPage(); await pub.page.goto(BASE); await pub.page.waitForSelector('#banner:not([hidden])');
  assert((await pub.page.textContent('#banner .announce-text')).includes('<b>bold?</b>'), 'plain text, not HTML');
  assert(!(await pub.page.locator('#banner b').count()), 'no injected markup');
  assert((await pub.page.getAttribute('#banner a', 'href')) === 'https://example.com/board' && (await pub.page.getAttribute('#banner a', 'rel')).includes('noopener'), 'safe link');
  assert(await pub.page.$eval('#banner', (el) => el.classList.contains('warn')), 'warn tone');
  // hide the Season section + chart → gone from the public page (and its dock tab); Learn stays
  const sections = page.locator('#panel .panel', { hasText: 'Sections shown' });
  await setSwitch(sections.locator('.switch', { hasText: 'Season 1' }), false);
  await setSwitch(sections.locator('.switch', { hasText: '24h price chart' }), false);
  await sections.locator('button:has-text("Save sections")').click(); await page.waitForSelector('.toast:has-text("Saved")');
  await pub.page.reload(); await pub.page.waitForSelector('#banner:not([hidden])');
  assert(await pub.page.isHidden('#st-season') && await pub.page.isHidden('.dk[data-dk="season"]') && await pub.page.isHidden('#spark'), 'season + chart hidden');
  await pub.page.evaluate(() => { location.hash = '#/season'; }); await pub.page.waitForTimeout(300);
  assert(await pub.page.evaluate(() => document.querySelector('#drawer').hidden), 'the hidden section’s drawer does not open');
  assert(await pub.page.isVisible('.dk[data-dk="learn"]'), 'learn still there');
  // the story: title + text with bold, italic, a link and an HTML attempt → shown as safe text in the Story drawer; the draft survives a reload
  const story = page.locator('#panel .story-panel');
  await story.locator('input[placeholder^="Title"]').fill('How it started');
  await story.locator('textarea').fill('I bought the **dip**.\n\nThen *the dip of the dip* <b>bold?</b> see https://example.com/board.');
  assert((await story.locator('.story-preview strong').textContent()) === 'dip' && (await story.locator('.story-preview p').count()) === 2, 'live preview');
  await page.reload(); await page.waitForSelector('#panel .panel');
  const story2 = page.locator('#panel .story-panel');
  assert((await story2.locator('textarea').inputValue()).includes('dip of the dip') && (await story2.locator('.draft-note').textContent()).includes('draft'), 'draft restored after a reload');
  await story2.locator('button:has-text("Save story")').click(); await page.waitForSelector('.toast:has-text("Story saved")');
  assert((await page.evaluate(() => localStorage.getItem('tbb-story-draft'))) === null, 'draft cleared once saved');
  await pub.page.evaluate(() => { location.hash = '#/story'; }); await pub.page.waitForSelector('#drawer:not([hidden]) .dw-story:not([hidden])');
  await pub.page.waitForFunction(() => document.querySelector('#storyTitle').textContent === 'How it started', null, { timeout: 8000 });
  assert((await pub.page.locator('#storyBody p').count()) === 2 && (await pub.page.textContent('#storyBody strong')) === 'dip' && (await pub.page.textContent('#storyBody em')) === 'the dip of the dip', 'story rendered');
  assert((await pub.page.textContent('#storyBody')).includes('<b>bold?</b>') && !(await pub.page.locator('#storyBody b').count()), 'HTML shown as text');
  assert((await pub.page.getAttribute('#storyBody a', 'href')) === 'https://example.com/board' && (await pub.page.getAttribute('#storyBody a', 'rel')).includes('noopener'), 'safe link');
  await pub.page.keyboard.press('Escape'); await pub.page.waitForFunction(() => document.querySelector('#drawer').hidden);
  assert(!(await page.locator('#panel .home-panel, #panel .h3:has-text("Home page")').count()) && !/Live visitors|reveal/i.test(await page.textContent('#panel')), 'no reveal switch and no visitor count in the panel');
  // area switches: the server opens chat → the panel shows a switch (closed); flipping it opens chat on the public page without a reload, and closes it again
  app2.config.chatOpen = true;
  await page.reload(); await page.waitForSelector('#panel .panel');
  const areas = () => page.locator('#panel .panel', { hasText: 'Launch areas' });
  assert((await areas().locator('.launch input').count()) === 1, 'one switch (Chat); accounts stay locked');
  assert((await areas().locator('.launch', { hasText: 'Accounts' }).textContent()).includes('Locked — opens after the outside audit'), 'accounts locked');
  await pub.page.waitForSelector('html.live', { timeout: 60_000 }); // this page's live stream must be up before a flip can reach it
  assert(await pub.page.isHidden('.dk[data-dk="live"]') && await pub.page.isHidden('#accountBtn'), 'chat still to come on the public page (the Chat tab is off the dock)');
  await setSwitch(areas().locator('.launch', { hasText: 'Chat' }).first().locator('.switch'), true); await page.waitForSelector('.toast:has-text("Chat: open")');
  await pub.page.waitForFunction(() => !document.querySelector('.dk[data-dk="live"]').hidden && document.querySelector('.dk[data-dk="live"]').offsetParent && document.querySelector('.dk[data-dk="build"]').hidden, null, { timeout: 10_000 }); // the Chat tab comes back (Build stays off)
  assert((await fetch(BASE + '/api/rooms/general/messages')).status === 200, 'chat route open');
  await pub.page.click('.dk[data-dk="live"]'); await pub.page.waitForSelector('#drawer:not([hidden]) #boardList li');
  await page.waitForSelector('#panel .panel');
  await setSwitch(areas().locator('.launch', { hasText: 'Chat' }).first().locator('.switch'), false); await page.waitForSelector('.toast:has-text("Chat: closed")');
  await pub.page.waitForFunction(() => document.querySelector('#drawer').hidden && document.querySelector('.dk[data-dk="live"]').hidden, null, { timeout: 10_000 }); // the open Chat drawer closes itself and the tab goes again
  await pub.page.waitForSelector('.toast:has-text("Coming soon.")');
  assert((await fetch(BASE + '/api/rooms/general/messages')).status === 503, 'chat route closed again');
  app2.config.chatOpen = false;
  // links: add one → appears in the public Links drawer (last); delete it → gone
  await page.waitForSelector('#panel .panel');
  const links = page.locator('#panel .panel', { hasText: 'Links' }).filter({ hasText: 'https:// only' });
  await links.locator('input[placeholder^="Title"]').fill('Example site'); await links.locator('input[placeholder^="https"]').fill('https://example.com/x'); await links.locator('input[placeholder^="One line"]').fill('Just an example');
  await links.locator('button:has-text("Add link")').click(); await page.waitForSelector('.toast:has-text("Link added")');
  await pub.page.reload(); await pub.page.evaluate(() => { location.hash = '#/links'; });
  await pub.page.waitForSelector('#linksList .link-row:has-text("Example site")', { state: 'visible', timeout: 5000 });
  assert((await pub.page.$$eval('#linksList .link-row', (r) => r.map((x) => x.textContent))).pop().includes('Example site'), 'new link is last');
  await page.locator('.link-item', { hasText: 'Example site' }).locator('button:has-text("Delete")').click(); await page.waitForSelector('.toast:has-text("Link removed")');
  await links.locator('input[placeholder^="https"]').fill('http://example.com/x'); await links.locator('input[placeholder^="Title"]').fill('Bad'); await links.locator('input[placeholder^="One line"]').fill('x');
  await links.locator('button:has-text("Add link")').click(); await page.waitForSelector('.toast-error:has-text("https")');
  // maintenance on → public site says back soon (503), API 503; panel still works; then off again
  const maint = page.locator('#panel .panel', { hasText: 'Maintenance mode' });
  await setSwitch(maint.locator('.switch'), true); await maint.locator('button:has-text("Save")').click(); await page.waitForSelector('.toast:has-text("Maintenance mode is on")');
  const m = await pub.page.goto(BASE); assert(m.status() === 503 && await pub.page.isVisible('text=Back soon'), 'back soon page');
  assert((await fetch(BASE + '/api/state')).status === 503, 'api 503');
  assert((await page.reload()).status() === 200, 'panel unaffected');
  await page.waitForSelector('#panel .panel');
  const maint2 = page.locator('#panel .panel', { hasText: 'Maintenance mode' });
  await setSwitch(maint2.locator('.switch'), false); await maint2.locator('button:has-text("Save")').click(); await page.waitForSelector('.toast:has-text("live again")');
  assert((await pub.page.goto(BASE)).status() === 200, 'site back');
  // audit trail shows the changes, actor "panel", no e-mail
  await page.reload(); await page.waitForSelector('.audit-row');
  const audit = await page.$$eval('.audit-row', (rows) => rows.map((r) => r.textContent));
  assert(audit.some((a) => a.includes('setting:maintenance')) && audit.some((a) => a.includes('link:add')) && audit.some((a) => a.includes('setting:banner')), 'audit rows: ' + audit.slice(0, 3).join(' | '));
  assert(audit.some((a) => a.includes('area:chat') && a.includes('closed → open')) && audit.some((a) => a.includes('area:chat') && a.includes('open → closed')) && audit.some((a) => a.includes('setting:story_body')), 'flips and edits audited');
  assert(audit.every((a) => a.includes('panel')) && !audit.join('').includes(ADMIN_EMAIL), 'actor is "panel"');
  // clean up for the other tests
  const b2 = page.locator('#panel .panel', { hasText: 'Announcement banner' }); await setSwitch(b2.locator('.switch'), false); await b2.locator('button:has-text("Save banner")').click(); await page.waitForSelector('.toast:has-text("Saved")');
  const s2 = page.locator('#panel .panel', { hasText: 'Sections shown' }); await setSwitch(s2.locator('.switch', { hasText: 'Season 1' }), true); await setSwitch(s2.locator('.switch', { hasText: '24h price chart' }), true); await s2.locator('button:has-text("Save sections")').click(); await page.waitForSelector('.toast:has-text("Saved")');
  await pub.ctx.close(); await ctx.close();
});
await t('admin moderation (desktop + phone): queue with a held message, approve, hide live, people search, mute with a reason, kick, undo, ban + IP', async () => {
  app2.config.chatOpen = true; app2.config.accountsOpen = true; app2.settings.set('areas', { chat: true, accounts: true });
  // a member posts: one normal message, one the filter holds
  const bad = kp(); const member = await newPage({ who: bad }); await member.page.goto(BASE + '/#/chat/general'); await signIn(member.page, 'suspect');
  await member.page.fill('.composer textarea', 'gm from the suspect'); await member.page.keyboard.press('Enter'); await member.page.waitForSelector('.msg.mine .msg-body:has-text("gm from the suspect")');
  await member.page.waitForTimeout(2100);
  await member.page.fill('.composer textarea', 'is there a telegram group?'); await member.page.keyboard.press('Enter');
  await member.page.waitForSelector('.msg.mine.held .msg-held:has-text("Waiting for a moderator")'); await member.page.waitForSelector('.toast:has-text("waiting for a moderator")');
  const heldId = app2.db.get("SELECT id FROM messages WHERE body='is there a telegram group?'").id;
  // a second visitor must not see the held message
  const viewer = await newPage(); await viewer.page.goto(BASE + '/#/chat/general'); await viewer.page.waitForSelector('.msg-body:has-text("gm from the suspect")');
  assert(!(await viewer.page.locator('.msg-body:has-text("telegram group")').count()), 'held = invisible to others');
  await viewer.page.waitForSelector('html.live', { timeout: 60_000 });
  for (const [label, viewport, mobile] of [['desktop', { width: 1280, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    // the admin's own connection: the admin host paces token checks per connection, and the panel test before this one spent much of that budget
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': accessToken(), 'x-test-ip': mobile ? '203.0.113.78' : '203.0.113.77' } });
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push('admin: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('admin console: ' + m.text()); });
    await page.goto(ADMIN_BASE + '/#queue'); await page.waitForSelector(label === 'desktop' ? '#queue .q-item' : '#queue'); // the desktop pass clears the one queue item; the phone pass checks the layout
    assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= viewport.width, label + ': fits');
    const queue = page.locator('#queue');
    if (label === 'desktop') {
      // the held message is in the queue, with its author; approve it → it appears for the viewer live
      const item = queue.locator('.q-item', { hasText: 'telegram group' }); assert(await item.isVisible(), 'held item'); assert((await item.textContent()).includes('suspect'), 'author shown');
      await item.locator('button:has-text("Approve")').click(); await page.waitForSelector('.toast:has-text("Approved")');
      await viewer.page.waitForSelector('.msg-body:has-text("telegram group")', { timeout: 8000 });
      assert(!(await page.locator('#queue .q-item', { hasText: 'telegram group' }).count()), 'gone from the queue');
      // people: search, hide one message with a reason (the viewer sees it vanish live), mute with a reason
      const people = page.locator('#people'); await people.locator('input[type=search]').fill('suspect'); await page.waitForTimeout(450); // let the search debounce re-render first
      await page.waitForFunction(() => document.querySelectorAll('#people .u-row').length === 1);
      const row = people.locator('.u-row').first(); assert((await row.textContent()).includes('2 messages'), 'message count');
      await row.locator('button:has-text("Messages")').click(); await page.waitForSelector('#people .u-msg');
      const msgRow = people.locator('.u-msg', { hasText: 'gm from the suspect' }); await msgRow.locator('button:has-text("Hide")').click();
      await people.locator('.reason input').fill('e2e hide'); await people.locator('.reason button:has-text("Hide")').click(); await page.waitForSelector('.toast:has-text("Hidden")');
      await viewer.page.waitForFunction(() => ![...document.querySelectorAll('.msg-body')].some((b) => b.textContent.includes('gm from the suspect')), null, { timeout: 8000 });
      await page.waitForSelector('#people .u-row'); await people.locator('input[type=search]').fill('suspect'); await page.waitForTimeout(450); // let the search debounce re-render first await page.waitForFunction(() => document.querySelectorAll('#people .u-row').length === 1);
      const row2 = people.locator('.u-row').first(); await row2.locator('.mute-ctl select').selectOption('60');
      await row2.locator('button:has-text("Mute")').click(); const noReason = row2.locator('.reason button:has-text("Mute")'); await noReason.click();
      assert(await row2.locator('.reason input.bad').isVisible(), 'a reason is required');
      await row2.locator('.reason input').fill('cooling off'); await noReason.click(); await page.waitForSelector('.toast:has-text("Muted")');
      await member.page.waitForTimeout(300); await member.page.fill('.composer textarea', 'can I still talk?'); await member.page.keyboard.press('Enter'); await member.page.waitForSelector('.toast-error:has-text("muted")');
      // the log shows it with the reason; undo lifts the mute
      const log = page.locator('#modlog'); const muteRow = log.locator('.mod-row', { hasText: 'cooling off' }); assert(await muteRow.isVisible(), 'logged with reason');
      await muteRow.locator('button:has-text("Undo")').click(); await page.waitForSelector('.toast:has-text("Undone")');
      await member.page.waitForTimeout(2100); await member.page.fill('.composer textarea', 'back again'); await member.page.keyboard.press('Enter'); await member.page.waitForSelector('.msg.mine .msg-body:has-text("back again")');
      // kick from the people list: the member is signed out at once (their live stream must be up to hear it)
      await member.page.waitForSelector('html.live', { timeout: 60_000 });
      await page.waitForSelector('#people .u-row'); await people.locator('input[type=search]').fill('suspect'); await page.waitForTimeout(450); // let the search debounce re-render first await page.waitForFunction(() => document.querySelectorAll('#people .u-row').length === 1);
      await people.locator('.u-row').first().locator('button:has-text("Kick")').click(); await people.locator('.reason input').fill('e2e kick'); await people.locator('.reason button:has-text("Kick")').click(); await page.waitForSelector('.toast:has-text("Kicked")');
      await member.page.waitForSelector('.toast:has-text("signed out by a moderator")', { timeout: 8000 });
      await member.page.waitForFunction(() => !document.querySelector('#accountBtn').classList.contains('on'));
      // ban account + IP from the people list: the chooser needs a reason; the connection (every e2e page shares one) can read
      // but not sign up or post; the IP bans section shows it with the other accounts on it; Lift opens it again
      await page.waitForSelector('#people .u-row'); await people.locator('input[type=search]').fill('suspect'); await page.waitForTimeout(450);
      await people.locator('.u-row').first().locator('button:has-text("Ban…")').click();
      const ban = people.locator('.ban-ctl'); assert(await ban.isVisible(), 'ban chooser');
      assert((await ban.locator('select').nth(0).locator('option').allTextContents()).join('|') === 'Ban account|Ban account + IP', 'two kinds of ban');
      assert((await ban.locator('select').nth(1).locator('option').allTextContents()).join('|') === 'for good|24 hours|7 days|30 days', 'account ban lengths');
      await ban.locator('select').nth(0).selectOption('ip');
      assert((await ban.locator('select').nth(2).locator('option').allTextContents()).join('|') === 'IP 24 hours|IP 7 days|IP 30 days' && (await ban.locator('select').nth(2).inputValue()) === '7', 'IP bans: 24 h / 7 d / 30 d, default 7 d, never for good');
      await ban.locator('button:has-text("Ban")').click(); assert(await ban.locator('input.bad').isVisible(), 'a reason is required');
      await ban.locator('input').fill('e2e ban'); await ban.locator('button:has-text("Ban")').click(); await page.waitForSelector('.toast:has-text("Banned, and the connection")');
      const post = (body) => fetch(BASE + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: BASE }, body: JSON.stringify(body) });
      const blocked = await post({ username: 'blockedone', password: 'fog on the ridge 2026', adult: true }); assert(blocked.status === 403 && /this connection/.test((await blocked.json()).error), 'sign-up from the banned connection is refused');
      assert((await fetch(BASE + '/api/rooms/general/messages')).status === 200 && (await fetch(BASE + '/')).status === 200, 'reading still works');
      const ipb = page.locator('#ipbans'); await ipb.scrollIntoViewIfNeeded(); await page.waitForSelector('#ipbans .ip-row');
      const ipRow = ipb.locator('.ip-row').first(); assert(/#[0-9a-f]{8}/.test(await ipRow.locator('b.mono').textContent()) && !/\d+\.\d+\.\d+\.\d+|127\.0|::1/.test(await ipRow.textContent()), 'a label, never the IP');
      assert(/\d+ other accounts? used this connection/.test(await ipRow.textContent()), 'others count: ' + await ipRow.textContent());
      await ipRow.locator('button:has-text("Review")').click(); await page.waitForSelector('#people .ip-filter');
      assert((await page.locator('#people .u-row').count()) >= 2, 'one-click review lists the accounts on that connection');
      await page.locator('#people .ip-filter button:has-text("Show everyone")').click(); await page.waitForSelector('#people .u-row');
      await page.locator('#ipbans .ip-row').first().locator('button:has-text("Lift")').click(); await page.locator('#ipbans .reason input').fill('e2e lift'); await page.locator('#ipbans .reason button:has-text("Lift")').click();
      await page.waitForSelector('.toast:has-text("IP ban lifted")');
      const ok = await post({ username: 'blockedone', password: 'fog on the ridge 2026', adult: true }); assert(ok.status === 422, 'the connection is open again (only the browser check is missing now): ' + ok.status);
      assert((await page.locator('#modlog .mod-row', { hasText: 'banned for good + 1 connection' }).count()) || (await page.locator('#modlog .mod-row', { hasText: 'banned for good +' }).count()), 'logged with the IP part');
      // the chat rules are a plain list: no on-chain gate, nothing to save
      const rules = page.locator('#chatrules'); assert(await rules.isVisible() && !(await rules.locator('input, button').count()) && !/TBB held|on chain|Million/i.test(await rules.textContent()), 'chat rules: text only, no setting');
    } else {
      // phone: the panels render and fit
      for (const id of ['queue', 'people', 'modlog', 'chatrules']) assert(await page.locator('#' + id).isVisible(), 'phone: ' + id);
      assert(!(await page.locator('#queue .q-item[data-kind="image"], #build').count()), 'no image queue, no makers section');
    }
    await ctx.close();
  }
  await viewer.ctx.close(); await member.ctx.close();
  app2.config.chatOpen = false; app2.config.accountsOpen = false; app2.settings.set('areas', { chat: false, accounts: false });
});
await t('share today’s line: the browser’s share sheet when there is one (title, text, this site’s address, nothing else), else the clipboard + a toast; a phone shows the kicker and the fine print, no page scroll, no visitor count', async () => {
  const { page, ctx } = await newPage({ viewport: { width: 390, height: 844 }, mobile: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => { window.__shared = null; Object.defineProperty(navigator, 'share', { value: (d) => { window.__shared = d; return Promise.resolve(); }, configurable: true }); });
  await page.goto(BASE); await page.waitForFunction(() => document.querySelector('#st-staked .stat-v').textContent === '52.71M' && document.querySelector('#st-season .stat-v').textContent === '308 buyers');
  assert(await page.locator('#kicker').isVisible() && await page.locator('.fine').isVisible() && await page.locator('.fine a[href="#/disclaimer"]').isVisible(), 'kicker and fine print on a phone');
  assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'still one screen with the fine print');
  assert((await page.locator('.dock .dk:visible').count()) === 4, 'four tabs on the phone dock');
  await page.click('#shareBtn');
  const shared = await page.evaluate(() => window.__shared);
  assert(shared && shared.title === 'The Bitcoin Bull · $TBB community dashboard' && shared.url === BASE + '/' && /^TBB \$0\.00812 \(\+2\.6% 24h\) · 52\.71M staked · Season 1: 308 buyers, \d+d left$/.test(shared.text), 'share payload: ' + JSON.stringify(shared));
  assert(!/online|wallet|stake ↗/i.test(shared.text) && !(await page.locator('.toast').count()), 'nothing else in the line, no toast when the sheet opened');
  // no share sheet (a desktop browser): the same line goes to the clipboard with the site’s host, and a toast says so
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
  await page.click('#shareBtn'); await page.waitForSelector('.toast:has-text("Today’s line copied")');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip === shared.text + ' · ' + new URL(BASE).host, 'clipboard: ' + clip);
  assert(!(await page.locator('iframe, script[src*="twitter"], script[src*="facebook"]').count()), 'no third-party widget');
  // a cancelled share sheet is quiet
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })), configurable: true }); });
  const toasts = await page.locator('.toast').count(); await page.click('#shareBtn'); await page.waitForTimeout(300);
  assert((await page.locator('.toast').count()) === toasts, 'cancelling the sheet copies nothing and says nothing');
  await ctx.close();
});
await t('no page errors anywhere', async () => { assert(!errors.length, errors.slice(0, 5).join(' | ')); });

await browser.close(); await app2.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
