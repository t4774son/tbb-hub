// Admin panel. Self-contained: a few DOM helpers, one fetch of /api/panel/panel, and small forms that write back.
// All dynamic text goes through textContent (never innerHTML). Writes carry the X-Admin header; Cloudflare adds the
// Access token to every request on this host.
import { parseStory } from '/js/storytext.js';
const $ = (s, r = document) => r.querySelector(s);
// href/src: the same rules as public/js/ui.js (in-page, same-site path, https, mailto; src also inline images); trimmed;
// a control character or backslash anywhere drops the attribute; srcset, ping, srcdoc, formaction, action and
// xlink:href are never set. test/unit/hardening.test.js checks both copies.
const SAFE_URL = /^(#|\/(?![\/\\])|https:\/\/|mailto:)/i;
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;
const NO_ATTR = new Set(['srcset', 'ping', 'srcdoc', 'formaction', 'action', 'xlink:href']);
const INLINE_IMG = /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i;
function safeUrl(k, v) {
  const s = String(v).trim();
  if (UNSAFE_CHARS.test(s)) return null;
  if (SAFE_URL.test(s) || (k === 'src' && INLINE_IMG.test(s))) return s;
  return null;
}
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.toLowerCase().startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.toLowerCase().startsWith('on')) continue;
    else if (NO_ATTR.has(k.toLowerCase())) continue;
    else if (k === 'href' || k === 'src') { const u = safeUrl(k, v); if (u !== null) el.setAttribute(k, u); }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const clear = (el, ...kids) => { el.replaceChildren(); for (const c of kids.flat(Infinity)) if (c) el.append(c); return el; };
async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json', 'x-admin': '1' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch { /* */ }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}
function toast(text, kind = 'info') {
  const t = h('div', { class: `toast toast-${kind}`, role: 'status' }, text); $('#toasts').append(t);
  requestAnimationFrame(() => t.classList.add('in')); setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 400); }, 3200);
}
const ago = (t) => { if (!t) return 'never'; const s = Math.max(0, (Date.now() - t) / 1000); return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dur = (s) => { const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`; };
const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const num = (n) => Number(n).toLocaleString('en-US');

function sw(label, checked, onchange, { locked = false } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled: locked });
  if (onchange) input.addEventListener('change', () => onchange(input.checked));
  return h('label', { class: 'switch' + (locked ? ' locked' : '') }, input, h('span', { class: 'knob', 'aria-hidden': 'true' }), h('span', null, label));
}
async function save(btn, fn, okMsg = 'Saved.') {
  btn.disabled = true; btn.classList.add('busy');
  try { await fn(); toast(okMsg); await load(); } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.classList.remove('busy'); }
}
const counter = (input, max) => { const c = h('span', { class: 'count' }, `${input.value.length} / ${max}`); input.addEventListener('input', () => { c.textContent = `${input.value.length} / ${max}`; }); return c; };

// ---------- moderation ----------
// The admin's hands: a queue (reports, held messages, community hides, automatic mutes), the people list,
// and a log where every action (panel, rules, community) can be undone. Every action asks for a reason inline.
let modQuery = '';
const KIND_LABEL = { report: 'Report', held: 'Held by the filter', community: 'Hidden by reports', auto_mute: 'Auto-muted', reports_user: 'Many reports' };
const MUTE_LABEL = { 10: '10 min', 60: '1 hour', 1440: '24 hours', 10080: '7 days' };
const DAYS_LABEL = { 1: '24 hours', 7: '7 days', 30: '30 days' };
let ipFilter = null; // { hash, label }: the people list narrowed to one hashed connection
const act = (btn, body, okMsg) => save(btn, () => api('/api/panel/mod/action', body), okMsg);
// Replaces a row's buttons with "why?" + Go/Cancel; the reason goes into the log.
function withReason(host, label, run, placeholder = 'Reason (goes in the log)') {
  const input = h('input', { class: 'input', maxlength: 200, placeholder, 'aria-label': placeholder });
  const go = h('button', { class: 'btn btn-primary btn-sm', onclick: () => { if (!input.value.trim()) { input.focus(); input.classList.add('bad'); return; } run(go, input.value.trim()); } }, label);
  const box = h('div', { class: 'reason' }, input, go, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => box.remove() }, 'Cancel'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') box.remove(); });
  host.querySelector('.reason')?.remove(); host.append(box); input.focus();
}
function muteControl(host, uid, qid) {
  const sel = h('select', { class: 'select input', 'aria-label': 'Mute for' }, Object.entries(MUTE_LABEL).map(([m, l]) => h('option', { value: m }, l)));
  const btn = h('button', { class: 'btn btn-sm', onclick: () => withReason(host, `Mute ${MUTE_LABEL[sel.value]}`, (b, reason) => act(b, { action: 'mute', uid, minutes: Number(sel.value), reason, qid }, 'Muted.')) }, 'Mute');
  return h('span', { class: 'mute-ctl' }, sel, btn);
}
// Ban: the account (24 h / 7 d / 30 d / for good) or the account + the hashed connections it used lately (IP bans are
// 24 h / 7 d / 30 d, default 7 d, never for good: addresses are reused by innocent people, VPN exits and phone carriers).
function withBan(host, uid, qid) {
  const scope = h('select', { class: 'select input', 'aria-label': 'What to ban' }, h('option', { value: 'account' }, 'Ban account'), h('option', { value: 'ip' }, 'Ban account + IP'));
  const days = h('select', { class: 'select input', 'aria-label': 'For how long' }, h('option', { value: 'forever' }, 'for good'), ...Object.entries(DAYS_LABEL).map(([d, l]) => h('option', { value: d }, l)));
  const ipDays = h('select', { class: 'select input', 'aria-label': 'IP ban for how long', hidden: true }, ...Object.entries(DAYS_LABEL).map(([d, l]) => h('option', { value: d, selected: d === '7' }, 'IP ' + l)));
  const input = h('input', { class: 'input', maxlength: 200, placeholder: 'Reason (goes in the log)', 'aria-label': 'Reason' });
  scope.addEventListener('change', () => { ipDays.hidden = scope.value !== 'ip'; });
  const go = h('button', { class: 'btn btn-danger btn-sm', onclick: (e) => {
    if (!input.value.trim()) { input.focus(); input.classList.add('bad'); return; }
    const body = { action: 'ban', uid, reason: input.value.trim(), qid, days: days.value === 'forever' ? null : Number(days.value), ip: scope.value === 'ip', ipDays: Number(ipDays.value) };
    act(e.currentTarget, body, scope.value === 'ip' ? `Banned, and the connection${days.value === 'forever' ? '' : ' too'} for ${DAYS_LABEL[ipDays.value]}.` : 'Banned.');
  } }, 'Ban');
  const box = h('div', { class: 'reason ban-ctl' }, scope, days, ipDays, input, go, h('button', { class: 'btn btn-ghost btn-sm', onclick: () => box.remove() }, 'Cancel'),
    h('p', { class: 'tiny muted m0 ban-note' }, 'Blocked connections can still read the site; they can’t sign up, sign in or post. Shared or reused addresses get caught too, so IP bans are short and never for good.'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') box.remove(); });
  host.querySelector('.reason')?.remove(); host.append(box); input.focus();
}
function userActions(u, host, qid) {
  const w = u.uid; const out = [];
  if (u.banned) out.push(h('button', { class: 'btn btn-sm', onclick: (e) => act(e.currentTarget, { action: 'unban', uid: w, qid }, 'Unbanned (its IP bans lifted too).') }, 'Unban'));
  else {
    if (u.muted) out.push(h('button', { class: 'btn btn-sm', onclick: (e) => act(e.currentTarget, { action: 'unmute', uid: w, qid }, 'Unmuted.') }, 'Unmute'));
    else out.push(muteControl(host, w, qid));
    out.push(h('button', { class: 'btn btn-sm', onclick: () => withReason(host, 'Kick', (b, reason) => act(b, { action: 'kick', uid: w, reason, qid }, 'Kicked (signed out everywhere, muted 24 h).')) }, 'Kick'));
    out.push(h('button', { class: 'btn btn-sm btn-danger', onclick: () => withBan(host, w, qid) }, 'Ban…'));
  }
  return out;
}
// "3 other accounts used this connection" → one click shows them in the people list. Never the IP: only its label.
function reviewConnection(hash, label) { ipFilter = { hash, label }; modQuery = ''; load().then(() => document.querySelector('#people')?.scrollIntoView({ block: 'start' })); }
function connectionsPanelFor(u, host) {
  const box = h('div', { class: 'u-conns' }, h('span', { class: 'muted small' }, 'Loading…'));
  api(`/api/panel/mod/connections?uid=${encodeURIComponent(u.uid)}`).then((r) => clear(box, r.connections.length ? r.connections.map((c) => h('div', { class: 'u-conn' },
    h('span', { class: 'mono' }, c.label), c.banned ? h('span', { class: 'chip chip-orange' }, 'IP banned') : null,
    h('span', { class: 'small muted' }, c.others ? `${c.others} other account${c.others === 1 ? '' : 's'} used this connection` : 'no other account used this connection'),
    c.others ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => reviewConnection(c.hash, c.label) }, 'Review') : null,
    c.banned ? h('button', { class: 'btn btn-sm', onclick: () => withReason(host, 'Lift IP ban', (b, reason) => act(b, { action: 'lift_ip', hash: c.hash, reason }, 'IP ban lifted.')) }, 'Lift') : null))
    : h('span', { class: 'muted small' }, 'No connections in the last 7 days.'))).catch((e) => toast(e.message, 'error'));
  return box;
}
const msgQuote = (m) => (m ? h('blockquote', { class: 'q-msg' + (m.hidden ? ' is-hidden' : '') }, h('span', { class: 'q-room' }, m.room), m.deleted ? h('i', null, 'deleted by its author') : m.body) : h('p', { class: 'muted small m0' }, 'The message is gone.'));

function queuePanel(md) {
  const items = md.queue;
  return h('section', { class: 'panel mod-panel', id: 'queue' }, h('h3', { class: 'h3' }, 'Moderation queue', h('span', { class: items.length ? 'chip chip-orange' : 'chip chip-dim' }, `${items.length}`)),
    h('p', { class: 'small muted m0' }, 'Newest first: reports from members, messages the scam filter held back, messages hidden by community reports, and automatic mutes. Hidden and held messages are never shown to anyone until you approve them.'),
    h('div', { class: 'stack gap8' }, items.length ? items.map((it) => {
      const row = h('div', { class: 'q-item', 'data-kind': it.kind });
      const who = it.user ? h('span', { class: 'q-who' }, h('b', null, it.user.name), ' ', h('span', { class: 'mono muted' }, it.user.short), it.user.muted ? h('span', { class: 'chip chip-dim' }, 'muted') : null, it.user.banned ? h('span', { class: 'chip chip-dim' }, 'banned') : null) : null;
      const head = h('div', { class: 'q-head' }, h('span', { class: 'chip chip-orange' }, KIND_LABEL[it.kind] || it.kind), h('span', { class: 'q-when' }, ago(it.at)), who);
      const body = h('div', { class: 'q-body' });
      const actions = h('div', { class: 'q-actions' });
      const u = it.user ? { uid: it.user.uid, muted: it.user.muted, banned: it.user.banned } : null;
      if (it.kind === 'report' && it.target !== 'message') {
        body.append(h('p', { class: 'm0' }, h('b', null, `${it.target} #${it.targetId}`), ' — ', it.reason), it.reporter ? h('p', { class: 'tiny muted m0' }, `reported by ${it.reporter.name}`) : null);
        if (it.target === 'idea') actions.append(h('button', { class: 'btn btn-sm', onclick: () => withReason(row, 'Hide idea', (b, reason) => act(b, { action: 'hide_idea', id: Number(it.targetId), reason, qid: it.qid }, 'Idea hidden.')) }, 'Hide idea'));
        actions.append(h('button', { class: 'btn btn-sm', onclick: (e) => act(e.currentTarget, { action: 'dismiss', qid: it.qid }, 'Dismissed.') }, 'Dismiss'));
      } else if (it.message || it.kind === 'report') {
        body.append(msgQuote(it.message), h('p', { class: 'tiny muted m0' }, it.kind === 'report' ? `${it.reports} report${it.reports === 1 ? '' : 's'} · “${it.reason}”${it.reporter ? ` · by ${it.reporter.name}` : ''}` : it.reason));
        if (it.message && !it.message.deleted) {
          if (it.message.hidden) actions.append(h('button', { class: 'btn btn-primary btn-sm', onclick: (e) => act(e.currentTarget, { action: 'approve', id: it.message.id, qid: it.qid }, 'Approved: shown to everyone.') }, 'Approve'));
          else actions.append(h('button', { class: 'btn btn-sm', onclick: (e) => act(e.currentTarget, { action: 'dismiss', qid: it.qid }, 'Kept.') }, 'Keep'));
          if (!it.message.hidden || it.message.held) actions.append(h('button', { class: 'btn btn-sm', onclick: () => withReason(row, 'Hide', (b, reason) => act(b, { action: 'hide', id: it.message.id, reason, qid: it.qid }, 'Hidden.')) }, 'Hide'));
        } else actions.append(h('button', { class: 'btn btn-sm', onclick: (e) => act(e.currentTarget, { action: 'dismiss', qid: it.qid }, 'Dismissed.') }, 'Dismiss'));
        if (u) actions.append(...userActions(u, row, it.qid));
      } else {
        body.append(h('p', { class: 'm0' }, it.reason));
        actions.append(h('button', { class: 'btn btn-sm', onclick: (e) => act(e.currentTarget, { action: 'dismiss', qid: it.qid }, 'Noted.') }, 'Noted'));
        if (u) actions.append(...userActions(u, row, it.qid));
      }
      row.append(head, body, actions); return row;
    }) : h('p', { class: 'muted small' }, 'Nothing waiting. The rules filter, the community’s reports and your own actions all land here.')));
}

function peoplePanel(md) {
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or username', 'aria-label': 'Search people' }); search.value = modQuery;
  const list = h('div', { class: 'stack gap6' });
  const draw = (users) => clear(list, users.length ? users.map((u) => {
    const row = h('div', { class: 'u-row' + (u.status !== 'ok' ? ' is-' + u.status : '') });
    const flags = [u.hits ? h('span', { class: 'chip chip-orange' }, `${u.hits} refused 24h`) : null, u.reports ? h('span', { class: 'chip chip-orange' }, `${u.reports} report${u.reports === 1 ? '' : 's'}`) : null,
      u.status === 'muted' ? h('span', { class: 'chip chip-dim' }, `muted until ${when(u.mutedUntil)}`) : u.status === 'banned' ? h('span', { class: 'chip chip-dim' }, u.bannedUntil ? `banned until ${when(u.bannedUntil)}` : 'banned for good') : h('span', { class: 'chip chip-green' }, 'ok'),
      u.ipBans ? h('span', { class: 'chip chip-orange' }, `IP banned (${u.ipBans})`) : null, !u.adult ? h('span', { class: 'chip chip-dim' }, 'no 18+ yet') : null,
      u.x ? h('span', { class: 'chip chip-dim' }, '𝕏 @' + u.x) : null];
    const conns = h('div', { class: 'u-msgs', hidden: true });
    const showConns = h('button', { class: 'btn btn-sm btn-ghost', onclick: (e) => { if (!conns.hidden) { conns.hidden = true; e.currentTarget.textContent = 'Connections'; return; } clear(conns, connectionsPanelFor(u, row)); conns.hidden = false; e.currentTarget.textContent = 'Close'; } }, 'Connections');
    const msgs = h('div', { class: 'u-msgs', hidden: true });
    const show = h('button', { class: 'btn btn-sm btn-ghost', onclick: async (e) => {
      if (!msgs.hidden) { msgs.hidden = true; e.currentTarget.textContent = 'Messages'; return; }
      try { const r = await api(`/api/panel/mod/messages?uid=${encodeURIComponent(u.uid)}`); clear(msgs, r.messages.length ? r.messages.map((m) => h('div', { class: 'u-msg' + (m.hidden ? ' is-hidden' : '') }, h('span', { class: 'q-room' }, m.room), h('span', { class: 'u-msg-t' }, m.deleted ? 'deleted' : m.body), h('span', { class: 'tiny muted' }, ago(m.at)),
        m.hidden ? h('button', { class: 'btn btn-sm', onclick: (ev) => act(ev.currentTarget, { action: 'unhide', id: m.id }, 'Shown again.') }, 'Unhide') : m.deleted ? null : h('button', { class: 'btn btn-sm', onclick: () => withReason(row, 'Hide', (b, reason) => act(b, { action: 'hide', id: m.id, reason }, 'Hidden.')) }, 'Hide'))) : h('p', { class: 'muted small m0' }, 'No messages.')); msgs.hidden = false; e.currentTarget.textContent = 'Close'; } catch (x) { toast(x.message, 'error'); }
    } }, 'Messages');
    row.append(h('div', { class: 'u-main' }, h('b', { class: 'u-name' }, u.name || '(no name yet)'), u.username ? h('span', { class: 'mono muted small' }, '@' + u.username) : h('span', { class: 'mono muted small' }, u.short), h('span', { class: 'tiny muted' }, `joined ${ago(u.joined)} · ${num(u.msgs)} message${u.msgs === 1 ? '' : 's'} · ${u.via === 'x' ? 'X' : u.via === 'legacy' ? 'older install' : 'username'} sign-up · ${u.connections} connection${u.connections === 1 ? '' : 's'} (7 d)`)),
      h('div', { class: 'u-flags' }, flags), h('div', { class: 'q-actions' }, show, showConns, u.msgs ? h('button', { class: 'btn btn-sm', onclick: () => withReason(row, 'Hide all (24 h)', (b, reason) => act(b, { action: 'hide_all', uid: u.uid, reason }, 'Hidden everything from the last 24 h.')) }, 'Hide all 24h') : null, ...userActions({ uid: u.uid, muted: u.status === 'muted', banned: u.status === 'banned' }, row)), msgs, conns);
    return row;
  }) : h('p', { class: 'muted small' }, modQuery || ipFilter ? 'Nobody matches.' : 'Nobody has signed up yet.'));
  draw(md.users);
  let t = 0; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { modQuery = search.value; try { draw((await api(`/api/panel/mod?q=${encodeURIComponent(modQuery)}${ipFilter ? '&ip=' + encodeURIComponent(ipFilter.hash) : ''}`)).users); } catch (e) { toast(e.message, 'error'); } }, 250); });
  const filterNote = ipFilter ? h('div', { class: 'notice soft ip-filter' }, h('span', null, `Accounts that used connection ${ipFilter.label} in the last 7 days.`), h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { ipFilter = null; load(); } }, 'Show everyone')) : null;
  return h('section', { class: 'panel mod-panel', id: 'people' }, h('h3', { class: 'h3' }, 'People', h('span', { class: 'chip chip-dim' }, `${md.users.length}${md.users.length === 200 ? '+' : ''}`)),
    h('p', { class: 'small muted m0' }, 'Every account (username + password, or X). Mute = can read, can’t post. Kick = signed out everywhere now + muted 24 h. Ban = signed out, every message hidden, can’t sign in: for 24 h / 7 d / 30 d or for good; “+ IP” also blocks the hashed connections it used lately for a while. All reversible below.'),
    filterNote, search, list);
}

// Active IP bans: a label (we have no IP, only a keyed hash of one), when it ends, why, whose ban brought it, and how
// many other accounts used that connection. Lift any of them in one click.
function ipBansPanel(md) {
  const bans = md.ipBans || [];
  return h('section', { class: 'panel mod-panel', id: 'ipbans' }, h('h3', { class: 'h3' }, 'IP bans', h('span', { class: bans.length ? 'chip chip-orange' : 'chip chip-dim' }, `${bans.length}`)),
    h('p', { class: 'small muted m0' }, 'Connections blocked from signing up, signing in and posting; reading stays open. IPs are never stored: only a scrambled (hashed) form, kept 7 days per account, and bans run 24 h / 7 d / 30 d, never for good.'),
    h('div', { class: 'stack gap6' }, bans.length ? bans.map((b) => { const row = h('div', { class: 'u-row ip-row' });
      row.append(h('div', { class: 'u-main' }, h('b', { class: 'mono' }, b.label), h('span', { class: 'small muted' }, `until ${when(b.until)}`), b.user ? h('span', { class: 'small' }, 'with the ban of ', h('b', null, b.user.name)) : null),
        h('div', { class: 'u-flags' }, h('span', { class: 'chip chip-dim' }, b.reason || 'no reason'), h('span', { class: b.others ? 'chip chip-orange' : 'chip chip-dim' }, b.others ? `${b.others} other account${b.others === 1 ? '' : 's'} used this connection` : 'no other account on it')),
        h('div', { class: 'q-actions' }, b.others ? h('button', { class: 'btn btn-sm', onclick: () => reviewConnection(b.hash, b.label) }, 'Review') : null,
          h('button', { class: 'btn btn-sm', onclick: () => withReason(row, 'Lift', (btn, reason) => act(btn, { action: 'lift_ip', hash: b.hash, reason }, 'IP ban lifted.')) }, 'Lift')));
      return row; }) : h('p', { class: 'muted small' }, 'No connection is blocked right now.')));
}

function modLogPanel(md) {
  const line = (a) => { const what = { hide: 'hid a message', unhide: 'showed a message again', hold: 'held a message', hide_all: `hid ${a.meta?.ids?.length ?? ''} messages (24 h)`, unhide_all: 'showed the messages again', mute: `muted ${a.meta?.minutes ? MUTE_LABEL[a.meta.minutes] || a.meta.minutes + ' min' : ''}`, unmute: 'unmuted', kick: 'kicked',
    ban: `banned ${a.meta?.days ? 'for ' + (DAYS_LABEL[a.meta.days] || a.meta.days + ' d') : 'for good'}${a.meta?.ip ? ` + ${a.meta.ipHashes?.length ?? ''} connection${a.meta.ipHashes?.length === 1 ? '' : 's'} (${DAYS_LABEL[Math.round(((a.meta.ipUntil || a.at) - a.at) / 86400000)] || 'a while'})` : ''}`, unban: 'unbanned', lift_ip: `lifted the IP ban ${a.meta?.label || ''}`, ban_ip: 'put the IP ban back',
    dismiss: 'closed a queue item' }[a.action] || a.action;
    return [h('b', null, a.actor), ` ${what}`, a.name ? [' · ', h('b', null, a.name)] : null, a.reason ? h('span', { class: 'muted' }, ` — ${a.reason}`) : null]; };
  return h('section', { class: 'panel mod-panel', id: 'modlog' }, h('h3', { class: 'h3' }, 'Moderation log', h('span', { class: 'chip chip-dim' }, `last ${md.recent.length}`)),
    h('p', { class: 'small muted m0' }, 'Every action by you (panel), the rules filter (auto) and the community’s reports (community). One click undoes it.'),
    h('div', { class: 'audit' }, md.recent.length ? md.recent.map((a) => h('div', { class: 'audit-row mod-row' + (a.undone_at ? ' is-undone' : '') }, h('span', { class: 'a-when' }, when(a.at)), h('span', { class: 'a-what' }, ...line(a)),
      a.undone_at ? h('span', { class: 'tiny muted' }, 'undone') : a.undoable ? h('button', { class: 'btn btn-sm', onclick: (e) => save(e.currentTarget, () => api('/api/panel/mod/undo', { id: a.id }), 'Undone.') }, 'Undo') : null)) : h('p', { class: 'muted small' }, 'Nothing yet.')));
}

function chatRulesPanel() {
  return h('section', { class: 'panel', id: 'chatrules' }, h('h3', { class: 'h3' }, 'Chat rules', h('span', { class: 'chip chip-dim' }, 'text only')),
    h('ul', { class: 'rules-list small' },
      h('li', null, h('b', null, 'Text only, zero links, no pictures.'), ' Every link shape is refused (including “dot com”, [.] and look-alike letters), as are crypto addresses, private keys and seed phrases. The room says “Links and pictures coming soon.”'),
      h('li', null, h('b', null, 'Scam filter, no AI.'), ' Asking for keys or seed phrases, “DM me”, moving people to Telegram/WhatsApp, giveaways and the like are refused or held here for you. Swearing and strong opinions are not filtered.'),
      h('li', null, h('b', null, 'Automatic escalation.'), ' 3 refused messages in 24 h = 1 h mute; more = 24 h mute and a queue item. Reports from 3 established members hide a message until you look; 5 reports on one person in 24 h mute them for an hour.'),
      h('li', null, h('b', null, '18+.'), ' Posting needs the confirmation on the account.')));
}

// ---------- sections ----------
function statusPanel(d) {
  const s = d.status; const feeds = Object.entries(s.feeds || {});
  const NAMES = { market: 'Price (DexScreener)', chart: '24h chart (GeckoTerminal)', staked: 'TBB staked (Solana RPC)', season: 'Season 1 board', holders: 'Holders (Helius)', btc: 'BTC price', sol: 'SOL price', lore: 'Bitcoin blocks (mempool.space)' };
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Status', h('span', { class: 'chip chip-dim' }, `node ${s.node}`)),
    h('div', { class: 'status-grid' },
      h('div', { class: 'status-cell' }, h('span', { class: 'stat-k' }, 'Up for'), h('span', { class: 'stat-v mono' }, dur(s.uptimeS))),
      h('div', { class: 'status-cell' }, h('span', { class: 'stat-k' }, 'Memory'), h('span', { class: 'stat-v mono' }, `${Math.round(s.memory.rss / 1048576)} MB`)),
      h('div', { class: 'status-cell' }, h('span', { class: 'stat-k' }, 'Bitcoin height'), h('span', { class: 'stat-v mono' }, s.btcHeight ? num(s.btcHeight) : '—')),
      h('div', { class: 'status-cell' }, h('span', { class: 'stat-k' }, 'Accounts'), h('span', { class: 'stat-v mono' }, num(d.accounts?.total ?? 0)), h('span', { class: 'tiny muted' }, `${num(d.accounts?.password ?? 0)} with a password · ${num(d.accounts?.x ?? 0)} with X`)),
      d.accounts?.xToday ? h('div', { class: 'status-cell' }, h('span', { class: 'stat-k' }, 'X sign-ins today'), h('span', { class: 'stat-v mono' }, `${num(d.accounts.xToday.today)} / ${num(d.accounts.xToday.cap)}`), h('span', { class: 'tiny muted' }, 'paid API calls; over the cap the X button hides')) : h('div', { class: 'status-cell' }, h('span', { class: 'stat-k' }, 'Sign in with X'), h('span', { class: 'stat-v mono' }, 'off'), h('span', { class: 'tiny muted' }, 'set X_CLIENT_ID, X_CLIENT_SECRET, X_REDIRECT_URI to turn it on'))),
    h('div', { class: 'feed-list' }, feeds.length ? feeds.map(([k, f]) => {
      const stale = f.okAt && Date.now() - f.okAt > 2 * (f.ttl || 60_000);
      return h('div', { class: 'feed' + (f.error ? ' bad' : stale ? ' stale' : f.okAt ? '' : ' never') },
        h('span', null, h('span', { class: 'dot', 'aria-hidden': 'true' }), NAMES[k] || k),
        h('span', { class: 'feed-when' }, f.okAt ? `last good refresh ${ago(f.okAt)}` : 'no successful refresh yet'),
        h('span', { class: 'muted small' }, f.ttl ? `every ${Math.round(f.ttl / 60_000) || 1} min` : ''),
        f.error ? h('span', { class: 'feed-err' }, `${f.errorAt ? ago(f.errorAt) : ''}: ${f.error}`) : null);
    }) : h('p', { class: 'muted small' }, 'No feed has run yet.')),
    h('p', { class: 'tiny muted m0' }, 'The public page marks a number "delayed" when its feed is older than twice its interval.'));
}

function bannerPanel(d) {
  const v = d.settings.banner; const max = d.limits.banner;
  const text = h('textarea', { class: 'textarea', maxlength: max, placeholder: 'Short announcement, plain text. https:// links only.' }); text.value = v.text || '';
  const tone = h('select', { class: 'select input' }, h('option', { value: 'info', selected: v.tone !== 'warn' }, 'Info (orange)'), h('option', { value: 'warn', selected: v.tone === 'warn' }, 'Warning (red)'));
  const preview = h('div', { class: 'banner-preview' + (v.tone === 'warn' ? ' warn' : '') });
  const draw = () => { clear(preview, text.value.trim() ? [h('strong', null, tone.value === 'warn' ? '⚠' : '•'), text.value.trim()] : []); preview.classList.toggle('warn', tone.value === 'warn'); };
  text.addEventListener('input', draw); tone.addEventListener('change', draw); draw();
  const on = sw(v.on ? 'Showing on the site' : 'Hidden', v.on); const err = h('p', { class: 'err' });
  const btn = h('button', { class: 'btn btn-primary', onclick: () => save(btn, () => api('/api/panel/setting', { key: 'banner', value: { on: $('input', on).checked, text: text.value, tone: tone.value } })) }, 'Save banner');
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Announcement banner', v.on ? h('span', { class: 'chip chip-orange' }, 'on') : h('span', { class: 'chip chip-dim' }, 'off')),
    text, h('div', { class: 'actions' }, tone, counter(text, max)), preview, on, err, h('div', { class: 'actions' }, btn));
}

function maintenancePanel(d) {
  const v = d.settings.maintenance;
  const text = h('input', { class: 'input', maxlength: d.limits.maintenance, placeholder: 'Optional note, e.g. "Back in an hour."' }); text.value = v.text || '';
  const on = sw(v.on ? 'Maintenance mode is ON: visitors see "back soon"' : 'Site is live', v.on);
  const btn = h('button', { class: 'btn ' + (v.on ? 'btn-primary' : ''), onclick: () => {
    const next = $('input', on).checked;
    if (next && !v.on && !confirm('Put the whole public site behind a "back soon" page? The API answers 503 while it is on. This panel keeps working.')) return;
    save(btn, () => api('/api/panel/setting', { key: 'maintenance', value: { on: next, text: text.value } }), next ? 'Maintenance mode is on.' : 'Site is live again.');
  } }, 'Save');
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Maintenance mode', v.on ? h('span', { class: 'chip chip-orange' }, 'ON') : h('span', { class: 'chip chip-green' }, 'live')),
    h('p', { class: 'small muted m0' }, 'Visitors get a calm "back soon" page and every public API answers 503. The admin host is unaffected.'),
    on, text, h('div', { class: 'actions' }, btn));
}

function sectionsPanel(d) {
  const v = d.settings.sections; const state = { ...v };
  const rows = [['season', 'Season 1 (leaders card, stat, tile)'], ['chart', '24h price chart'], ['learn', 'Learn pages'], ['lore', 'Block chain message line']];
  const btn = h('button', { class: 'btn btn-primary', onclick: () => save(btn, () => api('/api/panel/setting', { key: 'sections', value: state })) }, 'Save sections');
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Sections shown'),
    h('p', { class: 'small muted m0' }, 'Read-only parts of the home page you can hide. Nothing here opens a write.'),
    h('div', { class: 'stack gap8' }, rows.map(([k, label]) => sw(label, v[k], (on) => { state[k] = on; }))),
    h('div', { class: 'actions' }, btn));
}

// Launch areas: the server setting is the ceiling; where it allows, an Open/Closed switch that takes effect at once.
function areasPanel(d) {
  const open = d.launch.filter((l) => l.effective).length;
  return h('section', { class: 'panel', id: 'areas' }, h('h3', { class: 'h3' }, 'Launch areas', h('span', { class: open ? 'chip chip-orange' : 'chip chip-dim' }, `${open} open`)),
    h('p', { class: 'small muted m0' }, 'Closed = visitors see “coming soon” and the area’s routes answer the same, at once, no reload. The server setting (.env) is the ceiling: what it keeps closed cannot be opened here.'),
    h('div', { class: 'stack gap6' }, d.launch.map((l) => {
      const flip = (on) => api('/api/panel/area', { id: l.id, open: on }).then(() => { toast(`${l.name}: ${on ? 'open' : 'closed'}.`); load(); }).catch((e) => { toast(e.message, 'error'); load(); });
      return h('div', { class: 'launch' + (l.locked ? ' is-locked' : ''), 'data-area': l.id },
        h('span', { 'aria-hidden': 'true' }, l.locked ? '🔒' : l.effective ? '🟢' : '⚫'), h('span', { class: 'l-name' }, l.name),
        l.locked ? h('span', { class: 'l-state' }, l.locked) : sw(l.open ? 'Open' : 'Closed', l.open, flip));
    })));
}
// The story (Story tab on the home page): a big editor with a live preview; the draft stays in this browser until saved.
const DRAFT_KEY = 'tbb-story-draft';
function storyPanel(d) {
  const maxT = d.limits.storyTitle; const maxB = d.limits.storyBody;
  const title = h('input', { class: 'input', maxlength: maxT, placeholder: 'Title (optional)' }); title.value = d.settings.story_title || '';
  const body = h('textarea', { class: 'textarea story-editor', maxlength: maxB, placeholder: 'Write it here. Blank line = new paragraph. **bold**, *italic*, https:// links. Nothing else is needed.', spellcheck: 'true' }); body.value = d.settings.story_body || '';
  const preview = h('div', { class: 'story story-preview' }); const note = h('p', { class: 'small muted m0 draft-note' });
  const node = (t) => t.t === 'text' ? document.createTextNode(t.v) : t.t === 'a' ? h('a', { href: t.href, target: '_blank', rel: 'noopener noreferrer' }, t.v) : h(t.t === 'b' ? 'strong' : 'em', null, t.v.map(node));
  const draw = () => { const paras = parseStory(body.value); clear(preview, paras.length ? paras.map((p) => h('p', null, p.map(node))) : h('p', { class: 'muted' }, 'The story is coming.')); };
  let draft = null; try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* */ }
  const discard = h('button', { class: 'btn btn-sm btn-ghost', hidden: true, onclick: () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ } title.value = d.settings.story_title || ''; body.value = d.settings.story_body || ''; note.textContent = ''; discard.hidden = true; draw(); } }, 'Discard draft');
  if (draft && typeof draft.body === 'string' && (draft.body !== body.value || (draft.title || '') !== title.value)) {
    title.value = draft.title || ''; body.value = draft.body; note.textContent = `Unsaved draft from ${ago(draft.at)} restored. Save it or discard it.`; discard.hidden = false;
  }
  const keep = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: title.value, body: body.value, at: Date.now() })); } catch { /* */ } note.textContent = 'Draft kept in this browser (not saved yet).'; discard.hidden = false; };
  body.addEventListener('input', () => { draw(); keep(); }); title.addEventListener('input', keep); draw();
  const btn = h('button', { class: 'btn btn-primary', onclick: () => save(btn, async () => {
    await api('/api/panel/setting', { key: 'story_title', value: title.value }); await api('/api/panel/setting', { key: 'story_body', value: body.value });
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
  }, 'Story saved.') }, 'Save story');
  return h('section', { class: 'panel story-panel', id: 'story' }, h('h3', { class: 'h3' }, 'Story', h('span', { class: 'chip chip-dim' }, d.settings.story_body ? 'published' : 'empty')),
    h('p', { class: 'small muted m0' }, 'Shown in the Story tab at the bottom of the home page. Plain text; paragraphs from blank lines; **bold**, *italic* and https:// links. Never HTML.'),
    title, h('div', { class: 'actions' }, h('span', { class: 'label' }, 'Story'), counter(title, maxT)), body, h('div', { class: 'actions' }, counter(body, maxB)),
    h('span', { class: 'label' }, 'Preview'), preview, note, h('div', { class: 'actions' }, btn, discard));
}

function linksPanel(d) {
  const f = { id: null, title: h('input', { class: 'input', maxlength: d.limits.linkTitle, placeholder: 'Title (e.g. TBB Time Machine)' }), url: h('input', { class: 'input', placeholder: 'https://…', inputmode: 'url' }), blurb: h('input', { class: 'input', maxlength: d.limits.linkBlurb, placeholder: 'One line about it' }) };
  const formTitle = h('span', { class: 'label' }, 'Add a link');
  const cancel = h('button', { class: 'btn btn-ghost', hidden: true, onclick: () => { f.id = null; f.title.value = f.url.value = f.blurb.value = ''; formTitle.textContent = 'Add a link'; cancel.hidden = true; add.textContent = 'Add link'; } }, 'Cancel');
  const add = h('button', { class: 'btn btn-primary', onclick: () => save(add, () => api('/api/panel/link', { id: f.id, title: f.title.value, url: f.url.value, blurb: f.blurb.value }), f.id ? 'Link updated.' : 'Link added.') }, 'Add link');
  const order = d.links.map((l) => l.id);
  const move = (btn, id, dir) => { const i = order.indexOf(id); const j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; save(btn, () => api('/api/panel/links/order', { ids: order }), 'Order saved.'); };
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Links', h('span', { class: 'chip chip-dim' }, `${d.links.length}`)),
    h('p', { class: 'small muted m0' }, 'The Links tab at the bottom of the home page, in this order. https:// only.'),
    h('div', { class: 'stack gap6' }, d.links.length ? d.links.map((l, i) => h('div', { class: 'link-item' },
      h('div', null, h('div', { class: 'l-title' }, l.title), h('div', { class: 'l-url' }, l.url)),
      h('div', { class: 'l-tools' },
        h('button', { class: 'btn', 'aria-label': 'Move up', disabled: i === 0, onclick: (e) => move(e.currentTarget, l.id, -1) }, '↑'),
        h('button', { class: 'btn', 'aria-label': 'Move down', disabled: i === d.links.length - 1, onclick: (e) => move(e.currentTarget, l.id, 1) }, '↓'),
        h('button', { class: 'btn', onclick: () => { f.id = l.id; f.title.value = l.title; f.url.value = l.url; f.blurb.value = l.blurb; formTitle.textContent = `Editing “${l.title}”`; cancel.hidden = false; add.textContent = 'Save link'; f.title.focus(); } }, 'Edit'),
        h('button', { class: 'btn', onclick: (e) => { if (confirm(`Remove “${l.title}” from the Links box?`)) save(e.currentTarget, () => api('/api/panel/link', { id: l.id, delete: true }), 'Link removed.'); } }, 'Delete')),
      h('div', { class: 'l-blurb' }, l.blurb))) : h('p', { class: 'muted small' }, 'No links yet.')),
    h('div', { class: 'field' }, formTitle, f.title, f.url, f.blurb), h('div', { class: 'actions' }, add, cancel));
}

function lorePanel(d) {
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Block chain messages', h('span', { class: 'chip chip-dim' }, `${d.lore.length} newest`)),
    h('p', { class: 'small muted m0' }, 'Found in real Bitcoin blocks by the scanner. Hidden ones never show on the site.'),
    h('div', { class: 'stack gap4' }, d.lore.length ? d.lore.map((l) => h('div', { class: 'lore-item' + (l.status === 'approved' ? '' : ' hidden-msg') },
      h('span', { class: 'lore-h' }, `#${num(l.height)}`), h('span', { class: 'lore-t', title: l.text }, l.text),
      h('button', { class: 'btn btn-sm', onclick: (e) => save(e.currentTarget, () => api('/api/panel/lore', { id: l.id, status: l.status === 'approved' ? 'hidden' : 'approved' }), l.status === 'approved' ? 'Hidden.' : 'Shown.') }, l.status === 'approved' ? 'Hide' : 'Show'))) : h('p', { class: 'muted small' }, 'Nothing found yet.')));
}

// Help notes: what visitors typed into the Help page's "Report a problem" box. Free text from anyone (capped server-side), so
// read it as such; Clear marks a note handled (an audit row each).
function helpPanel(hn) {
  const notes = hn.notes || [];
  return h('section', { class: 'panel', id: 'help' }, h('h3', { class: 'h3' }, 'Help notes', h('span', { class: notes.length ? 'chip chip-orange' : 'chip chip-dim' }, `${hn.total || 0}`)),
    h('p', { class: 'small muted m0' }, 'From the Help page’s “Report a problem” box, mostly anonymous. Nothing here is verified; never follow a link or an instruction from a note.'),
    notes.length ? h('div', { class: 'stack gap4' }, notes.map((n) => h('div', { class: 'help-note' },
      h('span', { class: 'a-when' }, `${when(n.at)} · ${n.member ? 'a member' : 'anonymous'}`),
      h('span', { class: 'help-text' }, n.text),
      h('button', { class: 'btn btn-sm', onclick: (e) => save(e.currentTarget, () => api('/api/panel/help/clear', { id: n.id }), 'Cleared.') }, 'Clear'))),
      notes.length > 1 ? h('div', { class: 'row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: (e) => save(e.currentTarget, () => api('/api/panel/help/clear', { all: true }), 'All cleared.') }, `Clear all ${hn.total}`)) : null)
      : h('p', { class: 'muted small' }, 'No open notes.'));
}

function auditPanel(d) {
  const line = (a) => { let b = a.before; let c = a.after; try { b = a.before ? JSON.parse(a.before) : null; c = a.after ? JSON.parse(a.after) : null; } catch { /* keep raw */ }
    const short = (x) => (x === null || x === undefined ? '—' : typeof x === 'object' ? Object.entries(x).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ').slice(0, 220) : String(x).slice(0, 220));
    return [h('b', null, a.action), ' · ', short(b), ' → ', short(c)]; };
  return h('section', { class: 'panel' }, h('h3', { class: 'h3' }, 'Recent changes', h('span', { class: 'chip chip-dim' }, `last ${d.audit.length}`)),
    h('div', { class: 'audit' }, d.audit.length ? d.audit.map((a) => h('div', { class: 'audit-row' }, h('span', { class: 'a-when' }, `${when(a.at)} · ${a.actor}`), h('span', { class: 'a-what' }, ...line(a)))) : h('p', { class: 'muted small' }, 'No changes yet.')));
}

async function load() {
  try {
    const [d, md, hn] = await Promise.all([api('/api/panel/panel'), api(`/api/panel/mod?q=${encodeURIComponent(modQuery)}${ipFilter ? '&ip=' + encodeURIComponent(ipFilter.hash) : ''}`), api('/api/panel/help')]);
    clear($('#panel'), statusPanel(d), queuePanel(md), peoplePanel(md), ipBansPanel(md), modLogPanel(md), helpPanel(hn), chatRulesPanel(), areasPanel(d), bannerPanel(d), storyPanel(d), maintenancePanel(d), sectionsPanel(d), linksPanel(d), lorePanel(d), auditPanel(d));
    $('#whoami').textContent = `Signed in as the admin · ${when(Date.now())}`;
  } catch (e) { clear($('#panel'), h('div', { class: 'empty' }, h('div', { class: 'serif' }, 'Not allowed.'), h('p', null, e.message))); }
}
load();
setInterval(() => { if (document.visibilityState === 'visible' && !document.activeElement?.matches?.('input, textarea, select')) load(); }, 60_000);
