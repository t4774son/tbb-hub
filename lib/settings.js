// Admin settings: a short whitelist, each with a strict shape. Stored as JSON in the `settings` table; the public site
// reads them on every /api/state. Anything not listed here cannot be set at all.
import { bad } from './http.js';

const plain = (v, max, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return s;
};
const bool = (v, field) => { if (typeof v !== 'boolean') throw bad(`${field} must be on or off.`); return v; };
// Longer admin text that keeps its line breaks (the story): control characters out, Windows line ends normalised, trimmed.
const multiline = (v, max, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (s.length > max) throw bad(`${field} is too long (max ${max.toLocaleString('en-US')} characters).`);
  return s;
};
// The areas the admin can open from the panel. Each one is also capped by the server (.env): closed there = closed, whatever this says.
export const AREAS = ['chat', 'accounts'];
// Links inside admin text: https only, a real public host, no credentials (the same rules as the Links box).
export function checkLinks(text, safeUrl) {
  for (const m of text.matchAll(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi)) {
    const raw = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!/^https:\/\//i.test(raw)) throw bad('Links in the text must start with https://.');
    safeUrl(raw); // throws its own clear message
  }
  if (/javascript:|data:|vbscript:/i.test(text)) throw bad('That text contains something that is not a link.');
}

export const SETTINGS = {
  banner: {
    default: { on: false, text: '', tone: 'info' },
    check(v, { safeUrl }) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Banner must be an object.');
      const text = plain(v.text, 160, 'Banner text'); checkLinks(text, safeUrl);
      const tone = v.tone === 'warn' ? 'warn' : v.tone === 'info' || v.tone === undefined ? 'info' : null; if (!tone) throw bad('Tone must be info or warn.');
      const on = bool(v.on ?? false, 'Banner');
      if (on && !text) throw bad('Write the announcement before turning it on.');
      return { on, text, tone };
    },
  },
  maintenance: {
    default: { on: false, text: '' },
    check(v, { safeUrl }) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Maintenance must be an object.');
      const text = plain(v.text, 160, 'Maintenance note'); checkLinks(text, safeUrl);
      return { on: bool(v.on ?? false, 'Maintenance'), text };
    },
  },
  // Read-only sections the admin may hide. Nothing here opens a write.
  sections: {
    default: { season: true, chart: true, learn: true, lore: true },
    check(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Sections must be an object.');
      const out = {};
      for (const k of Object.keys(SETTINGS.sections.default)) out[k] = bool(v[k] ?? true, `Section ${k}`);
      for (const k of Object.keys(v)) if (!(k in out)) throw bad(`Unknown section: ${String(k).slice(0, 30)}.`);
      return out;
    },
  },
  // The admin's story, shown in the Story tab. Plain text with **bold**, *italic* and https links; never HTML.
  story_title: { default: '', check: (v) => plain(v, 80, 'Story title') },
  story_body: { default: '', check(v, { safeUrl }) { const t = multiline(v, 20_000, 'Story'); checkLinks(t, safeUrl); return t; } },
  // Panel switches for the launch areas. Default closed; the server setting is the ceiling (lib/app.js applies both).
  areas: {
    default: Object.fromEntries(AREAS.map((k) => [k, false])),
    check(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Areas must be an object.');
      const out = {};
      for (const k of AREAS) out[k] = bool(v[k] ?? false, `Area ${k}`);
      for (const k of Object.keys(v)) if (!(k in out)) throw bad(`Unknown area: ${String(k).slice(0, 30)}.`);
      return out;
    },
  },
};

export function makeSettings(db, { safeUrl }) {
  const cache = new Map();
  function get(key) {
    if (!SETTINGS[key]) throw bad('Unknown setting.', 404);
    if (cache.has(key)) return cache.get(key);
    const row = db.get('SELECT v FROM settings WHERE k=?', key);
    let v = SETTINGS[key].default;
    if (row) { try { v = SETTINGS[key].check(JSON.parse(row.v), { safeUrl }); } catch { v = SETTINGS[key].default; } }
    cache.set(key, v); return v;
  }
  return {
    get,
    all: () => Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, get(k)])),
    // Validate, store, return {before, after}. Throws a clear 4xx on anything outside the shape.
    set(key, value) {
      if (!Object.hasOwn(SETTINGS, key)) throw bad('Unknown setting.', 404);
      const after = SETTINGS[key].check(value, { safeUrl }); const before = get(key);
      db.run('INSERT INTO settings(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at', key, JSON.stringify(after), Date.now());
      cache.set(key, after);
      return { before, after };
    },
  };
}
