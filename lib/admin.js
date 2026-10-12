// The admin panel. It answers only on ADMIN_HOST, and only when every request carries a Cloudflare Access
// token that checks out (lib/access.js). The launch areas (chat, accounts) have an Open/Closed switch here, but the
// server setting (.env) is the ceiling: an area the server keeps closed cannot be opened from a browser. Every admin
// action lives here: there is no admin account or role on the public host (members' things are reached through `ops`,
// lib/app.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, readBody, makeLimiter, bad, HttpError } from './http.js';
import { MUTE_MINUTES, BAN_DAYS, IP_BAN_DAYS } from './moderation.js';
import { buildAssets, serveAsset } from './assets.js';
import { SETTINGS, AREAS } from './settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LAUNCH = [['chat', 'Chat', 'chatOpen'], ['accounts', 'Accounts & sign-in', 'accountsOpen']];
export const LOCKED_MSG = 'Locked — opens after the outside audit (server setting)';
const BODY_LIMIT = { 'POST /api/panel/setting': 96 * 1024 }; // the story can be 20,000 characters; everything else is small
const summary = (v) => (v === undefined ? null : JSON.stringify(v).slice(0, 400));

export function makeAdmin({ config, db, settings, verify, siteAssets, safeUrl, status, mod, ops, xStatus = () => null, log = () => {}, onChange = () => {}, onLoreChange = () => {} }) {
  let assets = buildAssets(path.join(ROOT, 'admin'), { extra: siteAssets, hash: false });
  const allow = makeLimiter();
  const audit = (action, before, after) => db.run('INSERT INTO admin_audit(at,action,before,after,actor) VALUES(?,?,?,?,?)', Date.now(), action, summary(before), summary(after), 'panel');
  const str = (v, max, field) => { const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''; if (!s) throw bad(`${field} is required.`); if (s.length > max) throw bad(`${field} is too long (max ${max}).`); return s; };
  const linkRow = (id) => db.get('SELECT id,title,url,blurb,sort FROM allies WHERE id=?', id);
  const shortId = (s) => (typeof s === 'string' && s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-4) : null); // the audit log never keeps a whole account id

  const routes = {
    'GET /api/panel/panel': async () => ({
      settings: settings.all(),
      limits: { banner: 160, maintenance: 160, linkTitle: 60, linkBlurb: 160, storyTitle: 80, storyBody: 20_000 },
      links: db.all('SELECT id,title,url,blurb,sort FROM allies ORDER BY sort, id'),
      lore: db.all('SELECT id,height,kind,text,status FROM lore ORDER BY id DESC LIMIT 60'),
      audit: db.all('SELECT id,at,action,before,after,actor FROM admin_audit ORDER BY id DESC LIMIT 50'),
      // env = the server ceiling; open = the panel switch; effective = both (what visitors get)
      launch: LAUNCH.map(([id, name, k]) => ({ id, name, env: !!config[k], open: !!settings.get('areas')[id], effective: !!config[k] && !!settings.get('areas')[id], locked: !config[k] ? LOCKED_MSG : null })),
      status: status(),
      mod: { queue: mod.queue().length, muted: db.get('SELECT COUNT(*) n FROM users WHERE muted_until>?', Date.now()).n, banned: db.get('SELECT COUNT(*) n FROM users WHERE banned=1 AND (ban_until=0 OR ban_until>?)', Date.now()).n, ipBans: mod.ipBans().length },
      accounts: { total: db.get('SELECT COUNT(*) n FROM users').n, password: db.get('SELECT COUNT(*) n FROM users WHERE pass_hash IS NOT NULL').n, x: db.get('SELECT COUNT(*) n FROM users WHERE x_id IS NOT NULL').n, xToday: xStatus() },
    }),
    // ---- moderation (lib/moderation.js). No AI: the rules filter, the admin's hands, and the community's reports.
    'GET /api/panel/mod': async (body, q) => ({
      queue: mod.queue(), users: mod.users(q.get('q') || '', { ipHash: q.get('ip') || null }), recent: mod.recent(50), muteMinutes: MUTE_MINUTES, banDays: BAN_DAYS, ipBanDays: IP_BAN_DAYS,
      ipBans: mod.ipBans(),
    }),
    // one account's hashed connections (labels only) and who else used them
    'GET /api/panel/mod/connections': async (body, q) => { const uid = String(q.get('uid') || ''); if (!uid) throw bad('Which person?'); return { uid, connections: mod.connectionsOf(uid) }; },
    'GET /api/panel/mod/messages': async (body, q) => {
      const uid = String(q.get('uid') || ''); if (!uid) throw bad('Which person?');
      return { uid, messages: mod.messagesOf(uid, Number(q.get('limit')) || 20) };
    },
    // One action, one reason, one audit row, one undo button.
    'POST /api/panel/mod/action': async (body) => {
      const action = String(body.action || '');
      const reason = typeof body.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
      const needsReason = ['hide', 'hide_all', 'mute', 'kick', 'ban', 'lift_ip', 'hide_idea'].includes(action);
      if (needsReason && !reason) throw bad('Say why (the reason goes in the log).');
      const uid = typeof body.uid === 'string' ? body.uid.slice(0, 60) : null;
      const id = Number(body.id) || null;
      const opts = { actor: 'panel', reason: reason || 'panel review' };
      // close the queue item first: a report's reporters were right when the content is punished, overruled when it is approved
      if (body.qid && action !== 'dismiss') mod.closeQueueItem(String(body.qid), { punished: ['hide', 'hide_all', 'mute', 'kick', 'ban', 'hide_idea'].includes(action) });
      let actionId;
      switch (action) {
        case 'hide': actionId = mod.hide(id, opts); break;
        case 'unhide': case 'approve': actionId = mod.unhide(id, opts); break;
        case 'hide_all': actionId = mod.hideAll(uid, { ...opts, hours: 24 }); break;
        case 'mute': actionId = mod.mute(uid, Number(body.minutes), opts); break;
        case 'unmute': actionId = mod.unmute(uid, opts); break;
        case 'kick': actionId = mod.kick(uid, opts); break;
        case 'ban': actionId = mod.ban(uid, { ...opts, days: body.days === null || body.days === undefined || body.days === 'forever' ? null : Number(body.days), ip: body.ip === true, ipDays: body.ipDays === undefined ? 7 : Number(body.ipDays) }); break;
        case 'unban': actionId = mod.unban(uid, { ...opts, ids: db.all("SELECT id FROM messages WHERE uid=? AND mod_reason='banned'", uid).map((r) => r.id) }); break;
        case 'lift_ip': actionId = mod.liftIp(String(body.hash || ''), opts); break;
        case 'dismiss': actionId = mod.dismiss(String(body.qid || ''), opts); break;
        case 'hide_idea': ops.hideIdea(id); break; // a reported idea: off the board (lib/app.js ops)
        default: throw bad('Unknown action.', 404);
      }
      audit(`mod:${action}`, uid ? { uid: shortId(uid), id } : { id }, { reason: opts.reason, action: actionId, ...(action === 'ban' ? { days: body.days ?? 'forever', ip: body.ip === true } : {}) });
      return { ok: true, action: actionId };
    },
    'POST /api/panel/mod/undo': async (body) => {
      const id = Number(body.id); if (!id) throw bad('Which action?');
      const undoId = mod.undo(id, { actor: 'panel' });
      audit('mod:undo', { action: id }, { action: undoId });
      return { ok: true, action: undoId };
    },
    'POST /api/panel/setting': async (body) => {
      const key = typeof body.key === 'string' && Object.hasOwn(SETTINGS, body.key) ? body.key : null;
      if (!key) throw bad('Unknown setting.', 404);
      if (key === 'areas') throw bad('Use the area switches.', 400); // one flip per request, each one audited by name
      const { before, after } = settings.set(key, body.value);
      audit(`setting:${key}`, before, after); onChange(key);
      return { ok: true, value: after };
    },
    // One launch area, Open or Closed. Fail-closed: refused outright when the server setting keeps it shut.
    'POST /api/panel/area': async (body) => {
      const id = AREAS.includes(body.id) ? body.id : null; if (!id) throw bad('Unknown area.', 404);
      if (typeof body.open !== 'boolean') throw bad('Open must be on or off.');
      const env = !!config[LAUNCH.find(([k]) => k === id)[2]];
      if (body.open && !env) throw bad(LOCKED_MSG + '.', 403);
      const cur = settings.get('areas');
      const { before, after } = settings.set('areas', { ...cur, [id]: body.open });
      audit(`area:${id}`, before[id] ? 'open' : 'closed', after[id] ? 'open' : 'closed'); onChange('areas');
      return { ok: true, open: after[id], effective: env && after[id] };
    },
    'POST /api/panel/link': async (body) => {
      if (body.delete) {
        const before = linkRow(Number(body.id)); if (!before) throw bad('No such link.', 404);
        db.run('DELETE FROM allies WHERE id=?', before.id); audit('link:delete', before, null);
        return { ok: true };
      }
      const title = str(body.title, 60, 'Title'); const url = safeUrl(body.url); const blurb = str(body.blurb, 160, 'Blurb');
      if (!url) throw bad('Link is required.');
      if (body.id) {
        const before = linkRow(Number(body.id)); if (!before) throw bad('No such link.', 404);
        db.run('UPDATE allies SET title=?,url=?,blurb=? WHERE id=?', title, url, blurb, before.id);
        audit('link:edit', before, linkRow(before.id)); return { ok: true, id: before.id };
      }
      if (db.get('SELECT COUNT(*) n FROM allies').n >= 60) throw bad('That is plenty of links already (60).');
      const sort = (db.get('SELECT MAX(sort) m FROM allies').m ?? -1) + 1;
      const r = db.run('INSERT INTO allies(title,url,blurb,sort) VALUES(?,?,?,?)', title, url, blurb, sort);
      audit('link:add', null, linkRow(r.lastInsertRowid)); return { ok: true, id: Number(r.lastInsertRowid) };
    },
    'POST /api/panel/links/order': async (body) => {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
      const current = db.all('SELECT id FROM allies ORDER BY sort, id').map((r) => r.id);
      if (!ids || ids.length !== current.length || ids.length > 200 || !ids.every((x) => Number.isInteger(x)) || new Set(ids).size !== ids.length || ids.some((x) => !current.includes(x))) throw bad('Send every link id exactly once.');
      db.tx(() => ids.forEach((id, i) => db.run('UPDATE allies SET sort=? WHERE id=?', i, id)));
      audit('links:order', current, ids); return { ok: true };
    },
    // Help notes: the public Help page's "Report a problem" box (the one anonymous write). Read and cleared here only (the
    // public host has no admin page). Clearing deletes the row and checkpoints the log: the text exists nowhere afterwards
    // (secure_delete, lib/db.js), and the audit row records only that a note was cleared and which id, never what it said.
    'GET /api/panel/help': async () => ({
      notes: db.all("SELECT id, reason, created_at, (uid IS NOT NULL) AS member FROM reports WHERE kind='problem' ORDER BY id DESC LIMIT 200").map((r) => ({ id: r.id, text: r.reason, at: r.created_at, member: !!r.member })),
      total: db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem'").n,
    }),
    'POST /api/panel/help/clear': async (body) => {
      if (body.all === true) {
        const n = db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem'").n;
        db.run("DELETE FROM reports WHERE kind='problem'"); db.checkpoint();
        audit('help:clear_all', { open: n }, { cleared: n }); return { ok: true, cleared: n };
      }
      const id = Number(body.id); const note = id ? db.get("SELECT id FROM reports WHERE id=? AND kind='problem'", id) : null;
      if (!note) throw bad('No such note.', 404);
      db.run('DELETE FROM reports WHERE id=?', note.id); db.checkpoint();
      audit('help:clear', { id: note.id }, { cleared: 1 }); return { ok: true, cleared: 1 };
    },
    'POST /api/panel/lore': async (body) => {
      const st = body.status === 'approved' ? 'approved' : body.status === 'hidden' ? 'hidden' : null; if (!st) throw bad('Status must be approved or hidden.');
      const before = db.get('SELECT id,height,status FROM lore WHERE id=?', Number(body.id)); if (!before) throw bad('No such message.', 404);
      db.run('UPDATE lore SET status=? WHERE id=?', st, before.id); onLoreChange();
      audit('lore:' + st, before, { ...before, status: st }); return { ok: true };
    },
  };

  async function handle(req, res, ip, p) {
    if (!verify.configured) return send(res, 404, 'Not found');
    try {
      if (!allow('adm:' + ip, 600, 300)) throw bad('Slow down a little.', 429); // one admin; this only caps token checks
      const tok = req.headers['cf-access-jwt-assertion'];
      const v = await verify.verify(typeof tok === 'string' ? tok : '');
      if (!v.ok) { log('admin denied', v.reason); throw bad('Not allowed.', 403); }
      if (p.startsWith('/api/')) {
        const h = routes[`${req.method} ${p}`];
        if (!h) throw bad('Not found', 404);
        const q = new URL(req.url, 'http://x').searchParams;
        let body = {};
        if (req.method !== 'GET') {
          if (req.headers['x-admin'] !== '1') throw bad('Missing header.', 403);
          if (req.headers.origin !== config.adminOrigin) throw bad('Cross-site request blocked.', 403);
          if (!allow('admw:' + ip, 120, 60)) throw bad('Slow down a little.', 429);
          body = await readBody(req, BODY_LIMIT[`${req.method} ${p}`] || 16 * 1024);
        }
        return send(res, 200, await h(body, q));
      }
      if (config.devAssets && p === '/' && assets.changed()) assets = buildAssets(path.join(ROOT, 'admin'), { extra: siteAssets, hash: false });
      const own = req.method === 'GET' || req.method === 'HEAD' ? assets.get(p === '/' ? '/index.html' : p) : null;
      if (own) return serveAsset(req, res, own, { noStore: true, extraHeaders: { 'X-Robots-Tag': 'noindex, nofollow' } });
      // Styles, fonts, images, and the one shared script (the story text parser, for the editor preview). No other site code.
      if (/^\/(css|fonts|img)\//.test(p) || /^\/js\/(storytext|theme)(\.[0-9a-f]{10})?\.js$/.test(p)) { const e = siteAssets.get(p); if (e) return serveAsset(req, res, e, { immutable: siteAssets.isHashed(p) }); }
      throw bad('Not found', 404);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log('admin error', req.method, p, String(e.stack || e.message).split(ROOT).join('.'));
      return send(res, 500, { error: 'Something broke on our side. Try again in a moment.' });
    }
  }
  return { handle, ready: assets.ready };
}
