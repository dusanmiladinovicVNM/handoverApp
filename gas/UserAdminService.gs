/**
 * UserAdminService.gs
 * The actions behind the account administration screen.
 *
 * Every one of them calls requireAdmin first. The screen hides the buttons a
 * non-admin should not see, but that is presentation, not protection — the
 * client can send whatever it likes, so the check that matters is here.
 *
 * The guardrails in _assertNotSelf and _assertNotLastAdmin exist so that a
 * single mis-click cannot lock the company out of its own system. They are
 * cheap and they are the difference between an awkward afternoon and a call to
 * whoever still has access to the Apps Script editor.
 */

const UserAdminService = (function () {

  // ============================================================
  // Reads
  // ============================================================

  function listUsers(authCtx, data) {
    AuthService.requireAdmin(authCtx);

    // One pass over devices rather than a lookup per user — the list is small,
    // but the sheet read is not free and this is the screen's landing call.
    const activeDevices = {};
    SheetService.listDevices().forEach(d => {
      if (d.revokedAt) return;
      activeDevices[d.userId] = (activeDevices[d.userId] || 0) + 1;
    });

    const users = UserService.listAll().map(u => {
      const projected = UserService.toPublic(u);
      projected.deviceCount = activeDevices[u.userId] || 0;
      return projected;
    });

    users.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { users: users, activeAdmins: UserService.countActiveAdmins() };
  }

  function listUserDevices(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'userId', 'string');
    _requireUser(data.userId);
    return { devices: DeviceService.listForUser(data.userId, false) };
  }

  /**
   * Account and sign-in history, newest first.
   * With no userId, returns the whole account log.
   */
  function getAuthLog(authCtx, data) {
    AuthService.requireAdmin(authCtx);

    let events = SheetService.getAuthAuditEvents();

    if (data && data.userId) {
      const user = _requireUser(data.userId);
      const needle = String(user.email).toLowerCase();
      events = events.filter(e => String(e.actor).toLowerCase().indexOf(needle) >= 0
        || _detailsMention(e.detailsJson, user.userId));
    }

    const projected = events.map(e => ({
      eventId: e.eventId,
      eventType: e.eventType,
      actor: e.actor,
      timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : String(e.timestamp),
      details: _safeParseJson(e.detailsJson),
    }));

    projected.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return { events: projected.slice(0, (data && data.limit) || 200) };
  }

  // ============================================================
  // Writes
  // ============================================================

  function createUser(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'name', 'string');
    Utils.requireField(data, 'email', 'string');
    Utils.requireField(data, 'role', 'string');

    const user = UserService.create({
      name: data.name,
      email: data.email,
      role: data.role,
      notes: data.notes,
      createdBy: authCtx.actorString,
    });

    AuditService.logAuth(authCtx.actorString, 'user_created', {
      userId: user.userId, email: user.email, role: user.role,
    });

    const delivery = _sendSetPasswordLink(user, authCtx);
    return { user: UserService.toPublic(user), delivery: delivery };
  }

  function setUserStatus(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'userId', 'string');
    Utils.requireField(data, 'status', 'string');
    UserService.assertValidStatus(data.status);

    const user = _requireUser(data.userId);
    if (user.status === data.status) {
      return { user: UserService.toPublic(user), devicesRevoked: 0 };
    }

    if (data.status === 'disabled') {
      _assertNotSelf(authCtx, user, 'You cannot disable your own account.');
      _assertNotLastAdmin(user,
        'This is the only active administrator. Give someone else admin rights first.');
    }

    const updated = UserService.update(user.userId, data.status === 'disabled'
      ? { status: 'disabled', disabledAt: Utils.nowIso(), disabledBy: authCtx.actorString }
      : { status: 'active', disabledAt: '', disabledBy: '', failedCount: 0, lockedUntil: '' });

    // Disabling has to reach the devices, not just the row. Without this the
    // account is refused at the next request but the person stays signed in
    // until the cache expires, which is not what "disable" is understood to
    // mean.
    let revoked = [];
    if (data.status === 'disabled') {
      revoked = DeviceService.revokeAllForUser(user.userId, authCtx.actorString);
    }

    AuditService.logAuth(authCtx.actorString,
      data.status === 'disabled' ? 'user_disabled' : 'user_enabled',
      { userId: user.userId, email: user.email, devicesRevoked: revoked.length });

    return { user: UserService.toPublic(updated), devicesRevoked: revoked.length };
  }

  function setUserRole(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'userId', 'string');
    Utils.requireField(data, 'role', 'string');
    UserService.assertValidRole(data.role);

    const user = _requireUser(data.userId);
    if (user.role === data.role) return { user: UserService.toPublic(user) };

    if (user.role === 'admin' && data.role !== 'admin') {
      _assertNotSelf(authCtx, user, 'You cannot remove your own admin rights.');
      _assertNotLastAdmin(user,
        'This is the only active administrator. Promote someone else first.');
    }

    const updated = UserService.update(user.userId, { role: data.role });

    AuditService.logAuth(authCtx.actorString,
      data.role === 'admin' ? 'role_granted' : 'role_revoked',
      { userId: user.userId, email: user.email, role: data.role });

    return { user: UserService.toPublic(updated) };
  }

  function unlockUser(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'userId', 'string');

    const user = _requireUser(data.userId);
    const updated = UserService.update(user.userId, { failedCount: 0, lockedUntil: '' });

    AuditService.logAuth(authCtx.actorString, 'account_unlocked', {
      userId: user.userId, email: user.email,
    });
    return { user: UserService.toPublic(updated) };
  }

  function sendPasswordLink(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'userId', 'string');

    const user = _requireUser(data.userId);
    if (user.status !== 'active') {
      throw new HandoverError('VALIDATION_FAILED',
        'This account is disabled. Restore access before sending a link.');
    }

    const delivery = _sendSetPasswordLink(user, authCtx);
    AuditService.logAuth(authCtx.actorString, 'password_reset_sent', {
      userId: user.userId, email: user.email, source: 'admin',
    });
    return { delivery: delivery };
  }

  function revokeDevice(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'deviceId', 'string');

    const device = SheetService.getDevice(data.deviceId);
    if (!device) throw new HandoverError('NOT_FOUND', 'Device not found.');

    DeviceService.revoke(data.deviceId, authCtx.actorString);
    AuditService.logAuth(authCtx.actorString, 'device_revoked', {
      deviceId: data.deviceId, userId: device.userId, label: device.label,
    });
    return { revoked: true };
  }

  function revokeAllDevices(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'userId', 'string');

    const user = _requireUser(data.userId);
    const revoked = DeviceService.revokeAllForUser(user.userId, authCtx.actorString);
    AuditService.logAuth(authCtx.actorString, 'device_revoked', {
      userId: user.userId, email: user.email, count: revoked.length, scope: 'all',
    });
    return { revoked: revoked.length };
  }

  /**
   * Hand an inspection to someone.
   *
   * Needed because createdBy is not ownership: the office commonly opens a job
   * that an inspector goes out to do, and from phase 3 onward this column is
   * what decides who can see it.
   */
  function assignInspection(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'assignedTo', 'string');

    const email = UserService.normalizeEmail(data.assignedTo);
    const target = UserService.getByEmail(email);
    if (!target) {
      throw new HandoverError('NOT_FOUND', `No account for ${email}.`);
    }
    if (target.status !== 'active') {
      throw new HandoverError('VALIDATION_FAILED',
        'That account is disabled. Assign the work to an active user.');
    }

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    SheetService.updateInspection(data.inspectionId, { assignedTo: email });
    AuditService.log(data.inspectionId, authCtx.actorString, 'inspection_assigned', {
      assignedTo: email,
    });
    return { inspectionId: data.inspectionId, assignedTo: email };
  }

  // ============================================================
  // Guardrails
  // ============================================================

  function _requireUser(userId) {
    const user = UserService.getById(userId);
    if (!user) throw new HandoverError('NOT_FOUND', 'User not found.');
    return user;
  }

  /**
   * A legacy admin token has no userId behind it, so it never matches — which
   * is correct. It is not a person, and the last-admin rule still applies.
   */
  function _assertNotSelf(authCtx, user, message) {
    if (authCtx.userId && authCtx.userId === user.userId) {
      throw new HandoverError('FORBIDDEN', message);
    }
  }

  function _assertNotLastAdmin(user, message) {
    if (user.role !== 'admin' || user.status !== 'active') return;
    if (UserService.countActiveAdmins() <= 1) {
      throw new HandoverError('FORBIDDEN', message);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Mail the link, and report honestly if it did not go out.
   *
   * A failure here is not a reason to fail the whole action: the account has
   * already been created or restored, and undoing that would be worse than
   * telling the admin to send the link again. The link is returned so the
   * screen can offer it directly.
   */
  function _sendSetPasswordLink(user, authCtx) {
    const token = AuthService.generateSetPasswordToken(user);
    const url = `${Config.getFrontendUrl()}#/set-password?k=${encodeURIComponent(token)}`;
    try {
      MailService.sendSetPasswordLink(user, token, PasswordService.hasPassword(user));
      return { emailed: true, url: url };
    } catch (e) {
      Utils.log('WARN', 'Set-password mail failed', {
        userId: user.userId, error: e.message,
      });
      return { emailed: false, url: url, error: e.message };
    }
  }

  function _detailsMention(detailsJson, userId) {
    return String(detailsJson || '').indexOf(userId) >= 0;
  }

  function _safeParseJson(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return {};
    }
  }

  return {
    listUsers,
    listUserDevices,
    getAuthLog,
    createUser,
    setUserStatus,
    setUserRole,
    unlockUser,
    sendPasswordLink,
    revokeDevice,
    revokeAllDevices,
    assignInspection,
  };
})();
