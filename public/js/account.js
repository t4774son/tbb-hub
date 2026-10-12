// Accounts: the sign-in, recovery, password and X dialogs, the age confirmation and the account menu. Loaded by
// app.js the first time one of them is needed, so a public page load carries none of this.
import { h, clear, icon, api, toast, copy, busy } from './ui.js';
import { S, modal, refresh, reconnectLive, SOON_MSG } from './app.js';

// small form helpers
const add = (el, ...kids) => { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k); return el; }; // Element.append would print "null"
const err = () => h('p', { class: 'form-err small', role: 'alert' });
const pwField = (placeholder, { autocomplete = 'current-password', label = 'Password' } = {}) => {
  const input = h('input', { class: 'input', type: 'password', maxlength: 200, placeholder, autocomplete, 'aria-label': label });
  const show = h('button', { class: 'pw-eye', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false', onclick: () => { const hidden = input.type === 'password'; input.type = hidden ? 'text' : 'password'; show.textContent = hidden ? 'hide' : 'show'; show.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password'); show.setAttribute('aria-pressed', String(hidden)); } }, 'show');
  return { input, el: h('div', { class: 'pw-row' }, input, show) };
};
const adultBox = () => { const c = h('input', { type: 'checkbox', id: 'adultTick' }); return { c, el: h('label', { class: 'check' }, c, h('span', null, 'I’m 18 or older')) }; };
const afterSignIn = async (greeting) => {
  await refresh(); reconnectLive(); // reconnect the live stream with the session, so private nudges (inbox, mute, kick) reach this page
  if (greeting) toast(greeting);
};

// The sign-in dialog: Sign in / Create account, a recovery-code link, and Sign in with X (when the admin has set it up).
export function signInFlow(reason, done = () => {}) {
  let resolved = false;
  const finish = (v) => { if (!resolved) { resolved = true; done(v); } };
  modal('Sign in', (box, close) => {
    let tab = 'in';
    const body = h('div', { class: 'stack' });
    const tabs = h('div', { class: 'tabs auth-tabs', role: 'tablist' }, ...[['in', 'Sign in'], ['up', 'Create account']].map(([id, label]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(id === tab), onclick: () => { tab = id; for (const t of tabs.children) t.setAttribute('aria-selected', String(t.textContent === label)); draw(); } }, label)));
    const draw = () => { clear(body, tab === 'in' ? signInForm() : signUpForm()); setTimeout(() => body.querySelector('input')?.focus(), 20); };
    function signInForm() {
      const user = h('input', { class: 'input', maxlength: 20, placeholder: 'Username', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username' });
      const pw = pwField('Password'); const e = err();
      const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');
      const form = h('form', { class: 'stack', onsubmit: async (ev) => {
        ev.preventDefault(); busy(go, true); e.textContent = '';
        try { const r = await api('/api/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pw.input.value } }); close(); await afterSignIn(`Welcome back, ${r.username}.`); finish(true); }
        catch (x) { e.textContent = x.message; busy(go, false); }
      } }, user, pw.el, e, go);
      return h('div', { class: 'stack' }, form,
        h('div', { class: 'row auth-links' }, h('button', { class: 'link small', type: 'button', onclick: () => recoverFlow(close, finish) }, 'Have a recovery code?')),
        S.x ? xButton() : null);
    }
    function signUpForm() {
      const user = h('input', { class: 'input', maxlength: 20, placeholder: 'Username (3–20 letters, numbers, _)', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username' });
      const pw = pwField('Password (10 or more characters)', { autocomplete: 'new-password' }); const adult = adultBox(); const e = err();
      const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create account');
      const note = h('p', { class: 'tiny muted', style: { margin: 0 } }, 'No e-mail, no phone, no real name. You’ll get a one-time recovery code: it’s the only way back in if you forget the password.');
      const form = h('form', { class: 'stack', onsubmit: async (ev) => {
        ev.preventDefault(); e.textContent = '';
        if (!adult.c.checked) { e.textContent = 'Please confirm you are 18 or older.'; return; }
        busy(go, true, 'Checking your browser…');
        try {
          const challenge = await api('/api/auth/pow');
          const { solvePow } = await import('./pow.js');
          const nonce = await solvePow(challenge);
          busy(go, false); busy(go, true, 'Creating your account…');
          const r = await api('/api/auth/signup', { method: 'POST', body: { username: user.value.trim(), password: pw.input.value, adult: true, pow: { id: challenge.id, nonce } } });
          try { localStorage.setItem('tbb-adult', String(Date.now())); } catch { /* */ }
          close(); recoveryCodeScreen(r.recovery, { title: `Welcome, ${r.username}.`, onDone: async () => { await afterSignIn(); finish(true); } });
        } catch (x) { e.textContent = x.message; busy(go, false); }
      } }, user, pw.el, adult.el, e, go, note);
      return h('div', { class: 'stack' }, form, S.x ? xButton() : null);
    }
    const xButton = () => h('a', { class: 'acct-opt x-opt', href: '/auth/x/start' }, h('span', { class: 'x-mark', 'aria-hidden': 'true' }, '𝕏'), 'Sign in with X', h('span', { class: 'soon' }, 'no posting rights asked'));
    add(box, h('h3', { class: 'modal-title' }, 'Sign in'), reason ? h('p', { class: 'muted small', style: { margin: 0 } }, reason) : null, tabs, body,
      h('div', { class: 'notice' }, icon('shield'), h('span', null, 'We never ask for your seed phrase, e-mail or phone. Nobody here will ever DM you first.')),
      h('button', { class: 'btn btn-ghost', onclick: () => { close(); finish(false); } }, 'Not now'));
    draw();
  }, { onClose: () => finish(!!S.me?.name) });
}

// The one-time recovery code: shown once, big; the person must tick "I saved it" before going on.
function recoveryCodeScreen(code, { title = 'Your recovery code', onDone = () => {} } = {}) {
  modal('Recovery code', (box, close) => {
    const tick = h('input', { type: 'checkbox', id: 'savedTick' });
    const go = h('button', { class: 'btn btn-primary btn-block', disabled: true, onclick: async () => { close(); await onDone(); } }, 'Continue');
    tick.addEventListener('change', () => { go.disabled = !tick.checked; });
    add(box, h('h3', { class: 'modal-title' }, title),
      h('p', { class: 'small', style: { margin: 0 } }, 'This is your recovery code. We don’t collect e-mail, so keep this code — it’s the only way back in if you forget your password. It is shown once.'),
      h('div', { class: 'code-box mono', 'aria-label': 'Recovery code' }, code),
      h('button', { class: 'btn btn-sm', onclick: async () => { await copy(code); toast('Code copied. Paste it somewhere safe.'); } }, icon('copy'), 'Copy code'),
      h('label', { class: 'check' }, tick, h('span', null, 'I saved it somewhere safe')), go);
  }, { locked: true });
}

// Recovery: username + code + a new password. Issues a fresh code.
function recoverFlow(closeParent, finish) {
  closeParent?.();
  modal('Recover', (box, close) => {
    const user = h('input', { class: 'input', maxlength: 20, placeholder: 'Username', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username' });
    const code = h('input', { class: 'input mono', maxlength: 40, placeholder: 'Recovery code (XXXXX-XXXXX-…)', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Recovery code' });
    const pw = pwField('New password (10 or more characters)', { autocomplete: 'new-password', label: 'New password' }); const e = err();
    const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Reset and sign in');
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault(); busy(go, true); e.textContent = '';
      try { const r = await api('/api/auth/recover', { method: 'POST', body: { username: user.value.trim(), code: code.value, password: pw.input.value } }); close(); recoveryCodeScreen(r.recovery, { title: 'Password reset. Here is your new code.', onDone: async () => { await afterSignIn(`Welcome back, ${r.username}.`); finish?.(true); } }); }
      catch (x) { e.textContent = x.message; busy(go, false); }
    } }, user, code, pw.el, e, go);
    add(box, h('h3', { class: 'modal-title' }, 'Recover your account'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Your recovery code and a new password reset the account and sign out every other browser. There is no other way back in: we don’t collect e-mail.'), form,
      h('button', { class: 'btn btn-ghost', onclick: () => { close(); finish?.(false); } }, 'Cancel'));
  }, { onClose: () => finish?.(!!S.me?.name) });
}

// For accounts made by X sign-in (or from an older install): set a username (when there is none) and a password; shows the recovery code.
function askCredentials(done = () => {}) {
  modal('Set a password', (box, close) => {
    const user = S.me?.username ? null : h('input', { class: 'input', maxlength: 20, placeholder: 'Username (3–20 letters, numbers, _)', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username' });
    if (user && S.me?.name && /^[A-Za-z0-9_]{3,20}$/.test(S.me.name)) user.value = S.me.name;
    const pw = pwField('Password (10 or more characters)', { autocomplete: 'new-password' }); const e = err();
    const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Save');
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault(); busy(go, true); e.textContent = '';
      try { const r = await api('/api/me/credentials', { method: 'POST', body: { username: user?.value.trim(), password: pw.input.value } }); close(); recoveryCodeScreen(r.recovery, { title: 'Saved. Here is your recovery code.', onDone: async () => { await refresh(); done(true); } }); }
      catch (x) { e.textContent = x.message; busy(go, false); }
    } }, user, pw.el, e, go);
    add(box, h('h3', { class: 'modal-title' }, S.me?.username ? 'Set a password' : 'Set a username and password'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Accounts sign in with a username and password. No e-mail, no phone.'), form,
      h('button', { class: 'btn btn-ghost', onclick: () => { close(); done(false); } }, 'Later'));
  }, { onClose: () => done(false) });
}
function changePasswordFlow() {
  modal('Change password', (box, close) => {
    const cur = pwField('Current password', { label: 'Current password' }); const pw = pwField('New password (10 or more characters)', { autocomplete: 'new-password', label: 'New password' }); const e = err();
    const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Change password');
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault(); busy(go, true); e.textContent = '';
      try { await api('/api/me/password', { method: 'POST', body: { current: cur.input.value, password: pw.input.value } }); close(); toast('Password changed. Other browsers were signed out.'); }
      catch (x) { e.textContent = x.message; busy(go, false); }
    } }, cur.el, pw.el, e, go);
    add(box, h('h3', { class: 'modal-title' }, 'Change password'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Every other browser is signed out when you change it.'), form, h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'));
  });
}

// ---------- the account-side confirmation ----------
// Dormant until accounts and chat open (there is no first-visit card: nothing on the read-only site asks). The
// sign-up and X welcome forms carry the tick; before a first post the server refuses an account without it (403 `adult`)
// and this asks once, in a plain dialog. Remembered in this browser and, once signed in, on the account.
const adultRemembered = () => { try { return !!localStorage.getItem('tbb-adult'); } catch { return false; } };
const forgetAdult = () => { try { localStorage.removeItem('tbb-adult'); } catch { /* */ } }; // on sign-out: the next account answers for itself
// force = the server just said the account has no confirmation (whatever this page thought), so don't trust S.me.
export function ensureAdult(force = false) {
  if (!force && S.me?.adult) return Promise.resolve(true);
  const send = () => api('/api/me/adult', { method: 'POST', body: { confirm: true } }).then(() => refresh()).then(() => true).catch(() => false);
  if (adultRemembered()) return send();
  return new Promise((resolve) => {
    let answered = false;
    modal('Confirm your age', (box, close) => {
      const go = h('button', { class: 'btn btn-primary btn-block', id: 'adultYes', type: 'button', onclick: async () => {
        answered = true; busy(go, true);
        try { localStorage.setItem('tbb-adult', String(Date.now())); } catch { /* private mode: asked again next time */ }
        const ok = await send(); close(); resolve(ok);
      } }, 'I’m 18 or older');
      add(box, h('h3', { class: 'modal-title' }, 'Confirm your age'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Posting needs a one-time confirmation on your account.'), go, h('button', { class: 'btn btn-ghost', onclick: close }, 'Not now'));
    }, { onClose: () => { if (!answered) resolve(false); } });
  });
}

export function askName(done = () => {}) {
  modal('Pick a name', (box, close) => {
    const input = h('input', { class: 'input', maxlength: 24, placeholder: 'e.g. ridgerunner', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Display name' });
    const e = err(); e.style.minHeight = '1em';
    const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Continue');
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault(); busy(go, true); e.textContent = '';
      try { await api('/api/me/name', { method: 'POST', body: { name: input.value } }); await refresh(); close(); done(true); toast(`Welcome to the herd, ${S.me.name}.`); }
      catch (x) { e.textContent = x.message; busy(go, false); }
    } }, input, e, go);
    add(box, h('h3', { class: 'modal-title' }, 'What should the herd call you?'), h('p', { class: 'muted small', style: { margin: 0 } }, 'Not your real name. Pick something you’d be happy to see in chat.'), form);
  }, { onClose: () => done(!!S.me?.name) });
}

// Sign in with X: the person comes back to /#/?x=<what happened>. First time: a welcome step (username + 18+).
export async function xReturn() {
  const m = /^#\/?\?x=([a-z]+)/.exec(location.hash); if (!m) return;
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* */ }
  const what = m[1];
  const MSG = { error: 'Sign in with X didn’t work. Try again, or use a username and password.', busy: 'Sign in with X is busy, use username and password.', closed: SOON_MSG, banned: 'You can’t sign in from this connection right now.', account: 'This account can’t sign in here.',
    toomany: 'Too many new accounts from this connection today. Try again tomorrow.', handle: 'That X handle can’t be used here.', taken: 'That X account is already linked to another account here.', linked: 'X linked.', signin: 'Sign in first, then link X from your account menu.' };
  if (what === 'linked') { await refresh(); toast(MSG.linked); return; }
  if (what !== 'new') { toast(Object.hasOwn(MSG, what) ? MSG[what] : MSG.error, { kind: 'error' }); return; } // own keys only: '?x=constructor' is an unknown code
  let p; try { p = await api('/api/auth/x/pending'); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  modal('Welcome', (box, close) => {
    const user = h('input', { class: 'input', maxlength: 20, placeholder: 'Username (3–20 letters, numbers, _)', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username' }); if (p.suggested) user.value = p.suggested;
    const adult = adultBox(); const e = err();
    const go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Finish');
    const form = h('form', { class: 'stack', onsubmit: async (ev) => {
      ev.preventDefault(); e.textContent = ''; if (!adult.c.checked) { e.textContent = 'Please confirm you are 18 or older.'; return; } busy(go, true);
      try { const r = await api('/api/auth/x/finish', { method: 'POST', body: { username: user.value.trim(), adult: true } }); try { localStorage.setItem('tbb-adult', String(Date.now())); } catch { /* */ } close(); await afterSignIn(`Welcome, ${r.username}.`); }
      catch (x) { e.textContent = x.message; busy(go, false); }
    } }, user, adult.el, e, go);
    add(box, h('h3', { class: 'modal-title' }, `Welcome, @${p.handle}.`), h('p', { class: 'muted small', style: { margin: 0 } }, p.suggested ? 'Your X handle is free here, so it can be your username. Change it if you like.' : 'That name is taken here; pick a username.'),
      h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Your handle shows on your messages as plain text. We keep only your X id and handle, never a token. You can set a password later so X isn’t the only way in.'), form,
      h('button', { class: 'btn btn-ghost', onclick: close }, 'Not now'));
  });
}

// The account menu behind the signed-in button.
export function accountMenu() {
  modal('Account', (box, close) => {
    const me = S.me;
    add(box,
      h('div', { class: 'row' }, h('h3', { class: 'modal-title' }, me.name)),
      h('div', { class: 'row' }, me.username ? h('span', { class: 'chip mono' }, '@' + me.username) : null, me.x ? h('span', { class: 'chip x-chip' }, '𝕏 @' + me.x) : null),
      me.newUntil ? h('p', { class: 'tiny muted', style: { margin: 0 } }, 'New account: reading only for the first 10 minutes, then one message per 10 seconds for a day.') : null,
      h('div', { class: 'stack' },
        !me.hasPassword ? h('button', { class: 'acct-opt', onclick: () => { close(); askCredentials(); } }, icon('lock'), me.username ? 'Set a password' : 'Set a username and password', h('span', { class: 'soon' }, 'recommended')) : null,
        me.hasPassword ? h('button', { class: 'acct-opt', onclick: () => { close(); changePasswordFlow(); } }, icon('lock'), 'Change password') : null,
        S.x && !me.x ? h('a', { class: 'acct-opt', href: '/auth/x/start?link=1' }, h('span', { class: 'x-mark', 'aria-hidden': 'true' }, '𝕏'), 'Link X', h('span', { class: 'soon' }, 'shows your handle')) : null,
        me.x ? h('button', { class: 'acct-opt', onclick: async () => { try { await api('/api/me/x/unlink', { method: 'POST' }); close(); await refresh(); toast('X unlinked.'); } catch (e) { toast(e.message, { kind: 'error' }); } } }, h('span', { class: 'x-mark', 'aria-hidden': 'true' }, '𝕏'), 'Unlink X') : null,
        h('a', { class: 'acct-opt', href: '#/inbox', onclick: close }, icon('inbox'), 'Inbox', me.unread ? h('span', { class: 'soon' }, `${me.unread} new`) : null),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn', style: { flex: '1' }, onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); forgetAdult(); close(); await refresh(); reconnectLive(); toast('Signed out.'); } }, 'Sign out'),
        h('button', { class: 'btn btn-ghost', onclick: async () => { await api('/api/auth/logout', { method: 'POST', body: { everywhere: true } }); forgetAdult(); close(); await refresh(); reconnectLive(); toast('Signed out everywhere.'); } }, 'Sign out everywhere')),
    );
  });
}
