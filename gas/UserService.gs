/**
 * UserService.gs
 * Data access for user accounts.
 *
 * This is the store, not the flows — login, password reset and session issuing
 * live in AccountService. Kept apart so that the rule below has exactly one
 * home.
 *
 * THE RULE: a user's role and status are read from this sheet on every request,
 * never from the token. A token carries identity (uid), never authority. That
 * is what makes "revoke admin rights" and "disable account" take effect while
 * the person is signed in, instead of whenever their token happens to expire.
 *
 * Every read goes through a short-lived cache, because it sits on the hot path
 * of every API call. Every write clears it.
 */

const UserService = (function () {

  const ROLES = ['admin', 'inspector'];
  const STATUSES = ['active', 'disabled'];

  // --- Cache ---

  function _cache() {
    return CacheService.getScriptCache();
  }

  function _idKey(userId) {
    return `u:${userId}`;
  }

  function _emailKey(email) {
    return `ue:${String(email).trim().toLowerCase()}`;
  }

  function _invalidate(user) {
    if (!user) return;
    const keys = [];
    if (user.userId) keys.push(_idKey(user.userId));
    if (user.email) keys.push(_emailKey(user.email));
    if (keys.length) _cache().removeAll(keys);
  }

  function _cacheGet(key) {
    try {
      const raw = _cache().get(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function _cachePut(key, user) {
    try {
      _cache().put(key, JSON.stringify(user), Config.getAuthCacheTtlSeconds());
    } catch (e) {
      // A cache miss is only slower, never wrong. Never fail the request.
    }
  }

  // --- Reads ---

  function getById(userId) {
    if (!userId) return null;
    const key = _idKey(userId);
    const cached = _cacheGet(key);
    if (cached) return cached;

    const user = SheetService.getUser(userId);
    if (user) _cachePut(key, user);
    return user;
  }

  function getByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const key = _emailKey(normalized);
    const cached = _cacheGet(key);
    if (cached) return cached;

    const user = SheetService.getUserByEmail(normalized);
    if (user) _cachePut(key, user);
    return user;
  }

  function listAll() {
    return SheetService.listUsers();
  }

  function countActiveAdmins() {
    return listAll().filter(u => u.role === 'admin' && u.status === 'active').length;
  }

  // --- Writes ---

  function create(fields) {
    const email = normalizeEmail(fields.email);
    if (!email || email.indexOf('@') < 1) {
      throw new HandoverError('VALIDATION_FAILED', 'A valid email address is required.');
    }
    if (!fields.name || !String(fields.name).trim()) {
      throw new HandoverError('VALIDATION_FAILED', 'Name is required.');
    }
    assertValidRole(fields.role);
    if (SheetService.getUserByEmail(email)) {
      throw new HandoverError('VALIDATION_FAILED', `A user with ${email} already exists.`);
    }

    const user = {
      userId: Utils.generateUserId(),
      email: email,
      name: String(fields.name).trim(),
      role: fields.role,
      status: 'active',
      passHash: '',
      passSetAt: '',
      failedCount: 0,
      lockedUntil: '',
      createdAt: Utils.nowIso(),
      createdBy: fields.createdBy || 'system',
      disabledAt: '',
      disabledBy: '',
      lastLoginAt: '',
      notes: fields.notes || '',
    };
    SheetService.createUser(user);
    _invalidate(user);
    return user;
  }

  function update(userId, updates) {
    const updated = SheetService.updateUser(userId, updates);
    _invalidate(updated);
    return updated;
  }

  // --- Lockout ---

  function isLocked(user) {
    if (!user || !user.lockedUntil) return false;
    return _toIso(user.lockedUntil) > Utils.nowIso();
  }

  function lockedUntilIso(user) {
    return user && user.lockedUntil ? _toIso(user.lockedUntil) : '';
  }

  /**
   * Count one failed attempt, locking the account once the limit is reached.
   * Returns the updated user.
   */
  function registerFailedLogin(user) {
    const failures = Number(user.failedCount || 0) + 1;
    const patch = { failedCount: failures };

    if (failures >= Config.getLoginMaxFailures()) {
      const until = new Date(Date.now() + Config.getLoginLockMinutes() * 60 * 1000);
      patch.lockedUntil = until.toISOString();
      patch.failedCount = 0;
    }
    return update(user.userId, patch);
  }

  function clearFailedLogin(user) {
    if (!Number(user.failedCount || 0) && !user.lockedUntil) return user;
    return update(user.userId, { failedCount: 0, lockedUntil: '' });
  }

  // --- Helpers ---

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function assertValidRole(role) {
    if (ROLES.indexOf(role) < 0) {
      throw new HandoverError(
        'VALIDATION_FAILED', `Role must be one of: ${ROLES.join(', ')}.`);
    }
  }

  function assertValidStatus(status) {
    if (STATUSES.indexOf(status) < 0) {
      throw new HandoverError(
        'VALIDATION_FAILED', `Status must be one of: ${STATUSES.join(', ')}.`);
    }
  }

  /** Sheets hands back Date objects for ISO-looking cells; normalise to string. */
  function _toIso(value) {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  /** Projection safe to send to the client — never includes passHash. */
  function toPublic(user) {
    if (!user) return null;
    return {
      userId: user.userId,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      hasPassword: PasswordService.hasPassword(user),
      lastLoginAt: _toIso(user.lastLoginAt || ''),
      lockedUntil: isLocked(user) ? lockedUntilIso(user) : '',
      createdAt: _toIso(user.createdAt || ''),
      createdBy: user.createdBy || '',
      disabledAt: _toIso(user.disabledAt || ''),
      disabledBy: user.disabledBy || '',
      notes: user.notes || '',
    };
  }

  return {
    ROLES,
    STATUSES,
    getById,
    getByEmail,
    listAll,
    countActiveAdmins,
    create,
    update,
    isLocked,
    lockedUntilIso,
    registerFailedLogin,
    clearFailedLogin,
    normalizeEmail,
    assertValidRole,
    assertValidStatus,
    toPublic,
  };
})();
