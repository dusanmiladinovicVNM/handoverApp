/**
 * password.test.js
 * Checks the hand-rolled PBKDF2 against Node's own implementation, plus the
 * stored-hash format, the upgrade path and the policy.
 *
 * The comparison against crypto.pbkdf2Sync is the important one. A key
 * derivation written by hand can look plausible and still be wrong in a way
 * nothing else would reveal — a wrong-but-consistent function still lets people
 * sign in, so every other test would pass while the stored hashes were far
 * weaker than intended.
 */

const crypto = require('crypto');
const { createEnvironment, section, check, assert } = require('./appsscript-stubs');

module.exports = function run() {
  const env = createEnvironment();
  const { PasswordService, Utils, HandoverError } = env;

  const toBuf = (bytes) =>
    Buffer.from(Array.from(bytes).map(b => (b < 0 ? b + 256 : b)));

  section('PBKDF2 matches Node crypto.pbkdf2Sync:');

  [
    [1, 'aaaaaaaaaaaa'],
    [2, 'p'],
    [1000, 'correct horse battery staple'],
    [3333, 'Ω unicode ćčšđž passphrase'],
  ].forEach(([iterations, password]) => {
    check(`${iterations} iteration(s), ${password.length}-character password`, () => {
      const salt = [1, -2, 3, -4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -16];
      const mine = toBuf(PasswordService._pbkdf2Sha256(password, salt, iterations));
      const theirs = crypto.pbkdf2Sync(
        Buffer.from(password, 'utf8'), toBuf(salt), iterations, 32, 'sha256');
      assert(mine.equals(theirs),
        `got  ${mine.toString('hex')}\n        want ${theirs.toString('hex')}`);
    });
  });

  section('Stored hash:');

  check('the correct password verifies', () => {
    const stored = PasswordService.hashPassword('a decent length passphrase');
    assert(PasswordService.verifyPassword('a decent length passphrase', stored).ok,
      'correct password was rejected');
  });

  check('a near-miss password does not', () => {
    const stored = PasswordService.hashPassword('a decent length passphrase');
    assert(!PasswordService.verifyPassword('a decent length passphrasE', stored).ok,
      'wrong password was accepted');
  });

  check('the format carries algorithm and work factor', () => {
    const parts = PasswordService.hashPassword('a decent length passphrase').split('$');
    assert(parts.length === 4, `expected 4 fields, got ${parts.length}`);
    assert(parts[0] === 'pbkdf2-sha256', `algorithm field reads ${parts[0]}`);
    assert(parseInt(parts[1], 10) === env.config.pbkdf2Iterations,
      `iteration field reads ${parts[1]}`);
  });

  check('the same password hashes differently every time', () => {
    const a = PasswordService.hashPassword('a decent length passphrase');
    const b = PasswordService.hashPassword('a decent length passphrase');
    assert(a !== b, 'two hashes came out identical — the salt is not random');
  });

  check('a malformed stored value is rejected rather than thrown on', () => {
    ['', 'x', 'pbkdf2-sha256$$$', 'sha1$1$a$b', 'pbkdf2-sha256$0$YQ==$Yg==',
     'pbkdf2-sha256$100$not-base64!$Yg=='].forEach(bad => {
      assert(PasswordService.verifyPassword('whatever', bad).ok === false,
        `accepted stored value ${JSON.stringify(bad)}`);
    });
  });

  section('Raising the work factor:');

  check('an old hash still verifies and is flagged for rehash', () => {
    const stored = PasswordService.hashPassword('a decent length passphrase');
    env.config.pbkdf2Iterations = 400;
    const result = PasswordService.verifyPassword('a decent length passphrase', stored);
    assert(result.ok, 'the old hash stopped verifying when the setting changed');
    assert(result.needsRehash, 'needsRehash was not set');
    env.config.pbkdf2Iterations = 100;
  });

  check('a current hash is not flagged', () => {
    const stored = PasswordService.hashPassword('a decent length passphrase');
    assert(PasswordService.verifyPassword('a decent length passphrase', stored)
      .needsRehash === false, 'flagged a hash that is already current');
  });

  section('Policy:');

  const rejects = (password, note) => {
    let threw = false;
    try {
      PasswordService.validatePolicy(password);
    } catch (e) {
      threw = e instanceof HandoverError;
    }
    assert(threw, note);
  };

  check('too short is rejected', () => rejects('short one', 'accepted 9 characters'));
  check('empty is rejected', () => rejects('   ', 'accepted whitespace only'));
  check('a single repeated character is rejected', () =>
    rejects('bbbbbbbbbbbbbbbbbb', 'accepted a repeated character'));

  // The length rule already rejects every common password, since they are all
  // shorter than the minimum. What it does not catch is how people satisfy it.
  check('a common word padded with digits is rejected', () =>
    rejects('password12345678', 'accepted a padded common word'));
  check('a common word padded at the front is rejected', () =>
    rejects('12345678password', 'accepted a front-padded common word'));
  check('a common word repeated to length is rejected', () =>
    rejects('lozinkalozinka12', 'accepted a repeated common word'));
  check('padding with punctuation does not slip through', () =>
    rejects('p-a-s-s-w-o-r-d-1234', 'accepted a common word split by punctuation'));

  check('a four-word passphrase is accepted', () =>
    PasswordService.validatePolicy('kisa pada trava raste'));
  check('a long phrase containing a common word is still accepted', () =>
    PasswordService.validatePolicy('moja lozinka za oblak i kisu'));

  section('Constant-time comparison:');

  check('matches equal arrays and separates unequal ones', () => {
    assert(Utils.safeEqualBytes([1, -2, 3], [1, -2, 3]), 'equal arrays did not match');
    assert(!Utils.safeEqualBytes([1, -2, 3], [1, -2, 4]), 'differing arrays matched');
    assert(!Utils.safeEqualBytes([1, 2], [1, 2, 3]), 'different lengths matched');
    assert(!Utils.safeEqualBytes(null, [1]), 'null matched');
  });
};
