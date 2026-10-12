# The Bitcoin Bull — community hub

[![Live site matches this commit](https://github.com/t4774son/tbb-hub/actions/workflows/verify-live.yml/badge.svg)](https://github.com/t4774son/tbb-hub/actions/workflows/verify-live.yml)

The community site for the $TBB meme token on Solana: a read-only, one-screen dashboard with the live price and
24 h chart, TBB staked, the Season 1 competition, the Story, a Links box, Learn (what $TBB is, staking, safety,
Bitcoin lore) and Help. It never asks for a wallet, a signature or money, and carries no code that could: nothing here
connects, signs, builds or checks a transaction, or sells anything. The rest is built and switched off until it is safe
to open: text-only chat with rule-based moderation, an ideas board with votes, username + password accounts, and Sign in with X.

Two looks with identical features: the night ridge (dark) and a 2009-style window (light). No tracking, no analytics,
no CDNs, zero runtime dependencies. See DECISIONS.md for the principles and SECURITY.md for the threat model.

## Run it locally

Needs Node 24 or newer (the built-in `node:sqlite` is used). Nothing to install.

```bash
cp .env.example .env      # every setting is optional for a local run
npm run seed              # links + starting content (safe to re-run)
npm start                 # http://127.0.0.1:3000
```

Demo data for a look around (a separate database, fake names):

```bash
DB_FILE=data/demo.db npm run seed -- --demo
DB_FILE=data/demo.db LORE_WORKER=off npm start
```

Every area is closed by default; the `*_OPEN` settings in `.env` are the ceiling and the admin panel (see below) opens
an area underneath them. Set `CHAT_OPEN=1 ACCOUNTS_OPEN=1` to see everything.

## Tests

```bash
npm test                  # unit + API tests: real HTTP, mocked chain, the admin host with a local RSA key, the story
                          # parser, the zero-link detector (every link shape and disguise), the scam filter, moderation end
                          # to end, accounts (scrypt, rules, proof of work, throttling, recovery, slow start), IP hashing
                          # and bans, Sign in with X against a fake X server, the launch surface route by route, the
                          # dashboard-only guard (no wallet or commerce code, former routes 404, the database brought
                          # over), the asset build and the live-site verifier (match, and a tampered file)
npm run test:e2e          # browser tests (real Chromium): the launch home, history, the live labels, one-screen layout at
                          # seven sizes, the first visit, the share line, text-only chat, sign-up / sign-in / recovery in
                          # the dialog, the admin panel and its moderation screens, the ban + IP flow.
                          # Needs playwright-core: set PLAYWRIGHT_CORE=/path/to/playwright-core if it is not installed here;
                          # ONLY="admin moderation" runs a subset
npm run shots -- --launch # what visitors see at launch (every *_OPEN flag unset, no X): home ·
                          # Learn · Links, dark and light, 1440x900 / 390x844 / 360x640 / 320x640 → shots/launch/
npm run shots             # screenshots of every state → shots/ (or --out DIR)
npm run test:net          # live network: decodes real Bitcoin blocks
```

## Verify the live site

What `https://thebitcoinbull.club` serves should be exactly this repository, built the way the server builds it. The
verifier rebuilds every public file with the server's own asset build (content-hashed names, rewritten references),
downloads the live HTML and every asset it references, and compares them byte for byte:

```bash
node scripts/verify-live.js                  # against https://thebitcoinbull.club
node scripts/verify-live.js http://127.0.0.1:3000   # against a local server
```

It prints `MATCH: live site = this commit` and exits 0, or a precise list of differences and exits 1. The GitHub
workflow in `.github/workflows/verify-live.yml` runs it every hour and on demand with read-only permissions; the badge
above shows the latest result.

## Settings (.env)

| Setting | What it does | Needed? |
|---|---|---|
| `PUBLIC_ORIGIN` | The URL people use. The site answers to this host only. | Yes, when public |
| `CLIENT_IP_HEADER` | Header carrying the real visitor IP behind Cloudflare + cloudflared: `cf-connecting-ip`. Validated as an IP, else the socket; overrides `TRUST_PROXY`. Safe only on loopback behind the tunnel. | Yes, behind Cloudflare |
| `TRUST_PROXY` | Without `CLIENT_IP_HEADER`: how many proxies sit in front (1 or 2). | Otherwise, when public |
| `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI` | Sign in with X. All three or nothing: with any missing there is no X button and the routes 404. Redirect URI must be `https://<public host>/auth/x/callback`. | Optional |
| `X_LOGIN_DAILY_CAP` | Paid X sign-ins per day (default 500); over it the button hides. | Optional |
| `SOLANA_RPC_URL` | Solana RPC, read-only (the staking pool account, the token supply). The public one works but throttles; a free Helius key is better. | Recommended |
| `HELIUS_API_KEY` | Turns on the live Holders count. | Optional |
| `LORE_WORKER` | `off` stops the block chain message scanner. | Optional |
| `CHAT_OPEN` | `1` *allows* chat (Main, Crypto Builds); it is then opened from the admin panel; default closed. | Launch ceiling |
| `ACCOUNTS_OPEN` | `1` allows accounts: sign-up / sign-in and everything that needs an account (ideas, votes, inbox); opened from the panel ("Accounts & sign-in"). | Launch ceiling |
| `OPERATOR_NAME` | Company name shown small at the bottom. Empty = "community-made page". | Optional |
| `ADMIN_HOST` | Hostname of the private admin panel (e.g. `admin.example.com`), behind Cloudflare Access. Empty = none. | Optional |
| `ACCESS_TEAM`, `ADMIN_ACCESS_AUD`, `ADMIN_EMAIL_SHA256` | Cloudflare Access team, application audience tag, and sha256 of the admin's lowercase e-mail. All three are required for the admin host to answer at all. | With `ADMIN_HOST` |

## The admin panel

With `ADMIN_HOST` + the three Access settings filled in (see SECURITY.md), `https://admin.<domain>/` shows a private
panel: the launch areas (Chat, Accounts & sign-in) each with an Open/Closed switch
where the server allows it and "Locked" where it doesn't; the announcement banner; the Story (title + up to 20,000
characters, live preview, draft kept in that browser until saved); maintenance mode ("back
soon" page + API 503); which read-only sections show; the Links box (add/edit/delete/reorder); block-message
approve/hide; feed status; the Help page's "Report a problem" notes; the moderation queue, people list and log (a
reported idea can be hidden from there); and the last 50 changes. An area is open only when both the server setting and
the panel switch say so; closing one takes effect at once over the live stream, and every action is audited. On the
public host none of this exists: there is no admin account or role, and no member sees a closed area or skips a rule.

## What is where

```
server.js            entry (loads .env, binds 127.0.0.1)
lib/app.js           routes, sessions, chat, ideas, the live stream; `ops` for the panel (hide a reported idea)
lib/solana.js        read-only: the mint, the staking program and its pool address, JSON-RPC with backoff
lib/auth.js          accounts: scrypt hashes, username/password rules, recovery codes, sign-in throttle, sign-up proof of work
lib/common-passwords.js  the most common long passwords (local list)
lib/xauth.js         Sign in with X: OAuth 2.0 code + PKCE, one paid call per sign-in, daily cap, off until configured
lib/feeds.js         DexScreener, mempool.space, Helius; the block chain message worker (backoff, batch picks, pruning)
lib/rules.js         what users may type: zero-link detector, address/key/seed-phrase blocks, doxxing shapes, names; chain text filter
lib/modrules.js      the scam filter (allow / hold / reject), no AI
lib/moderation.js    hide / mute / kick / ban / undo, automatic escalation, community reports, the queue
lib/bip39words.js    the BIP39 English word list (seed-phrase detection only)
lib/db.js, http.js   SQLite schema (and the one-time move to the dashboard shape); headers, cookies, rate limits
lib/assets.js        public/ in memory: hashed names, rewritten references, comments stripped, precompressed, ETag/304
lib/access.js        Cloudflare Access token check (RS256, audience, issuer, e-mail hash)
lib/settings.js      panel settings whitelist + schemas (banner, maintenance, sections)
lib/admin.js         the admin panel: admin-host routes, audit, static files from admin/
admin/               the panel's own HTML/JS/CSS (never served on the public host)
public/              index.html, back-soon.html, manifest.webmanifest, css/app.css, fonts, images (summit art, og.jpg + icons from it),
                     js/{theme,app,ui,views,storytext}.js on every load; {account,views-closed,pow}.js on demand
scripts/             seed, screenshots, the live-site verifier, image generators, the privacy scan, measure
test/unit, e2e, net  see Tests
```

## Publishing a copy

`scripts/privacy-scan.py` must say clean before anything from this tree is published. It refuses secrets, private
network addresses, home paths, time zones, timestamps with a time-zone offset, dated or named working notes, and the
private word list it is given (`PRIVACY_WORDS`), which it also looks for base64-, hex- and URL-encoded, JS/Unicode-escaped,
as HTML entities and spelled backwards. An optional rules file (`PRIVACY_RULES`) adds a project's own private files,
build-round words and warn words; neither file is published. Images are parsed container by container (PNG chunks,
JPEG segments, WebP chunks, AVIF boxes and items): anything beyond picture data fails. Any other binary is checked
through its readable byte runs (and, for a WOFF font, its unpacked tables, metadata and private blocks; for gzip, zlib
and zip data, the unpacked contents), where a private word, a date or a time-zone offset fails like in a note.
`SCAN_COMMIT=1` checks the latest commit's author, dates and message too; `SCAN_COMMIT=all` checks every commit
reachable from HEAD and refuses tags.

## License

MIT — see [LICENSE](LICENSE).
