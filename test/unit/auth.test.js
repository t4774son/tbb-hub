// Accounts: scrypt hashes with their parameters, constant-time checks, username and password rules, recovery codes,
// the sign-in throttle and the sign-up proof of work. Pure functions, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashSecret, verifySecret, parseHash, dummyVerify, makeGate, scryptGate, checkUsername, checkPassword, isStaffUsername, makeRecoveryCode, normalizeRecoveryCode, canonicalCode, makeThrottle, makePow, leadingZeroBits, powHash, SCRYPT } from '../../lib/auth.js';

test('scrypt: N=2^15 r=8 p=1, 16-byte salt, 64-byte key, parameters stored per hash, fresh salt every time', async () => {
  const h = await hashSecret('correct horse battery');
  const p = parseHash(h);
  assert.equal(p.N, 32768); assert.equal(p.r, 8); assert.equal(p.p, 1); assert.equal(p.salt.length, 16); assert.equal(p.key.length, 64);
  assert.equal(SCRYPT.N, 2 ** 15);
  assert.notEqual(h, await hashSecret('correct horse battery'), 'new salt each time');
  assert.equal(await verifySecret('correct horse battery', h), true);
  assert.equal(await verifySecret('correct horse batter', h), false);
  assert.equal(await verifySecret('', h), false);
  assert.equal(await verifySecret('x', 'not a hash'), false);
  assert.equal(await verifySecret('x', 'scrypt$1024$8$1$' + 'a'.repeat(22) + '$' + 'b'.repeat(86)), false, 'weak parameters refused');
  assert.equal(await verifySecret('x', null), false);
  // a hash made with other (stronger) parameters still verifies: the parameters travel with it
  const strong = await hashSecret('pw-strong-enough', { N: 2 ** 16, r: 8, p: 2, saltBytes: 16, keyBytes: 64 });
  assert.equal(await verifySecret('pw-strong-enough', strong), true);
  assert.equal(await dummyVerify('anything'), false, 'the dummy hash never matches');
  assert.equal(await verifySecret('café', await hashSecret('café')), true, 'unicode normalised');
});

test('usernames: 3–20 [A-Za-z0-9_], staff-like and look-alike names refused, people and slurs from the name rules too', () => {
  for (const ok of ['ridgerunner', 'fog_walker', 'Bull2024', 'abc', 'a'.repeat(20), 'modest', 'bbtmaxi', 'herdwalker_7']) assert.equal(checkUsername(ok), null, ok);
  for (const bad of ['ab', 'a'.repeat(21), 'ridge runner', 'ridge-runner', 'ridge.runner', '123456', '_lead', 'trail_', 'dou__ble', 'ünïcode']) assert.ok(checkUsername(bad), bad);
  for (const staff of ['admin', 'Admin42', 'adm1n', 'tbb_admin', 'TBB', 'tbb2024', 'mod', 'm0d_squad', 'Moderator', 'support', 'tbb_support', '0fficial', 'TBBofficial', 'team_tbb', 'Team', 'staff', 'bitcoinbull', 'TheBitcoinBull', 'helpdesk99', 'satoshi', 'GoingParabolic', 'jason_x', 'owner', 'sysadmin']) {
    assert.match(checkUsername(staff) || '', /reserved/i, staff);
  }
  assert.equal(isStaffUsername('modest'), false); assert.equal(isStaffUsername('ad_min'), true); assert.equal(isStaffUsername('supporter'), true, 'a fragment counts: a rare false positive beats an impersonator');
});

test('passwords: at least 10 characters, not on the common list (with or without a trailing 123), not the username, not one repeated character', () => {
  assert.equal(checkPassword('fog on the ridge 2026'), null);
  assert.equal(checkPassword('correcthorsebatterystaple'), null);
  assert.match(checkPassword('short1'), /at least 10/);
  assert.match(checkPassword('x'.repeat(201)), /too long/);
  assert.match(checkPassword('qwertyuiop'), /most common/);
  assert.match(checkPassword('Basketball1'), /most common/);
  assert.match(checkPassword('1234567890'), /most common/);
  assert.match(checkPassword('aaaaaaaaaaaa'), /repeated/);
  assert.match(checkPassword('ridgerunner-pass', 'ridgerunner'), /username/);
  assert.match(checkPassword(undefined), /Enter/);
});

test('recovery codes: 25 characters from an unambiguous alphabet, shown in groups, read back forgivingly', () => {
  const c = makeRecoveryCode();
  assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}(-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}){4}$/);
  assert.notEqual(c, makeRecoveryCode());
  const canon = canonicalCode(c);
  assert.equal(normalizeRecoveryCode(c), canon);
  assert.equal(normalizeRecoveryCode(c.toLowerCase().replace(/-/g, ' ')), canon, 'lower case and spaces are fine');
  assert.equal(normalizeRecoveryCode(' ' + canon.match(/.{5}/g).join(' - ') + ' '), canon);
  assert.equal(normalizeRecoveryCode('too short'), null);
  assert.equal(normalizeRecoveryCode(canon + 'A'), null);
  assert.equal(normalizeRecoveryCode(canon.replace(/Q/g, '0')), canon, 'a 0 can only be a Q');
});

test('throttle: the first failures are free, then the wait doubles up to five minutes; success clears it', () => {
  let t = 1_000_000; const th = makeThrottle({ now: () => t });
  assert.equal(th.wait('k'), 0);
  th.fail('k'); th.fail('k'); assert.equal(th.wait('k'), 0, 'two free');
  th.fail('k'); assert.equal(th.wait('k'), 1);
  t += 1000; assert.equal(th.wait('k'), 0);
  th.fail('k'); assert.equal(th.wait('k'), 2); th.fail('k'); assert.equal(th.wait('k'), 4);
  for (let i = 0; i < 20; i++) th.fail('k'); assert.equal(th.wait('k'), 300, 'capped at five minutes');
  assert.equal(th.fails('k'), 25);
  th.clear('k'); assert.equal(th.wait('k'), 0); assert.equal(th.fails('k'), 0);
  assert.equal(th.wait('other'), 0, 'keys are independent');
});

test('proof of work: single use, expires in five minutes, wrong nonce refused, solvable', () => {
  let t = 5_000_000; const pow = makePow({ bits: 8, now: () => t });
  const c = pow.issue();
  assert.equal(c.bits, 8); assert.match(c.challenge, /^[0-9a-f]{32}$/); assert.equal(c.expires, t + 300_000);
  const nonce = pow.solve(c);
  assert.ok(leadingZeroBits(powHash(c.challenge, nonce)) >= 8);
  assert.deepEqual(pow.verify(c.id, 'definitely-wrong'), { ok: false, reason: 'wrong' });
  assert.deepEqual(pow.verify(c.id, nonce), { ok: false, reason: 'used' }, 'one attempt spends the challenge');
  const c2 = pow.issue(); assert.deepEqual(pow.verify(c2.id, pow.solve(c2)), { ok: true });
  assert.deepEqual(pow.verify(c2.id, pow.solve(c2)), { ok: false, reason: 'expired' }, 'gone after success');
  const c3 = pow.issue(); const n3 = pow.solve(c3); t += 301_000;
  assert.deepEqual(pow.verify(c3.id, n3), { ok: false, reason: 'expired' });
  assert.deepEqual(pow.verify('nope', 'x'), { ok: false, reason: 'expired' });
  assert.deepEqual(pow.verify({ toString: 1 }, 'x'), { ok: false, reason: 'expired' });
  const c4 = pow.issue(); assert.deepEqual(pow.verify(c4.id, 'has spaces in it'), { ok: false, reason: 'bad nonce' });
  assert.equal(leadingZeroBits(Buffer.from([0, 0, 0x0f])), 20); assert.equal(leadingZeroBits(Buffer.from([0x80])), 0);
  // a sixteen-bit challenge takes tens of thousands of hashes: a crude check that the difficulty is real
  const hard = makePow({ bits: 16 }); const ch = hard.issue(); const n = hard.solve(ch);
  assert.ok(leadingZeroBits(powHash(ch.challenge, n)) >= 16); assert.ok(crypto.createHash('sha256').update(`${ch.challenge}:${n}`).digest()[0] === 0);
});

test('gate: at most `max` jobs run at once, up to `queue` wait their turn, the rest are refused at once with a 429', async () => {
  const g = makeGate({ max: 2, queue: 3 });
  let running = 0; let peak = 0; const done = [];
  const job = (i) => g.run(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running--; done.push(i); return i; });
  const t0 = Date.now();
  const outcomes = await Promise.all(Array.from({ length: 7 }, (_, i) => job(i).then(() => 'ran', (e) => (e.status === 429 ? 'refused' : 'other'))));
  assert.deepEqual(outcomes, ['ran', 'ran', 'ran', 'ran', 'ran', 'refused', 'refused'], 'two run, three queue, the sixth and seventh are refused');
  assert.equal(peak, 2); assert.deepEqual(done, [0, 1, 2, 3, 4], 'in order');
  assert.ok(Date.now() - t0 >= 85 && Date.now() - t0 < 400, 'three rounds of two, not seven in a row');
  assert.equal(g.running, 0); assert.equal(g.waiting, 0);
  // a refused job is refused before anything runs, and a failing job frees its slot
  const quick = Date.now(); await assert.rejects(Promise.all(Array.from({ length: 6 }, () => g.run(() => new Promise((r) => setTimeout(r, 50))))), (e) => e.status === 429 && /Slow down/.test(e.message));
  assert.ok(Date.now() - quick < 40, 'the refusal does not wait for a slot');
  await new Promise((r) => setTimeout(r, 120));
  await assert.rejects(g.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await g.run(async () => 'free again'), 'free again');
});

test('scrypt runs through one gate: two at a time, twenty waiting, the rest refused with a 429 while the hashes still finish', async () => {
  assert.deepEqual([scryptGate.max, scryptGate.queue], [2, 20]);
  const stored = await hashSecret('correct horse battery');
  const outcomes = await Promise.all([
    ...Array.from({ length: 26 }, () => verifySecret('correct horse battery', stored).then((ok) => (ok ? 'ok' : 'wrong'), (e) => (e.status === 429 ? 'refused' : 'other'))),
    hashSecret('one more').then(() => 'ok', (e) => (e.status === 429 ? 'refused' : 'other')),
    dummyVerify('x').then(() => 'ok', (e) => (e.status === 429 ? 'refused' : 'other')),
  ]);
  assert.equal(outcomes.filter((o) => o === 'ok').length, 22, '2 running + 20 queued finish');
  assert.equal(outcomes.filter((o) => o === 'refused').length, 6, 'everything past the queue is refused');
  assert.ok(!outcomes.includes('wrong') && !outcomes.includes('other'));
});
