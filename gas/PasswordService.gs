/**
 * PasswordService.gs
 * Password hashing and policy.
 *
 * Apps Script offers no bcrypt, scrypt, Argon2 or built-in PBKDF2 — only a
 * single-pass SHA-256 and an HMAC primitive. A single pass of SHA-256 is
 * checked at billions of guesses per second on commodity hardware, so PBKDF2
 * is built here on top of computeHmacSha256Signature.
 *
 * The honest limit: every iteration crosses the JavaScript/native boundary,
 * which caps the achievable work factor far below what bcrypt or Argon2 reach.
 * This is roughly a thousand times more expensive than one SHA-256 pass, and
 * that is a real improvement, but it is not equivalent protection. The security
 * of this scheme rests on password *length* — hence the 12 character minimum
 * in validatePolicy, and the account lockout in AccountService. Both are load
 * bearing, not decoration.
 *
 * Stored format, one self-describing field:
 *
 *     pbkdf2-sha256$<iterations>$<saltBase64>$<hashBase64>
 *
 * The iteration count travels with each hash so it can be raised later without
 * invalidating existing passwords — see _needsRehash and AccountService.login.
 */

const PasswordService = (function () {

  const ALGORITHM = 'pbkdf2-sha256';
  const SALT_BYTES = 16;
  const MAX_LENGTH = 200;

  /**
   * Rejected outright regardless of length. A starter list of shapes people
   * actually pick; extend it as you see what turns up in your own deployment.
   */
  const COMMON_PASSWORDS = [
    'password', 'password1', 'password12', 'password123', 'password1234',
    'passwort', 'passwort123', 'lozinka', 'lozinka123', 'sifra123',
    '123456789012', '1234567890', '123456789', '111111111111', '000000000000',
    'qwertyuiop', 'qwertzuiop', 'qwerty123456', 'asdfghjkl', 'zxcvbnm',
    'iloveyou123', 'letmein12345', 'welcome12345', 'admin1234567',
    'administrator', 'handover123', 'handoverapp', 'inspection123',
    'abcdefghijkl', 'aaaaaaaaaaaa', 'mojalozinka', 'dobrodosli123',
  ];

  // --- Key derivation ---

  /**
   * PBKDF2-HMAC-SHA256 with dkLen = 32, i.e. exactly one output block, so the
   * INT(i) suffix appended to the salt is always 1.
   */
  function _pbkdf2Sha256(password, saltBytes, iterations) {
    const keyBytes = Utilities.newBlob(password).getBytes();
    const block = Utils.toByteArray(saltBytes).concat([0, 0, 0, 1]);

    let u = Utils.toByteArray(Utilities.computeHmacSha256Signature(block, keyBytes));
    const out = u.slice();

    for (let i = 1; i < iterations; i++) {
      u = Utils.toByteArray(Utilities.computeHmacSha256Signature(u, keyBytes));
      for (let j = 0; j < out.length; j++) {
        out[j] ^= u[j];
      }
    }
    return out;
  }

  // --- Public operations ---

  /** Hash a password at the currently configured work factor. */
  function hashPassword(password) {
    const iterations = Config.getPbkdf2Iterations();
    const salt = Utils.secureRandomBytes(SALT_BYTES);
    const digest = _pbkdf2Sha256(password, salt, iterations);
    return [
      ALGORITHM,
      iterations,
      Utilities.base64Encode(salt),
      Utilities.base64Encode(digest),
    ].join('$');
  }

  /**
   * Check a candidate password against a stored hash.
   * Returns { ok, needsRehash }. needsRehash is true when the stored hash used
   * a lower work factor than is configured now — the caller should re-hash
   * while the plaintext is still in hand.
   */
  function verifyPassword(password, stored) {
    const miss = { ok: false, needsRehash: false };
    if (typeof password !== 'string' || typeof stored !== 'string') return miss;

    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== ALGORITHM) return miss;

    const iterations = parseInt(parts[1], 10);
    if (!iterations || iterations < 1) return miss;

    let salt, expected;
    try {
      salt = Utils.toByteArray(Utilities.base64Decode(parts[2]));
      expected = Utils.toByteArray(Utilities.base64Decode(parts[3]));
    } catch (e) {
      return miss;
    }

    const actual = _pbkdf2Sha256(password, salt, iterations);
    const ok = Utils.safeEqualBytes(actual, expected);
    return { ok: ok, needsRehash: ok && iterations < Config.getPbkdf2Iterations() };
  }

  function hasPassword(user) {
    return !!(user && user.passHash && String(user.passHash).indexOf('$') > 0);
  }

  /**
   * Enforce the password policy. Throws VALIDATION_FAILED with a message meant
   * to be shown to the user.
   *
   * No composition rules on purpose. Demanding an uppercase letter, a digit and
   * a symbol reliably produces 'Lozinka1!' — it lowers real strength while
   * feeling stricter. Length is what carries this scheme.
   */
  function validatePolicy(password) {
    const minLength = Config.getPasswordMinLength();

    if (typeof password !== 'string' || !password.trim()) {
      throw new HandoverError('VALIDATION_FAILED', 'Password cannot be empty.');
    }
    if (password.length < minLength) {
      throw new HandoverError(
        'VALIDATION_FAILED',
        `Password must be at least ${minLength} characters. A phrase of four ` +
        'unrelated words is both easier to remember and far harder to guess.'
      );
    }
    if (password.length > MAX_LENGTH) {
      throw new HandoverError(
        'VALIDATION_FAILED', `Password must be at most ${MAX_LENGTH} characters.`);
    }

    const normalized = password.toLowerCase().replace(/\s+/g, '');
    if (COMMON_PASSWORDS.indexOf(normalized) >= 0) {
      throw new HandoverError(
        'VALIDATION_FAILED', 'That password is too common. Please choose another.');
    }
    if (/^(.)\1+$/.test(password)) {
      throw new HandoverError(
        'VALIDATION_FAILED', 'A password cannot be a single repeated character.');
    }
  }

  return {
    hashPassword,
    verifyPassword,
    hasPassword,
    validatePolicy,
    // Exposed for benchmarkPbkdf2() in BootstrapService.
    _pbkdf2Sha256,
  };
})();
