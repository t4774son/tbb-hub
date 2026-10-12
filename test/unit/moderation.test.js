// Moderation end to end on a real server: the 18+ gate, text-only chat, zero links, the scam filter's hold/reject, automatic
// escalation, community reports, the admin's hide / mute / kick / ban / undo, live updates over the stream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../../lib/app.js';
import { seed } from '../../scripts/seed.js';
import { LINK_MSG, SECRET_MSG } from '../../lib/rules.js';
import { HOLD_MSG, REJECT_MSG } from '../../lib/modrules.js';
import { newUid, plantUser, sessionFor } from './helpers.js';

const kp = () => newUid('m'); // a fresh member id (planted on sign-in)
const rpc = async (method) => { throw new Error('unexpected rpc ' + method); };
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

let app; let base; let port;
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbmod-'));
before(async () => {
  app = createApp({ env: { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1', PORT: '0', LORE_WORKER: 'off', DB_FILE: path.join(dir, 'm.db'), PUBLIC_ORIGIN: 'http://localhost:3000' }, rpc, fetchImpl: fakeFetch, log: () => {} });
  seed(app.db);
  app.settings.set('areas', { chat: true, accounts: true });
  const a = await app.listen(0); port = a.port; base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const j = await res.json().catch(() => ({}));
    return { ...j, status: res.status, body: j };
  };
  return { call, get cookie() { return cookie; }, async signIn(uid, name, { adult = true } = {}) {
    plantUser(app.db, uid, { adult }); cookie = sessionFor(app.db, uid);
    if (name) { const r = await call('POST', '/api/me/name', { name }); assert.equal(r.status, 200, JSON.stringify(r)); }
    return { status: 200 };
  } };
}
// An open live stream: collects events so tests can check what was (and was not) broadcast.
function stream(cookie = '') {
  const events = []; let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie } }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1]; if (ev) events.push({ ev, data: data ? JSON.parse(data) : null }); } });
      res.on('error', () => {}); resolve();
    }); req.on('error', reject);
  });
  const wait = (pred, ms = 3000) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { const hit = events.find(pred); if (hit) return resolve(hit); if (Date.now() - t0 > ms) return reject(new Error('no event: ' + JSON.stringify(events.slice(-5)))); setTimeout(tick, 25); }; tick(); });
  return { events, ready, wait, close: () => req.destroy() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (c, room, body) => c.call('POST', `/api/rooms/${room}/messages`, { body });
// the chat limiter allows one message every 2 s per account (refused ones count too), so repeated posts from one account are paced
const paced = async (c, room, body) => { await sleep(2100); return post(c, room, body); };

test('18+: posting is refused until the account confirms; the confirmation sticks', async () => {
  const c = client(); await c.signIn(kp(), 'notyet', { adult: false });
  const r = await post(c, 'general', 'hello');
  assert.equal(r.status, 403); assert.equal(r.code, 'adult'); assert.match(r.error, /18 or older/);
  assert.equal((await c.call('POST', '/api/me/adult', { confirm: 'yes' })).status, 400);
  assert.equal((await c.call('POST', '/api/me/adult', { confirm: true })).status, 200);
  const st = await c.call('GET', '/api/state'); assert.equal(st.me.adult, true);
  assert.equal((await post(c, 'general', 'hello now')).status, 200);
});

test('text only, zero links, no addresses: every refusal has a friendly message; images/files have no way in', async () => {
  // one account per refusal (three refusals in 24 h would mute the account, which is the next test)
  for (const [body, re] of [['see claim-tbb.xyz', LINK_MSG], ['tbb dot com', LINK_MSG], ['data:image/png;base64,iVBORw0KGgo=', LINK_MSG], ['send to 7Nz7Z1Yj9Q3xYQp6q4Y2m1RkTo8m4nGpD3Qc1vqJz8Km', SECRET_MSG]]) {
    const x = client(); await x.signIn(kp(), 'l' + Math.random().toString(36).slice(2, 8));
    const r = await post(x, 'general', body); assert.equal(r.status, 422, body); assert.equal(r.error, re);
  }
  const c = client(); await c.signIn(kp(), 'linker');
  // nothing but text is stored: extra fields are ignored, an attachment-shaped body is just a string check
  const r = await post(c, 'general', 'plain words');
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.message).sort(), ['at', 'author', 'body', 'deleted', 'edited', 'held', 'hidden', 'id', 'mine', 'reactions', 'reply', 'room'].sort());
  await sleep(2100);
  const extra = await c.call('POST', '/api/rooms/general/messages', { body: 'with extras', image: 'data:image/png;base64,AAAA', file: { name: 'x.png' }, attachments: [1] });
  assert.equal(extra.status, 200, JSON.stringify(extra)); assert.equal(extra.message.body, 'with extras'); assert.equal(extra.message.image, undefined);
  const big = await fetch(base + '/api/rooms/general/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie: c.cookie }, body: JSON.stringify({ body: 'x', image: 'A'.repeat(70_000) }) });
  assert.equal(big.status, 413, 'chat bodies stay small: no room for a picture');
  // zero links everywhere users type: ideas, names
  const idea = await c.call('POST', '/api/ideas', { title: 'Visit tbb.app', body: 'great site' }); assert.equal(idea.status, 422);
  assert.equal((await c.call('POST', '/api/me/name', { name: 'tbb.xyz' })).status, 422);
  // invisible characters are stripped from what is stored
  const inv = await paced(c, 'general', 'he\u200bllo \u202ethere'); assert.equal(inv.status, 200); assert.equal(inv.message.body, 'hello there');
});

test('thumbs-up reactions work and show counts', async () => {
  const a = client(); await a.signIn(kp(), 'thumbsa'); const b = client(); await b.signIn(kp(), 'thumbsb');
  const m = await post(a, 'builds', 'ship it'); assert.equal(m.status, 200);
  assert.deepEqual(m.message.reactions.map((r) => r.e), ['👍', '🐂', '🔥', '🧡', '😂']);
  const r1 = await b.call('POST', `/api/messages/${m.message.id}/react`, { emoji: '👍' }); assert.equal(r1.status, 200);
  assert.deepEqual(r1.message.reactions.find((x) => x.e === '👍'), { e: '👍', n: 1, mine: true });
  const r2 = await a.call('POST', `/api/messages/${m.message.id}/react`, { emoji: '👍' });
  assert.deepEqual(r2.message.reactions.find((x) => x.e === '👍'), { e: '👍', n: 2, mine: true });
  const r3 = await b.call('POST', `/api/messages/${m.message.id}/react`, { emoji: '👍' });
  assert.deepEqual(r3.message.reactions.find((x) => x.e === '👍'), { e: '👍', n: 1, mine: false }, 'toggles off');
  const list = await client().call('GET', '/api/rooms/builds/messages');
  assert.equal(list.messages.find((x) => x.id === m.message.id).reactions.find((x) => x.e === '👍').n, 1);
});

test('scam filter: a scam is refused; a doubtful message is held (author sees it, nobody else, never broadcast) until the admin approves it', async () => {
  const c = client(); await c.signIn(kp(), 'doubtful');
  const s = stream(); await s.ready;
  const bad = await post(c, 'general', 'DM me for the airdrop'); assert.equal(bad.status, 422); assert.equal(bad.error, REJECT_MSG);
  const held = await paced(c, 'general', 'any telegram group for this?');
  assert.equal(held.status, 200); assert.equal(held.held, true); assert.equal(held.notice, HOLD_MSG); assert.equal(held.message.body, 'any telegram group for this?');
  const id = held.message.id;
  const mine = await c.call('GET', '/api/rooms/general/messages'); assert.equal(mine.messages.find((m) => m.id === id).body, 'any telegram group for this?', 'the author still sees it');
  const other = await client().call('GET', '/api/rooms/general/messages'); const o = other.messages.find((m) => m.id === id);
  assert.equal(o.body, ''); assert.equal(o.hidden, true); assert.equal(o.held, true);
  await sleep(200); assert.ok(!s.events.some((e) => e.ev === 'message' && e.data.id === id), 'never broadcast');
  const q = app.mod.queue(); const item = q.find((x) => x.kind === 'held' && x.message?.id === id); assert.ok(item, JSON.stringify(q)); assert.match(item.reason, /offsite_app/);
  // the admin approves: everyone sees it, it arrives on open pages as a new message
  app.mod.unhide(id, { actor: 'panel', reason: 'fine' });
  await s.wait((e) => e.ev === 'message' && e.data.id === id);
  assert.equal((await client().call('GET', '/api/rooms/general/messages')).messages.find((m) => m.id === id).body, 'any telegram group for this?');
  assert.ok(!app.mod.queue().some((x) => x.message?.id === id), 'queue item closed');
  s.close();
});

test('escalation without AI: 3 refused messages in 24 h = 1 h mute; more = 24 h mute + queue item; mutes end', async () => {
  const c = client(); await c.signIn(kp(), 'repeatoff');
  assert.equal((await post(c, 'general', 'claim-tbb.xyz')).status, 422); assert.equal((await paced(c, 'general', 'see tbb.app')).status, 422);
  assert.equal((await paced(c, 'general', 'still fine')).status, 200, 'two hits: still allowed');
  assert.equal((await paced(c, 'general', 'tbb dot com')).status, 422);
  const muted = await paced(c, 'general', 'hello'); assert.equal(muted.status, 403); assert.match(muted.error, /muted for another (1 h|59 min)/);
  const st = await c.call('GET', '/api/state'); assert.ok(st.me.muted > Date.now() + 50 * 60_000);
  const w = app.db.get('SELECT uid FROM users WHERE name=?', 'repeatoff').uid;
  assert.equal(app.mod.recent().find((a) => a.uid === w).action, 'mute');
  app.mod.unmute(w, { actor: 'panel', reason: 'test' });
  assert.equal((await paced(c, 'general', 'bit.ly/x')).status, 422, 'fourth hit');
  assert.ok(app.db.get('SELECT muted_until FROM users WHERE uid=?', w).muted_until > Date.now() + 23 * 3600_000, '24 h mute');
  assert.ok(app.mod.queue().some((q) => q.kind === 'auto_mute' && q.user.uid === w), 'admin queue item');
  // a muted person can still read
  assert.equal((await c.call('GET', '/api/rooms/general/messages')).status, 200);
  // a mute is time-limited: wind the clock back and the person posts again
  app.db.run('UPDATE users SET muted_until=? WHERE uid=?', Date.now() - 1000, w);
  assert.equal((await paced(c, 'general', 'back')).status, 200);
});

test('community reports: 3 established accounts hide a message pending review; 5 on one person mute them; overruled reporters lose weight; no double reports', async () => {
  const target = client(); await target.signIn(kp(), 'reported');
  const m = await post(target, 'general', 'a message people dislike'); assert.equal(m.status, 200);
  const reporters = []; for (let i = 0; i < 7; i++) { const c = client(); await c.signIn(kp(), 'rep' + i); reporters.push(c); }
  const young = client(); await young.signIn(kp(), 'newbie');
  const age = (name, days) => app.db.run('UPDATE users SET created_at=? WHERE name=?', Date.now() - days * 86400_000, name);
  for (let i = 0; i < 7; i++) age('rep' + i, 10);
  const s = stream(); await s.ready;
  for (const c of [young, reporters[0], reporters[1]]) assert.equal((await c.call('POST', '/api/report', { kind: 'message', target: m.message.id, reason: 'scammy' })).status, 200);
  assert.equal((await reporters[1].call('POST', '/api/report', { kind: 'message', target: m.message.id, reason: 'again' })).status, 200, 'a repeat report is accepted silently');
  assert.equal(app.db.get('SELECT COUNT(*) n FROM reports WHERE target=?', String(m.message.id)).n, 3, 'but not counted twice');
  assert.equal(app.db.get('SELECT hidden FROM messages WHERE id=?', m.message.id).hidden, 0, 'a 2-day-old account does not count: still visible');
  const third = await reporters[2].call('POST', '/api/report', { kind: 'message', target: m.message.id, reason: 'scammy' });
  assert.equal(third.hidden, true);
  const row = app.db.get('SELECT hidden, held, mod_by FROM messages WHERE id=?', m.message.id); assert.deepEqual({ ...row }, { hidden: 1, held: 1, mod_by: 'community' });
  const upd = await s.wait((e) => e.ev === 'message:update' && e.data.id === m.message.id); assert.equal(upd.data.body, ''); assert.equal(upd.data.hidden, true);
  assert.ok(app.mod.queue().some((q) => q.kind === 'community' && q.message?.id === m.message.id));
  // the admin overrules: message back, the overruled reporters' weight halves
  app.mod.closeQueueItem(`report:${app.db.get('SELECT id FROM reports WHERE target=? ORDER BY id LIMIT 1', String(m.message.id)).id}`, { punished: false }); // what the admin route does first
  app.mod.unhide(m.message.id, { actor: 'panel', reason: 'that was fine' });
  assert.equal(app.db.get('SELECT report_weight FROM users WHERE name=?', 'rep0').report_weight, 0.5); assert.equal(app.db.get('SELECT report_weight FROM users WHERE name=?', 'rep3').report_weight, 1);
  // five (weighted) reports on one person's messages in 24 h → 1 h mute + queue item. The three overruled reporters now count half.
  const m2 = await paced(target, 'general', 'another one'); const m3 = await paced(target, 'general', 'and another');
  for (const [c, id] of [[reporters[0], m2.message.id], [reporters[1], m2.message.id], [reporters[2], m3.message.id], [reporters[3], m3.message.id], [reporters[4], m2.message.id]]) await c.call('POST', '/api/report', { kind: 'message', target: id, reason: 'spam' });
  assert.equal(app.db.get('SELECT muted_until FROM users WHERE name=?', 'reported').muted_until, 0, '0.5+0.5+0.5+1+1 = 3.5: not yet');
  for (const [c, id] of [[reporters[5], m3.message.id], [reporters[6], m2.message.id]]) await c.call('POST', '/api/report', { kind: 'message', target: id, reason: 'spam' });
  const u = app.db.get('SELECT muted_until, uid FROM users WHERE name=?', 'reported');
  assert.ok(u.muted_until > Date.now() + 50 * 60_000, 'muted 1 h by the community: ' + JSON.stringify(u));
  assert.ok(app.mod.queue().some((q) => q.kind === 'reports_user' && q.user.uid === u.uid));
  assert.equal((await paced(target, 'general', 'hey')).status, 403);
  s.close();
});

test('admin tools: hide (live for everyone), hide all 24 h, mute, kick ends sessions, ban hides everything and blocks sign-in; each undone in one step', async () => {
  const bad = kp(); const c = client(); await c.signIn(bad, 'troublemaker');
  const m1 = await post(c, 'general', 'first'); const m2 = await paced(c, 'builds', 'second');
  const viewer = stream(); await viewer.ready;
  const theirs = stream(c.cookie); await theirs.ready;
  // hide one message: every open page gets the update at once, with an empty body
  const hideId = app.mod.hide(m1.message.id, { actor: 'panel', reason: 'nope' });
  const upd = await viewer.wait((e) => e.ev === 'message:update' && e.data.id === m1.message.id);
  assert.equal(upd.data.hidden, true); assert.equal(upd.data.body, '');
  assert.equal((await client().call('GET', '/api/rooms/general/messages')).messages.find((x) => x.id === m1.message.id).body, '');
  app.mod.undo(hideId, { actor: 'panel' });
  assert.equal((await client().call('GET', '/api/rooms/general/messages')).messages.find((x) => x.id === m1.message.id).body, 'first');
  assert.equal(app.db.get('SELECT undone_at FROM mod_actions WHERE id=?', hideId).undone_at > 0, true);
  // hide all from the last 24 h
  const allId = app.mod.hideAll(bad, { actor: 'panel', reason: 'cleanup' });
  assert.equal(app.db.get('SELECT COUNT(*) n FROM messages WHERE uid=? AND hidden=1', bad).n, 2);
  app.mod.undo(allId, { actor: 'panel' }); assert.equal(app.db.get('SELECT COUNT(*) n FROM messages WHERE uid=? AND hidden=1', bad).n, 0);
  // mute: can read, can't post; the person's own page is told; undo lifts it
  const muteId = app.mod.mute(bad, 1440, { actor: 'panel', reason: 'cool off' });
  await theirs.wait((e) => e.ev === 'me');
  const r = await paced(c, 'general', 'hi'); assert.equal(r.status, 403); assert.match(r.error, /muted for another 24 h/);
  assert.equal((await c.call('GET', '/api/rooms/general/messages')).status, 200);
  assert.throws(() => app.mod.mute(bad, 7, { reason: 'x' }), /10 minutes, 1 hour, 24 hours or 7 days/);
  app.mod.undo(muteId, { actor: 'panel' }); assert.equal((await paced(c, 'general', 'hi again')).status, 200);
  // kick: sessions end now (the stream says so and closes), 24 h mute
  const kickId = app.mod.kick(bad, { actor: 'panel', reason: 'out' });
  await theirs.wait((e) => e.ev === 'kicked');
  assert.equal((await c.call('GET', '/api/state')).me, null, 'signed out everywhere');
  await c.signIn(bad); // can sign in again…
  assert.equal((await paced(c, 'general', 'back?')).status, 403, '…but is muted for 24 h');
  app.mod.undo(kickId, { actor: 'panel' }); assert.equal((await paced(c, 'general', 'ok back')).status, 200);
  // ban: permanent, messages hidden, no sign-in
  const banId = app.mod.ban(bad, { actor: 'panel', reason: 'scammer' });
  assert.equal(app.db.get('SELECT COUNT(*) n FROM messages WHERE uid=? AND hidden=0 AND deleted=0', bad).n, 0, 'all hidden');
  assert.equal((await c.call('GET', '/api/state')).me, null);
  assert.equal(app.mod.users('trouble')[0].status, 'banned');
  app.mod.undo(banId, { actor: 'panel' });
  assert.equal(app.db.get('SELECT banned FROM users WHERE uid=?', bad).banned, 0);
  assert.equal(app.db.get('SELECT COUNT(*) n FROM messages WHERE uid=? AND hidden=0 AND deleted=0', bad).n, 4, 'messages back');
  await c.signIn(bad); assert.equal((await c.call('GET', '/api/state')).me.name, 'troublemaker');
  // the log tells the story
  const log = app.mod.recent(20).map((a) => a.action);
  assert.ok(log.includes('ban') && log.includes('unban') && log.includes('kick') && log.includes('mute') && log.includes('hide_all'));
  viewer.close(); theirs.close();
});

test('users list: name, short id, joined, messages, flags, status; search by name or id', async () => {
  const list = app.mod.users();
  const t = list.find((u) => u.name === 'troublemaker');
  assert.ok(t && t.short.includes('…') && t.joined > 0 && t.msgs >= 3 && typeof t.hits === 'number' && t.status === 'ok');
  assert.ok(list[0].uid.length > 10, 'the full account id is available to the admin only');
  assert.equal(app.mod.users('TROUBLE').length, 1);
  assert.equal(app.mod.users(t.uid.slice(2, 10))[0].uid, t.uid); // the search strips SQL wildcards, the underscore of the id prefix included
  assert.equal(app.mod.users('nobody-by-that-name').length, 0);
});

