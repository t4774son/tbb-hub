# Design principles

The choices behind the code, in the order they matter.

1. **Security and privacy first.** Nothing the site stores identifies a person: no e-mails, phone numbers, real names
   or addresses of any kind. Visitor IPs are never stored; bans use a keyed hash that expires. Every write is
   rate-limited, origin-checked and moderated server-side. See SECURITY.md for the threat model.
2. **A read-only dashboard.** The public site shows numbers, the story, links, Season 1, Learn and Help. Chat, Ideas
   and accounts are built, tested and closed. A closed area is off the navigation (its tab comes back the moment it
   opens); its address typed in shows a calm card, never a broken page, and nothing a visitor can see is ever disabled
   or going nowhere. Each area has a server setting as its ceiling and a panel switch underneath it; what the server
   keeps closed cannot be opened from a browser.
3. **No wallet code, no commerce code.** Visiting never asks for a wallet, a signature or money, and the code cannot:
   there is nothing in it that connects, signs, builds or checks a transaction, holds an address for a person, or sells
   anything, closed or not. When accounts open they are a username and a password with a one-time recovery code. The
   site links to no outside site that asks for a wallet: the staking program's numbers and an explanation are shown,
   its address is named as plain text, never linked. The hero action is Learn.
4. **No tracking.** No analytics, no ads, no CDNs, no third-party scripts or fonts. The browser talks only to this site
   (`connect-src 'self'`); outside data (price, blocks, chain) is fetched by the server. Nothing in the browser
   remembers a visit (no session flag, no opening animation to skip), and the number of people on the site is never
   published: not on the page, not in the API, not in the stream, not in the admin panel. Outside data is refreshed on
   the server's own timer, never because somebody visited, and refresh times are rounded, so no timestamp says when
   anyone else was here.
5. **Zero runtime dependencies, no bundler.** The little Solana needed to read public chain data (base58, one derived
   address for the staking pool, JSON-RPC) is written here. Less supply-chain risk, nothing to update, a small page.
   Node 24+ with the built-in SQLite.
6. **Zero links in chat, text only.** Every link shape and disguise is refused server-side, as are wallet addresses,
   keys, seed phrases, phone numbers, street addresses and e-mails. A rare false positive is accepted over a missed
   drainer link. Swearing is not filtered; scams are.
7. **Moderation without AI.** Rules (`lib/rules.js`, `lib/modrules.js`), the admin's tools on a private host, and
   community reports from established members. Every action has a reason and an undo. Nothing contacts an AI provider.
8. **The site never touches money.** Nothing is bought, sold, paid or paid out here, and the server sends nothing to a
   chain: it only reads public numbers (price feeds, blocks, the staking pool, the token supply).
9. **Honest numbers.** Every figure carries its feed's last refresh time and is marked "delayed" when stale. Holders
   shows nothing rather than a guess until an indexer key is set. Block chain messages are decoded from real blocks.
10. **One screen, the art first.** The home fits the viewport at every size; long things live in drawers and sheets
    that are hash routes with sane history (closing pops, never pushes). Two looks with identical features: the night
    ridge, and a 2009-style window.
11. **The admin panel is not on the public host.** It answers only on its own hostname behind Cloudflare Access, and
    the app verifies the Access token again itself. On the public host every admin path is the same 404 as any other.
    Administration happens only there: there is no admin account or role on the public host, so no sign-in of any
    kind can confer it, and no member sees a closed area or skips a rule.
12. **Published code is the whole code.** What runs on the live site is this repository: `scripts/verify-live.js`
    rebuilds the fingerprinted assets from a checkout and compares them byte for byte with what the site serves. That
    proves the browser side (`public/`): what the server does with a request, including how it handles addresses, is
    the published `lib/` taken on trust, as with any server.
