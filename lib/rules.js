// Content rules: what users may type (chat, ideas, notes, names) and the block chain text filter.
//
// Chat is text only, zero links: every link-like thing is refused, however it is dressed up (schemes, bare domains,
// IPs, punycode, invites, "dot com", [.] , spaced letters, look-alike letters, invisible characters). Wallet addresses,
// private keys and seed phrases are refused too (drainers post "send to" / "verify at"). Doxxing shapes (phone numbers,
// street addresses, e-mails) are refused. There is NO profanity or rudeness filter: swearing is allowed.
import { BIP39 } from './bip39words.js';
import { TBB_MINT } from './solana.js';

export const LINK_MSG = 'Links aren’t allowed yet — coming soon.';
export const SECRET_MSG = 'Wallet addresses, private keys and seed phrases can’t be posted here — it keeps everyone safe from scams.';

// Short, deliberately conservative slur list (substring match on a normalized form): display names only. Kept as fragments.
const SLURS = ['nigg', 'fagg', 'faggot', 'kike', 'spic ', 'chink', 'tranny', 'retard', 'coon ', 'wetback', 'gook', 'raghead', 'beaner'];
// Words the block chain text filter (lore) still drops; never applied to what users type.
const PROFANE = [...SLURS, 'fuck', 'shit', 'cunt', 'bitch', 'porn', 'cock', 'pussy', 'whore', 'rape', 'nazi', 'hitler', 'kill yourself', 'kys'];

export function normalize(s) {
  return String(s).toLowerCase()
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5|\$/g, 's').replace(/7/g, 't')
    .replace(/[^a-z ]+/g, '');
}

// ---- invisible characters ----
// Removed from stored text: zero-width spaces/non-joiners/marks, word joiners, BOM, soft hyphen, bidi controls, C0/C1 controls.
// Kept: the zero-width joiner (U+200D) and variation selectors, which emoji sequences need; tabs and new lines.
// eslint-disable-next-line no-control-regex
const INVISIBLE_STORE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Removed before scanning: the same plus joiners and variation selectors (so "t.\u200dme" is seen as "t.me").
// eslint-disable-next-line no-control-regex
const INVISIBLE_SCAN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\ue000-\uf8ff]/g;
export const stripInvisible = (s) => String(s).replace(INVISIBLE_STORE, '');

// Letters from other alphabets that look like Latin ones (after NFKC and lower-casing).
const CONFUSABLE = new Map(Object.entries({
  а: 'a', ә: 'a', ɑ: 'a', α: 'a', ꭺ: 'a', е: 'e', ε: 'e', ё: 'e', є: 'e', ҽ: 'e', о: 'o', ο: 'o', ө: 'o', ӧ: 'o', ߋ: 'o', ꓳ: 'o', р: 'p', ρ: 'p', с: 'c', ϲ: 'c', ꮯ: 'c', ҫ: 'c',
  у: 'y', γ: 'y', ү: 'y', ყ: 'y', х: 'x', χ: 'x', ҳ: 'x', ꓫ: 'x', і: 'i', ι: 'i', ї: 'i', ꓲ: 'i', ӏ: 'l', ⅼ: 'l', ǀ: 'l', ј: 'j', ѕ: 's', ꜱ: 's', ꓢ: 's', һ: 'h', ħ: 'h', ԛ: 'q', ԝ: 'w', ѡ: 'w', ω: 'w', ꓪ: 'w',
  ɡ: 'g', ց: 'g', ԁ: 'd', ď: 'd', ꓒ: 'd', ν: 'v', ѵ: 'v', ꮩ: 'v', κ: 'k', к: 'k', ᴋ: 'k', т: 't', τ: 't', м: 'm', ꭑ: 'm', п: 'n', η: 'n', ո: 'n', в: 'b', ƅ: 'b', ь: 'b', ꓐ: 'b', ʀ: 'r', г: 'r', ꭱ: 'r',
  ս: 'u', υ: 'u', µ: 'u', ꓴ: 'u', ꓬ: 'y', ꓜ: 'z', ꮓ: 'z', ƶ: 'z', ꓠ: 'n', ꓔ: 't', ꓝ: 'f', ꓗ: 'k', ꓡ: 'l', ꓟ: 'm', ꓣ: 'r', ꓦ: 'v', ꓹ: 'j',
}));
const DOTS = /[。．｡․‧∙•·・᛫⸱⸳꘎܁܂᠁⸼⳾]/g;
// Short list of endings that are plainly "a web address" and never an English word, for the "example. com" / "example,com" tricks.
const OBVIOUS_TLD = 'com|net|org|xyz|io|app|gg|ly|info|biz|cc|tv|sol|link|site|online|top|club|vip|fun|dev|pro|mobi|lol|wtf';

// One text, as a scammer hopes the reader will see it: NFKC, lower case, look-alikes mapped, invisibles gone, dots unified,
// "(dot)" / "[.]" / " . " written as plain dots.
export function scanForm(text) {
  let s = String(text).replace(INVISIBLE_SCAN, '').normalize('NFKC').toLowerCase();
  return s.replace(/[^\x00-\x7f]/gu, (c) => CONFUSABLE.get(c) ?? c).replace(DOTS, '.');
}
// "(dot)" / "[.]" / " . " / ". com" / ",com" written as plain dots.
function undress(s) {
  s = s.replace(/[\[({<]\s*\.\s*[\])}>]/g, '.');                                                          // [.] (.) {.} <.>
  s = s.replace(/([\p{L}\p{N}])[\s\-_]*(?:[\[({<]\s*d[o0]t\s*[\])}>]|(?<![a-z0-9])d[o0]t(?![a-z0-9]))[\s\-_]*([\p{L}\p{N}])/gu, '$1.$2'); // a dot b, a(dot)b, a-dot-b
  s = s.replace(new RegExp(`([\\p{L}\\p{N}])d[o0]t\\s*(${OBVIOUS_TLD})(?![\\p{L}\\p{N}])`, 'gu'), '$1.$2');   // exampledotcom, exampledot com (glued)
  s = s.replace(new RegExp(`([\\p{L}\\p{N}])\\s*(?:period|punto|punkt|point|comma|dawt|d[o0]tt)\\s*(${OBVIOUS_TLD})(?![\\p{L}\\p{N}])`, 'gu'), '$1.$2'); // example period com
  s = s.replace(/([\p{L}\p{N}])\s+\.\s*([\p{L}\p{N}])/gu, '$1.$2');                                      // a . b, a .b (a space before the dot is never prose)
  s = s.replace(new RegExp(`([\\p{L}\\p{N}])\\.\\s{1,2}(${OBVIOUS_TLD})(?![\\p{L}\\p{N}])`, 'gu'), '$1.$2'); // a. com
  s = s.replace(new RegExp(`([\\p{L}\\p{N}])\\s*,\\s*(${OBVIOUS_TLD})(?![\\p{L}\\p{N}])`, 'gu'), '$1.$2'); // a,com
  s = s.replace(new RegExp(`(?<![\\p{L}\\p{N}])(www\\d{0,3})\\s+([\\p{L}\\p{N}-]{1,63})\\s+(${OBVIOUS_TLD})(?![\\p{L}\\p{N}])`, 'gu'), '$1.$2.$3'); // www example com
  return s;
}
// "e x a m p l e . c o m" (and "c o m" alone): runs of single characters a space apart, joined.
const collapseSpaced = (s) => s.replace(/(?:^|(?<=\s))(?:[\p{L}\p{N}.\-/:]\s){2,}[\p{L}\p{N}.\-/:](?=\s|$)/gu, (m) => m.replace(/\s/g, ''));
// A web ending written with digits for letters ("c0m", "xy2"): read it as the letters it imitates.
const deleet = (t) => (/\d/.test(t) ? t.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't') : t);

// ---- what counts as a link ----
// Every country code, the classic and the common new endings, web3 names (.sol .eth .crypto), plus anything punycode.
// An unknown ending still counts when a port or a path follows ("unknowntld.frobnicate/claim").
const TLDS = new Set(`ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw
com net org info biz name pro mobi tel asia xxx aero coop jobs museum travel cat edu gov mil int arpa post
app dev page xyz top site online store shop tech space club live life world today news blog wiki link click fun fund money cash gold coin crypto nft dao defi finance capital exchange market trade bet casino poker game games play win vip best buzz cool guru ninja rocks works zone one web
email digital network systems solutions services agency company center media studio design art photo photos pics video tube cam chat social community team group partners support help care host hosting cloud domains download
wallet bitcoin blockchain x zil eth sol lol wtf sucks zip mov meme ing boo foo dad phd prof esq nexus rsvp day new how soy ooo onl pw cc tv fm am sh ly to gl gg gs gy ac ms
academy accountants actor adult airforce apartments archi army associates attorney auction audio auto autos baby band bank bar bargains beer bid bike bingo bio black blackfriday boutique broker build builders business cab cafe camera camp cards career careers cars catering ceo charity cheap christmas church city claims cleaning clinic clothing coach codes coffee college computer condos construction consulting contractors cooking country coupons courses credit creditcard cricket cruises dance date dating deals degree delivery democrat dental dentist desi diamonds diet direct directory discount doctor dog earth eat education energy engineer engineering enterprises equipment estate events expert exposed express fail faith family fans farm fashion film fish fishing fit fitness flights florist flowers football forex forsale foundation furniture futbol fyi gallery garden gift gifts gives glass global gmbh golf graphics gratis green gripe guide guitars haus health healthcare hiphop hockey holdings holiday horse hospital house immo immobilien industries ink institute insure international investments jewelry juegos kaufen kim kitchen land lawyer lease legal lgbt limited limo loan loans love ltd luxury maison management marketing mba memorial men menu moda moe mom mortgage movie navy observer organic parts party pet pharmacy photography physio pictures pink pizza plumbing plus porn press productions promo properties property protection pub qpon quebec racing realty recipes red rehab reise reisen rent rentals repair report republican rest restaurant review reviews rich rip run sale salon sarl school schule science security sex sexy shiksha shoes show singles ski soccer software solar study style supplies supply surf surgery tatar tattoo tax taxi tennis theater theatre tienda tips tires tools tours town toys trading training university vacations vegas ventures vet viajes villas vision vodka vote voting voyage watch webcam website wedding whoswho wine work yoga lat dress`.split(/\s+/));

const SCHEME_ANY = /(?<![\p{L}\p{N}])[a-z][a-z0-9+.-]{0,15}:\/\/\S*/u;
const SCHEME_NAMED = /(?<![\p{L}\p{N}])(?:https?|ftps?|sftp|ipfs|ipns|data|javascript|vbscript|mailto|tel|sms|tg|solana|wc|ethereum|bitcoin|litecoin|magnet|file|blob|wss?|ssh|git|smb|about|chrome|intent|market|itms(?:-[a-z]+)?|skype|whatsapp|viber|signal|fb-messenger|instagram|twitter|discord|steam|spotify|zoom(?:us)?):\S+/u;
const WWW = /(?<![\p{L}\p{N}])www\d{0,3}\.(?=[\p{L}\p{N}])/u;
const DOMAIN = /(?<![\p{L}\p{N}-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+)([\p{L}][\p{L}\p{N}-]{1,62})(?![\p{L}\p{N}-])((?::\d{2,5})?(?:\/\S*)?)/gu;
const IPV4 = /(?<![0-9.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![0-9.])(?::\d{2,5})?(?:\/\S*)?/g;
const IPHEX = /(?<![\p{L}\p{N}])0x[0-9a-f]{8}(?![\p{L}\p{N}])/gu;
const IPV6_TOKEN = /(?<![\p{L}\p{N}:.])\[?([0-9a-f:]{3,})\]?(?![\p{L}\p{N}:])/gu;
const PUNY = /(?<![\p{L}\p{N}])xn--[a-z0-9-]+/gu;
const INVITE = /(?<![\p{L}\p{N}])(?:(?:t|telegram)\.me|discord(?:app)?\.(?:gg|com\/invite)|wa\.me|chat\.whatsapp\.com)(?![\p{L}\p{N}])\S*/gu;
const DOT_BARE = new RegExp(`\\bd[o0]t\\s*(?:${OBVIOUS_TLD})(?![\\p{L}\\p{N}])`, 'gu');
// "bit ly/x", "t me/x", "discord gg/x": a known shortener or invite host with its dot replaced by a space, and a path.
const SPACED_HOST = /(?<![\p{L}\p{N}])(?:bit\s+ly|t\s+me|telegram\s+me|discord\s+gg|tinyurl\s+com|wa\s+me|goo\s+gl|cutt\s+ly|rb\s+gy|is\s+gd)\s*\/\S*/gu;
// "e.x.a.m.p.l.e.c.o.m": six or more single letters a dot apart (prose stops at "U.S.A.").
const DOTTED = /(?<![\p{L}\p{N}])(?:[\p{L}]\.){5,}[\p{L}](?![\p{L}\p{N}])/gu;
const isV6 = (t) => { const groups = t.split(':').filter(Boolean); if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return false; return (t.includes('::') && groups.length >= 1 && groups.length <= 7) || (groups.length === 8 && (t.match(/:/g) || []).length === 7); };

function linksIn(s) {
  const out = [];
  const grab = (re) => { for (const m of s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) out.push(m[0]); };
  grab(SCHEME_ANY); grab(SCHEME_NAMED); grab(WWW); grab(IPV4); grab(IPHEX); grab(PUNY); grab(INVITE); grab(DOT_BARE); grab(SPACED_HOST); grab(DOTTED);
  for (const m of s.matchAll(DOMAIN)) { const tld = m[2]; if (TLDS.has(tld) || TLDS.has(deleet(tld)) || tld.startsWith('xn--') || /[^\x00-\x7f]/.test(tld) || m[3]) out.push(m[0]); }
  for (const m of s.matchAll(IPV6_TOKEN)) if (isV6(m[1])) out.push(m[0]);
  return out;
}
// Every link-like thing in a text (as the normalized form shows it). Empty = clean.
export function findLinks(text) {
  const base = scanForm(text); const a = undress(base); const b = undress(collapseSpaced(base));
  const found = linksIn(a); if (b !== a) found.push(...linksIn(b));
  // a scheme match swallows the domain match that follows it; keep the longest of overlapping finds
  return [...new Set(found)].filter((x, i, arr) => !arr.some((y) => y !== x && y.includes(x)));
}
export function hasUrl(s) { return findLinks(s).length > 0; }

// ---- wallet addresses, keys, seed phrases ----
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const B58_RUN = new RegExp(`(?<!${B58})${B58}{32,88}(?!${B58})`, 'g');
const BTC_LEGACY = new RegExp(`(?<!${B58})[13]${B58}{25,34}(?!${B58})`, 'g');
const BECH32 = /(?<![a-z0-9])(?:bc1|tb1|ltc1)[02-9ac-hj-np-z]{25,87}(?![a-z0-9])/gi;
const ETH = /(?<![a-z0-9])0x[0-9a-f]{40}(?![a-z0-9])/gi;
const HEX64 = /(?<![a-z0-9])(?:0x)?[0-9a-f]{64}(?![a-z0-9])/gi;
const KEYPAIR_JSON = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g;
export function findSecrets(text) {
  const s = String(text).replace(INVISIBLE_SCAN, '').normalize('NFKC');
  const out = [];
  for (const re of [B58_RUN, BTC_LEGACY, BECH32, ETH, HEX64, KEYPAIR_JSON]) for (const m of s.matchAll(re)) if (m[0] !== TBB_MINT) out.push(m[0]);
  // 12 (or more) BIP39 words in a row, however they are numbered or separated
  const words = s.toLowerCase().match(/[a-z]+/g) || [];
  for (let i = 0; i + 12 <= words.length; i++) { if (words.slice(i, i + 12).every((w) => BIP39.has(w))) { out.push(words.slice(i, i + 12).join(' ')); break; } }
  return [...new Set(out)];
}

// ---- doxxing shapes ----
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+?\d[\s().-]*){10,}/;
const STREET = /\b\d{1,6}\s+(?:[A-Za-z0-9.]+\s){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|circle|cir|highway|hwy)\b\.?/i;

// What is wrong with a user's text, if anything: { kind, error } or null. kind ∈ empty | email | phone | street | link | secret.
export function classifyUserText(text) {
  const t = stripInvisible(text);
  if (!t.trim()) return { kind: 'empty', error: 'Say something first.' };
  if (EMAIL.test(t)) return { kind: 'email', error: 'No e-mail addresses — keep everyone private, you included.' };
  if (PHONE.test(t.replace(/\b\d{1,3}(,\d{3})+\b/g, ''))) return { kind: 'phone', error: 'That looks like a phone number. Keep it private.' };
  if (STREET.test(t)) return { kind: 'street', error: 'That looks like a street address. Keep it private.' };
  if (hasUrl(t)) return { kind: 'link', error: LINK_MSG };
  if (findSecrets(t).length) return { kind: 'secret', error: SECRET_MSG };
  return null;
}
// Returns null when fine, or a kind message explaining the block.
export function checkUserText(text) { return classifyUserText(text)?.error ?? null; }

const RESERVED = ['satoshi', 'nakamoto', 'halfinney', 'hal finney', 'finney', 'jason', 'goingparabolic', 'admin', 'moderator', 'mod team', 'support', 'official', 'tbbteam', 'tbb team', 'theherd', 'the herd', 'helpdesk', 'staff'];
// Display names that claim to be staff (also used by the scam filter to flag older names).
export function isStaffName(name) {
  const n = normalize(name); const squashed = n.replace(/ /g, '');
  return RESERVED.some((r) => n.includes(r) || squashed.includes(r.replace(/ /g, '')));
}

export function checkName(name) {
  const s = String(name ?? '').trim();
  if (s.length < 2 || s.length > 24) return 'Names are 2 to 24 characters.';
  // Latin letters only: lookalike letters from other alphabets are the classic impersonation trick.
  if (!/^[A-Za-z0-9 ._-]+$/.test(s)) return 'Use letters A–Z, numbers, spaces, dots, dashes or underscores.';
  if (isStaffName(s)) return 'That name is reserved. Pick your own.';
  if (hasUrl(s)) return 'A name can’t look like a web address.';
  if (SLURS.some((w) => (' ' + normalize(s) + ' ').includes(w))) return 'Pick a different name.';
  return null;
}

// ---- block chain text (coinbase / OP_RETURN) ----
const POOL_TAGS = /(mined by|minedby|\/slush\/|antpool|f2pool|viabtc|btc\.com|poolin|binance|foundry|luxor|braiins|spiderpool|marapool|mara pool|ocean|sbicrypto|emcd|secpool|ultimuspool|kucoinpool|bitfury|btcguild|bitminter|eligius|ghash|kano|cksolo|solo ?ck|nicehash|okex|okpool|huobi|1thash|btc\.top|bw\.com|58coin|bitclub|canoe|kncminer|bixin|rawpool|whitepool|titan|pega ?pool|sigmapool|carbon ?negative|bitdeer|bitcoin\.com|hashpool)/i;
const PROTOCOL = /^(omni|ord\b|=:|docproof|counterparty|cntrprty|stamp:|bitproof|ots\b|opentimestamps|exodus|blockstack|id\.|thor|swap:|out:|refund:|rune)/i;
const B58ADDR = /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bbc1[0-9a-z]{20,}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

// Lore is at most 140 characters, so nothing longer than LORE_MAX bytes is decoded or scanned: the trailing-strip regex in
// cleanLore is quadratic on long runs of spaces (seconds at 99k chars), and a block can carry data of any size.
const LORE_MAX = 1000;
export function hexToText(hex) {
  if (typeof hex !== 'string' || hex.length > 2 * LORE_MAX) return null;
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return null;
  const bytes = Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

// Pull printable runs out of a coinbase scriptsig. Parse it as script pushes first (so push-length
// bytes like 0x45 'E' don't leak into the text), then fall back to a raw scan.
function scriptPushes(bytes) {
  const out = []; let i = 0;
  while (i < bytes.length) {
    const op = bytes[i++]; let n = -1;
    if (op >= 1 && op <= 75) n = op;
    else if (op === 0x4c) n = bytes[i++];
    else if (op === 0x4d) { n = bytes[i] | (bytes[i + 1] << 8); i += 2; }
    else continue;
    if (n < 0 || i + n > bytes.length) return null;
    out.push(bytes.subarray(i, i + n)); i += n;
  }
  return out;
}
function printableRuns(bytes, runs) {
  let cur = [];
  const flush = () => { if (cur.length >= 12) { try { runs.push(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(cur))); } catch { /* skip */ } } cur = []; };
  for (const b of bytes) { if ((b >= 0x20 && b < 0x7f) || b >= 0x80) cur.push(b); else flush(); }
  flush();
}
export function coinbaseCandidates(scriptsigHex) {
  const bytes = Uint8Array.from((scriptsigHex.match(/../g) || []), (h) => parseInt(h, 16));
  const runs = [];
  const pushes = scriptPushes(bytes);
  if (pushes) for (const p of pushes) printableRuns(p, runs);
  else printableRuns(bytes, runs);
  // Some miners split one sentence across pushes; offer the joined text too (the filter decides).
  if (runs.length > 1) runs.push(runs.join(' '));
  return runs;
}

// Parse OP_RETURN asm ("OP_RETURN OP_PUSHBYTES_n <hex> ...") → text pieces.
export function opReturnCandidates(asm) {
  if (!asm || !asm.startsWith('OP_RETURN')) return [];
  const hexes = asm.split(' ').filter((p) => /^[0-9a-f]+$/i.test(p) && p.length >= 8 && p.length <= 2 * LORE_MAX);
  const joined = hexToText(hexes.join(''));
  return joined ? [joined] : hexes.map(hexToText).filter(Boolean);
}

export function cleanLore(raw) {
  if (typeof raw !== 'string' || raw.length > LORE_MAX) return null; // before any regex (see LORE_MAX)
  if (POOL_TAGS.test(raw)) return null;
  // eslint-disable-next-line no-control-regex
  let t = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^\/[A-Za-z0-9. _-]{2,20}\//, '').replace(/\/+$/, ''); // leading "/PoolName/" tag
  t = t.replace(/^[^\p{L}\p{N}"'“(]+/u, '').replace(/[^\p{L}\p{N}.!?"'”)]+$/u, '').trim();
  if (t.length < 12 || t.length > 140) return null;
  const letters = (t.match(/[\p{L} ]/gu) || []).length;
  if (letters / t.length < 0.6) return null;
  if ((t.match(/\p{L}+/gu) || []).filter((w) => w.length >= 2).length < 3) return null;
  if (/^[0-9a-f\s]+$/i.test(t) || /^[A-Za-z0-9+/=]{20,}$/.test(t)) return null;
  if (hasUrl(t) || EMAIL.test(t) || PHONE.test(t) || B58ADDR.test(t)) return null;
  if (POOL_TAGS.test(t) || PROTOCOL.test(t)) return null;
  const n = ' ' + normalize(t) + ' ';
  if (PROFANE.some((w) => n.includes(w))) return null;
  if (/(.)\1{5,}/.test(t)) return null;
  return t;
}
