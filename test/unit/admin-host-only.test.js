// Administration happens on the admin host behind Cloudflare Access and nowhere else. There is no admin account or
// role on the public host: the old signed admin API does not exist whatever the settings say, the state never carries
// an admin flag, nothing in the published tree names that API or its setting, and every action it had lives in the
// panel (test/unit/admin.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../lib/app.js';
import { newUid, plantUser, sessionFor } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// the names are spelled in pieces here so that this file is not itself a mention of them (the tree scan below)
const API = '/api/' + 'admin'; const SETTING = 'ADMIN_' + 'WALLETS';
const MAKER = 'sel' + 'ler'; const REWARD = 'boun' + 'ty';
const FORMER = [API, `${API}/${MAKER}`, `${API}/${REWARD}`, `${API}/${REWARD}/1/paid`, `${API}/${REWARD}/1/reopen`, `${API}/hide`, `${API}/resolve`, `${API}/ban`, `${API}/ally`];
const OPEN = { CHAT_OPEN: '1', ACCOUNTS_OPEN: '1' };
const rpc = async (method) => { throw new Error('unexpected rpc ' + method); };
const fakeFetch = async () => new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });

function client(base) {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-tbb': '1', origin: 'http://localhost:3000', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, type: res.headers.get('content-type'), cache: res.headers.get('cache-control') };
  };
  return { call, set cookie(v) { cookie = v; } };
}

test('the former signed admin API is the plain 404 on the public host — every setting closed or every one open, for a stranger and for a signed-in member alike; the state has no admin flag; the setting that named admin addresses does nothing', async () => {
  for (const [label, env] of [['closed', {}], ['open', OPEN]]) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tbbnoadm-'));
    const app = createApp({ env: { PORT: '0', LORE_WORKER: 'off', OFFLINE: '1', DB_FILE: path.join(dir, 'a.db'), PUBLIC_ORIGIN: 'http://localhost:3000', [SETTING]: 'DemoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', ...env }, rpc, fetchImpl: fakeFetch, log: () => {} });
    try {
      if (label === 'open') app.settings.set('areas', { chat: true, accounts: true });
      const a = await app.listen(0); const base = `http://127.0.0.1:${a.port}`;
      assert.ok(!app.routes.some((r) => r.pattern.startsWith(API)), label + ': no such route in the table');
      assert.ok(!('admins' in app.config), label + ': the server keeps no list of admin accounts');
      const callers = [['a stranger', client(base)]];
      if (label === 'open') {
        const c = client(base); const uid = plantUser(app.db, newUid('adm'), { name: 'member' }); c.cookie = sessionFor(app.db, uid);
        const st = await c.call('GET', '/api/state'); assert.ok(st.json.me && !('admin' in st.json.me), 'no admin flag in the state: ' + st.text);
        callers.push(['a signed-in member', c]);
      }
      for (const [who, c] of callers) {
        const nope = await c.call('GET', '/api/nope');
        for (const p of FORMER) for (const method of ['GET', 'POST']) {
          const r = await c.call(method, p, method === 'POST' ? { id: 1, title: 'x', body: 'y', reward: 1 } : undefined);
          assert.equal(r.status, 404, `${label}, ${who}: ${method} ${p} answered ${r.status} ${r.text.slice(0, 80)}`);
          assert.equal(r.text, '{"error":"Not found"}', `${label}, ${who}: ${method} ${p} is the plain 404`);
          assert.deepEqual([r.type, r.cache], [nope.type, nope.cache], `${label}, ${who}: ${method} ${p} is indistinguishable from an unknown path`);
        }
      }
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('the published tree never names the former admin API, its setting, or an admin role on the public host', () => {
  const exporter = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => path.join(ROOT, 'scripts', f)).find((f) => /git archive --format=tar HEAD/.test(fs.readFileSync(f, 'utf8')));
  let files;
  if (exporter) { // the working tree: what the export script ships, committed or not
    const allow = /ALLOW=\(([^)]*)\)/.exec(fs.readFileSync(exporter, 'utf8'))[1].split(/\s+/).filter(Boolean);
    const walk = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => walk(path.join(p, f))) : [p]);
    files = allow.filter((f) => fs.existsSync(path.join(ROOT, f))).flatMap((f) => walk(path.join(ROOT, f)));
    try { files.push(...execFileSync('git', ['ls-files', '--', ...allow], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => path.join(ROOT, f))); } catch { /* not a git repository */ }
  } else { // the published tree: everything in it
    const walk = (p) => (fs.statSync(p).isDirectory() ? (path.basename(p) === '.git' || path.basename(p) === 'node_modules' || path.basename(p) === 'data' ? [] : fs.readdirSync(p).flatMap((f) => walk(path.join(p, f)))) : [p]);
    files = walk(ROOT);
  }
  const TEXT = /\.(js|mjs|cjs|html|css|md|json|yml|yaml|txt|py|sh|example|gitignore)$/;
  const needles = [SETTING, API + '/', API + "'", API + '"', API + '`', API + ' ', 'is' + 'Admin', 'need' + 'Admin', 'admin' + 'Accounts', 'me.' + 'admin', 'me?.' + 'admin', '#/' + 'admin'];
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f) || !fs.existsSync(f) || !TEXT.test(f) || fs.statSync(f).isDirectory()) continue; seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    for (const n of needles) assert.ok(!src.includes(n), `${path.relative(ROOT, f)} mentions ${JSON.stringify(n)}`);
  }
  assert.ok(seen.size > 50, 'the tree was scanned: ' + seen.size);
});
