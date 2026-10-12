// The closed areas: chat, Ideas and the inbox. views.js loads this module the first time one of them is opened for
// real; the launch site never fetches it.
import { h, $, $$, clear, icon, avatar, num, ago, until, api, toast, busy, plainText } from './ui.js';
import { S, on, modal, requireSignIn, refresh } from './app.js';
import { empty, field, tabs, byline, counter, CHAT_SOON, IDEAS_SOON, guard, report } from './views.js';

// =====================================================================================
// MESSAGE BOARD
// =====================================================================================
async function chat({ body, parts, setTitle }) {
  const roomId = S.rooms.find((r) => r.id === parts[0]) ? parts[0] : 'general';
  const room = S.rooms.find((r) => r.id === roomId);
  setTitle('Chat');
  if (!S.features?.chat) { clear(body, h('div', { class: 'stack' }, CHAT_SOON())); return; }
  body.classList.add('flush');
  const scroll = h('div', { class: 'chat-scroll', role: 'log', 'aria-live': 'polite' });
  const roomTabs = tabs(S.rooms.map((r) => [r.id, r.short || r.name, r.id === 'builds' ? 'build' : null]), roomId, (id) => { location.hash = `#/chat/${id}`; });
  const wrap = h('div', { class: 'chat' }, h('div', { class: 'chat-rooms' }, roomTabs, h('div', { class: 'room-blurb' }, room.blurb)), scroll);
  clear(body, wrap);
  roomTabs.querySelector('[aria-selected=true]')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  let messages = []; let replyTo = null; let editing = null;
  const nodes = new Map();

  const composer = h('div', { class: 'composer' });
  const input = h('textarea', { class: 'textarea', rows: 1, maxlength: 500, placeholder: `Message ${room.name}`, 'aria-label': `Message ${room.name}` });
  const send = h('button', { class: 'btn btn-primary send', 'aria-label': 'Send' }, icon('send'));
  const replying = h('div', { class: 'replying', hidden: true });
  composer.append(replying, h('div', { class: 'composer-row' }, input, send), h('p', { class: 'composer-note' }, 'Links and pictures coming soon.'));
  // Text only: a pasted or dropped picture/file goes nowhere (and says so). Pasted text is fine.
  const PICS_MSG = 'Pictures coming soon.';
  input.addEventListener('paste', (e) => { const items = [...(e.clipboardData?.items || [])]; if (items.some((i) => i.kind === 'file') || (e.clipboardData?.files?.length)) { e.preventDefault(); toast(PICS_MSG); } });
  for (const el of [composer, scroll]) { el.addEventListener('dragover', (e) => { e.preventDefault(); }); el.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length || [...(e.dataTransfer?.types || [])].includes('Files')) toast(PICS_MSG); }); }

  function grow() { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight + 2) + 'px'; }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } if (e.key === 'Escape' && (replyTo || editing)) { e.stopPropagation(); setReply(null); } });
  send.addEventListener('click', submit);

  function setReply(m, mode = 'reply') {
    replyTo = mode === 'reply' ? m : null; editing = mode === 'edit' ? m : null;
    if (!m) { replying.hidden = true; if (editing === null) { /* keep text */ } return; }
    clear(replying, icon(mode === 'edit' ? 'edit' : 'reply'), h('span', null, mode === 'edit' ? 'Editing your message' : `Replying to ${m.author.name}`),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { if (editing) input.value = ''; setReply(null); } }, 'Cancel'));
    replying.hidden = false;
    if (mode === 'edit') { input.value = m.body; grow(); }
    input.focus();
  }

  async function submit() {
    const text = input.value.trim(); if (!text) return;
    if (!(await requireSignIn('Sign in to post.'))) return;
    const go = async () => {
      if (editing) { const r = await api(`/api/messages/${editing.id}`, { method: 'PATCH', body: { body: text } }); upsert(r.message); }
      else { const r = await api(`/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: text, reply_to: replyTo?.id } }); upsert(r.message, true); if (r.held) toast(r.notice || 'Your message is waiting for a moderator.'); }
      input.value = ''; grow(); setReply(null);
    };
    busy(send, true);
    try { await go(); } // a first post from an account that never confirmed its age: api() asks once (hooks.adult) and sends again
    catch (e) { toast(e.message, { kind: 'error' }); }
    finally { busy(send, false); }
  }

  function bubble(m, prev) {
    const cont = prev && !prev.deleted && prev.author.name === m.author.name && m.at - prev.at < 5 * 60_000 && !m.reply;
    const el = h('div', { class: `msg${m.mine ? ' mine' : ''}${cont ? ' cont' : ''}`, 'data-id': m.id, tabindex: 0 });
    // plain text, never links; a held message (waiting for a moderator) shows to its author with a tag
    const bodyEl = m.deleted ? h('div', { class: 'msg-body gone' }, 'Message deleted') : h('div', { class: 'msg-body' }, plainText(m.body), m.held ? h('span', { class: 'msg-held' }, 'Waiting for a moderator') : null);
    if (m.held) el.classList.add('held');
    const reacts = h('div', { class: 'msg-reacts' }, m.deleted || m.hidden ? null : m.reactions.map((r) => h('button', { class: `react${r.mine ? ' mine' : ''}${r.n ? '' : ' zero'}`, 'aria-label': `React ${r.e}`, onclick: () => react(m, r.e) }, r.e, r.n ? h('span', { class: 'n' }, r.n) : null)));
    const actions = h('div', { class: 'msg-actions' },
      h('button', { 'aria-label': 'Reply', title: 'Reply', onclick: () => setReply(m) }, icon('reply')),
      m.mine && Date.now() - m.at < 5 * 60_000 && !m.deleted ? h('button', { 'aria-label': 'Edit', title: 'Edit', onclick: () => setReply(m, 'edit') }, icon('edit')) : null,
      m.mine && !m.deleted ? h('button', { 'aria-label': 'Delete', title: 'Delete', onclick: () => del(m) }, icon('trash')) : null,
      !m.mine && !m.author.herd ? h('button', { 'aria-label': 'Report', title: 'Report', onclick: () => report('message', m.id) }, icon('flag')) : null);
    el.append(avatar(m.author.avatar, 36), h('div', { class: 'msg-body-wrap' },
      h('div', { class: 'msg-head' }, h('span', { class: 'msg-name' }, m.author.name),
        m.author.x ? h('span', { class: 'x-handle', title: 'X handle (plain text, not a link)' }, '𝕏 @' + m.author.x) : null,
        m.author.herd ? h('span', { class: 'badge badge-herd' }, 'Herd') : null,
        h('span', { class: 'msg-time', title: new Date(m.at).toLocaleString() }, ago(m.at) + (m.edited ? ' · edited' : ''))),
      m.reply ? h('div', { class: 'msg-reply' }, `${m.reply.name}: ${m.reply.body || '…'}`) : null,
      bodyEl, reacts), m.deleted ? null : actions);
    el.addEventListener('click', (e) => { if (matchMedia('(hover: none)').matches && !e.target.closest('button, a')) { $$('.msg.sel', scroll).forEach((x) => x !== el && x.classList.remove('sel')); el.classList.toggle('sel'); } });
    return el;
  }
  function render() {
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    const kids = []; nodes.clear(); let lastDay = '';
    // a hidden message is gone for everyone (its author still sees a held one, with the tag)
    const shown = messages.filter((m) => !(m.hidden && !m.body));
    shown.forEach((m, i) => {
      const day = new Date(m.at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      if (day !== lastDay) { kids.push(h('div', { class: 'day' }, day)); lastDay = day; }
      const n = bubble(m, i && shown[i - 1].room === m.room && new Date(shown[i - 1].at).toDateString() === new Date(m.at).toDateString() ? shown[i - 1] : null);
      nodes.set(m.id, n); kids.push(n);
    });
    clear(scroll, messages.length >= 60 ? h('button', { class: 'btn btn-sm more', onclick: older }, 'Load earlier') : null, kids.length ? kids : empty('No messages yet.'));
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
  }
  function upsert(m, scrollDown) {
    if (m.room !== roomId) return;
    const i = messages.findIndex((x) => x.id === m.id);
    if (i >= 0) { messages[i] = { ...m, mine: messages[i].mine || m.mine, reactions: m.reactions.map((r, k) => ({ ...r, mine: m.mine === undefined ? messages[i].reactions[k]?.mine : r.mine })) }; }
    else messages.push({ ...m, mine: m.mine || (S.me && m.author.name === S.me.name) });
    render(); if (scrollDown) scroll.scrollTop = scroll.scrollHeight;
  }
  async function react(m, e) {
    if (!(await requireSignIn('Sign in to react.'))) return;
    await guard(async () => { const r = await api(`/api/messages/${m.id}/react`, { method: 'POST', body: { emoji: e } }); upsert(r.message); });
  }
  async function del(m) {
    if (!confirm('Delete this message?')) return;
    await guard(async () => { await api(`/api/messages/${m.id}`, { method: 'DELETE' }); upsert({ ...m, deleted: m.mine, hidden: !m.mine, body: '' }); });
  }
  async function older() {
    const r = await api(`/api/rooms/${roomId}/messages?before=${messages[0].id}`);
    const top = scroll.scrollHeight; messages = [...r.messages, ...messages]; render(); scroll.scrollTop = scroll.scrollHeight - top;
  }

  try {
    const r = await api(`/api/rooms/${roomId}/messages`);
    messages = r.messages.map((m) => ({ ...m }));
    wrap.append(composer); render(); scroll.scrollTop = scroll.scrollHeight;
    setTimeout(() => { if (matchMedia('(hover: hover)').matches) input.focus(); }, 300);
  } catch (e) {
    clear(scroll, empty('Couldn’t load messages.', e.message));
  }
  const offs = [
    on('message', (m) => { if (m.room === roomId) upsert(m); }),
    on('message:update', (m) => { if (m.room === roomId && messages.some((x) => x.id === m.id)) upsert(m); }),
  ];
  const tick = setInterval(() => $$('.msg-time', scroll).forEach((t, i) => void i), 60000);
  return () => { offs.forEach((f) => f()); clearInterval(tick); };
}

// =====================================================================================
// BUILD — ideas and votes
// =====================================================================================
async function build({ body, parts, setTitle, tools }) {
  setTitle('Ideas');
  if (!S.features?.ideas) { clear(body, h('div', { class: 'stack' }, IDEAS_SOON())); return; }
  if (parts[0] === 'idea' && parts[1]) return ideaDetail(body, Number(parts[1]), setTitle);
  const content = h('div', { class: 'stack' });
  clear(body, h('div', { class: 'stack' }, h('p', { class: 'lead' }, 'Post ideas and vote on the best ones.'), content));
  await ideasTab(content, tools);
}

async function ideasTab(content, tools) {
  let sort = 'hot';
  const listEl = h('div', { class: 'list' });
  const head = h('div', { class: 'spread' });
  const newBtn = h('button', { class: 'btn btn-primary', onclick: newIdea }, icon('plus'), 'New idea');
  content.append(head, listEl);
  async function load() {
    const r = await api(`/api/ideas?sort=${sort}`);
    clear(head, h('div', { class: 'row' }, ...['hot', 'new', 'top'].map((s) => h('button', { class: `chip${s === sort ? ' chip-orange' : ''}`, onclick: () => { sort = s; load(); } }, s[0].toUpperCase() + s.slice(1))),
      h('span', { class: 'chip chip-dim' }, `Vote closes in ${until(r.closes)}`)), newBtn);
    clear(listEl, r.ideas.length ? r.ideas.map(ideaCard) : empty('No ideas yet.', 'Be the first. Small ideas welcome.'));
  }
  function ideaCard(i) {
    const vote = h('button', { class: `vote${i.voted ? ' on' : ''}`, 'aria-pressed': String(i.voted), 'aria-label': `Vote for ${i.title}` }, icon('up'), h('span', { class: 'n' }, num(i.votes)));
    vote.onclick = async () => {
      if (!(await requireSignIn('Sign in to vote. One account, one vote.'))) return;
      await guard(async () => { const r = await api(`/api/ideas/${i.id}/vote`, { method: 'POST' }); vote.classList.toggle('on', r.idea.voted); vote.setAttribute('aria-pressed', String(r.idea.voted)); $('.n', vote).textContent = num(r.idea.votes); });
    };
    return h('div', { class: 'card idea' }, vote, h('div', { class: 'stack', style: { gap: '6px' } },
      h('a', { class: 'idea-title', href: `#/build/idea/${i.id}` }, i.title), h('div', { class: 'idea-body' }, i.body.length > 220 ? i.body.slice(0, 220) + '…' : i.body), byline(i.author, i.at)));
  }
  async function newIdea() {
    if (!(await requireSignIn('Sign in to post an idea.'))) return;
    modal('New idea', (box, close) => {
      const title = h('input', { class: 'input', maxlength: 80, placeholder: 'A short, clear title' });
      const text = h('textarea', { class: 'textarea', maxlength: 1000, placeholder: 'What is it, who is it for, and why would the herd love it?' });
      const go = h('button', { class: 'btn btn-primary btn-block' }, 'Post idea');
      go.onclick = () => guard(async () => { const r = await api('/api/ideas', { method: 'POST', body: { title: title.value, body: text.value } }); close(); toast('Idea posted. Go get votes.'); location.hash = `#/build/idea/${r.idea.id}`; }, go);
      box.append(h('h3', { class: 'modal-title' }, 'New idea'), field('Title', title), counter(title, 80), field('Details', text), counter(text, 1000), go);
    });
  }
  await load();
}

async function ideaDetail(body, id, setTitle) {
  const r = await api('/api/ideas?sort=new');
  const i = r.ideas.find((x) => x.id === id);
  if (!i) { clear(body, empty('That idea isn’t here.', null, h('a', { class: 'btn', href: '#/build' }, 'All ideas'))); return; }
  setTitle('Idea');
  const vote = h('button', { class: `btn ${i.voted ? '' : 'btn-primary'}` }, icon('up'), i.voted ? `Voted · ${i.votes}` : `Vote · ${i.votes}`);
  vote.onclick = async () => {
    if (!(await requireSignIn('Sign in to vote.'))) return;
    await guard(async () => { const x = await api(`/api/ideas/${i.id}/vote`, { method: 'POST' }); vote.className = `btn ${x.idea.voted ? '' : 'btn-primary'}`; clear(vote, icon('up'), x.idea.voted ? `Voted · ${x.idea.votes}` : `Vote · ${x.idea.votes}`); });
  };
  clear(body, h('div', { class: 'stack' },
    h('h3', { class: 'serif', style: { fontSize: '32px', margin: 0, lineHeight: 1.15 } }, i.title), byline(i.author, i.at),
    h('div', { class: 'panel prose' }, h('p', { style: { whiteSpace: 'pre-wrap' } }, i.body)),
    h('div', { class: 'row' }, i.mine ? h('span', { class: 'chip' }, 'Your idea') : vote, h('span', { class: 'chip chip-dim' }, `Vote closes in ${until(r.closes)}`),
      !i.mine ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => report('idea', i.id) }, icon('flag'), 'Report') : null)));
}

// =====================================================================================
// INBOX
// =====================================================================================
async function inbox({ body, setTitle }) {
  setTitle('Inbox');
  if (!S.me && !S.features?.accounts) { clear(body, empty('Inbox is coming soon', 'Replies and updates will land here once accounts open. No e-mail needed.')); return; }
  if (!S.me) { clear(body, empty('Your inbox', 'Replies and votes land here.', h('button', { class: 'btn btn-primary', onclick: async () => { if (await requireSignIn()) location.reload(); } }, 'Sign in'))); return; }
  const r = await api('/api/inbox');
  const ico = { reply: 'reply', vote: 'up', idea: 'bolt' };
  clear(body, r.items.length ? h('div', { class: 'list' }, r.items.map((i) => h(i.link ? 'a' : 'div', { class: 'card', href: i.link || undefined, style: { flexDirection: 'row', alignItems: 'center', gap: '12px', opacity: i.read ? 0.72 : 1 } },
    h('span', { class: 't-ico', style: { width: '34px', height: '34px' } }, icon(ico[i.kind] || 'bell')), h('span', { style: { flex: 1 } }, i.text), h('span', { class: 'bl-time' }, ago(i.created_at)))))
    : empty('All quiet.', 'When someone replies or votes, you’ll see it here.'));
  if (r.items.some((i) => !i.read)) { await api('/api/inbox/read', { method: 'POST' }); refresh(); }
}

export { chat, build, inbox };
