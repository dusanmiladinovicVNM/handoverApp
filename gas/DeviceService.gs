/**
 * DeviceService.gs
 * Remembered devices — this is what "stay signed in" is made of, and what the
 * admin screen's "sign this device out" acts on.
 *
 * This replaced the ADMIN_NONCES list that used to live in Script Properties:
 * same job — a revocation list checked on every request — but tied to a person,
 * with a name, a history and an expiry.
 *
 * Revoking a row here is the single mechanism behind three separate promises:
 * signing out one device, disabling an account, and ending every session when
 * a password changes.
 */

const DeviceService = (function () {

  /** Skip the lastSeenAt write unless the stored value is at least this old. */
  const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

  // --- Cache ---

  function _cache() {
    return CacheService.getScriptCache();
  }

  function _key(deviceId) {
    return `d:${deviceId}`;
  }

  function _invalidate(deviceId) {
    try {
      _cache().remove(_key(deviceId));
    } catch (e) {
      // Nothing to do — a stale entry expires on its own within the TTL.
    }
  }

  function getById(deviceId) {
    if (!deviceId) return null;
    try {
      const raw = _cache().get(_key(deviceId));
      if (raw) return JSON.parse(raw);
    } catch (e) {
      // fall through to the sheet
    }
    const device = SheetService.getDevice(deviceId);
    if (device) {
      try {
        _cache().put(_key(deviceId), JSON.stringify(device), Config.getAuthCacheTtlSeconds());
      } catch (e) {
        // cache failures are not request failures
      }
    }
    return device;
  }

  // --- Lifecycle ---

  /**
   * A device row is created for every sign-in, remembered or not — it is the
   * session record, and the thing revocation acts on. When the user did not ask
   * to be remembered, the row is given the session's own lifetime instead of the
   * full device lifetime, so a one-off sign-in does not sit in the admin screen
   * looking active for two months.
   */
  function register(userId, label, userAgent, ttlDays) {
    const days = (ttlDays === undefined || ttlDays === null)
      ? Config.getDeviceTtlDays()
      : ttlDays;
    const now = new Date();
    const expires = new Date(now.getTime() + days * 24 * 3600 * 1000);
    const device = {
      deviceId: Utils.generateDeviceId(),
      userId: userId,
      label: (label && String(label).trim()) || 'Unnamed device',
      nonce: Utils.generateNonce(),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      revokedAt: '',
      revokedBy: '',
      userAgent: String(userAgent || '').substring(0, 500),
    };
    SheetService.createDevice(device);
    _invalidate(device.deviceId);
    return device;
  }

  /**
   * Whether a device may still carry a session, and why not if it may not.
   * Returns { ok, reason }.
   */
  function checkUsable(device, nonce) {
    if (!device) return { ok: false, reason: 'unknown_device' };
    if (device.revokedAt) return { ok: false, reason: 'revoked' };
    if (!Utils.safeEqual(String(device.nonce), String(nonce))) {
      return { ok: false, reason: 'nonce_mismatch' };
    }
    if (_toIso(device.expiresAt) <= Utils.nowIso()) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, reason: '' };
  }

  /**
   * Record that a device is still in use.
   *
   * Called when a session is issued or refreshed — never while resolving one.
   *
   * It used to run on the request path, throttled to once an hour, on the
   * reasoning that a write every sixty minutes was cheap. The measurement said
   * otherwise: the request that happened to carry the write took 9.3 s in auth
   * against 1.0 s of actual work, and those were the ten-second outliers that
   * had been appearing all along. A Sheets write costs far more than a read,
   * and a request that only reads should not be the one paying for it.
   *
   * The cost of moving it: lastSeenAt is now accurate to the session lifetime
   * rather than to the hour. For a column read by a human deciding whether a
   * device is still in use, "yesterday" versus "yesterday afternoon" changes
   * nothing.
   */
  function touch(device) {
    if (!device) return;
    const last = Date.parse(_toIso(device.lastSeenAt)) || 0;
    if (Date.now() - last < TOUCH_INTERVAL_MS) return;
    try {
      SheetService.updateDevice(device.deviceId, { lastSeenAt: Utils.nowIso() });
      _invalidate(device.deviceId);
    } catch (e) {
      Utils.log('WARN', 'lastSeenAt update failed', { deviceId: device.deviceId });
    }
  }

  function revoke(deviceId, revokedBy) {
    const device = SheetService.getDevice(deviceId);
    if (!device) throw new HandoverError('NOT_FOUND', `Device ${deviceId} not found.`);
    if (device.revokedAt) return device;
    const updated = SheetService.updateDevice(deviceId, {
      revokedAt: Utils.nowIso(),
      revokedBy: revokedBy || 'system',
    });
    _invalidate(deviceId);
    return updated;
  }

  function revokeAllForUser(userId, revokedBy) {
    const revoked = SheetService.revokeDevicesForUser(userId, revokedBy);
    revoked.forEach(_invalidate);
    return revoked;
  }

  function listForUser(userId, includeRevoked) {
    return SheetService.getDevicesForUser(userId, includeRevoked).map(d => ({
      deviceId: d.deviceId,
      label: d.label,
      createdAt: _toIso(d.createdAt),
      lastSeenAt: _toIso(d.lastSeenAt),
      expiresAt: _toIso(d.expiresAt),
      revokedAt: _toIso(d.revokedAt || ''),
      userAgent: d.userAgent || '',
    }));
  }

  function _toIso(value) {
    if (value instanceof Date) return value.toISOString();
    return String(value || '');
  }

  return {
    getById,
    register,
    checkUsable,
    touch,
    revoke,
    revokeAllForUser,
    listForUser,
  };
})();
