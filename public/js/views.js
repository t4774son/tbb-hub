// Every view that opens over the home screen. Each view gets {body, parts, setTitle, tools} and may return a cleanup fn.
import { h, clear, icon, avatar, usd, num, ago, api, toast, copy, busy, CA } from './ui.js';
import { S, modal, SITE_LINKS } from './app.js';

export const ext = (href, ...kids) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids);
export const empty = (title, sub, ...actions) => h('div', { class: 'empty' }, h('div', { class: 'serif' }, title), sub ? h('p', { style: { margin: 0 } }, sub) : null, ...actions);
export const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('span', { class: 'help-text' }, hint) : null);
export function tabs(items, active, onPick) {
  const el = h('div', { class: 'tabs', role: 'tablist' });
  for (const [id, label, ico] of items) {
    el.append(h('button', { class: 'tab', role: 'tab', 'aria-selected': String(id === active), onclick: () => onPick(id) }, ico ? icon(ico) : null, label));
  }
  return el;
}
export function byline(a, at) {
  return h('span', { class: 'by' }, avatar(a.avatar, 18), a.name, a.x ? h('span', { class: 'x-handle' }, '𝕏 @' + a.x) : null, at ? h('span', null, '· ' + ago(at)) : null);
}
export function counter(input, max) {
  const c = h('span', { class: 'count' }, `0 / ${max}`);
  input.addEventListener('input', () => { c.textContent = `${input.value.length} / ${max}`; });
  return c;
}
// Launch switches: an area that isn't open yet shows what it will be, plus something to do now.
function soon({ ico, title, text, points, cta, badge = true }) {
  return h('div', { class: 'soon-card' },
    badge ? h('span', { class: 'soon-badge' }, 'Coming soon') : null,
    h('div', { class: 'soon-ico' }, icon(ico)),
    h('h3', { class: 'serif soon-t' }, title),
    h('p', { class: 'soon-p' }, text),
    points ? h('ul', { class: 'soon-list' }, points.map((x) => h('li', null, icon('check'), h('span', null, x)))) : null,
    cta || null);
}
// Chat while closed: one calm card, nothing to read and nothing to click. The real view stays behind the server's switch (CHAT_OPEN).
const SOON_NAMES = { chat: 'Chat', live: 'Chat' };
const SOON_ICONS = { chat: 'chat', live: 'chat' };
const SOON_CARD = (area) => soon({ ico: SOON_ICONS[area] || 'clock', title: 'Coming soon', text: `${SOON_NAMES[area] || 'This'} isn’t open yet.`, badge: false });
async function comingSoon({ body, setTitle, area }) { setTitle('Coming soon'); clear(body, h('div', { class: 'stack' }, SOON_CARD(area))); }
export const CHAT_SOON = () => SOON_CARD('chat');
// Ideas while closed: one card for #/build and every address under it. It says what is coming and nothing about a
// schedule or how it opens.
export const IDEAS_SOON = () => soon({ ico: 'bolt', title: 'Ideas are coming soon', badge: false,
  text: 'Post ideas for TBB and vote on the best ones. Details will be posted here before it opens.',
  points: ['Post an idea', 'Vote on ideas'] });

export async function guard(fn, btn) {
  if (btn) busy(btn, true);
  try { return await fn(); } catch (e) { toast(e.message, { kind: 'error' }); return null; } finally { if (btn) busy(btn, false); }
}
export function report(kind, target) {
  modal('Report', (box, close) => {
    const t = h('textarea', { class: 'textarea', maxlength: 1000, placeholder: 'What’s wrong? (scam, doxing, spam, stolen art…)' });
    const go = h('button', { class: 'btn btn-primary' }, 'Send report');
    go.onclick = () => guard(async () => { await api('/api/report', { method: 'POST', body: { kind, target, reason: t.value } }); close(); toast('Thanks. A moderator will look at it.'); }, go);
    box.append(h('h3', { class: 'modal-title' }, 'Report'), t, go);
  });
}

// =====================================================================================
// ALLIES
// =====================================================================================
async function allies({ body, setTitle }) {
  setTitle('Links');
  const r = await api('/api/allies');
  clear(body, h('div', { class: 'stack' }, h('p', { class: 'lead' }, 'The creator’s sites and other third-party places. Not run by this site. Check the whole address before you trust a site — scammers copy links.'),
    h('div', { class: 'grid2' }, SITE_LINKS.map((a) => h('a', { class: 'card', href: a.url }, h('div', { class: 'spread' }, h('span', { class: 'idea-title' }, a.title), h('span', { class: 'muted' }, icon(a.icon))), h('span', { class: 'small muted' }, a.blurb), h('span', { class: 'tiny mono muted' }, 'on this site'))),
      r.allies.map((a) => h('a', { class: 'card', href: a.url, target: '_blank', rel: 'noopener noreferrer' },
      h('div', { class: 'spread' }, h('span', { class: 'idea-title' }, a.title), h('span', { class: 'muted' }, '↗')), h('span', { class: 'small muted' }, a.blurb), h('span', { class: 'tiny mono muted' }, a.url.replace(/^https?:\/\//, '').replace(/\/$/, '')))))));
}

// =====================================================================================
// LEARN · HELP
// =====================================================================================
const LORE = [
  ['2008-10-31', 'The paper', 'Satoshi Nakamoto sends “Bitcoin: A Peer-to-Peer Electronic Cash System” to a cryptography mailing list. Nine pages. No company. No permission.', null],
  ['2009-01-03', 'Block 0', 'The genesis block is mined at 18:15:05 UTC. Inside it, a headline: “The Times 03/Jan/2009 Chancellor on brink of second bailout for banks.”', '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  ['2009-01-09', 'v0.1', 'Bitcoin v0.1 is released for Windows. A grey window, a Send Coins button, an Address Book, and an option to Generate Coins. Switch this hub to 2009 mode to see it again.', null],
  ['January 2009', 'Running bitcoin', 'Hal Finney posts two words that the whole movement still repeats.', null],
  ['2009-01-12', 'The first send', 'Block 170: Satoshi sends Hal Finney 10 BTC. The first person-to-person bitcoin transaction.', null],
  ['2010-05-22', 'Two pizzas', 'Laszlo Hanyecz pays 10,000 BTC for two pizzas. Now it’s a holiday.', null],
  ['2010-08-15', 'The overflow', 'Block 74638 conjures 184 billion bitcoin out of a bug. A fixed client ships in about five hours and the honest chain wins. The system held.', null],
  ['2010-12-12', 'The last post', 'Satoshi posts on the forum for the last time. Months later, one last e-mail: “I’ve moved on to other things.”', null],
];
const QUOTES = [
  ['The root problem with conventional currency is all the trust that’s required to make it work.', 'Satoshi Nakamoto, February 2009'],
  ['Writing a description for this thing for general audiences is bloody hard.', 'Satoshi Nakamoto, July 2010'],
  ['If you don’t believe me or don’t get it, I don’t have time to try to convince you, sorry.', 'Satoshi Nakamoto, July 2010'],
];
// The twelve points, verbatim from the creator's white paper poster (public/art/tbb-whitepaper.*): the subtitles are
// the poster's own lines, the titles in title case. The poster's bonus line and closing slogan stay in the picture only.
const WHITEPAPER = [
  ['01', 'Real Organic X Account', 'Built on authenticity and organic community growth.'],
  ['02', 'Expand Distribution Channels', 'Reach beyond boundaries. Global access. Infinite penetration.'],
  ['03', '70% Supply Control', 'The majority stays with the community. Power to the people.'],
  ['04', 'Based Doxxed Dev', 'Transparency. Accountability. Trust. No anons. No games.'],
  ['05', 'Reward Community Not Insiders', 'We build for the holders, not the profiteers.'],
  ['06', 'Develop a Programmatic Monetary Policy for Distribution', 'Smart, fair, and sustainable emission. Built to last.'],
  ['07', 'Core Diamond Holders Supply Control', 'Strong hands. Long-term vision. Immutable foundation.'],
  ['08', 'Liquidity Growth', 'Deep liquidity. Stronger charts. Health in every candle.'],
  ['09', 'Network Expansion', 'More nodes. More cities. More minds.'],
  ['10', 'Access to Trad Media Channels', 'Mainstream visibility. Massive exposure.'],
  ['11', 'Unite the Tribes', 'One mission. Many cultures. Bitcoin connects us all.'],
  ['12', 'Work That Bag Mentality', 'Discipline. Focus. Execution. We work. We grind. We win.'],
];
// The poster itself: three formats, the browser picks; loaded only when this tab renders (lazy), never upscaled past its own
// 567x847. Tap or click opens it full size in the dialog (Escape, the backdrop or Close shut it).
const POSTER_ALT = 'The Bitcoin Bull — $TBB white paper poster from the creator, with its twelve points';
// h() refuses srcset on purpose (it can't check it like src), so the two fixed sources set the property themselves.
const posterSource = (type, srcset) => Object.assign(h('source', { type }), { srcset });
const posterPicture = (extra = {}) => h('picture', null,
  posterSource('image/avif', '/art/tbb-whitepaper.avif'), posterSource('image/webp', '/art/tbb-whitepaper.webp'),
  h('img', { src: '/art/tbb-whitepaper.png', width: '567', height: '847', alt: POSTER_ALT, loading: 'lazy', decoding: 'async', ...extra }));
const openPoster = () => modal('White paper poster', (box, close) => { box.classList.add('poster'); box.append(posterPicture({ loading: 'eager' }), h('button', { class: 'btn btn-sm poster-close', onclick: close }, icon('close'), 'Close')); });
// Learn and Help are one section with one tab bar (the dock's "Learn"); Help keeps its own address.
const learnTabs = (active) => tabs([['tbb', 'What is $TBB'], ['staking', 'Staking & Season 1'], ['safety', 'Wallet safety'], ['lore', 'The lore'], ['help', 'Help']], active, (t) => { location.hash = t === 'help' ? '#/help' : `#/learn/${t}`; });
async function learn({ body, parts, setTitle }) {
  setTitle('Learn');
  const tab = ['tbb', 'staking', 'safety', 'lore'].includes(parts[0]) ? parts[0] : 'tbb';
  const content = h('div', { class: 'stack' });
  clear(body, h('div', { class: 'stack', style: { maxWidth: '720px' } }, learnTabs(tab), content));
  if (tab === 'tbb') content.append(
    h('div', { class: 'panel prose' },
      h('p', null, h('strong', null, 'The Bitcoin Bull ($TBB) '), 'is a community token on Solana from the Bitcoin Hard Money project. Its white paper is the creator’s poster below: twelve points, 70% to the community, a doxxed dev.')),
    h('button', { class: 'wp-poster', type: 'button', 'aria-label': 'View the white paper poster full size', onclick: openPoster }, posterPicture(), h('span', { class: 'wp-poster-cap tiny muted' }, 'Tap to view full size')),
    h('h3', { class: 'wp-head' }, 'The creator’s twelve points, as written on the poster'),
    h('div', { class: 'wp-grid' }, WHITEPAPER.map(([n, t, sub]) => h('div', { class: 'panel wp-pt' }, h('span', { class: 'wp-n mono' }, n), h('strong', null, t), h('span', { class: 'small muted' }, `“${sub}”`)))),
    h('div', { class: 'panel stack' }, h('span', { class: 'stat-k' }, 'Contract address'), h('div', { class: 'row' }, h('code', { class: 'mono small', style: { wordBreak: 'break-all' } }, CA), h('button', { class: 'btn btn-sm', onclick: async () => { await copy(CA); toast('Copied.'); } }, icon('copy'), 'Copy')),
      h('span', { class: 'tiny muted' }, 'Token-2022 · 6 decimals · ', ext('https://solscan.io/token/42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump', 'View on Solscan'))),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'From the creator’s white paper poster. This page is community-made, not from the dev. Not financial advice.'));
  if (tab === 'staking') {
    const se = S.stats?.season; const day = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    // the prize and its rate as the board publishes them (prizeTbb, stakeApr); the board's own figures when it has not answered yet
    const prize = se?.prizeTbb > 0 ? `${num(se.prizeTbb)} TBB (${+(se.prizeTbb / 999_996_129 * 100).toFixed(5)}% of supply)` : '4,206,900 TBB (0.42069% of supply)';
    const apr = Number.isFinite(se?.stakeApr) ? `${+(se.stakeApr * 100).toFixed(2)}%` : '8%';
    const rules = [
      ['Any buy counts', 'Every purchase of TBB with SOL or USDC counts, from any app, site, wallet or bot.'],
      ['Biggest net buyer wins', 'Each buy is valued in USD when it lands. Your score is what you bought minus what you sold during the season.'],
      ['Hold what you buy', 'If a wallet no longer holds the TBB it net-bought, its score drops in proportion. TBB staked on stakethebull.xyz counts as held.'],
      ['One wallet, one entry', 'The wallet that receives the TBB is credited. Team, creator and liquidity-pool wallets can’t rank.'],
      ['The prize', `${prize}, staked for 3 months at ${apr} APR on the winner’s behalf; principal plus interest goes to the winning wallet when the lock ends.`],
      ['Final-hour overtime', 'If #1 changes hands in the last hour, an hour is added. This repeats until a leader holds #1 for a full final hour.'],
      ['Fraud review', 'Wash trading, self-dealing and manipulation are excluded; suspicious activity is reviewed by hand before payout.'],
      ['Winner', 'Claim instructions are posted on X by @GoingParabolic when the season ends.'],
    ];
    content.append(
      h('div', { class: 'panel prose' },
        h('h3', null, 'Staking'),
        h('p', null, 'Staking means locking your TBB for a set time in the creator’s staking program, stakethebull.xyz. While locked, the tokens earn a yearly rate (APR). Longer locks pay more. This site does not link to it: find the address yourself and check it character by character.'),
        h('p', null, 'Rates shown on the staking site (9 Oct 2026): 1 month 5% · 3 months 8% · 6 months 12% · 12 months 18% APR. Check the site for the current terms before you lock anything.'),
        h('p', null, 'The “TBB staked” number on our home page is read straight from the staking program’s public account on Solana, the same total the staking site shows.'),
        h('p', { class: 'small muted' }, 'Locked tokens can’t be sold or moved until the lock ends. Staking runs on a smart contract, which can have bugs. The staking site is run by the creator, not by this site.')),
      h('div', { class: 'panel prose' },
        h('h3', null, 'Season 1: the Biggest Buyer Board'),
        h('p', null, 'Season 1 is a competition run by the creator. It tracks TBB buys and sells on chain for about 30 days and ranks wallets by how much they net-bought.',
          se ? ` It runs ${day(se.start)} to ${day(se.end)} (your time)${se.overtimeHours ? `, plus ${se.overtimeHours}h overtime so far` : ''}.` : ' It started 5 Oct 2026 and runs to 4 Nov 2026.'),
        se && Number.isFinite(se.buyers) ? h('p', { class: 'small' }, `So far: ${num(se.buyers)} buyers · ${num(se.buys)} buys · ${usd(se.volumeUsd)} volume.`) : null,
        h('ol', { class: 'rules' }, rules.map(([t, x]) => h('li', null, h('strong', null, t + '. '), x))),
        h('p', null, h('a', { class: 'btn btn-sm', href: 'https://tbb-buyer-board.garden-equity-field-0042.workers.dev/', target: '_blank', rel: 'noopener noreferrer' }, 'Open the Season 1 board ↗')),
        h('p', { class: 'tiny muted' }, 'Summarized from the rules on the creator’s board. The board is the official source and its rules can change. Not run by this site. Not financial advice.')));
  }
  if (tab === 'safety') content.append(h('div', { class: 'panel prose' },
    h('p', null, h('strong', null, 'Your recovery phrase is the wallet. '), 'Write it on paper and keep it offline. Never type it into a website, a form, a chat or a “support” page. Nobody legitimate will ever ask for it.'),
    h('p', null, h('strong', null, 'Check the whole contract address. '), 'Character by character: ', h('code', { class: 'mono', style: { wordBreak: 'break-all' } }, '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump'), '. Many tokens end in “pump”, and scam tokens copy the first and last few characters', '. Copy it from the top of this page; scammers make look-alike tokens.'),
    h('p', null, h('strong', null, 'Read before you sign. '), 'Your wallet shows what a transaction does before you approve it. If you don’t understand it, don’t sign it.'),
    h('p', null, h('strong', null, 'Bookmark the real sites. '), 'Use the Links box on the home page. Fake sites copy names and logos.')),
    h('div', { class: 'notice' }, icon('shield'), h('span', null, 'Nobody from this site will DM you first. Nobody needs your seed phrase. Anyone offering to “double” your tokens, or to fix your wallet, is a scammer.')),
    h('p', { class: 'tiny muted' }, 'This site doesn’t sell or recommend buying anything. Not financial advice — see the Disclaimer.'));
  if (tab === 'lore') content.append(h('div', { class: 'timeline' }, LORE.map(([d, t, x, hash]) => h('div', { class: 'tl panel stack', style: { gap: '6px' } }, h('span', { class: 'tl-date' }, d), h('span', { class: 'tl-title' }, t), h('span', { class: 'prose' }, x),
    hash ? ext(`https://mempool.space/block/${hash}`, h('span', { class: 'link small' }, 'Verify on the block chain ↗')) : null))),
    h('div', { class: 'stack' }, QUOTES.map(([q, by]) => h('figure', { class: 'panel', style: { margin: 0 } }, h('blockquote', { class: 'quote', style: { margin: 0 } }, `“${q}”`), h('figcaption', { class: 'quote-by' }, by, ' · ', ext(`https://satoshi.nakamotoinstitute.org/`, h('span', { class: 'link' }, 'source ↗')))))));
}

async function help({ body, setTitle }) {
  setTitle('Help');
  const faqs = [
    ['How do accounts work?', 'A username and a password, nothing else: no e-mail, no phone number, no real name. When you sign up you get a one-time recovery code; keep it, because it is the only way back in if you forget your password. New accounts read for the first 10 minutes and post slowly for a day.'],
    ['What if I forget my password?', 'Use “Have a recovery code?” on the sign-in screen: your recovery code plus a new password resets the account and gives you a fresh code. There is no other way: we don’t have your e-mail.'],
    ['Why can’t I post links?', 'Chat is text only for now; links and pictures are coming soon. It keeps drive-by wallet drainers out.'],
    ['Why was my message blocked?', 'Chat is text only for now: links and pictures are coming soon. We also block wallet addresses, private keys and seed phrases (that is how drainers work), phone numbers, street addresses and e-mail addresses, and obvious scam patterns such as “DM me” or “connect your wallet”. Swearing is fine.'],
    ['Who moderates?', 'The admin, with help from the community: reports from established members hide a message until the admin looks at it, and repeated rule breaks mute an account automatically. Every action is logged and can be undone.'],
    ['When does chat open?', 'When it can be kept well moderated and safe from spam and scams. We would rather open late than open unsafe. Chat comes first; private messages come later.'],
    ['Does this site ever ask for my wallet?', 'No. It is a read-only dashboard: there is nothing to connect, sign, buy or sell here, and no page of this site will ever ask for a wallet, a signature or money. Anything that does is not this site.'],
    ['Is this financial advice?', 'No. Nothing on this site is financial, investment, legal or tax advice. See the Disclaimer page.'],
    ['What do other people see of me?', 'Your display name and a generated pattern, nothing else. The site holds no address of yours of any kind.'],
    ['What do you keep about my connection?', 'When you sign up, sign in or post, we keep a hashed form of your IP for 7 days to stop banned spammers. We never store the IP itself, and the hash can’t be reversed without the server’s secret. Blocked connections can still read the site. Help notes you send from this page are stored until the admin clears them.'],
  ];
  const t = h('textarea', { class: 'textarea', maxlength: 1000, placeholder: 'What happened? Don’t include personal details.' });
  const go = h('button', { class: 'btn btn-primary', style: { alignSelf: 'flex-start' } }, 'Send');
  go.onclick = () => guard(async () => { await api('/api/report', { method: 'POST', body: { kind: 'problem', target: 'help', reason: t.value } }); t.value = ''; toast('Thanks. We read every one.'); }, go);
  clear(body, h('div', { class: 'stack', style: { maxWidth: '720px' } }, learnTabs('help'),
    h('div', { class: 'notice' }, icon('shield'), h('div', { class: 'stack', style: { gap: '4px' } }, h('strong', null, 'Stay safe'), h('span', null, 'Never share your seed phrase. Nobody from this site will DM you first. Check the full contract address, not just the ending. If in doubt, don’t click.'))),
    h('div', { class: 'list' }, faqs.map(([q, a]) => h('details', { class: 'panel faq' }, h('summary', null, q), h('p', null, a)))),
    h('div', { class: 'panel stack' }, h('h3', { class: 'h3' }, 'Report a problem'), t, go)));
}

// MORE (phone tab): everything that isn't on the first screen
async function more({ body, setTitle }) {
  setTitle('More');
  const row = (href, ic, label, sub, ext) => h('a', { class: 'more-row', href, ...(ext ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
    h('span', { class: 't-ico' }, icon(ic)), h('span', { class: 't-main' }, h('span', { class: 't-label' }, label), h('span', { class: 't-sub' }, sub)), h('span', { class: 'muted' }, ext ? '↗' : '›'));
  clear(body, h('div', { class: 'more-list' },
    row('https://tbb-buyer-board.garden-equity-field-0042.workers.dev/', 'star', 'Season 1', 'The creator’s on-chain competition', true),
    row('#/disclaimer', 'shield', 'Disclaimer', 'Not financial advice — please read'),
    row('#/allies', 'link', 'Links', 'Season 1, Time Machine calculator, whitepaper, socials'),
    row('#/learn', 'learn', 'Learn', 'Bitcoin, Solana and TBB, plainly'),
    row('#/help', 'help', 'Help', 'Safety and how things work')));
}

// DISCLAIMER: plain-English protection for the community and the operator
async function disclaimer({ body, setTitle }) {
  setTitle('Disclaimer');
  const sec = (t, ...p) => h('section', { class: 'panel prose' }, h('h3', { class: 'h3' }, t), ...p.map((x) => h('p', null, x)));
  clear(body, h('div', { class: 'stack', style: { maxWidth: '760px' } },
    h('p', { class: 'lead' }, 'Please read this. By using this site you agree to it.'),
    sec('Not financial advice', 'Everything here — prices, charts, staking totals, ideas, posts, links — is general information and community content. None of it is financial, investment, legal, accounting or tax advice, and none of it is a recommendation or an offer to buy, sell or hold anything.', 'Talk to a licensed professional before making financial decisions.'),
    sec('$TBB is a meme token', '$TBB is a community meme token on Solana. This site does not offer, sell or issue $TBB. Holding $TBB gives you no ownership, no share of any profits, and no claim against the site operator or anyone else. There is no promise of value, profit, return, utility, exchange placement or support. Its price can go to zero.', 'Crypto assets are highly volatile and risky. Only use money you can afford to lose completely.'),
    sec('Data can be wrong', 'Prices, 24h changes, holder counts and staking totals come from public block-chain data and third-party services (such as DexScreener, GeckoTerminal and Solana RPC providers). They can be delayed, incomplete or wrong. Check a block explorer before relying on any number.'),
    sec('Your wallet, your responsibility', 'You alone control your wallet and recovery phrase. This site never asks for your recovery phrase and never holds your funds. Anything you sign in your wallet is your decision. Transactions on a block chain are final and cannot be reversed by us or anyone else.'),
    sec('Community-made', 'This page was made by members of the $TBB community. It is not made, run or endorsed by the $TBB developer. It does not issue, sell, trade or control $TBB, and it is not an exchange.'),
    sec('Other sites', 'Links such as the creator’s Season 1 board, block explorers and social profiles open third-party sites. We do not operate, control, endorse or guarantee them, and we are not responsible for what happens there. A link is not an endorsement, and we are not paid for links. Read their own terms and risks first. Staking on a third-party site carries its own risks, including smart-contract bugs and loss of funds.'),
    sec('Community content', 'Posts and ideas belong to the people who write them and do not represent the views of the site operator. We may remove content or accounts at any time to keep the community safe.'),
    sec('No warranty; limits', 'The site is provided “as is” and “as available”, without warranties of any kind. It may change, break or go offline at any time. To the fullest extent the law allows, the operator and contributors are not liable for any loss or damage — including lost funds, tokens or profits — arising from your use of the site, its data or any linked service.'),
    sec('Location', 'You are responsible for following the laws where you live, including tax rules. Do not use the site where doing so is illegal, or if you are in a sanctioned country or on a sanctions list.'),
    sec('Privacy', S.features?.accounts
      ? 'No tracking, no ads and no analytics, and your browser talks only to this site. An account is a username and a password (stored only as a hash) plus a one-time recovery code (also only as a hash): no e-mail, no phone, no real name. If you link an X account, the site stores the X user id and handle (never an X token). One sign-in cookie (7 days). Reports and Help notes you send are stored until the admin clears them; a keyed hash of the connection behind a Help note is kept in memory for up to 24 hours to cap notes per connection, never the address itself. When you sign up, sign in or post, we keep a hashed form of your IP for 7 days to stop banned spammers; we never store the IP itself, and the hash can’t be reversed without the server’s secret. Our hosting provider may keep its own short logs. Your theme choice stays in your own browser.'
      : 'No accounts yet, no tracking, no ads and no analytics, and your browser talks only to this site. Visitor IP addresses are held briefly in memory to stop abuse and are not saved; a keyed hash of the connection behind a Help note is kept in memory for up to 24 hours to cap notes per connection, never the address itself. Help notes you send are stored until the admin clears them. Our hosting provider may keep its own short logs. Your theme choice stays in your own browser. When accounts open: a username and password only (no e-mail, no phone, no real name). When you sign up, sign in or post, we keep a hashed form of your IP for 7 days to stop banned spammers; the IP itself is never stored, and the hash can’t be reversed without the server’s secret.'),
    sec('Changes', 'We may update this notice. The date below shows the latest version.'),
    h('p', { class: 'tiny muted' }, 'Last updated October 2026. This is a plain-English notice, not a substitute for advice from your own lawyer.')));
}

// The closed areas (chat, Ideas, the inbox) live in views-closed.js and load the first time one of them is opened for
// real; a visitor to the launch site never fetches it. A closed area reached by address shows its card here (app.js
// sends chat and the rooms to comingSoon first).
const lazy = (name) => async (ctx) => (await import('./views-closed.js'))[name](ctx);
async function build(ctx) {
  if (!S.features?.ideas) { ctx.setTitle('Ideas'); clear(ctx.body, h('div', { class: 'stack' }, IDEAS_SOON())); return; }
  return lazy('build')(ctx);
}
async function inbox(ctx) {
  if (!S.me && !S.features?.accounts) { ctx.setTitle('Inbox'); clear(ctx.body, empty('Inbox is coming soon', 'Replies and updates will land here once accounts open. No e-mail needed.')); return; }
  return lazy('inbox')(ctx);
}
export const VIEWS = { chat: lazy('chat'), build, inbox, allies, learn, help, more, disclaimer, comingSoon };
