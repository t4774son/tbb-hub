// The scam filter (lib/modrules.js): each signal, each outcome, and the things it must leave alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMessage, REJECT_MSG, HOLD_MSG, REPEAT_MSG, FLOOD_MSG, NAME_MSG } from '../../lib/modrules.js';

const outcome = (t, o = {}) => scoreMessage(t, o).outcome;

test('scam phrases are refused outright', () => {
  const REJECT = ['send me your seed phrase to verify', 'paste your recovery phrase below', 'enter your 12 words here to sync', 'share your private key and I fix it', 'seed phrase here now please',
    'connect your wallet to claim', 'validate your wallet at the portal', 'sync wallet to receive rewards', 'verify ur wallet now', 'please re-authorize your wallet',
    'claim your airdrop before it ends', 'collect your free SOL', 'redeem your rewards now', 'claim airdrop', 'double your TBB in 24 hours', 'send 1 SOL get 2 SOL back', '10x your deposit guaranteed',
    'send me 0.5 SOL for the fee', 'deposit to this address 2 SOL', 'whitelist spots open, dm', 'presale link in bio dm now', 'guaranteed mint spots',
    'DM me for details', 'pm me', 'message me on telegram', 'hit me up on whatsapp', 'write me on tg @bull_support', '@bullhelp on telegram', 'my telegram is @xyz', 'join our telegram group',
    'admin here, we are checking wallets', 'I am the official support', 'this is TBB support, open a ticket', 'I’m a mod, send me your details', 'contact wallet support team'];
  const wrong = REJECT.filter((t) => outcome(t) !== 'reject').map((t) => `${t} → ${JSON.stringify(scoreMessage(t))}`);
  assert.deepEqual(wrong, [], 'should be rejected');
  assert.equal(scoreMessage('DM me for details').error, REJECT_MSG);
  assert.equal(scoreMessage('DM me for details').kind, 'scam');
  assert.ok(scoreMessage('send me your seed phrase').reasons.includes('seed_ask'));
  assert.ok(scoreMessage('message me on telegram').reasons.includes('dm_me'));
});

test('weaker signals are held for the admin, never broadcast', () => {
  const HOLD = ['any telegram group for this?', 'is there a giveaway this week?', 'urgent: act now', 'you have been selected', 'verify kyc for the airdrop'];
  const wrong = HOLD.filter((t) => outcome(t) !== 'hold').map((t) => `${t} → ${JSON.stringify(scoreMessage(t))}`);
  assert.deepEqual(wrong, [], 'should be held');
  assert.equal(scoreMessage('any telegram group for this?').error, HOLD_MSG);
});

test('ordinary talk, swearing, caps, warnings about scams and single scammy words pass', () => {
  const ALLOW = ['gm herd', 'FUCK YES WE ARE SO BACK', 'you absolute donkey, that take is garbage', 'never share your seed phrase with anyone', 'nobody here will ever ask for your private key',
    'don’t connect your wallet to random sites', 'did anyone get the airdrop last year?', 'support for staked balances is coming', 'I claim this ridge for the herd', 'the devs should verify the contract',
    'TBB TO THE MOON!!!', 'ratio + L + no bull', 'reward for the best meme is bragging rights', 'the fog is thick, hold tight', 'stop asking people for their recovery phrase, scammer', 'that seed phrase scam got my cousin'];
  const wrong = ALLOW.filter((t) => outcome(t) !== 'allow').map((t) => `${t} → ${JSON.stringify(scoreMessage(t))}`);
  assert.deepEqual(wrong, [], 'false positives');
});

test('impersonation in the display name, mass mentions, repeats and floods', () => {
  assert.equal(scoreMessage('hello', { name: 'TBB Support' }).error, NAME_MSG);
  assert.equal(scoreMessage('hello', { name: 'm0d team' }).kind, 'impersonation');
  assert.equal(outcome('hello', { name: 'fogwalker' }), 'allow');
  assert.equal(outcome('@a @b @c @d look here'), 'hold');
  assert.equal(outcome('@fogwalker nice one'), 'allow');
  const now = Date.now();
  assert.equal(scoreMessage('gm herd', { recent: [{ body: 'GM  herd ', at: now - 30_000 }], now }).error, REPEAT_MSG);
  assert.equal(outcome('gm herd', { recent: [{ body: 'gm herd', at: now - 11 * 60_000 }], now }), 'allow', 'an old repeat is fine');
  const flood = Array.from({ length: 5 }, (_, i) => ({ body: 'msg ' + i, at: now - i * 5000 }));
  assert.equal(scoreMessage('another', { recent: flood, now }).error, FLOOD_MSG);
  assert.equal(outcome('another', { recent: flood.slice(0, 4), now }), 'allow');
});
