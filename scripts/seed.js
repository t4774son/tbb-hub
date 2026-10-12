#!/usr/bin/env node
// Seeds real starting content: allies (verified links). No chat messages, ever: rooms start empty, and tests or
// screenshots that need messages write their own.
// `--demo` adds clearly fake sample accounts and ideas for screenshots and tests (use a separate DB_FILE).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.js';
import { loadConfig } from '../lib/app.js';

// Links box: third-party sites linked from the token creator's X profile. More are added from the panel's Links section.
// The whitepaper is not a link: it is the creator's poster, shown on this site (Learn → What is $TBB); the drawer adds that row itself.
export const ALLIES = [
  ['TBB Time Machine', 'https://tbbtimemachine.xyz', 'Third-party tool: past purchases priced in sats.'],
  ['The book', 'https://store.bitcoinhard.money', 'Bitcoin Hard Money book store (third party).'],
  ['Creator on X', 'https://x.com/GoingParabolic', 'X profile (third party).'],
  ['Solscan', 'https://solscan.io/token/42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump', 'Token details on a public block explorer.'],
];

// `--demo` account ids: plain, clearly fake, nothing shaped like an address.
export const DEMO_IDS = ['u_demo1', 'u_demo2', 'u_demo3', 'u_demo4'];

export function seed(db, { demo = false } = {}) {
  const t = Date.now();
  if (!db.get('SELECT COUNT(*) n FROM allies').n) ALLIES.forEach(([a, u, b], i) => db.run('INSERT INTO allies(title,url,blurb,sort) VALUES(?,?,?,?)', a, u, b, i));
  if (!demo) return;
  // ---- demo-only sample data (fake account ids, fake names). Never run against the real database.
  const W = DEMO_IDS; const N = ['ridgeRunner', 'emberhoof', 'coldstorage', 'pizzaday'];
  W.forEach((w, i) => db.run("INSERT OR IGNORE INTO users(uid,name,created_at,via) VALUES(?,?,?,'legacy')", w, N[i], t - 30 * 86400_000));
  const ideas = [[0, 'Block-time alarm', 'A little bot that pings Main Chat every time Bitcoin finds a block, with the block’s hidden message if it has one.'],
    [2, 'Bull wallpapers by the herd', 'A monthly wallpaper contest, judged by the herd.'],
    [3, 'Pizza Day tribute', 'Every May 22, the best on-chain pizza tribute gets a shout-out.']];
  ideas.forEach(([w, a, b], i) => { const r = db.run('INSERT INTO ideas(uid,title,body,created_at) VALUES(?,?,?,?)', W[w], a, b, t - (i + 1) * 7200_000); W.slice(0, 3 - i).forEach((v) => v !== W[w] && db.run('INSERT OR IGNORE INTO votes(idea_id,uid,created_at) VALUES(?,?,?)', r.lastInsertRowid, v, t)); });
  db.run('INSERT INTO events(kind,text,link,created_at) VALUES(?,?,?,?)', 'idea', 'New idea: Block-time alarm', '#/build/idea/1', t - 2 * 3600_000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const cfg = loadConfig();
  const file = demo && !process.env.DB_FILE ? path.join(path.dirname(cfg.dbFile), 'demo.db') : cfg.dbFile;
  const db = openDb(file);
  seed(db, { demo });
  console.log(`Seeded ${file}${demo ? ' (demo data)' : ''}`);
}
