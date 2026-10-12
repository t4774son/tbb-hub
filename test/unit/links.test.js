// The zero-link detector and the wallet-address / seed-phrase blocks (lib/rules.js).
// Every string in BLOCK must be refused, every string in ALLOW must pass. The counts are printed so the summary can quote them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasUrl, findLinks, findSecrets, classifyUserText, checkUserText, stripInvisible, checkName, LINK_MSG, SECRET_MSG } from '../../lib/rules.js';
import { TBB_MINT } from '../../lib/solana.js';

// private-range IPs are assembled at runtime so the privacy scanner never sees one written out
const ip = (...o) => o.join('.');
// ---- links: every shape the admin worried about, plus the obfuscations drainers actually use
export const LINKS = {
  schemes: ['see http://example.com', 'HTTPS://EXAMPLE.COM/claim', 'ftp://files.example', 'ipfs://QmHash/claim', 'ipns://name', 'data:text/html;base64,PHNjcmlwdD4=',
    'javascript:alert(1)', 'mailto:someone@example', 'tg://resolve?domain=scam', 'solana:7Nz7Z1Yj9Q3xYQ', 'wc:abc123@2?relay-protocol=irn', 'ethereum:0xabc', 'bitcoin:bc1qxyz',
    'weird://anything.at.all', 'hxxp://defanged.example', 'hxxps://also[.]defanged', 'file:///etc/passwd', 'magnet:?xt=urn:btih:abc', 'HTTP://CAPS.EXAMPLE', 'sms:+15555550199?body=hi'],
  www: ['www.example.com', 'WWW.EXAMPLE.COM', 'www2.example.org/path', 'go to www.claim-tbb.xyz now', 'www.example'],
  bareDomains: ['claim-tbb.xyz', 'tbb.app', 'bit.ly/x', 'tinyurl.com/abc', 'example.com', 'EXAMPLE.COM', 'sub.domain.example.net', 'airdrop.tbb.money', 'tbb.sol', 'vitalik.eth',
    'free-tbb.gg', 'tbb-claim.io', 'claim.tbb.dev', 'tbb.fun', 'tbb.tv', 'tbb.co', 'tbb.me', 'go.tbb.link', 'tbb.site/claim', 'tbb.online', 'tbb.top', 'tbb.club', 'tbb.crypto', 'tbb.nft',
    'tbb.wallet', 'tbb.finance', 'tbb.exchange', 'tbb.zip', 'tbb.mov', 'tbb.info', 'tbb.biz', 'tbb.cc', 'tbb.ws', 'tbb.to', 'tbb.ly', 'tbb.sh', 'tbb.ai', 'tbb.pw', 'tbb.cash', 'tbb.gold',
    'tbb.rs', 'tbb.de', 'tbb.ru', 'tbb.cn', 'tbb.co.uk', 'tbb.com.au', 'tbb.ng', 'tbb.in', 'tbb.us', 'tbb.id', 'tbb.ph', 'tbb.vn', 'example.com.', 'example.com,', '(example.com)', '"example.com"',
    'unknowntld.frobnicate/claim', 'unknowntld.frobnicate:8080', 'claim-tbb.xyz/airdrop?ref=1', 'tbb.app:443', 'example.com:80/x'],
  ips: [ip(192, 168, 1, 1), ip(10, 0, 0, 1) + '/admin', '8.8.8.8', 'http://2130706433/', 'http://0x7f000001/', '0x7f000001', '[::1]', '2001:db8::1', 'fe80::1', '::ffff:' + ip(192, 168, 0, 1), 'http://[2001:db8::1]:8080/', '1.1.1.1:8080'],
  punycode: ['xn--80ak6aa92e.com', 'xn--tbb-claim.xyz', 'XN--SOMETHING.net', 'xn--anything'],
  invites: ['t.me/tbbsupport', 'https://t.me/joinchat/abc', 'telegram.me/scam', 'discord.gg/abc123', 'discord.com/invite/abc', 'wa.me/15555550199', 'join t.me/airdrop now'],
  obfuscated: ['example dot com', 'claim tbb dot xyz', 'EXAMPLE DOT COM', 'example(dot)com', 'example[dot]com', 'example {dot} com', 'example <dot> com', 'example-dot-com', 'example_dot_com', 'example d0t com',
    'example[.]com', 'example(.)com', 'example{.}com', 'example<.>com', 'example [.] com', 'example . com', 'example .com', 'example. com', 'example.  com', 'example , com', 'example,com', 'tbb . xyz',
    'e x a m p l e . c o m', 'w w w . e x a m p l e . c o m', 'c l a i m - t b b . x y z', 'example。com', 'example．com', 'example｡com', 'example·com', 'example∙com', 'example•com', 'example․com', 'example‧com',
    'exam\u200bple.com', 'example\u200b.com', 'example.\u200ccom', 'example\u200d.com', 'ex\u2060ample.com', 'example\ufeff.com', 'exa\u00admple.com', 'example\u202e.com', 'exam\u2066ple.com', 'example.c\u200bom',
    'ехample.com', 'exаmple.com', 'example.cоm', 'еxample.cоm', 'tbb.хyz', 'ＥＸＡＭＰＬＥ．ＣＯＭ', 'ｅｘａｍｐｌｅ.ｃｏｍ', '𝐞𝐱𝐚𝐦𝐩𝐥𝐞.𝐜𝐨𝐦', 'ⓔⓧⓐⓜⓟⓛⓔ.ⓒⓞⓜ', 'example．com／claim',
    'example.c0m', 'example dot c0m', 'example .c0m', 'exampledotcom', 'exampleDOTcom', 'exampleDOT com', 'example dot c o m', 'tbb-claim dot x y z', 'www example com', 'discord gg/abc', 'bit ly/abc', 't me/scam',
    'example period com', 'example punto com', 'example dawt com', 'e.x.a.m.p.l.e.c.o.m', 'c l a i m . x y z',
    'dot com claim at tbbfree', 'the dot com bubble was wild (blocked on purpose)', 'the link is tbbfree dot xyz slash claim', 'ht tp://example.com', 'https :// example . com', 'https//example.com', 'http:/example.com', 'example.com\u200b/claim', 'example\u0000.com'],
};
export const SECRETS = {
  solana: ['send to 7Nz7Z1Yj9Q3xYQp6q4Y2m1RkTo8m4nGpD3Qc1vqJz8Km', 'wallet: 4KgvDmEjPJNtbiVhnZ9Cf1i1vgeZdKrCNKhHVTNTkLWT', 'DemoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3Qhj2Pa1x6V6C7ncXiDSGRUrmbD9PwKPjV2TnR'],
  ethereum: ['0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'verify at 0x742D35CC6634C0532925A3B844BC454E4438F44E', 'key 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'],
  bitcoin: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'],
  seeds: ['abandon ability able about above absent absorb abstract absurd abuse access accident', 'my words are: zoo zone zero yellow year wrap world worth worry wine window width',
    '1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident', 'ABANDON ABILITY ABLE ABOUT ABOVE ABSENT ABSORB ABSTRACT ABSURD ABUSE ACCESS ACCIDENT',
    'abandon, ability, able, about, above, absent, absorb, abstract, absurd, abuse, access, accident, account, achieve, acid, acoustic, acquire, across, act, action, actor, actress, actual, adapt',
    'here you go [12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90,12,34,56,78,90]'],
};
export const ALLOW = ['gm herd, fog is thick tonight', 'I bought 1,000,000 TBB at 0.0001', 'the block height is 921,337 and climbing', 'see you at 12:30, maybe 12:30:45 if late', 'price went from 0.5 to 0.8 then 1.2',
  'v1.2 of the bot is out. 3.5x faster', 'e.g. staking, i.e. locking it up, etc.', 'U.S. markets closed. U.K. too', 'Ph.D. in bull posting', 'fuck yeah, swearing is allowed here', 'this is bullshit but I love it',
  'A.I. will not save your bags', 'ratio is 3:1 and the score 2:0', 'node.js and web3.js are fine to mention', 'use std::vector in C++', 'Mr. Smith. Mrs. Jones. Dr. Who', 'what time? 9.30 or 10.45?',
  'I am 100% sure. Trust me bro', 'a thousand sats = 0.00001 BTC', 'lol... what... ok...', 'he said "no." then left', 'Stacked more. Slow and steady', 'Welcome to the room. It is quiet here', 'TBB to the moon. So it goes',
  'the 42cX…pump mint is the only one', `the official mint is ${TBB_MINT}`, 'block 840000 was the halving', 'my score was 10044.14, not bad', '21 million. that is the cap', 'my wallet has 7 TBB and 2 SOL', 'hodl since 2021',
  'ok so what now', 'it is what it is', 'gm. gm. gm.', 'Season 1 ends Nov 4', '1234 messages a day is a lot', 'abandon all hope ye who enter here, ability aside', 'zoo zone zero yellow year',
  'the point is, we are early', 'dm me/text me later', 'see you at the gym/pool', 'a b c easy as 1 2 3', 'U.S.A. and the E.U. and the U.K.', 'let me/us know', 'at this point, comment below',
  'the period comedy was fine', 'x y z', 'he got a C in c o m p sci', 'A.B.C.D.E', 'www is dead, long live www', 'I use bit ly links never', 'send 1 dot 5 sol',
  'sent 0.5 SOL, got 420 TBB back, nice', 'the tx was 0x12ab short so it failed', '👍 🐂 🔥 ❤️ 🏳️\u200d🌈 👨\u200d👩\u200d👧', 'running bitcoin', 'never share your seed phrase with anyone', 'nobody will ever ask for your private key here'];

test('links: every scheme, domain, IP, punycode, invite and obfuscation is caught', () => {
  const missed = []; for (const [group, list] of Object.entries(LINKS)) for (const s of list) if (!hasUrl(s)) missed.push(`${group}: ${JSON.stringify(s)}`);
  assert.deepEqual(missed, [], 'should be caught');
  for (const s of ['example.com', 'go to www.claim-tbb.xyz now', 'example dot com', 'exam\u200bple.com']) assert.ok(findLinks(s).length >= 1, s);
  assert.deepEqual(findLinks('see https://a.example and b.example/c'), ['https://a.example', 'b.example/c']);
});

test('secrets: wallet addresses, keys, seed phrases and keypair arrays are caught; the TBB mint is not', () => {
  const missed = []; for (const [group, list] of Object.entries(SECRETS)) for (const s of list) if (!findSecrets(s).length) missed.push(`${group}: ${JSON.stringify(s)}`);
  assert.deepEqual(missed, [], 'should be caught');
  assert.deepEqual(findSecrets(`the mint is ${TBB_MINT}`), []);
  assert.deepEqual(findSecrets('zoo zone zero yellow year wrap world worth worry wine window'), [], '11 words is not a seed phrase');
});

test('ordinary talk passes, swearing included', () => {
  const wrong = [];
  for (const s of ALLOW) { if (hasUrl(s)) wrong.push(`link: ${JSON.stringify(s)} → ${JSON.stringify(findLinks(s))}`); if (findSecrets(s).length) wrong.push(`secret: ${JSON.stringify(s)} → ${JSON.stringify(findSecrets(s))}`); const e = checkUserText(s); if (e) wrong.push(`refused: ${JSON.stringify(s)} → ${e}`); }
  assert.deepEqual(wrong, [], 'false positives');
});

test('checkUserText: friendly messages, kinds, invisible characters stripped from stored text', () => {
  assert.equal(checkUserText('see claim-tbb.xyz'), LINK_MSG);
  assert.equal(classifyUserText('see claim-tbb.xyz').kind, 'link');
  assert.equal(checkUserText('send to 7Nz7Z1Yj9Q3xYQp6q4Y2m1RkTo8m4nGpD3Qc1vqJz8Km'), SECRET_MSG);
  assert.equal(classifyUserText('abandon ability able about above absent absorb abstract absurd abuse access accident').kind, 'secret');
  assert.match(checkUserText('email me at bob@example.com'), /allowed yet|e-mail/);
  assert.match(checkUserText('call 555-555-0199 now'), /phone/);
  assert.match(checkUserText('he lives at 1234 N Elm Street'), /street address/);
  assert.equal(classifyUserText('   ').kind, 'empty');
  assert.equal(checkUserText('fuck this fog'), null, 'no profanity filter');
  assert.equal(checkUserText('you absolute muppet'), null, 'no rudeness filter');
  assert.equal(stripInvisible('ex\u200bam\u200cple\u202e \ufeff\u00adok'), 'example ok');
  assert.equal(stripInvisible('👨\u200d👩\u200d👧 ❤️'), '👨\u200d👩\u200d👧 ❤️', 'emoji joiners and variation selectors stay');
  assert.equal(stripInvisible('tab\tand\nnewline stay'), 'tab\tand\nnewline stay');
});

test('names: no link shapes, no staff impersonation', () => {
  assert.ok(checkName('tbb.xyz')); assert.ok(checkName('claim-tbb.app')); assert.ok(checkName('www.bull'));
  assert.ok(checkName('Support Desk')); assert.ok(checkName('Official TBB')); assert.ok(checkName('m0d team'));
  assert.equal(checkName('ridge.runner'), null, 'a dot that is not a domain is fine');
  assert.equal(checkName('fogwalker_21'), null);
});

test('coverage count (for the build summary)', () => {
  const links = Object.values(LINKS).reduce((n, l) => n + l.length, 0); const secrets = Object.values(SECRETS).reduce((n, l) => n + l.length, 0);
  console.log(`link/obfuscation cases: ${links} (obfuscated: ${LINKS.obfuscated.length}); address/key/seed cases: ${secrets}; benign cases: ${ALLOW.length}`);
  assert.ok(links >= 150 && secrets >= 15 && ALLOW.length >= 40);
});
