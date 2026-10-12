import { parseStory } from './storytext.js';
export const CA = '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump';
// Tiny DOM helpers. All dynamic text goes in via textContent — never innerHTML.
// Links: in-page (#/...), same-site paths, or https. Never '//' or '/\\' (both mean another site), never http.
// src: the same, plus inline images (data:image/...). Values are trimmed; a control character or backslash anywhere
// drops the attribute; srcset, ping, srcdoc, formaction, action and xlink:href are never set. admin/admin.js carries
// the same rules (keep them identical: test/unit/hardening.test.js checks both).
const SAFE_URL = /^(#|\/(?![\/\\])|https:\/\/|mailto:)/i;
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;
const NO_ATTR = new Set(['srcset', 'ping', 'srcdoc', 'formaction', 'action', 'xlink:href']);
const INLINE_IMG = /^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i;
// The value to set for href/src, or null when it must be dropped.
export function safeUrl(k, v) {
  const s = String(v).trim();
  if (UNSAFE_CHARS.test(s)) return null;
  if (SAFE_URL.test(s) || (k === 'src' && INLINE_IMG.test(s))) return s;
  return null;
}
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.toLowerCase().startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.toLowerCase().startsWith('on')) throw new Error('h(): handlers must be functions');
      else if (k === 'style') throw new Error('h(): use a style object (CSP)');
      else if (NO_ATTR.has(k.toLowerCase())) continue;
      else if (k === 'href' || k === 'src') { const u = safeUrl(k, v); if (u !== null) el.setAttribute(k, u); }
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function clear(el, ...kids) { el.replaceChildren(); append(el, kids); return el; }

const NS = 'http://www.w3.org/2000/svg';
// Hand-drawn 24px stroke icons.
const PATHS = {
  home: 'M3 11 12 4l9 7M5.5 9.5V20h13V9.5M10 20v-5h4v5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  build: 'M14.7 6.3a4 4 0 0 0 5 5L22 9l-3-3-1.7-1.7a4 4 0 0 0-2.6 2zM14 7 3.5 17.5a2.1 2.1 0 0 0 3 3L17 10',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z',
  allies: 'M9 7a3 3 0 1 0 0 .1M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16.5 4.5a3 3 0 0 1 0 5.6M18 14c1.9.8 3 2.9 3 6',
  buy: 'M12 3v18M7 8.5C7 6.6 9.2 5.5 12 5.5s5 1.1 5 3-2.2 2.6-5 3.5-5 1.6-5 3.5 2.2 3 5 3 5-1.1 5-3',
  stake: 'M12 3 3 7.5l9 4.5 9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  calc: 'M6 3h12v18H6zM9 7h6M9 11h.01M12 11h.01M15 11h.01M9 14.5h.01M12 14.5h.01M15 14.5v3M9 18h.01M12 18h.01',
  learn: 'M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  chat: 'M4 5h16v11H9l-5 4z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12.5 10 17 19 7',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  send: 'M4 12 20 4l-5 16-3-7z',
  reply: 'M10 8 5 12l5 4M5 12h9a5 5 0 0 1 5 5v1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  bolt: 'M13 3 5 13h6l-1 8 8-10h-6z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  plus: 'M12 5v14M5 12h14',
  up: 'M12 19V5M6 11l6-6 6 6',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  shield: 'M12 3 4.5 6v6c0 4.5 3.2 7.7 7.5 9 4.3-1.3 7.5-4.5 7.5-9V6z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  xlogo: 'M4 4l16 16M20 4 4 20',
  chart: 'M4 20V4M4 20h16M7 15l4-5 3 3 5-7',
  book: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6',
};
export function icon(name, cls = 'ico') {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', PATHS[name] || PATHS.help); s.append(p);
  return s;
}

// Deterministic identicon from a hex seed (a keyed hash: no account id leaves the server).
export function avatar(seed, size = 32) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 5 5'); s.setAttribute('class', 'avatar'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
  if (seed === 'herd') {
    s.setAttribute('viewBox', '0 0 24 24'); s.classList.add('herd');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M4 6c1 3 3 4 5 4h6c2 0 4-1 5-4M8 10l1 7c.3 1.6 1.5 3 3 3s2.7-1.4 3-3l1-7M10 15h.01M14 15h.01');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.append(p); return s;
  }
  const bits = [...String(seed)].map((c) => parseInt(c, 16) || 0);
  const hue = [28, 33, 38, 20, 44, 210, 190][bits[0] % 7];
  const light = 52 + (bits[1] % 4) * 6;
  const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', 5); bg.setAttribute('height', 5); bg.setAttribute('class', 'av-bg'); s.append(bg);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if ((bits[(y * 3 + x + 2) % bits.length] & 1) === 0) continue;
    for (const xx of x === 2 ? [2] : [x, 4 - x]) {
      const r = document.createElementNS(NS, 'rect'); r.setAttribute('x', xx); r.setAttribute('y', y); r.setAttribute('width', 1.02); r.setAttribute('height', 1.02);
      r.setAttribute('fill', `hsl(${hue} 70% ${light}%)`); s.append(r);
    }
  }
  return s;
}

// ---------- formatting ----------
export function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return '$' + n.toPrecision(3).replace(/0+$/, '');
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 ? 2 : 0 });
}
export const compact = (n) => { const v = Number(n); if (!Number.isFinite(v)) return '—'; const a = Math.abs(v);
  return a >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(1) + 'K' : num(v); };
export const num = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
export function pct(n) { if (n === null || n === undefined || !Number.isFinite(n)) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%'; }
export function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export function until(t) {
  const s = Math.max(0, (t - Date.now()) / 1000);
  const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`;
}
export const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');

// Text with safe, clickable links (built as DOM nodes).
// What users typed is shown exactly as typed: plain text, never anchors (chat is zero-link; see lib/rules.js).
export const plainText = (text) => document.createTextNode(String(text ?? ''));
// Admin text only (the banner): https links become anchors.
const LINK = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
export function richText(text) {
  const frag = document.createDocumentFragment(); let last = 0;
  for (const m of String(text).matchAll(LINK)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    let href = null; try { const u = new URL(m[0]); if (u.protocol === 'https:') href = u.href; } catch { /* plain */ }
    frag.append(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, m[0].replace(/^https?:\/\//, '')) : m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

// The admin's story as DOM: one <p> per paragraph; **bold**, *italic* and https links only (public/js/storytext.js).
export function richStory(text) {
  const node = (t) => t.t === 'text' ? document.createTextNode(t.v) : t.t === 'a' ? h('a', { href: t.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, t.v) : h(t.t === 'b' ? 'strong' : 'em', null, t.v.map(node));
  const frag = document.createDocumentFragment();
  for (const para of parseStory(text)) frag.append(h('p', null, para.map(node)));
  return frag;
}

// ---------- network ----------
// app.js installs hooks.adult = ensureAdult: when the server refuses a write from an account that never confirmed its
// age (403 `adult`), the one plain dialog is asked once and the call is sent again — the same for chat, ideas, votes
// and reports (the page no longer sends the confirmation on its own at sign-in).
export const hooks = { adult: null };
export async function api(path, { method = 'GET', body, retried = false } = {}) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-tbb': '1' }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error(data.error || `Something went wrong (${res.status}).`); e.status = res.status; e.code = data.code;
    if (e.code === 'adult' && hooks.adult && !retried && path !== '/api/me/adult' && (await hooks.adult(true))) return api(path, { method, body, retried: true });
    throw e;
  }
  return data;
}

// ---------- toast ----------
export function toast(text, { kind = 'info', ms = 3600 } = {}) {
  const host = $('#toasts');
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 400); }, ms);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea', { class: 'sr-only' }); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

export function busy(btn, on, label) {
  // The spinner is drawn in CSS; content is only replaced when a temporary label is asked for.
  if (on) { btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); if (label) { btn._kids = [...btn.childNodes]; btn.textContent = label; } }
  else { btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); if (btn._kids) { btn.replaceChildren(...btn._kids); btn._kids = null; } }
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
