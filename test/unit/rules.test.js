import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { checkUserText, checkName, cleanLore, coinbaseCandidates, opReturnCandidates, hexToText } from '../../lib/rules.js';
import { nextWeeklyClose } from '../../lib/app.js';

test('chat text: blocks doxing, links and addresses; allows normal talk, swearing included', () => {
  assert.equal(checkUserText('gm herd, fog is thick tonight'), null);
  assert.equal(checkUserText('I bought 1,000,000 TBB at 0.0001'), null);
  assert.equal(checkUserText('fuck it, we ride at dawn'), null, 'no profanity filter');
  assert.match(checkUserText('email me at bob@example.com'), /e-mail/);
  assert.match(checkUserText('call 555-555-0199 now'), /phone/);
  assert.match(checkUserText('he lives at 1234 N Elm Street'), /street address/);
  assert.equal(checkUserText('never share your seed phrase'), null, 'warning people is fine; asking for one is the scam filter’s job (lib/modrules.js)');
  assert.match(checkUserText('check https://evil.example'), /Links aren’t allowed yet/);
  assert.match(checkUserText('check evil dot example dot com'), /Links aren’t allowed yet/);
  assert.match(checkUserText('send to 7Nz7Z1Yj9Q3xYQp6q4Y2m1RkTo8m4nGpD3Qc1vqJz8Km'), /addresses/);
  assert.match(checkUserText('   '), /Say something/);
});

test('names: impersonation and reserved words are blocked (leet too)', () => {
  assert.equal(checkName('ridgeRunner'), null);
  for (const n of ['Satoshi', 'sat0shi n', 'S A T O S H I', 'Hal Finney', 'Jason_TBB', 'Admin', 'TBB Team', 'official bull', 'GoingParabolic', 'The Herd']) assert.ok(checkName(n), n);
  assert.ok(checkName('a')); assert.ok(checkName('x'.repeat(30))); assert.ok(checkName('<script>'));
  assert.ok(checkName('Sаtoshi'), 'Cyrillic lookalike blocked');
});

test('lore filter keeps human messages, drops junk', () => {
  assert.equal(cleanLore('The Times 03/Jan/2009 Chancellor on brink of second bailout for banks'), 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks');
  assert.equal(cleanLore('Mined by AntPool usa1 W'), null);
  assert.equal(cleanLore('/slush/ some words here'), null);
  assert.equal(cleanLore('deadbeefdeadbeefdeadbeefcafebabe'), null);
  assert.equal(cleanLore('visit https://scam.example now please'), null);
  assert.equal(cleanLore('send to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa please now'), null);
  assert.equal(cleanLore('short'), null);
  assert.equal(cleanLore('omni something something something'), null);
  assert.equal(cleanLore('fuck this block and everything'), null);
  assert.equal(cleanLore('aaaaaaaaaaaaaaaaaaa words here'), null);
  assert.equal(cleanLore('\u0003\u0001 Hello from the block chain, friends'), 'Hello from the block chain, friends');
  assert.equal(cleanLore('/HaoBTC/Zhuang Yuan: YES, of course/'), 'Zhuang Yuan: YES, of course');
  assert.equal(cleanLore('09/Apr/2020 With $2.3T Injection Fed’s Plan'), '09/Apr/2020 With $2.3T Injection Fed’s Plan');
});

test('coinbase + OP_RETURN decoding', () => {
  // Real genesis coinbase scriptsig.
  const genesis = '04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73';
  const c = coinbaseCandidates(genesis).map(cleanLore).filter(Boolean);
  assert.deepEqual(c, ['The Times 03/Jan/2009 Chancellor on brink of second bailout for banks']);
  const hex = Buffer.from('Never trust, always verify. Love from the herd').toString('hex');
  assert.equal(cleanLore(opReturnCandidates(`OP_RETURN OP_PUSHBYTES_46 ${hex}`)[0]), 'Never trust, always verify. Love from the herd');
  assert.deepEqual(opReturnCandidates('OP_DUP OP_HASH160'), []);
  assert.equal(hexToText('ff'), null);
});


test('weekly vote close is the next Sunday 23:59:59 UTC', () => {
  const now = Date.parse('2030-01-03T12:00:00Z'); // a Thursday
  const c = nextWeeklyClose(now);
  assert.equal(new Date(c).toISOString(), '2030-01-06T23:59:59.000Z');
  assert.ok(nextWeeklyClose(c + 1000) > c + 6 * 86400_000);
  assert.equal(new Date(nextWeeklyClose(Date.parse('2030-01-06T23:59:58Z'))).toISOString(), '2030-01-06T23:59:59.000Z');
});

// An over-long candidate is refused before any regex runs (the trailing-strip regex is quadratic: ~7 s at 99k chars).
test('cleanLore refuses anything over 1000 chars at once; hexToText and opReturnCandidates cap their output before decoding', () => {
  const junk = 'a' + ' -'.repeat(49_000) + 'b'; // the trailing-strip regex backtracks over every space: ~7 s without the cap
  let t0 = performance.now(); assert.equal(cleanLore(junk), null); assert.ok(performance.now() - t0 < 200, `cleanLore took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(cleanLore('a'.repeat(1001)), null); assert.equal(cleanLore('b '.repeat(70).trim()), null, 'still refused by the ordinary rules');
  assert.equal(cleanLore('The Times 03/Jan/2009 Chancellor on brink of second bailout for banks'), 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks');
  const hugeHex = '78'.repeat(100_000);
  t0 = performance.now(); assert.equal(hexToText(hugeHex), null); assert.deepEqual(opReturnCandidates("OP_RETURN " + hugeHex), []); assert.deepEqual(opReturnCandidates("OP_RETURN " + hugeHex.slice(0, 80_000) + " 68656c6c6f20776f726c64"), ["hello world"]); assert.ok(performance.now() - t0 < 200, "hex path slow");
  assert.equal(hexToText("48656c6c6f"), "Hello"); assert.equal(hexToText("78".repeat(1001)), null, "over 1000 bytes is never lore");
});
