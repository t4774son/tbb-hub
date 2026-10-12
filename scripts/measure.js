#!/usr/bin/env node
// First-visit cost, measured locally: bytes on the wire, requests, server time for /, and (with Chromium) time to first paint.
// Usage: node scripts/measure.js            (set PLAYWRIGHT_CORE / CHROME like the e2e tests for the browser part)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from '../lib/app.js';
import { seed } from './seed.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbmeasure-'));
const app = createApp({ env: { OFFLINE: '1', LORE_WORKER: 'off', DB_FILE: path.join(dir, 'm.db'), PUBLIC_ORIGIN: 'http://localhost:3000', PORT: '0' }, log: () => {} });
seed(app.db);
const a = await app.listen(0); const base = `http://127.0.0.1:${a.port}`;
const H = { 'accept-encoding': 'br, gzip', host: 'localhost:3000' };

const t0 = performance.now();
const index = await fetch(base + '/', { headers: H });
const html = await index.text();
const ttfb = performance.now() - t0;
// What a desktop browser fetches for the home page: head assets, the module graph, the wide hero, and the first API calls.
const urls = new Set();
for (const m of html.matchAll(/<(link|script)([^>]+)>/g)) { const href = /(?:href|src)="([^"]+)"/.exec(m[2])?.[1]; if (href && href.startsWith('/') && !/rel="(?:canonical|apple-touch-icon)"/.test(m[2])) urls.add(href); }
for (const m of html.matchAll(/<source[^>]*srcset="([^"]+)"[^>]*>/g)) { const first = m[1].split(',').map((s) => s.trim().split(' ')[0]); if (!m[0].includes('max-aspect-ratio')) { urls.add(first[first.length - 1]); break; } }
for (const p of ['/api/state', '/api/chart', '/api/allies', '/api/lore?n=20']) urls.add(p);
const rows = []; let wire = 0; let raw = 0;
for (const u of urls) {
  const r = await fetch(base + u, { headers: H }); const buf = Buffer.from(await r.arrayBuffer());
  // what the stylesheet pulls in by itself (fonts, images): counted too, data: URLs cost nothing extra
  if (u.endsWith('.css')) for (const m of buf.toString('utf8').matchAll(/url\(['"]?(\/[^'")]+)['"]?\)/g)) urls.add(m[1]);
  const len = Number(r.headers.get('content-length') || buf.length);
  wire += len; raw += buf.length;
  rows.push({ url: u, status: r.status, wire: len, enc: r.headers.get('content-encoding') || '-', cache: r.headers.get('cache-control') || '-' });
}
rows.push({ url: '/ (html)', status: index.status, wire: Number(index.headers.get('content-length') || html.length), enc: index.headers.get('content-encoding') || '-', cache: index.headers.get('cache-control') || '-' });
wire += rows[rows.length - 1].wire; raw += html.length;
console.table(rows);
console.log(`requests: ${rows.length}  wire bytes: ${wire} (${(wire / 1024).toFixed(0)} KB)  decoded: ${(raw / 1024).toFixed(0)} KB  server time for /: ${ttfb.toFixed(1)} ms`);

// Browser part: real Chromium, cold cache, desktop + phone.
try {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
  const CHROME = process.env.CHROME || path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  for (const [name, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const page = await ctx.newPage();
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#linksList .link-row'));
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]));
      const res = performance.getEntriesByType('resource');
      const nav = performance.getEntriesByType('navigation')[0];
      return { fcp: paint['first-contentful-paint'], requests: res.length + 1, transfer: res.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav?.transferSize || 0), domContentLoaded: Math.round(nav?.domContentLoadedEventEnd || 0), load: Math.round(nav?.loadEventEnd || 0) };
    });
    console.log(`${name}: first contentful paint ${m.fcp} ms · DOMContentLoaded ${m.domContentLoaded} ms · load ${m.load} ms · ${m.requests} requests · ${(m.transfer / 1024).toFixed(0)} KB transferred`);
    await ctx.close();
  }
  await browser.close();
} catch (e) { console.log('(browser timing skipped: ' + e.message.split('\n')[0] + ')'); }
await app.close(); fs.rmSync(dir, { recursive: true, force: true });
