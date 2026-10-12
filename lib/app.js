// The Bitcoin Bull hub — application (routes + state). No framework.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { makeRpc, TBB_MINT } from './solana.js';
import { classifyUserText, checkName, stripInvisible, hasUrl, LINK_MSG } from './rules.js';
import { scoreMessage } from './modrules.js';
import { makeModeration } from './moderation.js';
import { makeFeeds, GENESIS } from './feeds.js';
import { send, readBody, parseCookies, sessionCookie, makeLimiter, randomId, hashToken, HttpError, bad, SECURITY_HEADERS, enableHsts } from './http.js';
import { buildAssets, serveAsset } from './assets.js';
import { makeAccessVerifier } from './access.js';
import { makeSettings } from './settings.js';
import { makeAdmin } from './admin.js';
import { hashSecret, verifySecret, dummyVerify, checkUsername, checkPassword, makeRecoveryCode, normalizeRecoveryCode, canonicalCode, makeThrottle, makePow } from './auth.js';
import { makeX } from './xauth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOMS = [
  { id: 'general', name: 'Main Chat', short: 'Main', blurb: 'General talk about TBB and Bitcoin.' },
  { id: 'builds', name: 'Crypto Builds', short: 'Builds', blurb: 'Show what you’re building on chain — tools, bots, contracts, sites.' },
];
const EMOJI = ['👍', '🐂', '🔥', '🧡', '😂'];
const SESSION_DAYS = 7;
const DAY = 86400_000;
const NEW_READ_ONLY_MS = 10 * 60_000;   // a new account reads for ten minutes before its first post
const NEW_SLOW_MS = DAY;                 // ... and posts at most once per 10 s for its first day
const IP_KEEP_MS = 7 * DAY;              // hashed IPs are kept this long, at most 10 per account
const SIGNUPS_PER_IP_PER_DAY = 3;

// Link wording for the right-hand Links box: third-party sites, described plainly, no calls to action.
export const LINK_WORDING = [
  ['https://tbbtimemachine.xyz', 'TBB Time Machine', 'Third-party tool: past purchases priced in sats.'],
  ['https://store.bitcoinhard.money', 'The book', 'Bitcoin Hard Money book store (third party).'],
  ['https://x.com/GoingParabolic', 'Creator on X', 'X profile (third party).'],
];
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const isLocalHost = (h) => /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1)(:\d+)?$/i.test(h);
// Outside links we store or show: https only, a real public host, no credentials, not too long.
export const safeUrl = (v) => {
  if (!v) return null; const s = String(v).trim();
  try { const u = new URL(s); if (u.protocol !== 'https:') throw 0; if (u.username || u.password) throw 0; if (/^(localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(u.hostname) || !u.hostname.includes('.')) throw 0; if (u.href.length > 400) throw 0; return u.href; } catch { throw bad('That link doesn’t look right (https:// links only).'); }
};

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  return {
    port, host: '127.0.0.1',
    // Behind a reverse proxy/CDN, the real visitor IP is in X-Forwarded-For. Set TRUST_PROXY=1 (number of proxies) only when there is one.
    trustProxy: Math.max(0, Math.min(3, Number(env.TRUST_PROXY || 0) | 0)), trustProxySet: env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== '',
    // Behind Cloudflare + cloudflared the real visitor IP is in one header (cf-connecting-ip). When set, that header wins
    // over X-Forwarded-For / TRUST_PROXY. Safe only because the app listens on loopback and the tunnel is the only way in.
    clientIpHeader: String(env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
    // Sign-up proof of work: leading zero bits of sha256 (16 ≈ 1–2 s on a phone). Lower it only for tests.
    powBits: Math.max(4, Math.min(24, Number(env.POW_BITS || 16) | 0)),
    // Sign in with X: all three must be set or no X button exists anywhere. Tokens are never stored; one paid call per sign-in.
    x: { clientId: String(env.X_CLIENT_ID || '').trim(), clientSecret: String(env.X_CLIENT_SECRET || '').trim(), redirectUri: String(env.X_REDIRECT_URI || '').trim(),
      dailyCap: Math.max(0, Number(env.X_LOGIN_DAILY_CAP || 500) | 0), apiBase: String(env.X_API_BASE || '').trim(), authUrl: String(env.X_AUTH_URL || '').trim() },
    publicOrigin: env.PUBLIC_ORIGIN || `http://localhost:${port}`,
    dbFile: env.DB_FILE || path.join(ROOT, 'data', 'hub.db'),
    // Public chain data is read through this RPC: the staking program's pool account and the token supply. Nothing is ever sent.
    rpcUrl: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    heliusKey: env.HELIUS_API_KEY || '',
    // The creator's Season 1 board (public JSON at /api/board). https only; we read totals, never addresses.
    seasonBoard: publicHttpsRoot(env.SEASON_BOARD_URL) || 'https://tbb-buyer-board.garden-equity-field-0042.workers.dev/',
    mempoolBase: env.MEMPOOL_BASE || 'https://mempool.space/api',
    lore: env.LORE_WORKER !== 'off',
    // Shown small at the bottom. Leave empty until the company exists: the page says "community-made page".
    operator: (env.OPERATOR_NAME || '').trim().slice(0, 80),
    // Launch switches. Off = the area shows "coming soon" to everyone.
    chatOpen: env.CHAT_OPEN === '1', // the chat rooms
    accountsOpen: env.ACCOUNTS_OPEN === '1', // sign-up / sign-in (and everything that needs an account: ideas, votes, inbox)
    sseMax: 2000, // live streams open at once, in all; a new one past that gets the same generic refusal as going too fast (tests lower it)
    helpNotesMax: 50_000, // connections remembered for the daily Help-note cap (oldest out past that; tests lower it)
    offline: env.OFFLINE === '1',
    // the admin panel: a separate hostname behind Cloudflare Access. Empty = no admin host at all.
    adminHost: String(env.ADMIN_HOST || '').trim().toLowerCase(),
    accessTeam: String(env.ACCESS_TEAM || '').trim(),
    adminAud: String(env.ADMIN_ACCESS_AUD || '').trim(),
    adminEmailSha256: String(env.ADMIN_EMAIL_SHA256 || '').trim().toLowerCase(),
  };
}

// Next Sunday 23:59:59 UTC, as epoch ms. (UTC on purpose: the site shouldn't hint at anyone's timezone.)
export function nextWeeklyClose(now = Date.now()) {
  const d = new Date(now);
  const daysAhead = (7 - d.getUTCDay()) % 7;
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead, 23, 59, 59);
  if (t <= now) t += 7 * 86400_000;
  return t;
}

export function createApp(overrides = {}) {
  const config = { ...loadConfig(overrides.env || process.env), ...overrides.config };
  const db = openDb(config.dbFile);
  if (db.get('SELECT COUNT(*) n FROM allies').n && db.get("SELECT v FROM kv WHERE k='allies_rev'")?.v !== '2') {
    db.run("UPDATE allies SET title='The book', blurb=? WHERE url='https://store.bitcoinhard.money'", 'Bitcoin: Hard Money You Can’t F*ck With, by Jason.');
    db.run("UPDATE allies SET blurb=? WHERE url='https://tbbtimemachine.xyz'", 'What if you’d paid in Bitcoin? Any purchase, in sats then and now.');
    db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','2')");
  }
  if (db.get('SELECT COUNT(*) n FROM allies').n && db.get("SELECT v FROM kv WHERE k='allies_rev'")?.v === '2') {
    for (const [url, title, blurb] of LINK_WORDING) db.run('UPDATE allies SET title=?, blurb=? WHERE url=?', title, blurb, url);
    db.run("UPDATE allies SET title='Solscan', url=?, blurb='Token details on a public block explorer.' WHERE url LIKE 'https://dexscreener.com/%'", `https://solscan.io/token/${TBB_MINT}`);
    db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','3')");
  }
  // rev 4: no Instagram links; any such link goes, wherever it came from.
  if (db.get('SELECT COUNT(*) n FROM allies').n && db.get("SELECT v FROM kv WHERE k='allies_rev'")?.v === '3') {
    db.run("DELETE FROM allies WHERE lower(url) LIKE '%instagram.com%'");
    db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','4')");
  }
  // Audit rev 1: cleared Help notes are deleted, and the audit log keeps only the note's id. Rows written before that
  // copied the first characters of the note into the log; strip them once, and drop notes cleared under the old flag.
  if (db.get("SELECT v FROM kv WHERE k='audit_rev'")?.v !== '1') {
    for (const r of db.all("SELECT id, before FROM admin_audit WHERE action='help:clear' AND before LIKE '%\"note\"%'")) {
      let id = null; try { id = JSON.parse(r.before)?.id ?? null; } catch { /* a truncated summary: keep the id only if it parses */ }
      db.run('UPDATE admin_audit SET before=? WHERE id=?', JSON.stringify(id === null ? {} : { id }), r.id);
    }
    db.run("DELETE FROM reports WHERE kind='problem' AND resolved=1");
    db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('audit_rev','1')");
  }
  // rev 5: the whitepaper is the creator's poster, shown on this site (#/learn/tbb); the outside page never had it.
  if (db.get('SELECT COUNT(*) n FROM allies').n && db.get("SELECT v FROM kv WHERE k='allies_rev'")?.v === '4') {
    db.run("DELETE FROM allies WHERE url='https://bitcoinhard.money/tbb'");
    db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','5')");
  }
  // rev 6: no link to the staking site (an outside site that asks to connect); the staked total stays as a number.
  if (db.get('SELECT COUNT(*) n FROM allies').n && db.get("SELECT v FROM kv WHERE k='allies_rev'")?.v === '5') {
    db.run("DELETE FROM allies WHERE lower(url) LIKE 'https://stakethebull.xyz%'");
    db.run("INSERT OR REPLACE INTO kv(k,v) VALUES('allies_rev','6')");
  }
  // A per-install secret: avatars and IP hashes can't be matched back to an account or an address.
  let secret = db.get("SELECT v FROM kv WHERE k='pseudonym_secret'")?.v;
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); db.run("INSERT INTO kv(k,v) VALUES('pseudonym_secret',?)", secret); }
  const pseudo = (s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
  const rpc = overrides.rpc || makeRpc(config.rpcUrl, { fetchImpl: overrides.fetchImpl });
  const allow = makeLimiter();
  const clients = new Set();
  const log = overrides.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const expectedDomain = new URL(config.publicOrigin).host;
  if (!isLocalOrigin(config.publicOrigin) && !config.publicOrigin.startsWith('https:')) throw new Error('PUBLIC_ORIGIN must be https:// on a public host.');
  // Public site = behind a proxy (we only listen on 127.0.0.1). Without TRUST_PROXY every visitor shares one rate limit.
  if (!isLocalOrigin(config.publicOrigin) && !config.trustProxySet && !config.clientIpHeader) throw new Error('Set CLIENT_IP_HEADER (cf-connecting-ip behind Cloudflare) or TRUST_PROXY (1 = one proxy in front; 2 = CDN + proxy). See .env.example.');
  const secureCookie = !isLocalOrigin(config.publicOrigin);
  // Hosts we answer to (stops DNS-rebinding tricks). Local dev answers on localhost and 127.0.0.1.
  const okHost = (h) => h === expectedDomain || (isLocalOrigin(config.publicOrigin) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h));
  const sseByIp = new Map();
  if (config.publicOrigin.startsWith('https:')) enableHsts();

  function sendTo(c, kind, data) {
    if (c.writableLength > 64 * 1024) { clients.delete(c); try { c.destroy(); } catch { /* gone */ } return; } // slow reader: drop it
    try { c.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ }
  }
  function emit(kind, data) { for (const c of clients) sendTo(c, kind, data); }
  const feeds = makeFeeds({ db, rpc, config, fetchImpl: overrides.fetchImpl || fetch, log, emit });
  const settings = makeSettings(db, { safeUrl });
  // Moderation (lib/moderation.js): hide / mute / kick / ban / undo, automatic escalation, community reports, the admin's queue.
  const mod = makeModeration({ db, msgView, emit, clients, sendTo });
  // Effective launch state. The server setting (.env) is the ceiling; the admin panel switch (settings.areas) is the
  // second gate. An area is open only when both say so, so nothing in a browser session can open what the server keeps shut.
  const areas = () => settings.get('areas');
  const live = { chat: () => config.chatOpen && areas().chat, accounts: () => config.accountsOpen && areas().accounts };
  const features = () => ({ chat: live.chat(), accounts: live.accounts(), ideas: live.accounts() });
  const story = () => ({ title: settings.get('story_title'), body: settings.get('story_body') });
  // What every open page needs when the admin flips a switch or edits the story: pushed over the live stream, no reload.
  const settingsView = () => ({ features: features(), banner: settings.get('banner').on ? { text: settings.get('banner').text, tone: settings.get('banner').tone } : null, sections: settings.get('sections'), story: story() });
  const startedAt = Date.now();

  // ---------- helpers ----------
  const now = () => Date.now();
  // Account ids are "u_…". No account is an admin: administration happens on the admin host behind Cloudflare Access
  // (lib/admin.js), which has no account at all.
  const userRow = (uid) => db.get('SELECT * FROM users WHERE uid=?', uid);
  const byUsername = (u) => (typeof u === 'string' && u ? db.get('SELECT * FROM users WHERE lower(username)=lower(?)', u) : null);
  const nameOf = (uid) => { if (uid === 'herd') return 'The Herd'; const r = userRow(uid); return r?.name || r?.username || 'Member'; };
  const author = (uid) => { if (uid === 'herd') return { name: 'The Herd', herd: true, avatar: 'herd' }; const r = userRow(uid); return { name: nameOf(uid), avatar: pseudo('av:' + uid).slice(0, 16), ...(r?.x_handle ? { x: r.x_handle } : {}) }; };
  const isBanned = (u) => !!u && !!u.banned && (!u.ban_until || u.ban_until > now());
  // ---- visitor IPs: never stored or logged; a keyed hash (HMAC with the per-install secret, IPv6 as /48) is kept for
  // 7 days of sign-ins and posts (max 10 per account) so a banned spammer's connection can be refused for a while.
  const ipHash = (ip) => pseudo('ip:' + ip);
  function logIp(uid, ip, kind) {
    if (!uid || !ip || ip === '?') return;
    const h = ipHash(ip); const t = now();
    db.run('DELETE FROM ip_log WHERE at<?', t - IP_KEEP_MS);
    db.run('INSERT INTO ip_log(uid,ip_hash,kind,at) VALUES(?,?,?,?)', uid, h, kind, t);
    db.run('DELETE FROM ip_log WHERE uid=? AND id NOT IN (SELECT id FROM ip_log WHERE uid=? ORDER BY id DESC LIMIT 10)', uid, uid);
  }
  // A read only (it runs on every write request): expired rows are pruned by the housekeeping timer, not here.
  const ipBanned = (ip) => !!db.get('SELECT 1 FROM ip_bans WHERE ip_hash=? AND until>?', ipHash(ip), now());
  const signupsFrom = (ip) => db.get("SELECT COUNT(*) n FROM ip_log WHERE ip_hash=? AND kind='signup' AND at>?", ipHash(ip), now() - DAY).n;
  // Anonymous Help notes per day (memory only, nothing stored): the one unauthenticated write. 20 per connection (IPv6 by
  // /48) and 40 per IPv4 /24, so a few neighbouring addresses can't fill the inbox. The maps hold keyed hashes, never an
  // address: an entry lives a day at most (helpPurge, every ten minutes) and the maps have a hard ceiling
  // (config.helpNotesMax): past it the oldest entry goes, so a flood of addresses can't grow memory.
  const HELP_NOTES_PER_DAY = 20; const HELP_NOTES_PER_BLOCK = 40; const HELP_PURGE_MS = 10 * 60_000;
  const helpNotes = new Map(); const helpBlocks = new Map();
  const helpBlockOf = (ip) => (ip.includes(':') ? null : ipHash('net:' + ip.replace(/\.\d+$/, '.0/24'))); // IPv6 is a /48 already
  const countOf = (map, key) => { const e = key && map.get(key); return e && now() - e.at < DAY ? e.n : 0; };
  const helpNotesCapped = (ip) => Math.max(countOf(helpNotes, ipHash(ip)) / HELP_NOTES_PER_DAY, countOf(helpBlocks, helpBlockOf(ip)) / HELP_NOTES_PER_BLOCK) >= 1;
  const bump = (map, key) => {
    if (!key) return;
    const e = map.get(key);
    if (e && now() - e.at < DAY) { e.n++; return; }
    map.delete(key); // re-insert at the end: the order of the map is the order of eviction
    while (map.size >= config.helpNotesMax) map.delete(map.keys().next().value);
    map.set(key, { at: now(), n: 1 });
  };
  const helpNotesCount = (ip) => { bump(helpNotes, ipHash(ip)); bump(helpBlocks, helpBlockOf(ip)); };
  const helpPurge = () => { for (const map of [helpNotes, helpBlocks]) for (const [k, e] of map) if (now() - e.at >= DAY - HELP_PURGE_MS) map.delete(k); };
  const helpTimer = setInterval(helpPurge, HELP_PURGE_MS); helpTimer.unref?.();
  // ---- sign-in throttles (memory) and the sign-up proof of work
  const throttle = makeThrottle();
  const pow = makePow({ bits: config.powBits });
  const tooMany = (secs) => { const e = bad(`Too many attempts. Try again in ${secs < 60 ? secs + ' s' : Math.ceil(secs / 60) + ' min'}.`, 429); e.code = 'throttled'; return e; };
  const throttled = (...keys) => { const w = Math.max(...keys.map((k) => throttle.wait(k))); if (w > 0) throw tooMany(w); };

  function event(kind, text, link) {
    db.run('INSERT INTO events(kind,text,link,created_at) VALUES(?,?,?,?)', kind, text, link || null, now());
    if (kindOpen(kind)) emit('alert', { kind, text, link });
  }
  function kindOpen(k) {
    return !({ idea: !live.accounts(), vote: !live.accounts(), message: !live.chat() })[k];
  }
  function notify(uid, kind, text, link) {
    if (!uid || uid === 'herd') return;
    db.run('INSERT INTO inbox(uid,kind,text,link,created_at) VALUES(?,?,?,?,?)', uid, kind, text, link || null, now());
    // Tell only that account's open streams; broadcasting told every visitor when private activity happened.
    for (const c of clients) if (c.uid === uid) sendTo(c, 'inbox', {});
  }

  function session(req) {
    const tok = parseCookies(req.headers.cookie).tbb_s;
    if (!tok || tok.length > 100) return null;
    const s = db.get('SELECT * FROM sessions WHERE id=?', hashToken(tok));
    if (!s || s.expires_at < now()) return null;
    const u = userRow(s.uid);
    if (u?.banned && u.ban_until && u.ban_until <= now()) { db.run('UPDATE users SET banned=0, ban_until=0 WHERE uid=?', u.uid); u.banned = 0; u.ban_until = 0; }
    if (!u || isBanned(u)) return null;
    return u;
  }
  // A fresh session (the old one, if any, ends: rotation on every sign-in). Returns the cookie value.
  function startSession(req, res, uid) {
    const old = parseCookies(req.headers.cookie).tbb_s;
    if (old && old.length <= 100) db.run('DELETE FROM sessions WHERE id=?', hashToken(old));
    const tok = randomId(32);
    db.run('INSERT INTO sessions(id,uid,created_at,expires_at) VALUES(?,?,?,?)', hashToken(tok), uid, now(), now() + SESSION_DAYS * DAY);
    db.run('DELETE FROM sessions WHERE expires_at < ?', now());
    db.run('DELETE FROM sessions WHERE uid=? AND id NOT IN (SELECT id FROM sessions WHERE uid=? ORDER BY created_at DESC LIMIT 10)', uid, uid);
    res.setHeader('Set-Cookie', sessionCookie(tok, { secure: secureCookie, maxAge: SESSION_DAYS * 86400 }));
    return tok;
  }
  const endOtherSessions = (req, uid) => { const tok = parseCookies(req.headers.cookie).tbb_s; db.run('DELETE FROM sessions WHERE uid=? AND id<>?', uid, tok ? hashToken(tok) : ''); };
  function need(user) { if (!user) throw bad('Sign in first.', 401); if (!user.name) throw bad('Pick a display name first.', 403); return user; }
  function limit(key, perMin, burst) { if (!allow(key, perMin, burst)) throw bad('Slow down a little.', 429); }
  const str = (v, max, field) => { const s = typeof v === 'string' ? v.trim() : ''; if (!s) throw bad(`${field} is required.`); if (s.length > max) throw bad(`${field} is too long (max ${max}).`); return s; };
  // Zero links, no addresses or keys, no doxxing shapes, for everything users type. A refusal counts as a rule hit
  // (3 in 24 h = 1 h mute, more = 24 h mute + the admin's queue; lib/moderation.js).
  const textCheck = (t, user) => {
    const problem = classifyUserText(t);
    if (!problem) return;
    if (user?.uid && problem.kind !== 'empty') mod.recordHit(user.uid, problem.kind);
    throw bad(problem.error, 422);
  };
  const remaining = (until) => { const m = Math.max(1, Math.ceil((until - now()) / 60_000)); return m < 60 ? `${m} min` : m <= 1440 ? `${Math.ceil(m / 60)} h` : `${Math.ceil(m / 1440)} d`; };
  // May this person post right now? Banned accounts have no session; muted ones can read but not write; everyone confirms 18+ once.
  function canPost(u) {
    if (isBanned(u)) throw bad('This account can’t post here.', 403);
    const st = mod.status(u);
    if (st.muted) throw bad(`You’re muted for another ${remaining(st.until)}. You can still read.`, 403);
    if (!u.adult_confirmed_at) { const e = bad('Please confirm you are 18 or older first.', 403); e.code = 'adult'; throw e; }
    // slow start: a brand-new account reads first
    if (now() - u.created_at < NEW_READ_ONLY_MS) { const e = bad(`New accounts can read for the first 10 minutes. Posting opens in ${remaining(u.created_at + NEW_READ_ONLY_MS)}.`, 403); e.code = 'new'; throw e; }
  }
  const isNew = (u) => now() - u.created_at < NEW_SLOW_MS;

  // ---------- views of rows ----------
  function msgView(m, viewer) {
    const reacts = db.all('SELECT emoji, COUNT(*) n, SUM(uid=?) mine FROM reactions WHERE message_id=? GROUP BY emoji', viewer || '', m.id);
    const reply = m.reply_to ? db.get('SELECT id, uid, body, deleted, hidden FROM messages WHERE id=?', m.reply_to) : null;
    return {
      // a held message (waiting for the admin) shows to its author only; everyone else sees it as hidden
      id: m.id, room: m.room, body: m.deleted ? '' : m.hidden && !(m.held && viewer && viewer === m.uid) ? '' : m.body, deleted: !!m.deleted, hidden: !!m.hidden, held: !!m.held,
      at: m.created_at, edited: !!m.edited_at, author: author(m.uid), mine: viewer === m.uid,
      reactions: EMOJI.map((e) => { const r = reacts.find((x) => x.emoji === e); return { e, n: r ? r.n : 0, mine: !!(r && r.mine) }; }),
      reply: reply ? { id: reply.id, name: nameOf(reply.uid), body: reply.deleted || reply.hidden ? '' : reply.body.slice(0, 120) } : null,
    };
  }
  function ideaView(i, viewer) {
    const votes = db.get('SELECT COUNT(*) n FROM votes WHERE idea_id=?', i.id).n;
    const mine = viewer ? !!db.get('SELECT 1 FROM votes WHERE idea_id=? AND uid=?', i.id, viewer) : false;
    return { id: i.id, title: i.title, body: i.body, at: i.created_at, author: author(i.uid), votes, voted: mine, mine: viewer === i.uid };
  }

  function alerts() {
    const out = [];
    const close = nextWeeklyClose();
    const days = Math.ceil((close - now()) / 86400_000);
    if (live.accounts() && db.get('SELECT COUNT(*) n FROM ideas WHERE hidden=0').n > 0) {
      out.push({ kind: 'vote', text: days <= 1 ? 'Vote closes tonight' : `Vote closes in ${days} days`, link: '#/build' });
    }
    const hide = new Set([...(live.accounts() ? [] : ['idea', 'vote']), ...(live.chat() ? [] : ['message'])]);
    for (const e of db.all('SELECT kind,text,link FROM events WHERE created_at > ? ORDER BY id DESC LIMIT 12', now() - 7 * 86400_000)) if (!hide.has(e.kind) && out.length < 9) out.push(e);
    return out;
  }

  // The numbers as the feed timer last left them (lib/feeds.js start()): a request reads the cache and never asks an
  // outside service, so an answer is instant and no refresh time tells when anyone else was here.
  async function stats() {
    const m = feeds.fresh('market'); const h = feeds.fresh('holders'); const s = feeds.fresh('staked'); const se = feeds.fresh('season'); const b = feeds.fresh('btc');
    return {
      price: m?.priceUsd ?? null, change24h: m?.change24h ?? null, marketCap: m?.marketCap ?? null, fdv: m?.fdv ?? null, btcUsd: b?.usd ?? null, // the page shows the TBB price in sats with the BTC price
      holders: h?.count ?? null, staked: s ? { pct: s.pct, amount: s.amount, change24h: s.change24h ?? null, change7d: s.change7d ?? null, stakes: s.stakes ?? null } : null,
      season: se, btcHeight: feeds.lore.tip, at: tenSeconds(now()), feeds: feedAges(),
    };
  }
  // When each number was last refreshed and how often it refreshes, so the page can say "updated 2m ago" honestly.
  // Times are quantised to ten seconds: enough for "2m ago", nothing finer.
  const tenSeconds = (t) => (t ? Math.floor(t / 10_000) * 10_000 : t);
  function feedAges() {
    const st = feeds.status(); const out = {};
    for (const k of ['market', 'holders', 'staked', 'season', 'chart', 'lore']) { const m = st[k]; out[k] = { at: tenSeconds(m?.okAt ?? null), ttl: m?.ttl ?? ({ market: 60_000, holders: 15 * 60_000, staked: 5 * 60_000, season: 60_000, chart: 10 * 60_000, lore: 60_000 })[k] }; }
    return out;
  }
  // Keep every open page current: while anyone is connected, re-read the feeds every 30 s (which refreshes any that
  // went stale) and push the numbers over the live stream when they changed.
  let lastPushed = '';
  const pushTimer = setInterval(() => {
    if (!clients.size || config.offline) return;
    stats().then((st) => { const key = JSON.stringify({ ...st, at: 0 }); if (key !== lastPushed) { lastPushed = key; emit('stats', st); } }).catch(() => {});
  }, 30_000); pushTimer.unref?.();
  // Housekeeping at start and every six hours: expired connection bans out; hashed IPs past 7 days, rule hits past 30
  // days and expired sessions out (the writes that used to prune them stop while the areas are closed, the promise does
  // not); old pending lore candidates out, approved rows capped (lib/feeds.js prune()); the Help-note maps purged (their
  // own timer does that every ten minutes as well).
  const housekeeping = () => {
    db.run('DELETE FROM ip_bans WHERE until<=?', now()); db.run('DELETE FROM ip_log WHERE at<?', now() - IP_KEEP_MS); db.run('DELETE FROM mod_hits WHERE at<?', now() - 30 * DAY); db.run('DELETE FROM sessions WHERE expires_at<?', now());
    helpPurge(); try { feeds.lore.prune(); } catch (e) { log('lore prune', e.message); }
  };
  const pruneTimer = setInterval(housekeeping, 6 * 3600_000); pruneTimer.unref?.();

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, pattern, re, keys, handler, opts });
  };

  route('GET', '/api/state', async (req, u) => ({
    me: u ? { name: u.name, username: u.username || null, x: u.x_handle || null, hasPassword: !!u.pass_hash,
      unread: db.get('SELECT COUNT(*) n FROM inbox WHERE uid=? AND read=0', u.uid).n, adult: !!u.adult_confirmed_at, muted: u.muted_until > now() ? u.muted_until : null,
      newUntil: now() - u.created_at < NEW_READ_ONLY_MS ? u.created_at + NEW_READ_ONLY_MS : null } : null,
    stats: await stats(), alerts: alerts(), lore: feeds.lore.pick(), genesis: GENESIS,
    features: features(),
    x: xauth.enabled(), // Sign in with X: configured and under today's cap
    operator: config.operator || null,
    banner: settings.get('banner').on ? { text: settings.get('banner').text, tone: settings.get('banner').tone } : null,
    sections: settings.get('sections'), story: story(),
    rooms: ROOMS.map((r) => ({ id: r.id, name: r.name, short: r.short, blurb: r.blurb })),
  }));

  route('GET', '/api/lore', async (req, u, body, ip, res, p, q) => {
    // ?n=: a batch of up to 30 lines the page rotates through by itself, refilled every 15 minutes. The batch is shared
    // for a minute (lib/feeds.js shared()), and the route has a budget of its own, far under the general one.
    if (q.has('n')) { limit('lore:' + ip, 60, 20); const n = Math.min(30, Math.max(1, Number(q.get('n')) | 0)); return { lines: feeds.lore.shared(n), count: feeds.lore.count() }; }
    return { lore: feeds.lore.pick(), count: feeds.lore.count() };
  });

  // 24 hours of hourly closes for the home chart. Never blocks the page; empty when the source is down.
  route('GET', '/api/chart', async () => ({ points: feeds.fresh('chart') || [] }), { cache: 'etag' });

  // ---- username + password accounts (the way in; no e-mail, no phone, no real name)
  route('GET', '/api/auth/pow', async (req, u, body, ip) => { limit('pow:' + ip, 20, 10); return pow.issue(); });
  route('POST', '/api/auth/signup', async (req, u, body, ip, res) => {
    limit('signup:' + ip, 15, 15);
    if (body.adult !== true) throw bad('Confirm that you are 18 or older.', 422);
    const username = String(body.username || '').trim();
    const uErr = checkUsername(username); if (uErr) throw bad(uErr, 422);
    const pErr = checkPassword(body.password, username); if (pErr) throw bad(pErr, 422);
    const pw = pow.verify(body.pow?.id, body.pow?.nonce);
    if (!pw.ok) throw bad(pw.reason === 'wrong' || pw.reason === 'bad nonce' ? 'The browser check didn’t pass. Try again.' : 'The browser check expired. Try again.', 422);
    if (db.get('SELECT 1 FROM users WHERE lower(username)=lower(?) OR lower(name)=lower(?)', username, username)) throw bad('Someone already has that username.', 409);
    if (signupsFrom(ip) >= SIGNUPS_PER_IP_PER_DAY) throw bad('Too many new accounts from this connection today. Try again tomorrow.', 429);
    const uid = 'u_' + randomId(15).replace(/[^A-Za-z0-9]/g, 'x');
    const code = makeRecoveryCode();
    const [passHash, codeHash] = await Promise.all([hashSecret(body.password), hashSecret(canonicalCode(code))]);
    db.run("INSERT INTO users(uid,name,username,pass_hash,recovery_hash,pass_changed_at,created_at,adult_confirmed_at,via) VALUES(?,?,?,?,?,?,?,?,'password')", uid, username, username, passHash, codeHash, now(), now(), now());
    logIp(uid, ip, 'signup'); logIp(uid, ip, 'signin');
    startSession(req, res, uid);
    return { ok: true, username, recovery: code, newUntil: now() + NEW_READ_ONLY_MS };
  });
  const SIGNIN_FAIL = 'Wrong username or password.';
  route('POST', '/api/auth/login', async (req, u, body, ip, res) => {
    limit('login:' + ip, 40, 20);
    const username = String(body.username || '').trim().slice(0, 40); const password = typeof body.password === 'string' ? body.password : '';
    const ipKey = 'ip:' + ipHash(ip); const acctKey = 'acct:' + username.toLowerCase();
    throttled(ipKey, acctKey);
    const user = byUsername(username);
    if (user?.lock_until > now()) throw tooMany(Math.ceil((user.lock_until - now()) / 1000));
    // the same work and the same message whether or not the username exists
    const ok = user?.pass_hash ? await verifySecret(password, user.pass_hash) : await dummyVerify(password);
    if (!ok) {
      throttle.fail(ipKey); const fails = throttle.fail(acctKey);
      // Ten failures: a 15-minute cool-down on the name. A real account also gets it in the database (it survives a restart);
      // a username that does not exist gets the same wait in memory, so the cool-down can't be used to tell the two apart.
      if (user) { const n = user.fail_count + 1; if (n >= 10) { db.run('UPDATE users SET fail_count=0, lock_until=? WHERE uid=?', now() + 15 * 60_000, user.uid); throttle.lock(acctKey, 15 * 60_000); } else db.run('UPDATE users SET fail_count=? WHERE uid=?', n, user.uid); }
      else if (fails % 10 === 0) throttle.lock(acctKey, 15 * 60_000);
      throw bad(SIGNIN_FAIL, 401);
    }
    if (isBanned(user)) throw bad('This account can’t sign in here.', 403);
    throttle.clear(ipKey); throttle.clear(acctKey);
    if (user.fail_count) db.run('UPDATE users SET fail_count=0 WHERE uid=?', user.uid);
    startSession(req, res, user.uid); logIp(user.uid, ip, 'signin');
    return { ok: true, username: user.username, needsName: !user.name };
  });
  // Recovery code + new password = a reset. The only reset path there is (no e-mail exists). Issues a fresh code.
  route('POST', '/api/auth/recover', async (req, u, body, ip, res) => {
    limit('recover:' + ip, 10, 5);
    const username = String(body.username || '').trim().slice(0, 40);
    const ipKey = 'ip:' + ipHash(ip); const acctKey = 'rec:' + username.toLowerCase();
    throttled(ipKey, acctKey);
    const user = byUsername(username); const code = normalizeRecoveryCode(body.code);
    const ok = user?.recovery_hash && code ? await verifySecret(code, user.recovery_hash) : await dummyVerify(String(body.code || ''));
    if (!ok) { throttle.fail(ipKey); throttle.fail(acctKey); throw bad('That username and recovery code don’t match.', 401); }
    const pErr = checkPassword(body.password, username); if (pErr) throw bad(pErr, 422);
    if (isBanned(user)) throw bad('This account can’t sign in here.', 403);
    const fresh = makeRecoveryCode();
    const [passHash, codeHash] = await Promise.all([hashSecret(body.password), hashSecret(canonicalCode(fresh))]);
    db.run('UPDATE users SET pass_hash=?, recovery_hash=?, pass_changed_at=?, fail_count=0, lock_until=0 WHERE uid=?', passHash, codeHash, now(), user.uid);
    db.run('DELETE FROM sessions WHERE uid=?', user.uid); // every other browser is signed out
    throttle.clear(ipKey); throttle.clear(acctKey);
    startSession(req, res, user.uid); logIp(user.uid, ip, 'signin');
    return { ok: true, username: user.username, recovery: fresh };
  });
  // Change the password (needs the current one). Other sessions end.
  route('POST', '/api/me/password', async (req, u, body) => {
    if (!u) throw bad('Sign in first.', 401);
    if (!u.pass_hash) throw bad('This account has no password yet. Set a username and password first.', 400);
    limit('chpw:' + u.uid, 6, 3);
    if (!(await verifySecret(typeof body.current === 'string' ? body.current : '', u.pass_hash))) throw bad('The current password is wrong.', 401);
    const pErr = checkPassword(body.password, u.username); if (pErr) throw bad(pErr, 422);
    db.run('UPDATE users SET pass_hash=?, pass_changed_at=? WHERE uid=?', await hashSecret(body.password), now(), u.uid);
    endOtherSessions(req, u.uid);
    return { ok: true };
  });
  // An account made by X sign-in (or one from an older install) sets its username and password once; gets its recovery code.
  route('POST', '/api/me/credentials', async (req, u, body) => {
    if (!u) throw bad('Sign in first.', 401);
    if (u.pass_hash) throw bad('This account already has a password. Use “Change password”.', 400);
    limit('cred:' + u.uid, 6, 3);
    const username = u.username || String(body.username || '').trim();
    const uErr = checkUsername(username); if (uErr) throw bad(uErr, 422);
    const pErr = checkPassword(body.password, username); if (pErr) throw bad(pErr, 422);
    if (!u.username && db.get('SELECT 1 FROM users WHERE (lower(username)=lower(?) OR lower(name)=lower(?)) AND uid<>?', username, username, u.uid)) throw bad('Someone already has that username.', 409);
    const code = makeRecoveryCode();
    const [passHash, codeHash] = await Promise.all([hashSecret(body.password), hashSecret(canonicalCode(code))]);
    db.run('UPDATE users SET username=?, name=COALESCE(name,?), pass_hash=?, recovery_hash=?, pass_changed_at=? WHERE uid=?', username, username, passHash, codeHash, now(), u.uid);
    endOtherSessions(req, u.uid);
    return { ok: true, username, recovery: code };
  });
  // Sign in with X: the welcome step after X sent the person back (lib/xauth.js). 404 unless configured.
  route('GET', '/api/auth/x/pending', async (req) => xauth.api.pending(req));
  route('POST', '/api/auth/x/finish', async (req, u, body, ip, res) => { limit('xfinish:' + ip, 10, 5); return xauth.api.finish(req, res, body, ip); });
  route('POST', '/api/me/x/unlink', async (req, u) => xauth.api.unlink(u));

  route('POST', '/api/auth/logout', async (req, u, body, ip, res) => {
    const tok = parseCookies(req.headers.cookie).tbb_s;
    if (tok) db.run('DELETE FROM sessions WHERE id=?', hashToken(tok));
    if (u && body.everywhere) db.run('DELETE FROM sessions WHERE uid=?', u.uid);
    res.setHeader('Set-Cookie', sessionCookie('', { secure: secureCookie, maxAge: 0 }));
    return { ok: true };
  });

  route('POST', '/api/me/name', async (req, u, body) => {
    if (!u) throw bad('Sign in first.', 401);
    limit('name:' + u.uid, 6, 3);
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    const err = checkName(name); if (err) throw bad(err, 422);
    const taken = db.get('SELECT uid FROM users WHERE (lower(name)=lower(?) OR lower(username)=lower(?)) AND uid<>?', name, name, u.uid);
    if (taken) throw bad('Someone already has that name.', 409);
    db.run('UPDATE users SET name=? WHERE uid=?', name, u.uid);
    return { ok: true, name };
  });
  // The 18+ confirmation, remembered on the account (the page also remembers it in the browser). Posting is refused without it.
  route('POST', '/api/me/adult', async (req, u, body) => {
    if (!u) throw bad('Sign in first.', 401);
    if (body.confirm !== true) throw bad('Confirm that you are 18 or older.');
    if (!u.adult_confirmed_at) db.run('UPDATE users SET adult_confirmed_at=? WHERE uid=?', now(), u.uid);
    return { ok: true };
  });

  // ---- chat
  function roomOf(room) { const r = ROOMS.find((x) => x.id === room); if (!r) throw bad('No such room.', 404); return r; }
  route('GET', '/api/rooms/:room/messages', async (req, u, body, ip, res, p, q) => {
    roomOf(p.room);
    const before = Number(q.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db.all('SELECT * FROM messages WHERE room=? AND id<? ORDER BY id DESC LIMIT 60', p.room, before).reverse();
    return { room: p.room, messages: rows.map((m) => msgView(m, u?.uid)) };
  });
  route('POST', '/api/rooms/:room/messages', async (req, u, body, ip, res, p) => {
    need(u); roomOf(p.room);
    limit('chat:' + u.uid, 30, 1 + 1); // ~one every 2s
    canPost(u);
    if (isNew(u)) limit('chat:new:' + u.uid, 6, 1); // first day: one message per 10 s
    logIp(u.uid, ip, 'post');
    // Text only. Anything else in the body (an image, a file, an attachment field) is ignored; a pasted data: URL is a link and refused.
    const text = stripInvisible(str(body.body, 500, 'Message')).trim(); if (!text) throw bad('Say something first.');
    textCheck(text, u);
    // The scam filter (lib/modrules.js): reject = refused with a message and a rule hit; hold = stored hidden for the admin, never broadcast.
    const verdict = scoreMessage(text, { name: u.name, recent: db.all('SELECT body, created_at at FROM messages WHERE uid=? ORDER BY id DESC LIMIT 8', u.uid).reverse() });
    if (verdict.outcome === 'reject') { mod.recordHit(u.uid, verdict.kind); throw bad(verdict.error, 422); }
    const reply = Number(body.reply_to) || null;
    if (reply && !db.get('SELECT 1 FROM messages WHERE id=? AND room=?', reply, p.room)) throw bad('That message is gone.');
    const r = db.run('INSERT INTO messages(room,uid,body,reply_to,created_at) VALUES(?,?,?,?,?)', p.room, u.uid, text, reply, now());
    if (verdict.outcome === 'hold') {
      mod.hold(r.lastInsertRowid, { actor: 'auto', reason: `scam filter: ${verdict.reasons.join(', ')}` });
      return { message: msgView(db.get('SELECT * FROM messages WHERE id=?', r.lastInsertRowid), u.uid), held: true, notice: verdict.error };
    }
    const m = msgView(db.get('SELECT * FROM messages WHERE id=?', r.lastInsertRowid), null);
    if (reply) { const orig = db.get('SELECT uid FROM messages WHERE id=?', reply); if (orig && orig.uid !== u.uid) notify(orig.uid, 'reply', `${u.name} replied to you in ${roomOf(p.room).name}`, `#/chat/${p.room}`); }
    if (live.chat()) emit('message', m); // closed: no broadcast
    return { message: m };
  });
  route('PATCH', '/api/messages/:id', async (req, u, body, ip, res, p) => {
    need(u); limit('edit:' + u.uid, 20, 5); // every edit reaches every open page; no one account gets to flood them
    const m = db.get('SELECT * FROM messages WHERE id=?', Number(p.id));
    if (!m || m.uid !== u.uid || m.deleted) throw bad('Can’t edit that.', 403);
    if (now() - m.created_at > 5 * 60_000) throw bad('Edits close after 5 minutes.', 403);
    canPost(u);
    const text = stripInvisible(str(body.body, 500, 'Message')).trim(); if (!text) throw bad('Say something first.');
    textCheck(text, u);
    const verdict = scoreMessage(text, { name: u.name, recent: db.all('SELECT body, created_at at FROM messages WHERE uid=? AND id<>? ORDER BY id DESC LIMIT 8', u.uid, m.id).reverse() });
    if (verdict.outcome === 'reject' && !['repeat', 'flood'].includes(verdict.kind)) { mod.recordHit(u.uid, verdict.kind); throw bad(verdict.error, 422); }
    db.run('UPDATE messages SET body=?, edited_at=? WHERE id=?', text, now(), m.id);
    if (verdict.outcome === 'hold') mod.hold(m.id, { actor: 'auto', reason: `scam filter (edit): ${verdict.reasons.join(', ')}` });
    const v = msgView(db.get('SELECT * FROM messages WHERE id=?', m.id), null);
    if (live.chat()) emit('message:update', v);
    return { message: v };
  });
  route('DELETE', '/api/messages/:id', async (req, u, body, ip, res, p) => {
    need(u); limit('del:' + u.uid, 30, 10);
    const m = db.get('SELECT * FROM messages WHERE id=?', Number(p.id));
    if (!m) throw bad('Gone already.', 404);
    if (m.uid !== u.uid) throw bad('Not yours.', 403); // someone else's message is moderation: the panel, with a reason and an undo
    if (m.deleted) return { ok: true }; // nothing changed: nothing to tell the room again
    db.run('UPDATE messages SET deleted=1 WHERE id=?', m.id);
    if (live.chat()) emit('message:update', msgView(db.get('SELECT * FROM messages WHERE id=?', m.id), null));
    return { ok: true };
  });
  route('POST', '/api/messages/:id/react', async (req, u, body, ip, res, p) => {
    need(u); limit('react:' + u.uid, 60, 10);
    const m = db.get('SELECT * FROM messages WHERE id=?', Number(p.id)); if (!m || m.deleted || m.hidden) throw bad('Gone.', 404);
    roomOf(m.room);
    if (!EMOJI.includes(body.emoji)) throw bad('Unknown reaction.');
    const has = db.get('SELECT 1 FROM reactions WHERE message_id=? AND uid=? AND emoji=?', m.id, u.uid, body.emoji);
    if (has) db.run('DELETE FROM reactions WHERE message_id=? AND uid=? AND emoji=?', m.id, u.uid, body.emoji);
    else db.run('INSERT INTO reactions(message_id,uid,emoji) VALUES(?,?,?)', m.id, u.uid, body.emoji);
    const v = msgView(m, null);
    if (live.chat()) emit('message:update', v);
    return { message: msgView(m, u.uid) };
  });
  route('POST', '/api/report', async (req, u, body, ip) => {
    limit('report:' + (u?.uid || ip), 10, 5);
    const kind = ['message', 'idea', 'problem'].includes(body.kind) ? body.kind : null;
    if (!kind) throw bad('Unknown report.');
    if (kind !== 'problem') need(u);
    const areaOf = { message: live.chat(), idea: live.accounts() };
    if (kind !== 'problem' && !areaOf[kind]) throw bad('That area isn’t open yet.', 503);
    const reason = stripInvisible(str(body.reason, 1000, 'Reason'));
    // a Help note is zero-link like everything typed on the site (a report on a thing may quote the scam it reports)
    if (kind === 'problem' && hasUrl(reason)) throw bad(LINK_MSG, 422);
    if (kind === 'problem' && !u) {
      // the one unauthenticated write: 20 notes a day per connection (IPv6 by /48), 40 per IPv4 /24; a full inbox (500
      // open notes) refuses the new note rather than dropping an older one, so no flood can push a note out before the
      // admin has read it. The full-inbox refusal is the same answer as any other limit: a different wording would tell a
      // visitor whether the admin has been reading and clearing notes.
      if (helpNotesCapped(ip)) throw bad('That’s enough notes for today from this connection. Try again tomorrow.', 429);
      if (db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem'").n >= 500) throw bad('Slow down a little.', 429);
      helpNotesCount(ip);
    }
    const target = String(body.target ?? '').slice(0, 40);
    // one report per person per thing (a free-text "problem" note is not a report on a thing: every note is kept)
    if (u && kind !== 'problem' && db.get('SELECT 1 FROM reports WHERE kind=? AND target=? AND uid=?', kind, target, u.uid)) return { ok: true };
    db.run('INSERT INTO reports(kind,target,uid,reason,created_at) VALUES(?,?,?,?,?)', kind, target, u?.uid || null, reason, now());
    // Community rules (no AI needed): enough reports from established accounts hide the message / mute the person, pending the admin.
    const auto = mod.onReport(kind, target, u?.uid) || {};
    return { ok: true, ...auto };
  });

  // ---- build: ideas and votes
  route('GET', '/api/ideas', async (req, u, body, ip, res, p, q) => {
    const sort = q.get('sort') || 'hot';
    const rows = db.all('SELECT * FROM ideas WHERE hidden=0 ORDER BY id DESC LIMIT 200').map((i) => ideaView(i, u?.uid));
    const age = (i) => (now() - i.at) / 3600_000;
    if (sort === 'top') rows.sort((a, b) => b.votes - a.votes || b.at - a.at);
    else if (sort === 'hot') rows.sort((a, b) => (b.votes + 1) / Math.pow(age(b) + 2, 1.5) - (a.votes + 1) / Math.pow(age(a) + 2, 1.5));
    return { ideas: rows, closes: nextWeeklyClose() };
  });
  route('POST', '/api/ideas', async (req, u, body) => {
    need(u); limit('idea:' + u.uid, 2, 3); canPost(u);
    const title = str(body.title, 80, 'Title'); const text = str(body.body, 1000, 'Description');
    textCheck(title + ' ' + text, u);
    const r = db.run('INSERT INTO ideas(uid,title,body,created_at) VALUES(?,?,?,?)', u.uid, title, text, now());
    event('idea', `New idea: ${title}`, `#/build/idea/${r.lastInsertRowid}`);
    return { idea: ideaView(db.get('SELECT * FROM ideas WHERE id=?', r.lastInsertRowid), u.uid) };
  });
  route('POST', '/api/ideas/:id/vote', async (req, u, body, ip, res, p) => {
    need(u); limit('vote:' + u.uid, 60, 20); canPost(u);
    const i = db.get('SELECT * FROM ideas WHERE id=? AND hidden=0', Number(p.id)); if (!i) throw bad('No such idea.', 404);
    if (i.uid === u.uid) throw bad('You can’t vote for your own idea.');
    const has = db.get('SELECT 1 FROM votes WHERE idea_id=? AND uid=?', i.id, u.uid);
    if (has) db.run('DELETE FROM votes WHERE idea_id=? AND uid=?', i.id, u.uid);
    else {
      db.run('INSERT INTO votes(idea_id,uid,created_at) VALUES(?,?,?)', i.id, u.uid, now());
      const k = `voted:${pseudo(i.id + ':' + u.uid).slice(0, 24)}`; // notify once per voter per idea, however often they toggle
      if (!db.get('SELECT 1 FROM kv WHERE k=?', k)) { db.run('INSERT INTO kv(k,v) VALUES(?,?)', k, '1'); notify(i.uid, 'vote', `Someone voted for your idea “${i.title}”`, `#/build/idea/${i.id}`); }
    }
    return { idea: ideaView(i, u.uid) };
  });

  // ---- inbox / allies
  route('GET', '/api/inbox', async (req, u) => {
    need(u);
    return { items: db.all('SELECT id,kind,text,link,created_at,read FROM inbox WHERE uid=? ORDER BY id DESC LIMIT 100', u.uid) };
  });
  route('POST', '/api/inbox/read', async (req, u) => { need(u); db.run('UPDATE inbox SET read=1 WHERE uid=?', u.uid); return { ok: true }; });
  route('GET', '/api/allies', async () => ({ allies: db.all('SELECT id,title,url,blurb FROM allies ORDER BY sort, id') }), { cache: 'etag' });

  // ---- what the panel does with members' things (lib/admin.js calls these on the admin host, behind Access; the
  // public host has no route to any of them): a reported idea hidden from the board.
  const ops = {
    hideIdea(id) { const i = db.get('SELECT id FROM ideas WHERE id=?', Number(id)); if (!i) throw bad('No such idea.', 404); db.run('UPDATE ideas SET hidden=1 WHERE id=?', i.id); },
  };

  // ---------- launch switches: closed areas answer "soon" to everyone ----------
  const AREAS = [
    ['chat', live.chat, 'Chat is coming soon.', ['/api/rooms/', '/api/messages/']],
    ['ideas', live.accounts, 'Ideas and votes are coming soon.', ['/api/ideas']],
    ['account', live.accounts, 'Sign-in is coming soon.', ['/api/me/', '/api/inbox', '/api/auth/signup', '/api/auth/login', '/api/auth/recover', '/api/auth/pow']],
  ];
  for (const r of routes) {
    const area = AREAS.find(([, , , prefixes]) => prefixes.some((x) => r.pattern.startsWith(x)));
    if (!area) continue;
    const [, isOpen, msg] = area; const inner = r.handler;
    // a room that does not exist is the plain 404 whatever the switches say (the closed card is for real rooms only)
    r.handler = (req, u, body, ip, res, params, ...rest) => { if (params?.room && !ROOMS.some((x) => x.id === params.room)) throw bad('Not found', 404); if (!isOpen()) throw bad(msg, 503); return inner(req, u, body, ip, res, params, ...rest); };
  }

  // ---------- server ----------
  const publicDir = path.join(ROOT, 'public');
  // The whole public folder lives in memory with content-hashed names and precompressed text (lib/assets.js).
  let assets = buildAssets(publicDir);
  const devAssets = isLocalOrigin(config.publicOrigin);
  config.devAssets = devAssets;
  // ---- the admin panel, on its own hostname (lib/admin.js). Misconfigured = answers 404, never open.
  if (config.adminHost && config.adminHost === expectedDomain) throw new Error('ADMIN_HOST must differ from the public host.');
  // The admin host's rate limits need the real visitor IP too: CLIENT_IP_HEADER (the production setting) or TRUST_PROXY.
  if (config.adminHost && !isLocalHost(config.adminHost) && !isLocalOrigin(config.publicOrigin) && !config.trustProxySet && !config.clientIpHeader) throw new Error('Set CLIENT_IP_HEADER or TRUST_PROXY for the admin host too.');
  config.adminOrigin = config.adminHost ? `${isLocalHost(config.adminHost) ? 'http' : 'https'}://${config.adminHost}` : '';
  const verify = makeAccessVerifier({ team: config.accessTeam, aud: config.adminAud, emailSha256: config.adminEmailSha256, fetchImpl: overrides.accessFetch || overrides.fetchImpl || fetch, log });
  if (config.adminHost && !verify.configured) log('admin host set but ACCESS_TEAM / ADMIN_ACCESS_AUD / ADMIN_EMAIL_SHA256 are missing or malformed: the admin host answers 404 until they are set.');
  const status = () => ({ node: process.version, uptimeS: Math.round((now() - startedAt) / 1000), memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed }, btcHeight: feeds.lore.tip, feeds: feeds.status(), maintenance: settings.get('maintenance').on });
  // Sign in with X (lib/xauth.js): off (routes 404, no button) until X_CLIENT_ID / X_CLIENT_SECRET / X_REDIRECT_URI are set.
  const xauth = makeX({ config, db, log, fetchImpl: overrides.xFetch || fetch, isLocal: isLocalOrigin(config.publicOrigin), secureCookie, now,
    open: () => live.accounts(), ipBanned, signupsFrom, logIp, startSession, isBanned, userRow, randomId, checkUsername, session });
  const admin = makeAdmin({ config, db, settings, verify, siteAssets: assets, safeUrl, status, log, mod, ops, xStatus: () => (xauth.configured ? { today: xauth.today(), cap: xauth.cap } : null), onChange: () => emit('settings', settingsView()), onLoreChange: () => feeds.lore.invalidate() });
  // The page is served at / only (every route is a hash route on that page); any other path that is not a file is a
  // plain 404, so a mistyped share link, a scanner or a search engine never gets a copy of the home under another name.
  function serveSite(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false; // files answer reads only
    if (devAssets && p === '/' && assets.changed()) assets = buildAssets(publicDir); // local dev: pick up edits without a restart
    if (p === '/') { serveAsset(req, res, assets.get('/index.html')); return true; }
    if (/\/\./.test(p) && !p.startsWith('/.well-known/')) return false; // /.env, /.git/HEAD, /.hidden/x: nothing of ours starts with a dot, apart from /.well-known/security.txt
    const e = assets.get(p);
    // The page has one address: not /index.html, not its fingerprinted name. The maintenance page is served by its
    // fingerprinted name only (one of the files the live verifier checks), and by the server itself while maintenance is on.
    if (!e || e.url === '/index.html' || (e.url === '/back-soon.html' && !assets.isHashed(p))) return false;
    serveAsset(req, res, e, { immutable: assets.isHashed(p) }); return true;
  }

  async function handle(req, res) {
    const ip = clientIp(req); // used only in memory for rate limiting; never stored or logged
    let url; try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
    const p = url.pathname;
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (config.adminHost && host === config.adminHost) return await admin.handle(req, res, ip, p);
      if (!okHost(host)) return send(res, 421, 'Wrong host');
      // Maintenance: a calm "back soon" page for people, 503 for the API, the art and styles still served so the page looks right.
      if (settings.get('maintenance').on) {
        if (p.startsWith('/api/')) return send(res, 503, { error: 'Back soon.', maintenance: true }, { 'Retry-After': '120' });
        const e = p !== '/' && /^\/(css|img|fonts|js)\//.test(p) ? assets.get(p) : null;
        if (e) return serveAsset(req, res, e, { immutable: assets.isHashed(p) });
        const note = settings.get('maintenance').text;
        if (!note) return serveAsset(req, res, assets.get('/back-soon.html'), { status: 503, noStore: true, extraHeaders: { 'Retry-After': '120' } });
        const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        return send(res, 503, assets.get('/back-soon.html').buf.toString('utf8').replace('<p class="soon-note"></p>', () => `<p class="soon-note">${esc(note)}</p>`), { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '120' }); // a function: "$&" in the note is shown, not expanded
      }
      if (p === '/api/stream') return stream(req, res, ip);
      if (p.startsWith('/auth/x/')) return xauth.handle(req, res, ip, p, url);
      if (p.startsWith('/api/')) {
        const method = req.method;
        limit('ip:' + ip, 600, 120); // first, before any header check or database lookup: a refused request costs nothing
        if (method !== 'GET' && method !== 'HEAD') {
          // CSRF: same-origin requests only, with our custom header (forces CORS preflight for anyone else).
          if (req.headers['x-tbb'] !== '1') throw bad('Missing header.', 403);
          const origin = req.headers.origin;
          if (origin && origin !== config.publicOrigin && !(isLocalOrigin(config.publicOrigin) && isLocalOrigin(origin))) throw bad('Cross-site request blocked.', 403);
          // A banned connection can read everything; it can't sign up, sign in or write. (Signing out is always fine.)
          if (p !== '/api/auth/logout' && ipBanned(ip)) throw bad(p.startsWith('/api/auth/') ? 'You can’t sign in from this connection right now.' : 'You can’t post from this connection right now.', 403);
        }
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.re.exec(p); if (!m) continue;
          let params; try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { throw bad('Bad path.'); }
          const user = session(req);
          const body = method === 'GET' ? {} : await readBody(req, 64 * 1024);
          const out = await r.handler(req, user, body, ip, res, params, url.searchParams);
          return send(res, 200, out, r.opts.cache === 'etag' ? { etag: true } : {});
        }
        throw bad('Not found', 404);
      }
      if (serveSite(req, res, p)) return;
      return send(res, 404, 'This page has moved on to other things.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
      log('error', req.method, p, String(e.stack || e.message).split(ROOT).join('.')); // no install paths in logs
      return send(res, 500, { error: 'Something broke on our side. Try again in a moment.' });
    }
  }

  // Real visitor IP: CLIENT_IP_HEADER when set (Cloudflare's cf-connecting-ip; must parse as an IP, else the socket),
  // otherwise the socket, or (behind TRUST_PROXY proxies) the entry the nearest trusted proxy added. IPv6 is grouped by
  // /48 (the block a site or a tunnel broker hands out whole) for everything downstream: every limiter, throttle, cap
  // and ban hash sees the same key, so one block never counts as thousands of visitors.
  function clientIp(req) {
    let ip = req.socket.remoteAddress || '?';
    if (config.clientIpHeader) {
      const v = String(req.headers[config.clientIpHeader] || '').trim();
      if (net.isIP(v)) ip = v;
    } else if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (xff.length >= config.trustProxy) ip = xff[xff.length - config.trustProxy];
    }
    ip = ip.replace(/^::ffff:/, '');
    return ip.includes(':') ? v6prefix48(ip) : ip;
  }
  function stream(req, res, ip) {
    if (req.method !== 'GET') return send(res, 405, 'GET only');
    // Three reasons to refuse (going too fast, six streams from one /48 already, the global cap), one and the same answer:
    // a visitor must not be able to learn from the stream whether the site is busy (that would be a live visitor count).
    const who = ip; // streams are counted per connection (IPv6 per /48, like every other cap)
    if (!allow('sse:' + ip, 10, 5) || clients.size >= config.sseMax || (sseByIp.get(who) || 0) >= 6) return send(res, 429, 'slow down');
    sseByIp.set(who, (sseByIp.get(who) || 0) + 1);
    const ttl = 3600_000; // every stream lives an hour, whatever the load; the page reconnects by itself (retry: 5000)
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ height: feeds.lore.tip, ttl })}\n\n`);
    try { res.uid = session(req)?.uid || null; } catch { res.uid = null; } // only for private 'inbox' nudges
    clients.add(res);
    const ping = setInterval(() => { if (res.writableLength > 64 * 1024) res.destroy(); else res.write(': ping\n\n'); }, 25_000);
    const maxAge = setTimeout(() => res.end(), ttl); maxAge.unref?.(); // clients reconnect on their own
    req.on('close', () => { clearInterval(ping); clearTimeout(maxAge); clients.delete(res); const n = (sseByIp.get(who) || 1) - 1; if (n > 0) sseByIp.set(who, n); else sseByIp.delete(who); });
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.headersTimeout = 15_000; server.requestTimeout = 30_000;
  // Idle keep-alive connections live 10 s (below headersTimeout, as node wants; the default 5 s made clients reuse a socket
  // the server was just closing).
  server.keepAliveTimeout = 10_000;

  return {
    config, db, feeds, settings, mod, ops, server, emit, event, notify, pow, throttle, limiter: allow, ipHash, logIp, xauth, housekeeping, get assets() { return assets; },
    helpNotesKeys: () => [...helpNotes.keys()], helpNotesAge: (key, ms) => { const e = helpNotes.get(key); if (e) e.at = now() - ms; }, // tests: what the Help-note map holds, and an entry made older
    routes: routes.map((r) => ({ method: r.method, pattern: r.pattern })), // every API route (method + pattern), for the launch-surface test
    async listen(port = config.port, host = config.host) {
      if (!config.offline) feeds.start(); // every outside feed on the server's own timer, from now on
      await Promise.all([assets.ready, admin.ready]); // the brotli copies first (a quarter second): no first visitor, and no CDN, keeps the gzip stand-in
      return new Promise((resolve) => server.listen(port, host, () => { if (config.lore && !config.offline) feeds.lore.start(); else feeds.lore.seed(); housekeeping(); resolve(server.address()); }));
    },
    async close() { clearInterval(pushTimer); clearInterval(pruneTimer); clearInterval(helpTimer); feeds.stop(); feeds.lore.stop(); for (const c of clients) c.end(); await new Promise((r) => server.close(r)); db.close(); },
  };
}

// Expand '::' before taking the /64, so 2001:db8::1 and 2001:db8::2 count as the same visitor.
export function v6prefix(ip) {
  const [h, t = ''] = String(ip).split('%')[0].split('::');
  const head = h ? h.split(':') : []; const tail = t ? t.split(':') : [];
  const full = String(ip).includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return full.slice(0, 4).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
// The /48 above that (the block a site, a hosting account or a tunnel broker gets whole), from a raw address or the
// '/64' form; an IPv4 address is itself. Every per-connection key downstream (limiters, the stream cap, the Help-note
// caps, ban hashes) is this, so one block never counts as thousands of visitors.
export function v6prefix48(ip) {
  const s = String(ip);
  if (!s.includes(':')) return s;
  const g = v6prefix(s.replace(/::\/64$/, '::')).replace(/::\/64$/, '').split(':');
  return `${g[0]}:${g[1]}:${g[2]}::/48`;
}
// Config URL for a third-party JSON feed: https, a real public hostname, root path only.
export function publicHttpsRoot(v) {
  try {
    const u = new URL(String(v || ''));
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) return '';
    const h = u.hostname;
    if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.') || /^[\d.]+$/.test(h) || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return '';
    return u.href === String(v) ? u.href : '';
  } catch { return ''; }
}
