// Moderation without AI: the admin's tools (hide, mute, kick, ban, undo), the automatic escalation of rule hits, and the
// community's reports. Every action is a row in mod_actions (actor panel | auto | community) so the panel can undo it,
// and every one takes effect at once over the live stream (a hidden message disappears for everyone without a reload).
import { bad } from './http.js';

export const MUTE_MINUTES = [10, 60, 1440, 10080]; // 10 min, 1 h, 24 h, 7 days
export const BAN_DAYS = [1, 7, 30];       // timed account bans (null = permanent)
export const IP_BAN_DAYS = [1, 7, 30];    // IP bans are never permanent: addresses are reused by innocent people, VPN exits, phone carriers
export const IP_KEEP_DAYS = 7;
export const REPORT_AGE_DAYS = 7;   // only accounts this old count towards a community hide
export const REPORTS_TO_HIDE = 3;   // different accounts on one message → hidden, pending the admin
export const REPORTS_TO_MUTE = 5;   // reports on one person's messages in 24 h → 1 h mute + queue item
const HOUR = 3600_000; const DAY = 24 * HOUR;

export function makeModeration({ db, msgView, emit, clients = new Set(), sendTo = () => {}, now = Date.now }) {
  const row = (id) => db.get('SELECT * FROM messages WHERE id=?', Number(id));
  const user = (id) => db.get('SELECT * FROM users WHERE uid=?', id);
  const banned = (u) => !!u?.banned && (!u.ban_until || u.ban_until > now());
  // the hashed connections an account used in the last 7 days (lib/app.js writes them; never an IP, only an HMAC of one)
  const hashesOf = (uid) => db.all('SELECT DISTINCT ip_hash FROM ip_log WHERE uid=? AND at>? ORDER BY ip_hash', uid, now() - IP_KEEP_DAYS * DAY).map((r) => r.ip_hash);
  const othersOn = (hash, uid) => db.get('SELECT COUNT(DISTINCT uid) n FROM ip_log WHERE ip_hash=? AND uid<>? AND at>?', hash, uid || '', now() - IP_KEEP_DAYS * DAY).n;
  const label = (hash) => '#' + String(hash).slice(0, 8);
  // what the panel prints as the short id: "@username" when there is one, else the account id, shortened
  const shortId = (s) => (typeof s === 'string' && s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
  const shortOf = (u) => (u.username ? '@' + u.username : shortId(u.uid));
  // Tell every open page about a message's new state (hidden messages carry an empty body).
  function push(m) { if (m) emit('message:update', msgView(m, null)); }
  function log(actor, action, { uid = null, message_id = null, reason = '', meta = null } = {}) {
    const r = db.run('INSERT INTO mod_actions(at,actor,action,uid,message_id,reason,meta) VALUES(?,?,?,?,?,?,?)', now(), actor, action, uid, message_id, String(reason || '').slice(0, 200), meta ? JSON.stringify(meta) : null);
    return Number(r.lastInsertRowid);
  }
  const queue = (kind, { target = null, uid = null, reason = '' } = {}) => db.run('INSERT INTO mod_queue(kind,target,uid,reason,created_at) VALUES(?,?,?,?,?)', kind, target === null ? null : String(target), uid, String(reason).slice(0, 300), now());
  // Once a message is dealt with, its queue entries (reports, held, community) are closed too.
  function settle(messageId, resolution) {
    db.run('UPDATE reports SET resolved=1 WHERE kind=? AND target=? AND resolved=0', 'message', String(messageId));
    db.run("UPDATE mod_queue SET resolved=1, resolution=? WHERE resolved=0 AND target=? AND kind IN ('held','community')", resolution, String(messageId));
  }
  // Reporters who are repeatedly overruled lose weight; reporters who were right regain it.
  function weigh(messageId, right) {
    for (const r of db.all('SELECT DISTINCT uid FROM reports WHERE kind=? AND target=? AND uid IS NOT NULL', 'message', String(messageId))) {
      const u = user(r.uid); if (!u) continue;
      const w = right ? Math.min(1, u.report_weight + 0.25) : Math.max(0.1, u.report_weight * 0.5);
      db.run('UPDATE users SET report_weight=? WHERE uid=?', w, r.uid);
    }
  }
  function endSessions(uid) {
    db.run('DELETE FROM sessions WHERE uid=?', uid);
    for (const c of [...clients]) if (c.uid === uid) { sendTo(c, 'kicked', {}); try { c.end(); } catch { /* gone */ } clients.delete(c); }
  }

  const mod = {
    status(u) {
      if (!u) return { muted: false, banned: false };
      return { muted: u.muted_until > now(), until: u.muted_until > now() ? u.muted_until : null, banned: banned(u) };
    },
    // A refused message (link / address / scam phrase / doxxing). 1st = refused; 3rd in 24 h = 1 h mute; more = 24 h mute + admin's queue.
    recordHit(uid, kind) {
      if (!uid) return null;
      db.run('INSERT INTO mod_hits(uid,kind,at) VALUES(?,?,?)', uid, kind, now());
      db.run('DELETE FROM mod_hits WHERE at<?', now() - 30 * DAY); // only the last 24 h ever count; keep a month for the admin's view, no more
      const n = db.get('SELECT COUNT(*) n FROM mod_hits WHERE uid=? AND at>?', uid, now() - DAY).n;
      if (n === 3) { mod.mute(uid, 60, { actor: 'auto', reason: `3 refused messages in 24 h (last: ${kind})` }); return { muted: 60 }; }
      if (n > 3) { mod.mute(uid, 1440, { actor: 'auto', reason: `${n} refused messages in 24 h (last: ${kind})` }); queue('auto_mute', { uid, reason: `${n} refused messages in 24 h; muted 24 h. Last: ${kind}.` }); return { muted: 1440, queued: true }; }
      return null;
    },
    hide(id, { actor = 'panel', reason = '', held = false } = {}) {
      const m = row(id); if (!m) throw bad('No such message.', 404);
      db.run('UPDATE messages SET hidden=1, held=?, mod_reason=?, mod_by=? WHERE id=?', held ? 1 : 0, String(reason).slice(0, 200), actor, m.id);
      if (!held) settle(m.id, 'hidden');
      push(row(m.id));
      return log(actor, 'hide', { uid: m.uid, message_id: m.id, reason, meta: { held } });
    },
    unhide(id, { actor = 'panel', reason = '' } = {}) {
      const m = row(id); if (!m) throw bad('No such message.', 404);
      db.run('UPDATE messages SET hidden=0, held=0, mod_reason=NULL, mod_by=NULL WHERE id=?', m.id);
      settle(m.id, 'approved');
      const v = row(m.id); push(v);
      // a held message was never broadcast: send it as new so open pages show it
      if (m.held) emit('message', msgView(v, null));
      return log(actor, 'unhide', { uid: m.uid, message_id: m.id, reason });
    },
    hideAll(uid, { actor = 'panel', reason = '', hours = 24 } = {}) {
      const ids = db.all('SELECT id FROM messages WHERE uid=? AND hidden=0 AND deleted=0 AND created_at>?', uid, now() - hours * HOUR).map((r) => r.id);
      for (const id of ids) { db.run('UPDATE messages SET hidden=1, mod_reason=?, mod_by=? WHERE id=?', String(reason).slice(0, 200), actor, id); settle(id, 'hidden'); push(row(id)); }
      return log(actor, 'hide_all', { uid, reason, meta: { ids, hours } });
    },
    mute(uid, minutes, { actor = 'panel', reason = '' } = {}) {
      if (!MUTE_MINUTES.includes(Number(minutes))) throw bad('Mute for 10 minutes, 1 hour, 24 hours or 7 days.');
      const u = user(uid); if (!u) throw bad('No such user.', 404);
      const until = Math.max(u.muted_until, now()) + Number(minutes) * 60_000;
      db.run('UPDATE users SET muted_until=? WHERE uid=?', until, uid);
      for (const c of clients) if (c.uid === uid) sendTo(c, 'me', {});
      return log(actor, 'mute', { uid, reason, meta: { minutes, until, before: u.muted_until } });
    },
    unmute(uid, { actor = 'panel', reason = '' } = {}) {
      const u = user(uid); if (!u) throw bad('No such user.', 404);
      db.run('UPDATE users SET muted_until=0 WHERE uid=?', uid);
      for (const c of clients) if (c.uid === uid) sendTo(c, 'me', {});
      return log(actor, 'unmute', { uid, reason, meta: { before: u.muted_until } });
    },
    kick(uid, { actor = 'panel', reason = '' } = {}) {
      const u = user(uid); if (!u) throw bad('No such user.', 404);
      const until = now() + DAY;
      db.run('UPDATE users SET muted_until=? WHERE uid=?', Math.max(u.muted_until, until), uid);
      endSessions(uid);
      return log(actor, 'kick', { uid, reason, meta: { until, before: u.muted_until } });
    },
    // Ban an account: permanent (days = null) or for 1 / 7 / 30 days. With ip = true, the hashed connections it used in the
    // last 7 days are blocked too (sign-up, sign-in, posting; reading stays open) for ipDays (1 / 7 / 30, default 7).
    ban(uid, { actor = 'panel', reason = '', days = null, ip = false, ipDays = 7 } = {}) {
      const u = user(uid); if (!u) throw bad('No such user.', 404);
      if (days !== null && !BAN_DAYS.includes(Number(days))) throw bad('Ban for 24 hours, 7 days, 30 days, or for good.');
      if (ip && !IP_BAN_DAYS.includes(Number(ipDays))) throw bad('An IP ban lasts 24 hours, 7 days or 30 days (never for good).');
      const ids = db.all('SELECT id FROM messages WHERE uid=? AND hidden=0 AND deleted=0', uid).map((r) => r.id);
      const until = days === null ? 0 : now() + Number(days) * DAY;
      db.run('UPDATE users SET banned=1, ban_until=? WHERE uid=?', until, uid);
      for (const id of ids) { db.run('UPDATE messages SET hidden=1, mod_reason=?, mod_by=? WHERE id=?', 'banned', actor, id); settle(id, 'hidden'); push(row(id)); }
      db.run("UPDATE mod_queue SET resolved=1, resolution='banned' WHERE resolved=0 AND uid=?", uid);
      endSessions(uid);
      let ipHashes = []; let ipUntil = null;
      if (ip) {
        ipHashes = hashesOf(uid); ipUntil = now() + Number(ipDays) * DAY;
        for (const h of ipHashes) db.run('INSERT INTO ip_bans(ip_hash,until,reason,uid,created_at) VALUES(?,?,?,?,?) ON CONFLICT(ip_hash) DO UPDATE SET until=MAX(until, excluded.until), reason=excluded.reason, uid=excluded.uid', h, ipUntil, String(reason).slice(0, 200), uid, now());
      }
      return log(actor, 'ban', { uid, reason, meta: { ids, days, until: until || null, ip: !!ip, ipHashes, ipUntil } });
    },
    unban(uid, { actor = 'panel', reason = '', ids = null, ipHashes = null } = {}) {
      const u = user(uid); if (!u) throw bad('No such user.', 404);
      db.run('UPDATE users SET banned=0, ban_until=0 WHERE uid=?', uid);
      for (const id of ids || []) { db.run("UPDATE messages SET hidden=0, mod_reason=NULL, mod_by=NULL WHERE id=? AND mod_reason='banned'", id); push(row(id)); }
      // the IP bans that came with this account's ban go too
      const lifted = ipHashes || db.all('SELECT ip_hash FROM ip_bans WHERE uid=?', uid).map((r) => r.ip_hash);
      for (const h of lifted) db.run('DELETE FROM ip_bans WHERE ip_hash=? AND uid=?', h, uid);
      return log(actor, 'unban', { uid, reason, meta: { ids, ipHashes: lifted } });
    },
    // Lift one IP ban (the account ban stays).
    liftIp(hash, { actor = 'panel', reason = '' } = {}) {
      const b = db.get('SELECT * FROM ip_bans WHERE ip_hash=?', String(hash)); if (!b) throw bad('No such IP ban.', 404);
      db.run('DELETE FROM ip_bans WHERE ip_hash=?', b.ip_hash);
      return log(actor, 'lift_ip', { uid: b.uid, reason, meta: { ipHashes: [b.ip_hash], label: label(b.ip_hash) } });
    },
    // A message the scam filter (or the community) wants the admin to see first: stored hidden, never broadcast.
    hold(id, { actor = 'auto', reason = '' } = {}) {
      const m = row(id); if (!m) return null;
      db.run('UPDATE messages SET hidden=1, held=1, mod_reason=?, mod_by=? WHERE id=?', String(reason).slice(0, 200), actor, m.id);
      queue(actor === 'community' ? 'community' : 'held', { target: m.id, uid: m.uid, reason });
      if (!m.hidden) push(row(m.id)); // a message people already saw disappears for everyone at once
      return log(actor, 'hold', { uid: m.uid, message_id: m.id, reason });
    },
    // A user's report. Three different accounts (≥ 7 days old, not muted) on one message → hidden pending review;
    // five on one person's messages in 24 h → 1 h mute + a queue item. Report weight shrinks for people who are repeatedly overruled.
    onReport(kind, target, reporter) {
      if (kind !== 'message' || !reporter) return null;
      const m = row(target); if (!m || m.deleted) return null;
      const counts = (sql, ...p) => db.all(sql, ...p).reduce((s, r) => s + (r.weight ?? 1), 0);
      const eligible = `SELECT DISTINCT r.uid, u.report_weight weight FROM reports r JOIN users u ON u.uid=r.uid WHERE r.kind='message' AND r.uid<>? AND u.created_at<? AND (u.muted_until<=? OR u.muted_until IS NULL) AND u.banned=0`;
      const onMessage = counts(`${eligible} AND r.target=?`, m.uid, now() - REPORT_AGE_DAYS * DAY, now(), String(m.id));
      const out = {};
      if (onMessage >= REPORTS_TO_HIDE && !m.hidden) { mod.hold(m.id, { actor: 'community', reason: `${Math.round(onMessage)} reports from different accounts` }); out.hidden = true; }
      const onUser = counts(`${eligible} AND r.created_at>? AND r.target IN (SELECT CAST(id AS TEXT) FROM messages WHERE uid=?)`, m.uid, now() - REPORT_AGE_DAYS * DAY, now(), now() - DAY, m.uid);
      const u = user(m.uid);
      if (onUser >= REPORTS_TO_MUTE && u && !db.get("SELECT 1 FROM mod_actions WHERE uid=? AND actor='community' AND action='mute' AND at>?", m.uid, now() - DAY)) {
        mod.mute(m.uid, 60, { actor: 'community', reason: `${Math.round(onUser)} reports on this person in 24 h` });
        queue('reports_user', { uid: m.uid, reason: `${Math.round(onUser)} reports on this person's messages in 24 h; muted 1 h.` });
        out.muted = true;
      }
      return out;
    },
    // Close a queue item without acting on the content ("approve" a report = the reporters were overruled).
    dismiss(qid, { actor = 'panel', reason = '' } = {}) {
      const [kind, id] = String(qid).split(':');
      if (kind === 'report') { const r = db.get('SELECT * FROM reports WHERE id=?', Number(id)); if (!r) throw bad('No such report.', 404); db.run('UPDATE reports SET resolved=1 WHERE id=?', r.id); if (r.kind === 'message' && !r.resolved) weigh(r.target, false); return log(actor, 'dismiss', { uid: r.uid, message_id: r.kind === 'message' ? Number(r.target) : null, reason, meta: { report: r.id } }); }
      if (kind === 'q') { const q = db.get('SELECT * FROM mod_queue WHERE id=?', Number(id)); if (!q) throw bad('No such item.', 404); db.run("UPDATE mod_queue SET resolved=1, resolution='dismissed' WHERE id=?", q.id); return log(actor, 'dismiss', { uid: q.uid, reason, meta: { queue: q.id, kind: q.kind } }); }
      throw bad('Unknown queue item.', 404);
    },
    // The admin acted on a queue item: close it; the reporters were right when the content was punished (their weight recovers).
    closeQueueItem(qid, { punished = false } = {}) {
      const [kind, id] = String(qid).split(':');
      if (kind === 'report') { const r = db.get('SELECT * FROM reports WHERE id=?', Number(id)); if (!r) return; const fresh = !r.resolved; db.run('UPDATE reports SET resolved=1 WHERE id=?', r.id); if (fresh && r.kind === 'message') weigh(r.target, punished); }
      else if (kind === 'q') db.run("UPDATE mod_queue SET resolved=1, resolution=? WHERE id=? AND resolved=0", punished ? 'actioned' : 'approved', Number(id));
    },
    // Reverse one action from the log. Kicks can't give sessions back (the person signs in again).
    undo(actionId, { actor = 'panel' } = {}) {
      const a = db.get('SELECT * FROM mod_actions WHERE id=?', Number(actionId)); if (!a) throw bad('No such action.', 404);
      if (a.undone_at) throw bad('Already undone.', 409);
      const meta = a.meta ? JSON.parse(a.meta) : {};
      const reason = `undo #${a.id}`;
      let undoId;
      switch (a.action) {
        case 'hide': case 'hold': undoId = mod.unhide(a.message_id, { actor, reason }); break;
        case 'hide_all': for (const id of meta.ids || []) { db.run('UPDATE messages SET hidden=0, mod_reason=NULL, mod_by=NULL WHERE id=?', id); push(row(id)); } undoId = log(actor, 'unhide_all', { uid: a.uid, reason, meta }); break;
        case 'unhide': undoId = mod.hide(a.message_id, { actor, reason }); break;
        case 'mute': case 'kick': { const u = user(a.uid); if (u) { db.run('UPDATE users SET muted_until=? WHERE uid=?', Math.min(u.muted_until, meta.before ?? 0), a.uid); for (const c of clients) if (c.uid === a.uid) sendTo(c, 'me', {}); } undoId = log(actor, 'unmute', { uid: a.uid, reason, meta: { before: u?.muted_until } }); break; }
        case 'ban': undoId = mod.unban(a.uid, { actor, reason, ids: meta.ids || [], ipHashes: meta.ipHashes || [] }); break;
        case 'unban': undoId = mod.ban(a.uid, { actor, reason }); break;
        case 'lift_ip': { const until = now() + 7 * DAY; for (const h of meta.ipHashes || []) db.run('INSERT INTO ip_bans(ip_hash,until,reason,uid,created_at) VALUES(?,?,?,?,?) ON CONFLICT(ip_hash) DO UPDATE SET until=excluded.until', h, until, reason, a.uid, now()); undoId = log(actor, 'ban_ip', { uid: a.uid, reason, meta: { ipHashes: meta.ipHashes, ipUntil: until } }); break; }
        case 'unmute': { const u = user(a.uid); if (u && meta.before > now()) db.run('UPDATE users SET muted_until=? WHERE uid=?', meta.before, a.uid); undoId = log(actor, 'mute', { uid: a.uid, reason, meta: { until: meta.before } }); break; }
        default: throw bad(`“${a.action}” can’t be undone.`, 400);
      }
      db.run('UPDATE mod_actions SET undone_at=? WHERE id=?', now(), a.id);
      return undoId;
    },
    // ---- what the panel shows ----
    queue() {
      const items = [];
      const msgInfo = (id) => { const m = row(id); return m ? { id: m.id, room: m.room, body: m.deleted ? '' : m.body, at: m.created_at, hidden: !!m.hidden, held: !!m.held, deleted: !!m.deleted } : null; };
      const who = (w) => { const u = w ? user(w) : null; return u ? { uid: u.uid, short: shortOf(u), name: u.name || u.username || shortOf(u), username: u.username || null, x: u.x_handle || null, muted: u.muted_until > now(), banned: banned(u) } : (w ? { uid: w, short: shortId(w), name: shortId(w) } : null); };
      for (const r of db.all('SELECT * FROM reports WHERE resolved=0 ORDER BY id DESC LIMIT 100')) {
        const m = r.kind === 'message' ? msgInfo(r.target) : null;
        const n = r.kind === 'message' ? db.get('SELECT COUNT(DISTINCT uid) n FROM reports WHERE kind=? AND target=? AND resolved=0', 'message', r.target).n : 1;
        items.push({ qid: `report:${r.id}`, kind: 'report', at: r.created_at, target: r.kind, targetId: r.target, reason: r.reason, reports: n, message: m, user: who(m?.uid ? row(r.target).uid : null), reporter: who(r.uid) });
      }
      for (const q of db.all('SELECT * FROM mod_queue WHERE resolved=0 ORDER BY id DESC LIMIT 100')) {
        const item = { qid: `q:${q.id}`, kind: q.kind, at: q.created_at, reason: q.reason, user: who(q.uid) };
        if (q.kind === 'held' || q.kind === 'community') item.message = msgInfo(q.target);
        items.push(item);
      }
      return items.sort((a, b) => b.at - a.at);
    },
    // The people list. `ipHash` narrows it to the accounts that used one hashed connection in the last 7 days ("3 other
    // accounts used this connection" → one click shows them). Never an IP, only its label.
    users(q = '', { ipHash = null } = {}) {
      const like = `%${String(q).trim().slice(0, 40).replace(/[%_]/g, '')}%`;
      const rows = db.all(`SELECT u.*, (SELECT COUNT(*) FROM messages m WHERE m.uid=u.uid AND m.deleted=0) msgs,
        (SELECT COUNT(*) FROM mod_hits h WHERE h.uid=u.uid AND h.at>?) hits,
        (SELECT COUNT(*) FROM reports r WHERE r.kind='message' AND r.resolved=0 AND r.target IN (SELECT CAST(id AS TEXT) FROM messages WHERE uid=u.uid)) reports,
        (SELECT COUNT(DISTINCT ip_hash) FROM ip_log l WHERE l.uid=u.uid AND l.at>?) conns,
        (SELECT COUNT(*) FROM ip_bans b WHERE b.uid=u.uid AND b.until>?) ipbans
        FROM users u WHERE (? = '%%' OR lower(u.name) LIKE lower(?) OR lower(u.username) LIKE lower(?) OR u.uid LIKE ? OR lower(u.x_handle) LIKE lower(?))
        ${ipHash ? 'AND u.uid IN (SELECT uid FROM ip_log WHERE ip_hash=? AND at>?)' : ''} ORDER BY u.created_at DESC LIMIT 200`,
        now() - DAY, now() - IP_KEEP_DAYS * DAY, now(), like, like, like, like, like, ...(ipHash ? [String(ipHash), now() - IP_KEEP_DAYS * DAY] : []));
      return rows.map((u) => ({ uid: u.uid, short: shortOf(u), name: u.name, username: u.username || null, x: u.x_handle || null, via: u.via || 'password',
        joined: u.created_at, msgs: u.msgs, hits: u.hits, reports: u.reports, connections: u.conns, ipBans: u.ipbans,
        status: banned(u) ? 'banned' : u.muted_until > now() ? 'muted' : 'ok', bannedUntil: banned(u) && u.ban_until ? u.ban_until : null, mutedUntil: u.muted_until > now() ? u.muted_until : null, adult: !!u.adult_confirmed_at, weight: u.report_weight }));
    },
    // Active IP bans: a label (never the IP: there is none, only a keyed hash), when it ends, why, whose ban it came with,
    // and how many other accounts used that connection lately.
    ipBans() {
      db.run('DELETE FROM ip_bans WHERE until<=?', now());
      return db.all('SELECT * FROM ip_bans ORDER BY created_at DESC LIMIT 200').map((b) => { const u = b.uid ? user(b.uid) : null;
        return { hash: b.ip_hash, label: label(b.ip_hash), until: b.until, reason: b.reason, at: b.created_at, user: u ? { uid: u.uid, name: u.name || u.username || shortOf(u) } : null, others: othersOn(b.ip_hash, b.uid) }; });
    },
    // For one account: its hashed connections (labels) and how many others share each.
    connectionsOf(uid) { return hashesOf(uid).map((h) => ({ hash: h, label: label(h), others: othersOn(h, uid), banned: !!db.get('SELECT 1 FROM ip_bans WHERE ip_hash=? AND until>?', h, now()) })); },
    messagesOf(uid, limit = 20) {
      return db.all('SELECT id, room, body, created_at at, hidden, held, deleted, mod_reason, mod_by FROM messages WHERE uid=? ORDER BY id DESC LIMIT ?', uid, Math.min(100, limit)).map((m) => ({ ...m, hidden: !!m.hidden, held: !!m.held, deleted: !!m.deleted }));
    },
    recent(limit = 50) {
      return db.all('SELECT * FROM mod_actions ORDER BY id DESC LIMIT ?', limit).map((a) => ({ ...a, meta: a.meta ? JSON.parse(a.meta) : null, short: a.uid ? shortId(a.uid) : null, name: a.uid ? (user(a.uid)?.name || user(a.uid)?.username || shortId(a.uid)) : null,
        undoable: !a.undone_at && ['hide', 'hold', 'hide_all', 'unhide', 'mute', 'kick', 'ban', 'unban', 'unmute', 'lift_ip'].includes(a.action) }));
    },
  };
  return mod;
}
