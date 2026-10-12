#!/usr/bin/env node
// Entry point. Loads .env (if present), starts the hub on 127.0.0.1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';

process.umask(0o077); // everything this process creates (database, WAL) is readable by its own user only

const dir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const app = createApp();
const addr = await app.listen();
console.log(`The Bitcoin Bull hub on http://${addr.address}:${addr.port}`);
console.log(`Chat: ${app.config.chatOpen ? 'open' : 'soon (CHAT_OPEN=1 allows it)'} · Accounts: ${app.config.accountsOpen ? 'open' : 'soon (ACCOUNTS_OPEN=1 allows them)'}`);
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
