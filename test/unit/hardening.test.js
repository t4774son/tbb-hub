// Hardening: anonymous Help notes (links refused, 20 a day per connection, 40 a day per IPv4 /24, a full inbox refuses
// rather than drops, senders remembered as expiring keyed hashes), the live stream grouped by IPv6 /48, CSP without blob:,
// the admin panel's h() with the public page's URL filter, richText https only, the privacy wording, the privacy scanner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp, v6prefix, v6prefix48 } from '../../lib/app.js';
import { LINK_MSG } from '../../lib/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbp12-'));
let app; let base; let port;
before(async () => {
  app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', PUBLIC_ORIGIN: 'http://localhost:3000', CLIENT_IP_HEADER: 'x-test-ip', DB_FILE: path.join(dir, 'p12.db') },
    rpc: async () => { throw new Error('offline'); }, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), log: () => {} });
  port = (await app.listen(0)).port; base = `http://127.0.0.1:${port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const note = async (reason, ip) => {
  const res = await fetch(base + '/api/report', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tbb': '1', 'x-test-ip': ip }, body: JSON.stringify({ kind: 'problem', target: 'help', reason }) });
  return { status: res.status, ...(await res.json()) };
};
const open = () => app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem' AND resolved=0").n;

test('IPv6 is grouped by /48 for every limiter, cap and ban hash: the same /48 across different /56s and /64s is one visitor', () => {
  assert.equal(v6prefix('2001:db8:1:1ff::2'), '2001:db8:1:1ff::/64');
  assert.equal(v6prefix48('2001:db8:1:1ff::2'), '2001:db8:1::/48');
  assert.equal(v6prefix48('2001:db8:1:100::/64'), '2001:db8:1::/48', 'accepts the /64 form too');
  assert.equal(v6prefix48('2001:db8:1:f200::1'), '2001:db8:1::/48', 'another /56 of the same /48');
  assert.equal(v6prefix48('2001:db8:2::1'), '2001:db8:2::/48');
  assert.equal(v6prefix48('2001:0db8:0001:01AB:0:0:0:1'), '2001:db8:1::/48', 'long form, upper case');
  assert.equal(v6prefix48('203.0.113.9'), '203.0.113.9', 'IPv4 is itself');
});

test('a Help note with a link is refused (zero links, like everything typed on the site)', async () => {
  assert.deepEqual(await note('the chart is broken, see example.com/claim-now', '203.0.113.10'), { status: 422, error: LINK_MSG });
  assert.deepEqual(await note('the chart is broken, see https://evil.example/x', '203.0.113.10'), { status: 422, error: LINK_MSG });
  assert.equal((await note('the chart is broken on my phone', '203.0.113.10')).status, 200);
  assert.equal(app.db.get("SELECT COUNT(*) n FROM reports WHERE kind='problem' AND reason LIKE '%example%'").n, 0, 'nothing with a link was stored');
});

test('anonymous Help notes: 20 a day per connection (IPv6 by /48); the 21st is refused, another /48 is not', async () => {
  // five /56s inside one /48, four notes each; the per-minute limiter (a burst of five, per /48 like everything) is
  // emptied between batches so the daily cap is what answers
  for (let i = 0; i < 5; i++) { app.limiter.forget('report:' + v6prefix48('2001:db8:7::1')); for (let j = 0; j < 4; j++) assert.equal((await note(`note ${i}-${j}`, `2001:db8:7:${(0x100 * (i + 1)).toString(16)}::1`)).status, 200, `note ${i}-${j}`); }
  app.limiter.forget('report:' + v6prefix48('2001:db8:7::1'));
  const r = await note('one too many', '2001:db8:7:9f00::9');
  assert.equal(r.status, 429); assert.match(r.error, /enough notes for today/i);
  assert.equal((await note('a neighbour', '2001:db8:8::1')).status, 200, 'a different /48 is a different visitor');
  assert.equal((await note('someone else', '203.0.113.77')).status, 200);
});

test('anonymous Help notes: 40 a day per IPv4 /24 as well, so a handful of neighbouring addresses cannot fill the inbox; the next /24 is untouched', async () => {
  // three addresses of one /24, 14 notes each (under their own 20): the 41st note of the /24 is refused whoever sends it
  let sent = 0; let refused = null;
  for (let a = 1; a <= 3 && !refused; a++) for (let j = 0; j < 14 && !refused; j++) {
    if (j % 5 === 0) app.limiter.forget('report:198.51.100.' + a);
    const r = await note(`block note ${a}-${j}`, '198.51.100.' + a); if (r.status === 429) refused = r; else { assert.equal(r.status, 200, `note ${a}-${j}`); sent++; }
  }
  assert.ok(refused && sent === 40, `refused after ${sent}: ${JSON.stringify(refused)}`); assert.match(refused.error, /enough notes for today/i);
  app.limiter.forget('report:198.51.100.9'); assert.equal((await note('a fourth address of the same block', '198.51.100.9')).status, 429, 'a fresh address in the /24 shares its cap');
  assert.equal((await note('the next block', '198.51.101.1')).status, 200, 'another /24 is another neighbourhood');
});

test('senders of Help notes are remembered as keyed hashes only, and an entry is dropped within 24 hours', async () => {
  assert.equal((await note('remember me', '203.0.113.123')).status, 200);
  assert.equal((await note('remember me too', '2001:db8:77::5')).status, 200);
  const keys = [...app.helpNotesKeys()];
  assert.ok(keys.length >= 2 && keys.every((k) => /^[0-9a-f]{64}$/.test(k)), 'every key is a hex digest: ' + keys.slice(0, 3));
  assert.ok(!keys.some((k) => k.includes('203.0.113.123') || k.includes('2001:db8') || k.includes('/48')), 'no raw address or prefix');
  assert.ok(keys.includes(app.ipHash('203.0.113.123')), 'keyed by the same HMAC as every other IP hash');
  const before = keys.length;
  app.helpNotesAge(app.ipHash('203.0.113.123'), 24 * 3600_000 - 60_000); // one minute short of a day old
  app.housekeeping();
  assert.ok(!app.helpNotesKeys().includes(app.ipHash('203.0.113.123')), 'purged before the day is out'); assert.equal(app.helpNotesKeys().length, before - 1);
  app.limiter.forget('report:203.0.113.123'); assert.equal((await note('a fresh day', '203.0.113.123')).status, 200);
});

test('when 500 notes are open, a new anonymous note is refused: nothing a flood sends can push an older note out before the admin reads it', async () => {
  app.db.run("DELETE FROM reports WHERE kind='problem'");
  const t = Date.now() - 1000;
  app.db.raw.exec(`INSERT INTO reports(kind,target,uid,reason,created_at) ${Array.from({ length: 500 }, (_, i) => `SELECT 'problem','help',NULL,'flood ${i}',${t + i}`).join(' UNION ALL ')}`);
  assert.equal(open(), 500);
  const r = await note('the newest note', '203.0.113.50');
  // the same answer as any other limit: a visitor must not learn from the refusal whether the admin has been clearing notes
  assert.deepEqual(r, { status: 429, error: 'Slow down a little.' });
  assert.ok(!/inbox is full/i.test(fs.readFileSync(path.join(ROOT, 'lib/app.js'), 'utf8')), 'no wording about the inbox');
  assert.equal(open(), 500, 'the inbox does not grow');
  assert.ok(app.db.get("SELECT 1 FROM reports WHERE reason='flood 0'") && !app.db.get("SELECT 1 FROM reports WHERE reason='the newest note'"), 'the oldest note stays, the new one was not stored');
  app.db.run("DELETE FROM reports WHERE kind='problem'");
});

// One live stream: resolves with the hello event's data and a handle to close it.
function stream(ip) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { 'x-test-ip': ip, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, close: () => req.destroy() }); }
      let buf = '';
      res.on('data', (d) => { buf += d; const m = /event: hello\ndata: (.*)\n/.exec(buf); if (m) { res.removeAllListeners('data'); res.on('data', () => {}); resolve({ status: 200, hello: JSON.parse(m[1]), close: () => req.destroy() }); } });
    });
    req.on('error', reject);
  });
}

// A refusal of the stream as the client sees it: status, body and the headers that could differ between two reasons.
async function refusal(ip) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { 'x-test-ip': ip, accept: 'text/event-stream' } }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => k !== 'date')) }));
    });
    req.on('error', reject);
  });
}

test('live stream: at most six streams per /48 (not per /56 or /64); every refusal is the same generic "slow down", whatever the reason', async () => {
  const opened = [];
  try {
    // the token bucket (10 a minute, burst 5) is per /48 like the count: emptied between attempts so the count cap is what answers
    const fresh = () => app.limiter.forget('sse:' + v6prefix48('2001:db8:9::1'));
    for (let i = 0; i < 3; i++) { fresh(); opened.push(await stream('2001:db8:9:100::1')); }
    for (let i = 0; i < 3; i++) { fresh(); opened.push(await stream('2001:db8:9:aa00::1')); }
    assert.deepEqual(opened.map((s) => s.status), [200, 200, 200, 200, 200, 200]);
    fresh(); const seventh = await refusal('2001:db8:9:ff00::1');
    assert.equal(seventh.status, 429, 'the seventh stream from the same /48 is refused');
    const other = await stream('2001:db8:a::1'); opened.push(other);
    assert.equal(other.status, 200, 'a different /48 is a different visitor');
    // the per-connection token bucket (10 a minute, burst 5): the sixth quick attempt from one address is refused
    for (let i = 0; i < 5; i++) opened.push(await stream('203.0.113.61'));
    const bucket = await refusal('203.0.113.61');
    assert.equal(bucket.status, 429);
    // the global cap (config.sseMax, 2000 live; lowered here): refused the same way, so nobody can tell "the site is full"
    // from "you are going too fast" — nothing about how many streams are open leaves the server
    app.config.sseMax = 0;
    const full = await refusal('203.0.113.62');
    assert.deepEqual(full, bucket, 'the global cap and the per-connection bucket answer byte for byte the same');
    assert.deepEqual(seventh, bucket, 'and so does the per-/48 cap');
    assert.equal(full.body, 'slow down');
  } finally { app.config.sseMax = 2000; for (const s of opened) s.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('live stream: the hello frame carries one fixed ttl whatever the load (no soft cap, no shorter stream under load)', async () => {
  const opened = [];
  try {
    const a = await stream('203.0.113.63'); opened.push(a);
    assert.deepEqual(Object.keys(a.hello).sort(), ['height', 'ttl']); assert.equal(a.hello.ttl, 3600_000);
    assert.equal(app.config.sseSoft, undefined, 'no soft cap in the config');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'app.js'), 'utf8');
    assert.ok(!/sseSoft|300_000/.test(src), 'the five-minute "under load" lifetime is gone from the server');
  } finally { for (const s of opened) s.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('CSP: img-src allows self and data: only (no blob:); nothing in the page scripts uses blob URLs', async () => {
  const res = await fetch(base + '/', { headers: { host: 'localhost:3000' } }); await res.text();
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data:;/); assert.ok(!csp.includes('blob:'), csp);
  // Trusted Types: no page code writes HTML (textContent and DOM nodes only), so every HTML sink is a hard error from now on
  assert.ok(csp.includes("require-trusted-types-for 'script'") && csp.includes("trusted-types 'none'"), csp);
  for (const f of ['public/js/ui.js', 'public/js/app.js', 'public/js/views.js', 'public/js/views-closed.js', 'public/js/account.js', 'admin/admin.js']) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/.test(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/[^\n]*/g, '')), f + ' uses an HTML sink');
  for (const f of ['public/js/ui.js', 'public/js/app.js', 'public/js/views.js', 'admin/admin.js']) assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes('blob:'), f);
});

// A tiny stand-in for the DOM: enough for h() and richText() to build elements and record attributes.
function fakeDom() {
  class Node { constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.style = {}; this.dataset = {}; } setAttribute(k, v) { this.attrs[k] = v; } addEventListener() {} append(...k) { this.kids.push(...k); } replaceChildren() { this.kids = []; } set className(v) { this.attrs.class = v; } get className() { return this.attrs.class; } set textContent(v) { this.text = v; } get textContent() { return this.text; } }
  const document = { createElement: (t) => new Node(t), createElementNS: (ns, t) => new Node(t), createTextNode: (t) => Object.assign(new Node('#text'), { text: String(t) }), createDocumentFragment: () => new Node('#frag') };
  return { document, Node };
}
const URL_CASES = [
  // [attr, value, expected attribute value or null when it must be dropped]
  ['href', ' https://a.example/x ', 'https://a.example/x'],
  ['href', 'https://a.example/\\x', null], ['href', 'https://a.example/\u0000x', null], ['href', 'https://a.example/x\u001f', null],
  ['href', '//evil.example', null], ['href', '/\\evil.example', null], ['href', 'javascript:alert(1)', null], ['href', 'http://a.example', null], ['href', 'data:text/html,hi', null],
  ['href', '#/learn', '#/learn'], ['href', '/img/abc.png', '/img/abc.png'], ['href', 'mailto:x@example.com', 'mailto:x@example.com'],
  ['src', 'javascript:alert(1)', null], ['src', '//evil.example/x.png', null], ['src', 'blob:https://a.example/1', null], ['src', 'https://a.example/\\x.png', null],
  ['src', 'data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'], ['src', 'data:text/html,hi', null], ['src', '/img/abc.png', '/img/abc.png'],
  ['srcdoc', '<script>1</script>', null], ['formaction', 'https://a.example', null], ['srcset', '/x.png 1x', null], ['ping', 'https://a.example', null], ['action', 'https://a.example', null], ['xlink:href', '#x', null],
];
function checkUrlFilter(h, label) {
  for (const [k, v, want] of URL_CASES) {
    const el = h('a', { [k]: v, class: 'x' });
    assert.equal(el.attrs[k], want ?? undefined, `${label}: ${k}=${JSON.stringify(v)}`);
  }
}

test("the admin panel's h() filters href and src like the public page: trim, no control characters or backslashes, no srcdoc/formaction/srcset", () => {
  const src = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');
  const end = src.indexOf('\n}\n', src.indexOf('\nfunction h(')); assert.ok(end > 0, 'h() found');
  const head = src.slice(0, end + 2).split('\n').filter((l) => !l.startsWith('import ')).join('\n');
  const { document, Node } = fakeDom();
  const h = new Function('document', 'Node', head + '\nreturn h;')(document, Node);
  checkUrlFilter(h, 'admin');
});

test("the public page's h() keeps the same rules (and sets the trimmed value); richText links https only", async () => {
  const { document, Node } = fakeDom(); globalThis.document = document; globalThis.Node = Node;
  const ui = await import('../../public/js/ui.js');
  checkUrlFilter(ui.h, 'public');
  const frag = ui.richText('see http://a.example/x and https://b.example/y now');
  const anchors = frag.kids.filter((k) => k.tag === 'a');
  assert.equal(anchors.length, 1); assert.equal(anchors[0].attrs.href, 'https://b.example/y');
  assert.ok(frag.kids.some((k) => (typeof k === 'string' ? k : k.text || '').includes('http://a.example/x')), 'the http link stays plain text');
});

test('privacy wording: hashed IP on sign-up, sign-in and post (not reversible without the server secret), Help notes kept until cleared, no session flag any more', () => {
  const views = fs.readFileSync(path.join(ROOT, 'public/js/views.js'), 'utf8');
  for (const phrase of ['When you sign up, sign in or post, we keep a hashed form of your IP', 'reversed without the server’s secret', 'Help notes', 'until the admin clears']) assert.ok(views.includes(phrase), phrase);
  // the Help-note sender is remembered as a keyed hash for a day (the daily cap), never as the address: said in both versions of the notice
  assert.equal(views.split('a keyed hash of the connection behind a Help note is kept in memory for up to 24 hours to cap notes per connection, never the address itself').length, 3, 'both notices say what is kept about a Help note');
  assert.ok(!views.includes('session flag') && !views.includes('tbb-seen'), 'no session flag: there is no opening reveal to remember');
  assert.ok(!views.includes('nobody can turn the hash back into it'), 'the old absolute claim is gone');
});

test('privacy scan: private networks (192.168, 10/8, 100.64/10, ULA), tailnet/.local hosts, time zones, home paths, Access teams and foreign workers.dev hosts fail; dated notes in comments or docs, build-round numbers in text or file names and the role word fail in published files; the token-account field, old dates, the files the rules file keeps private, the allow-listed board and a bare UTC pass; words from the rules file warn', () => {
  // the rules file (private, read from PRIVACY_RULES like the word list): which files stay with the operator, which words
  // name a build round, which words only warn. Every word here is made up: the real rules file is never published.
  const RULES = 'private-file: ^TEAM-NOTES\\.md$\nround-word: sprint\nround-word: cycle\nwarn: \\bhuddle\\b\nwarn: TEAM-NOTES\n';
  const run = (files, rules = RULES) => {
    const d = fs.mkdtempSync(path.join(dir, 'scan-')); fs.writeFileSync(path.join(d, '.privacy-words'), 'zzqqnevermatch\n'); // skipped by name, as in the repo
    const env = { ...process.env, PRIVACY_WORDS: path.join(d, '.privacy-words') };
    if (rules) { fs.writeFileSync(path.join(d, '.privacy-rules'), rules); env.PRIVACY_RULES = path.join(d, '.privacy-rules'); } else env.PRIVACY_RULES = '';
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
    const r = spawnSync('python3', [path.join(ROOT, 'scripts/privacy-scan.py'), d], { env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  // every address, date, round and role word is assembled at run time: this file is scanned too, and must not spell what the scanner looks for
  const dots = (...p) => p.join('.'); const role = ['own', 'er'].join(''); const date = (y, m, d) => [y, m, d].join('-');
  const leaks = { 'a.md': 'router at ' + dots(192, 168, 1, 5), 'b.md': 'box ' + dots(10, 0, 0, 7) + ' here', 'c.md': 'cgnat ' + dots(100, 64, 3, 9), 'd.md': 'host ' + dots('box', 'tail1234', 'ts', 'net'),
    'e.md': 'printer ' + dots('mybox', 'local') + ' on the lan', 'f.md': 'ula ' + ['fd12', '3456', '789a', '', '1'].join(':'), 'g.md': 'tz ' + ['America', 'Chicago'].join('/'),
    'h.md': ['Pa', 'cific'].join('') + ' time', 'i.md': 'at 9 P' + 'DT', 'j.md': 'at 9 P' + 'ST', 'k.md': 'team ' + dots('myteam', 'cloudflareaccess', 'com'), 'l.md': 'https://' + dots('other-thing', 'someone', 'workers', 'dev') + '/',
    'm.md': 'tz ' + ['Europe', 'Berlin'].join('/'), 'n.md': 'meet at ' + ['UTC', '+2'].join(''), 'o.md': 'kept in ' + ['/ro', 'ot/'].join('') + 'keys' };
  const r = run(leaks);
  assert.equal(r.code, 1, r.out);
  for (const f of Object.keys(leaks)) assert.ok(new RegExp(`LEAK\\? ${f}:`).test(r.out), `${f} flagged: ${r.out}`);
  // the publication voice: a dated comment, a dated line in a doc, a build round in text or a file name (the generic words
  // build/round, and the words the rules file adds), the role word in prose
  const voice = { 'v1.js': 'const x = 1; // changed on ' + date(2026, 10, 10), 'v2.md': 'Shipped ' + date(2025, '01', '02') + '.', 'v3.css': '/* ' + ['sprint', '13'].join(' ') + ': the dock */',
    'v4.js': "test('" + ['cycle', '2'].join(' ') + ": gates', () => {});", 'v5.js': '// the ' + role + ' asked for this', 'v6.html': '<p>Only the ' + role + ' sees this.</p>', 'v7.md': 'done in ' + ['build', '4b'].join(' '),
    [['sprint', '3.test.js'].join('')]: 'export const a = 1;', [['cycle', '12.md'].join('')]: 'notes', [['round', '7.md'].join('')]: 'notes' };
  const v = run(voice);
  assert.equal(v.code, 1, v.out);
  assert.ok(/VOICE\? v1\.js: dated note/.test(v.out) && /VOICE\? v2\.md: dated note/.test(v.out), 'dated notes: ' + v.out);
  assert.ok(/VOICE\? v3\.css: build-round number/.test(v.out) && /VOICE\? v4\.js: build-round number/.test(v.out) && /VOICE\? v7\.md: build-round number/.test(v.out), 'round numbers: ' + v.out);
  assert.ok(new RegExp('VOICE\\? v5\\.js: the word "' + role + '"').test(v.out) && new RegExp('VOICE\\? v6\\.html: the word "' + role + '"').test(v.out), 'the role word: ' + v.out);
  for (const f of Object.keys(voice).slice(-3)) assert.ok(new RegExp(`VOICE\\? ${f.replace('.', '\\.')}: file named after a build round`).test(v.out), f + ': ' + v.out);
  // without a rules file the defaults are generic: the made-up words are nobody's, build/round still are
  const plain = run({ 'p1.md': 'done in ' + ['sprint', '13'].join(' '), 'p2.md': 'done in ' + ['round', '13'].join(' ') }, null);
  assert.equal(plain.code, 1); assert.ok(!/p1\.md/.test(plain.out) && /VOICE\? p2\.md: build-round number/.test(plain.out), plain.out);
  // what passes: the token-account field and a quoted bare word in a name list, a date in code (not a comment), an old date, the
  // private notes (left out of the export, so they may say anything), the allow-listed board, and a UTC without an offset
  const ok = run({ 'board.md': 'the board https://tbb-buyer-board.garden-equity-field-0042.workers.dev/ and the .local suffix check and workers.dev in general',
    'notes.md': 'Read the huddle notes; see TEAM-NOTES.md',
    'code.js': "if (h.endsWith('.local')) return ''; const tz = 'UTC'; const w = b." + role + "; const k = { " + role + ": 1, \"" + role + "\": 2 }; const names = ['admin', '" + role + "']; const re = /mod|" + role + "|dev/; const t = Date.parse('" + date(2030, '01', '03') + "T00:00:00Z'); // the genesis block: " + date(2009, '01', '03'),
    'TEAM-NOTES.md': 'the ' + role + ' said on ' + date(2026, 10, 10) + ' after ' + ['sprint', '13'].join(' ') + ': fine', 'lore.md': 'Block 0 was mined on ' + date(2009, '01', '03') + '.' });
  assert.equal(ok.code, 0, ok.out);
  assert.ok(!ok.out.includes('LEAK?') && !ok.out.includes('VOICE?'), ok.out);
  for (const w of ['huddle', 'TEAM-NOTES']) assert.ok(new RegExp(`WARN\\? notes\\.md: .*${w}`).test(ok.out), `${w} warned: ${ok.out}`);
  assert.ok(ok.out.trim().endsWith('privacy scan: clean'), ok.out);
  // the published scanner carries nothing of the private side: no file names, no round words beyond the generic two
  const scanner = fs.readFileSync(path.join(ROOT, 'scripts/privacy-scan.py'), 'utf8');
  // the private names live only in the operator's rules file: the scanner, the docs and the tests never spell them out
  // (only the distinctive ones: file-like names, not ordinary words; skipped where the rules file is absent)
  const rulesFile = process.env.PRIVACY_RULES || path.join(ROOT, '.privacy-rules');
  if (fs.existsSync(rulesFile)) {
    const tokens = fs.readFileSync(rulesFile, 'utf8').split('\n').map((l) => l.match(/^\s*(?:private-file|warn):\s*(.+)$/)).filter(Boolean)
      .flatMap((m) => m[1].replace(/\\\./g, '.').split(/[^A-Za-z0-9_.-]+/)).filter((t) => t.length >= 5 && /[A-Z]|[.-]/.test(t));
    const files = ['scripts/privacy-scan.py', 'README.md', 'SECURITY.md', 'DECISIONS.md', ...fs.readdirSync(path.join(ROOT, 'test/unit')).map((f) => 'test/unit/' + f)];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const t of tokens) assert.ok(!text.includes(t), `${f} spells out a private name from the rules file`);
    }
  }
  assert.ok(/PRIVACY_RULES/.test(scanner) && /round-word/.test(scanner) && /private-file/.test(scanner), 'the rules file is read from PRIVACY_RULES');
});

// ---- one grouping for every limiter, hard caps on every map, the limiter before any database touch ----
const post = (p, ip, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip, ...headers }, body: '{}' });

test('every limiter keys IPv6 by /48: the API token bucket is shared by two /56s of one /48, a different /48 has its own', async () => {
  // 600 a minute with a burst of 120 per connection, on an unknown path (no body is read, nothing is looked up). The
  // first /56 spends 100 tokens; the second /56 of the same /48 is refused long before 120 of its own (the bucket refills
  // ten a second, so the count is a range, not a number).
  for (let i = 0; i < 100; i++) assert.equal((await post('/api/no-such-thing', '2001:db8:c:100::1', { 'x-tbb': '1' })).status, 404);
  let sent = 0; let status = 404;
  while (status === 404 && sent < 100) { status = (await post('/api/no-such-thing', '2001:db8:c:ff00::1', { 'x-tbb': '1' })).status; sent++; }
  assert.equal(status, 429, 'the second /56 is refused: the bucket is the /48\'s');
  assert.ok(sent < 100, `refused after ${sent} of its own, not 120`);
  assert.equal((await post('/api/no-such-thing', '2001:db8:d::1', { 'x-tbb': '1' })).status, 404, 'the next /48 is another visitor');
});

test('the per-connection limit runs before the CSRF check, the ban lookup or any database work: a write without the header still spends a token', async () => {
  let status = 403; let sent = 0;
  while (status === 403 && sent < 200) { status = (await post('/api/no-such-thing', '203.0.113.90')).status; sent++; }
  assert.equal(status, 429, 'header-less writes are 403 until the limiter (burst 120, refilling ten a second) says 429');
  assert.ok(sent > 100 && sent < 200, `the limiter counted every one: ${sent}`);
  // an expired ban row is not deleted on the request path (that was a write lock per request); the housekeeping timer prunes it
  app.db.run('INSERT INTO ip_bans(ip_hash,until,reason,uid,created_at) VALUES(?,?,?,?,?)', 'stale-hash', Date.now() - 1000, '', null, Date.now() - 2000);
  await post('/api/no-such-thing', '203.0.113.91', { 'x-tbb': '1' });
  assert.ok(app.db.get("SELECT 1 FROM ip_bans WHERE ip_hash='stale-hash'"), 'the request did not write to the database');
  app.housekeeping();
  assert.equal(app.db.get("SELECT 1 FROM ip_bans WHERE ip_hash='stale-hash'"), undefined, 'the timer\'s job dropped the expired ban');
});

test('the Help-note counter has a hard ceiling with oldest-first eviction (config.helpNotesMax; 50,000 live)', async () => {
  assert.equal(app.config.helpNotesMax, 50_000);
  app.config.helpNotesMax = 2;
  try {
    for (let i = 0; i < 20; i++) { if (i % 5 === 0) app.limiter.forget('report:' + v6prefix48('2001:db8:e:100::1')); assert.equal((await note(`cap ${i}`, '2001:db8:e:100::1')).status, 200); }
    app.limiter.forget('report:' + v6prefix48('2001:db8:e:100::1'));
    assert.equal((await note('cap 21', '2001:db8:e:100::1')).status, 429, 'the daily cap');
    assert.equal((await note('from b', '203.0.113.92')).status, 200);
    assert.equal((await note('from c', '203.0.113.93')).status, 200, 'the third connection evicts the oldest entry');
    assert.equal((await note('cap again', '2001:db8:e:100::1')).status, 200, 'the evicted connection starts a fresh count (the ceiling is a memory bound, not a loophole worth more than 50,000 addresses)');
  } finally { app.config.helpNotesMax = 50_000; app.db.run("DELETE FROM reports WHERE kind='problem'"); }
});
