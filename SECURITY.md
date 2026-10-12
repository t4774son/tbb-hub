# Security

Goal: safe for the community, and nobody gets doxed.

## Report a problem

Found a vulnerability or a privacy problem? Please report it privately rather than in a public issue:

- **Contact:** GitHub private vulnerability reporting: the repository's **Security** tab, then **Report a
  vulnerability**. Only the maintainers see the report. The site's Help page ("Report a problem") also works.
  The site publishes the same at `/.well-known/security.txt` (RFC 9116).
- Include what you found, how to reproduce it and, if you can, which file or route is involved.
- Please do not test against other people's accounts or data, and do not run load or flood tests against the live site.

You will get an acknowledgement, and a fix or a reply before any public disclosure where possible.

## What is stored

Usernames, display names, password and recovery-code **hashes** (scrypt, never the secret), posts, ideas, votes,
inbox notes; an X user id and handle when they linked X (never an X token). **No** e-mails, real names, phone numbers,
physical addresses or crypto addresses of any kind: nothing that identifies a person. The site holds no wallet code and
no commerce code (closed or not): nothing in it can ask for an address, a signature or a payment. IPs are never stored or logged; for rate limits they live in memory for minutes, and for IP bans only a keyed
hash (HMAC-SHA256 with the per-install secret, IPv6 as /48) of the connections an account used in the last 7 days is
kept, at most 10 per account, purged after 7 days. The daily cap on anonymous Help notes remembers the sender as the
same keyed hash, in memory only, for at most 24 hours (and 40 notes a day per IPv4 /24, so a few neighbouring addresses
cannot fill the inbox; a full inbox refuses new notes rather than dropping older ones). The site says so: "If you post, we keep a scrambled (hashed) form of your
IP for 7 days to stop banned spammers. We never store the IP itself."

## Accounts

- **Username + password** is the main way in. Username 3–20 `[A-Za-z0-9_]`, case-insensitive unique (display names
  count too), staff-like and look-alike names refused (`admin`, `m0d`, `TBB_support`, `0fficial`, …, lib/auth.js).
  Password ≥ 10 characters, not on the shipped list of the most common long passwords (lib/common-passwords.js, local,
  no network), not the username. Hashes: `crypto.scrypt`, N=2^15, r=8, p=1, 16-byte salt, 64-byte key, parameters
  stored per hash, `timingSafeEqual`. Passwords and codes are never logged.
- **Recovery code**: 25 characters from an unambiguous alphabet, shown once at sign-up (the person must tick "I saved
  it"), stored only as a hash. Code + new password resets the account, ends every session and issues a new code. There
  is no other reset path and the page says why ("We don't collect email, so keep this code").
- **Brute force**: a failed sign-in gives one message whether or not the username exists, and does the same scrypt
  work against a dummy hash; failures are throttled per connection and per account with doubling waits (up to 5 min);
  ten failures on an account start a 15-minute cool-down. Sign-up: a server-issued proof of work solved in the browser
  (SubtleCrypto SHA-256, 16 leading zero bits, single use, 5 min) and at most 3 accounts per connection per day. No
  third-party CAPTCHA: the browser talks only to this site.
- **Sessions**: an HttpOnly / Secure / SameSite=Strict cookie, hashed tokens in the database, rotated on every
  sign-in; "Sign out everywhere"; changing the password (needs the current one) ends the other sessions.
- **Slow start**: a new account reads for 10 minutes, then posts at most once per 10 s for a day (nobody is exempt).
- **No wallet on an account.** An account is a username and a password, nothing else; accounts from an older install
  that were made another way sign in once they set a username and password from the account menu.
- **Sign in with X** (off until `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REDIRECT_URI` are set; otherwise no button and
  the routes 404): OAuth 2.0 authorization code + PKCE (S256), confidential client, scopes exactly `users.read tweet.read`,
  `state` random, single use, 10 min, bound to a short HttpOnly SameSite=Lax cookie (Lax because X sends the browser back
  cross-site), the code exchange server-side only (node fetch, 8 s timeout, 64 KB cap), exactly one paid call per sign-in
  (`GET /2/users/me`), the access token discarded, never stored. Only the X id and handle are kept; the handle shows as
  plain text, never a link. Daily cap `X_LOGIN_DAILY_CAP` (500). Staff-like handles are refused; account and IP bans
  apply like everywhere else. The browser's `connect-src` stays `'self'`.

## Visitor IP and IP bans

Production sits behind Cloudflare → `cloudflared` → 127.0.0.1. `CLIENT_IP_HEADER=cf-connecting-ip` makes that header
the visitor IP (checked with `net.isIP`, else the socket address), overriding X-Forwarded-For / `TRUST_PROXY`. **This is
safe only because the app listens on loopback and the tunnel is the only way in**: nobody can reach the app with a forged
header. Do not set it when something else can connect to the port.

Bans: the admin bans an **account** (24 h / 7 d / 30 d / permanent) or the **account + IP** (the hashed connections it
used in the last 7 days) for 24 h / 7 d / 30 d, default 7 d; IP bans are never permanent (addresses are reused by
innocent people, VPN exits and phone carriers). A blocked connection can still **read** the site; it can't sign up,
sign in or post ("You can't post from this connection right now."). The panel lists active IP bans by label, when they
end, why, and how many other accounts used that connection, with one-click review and Lift; the IP itself is never
shown (it is never known). Tests: hash ≠ IP, 7-day purge and the 10-per-account cap, ban blocks sign-up / sign-in /
posting but not reading, expiry, /48 grouping, `CLIENT_IP_HEADER` with a junk value falling back to the socket.

Every per-connection key (rate limits, the stream cap, the Help-note caps, ban hashes) groups IPv6 by /48: the block a
site, a hosting account or a tunnel broker gets whole, so one block never counts as thousands of visitors.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Doxing via chat | Phone numbers, street addresses, e-mails blocked server-side; report button; admin hide/mute/kick/ban. |
| Wallet drainers via chat links | **Zero links.** Every link shape is refused server-side (`lib/rules.js`): any `scheme://` or `scheme:`, `www.`, bare domains with any ending (every country code, hundreds of generic and new endings, web3 names, punycode, any unknown ending followed by a port or path), IPv4/IPv6/hex IPs, Telegram/Discord/WhatsApp invites, and the disguises: "dot com", `(dot)`, `[.]`, `(.)`, ` . `, `. com`, `,com`, spaced letters, full-width and other dot look-alikes, Cyrillic/Greek look-alike letters (NFKC + a confusables map), zero-width/bidi/invisible characters (stripped before checking and before storing). A rare false positive is accepted over a missed link. Nothing in the renderer turns user text into anchors (`plainText`). The message says "Links aren’t allowed yet — coming soon." |
| Drainers posting "send to" / "verify at" addresses, seed-phrase phishing | Solana/Bitcoin/Ethereum address shapes, 64-hex keys, keypair JSON arrays and 12+ consecutive BIP39 words are refused (the official TBB mint is the one exception). The scam filter (`lib/modrules.js`, no AI) refuses asking for seed phrases / private keys, "connect/validate/sync your wallet", "claim your airdrop", "double your", "send me X SOL", whitelist bait, "DM me", "message me on telegram/whatsapp/signal", staff claims ("admin here", "official support"); it holds weaker signals (giveaway, urgency, a Telegram mention) for the admin. Warnings about scams ("never share your seed phrase") pass. |
| Repeat offenders, floods | Refusals are rule hits: 3 in 24 h = 1 h mute, more = 24 h mute + a queue item for the admin. Identical repeats within 10 minutes and 5 messages a minute are refused. A per-account token bucket on top. |
| Scam content nobody caught | Community reports: 3 different established accounts (≥ 7 days old, not muted, not banned) hide a message pending the admin; 5 (weighted) reports on one person's messages in 24 h mute them for an hour and queue them. Reporters who are repeatedly overruled lose weight (×0.5, min 0.1); reporters who were right regain it. |
| Children in the chat | The public read-only site shows no age card. The sign-up and X welcome forms carry an “I’m 18 or older” tick; the account stores `adult_confirmed_at`; a post from an account without it is refused (403 `adult`) and the page then asks once in a small dialog. The page never sends the confirmation on its own at sign-in, and the remembered tick is cleared on sign-out. Terms state 18+. |
| Identity linking | Nobody sees anyone else's account id. Avatars are generated from a server-side keyed hash. |
| Impersonation (Satoshi, the token's creator, admins) | Reserved-name filter (leet-insensitive) + Latin-only names (no homoglyphs) + unique names. No admin badge exists: there is no admin on the public host. |
| Password guessing, credential stuffing, account enumeration | scrypt hashes; one message and the same work for wrong password and unknown username; per-connection and per-account doubling delays; 15-minute cool-down after ten failures, for made-up usernames exactly like real accounts; the common-password list; no e-mail or phone to phish. Sign-up's "name taken" answer costs a proof of work per probe. |
| Sign-up floods, sock puppets | Browser proof of work (single use, 5 min), 3 accounts per connection per day, new-account slow start, IP bans on repeat offenders. |
| Session theft / CSRF | HttpOnly + SameSite=Strict cookie (Secure on https), hashed session tokens in DB rotated on every sign-in, "sign out everywhere", password change ends other sessions, custom header + Origin check on every write. |
| Banned person comes back from the same connection | Account + IP ban (hashed connections of the last 7 days, 24 h / 7 d / 30 d). Reads stay open so VPN users and innocent neighbours are not locked out of the dashboard. |
| XSS | All dynamic text rendered with textContent; links built as DOM nodes after URL validation (https only in user-facing text); strict CSP (`script-src 'self'`, no inline, no eval, Trusted Types required with no policy allowed, so any HTML sink is a hard error); no third-party scripts; `img-src 'self' data:` (no `blob:`). |
| Malicious uploads | There is no upload of any kind: chat is text only, and nothing else takes a file. |
| Site steals funds, or a tampered transaction | The site holds no wallet code and no commerce code: nothing connects, signs, builds, checks or relays a transaction, and nothing is for sale. The server only reads public chain data (the staking pool account, the token supply). A guard test keeps it that way (`test/unit/dashboard-only.test.js`): the modules are gone, no route, setting, address or identifier of them exists in the published tree, and the former routes are the plain 404 whatever the settings say. |
| Path traversal / file read | Every public file is served from memory by its exact name; nothing is read from disk per request. |
| Abuse / DoS | Per-account and per-IP token buckets on every route (the per-connection bucket runs before any header check or database lookup; IPv6 is one key per /48 everywhere); body size caps; a cap on live streams per visitor and in all, every refusal the same generic 429 so the stream never tells how busy the site is; scrypt behind a gate (two at a time, twenty waiting, the rest a fast 429); every in-memory map has a hard ceiling with oldest-first eviction; request timeouts; over-long inputs refused before any regex runs. |
| Clickjacking | `frame-ancestors 'none'` + X-Frame-Options DENY. |
| Tracking | No analytics, no CDNs, fonts self-hosted, `Referrer-Policy: no-referrer`. The browser talks only to this site (`connect-src 'self'`). Nothing is kept in the browser about a visit (no session flag). The number of open live streams stays inside the server (it bounds the stream caps) and is never published: not in `/api/state`, not on the stream, not in the admin panel. Only `/` serves the page; every other extension-less path is a plain 404. Outside services are called by the server only, with a plain `Mozilla/5.0` User-Agent: DexScreener (price), GeckoTerminal (24 h chart), mempool.space (blocks), the Solana RPC, Helius (holders, optional), the creator's Season board, X (sign-in, optional) and Cloudflare Access (admin certificates). What leaves: token/pool/account addresses, block heights, the X client credentials and code. Never a visitor IP or any user text. A failing feed is retried with exponential backoff (1 min → 30 min); a 429 is never retried or paged past. |
| Moderation bypass through other routes | `canPost` (ban, mute, 18+, new-account slow start) guards every public write: chat, edits, ideas, votes. Edits and deletes are paced per account and a repeat delete is not re-broadcast; an admin delete is a moderation-log hide and can be undone. |
| Admin takeover | Separate hostname behind Cloudflare Access, plus the app's own RS256 token check on every request (segments must be base64url before anything is decoded), same-origin + custom-header writes, strict schemas, audit log; the server's launch settings cap what the panel can open. See below. |
| Stale data shown as live | Every number carries its feed's last successful refresh time; the page shows "updated Xm ago" and marks anything older than twice its interval as delayed. Numbers are never invented. |
| Comments or paths leaking from served files | The served HTML, CSS and JS carry no comments (stripped at build time by a small tokenizer in `lib/assets.js`; the sources keep them). Response headers name no software. |

## The admin settings page (admin host)

The admin panel is not part of the public site. It answers only on its own hostname (`ADMIN_HOST`, e.g.
`admin.example.com`); on the public host every admin page and API path is an ordinary 404, and the public bundle
contains no admin code (the panel's HTML/JS/CSS live in `admin/`, outside `public/`). There is no admin account or
role on the public host: every administrative action (settings, moderation, Help notes) is a panel route on the admin
host, and no member sees a closed area or skips a rule.

Layers, outermost first:

1. **Cloudflare Access** in front of the admin hostname (policy: one e-mail), enforced by Cloudflare and by
   `cloudflared`. Nobody else even reaches the app.
2. **The app checks the Access token again** (`lib/access.js`): every request to the admin host must carry
   `Cf-Access-Jwt-Assertion`. It is verified with `node:crypto`: RS256 signature against the team's public keys
   (fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached ~1 h, refetched once on an unknown
   key id, capped body, 5 s timeout, fail closed on any error), `aud` must include `ADMIN_ACCESS_AUD`, `iss` must be the
   team, `exp`/`nbf`/`iat` with 60 s skew, and `sha256(lowercase e-mail)` must equal `ADMIN_EMAIL_SHA256`. The e-mail
   itself is never stored, logged or shown. Any of these settings missing or malformed → the admin host answers 404.
3. **Writes**: JSON only, `Origin` must equal the admin origin exactly, custom `X-Admin: 1` header (forces a CORS
   preflight for anyone else), 16 KB body cap (96 KB for the story), per-IP rate limits, strict per-setting schemas (`lib/settings.js`).
4. **Audit**: every change is written to `admin_audit` (time, action, before/after summary, actor `panel`) and the
   last 50 are shown in the panel.
5. **What it cannot do**: open anything the server keeps closed. `CHAT_OPEN` and `ACCOUNTS_OPEN` in `.env` are the
   ceiling; the panel's Open/Closed switches only work
   underneath them (effective = server AND panel, default closed, one flip per request, each audited by name, a
   refused flip answers 403). Admin text (banner, story) is stored as plain text with https-only links and rendered
   through the DOM, never as HTML. The panel carries the same URL filter as the public page, literal for literal.

No account confers administrative rights anywhere.

## Moderation: the admin, the rules, the community — no AI

- **Chat is text only.** The message route accepts one string of up to 500 characters and ignores every other field;
  bodies over 64 KB are refused before being read; a pasted `data:` URL is a link and refused; the composer blocks
  pasted or dropped files ("Pictures coming soon."). No attachments exist anywhere in chat.
- **Server is the authority.** The detector and the scam filter run on the server for chat, edits, ideas and display
  names. The page only shows the server's message.
- **Admin tools (admin host only; same Access token, same-origin + `X-Admin` writes, 16 KB bodies):** hide a message
  (and "hide all from this person, last 24 h"), mute 10 min / 1 h / 24 h / 7 days (can read, can't post), kick (every
  session ended now, told over the stream, + 24 h mute), ban (permanent: sessions ended, every message hidden, the
  account can't sign in), unmute, unban, hide a reported idea, close queue items. Every action needs a reason where it
  hurts (hide, hide all, mute, kick, ban, hide idea), goes into `mod_actions` and `admin_audit`, and can be undone
  from the log in one click (a kick's sessions can't be given back).
- **Automatic actions** (`actor = auto` / `community`) are logged the same way and undone the same way. Hidden and
  held messages are never broadcast; a hide reaches every open page at once (`message:update` with an empty body); a
  kick reaches the person's own pages (`kicked`).
- **No AI moderator.** Nothing here contacts an AI provider; there are no AI settings.
- **Account ids stay private.** The queue and people list show full account ids on the admin host only; the audit log
  keeps them short; chat payloads never contain them.
- **What is not filtered, on purpose:** swearing, insults, strong opinions, ALL CAPS. The rules keep the room
  scam-free, not polite.
- **Help notes** (the public Help page's "Report a problem" box) are the one anonymous write: zero-link, capped at 20 a
  day per connection (IPv6 by /48) and 40 a day per IPv4 /24, and when 500 are open a new note is refused rather than
  an older one dropped. They are read and cleared on the admin host only; clearing deletes the note (secure_delete, then
  a checkpoint, so its bytes leave the file too), and the audit row records only its id, never its text. Refused-message
  hits are purged after 30 days.

## Running it

`server.js` sets `umask 0077`; `data/` is created 0700 and the SQLite files 0600. Run it under a
hardened service unit (`ProtectSystem=strict`, `NoNewPrivileges`, `CapabilityBoundingSet=`, `PrivateTmp`, `UMask=0077`,
`EnvironmentFile=`); do not wrap it in `scripts/run.sh` under systemd (its `env -i` would drop the environment file).

## Known gaps

- **Hosting.** The site runs behind Cloudflare (a tunnel to a loopback-only process; Access in front of the admin host)
  with `PUBLIC_ORIGIN` and `CLIENT_IP_HEADER` set. Cloudflare and the host see visitor IPs in their own logs; the app
  keeps only a keyed hash, and only for sign-ups, sign-ins and posts. Deployment specifics and backups are kept out of
  this repository.
- **A lost recovery code is a lost account.** There is no e-mail to fall back on, by design. The page says so at sign-up.
- **IP bans are blunt.** A hashed /48 or a carrier NAT covers many people; that is why bans are short, reading stays open, and the panel shows how many other accounts share the connection before the admin acts.
- **Sign in with X trusts X** for who the person is; X's own account security applies. Nothing from X but the id and handle is kept.
- **Moderation is rules + the admin + the community.** No AI. A clever scammer who writes plain English with no
  link, no address and no scam phrase gets through until someone reports them. The detector errs towards blocking
  (e.g. "yes.no", "the dot com bubble" are refused); expect to tune the phrase lists.
- **The slur list is applied to display names only** (a name is on every message); chat text itself has no word filter.
- **Credible threats of violence and sexual content involving minors** have no reliable rule; they rely on reports
  (3 established reporters hide the message at once) and the admin's hands.
- **Report reasons may contain links** (only the admin reads them; a reporter needs to be able to quote the scam). The
  Help page's free-text notes do not: they are the one anonymous write, so they follow the zero-link rule.
- **Not audited by a third party.** Treat it as alpha until someone independent reviews `lib/`.
