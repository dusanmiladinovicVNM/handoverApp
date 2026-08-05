/**
 * PasswordService.gs
 * Password hashing and policy.
 *
 * Apps Script offers no bcrypt, scrypt, Argon2 or built-in PBKDF2 — only a
 * single-pass SHA-256 and an HMAC primitive. A single pass of SHA-256 is
 * checked at billions of guesses per second on commodity hardware, so PBKDF2
 * is built here on top of computeHmacSha256Signature.
 *
 * The honest limit, now measured rather than estimated: one iteration costs
 * about 2.5 ms on this platform, and almost all of that is the cost of crossing
 * from JavaScript into the host — a cost an attacker running native code does
 * not pay. So a couple of seconds of our time buys a couple of thousand
 * iterations, while buying the attacker very little. The reachable work factor
 * is nowhere near bcrypt or Argon2, and no amount of tuning here will change
 * that.
 *
 * What follows from it: the security of this scheme rests on password *length*,
 * not on this function. Hence the 16 character minimum in validatePolicy, which
 * is long enough that people write a phrase rather than a word, and the account
 * lockout in AccountService. Both are load bearing, not decoration.
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
   * Bases people reach for, checked after padding is stripped.
   *
   * A plain list of common passwords would be dead weight here: every entry on
   * such a list is shorter than the 16 character minimum, so length alone
   * already rejects them. What a length rule does NOT catch is the way people
   * satisfy it — by padding something short. 'password' becomes
   * 'password12345678', 'lozinka' becomes 'lozinkalozinka12'. Those clear the
   * length check while carrying almost no more entropy than the word they grew
   * from, so the base is what gets matched.
   */
  const COMMON_BASES = [
    'password', 'passwort', 'lozinka', 'sifra', 'parola',
    'qwerty', 'qwertyuiop', 'qwertzuiop', 'asdfghjkl', 'zxcvbnm',
    'iloveyou', 'letmein', 'welcome', 'dobrodosli', 'zdravo',
    'admin', 'administrator', 'root', 'test', 'demo',
    'handover', 'handoverapp', 'inspection', 'inspekcija', 'primopredaja',
    'abcdefgh', 'abcdefghijkl', 'mojalozinka', 'novalozinka',
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
        `Password must be at least ${minLength} characters. Use a phrase of ` +
        'four unrelated words — easier to remember than a short password, and ' +
        'far harder to guess.'
      );
    }
    if (password.length > MAX_LENGTH) {
      throw new HandoverError(
        'VALIDATION_FAILED', `Password must be at most ${MAX_LENGTH} characters.`);
    }

    if (_isPadding(password)) {
      throw new HandoverError(
        'VALIDATION_FAILED',
        'That is a common password with padding added. Length alone does not ' +
        'make it hard to guess — use four unrelated words instead.'
      );
    }
    if (/^(.)\1+$/.test(password)) {
      throw new HandoverError(
        'VALIDATION_FAILED', 'A password cannot be a single repeated character.');
    }
  }

  /**
   * True when the password is a common base dressed up to clear the length
   * rule — repeated, or with digits and symbols hung off either end.
   */
  function _isPadding(password) {
    const normalized = password.toLowerCase().replace(/[^a-z0-9šđčćž]/g, '');
    const letters = normalized.replace(/^[0-9]+|[0-9]+$/g, '');

    if (COMMON_BASES.indexOf(normalized) >= 0) return true;
    if (COMMON_BASES.indexOf(letters) >= 0) return true;

    const unit = _repeatedUnit(letters);
    return !!unit && COMMON_BASES.indexOf(unit) >= 0;
  }

  /** The shortest string that, repeated, makes up the whole input. */
  function _repeatedUnit(value) {
    for (let size = 1; size <= value.length / 2; size++) {
      if (value.length % size !== 0) continue;
      const candidate = value.substring(0, size);
      if (candidate.repeat(value.length / size) === value) return candidate;
    }
    return '';
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
