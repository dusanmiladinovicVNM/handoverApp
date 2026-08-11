/**
 * AccountService.gs
 * Sign-in flows: login, password setting and reset, session refresh, sign-out.
 *
 * UserService is the store; this is what happens to it. The two are kept apart
 * because the store sits on the hot path of every request while these run once
 * per session.
 *
 * Four of these actions run before any authentication exists, so they are
 * listed in PUBLIC_ACTIONS in Code.gs. That list is the only place where the
 * "every request is authenticated" rule is broken, which is why the checks
 * below are written out rather than delegated.
 */

const AccountService = (function () {

  /**
   * One message for every way a sign-in can fail. An unknown address, a
   * disabled account and a wrong password must be indistinguishable, or the
   * login form becomes a way to enumerate who works here.
   */
  const GENERIC_LOGIN_ERROR = 'Incorrect email address or password.';

  // ============================================================
  // Login
  // ============================================================

  /**
   * Unknown accounts skip password verification, which would make them answer
   * measurably faster than real ones and give the enumeration away by timing.
   * Spending the same work against a throwaway hash removes that difference.
   */
  let _timingHash = null;

  function _burnPasswordTime(password) {
    try {
      if (!_timingHash) {
        _timingHash = PasswordService.hashPassword('timing-equalizer-not-a-credential');
      }
      PasswordService.verifyPassword(String(password || ''), _timingHash);
    } catch (e) {
      // Never let the equalizer itself fail a request.
    }
  }

  function login(authCtx, data) {
    const email = UserService.normalizeEmail(Utils.requireField(data, 'email', 'string'));
    const password = Utils.requireField(data, 'password', 'string');

    const user = UserService.getByEmail(email);

    if (!user || user.status !== 'active' || !PasswordService.hasPassword(user)) {
      _burnPasswordTime(password);
      AuditService.logAuth(`login:${email}`, 'login_failed', {
        reason: !user ? 'unknown_email'
          : (user.status !== 'active' ? 'disabled' : 'no_password_set'),
      });
      throw new HandoverError('UNAUTHORIZED', GENERIC_LOGIN_ERROR);
    }

    // A locked account still has its password checked, and only someone who
    // gets it right is told about the lock. Announcing the lock to anyone who
    // asks would turn lockout itself into an account-enumeration oracle.
    if (UserService.isLocked(user)) {
      const knewPassword = PasswordService.verifyPassword(password, user.passHash).ok;
      AuditService.logAuth(`user:${user.email}`, 'login_failed', { reason: 'locked' });
      throw new HandoverError(
        'UNAUTHORIZED',
        knewPassword
          ? `Too many failed attempts. Please try again in ${_minutesUntilUnlock(user)} minutes.`
          : GENERIC_LOGIN_ERROR
      );
    }

    const check = PasswordService.verifyPassword(password, user.passHash);
    if (!check.ok) {
      const after = UserService.registerFailedLogin(user);
      AuditService.logAuth(`user:${user.email}`, 'login_failed', { reason: 'bad_password' });

      if (UserService.isLocked(after)) {
        AuditService.logAuth(`user:${user.email}`, 'account_locked', {
          minutes: Config.getLoginLockMinutes(),
        });
        throw new HandoverError(
          'UNAUTHORIZED',
          `Too many failed attempts. Please try again in ${Config.getLoginLockMinutes()} minutes.`
        );
      }
      throw new HandoverError('UNAUTHORIZED', GENERIC_LOGIN_ERROR);
    }

    const patch = {
      failedCount: 0,
      lockedUntil: '',
      lastLoginAt: Utils.nowIso(),
    };
    // The work factor may have been raised since this password was stored.
    // Now is the only moment the plaintext is available to re-derive it.
    if (check.needsRehash) {
      patch.passHash = PasswordService.hashPassword(password);
    }
    const updated = UserService.update(user.userId, patch);

    return _issueSession(updated, data);
  }

  // ============================================================
  // Setting and changing passwords
  // ============================================================

  /**
   * Consume a mailed link and set the password on it. Used both for a brand new
   * account and for a reset — the link is the same object in both cases.
   */
  function setPassword(authCtx, data) {
    const token = Utils.requireField(data, 'token', 'string');
    const password = Utils.requireField(data, 'password', 'string');

    const user = AuthService.verifySetPasswordToken(token);
    if (!user) {
      throw new HandoverError(
        'UNAUTHORIZED',
        'This link is no longer valid. It may have expired or already been used. ' +
        'Please request a new one.'
      );
    }

    PasswordService.validatePolicy(password);
    const isFirstPassword = !PasswordService.hasPassword(user);

    const updated = UserService.update(user.userId, {
      passHash: PasswordService.hashPassword(password),
      passSetAt: Utils.nowIso(),
      failedCount: 0,
      lockedUntil: '',
      lastLoginAt: Utils.nowIso(),
    });

    // Revoked before the new session is issued, so the sign-in that follows
    // survives while every older one ends.
    const revoked = DeviceService.revokeAllForUser(user.userId, `user:${user.email}`);

    AuditService.logAuth(
      `user:${user.email}`,
      isFirstPassword ? 'password_set' : 'password_reset',
      { devicesRevoked: revoked.length }
    );

    return _issueSession(updated, data);
  }

  /** Change from inside a session, knowing the current password. */
  function changePassword(authCtx, data) {
    if (!authCtx || !authCtx.userId) {
      throw new HandoverError(
        'FORBIDDEN', 'Only a signed-in account holder can change a password.');
    }
    const oldPassword = Utils.requireField(data, 'oldPassword', 'string');
    const newPassword = Utils.requireField(data, 'newPassword', 'string');

    const user = UserService.getById(authCtx.userId);
    if (!user || !PasswordService.hasPassword(user)) {
      throw new HandoverError('UNAUTHORIZED', 'This session is no longer valid.');
    }
    if (!PasswordService.verifyPassword(oldPassword, user.passHash).ok) {
      AuditService.logAuth(`user:${user.email}`, 'login_failed', { reason: 'bad_old_password' });
      throw new HandoverError('UNAUTHORIZED', 'The current password is incorrect.');
    }
    if (oldPassword === newPassword) {
      throw new HandoverError(
        'VALIDATION_FAILED', 'The new password must differ from the current one.');
    }
    PasswordService.validatePolicy(newPassword);

    UserService.update(user.userId, {
      passHash: PasswordService.hashPassword(newPassword),
      passSetAt: Utils.nowIso(),
      failedCount: 0,
      lockedUntil: '',
    });

    const revoked = DeviceService.revokeAllForUser(user.userId, `user:${user.email}`);
    AuditService.logAuth(`user:${user.email}`, 'password_changed', {
      devicesRevoked: revoked.length,
    });

    // Every device is signed out, including this one. A lost or borrowed device
    // logs itself out the moment the owner changes their password.
    return { signedOut: true, devicesRevoked: revoked.length };
  }

  /**
   * Send a set-password link. Answers identically whether or not the address
   * belongs to an account.
   */
  function requestPasswordReset(authCtx, data) {
    const email = UserService.normalizeEmail(Utils.requireField(data, 'email', 'string'));
    _throttle(`pwreset:${Utils.sha256(email)}`, 5, 60);

    const user = UserService.getByEmail(email);
    if (user && user.status === 'active') {
      try {
        const token = AuthService.generateSetPasswordToken(user);
        MailService.sendSetPasswordLink(user, token, PasswordService.hasPassword(user));
        AuditService.logAuth(`user:${user.email}`, 'password_reset_sent', { source: 'self' });
      } catch (e) {
        // A delivery failure must not turn into a different answer, or the
        // response starts revealing which addresses exist.
        Utils.log('ERROR', 'Password reset mail failed', { email: email, error: e.message });
      }
    } else {
      AuditService.logAuth(`login:${email}`, 'password_reset_sent', { source: 'self', found: false });
    }

    return {
      sent: true,
      message: 'If that address belongs to an account, a link is on its way.',
    };
  }

  // ============================================================
  // Sessions
  // ============================================================

  /** Exchange a remembered-device token for a fresh session. */
  function refreshSession(authCtx, data) {
    const deviceToken = Utils.requireField(data, 'deviceToken', 'string');

    const resolved = AuthService.verifyDeviceToken(deviceToken);
    if (!resolved) {
      throw new HandoverError('UNAUTHORIZED', 'Please sign in again.');
    }
    DeviceService.touch(resolved.device);

    return {
      sessionToken: AuthService.generateSessionToken(
        resolved.user.userId, resolved.device.deviceId, resolved.device.nonce),
      user: UserService.toPublic(resolved.user),
      expiresInHours: Config.getSessionTtlHours(),
    };
  }

  /**
   * The signed-in account. Every context that reaches here now has a user
   * behind it, so a caller without one — a tenant link, for instance — is
   * asking a question that has no answer rather than one worth inventing.
   */
  function me(authCtx) {
    if (!authCtx || !authCtx.userId) {
      throw new HandoverError('FORBIDDEN', 'This token does not belong to an account.');
    }
    return { user: UserService.toPublic(UserService.getById(authCtx.userId)) };
  }

  function signOut(authCtx) {
    if (!authCtx || !authCtx.deviceId) return { signedOut: true };
    DeviceService.revoke(authCtx.deviceId, authCtx.actorString);
    AuditService.logAuth(authCtx.actorString, 'device_revoked', {
      deviceId: authCtx.deviceId, reason: 'sign_out',
    });
    return { signedOut: true };
  }

  // ============================================================
  // Internals
  // ============================================================

  function _issueSession(user, data) {
    const remember = data.remember === true;
    const device = DeviceService.register(
      user.userId,
      data.deviceLabel,
      data.userAgent,
      remember ? undefined : Config.getSessionTtlHours() / 24
    );

    const result = {
      sessionToken: AuthService.generateSessionToken(
        user.userId, device.deviceId, device.nonce),
      user: UserService.toPublic(user),
      expiresInHours: Config.getSessionTtlHours(),
    };
    if (remember) {
      result.deviceToken = AuthService.generateDeviceToken(
        user.userId, device.deviceId, device.nonce);
      result.deviceExpiresInDays = Config.getDeviceTtlDays();
    }

    // One event, not two. A device row is created for every sign-in, so
    // 'device_registered' fired on exactly the same occasions as
    // 'login_succeeded' and carried nothing the other could not — two appends
    // to the same sheet, in the request someone is watching a spinner for, to
    // record one thing that happened once.
    AuditService.logAuth(`user:${user.email}`, 'login_succeeded', {
      deviceId: device.deviceId,
      deviceLabel: device.label,
      remembered: remember,
    });

    return result;
  }

  function _minutesUntilUnlock(user) {
    const until = Date.parse(UserService.lockedUntilIso(user));
    if (!until) return Config.getLoginLockMinutes();
    return Math.max(1, Math.ceil((until - Date.now()) / 60000));
  }

  /**
   * Cheap per-key throttle in CacheService.
   *
   * Apps Script gives no reliable caller IP, so the email address is the only
   * key available — which means this slows abuse of one address, not a spray
   * across many. The hourly window starts at the first request rather than
   * sliding, which is coarse but adequate here.
   */
  function _throttle(key, maxPerHour, minIntervalSeconds) {
    const cache = CacheService.getScriptCache();
    const recentKey = `thr:${key}`;
    const countKey = `thc:${key}`;

    try {
      if (cache.get(recentKey)) {
        throw new HandoverError(
          'RATE_LIMITED', 'Please wait a moment before requesting another link.');
      }
      const count = parseInt(cache.get(countKey) || '0', 10);
      if (count >= maxPerHour) {
        throw new HandoverError(
          'RATE_LIMITED', 'Too many requests for this address. Please try again later.');
      }
      cache.put(recentKey, '1', minIntervalSeconds);
      cache.put(countKey, String(count + 1), 3600);
    } catch (e) {
      if (e instanceof HandoverError) throw e;
      // Cache trouble must not become a lockout.
      Utils.log('WARN', 'Throttle check skipped', { error: e.message });
    }
  }

  return {
    login,
    setPassword,
    changePassword,
    requestPasswordReset,
    refreshSession,
    me,
    signOut,
  };
})();
