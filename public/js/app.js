// The Bitcoin Bull — client core: state, router, home screen, live updates, the account button, Easter eggs.
import { h, $, $$, clear, icon, avatar, usd, pct, num, compact, ago, api, toast, copy, reducedMotion, richText, richStory, CA, hooks } from './ui.js';

const SITE_TITLE = 'The Bitcoin Bull · $TBB community dashboard';
import { VIEWS } from './views.js';

export const S = { features: { chat: false, accounts: false, ideas: false }, me: null, stats: null, alerts: [], rooms: [], counts: {}, lore: null, height: null, voteCloses: 0, story: null };
const bus = new EventTarget();
export const on = (ev, f) => { const w = (e) => f(e.detail); bus.addEventListener(ev, w); return () => bus.removeEventListener(ev, w); };
const fire = (ev, d) => bus.dispatchEvent(new CustomEvent(ev, { detail: d }));

// ---------- theme ----------
const root = document.documentElement;
function setTheme(t, { save = true } = {}) {
  root.dataset.theme = t;
  if (save) try { localStorage.setItem('tbb-theme', t); } catch { /* private mode */ }
  clear($('#themeBtn'), icon(t === 'dark' ? 'sun' : 'moon'));
  $('#themeBtn').setAttribute('aria-label', t === 'dark' ? 'Switch to 2009 mode' : 'Switch to night mode');
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0B0B0C' : '#008080';
  fire('theme', t);
}
let saved = null; try { saved = localStorage.getItem('tbb-theme'); } catch { /* */ }
setTheme(saved === 'light' ? 'light' : 'dark', { save: false });

// ---------- icons into static markup ----------
for (const el of $$('[data-i]')) el.prepend(icon(el.dataset.i));
$('.ca-ico').append(icon('copy'));
$('.account-ico').append(icon('user'));
$('#sheetBack').append(icon('back')); $('#sheetClose').append(icon('close'));
$('.tool-chat').append(icon('chat')); $('.tool-build').append(icon('bolt'));
$('#seasonOpen').prepend(icon('star'));
for (const g of $$('.grid, .tiles')) g.prepend(h('div', { class: 'lv-head', 'aria-hidden': 'true' }, h('span', null, 'Status'), h('span', null, 'Date'), h('span', null, 'Description')));
$('#drawerClose').append(icon('close'));

// ---------- home rendering ----------
function setStat(id, text, cls) {
  const v = $(`#${id} .stat-v`);
  if (v.textContent !== text) { v.textContent = text; v.classList.remove('tick'); void v.offsetWidth; if (!reducedMotion()) v.classList.add('tick'); }
  v.classList.toggle('up', cls === 'up'); v.classList.toggle('down', cls === 'down');
}
// "updated 2m ago" on every number, ticking in the browser. Older than twice its refresh interval = delayed, shown as such.
function ageLabel(f) {
  if (!f || !f.at) return { text: '', stale: false, title: '' };
  const age = Date.now() - f.at; const stale = age > 2 * f.ttl;
  const t = age < 45_000 ? 'just now' : age < 3600_000 ? `${Math.round(age / 60_000)}m ago` : age < 86400_000 ? `${Math.round(age / 3600_000)}h ago` : `${Math.round(age / 86400_000)}d ago`;
  const every = f.ttl >= 60_000 ? `${Math.round(f.ttl / 60_000)} min` : `${Math.round(f.ttl / 1000)} s`;
  return { text: stale ? `delayed · ${t}` : t, stale, title: `${stale ? 'Delayed: the source has not answered lately. ' : ''}Last updated ${t}; refreshes about every ${every}.` };
}
// No number on screen (no indexer key, source never answered) → no age either: an age next to "—" would be a fake.
let sparkOk = false;
const HAS = { market: () => S.stats?.price != null, holders: () => S.stats?.holders != null, staked: () => !!S.stats?.staked, season: () => !!S.stats?.season, chart: () => sparkOk };
const FEED_NAME = { market: 'Price', chart: '24h chart', holders: 'Holders', staked: 'TBB staked', season: 'Season 1' };
function renderAges() {
  const feeds = S.stats?.feeds || {}; const lines = []; const late = [];
  for (const el of $$('.stat-age')) {
    const a = HAS[el.dataset.feed]?.() ? ageLabel(feeds[el.dataset.feed]) : { text: '' };
    if (a.text) { lines.push(`${FEED_NAME[el.dataset.feed]}: ${a.title}`); if (a.stale) late.push(FEED_NAME[el.dataset.feed].toLowerCase()); }
    // the stat itself only speaks up when its source is late; the panel line below carries the normal "updated" note
    const text = a.stale ? a.text : '';
    if (el.dataset.text !== text) { el.dataset.text = text; if (text) clear(el, h('i', { class: 'age-dot', 'aria-hidden': 'true' }), text); else el.replaceChildren(); }
    el.classList.toggle('stale', a.stale); el.classList.toggle('live', !!a.text && !a.stale); el.title = a.title;
    el.closest('.stat')?.classList.toggle('is-stale', a.stale);
  }
  const line = $('#panelAge'); if (!line) return;
  const main = HAS.market() ? ageLabel(feeds.market) : null;
  if (!main || !main.text) { line.hidden = true; return; }
  line.hidden = false; line.title = lines.join('\n');
  const text = `Updated ${main.stale ? main.text.replace('delayed · ', '') : main.text}${late.length ? ` · delayed: ${late.join(', ')}` : ''}`;
  if (line.dataset.text !== text) { line.dataset.text = text; clear(line, h('i', { class: 'age-dot', 'aria-hidden': 'true' }), text); }
  line.classList.toggle('stale', late.length > 0);
}
function renderStats() {
  const s = S.stats || {};
  renderAges();
  setStat('st-price', s.price ? usd(s.price) : '—');
  setStat('st-24h', pct(s.change24h), s.change24h > 0 ? 'up' : s.change24h < 0 ? 'down' : '');
  setStat('st-holders', s.holders ? num(s.holders) : '—');
  $('#st-holders').hidden = !s.holders; // no number, no stat: a "soon" is not a value
  renderSeason(s.season);
  // under the price: the same price in sats (the BTC price rides along in /api/state) and the market cap, both already fetched
  const sub = $('#st-sub'); const subParts = [];
  if (s.price > 0 && s.btcUsd > 0) subParts.push(`≈ ${sats(s.price / s.btcUsd * 1e8)} sats`);
  if (s.marketCap > 0) subParts.push(`Market cap ${usd(s.marketCap)}`);
  sub.hidden = !subParts.length; sub.textContent = subParts.join(' · ');
  const st = s.staked;
  setStat('st-staked', st && Number.isFinite(st.amount) ? compact(st.amount) : '—');
  // the trend line: 24 h and 7 d from the site's own hourly snapshots; the share of supply until there is any history
  const sd = $('#st-staked-d'); const c = st?.change24h; const c7 = st?.change7d;
  const arrow = (v, label) => `${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}% ${label}`;
  const trend = [Number.isFinite(c) ? arrow(c, '24h') : null, Number.isFinite(c7) ? arrow(c7, '7d') : null].filter(Boolean);
  sd.textContent = trend.length ? trend.join(' · ') : st && Number.isFinite(st.pct) ? `${st.pct.toFixed(1)}% of supply` : '';
  sd.className = 'stat-d mono' + (Number.isFinite(c) ? (c >= 0 ? ' up' : ' down') : '');
  $('#st-staked').title = st ? `${num(Math.round(st.amount))} TBB staked${Number.isFinite(st.pct) ? ` · ${st.pct.toFixed(2)}% of supply` : ''}${st.stakes ? ` · ${num(st.stakes)} stakes` : ''}` : 'Total TBB staked in the staking program';
}
const sats = (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : num(Math.round(v)));
const seasonLeft = (se) => { const left = se.end - Date.now(); return left <= 0 ? 'Ended' : left < 3600_000 ? `${Math.max(1, Math.round(left / 60_000))}m left` : left < 2 * 86400_000 ? `${Math.round(left / 3600_000)}h left` : `${Math.floor(left / 86400_000)}d left`; };
// Season 1 beside TBB staked: buyers so far and time left, from the creator's board.
function renderSeason(se) {
  const top = se?.top || [];
  clear($('#seasonTop'), top.length ? top.map((r) => h('li', null, h('span', { class: 'st-rank mono' }, String(r.rank)),
    h('span', { class: 'st-who mono' }, r.label), h('span', { class: 'st-score mono' }, usd(r.score))))
    : h('li', { class: 'ti-empty' }, se ? 'No buyers on the board yet.' : 'Leaderboard unavailable right now. Open the board for live standings.'));
  $('#seasonSub').textContent = se && Number.isFinite(se.buyers) ? `${num(se.buyers)} buyers · net USD bought · from the creator’s board · ${se.end > Date.now() ? 'ends ' + new Date(se.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'ended'}` : 'Ranked by net USD bought, on the creator’s board.';
  // the prize and its rate, as the board publishes them (nothing shown until the board answers)
  const pz = $('#seasonPrize'); pz.hidden = !(se?.prizeTbb > 0);
  if (!pz.hidden) pz.textContent = `Prize: ${num(se.prizeTbb)} TBB${Number.isFinite(se.stakeApr) ? ` · staked at ${+(se.stakeApr * 100).toFixed(2)}% APR on the winner’s behalf` : ''} · from the creator’s board.`;
  const v = $('#st-season .stat-v'); const d = $('#st-season-d');
  if (!se) { v.textContent = 'Board ↗'; d.textContent = ''; $('#st-season').title = 'Season 1 board'; return; }
  v.textContent = Number.isFinite(se.buyers) ? `${num(se.buyers)} buyers` : 'Live';
  d.textContent = seasonLeft(se);
  $('#st-season').title = `Season 1 · ${Number.isFinite(se.buys) ? num(se.buys) + ' buys' : ''}${Number.isFinite(se.volumeUsd) ? ' · ' + usd(se.volumeUsd) + ' volume' : ''} · ends ${new Date(se.end).toLocaleString()}`;
}
function renderFeatures() {
  const f = S.features || {};
  const chat = !!f.chat; const ideas = !!f.ideas;
  $('#boardSoon').hidden = chat; $('#boardList').hidden = $('#boardCompose').hidden = !chat;
  $('.board').classList.toggle('is-closed', !chat);
  $('#boardChips').classList.toggle('dim', !chat);
  $('#boardOpen').hidden = !chat; $('.live-dot').classList.toggle('off', !chat);
  // both closed: one short card instead of two empty ones
  const bothClosed = !chat && !ideas;
  $('.ideas-card').hidden = bothClosed;
  $('#boardSoon strong').textContent = bothClosed ? 'Chat and Ideas are coming soon' : 'Chat is coming soon';
  $('#ideasSoon').hidden = ideas; $('#topIdeas').hidden = $('.ideas-post').hidden = $('#ideasSub').hidden = !ideas;
  $('.ideas-card').classList.toggle('is-closed', !ideas);
  // Chat and Build are off the dock while closed (hidden in the shell too, so nothing flashes); the server's
  // switches (CHAT_OPEN, ACCOUNTS_OPEN) bring each tab back without a page change
  soonMark($('.dk[data-dk="live"]'), !chat);
  soonMark($('.dk[data-dk="build"]'), !ideas);
  // the 2009 skin's chrome follows the same rule: no Chat or Ideas tool while those are closed
  $('.toolbar .tool[href^="#/chat"]').hidden = !chat; $('.toolbar .tool[href="#/build"]').hidden = !ideas; $('.toolbar').hidden = !chat && !ideas;
  renderDock();
  if (openDrawerId === 'live' && !chat) leaveClosed('Coming soon.');
}
// A closed tab is not on the page at all (nothing a visitor can see is ever disabled or going nowhere); it comes back the moment its area opens.
function soonMark(el, closed) { el.hidden = closed; el.classList.toggle('is-soon', closed); }
function renderDock() {
  // the dock's label size follows how many tabs are showing (phones: six tabs need smaller labels to keep "Season 1" whole)
  const dock = $('.dock'); const shown = $$('.dock .dk').filter((el) => !el.hidden).length;
  for (const c of [...dock.classList]) if (/^tabs-\d$/.test(c)) dock.classList.remove(c);
  dock.classList.add('tabs-' + Math.min(9, shown));
}
// The admin's story (Story tab): paragraphs, bold, italic and https links only; never HTML.
function renderStory() {
  const st = S.story || {}; const t = $('#storyTitle');
  t.hidden = !st.title; t.textContent = st.title || '';
  clear($('#storyBody'), st.body ? richStory(st.body) : h('p', { class: 'story-empty' }, 'The story is coming.'));
}
function renderMe() {
  const btn = $('#accountBtn'); const label = $('.account-label', btn);
  btn.classList.toggle('on', !!S.me);
  // no button for a closed feature: while accounts are closed the home has no Sign in at all (no query-string back door
  // either: the admin's tools live on the admin host behind Cloudflare Access)
  btn.hidden = !S.me && !S.features?.accounts;
  label.textContent = S.me ? (S.me.name || S.me.username || 'Account') : 'Sign in';
  btn.setAttribute('aria-label', S.me ? `Signed in as ${S.me.name || S.me.username}. Open account menu.` : 'Sign in or create an account');
}
// Admin settings: an announcement line at the top, and read-only sections the admin may hide.
function renderBanner() {
  const b = S.banner; const el = $('#banner');
  el.hidden = !b || !b.text;
  if (el.hidden) return;
  el.classList.toggle('warn', b.tone === 'warn');
  clear($('.announce-ico', el), icon(b.tone === 'warn' ? 'flag' : 'bell'));
  clear($('.announce-text', el), richText(b.text));
}
function renderSections() {
  const v = S.sections || {};
  const show = (sel, on) => { for (const el of $$(sel)) el.toggleAttribute('hidden', !on); }; // attribute, so SVG works too
  show('.season-card, #st-season, .tile-season, .dk[data-dk="season"]', v.season !== false);
  show('#spark, .spark-age', v.chart !== false);
  show('.tile[href="#/learn"], .menu-list [data-href="#/learn"]', v.learn !== false);
  if (openDrawerId === 'season' && v.season === false) goHome();
  show('#lore', v.lore !== false);
  root.classList.toggle('no-chart', v.chart === false);
}
// alerts: one at a time, cross-fade
let alertIdx = 0; let alertTimer = 0;
function renderAlert() {
  const a = $('#alert'); const t = $('.alert-text', a);
  if (!S.alerts.length) { a.hidden = true; $('#sb-text').textContent = 'running bitcoin'; return; }
  a.hidden = false;
  const cur = S.alerts[alertIdx % S.alerts.length];
  const apply = () => { t.textContent = cur.text; a.href = /^#\//.test(cur.link || '') ? cur.link : '#/build'; $('#sb-text').textContent = cur.text; t.classList.remove('out'); };
  if (t.textContent && !reducedMotion()) { t.classList.add('out'); setTimeout(apply, 420); } else apply();
}
function cycleAlerts() { clearInterval(alertTimer); alertTimer = setInterval(() => { alertIdx++; renderAlert(); }, 6000); }

// lore line
let loreTimer = 0; let lorePinned = false;
function showLore(l, { instant = false } = {}) {
  if (!l) return;
  S.lore = l;
  const el = $('#lore'); const t = $('.lore-text', el);
  const apply = () => {
    t.textContent = l.text;
    const meta = clear($('.lore-meta', el), `block ${num(l.height)} · `, h('a', { href: `https://mempool.space/block/${l.hash}`, target: '_blank', rel: 'noopener noreferrer' }, 'verify ↗'));
    meta.setAttribute('aria-hidden', el.classList.contains('open') ? 'false' : 'true');
    t.classList.remove('out');
  };
  if (!instant && t.textContent && !reducedMotion()) { t.classList.add('out'); setTimeout(apply, 1200); } else apply();
}
function genesisMoment() {
  const d = new Date();
  if (d.getUTCMonth() === 0 && d.getUTCDate() === 3) return true; // every January 3
  return d.getUTCHours() === 18 && d.getUTCMinutes() === 15;     // 18:15 UTC, the genesis minute
}
// One batch of 20 lines is fetched at start and every 15 minutes; the line changes every 20 s from that batch,
// without a request (it used to ask the server for one line every 20 s). The server puts a reply right after its line.
const LORE_BATCH = 20; const LORE_REFILL = 15 * 60_000;
let loreLines = []; let loreIdx = -1; let loreFillAt = 0;
async function loreFill() {
  loreFillAt = Date.now();
  try { const r = await api(`/api/lore?n=${LORE_BATCH}`); if (Array.isArray(r.lines) && r.lines.length) { loreLines = r.lines; loreIdx = -1; } } catch { /* keep what we have */ }
}
async function nextLore() {
  if (genesisMoment()) { if (!lorePinned) { lorePinned = true; showLore({ ...S.genesis, hash: S.genesis.hash }); } return; }
  lorePinned = false;
  if (!loreLines.length && Date.now() - loreFillAt > 60_000) await loreFill(); // nothing yet (the first fill failed): try again, at most once a minute
  if (!loreLines.length) return;
  loreIdx = (loreIdx + 1) % loreLines.length;
  const l = loreLines[loreIdx];
  if (l.text !== S.lore?.text) showLore(l);
}
$('#lore').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const el = $('#lore'); el.classList.toggle('open');
  $('.lore-meta', el).setAttribute('aria-hidden', el.classList.contains('open') ? 'false' : 'true');
});

// live chat preview: a small window onto Main / Builds. Everything else happens inside the full chat.
let boardRoom = 'general';
for (const c of $$('#boardChips .chip[data-room]:not(.chip-lock)')) c.addEventListener('click', () => {
  boardRoom = c.dataset.room;
  for (const x of $$('#boardChips .chip')) x.setAttribute('aria-selected', String(x === c));
  $('#boardOpen').href = $('#boardCompose').href = `#/chat/${boardRoom}`;
  const tool = $('#drawerTools .board-open'); if (tool) tool.href = `#/chat/${boardRoom}`;
  renderBoard();
});
async function renderBoard() {
  if (!S.features?.chat) return;
  try {
    const r = await api(`/api/rooms/${boardRoom}/messages`);
    const list = $('#boardList');
    const msgs = r.messages.filter((m) => !m.deleted && !m.hidden).slice(-3);
    clear(list, msgs.length ? msgs.map((m) => h('li', null, avatar(m.author.avatar, 26),
      h('span', { class: 'bl-main' }, h('span', { class: 'bl-name' }, m.author.name), h('span', { class: 'bl-text' }, m.body)),
      h('span', { class: 'bl-time' }, ago(m.at)))) : h('li', null, h('span'), h('span', { class: 'bl-text' }, 'No messages yet.'), h('span')));
  } catch { /* offline */ }
}

// top ideas card
const LINK_ICON = [[/timemachine/i, 'clock'], [/x\.com|twitter\.com/i, 'xlogo'], [/dexscreener|geckoterminal|birdeye/i, 'chart'], [/store\.bitcoinhard/i, 'book'], [/solscan|explorer/i, 'link']];
// Rows that live on this site and sit above the admin's outside links: the whitepaper is the creator's poster on the
// Learn page (the outside site doesn't have it), so it is a page here, not a link out.
export const SITE_LINKS = [{ url: '#/learn/tbb', title: 'TBB whitepaper', blurb: 'The creator’s poster: twelve points.', icon: 'learn' }];
// The Links drawer: every link, in the admin's order (the drawer scrolls, so nothing is folded away).
async function renderLinks() {
  try {
    const r = await api('/api/allies'); const all = r.allies || [];
    const host = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    clear($('#linksList'), ...SITE_LINKS.map((a) => h('a', { class: 'tile link-row link-site', href: a.url, title: a.blurb },
      h('span', { class: 't-status' }, 'Page'), h('span', { class: 't-date' }),
      h('span', { class: 't-ico' }, icon(a.icon)),
      h('span', { class: 't-main' }, h('span', { class: 't-label' }, a.title), h('span', { class: 't-sub' }, 'On this site')))),
    ...all.map((a) => h('a', { class: 'tile link-row', href: a.url, target: '_blank', rel: 'noopener noreferrer', title: a.blurb },
      h('span', { class: 't-status' }, 'Link'), h('span', { class: 't-date' }),
      h('span', { class: 't-ico' }, icon((LINK_ICON.find(([re]) => re.test(a.url)) || [0, 'link'])[1])),
      h('span', { class: 't-main' }, h('span', { class: 't-label' }, a.title), h('span', { class: 't-sub' }, host(a.url))),
      h('span', { class: 'link-ext', 'aria-hidden': 'true' }, '↗'))));
  } catch { /* the drawer keeps what it had */ }
}

async function renderIdeas() {
  if (!S.features?.ideas) return;
  try {
    const r = await api('/api/ideas?sort=top');
    const top = r.ideas.slice(0, 3);
    clear($('#topIdeas'), top.length ? top.map((i) => h('li', null, h('a', { href: `#/build/idea/${i.id}` },
      h('span', { class: 'ti-votes mono' }, icon('up'), String(i.votes)), h('span', { class: 'ti-title' }, i.title))))
      : h('li', { class: 'ti-empty' }, 'No ideas yet. Be the first.'));
    if (r.closes) { const d = Math.max(0, Math.ceil((r.closes - Date.now()) / 86400_000)); $('#ideasSub').textContent = d <= 1 ? 'This week’s vote closes today.' : `This week’s vote closes in ${d} days.`; }
  } catch { /* offline */ }
}

// 24h sparkline (GeckoTerminal hourly closes, via our server)
async function renderSpark() {
  const svg = $('#spark');
  try {
    const { points } = await api('/api/chart');
    sparkOk = !!points && points.length >= 2; renderAges();
    if (!sparkOk) { svg.classList.add('empty'); return; }
    const vs = points.map((p) => p[1]); const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || hi || 1;
    const xy = vs.map((v, i) => [(i / (vs.length - 1)) * 240, 44 - ((v - lo) / span) * 38]);
    const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
    $('.spark-line', svg).setAttribute('d', line);
    $('.spark-area', svg).setAttribute('d', `${line}L240 48L0 48Z`);
    svg.classList.toggle('down', vs[vs.length - 1] < vs[0]);
    svg.classList.remove('empty');
  } catch { sparkOk = false; svg.classList.add('empty'); renderAges(); }
}

// ---------- state ----------
export async function refresh() {
  try {
    const s = await api('/api/state');
    $('#llc').textContent = s.operator ? `© ${new Date().getFullYear()} ${s.operator}` : `© ${new Date().getFullYear()} · community-made page`;
    Object.assign(S, { features: s.features || {}, me: s.me, x: !!s.x, stats: s.stats, alerts: s.alerts, rooms: s.rooms, counts: s.counts, genesis: s.genesis, voteCloses: s.voteCloses, banner: s.banner || null, sections: s.sections || {}, story: s.story || null });
    if (s.stats.btcHeight) S.height = s.stats.btcHeight;
    renderStats(); renderMe(); renderFeatures(); renderAlert(); renderStatus(); renderBanner(); renderSections(); renderStory();
    if (!S.lore) { if (genesisMoment()) { lorePinned = true; showLore(s.genesis, { instant: true }); } else showLore(s.lore, { instant: true }); }
    fire('state', S);
  } catch (e) { if (!S.stats) toast('Can’t reach the hub right now. Retrying…', { kind: 'error' }); }
}
function renderStatus() {
  $('#sb-blocks').textContent = S.height ? `${num(S.height)} blocks` : '— blocks';
}

// ---------- live updates (SSE) ----------
// The browser reconnects by itself when a stream drops; when the server refuses one (busy, rate limit) it gives up,
// so we retry with a growing pause. Either way the 60 s poll below keeps the numbers moving.
let es = null; let liveRetry = 5000; let liveTimer = 0;
function scheduleLive() { clearTimeout(liveTimer); liveTimer = setTimeout(live, liveRetry); liveRetry = Math.min(60_000, liveRetry * 2); }
function live() {
  clearTimeout(liveTimer);
  if (es) { try { es.close(); } catch { /* */ } es = null; }
  try { es = new EventSource('/api/stream'); } catch { return scheduleLive(); }
  es.addEventListener('open', () => { liveRetry = 5000; root.classList.remove('offline'); root.classList.add('live'); });
  es.addEventListener('error', () => { root.classList.remove('live'); if (es.readyState === EventSource.CLOSED) { root.classList.add('offline'); scheduleLive(); } });
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); if (d.height) S.height = d.height; renderStatus(); });
  es.addEventListener('stats', (e) => { S.stats = { ...S.stats, ...JSON.parse(e.data) }; renderStats(); });
  es.addEventListener('alert', () => renderIdeas());
  es.addEventListener('block', (e) => {
    const d = JSON.parse(e.data); S.height = d.height; renderStatus();
    if (d.isNew) { flashLights(); fire('block', d); }
  });
  es.addEventListener('alert', (e) => { const d = JSON.parse(e.data); S.alerts = [d, ...S.alerts.filter((a) => a.text !== d.text)].slice(0, 9); alertIdx = 0; renderAlert(); cycleAlerts(); });
  es.addEventListener('message', (e) => { const d = JSON.parse(e.data); fire('message', d); if (d.room === boardRoom) renderBoard(); });
  es.addEventListener('message:update', (e) => { const d = JSON.parse(e.data); fire('message:update', d); if (d.room === boardRoom) renderBoard(); });
  es.addEventListener('inbox', () => { if (S.me) refresh(); });
  // moderation: signed out by a moderator (kick/ban) · my own state changed (mute lifted or set)
  es.addEventListener('kicked', () => { refresh(); toast('You were signed out by a moderator.', { kind: 'error' }); });
  es.addEventListener('me', () => { if (S.me) refresh(); });
  // The admin flipped a switch or edited the story: apply it in place, no reload.
  es.addEventListener('settings', (e) => {
    const d = JSON.parse(e.data);
    Object.assign(S, { features: d.features || {}, banner: d.banner || null, sections: d.sections || {}, story: d.story || null });
    renderFeatures(); renderMe(); renderBanner(); renderSections(); renderStory(); renderBoard(); renderIdeas();
    fire('state', S);
  });
}

export function flashLights(twice = false) {
  if (reducedMotion() || root.dataset.theme !== 'dark') return;
  const b = $('#beam'); b.classList.remove('flash', 'flash2'); void b.offsetWidth; b.classList.add(twice ? 'flash2' : 'flash');
}

// ---------- accounts / sign-in ----------
// A modal; `locked` = no Escape / backdrop close (the one-time recovery code must be acknowledged first).
export function modal(title, build, { onClose, locked = false } = {}) {
  const host = $('#modal'); const opener = document.activeElement;
  const close = () => { clear(host); document.removeEventListener('keydown', esc, true); if (opener && opener.isConnected && document.body.contains(opener)) opener.focus?.(); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!box.dataset.locked) close(); } };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-title': title });
  if (locked) box.dataset.locked = '1';
  const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap && !box.dataset.locked) close(); } }, box);
  clear(host, wrap);
  build(box, close, box);
  const heading = box.querySelector('.modal-title'); if (heading && heading.textContent.trim() === title) heading.classList.add('is-dup'); // the 2009 dialog already says it in its title bar
  document.addEventListener('keydown', esc, true);
  setTimeout(() => (box.querySelector('input, textarea, button.acct-opt, .btn-primary') || box).focus?.(), 30);
  return close;
}

function soonToast(msg) { toast(msg); }
// Chat while closed: one calm "Coming soon." and go nowhere.
const chatClosed = () => !S.features?.chat;
const CLOSED = [
  ['#/chat', () => chatClosed(), 'Coming soon.'],
  ['#/live', () => chatClosed(), 'Coming soon.'],
];
// typed in by hand, the same addresses show one calm "Coming soon" card instead (nothing to read, nothing to click)
const SOON_ROUTES = { chat: () => chatClosed(), live: () => chatClosed() };
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#/"]'); if (!a) return;
  const href = a.getAttribute('href');
  const hit = CLOSED.find(([p, closed]) => (href === p || href.startsWith(p + '/')) && closed());
  if (hit) { e.preventDefault(); soonToast(hit[2]); return; }
  // tapping the dock tab of the drawer that is already open closes it (by going back, like every close)
  if (a.classList.contains('dk') && a.classList.contains('on')) { e.preventDefault(); goHome(); }
}, true);
for (const b of $$('[data-soon]')) b.addEventListener('click', () => soonToast(b.dataset.soon));

export const SOON_MSG = 'Sign-in is coming soon.';
export async function requireSignIn(reason) {
  if (!S.features?.accounts && !S.me) { soonToast(SOON_MSG); return false; }
  if (S.me?.name) return true;
  const a = await account();
  return new Promise((resolve) => { if (S.me && !S.me.name) a.askName(resolve); else a.signInFlow(reason, resolve); });
}

// Accounts (public/js/account.js): the sign-in, recovery, password and X dialogs load the first time one is needed;
// a public page load carries none of that code.
const account = () => import('./account.js');
hooks.adult = (force) => account().then((a) => a.ensureAdult(force)); // api() asks once and retries when a write answers 403 `adult`
$('#accountBtn').addEventListener('click', async () => {
  if (!S.me && !S.features?.accounts) return soonToast(SOON_MSG);
  const a = await account();
  if (!S.me) return a.signInFlow();
  if (!S.me.name) return a.askName();
  a.accountMenu();
});

// ---------- buttons ----------
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-action]');
  if (a) {
    const act = a.dataset.action;
    if (act === 'copy-ca') {
      await copy(CA);
      const ca = $('.ca'); ca.classList.add('copied'); $('.ca-val').textContent = 'Copied';
      setTimeout(() => { ca.classList.remove('copied'); $('.ca-val').textContent = '42cX…pump'; }, 1600);
      toast('Contract address copied. Check the full address, not just the first and last characters.');
    } else if (act === 'theme-dark') setTheme('dark');
    closeMenus();
  }
  const hrefBtn = e.target.closest('[data-href]');
  if (hrefBtn) { location.hash = hrefBtn.dataset.href; closeMenus(); }
  const extBtn = e.target.closest('[data-ext]');
  if (extBtn && /^https:\/\//.test(extBtn.dataset.ext)) { window.open(extBtn.dataset.ext, '_blank', 'noopener,noreferrer'); closeMenus(); }
});
$('#themeBtn').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
// Share today's line: the numbers on screen in one sentence, through the browser's own share sheet where there is one,
// else copied to the clipboard. Nothing but this site's address goes in it; no third-party widget.
export function shareLine() {
  const s = S.stats || {}; const parts = [];
  if (s.price > 0) parts.push(`TBB ${usd(s.price)}${Number.isFinite(s.change24h) ? ` (${pct(s.change24h)} 24h)` : ''}`);
  if (s.staked && Number.isFinite(s.staked.amount)) parts.push(`${compact(s.staked.amount)} staked`);
  if (s.season && Number.isFinite(s.season.buyers)) parts.push(`Season 1: ${num(s.season.buyers)} buyers, ${seasonLeft(s.season).toLowerCase()}`);
  return parts.length ? parts.join(' · ') : '$TBB community dashboard';
}
$('#shareBtn').addEventListener('click', async () => {
  const text = shareLine(); const url = location.origin + '/';
  if (typeof navigator.share === 'function') { try { await navigator.share({ title: SITE_TITLE, text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; } }
  await copy(`${text} · ${location.host}`);
  toast('Today’s line copied. Paste it anywhere.');
});

// 2009 menus
function closeMenus() { for (const m of $$('.menu.open')) m.classList.remove('open'); }
for (const m of $$('.menu')) {
  const b = $('.menu-btn', m);
  b.addEventListener('click', (e) => { e.stopPropagation(); const was = m.classList.contains('open'); closeMenus(); if (!was) m.classList.add('open'); });
  b.addEventListener('mouseenter', () => { if ($('.menu.open') && !m.classList.contains('open')) { closeMenus(); m.classList.add('open'); } });
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
// list view: double-click opens (single click works too, for phones)
for (const t of $$('.tile')) t.addEventListener('dblclick', (e) => e.preventDefault());

// ---------- router ----------
// Browser history. Every entry this page creates gets a sequence number in history.state, so "close" and the sheet's
// back arrow can go *back* to the entry you came from instead of pushing a new one. (Pushing meant browser Back
// re-opened whatever you had just closed, and the back arrow felt like it went forward.)
let cur = 0; const seen = new Map(); // seq → hash, for entries made since this page loaded
function tagEntry() {
  let n = history.state?.tbb;
  if (n == null) { // a new entry: the browser just dropped every forward entry, so forget those too
    for (const k of [...seen.keys()]) if (k > cur) seen.delete(k);
    n = cur + 1; try { history.replaceState({ tbb: n }, ''); } catch { /* */ }
  }
  cur = n; seen.set(n, location.hash);
}
const norm = (h) => (h === '#/' || h === '#' ? '' : h || '');
// Go to a hash: by popping back to the nearest earlier entry that already shows it when there is one, else by pushing.
function goTo(hash) {
  const want = norm(hash); const n = history.state?.tbb;
  // never further back than the browser can go (it keeps about 50 entries; a history.go() past the end does nothing at all)
  if (n != null) for (let k = n - 1; k >= 1 && n - k <= 45 && n - k < history.length; k--) { const h = seen.get(k); if (h === undefined) break; if (norm(h) === want) { history.go(k - n); return; } }
  if (norm(location.hash) === want) return;
  location.hash = want || '#/';
}
const goHome = () => goTo('#/');
// Change the address of the current entry to another one (a redirect): the entry keeps its sequence number, so the
// back-arrow arithmetic above stays true (location.replace() would hand the entry a new number with no history behind it).
export function redirect(hash) { try { history.replaceState(history.state, '', location.pathname + location.search + hash); } catch { /* */ } route(); }
// One level up: #/learn/staking → #/learn, #/build/idea/5 → #/build.
function parentOf(hash) {
  const p = norm(hash).replace(/^#\/?/, '').split('/').filter(Boolean); p.pop();
  if (p[p.length - 1] === 'idea') p.pop();
  return p.length ? '#/' + p.join('/') : '#/';
}
// A section that is not open yet, reached by address: say so, then step back to where you were. Never leaves a trap:
// one browser Back from here always lands on the previous page. Landing here directly just shows the home screen.
function leaveClosed(msg) {
  soonToast(msg);
  const n = history.state?.tbb;
  if (n != null && n > 1 && seen.has(n - 1)) { history.back(); return; }
  try { history.replaceState({ tbb: n }, '', location.pathname + location.search); } catch { /* */ }
  seen.set(n, ''); closeDrawer(); closeSheet();
}
const sheet = $('#sheet'); const backdrop = $('#backdrop');
let cleanup = null; let lastFocus = null; let openRoute = null;
// ---- drawers: the dock's four tabs. Each is a hash route, so Back, Forward, Escape and the backdrop behave like the sheet's.
const DRAWERS = { story: 'Story', links: 'Links', season: 'Season 1 leaders', live: 'Live chat' };
// the drawer's own link sits in its title row (the card headers underneath stay hidden): the Season board, the full chat
const DRAWER_TOOLS = {
  season: () => [h('a', { class: 'board-open', href: $('#seasonOpen').href, target: '_blank', rel: 'noopener noreferrer' }, icon('star'), 'Open the board ', h('span', { class: 'arrow' }, '↗'))],
  live: () => [h('a', { class: 'board-open', href: `#/chat/${boardRoom}` }, 'Open chat ', h('span', { class: 'arrow' }, '→'))],
};
function lightDock(id) { for (const t of $$('.dk')) { const on = t.dataset.dk === id; t.classList.toggle('on', on); if (on) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); } }
const drawer = $('#drawer'); const drawerBackdrop = $('#drawerBackdrop');
let openDrawerId = null;
function openDrawer(id) {
  for (const d of $$('.dw')) d.hidden = d.dataset.dw !== id;
  $('#drawerTitle').textContent = DRAWERS[id];
  clear($('#drawerTools'), ...(DRAWER_TOOLS[id]?.() || []));
  lightDock(id);
  document.title = `${DRAWERS[id]} · ${SITE_TITLE}`;
  if (id === 'live') { renderBoard(); renderIdeas(); } else if (id === 'links') renderLinks();
  if (openDrawerId === id) return;
  if (!openDrawerId) lastFocus = document.activeElement;
  openDrawerId = id; drawer.hidden = false; drawerBackdrop.hidden = false; drawer.classList.remove('out'); placeDrawer();
  $('#drawerBody').scrollTop = 0;
  setTimeout(() => { if (!drawer.contains(document.activeElement)) $('#drawerTitle').focus?.(); }, 50);
}
function closeDrawer() {
  if (drawer.hidden) return;
  openDrawerId = null; lightDock(null);
  document.title = SITE_TITLE;
  const done = () => { drawer.hidden = true; drawerBackdrop.hidden = true; };
  if (reducedMotion() || root.dataset.theme === 'light') done(); else { drawer.classList.add('out'); setTimeout(done, 240); }
  lastFocus?.focus?.();
}
// The drawer rises from the dock and stops just above it, so the tabs stay in reach (tap the lit one again to close);
// the backdrop stops at the same line.
function placeDrawer() {
  if (drawer.hidden) return;
  const r = $('.dock').getBoundingClientRect(); const bottom = Math.max(0, Math.round(innerHeight - r.top) + 6);
  drawer.style.bottom = bottom + 'px'; drawerBackdrop.style.bottom = bottom + 'px';
  drawer.style.maxHeight = Math.max(200, r.top - 6 - Math.min(90, r.top * 0.12)) + 'px';
}
addEventListener('resize', placeDrawer);
// swipe down on the drawer (from the top of its content) closes it
let touchY = null;
drawer.addEventListener('touchstart', (e) => { touchY = $('#drawerBody').scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
drawer.addEventListener('touchend', (e) => { if (touchY != null && e.changedTouches[0].clientY - touchY > 70) goHome(); touchY = null; }, { passive: true });
$('#drawerClose').addEventListener('click', goHome);
drawerBackdrop.addEventListener('click', goHome);
// Back from Sign in with X (#/?x=…, account.js xReturn): a message, never a page, and only once the state says accounts
// are open. While they are closed the hash goes quietly: a crafted link must not load the account code.
function xHash() {
  if (S.x || S.features?.accounts || S.me) account().then((a) => a.xReturn());
  else history.replaceState(history.state, '', location.pathname + location.search);
}
async function route() {
  tagEntry();
  const hash = location.hash.replace(/^#\/?/, '');
  if (/^\?x=/.test(hash)) return xHash(); // the Sign in with X return: a message, not a page
  const parts = hash.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ''; } });
  // an old #/swap address (and anything under it) goes quietly back to the home: no card, no message
  if (parts[0] === 'swap') { history.replaceState(history.state, '', location.pathname + location.search); parts.length = 0; seen.set(cur, ''); }
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  if (!parts.length) { closeDrawer(); return closeSheet(); }
  // a closed area typed in by hand (chat, live) shows the calm "Coming soon" card, whatever came after the slash
  const closed = Object.hasOwn(SOON_ROUTES, parts[0]) && SOON_ROUTES[parts[0]]();
  if (!closed && Object.hasOwn(DRAWERS, parts[0]) && !(parts[0] === 'season' && S.sections?.season === false)) { closeSheet(); return openDrawer(parts[0]); }
  closeDrawer();
  if (parts[0] === 'privacy' || parts[0] === 'terms') parts[0] = 'disclaimer'; // common addresses people type
  // no admin page exists on this host (administration is on the admin host): an address that is not a view is "Not found"
  const view = closed ? VIEWS.comingSoon : Object.hasOwn(VIEWS, parts[0]) ? VIEWS[parts[0]] : null;
  if (!openRoute) lastFocus = document.activeElement;
  openRoute = parts[0];
  lightDock(!closed && parts[0] === 'learn' ? 'learn' : parts[0] === 'help' ? 'learn' : null); // the dock tab that owns this sheet
  sheet.hidden = false; backdrop.hidden = false; sheet.classList.remove('out');
  document.body.style.overflow = 'hidden';
  const body = $('#sheetBody'); body.className = 'sheet-body'; body.scrollTop = 0;
  clear($('#sheetTools'));
  const setTitle = (t) => { $('#sheetTitle').textContent = t; document.title = `${t} · ${SITE_TITLE}`; };
  $('#sheetBack').hidden = parts.length < 2;
  if (!view) { setTitle('Not found'); clear(body, h('div', { class: 'empty' }, h('div', { class: 'serif' }, 'This page has moved on to other things.'), h('a', { class: 'btn', href: '#/' }, 'Back to the summit'))); return; }
  try {
    cleanup = (await view({ body, parts: parts.slice(1), setTitle, tools: $('#sheetTools'), S, area: parts[0] })) || null;
  } catch (err) {
    clear(body, h('div', { class: 'empty' }, h('div', { class: 'serif' }, 'That didn’t load.'), h('p', null, err.message), h('button', { class: 'btn', onclick: route }, 'Try again')));
  }
  setTimeout(() => { if (!sheet.contains(document.activeElement)) $('#sheetTitle').focus?.(); }, 50);
}
function closeSheet() {
  if (sheet.hidden) return;
  openRoute = null; lightDock(null);
  document.title = SITE_TITLE;
  document.body.style.overflow = '';
  const done = () => { sheet.hidden = true; backdrop.hidden = true; clear($('#sheetBody')); };
  if (reducedMotion() || root.dataset.theme === 'light') done(); else { sheet.classList.add('out'); setTimeout(done, 240); }
  lastFocus?.focus?.();
  refresh();
}
$('#sheetTitle').tabIndex = -1; $('#drawerTitle').tabIndex = -1;
$('#sheetClose').addEventListener('click', goHome);
$('#sheetBack').addEventListener('click', () => goTo(parentOf(location.hash)));
backdrop.addEventListener('click', goHome);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (!sheet.hidden || !drawer.hidden) && !$('#modal').children.length) goHome(); });
// "Home" links (tab bar, "Back to the summit") go back through history too, rather than piling up home entries.
document.addEventListener('click', (e) => { const a = e.target.closest?.('a[href="#/"]'); if (a && !e.defaultPrevented) { e.preventDefault(); goHome(); } });
window.addEventListener('hashchange', route);

// ---------- Easter eggs ----------
function burst(x, y, n = 28) {
  if (reducedMotion()) return;
  const host = $('#embers');
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2; const d = 40 + Math.random() * 120;
    const e = h('span', { class: 'ember', style: { left: x + 'px', top: y + 'px' } });
    e.style.setProperty('--dx', Math.cos(a) * d + 'px'); e.style.setProperty('--dy', Math.sin(a) * d - 40 + 'px');
    host.append(e); setTimeout(() => e.remove(), 1700);
  }
}
let wordClicks = 0; let wordTimer = 0;
$('#wordmark').addEventListener('click', (e) => {
  wordClicks++; clearTimeout(wordTimer); wordTimer = setTimeout(() => { wordClicks = 0; }, 8000);
  if (wordClicks === 21) { wordClicks = 0; const r = e.currentTarget.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, 42); toast('21,000,000. Not one more.', { kind: 'egg', ms: 5000 }); }
});
let typed = '';
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']; let kIdx = 0;
document.addEventListener('keydown', (e) => {
  const inField = e.target.closest?.('input, textarea, [contenteditable]');
  if (!inField) {
    if (e.key === KONAMI[kIdx] || e.key.toLowerCase() === KONAMI[kIdx]) { kIdx++; if (kIdx === KONAMI.length) { kIdx = 0; konami(); } } else kIdx = e.key === KONAMI[0] ? 1 : 0;
    if (e.key.length === 1) {
      typed = (typed + e.key.toLowerCase()).slice(-15);
      if (typed.endsWith('running bitcoin')) { typed = ''; runningBitcoin(); }
    }
  }
});
function runningBitcoin() {
  const sb = $('#sb-text'); const old = sb.textContent; sb.textContent = 'Running bitcoin'; setTimeout(() => { sb.textContent = old; }, 6000);
  flashLights();
  toast('“Running bitcoin” — Hal Finney, January 2009', { kind: 'egg', ms: 6000 });
}
function konami() {
  flashLights(true);
  root.classList.add('clear-fog'); setTimeout(() => root.classList.remove('clear-fog'), 5000);
  toast('The fog lifts. For a moment, you can see all the way down.', { kind: 'egg', ms: 5000 });
}
document.addEventListener('click', (e) => {
  const egg = e.target.closest('[data-egg]'); if (!egg) return;
  const k = egg.dataset.egg; closeMenus();
  if (k === 'generate') {
    const tick = $('.gen-tick', egg); tick.classList.add('on');
    modal('Generate Coins', (box, close) => {
      const bar = h('div', { class: 'progress' }, h('span'));
      const line = h('p', { class: 'small', style: { margin: 0 } }, 'Generating…');
      box.append(h('h3', { class: 'modal-title' }, 'Generate Coins'), line, bar);
      let p = 0; const iv = setInterval(() => {
        p += 4 + Math.random() * 9; bar.firstChild.style.width = Math.min(100, p) + '%';
        if (p >= 100) { clearInterval(iv); line.textContent = 'No coins here. Only bulls.'; tick.classList.remove('on'); box.append(h('button', { class: 'btn btn-primary', onclick: close }, 'OK')); }
      }, 160);
    });
  } else if (k === 'about') {
    modal('About The Bitcoin Bull', (box, close) => box.append(
      h('h3', { class: 'modal-title' }, 'The Bitcoin Bull v0.1 alpha'),
      h('p', { class: 'small', style: { margin: 0 } }, 'In honour of the people who ran bitcoin first.'),
      h('p', { class: 'small muted', style: { margin: 0 } }, 'This is experimental software. Don’t trust. Verify.'),
      h('button', { class: 'btn btn-primary', onclick: close }, 'OK')));
  } else if (k === 'min') { toast('Can’t minimize a bull.'); }
  else if (k === 'max') { toast('Already maximalist.'); }
});
// console egg
console.log('%cThe Times 03/Jan/2009 Chancellor on brink of second bailout for banks', 'color:#F7931A;font:italic 16px Georgia,serif;padding:6px 0');
console.log('%cDon’t trust. Verify.%c\n$TBB  ' + CA, 'font-weight:bold;font-size:13px', 'color:#888');

// subtle parallax (desktop, dark only)
if (matchMedia('(hover: hover) and (pointer: fine)').matches && !reducedMotion()) {
  let raf = 0;
  window.addEventListener('pointermove', (e) => {
    if (raf || root.dataset.theme !== 'dark') return;
    raf = requestAnimationFrame(() => { raf = 0;
      const x = (e.clientX / innerWidth - .5) * -14; const y = (e.clientY / innerHeight - .5) * -8;
      $('#sceneFrame').style.setProperty('--px', x.toFixed(1) + 'px'); $('#sceneFrame').style.setProperty('--py', y.toFixed(1) + 'px');
    });
  }, { passive: true });
}

// ---------- boot ----------
await refresh();
renderBoard(); renderIdeas(); renderSpark(); renderLinks(); loreFill();
// Timers: none of them runs while the tab is hidden; the 60 s state poll is skipped while the live stream is
// open (the stream pushes the numbers); the lore line turns from its local batch, refilled every 15 min.
const whenVisible = (fn) => () => { if (!document.hidden) fn(); };
const streamOpen = () => !!es && es.readyState === EventSource.OPEN;
setInterval(whenVisible(renderSpark), 10 * 60_000);
cycleAlerts();
loreTimer = setInterval(whenVisible(nextLore), 20000);
setInterval(whenVisible(loreFill), LORE_REFILL);
setInterval(whenVisible(() => { if (!streamOpen()) refresh(); }), 60000);
setInterval(whenVisible(renderAges), 10_000);
// Back from another tab or a sleeping phone: catch up right away rather than waiting for the next tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refresh(); renderSpark(); renderAges();
  if (Date.now() - loreFillAt >= LORE_REFILL) loreFill(); else nextLore();
  if (!es || es.readyState === EventSource.CLOSED) live();
});
live();
route();
export const liveState = () => (es ? es.readyState : -1);
export { refresh as reload, setTheme, burst, CA, live as reconnectLive };
