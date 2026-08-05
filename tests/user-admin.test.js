/**
 * user-admin.test.js
 * The actions behind the account administration screen.
 *
 * The guardrails get the most attention here. They are the difference between
 * a misclick being an inconvenience and a misclick locking everyone out of the
 * system with only the Apps Script editor left as a way back in. They are also
 * exactly the kind of check that looks redundant later and gets removed.
 *
 * The other half is the boundary: an inspector holds a perfectly valid session,
 * and every one of these actions has to refuse it.
 */

const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

module.exports = function run() {
  const env = createEnvironment();
  const { UserService, DeviceService, AuthService, AccountService, UserAdminService,
          PasswordService, HandoverError, db, mail } = env;

  const PASSWORD = 'kisa pada trava raste';
  const rejects = (fn, note) => expectError(HandoverError, fn, note);

  /** A signed-in context, the way a real request would arrive with one. */
  function signedIn(email, role) {
    let user = UserService.getByEmail(email);
    if (!user) {
      user = UserService.create({
        email, name: email.split('@')[0], role: role || 'inspector', createdBy: 'test',
      });
      AccountService.setPassword(null, {
        token: AuthService.generateSetPasswordToken(user), password: PASSWORD,
      });
    }
    const result = AccountService.login(null, { email, password: PASSWORD });
    return AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
  }

  const admin = signedIn('admin@firma.rs', 'admin');
  const second = signedIn('second@firma.rs', 'admin');
  const inspector = signedIn('inspector@firma.rs', 'inspector');

  const byEmail = (email) => UserService.getByEmail(email);

  section('Only admins get in:');

  const ADMIN_ONLY = [
    ['listUsers', {}],
    ['createUser', { name: 'X', email: 'x@firma.rs', role: 'inspector' }],
    ['setUserStatus', { userId: 'USR-1', status: 'disabled' }],
    ['setUserRole', { userId: 'USR-1', role: 'admin' }],
    ['unlockUser', { userId: 'USR-1' }],
    ['sendPasswordLink', { userId: 'USR-1' }],
    ['listUserDevices', { userId: 'USR-1' }],
    ['revokeDevice', { deviceId: 'DEV-1' }],
    ['revokeAllDevices', { userId: 'USR-1' }],
    ['getAuthLog', {}],
    ['assignInspection', { inspectionId: 'INS-1', assignedTo: 'x@firma.rs' }],
  ];

  ADMIN_ONLY.forEach(([action, data]) => {
    check(`an inspector cannot call ${action}`, () =>
      rejects(() => UserAdminService[action](inspector, data),
        `${action} accepted an inspector's session`));
  });

  check('a tenant cannot call them either', () => {
    const nonce = env.Utils.generateNonce();
    db.inspections.push({ inspectionId: 'INS-2026-000009', currentNonce: nonce });
    const tenant = AuthService.resolveAuth({
      type: 'token',
      token: AuthService.generateTenantToken('INS-2026-000009', 24, nonce),
    });
    ADMIN_ONLY.forEach(([action, data]) =>
      rejects(() => UserAdminService[action](tenant, data), `${action} accepted a tenant`));
  });

  section('Adding users:');

  check('a new user appears, with no password and never signed in', () => {
    const res = UserAdminService.createUser(admin, {
      name: 'Ana Anić', email: 'Ana@Firma.RS', role: 'inspector',
    });
    assert(res.user.email === 'ana@firma.rs', `email stored as ${res.user.email}`);
    assert(res.user.hasPassword === false, 'a password appeared from nowhere');
    assert(res.user.status === 'active', 'new user is not active');
    assert(res.delivery.emailed === true, 'no invitation was sent');
  });

  check('the invitation link actually works', () => {
    const before = mail.sent.length;
    UserAdminService.createUser(admin, {
      name: 'Pero', email: 'pero@firma.rs', role: 'inspector',
    });
    assert(mail.sent.length === before + 1, 'no mail sent');
    const token = decodeURIComponent(
      mail.sent.slice(-1)[0].body.match(/set-password\?k=([^\s]+)/)[1]);
    AccountService.setPassword(null, { token, password: 'druga duga lozinka ovde' });
    AccountService.login(null, { email: 'pero@firma.rs', password: 'druga duga lozinka ovde' });
  });

  check('a duplicate email is refused, whatever its case', () =>
    rejects(() => UserAdminService.createUser(admin, {
      name: 'Ana Again', email: 'ANA@firma.rs', role: 'inspector',
    }), 'a second account was created for the same address'));

  check('an invalid role is refused', () =>
    rejects(() => UserAdminService.createUser(admin, {
      name: 'X', email: 'role@firma.rs', role: 'superuser',
    }), 'an unknown role was accepted'));

  // The account and the email are separate things, and only one of them can
  // fail. Failing the whole action would leave the admin with nothing.
  check('a mail failure still leaves a usable account and hands back the link', () => {
    mail.failNext = true;
    const res = UserAdminService.createUser(admin, {
      name: 'Nomail', email: 'nomail@firma.rs', role: 'inspector',
    });
    assert(res.user.userId, 'the account was not created');
    assert(res.delivery.emailed === false, 'delivery claimed success');
    assert(/set-password\?k=/.test(res.delivery.url), 'no link to fall back on');

    const token = decodeURIComponent(res.delivery.url.match(/set-password\?k=([^\s]+)/)[1]);
    AccountService.setPassword(null, { token, password: 'treca duga lozinka ovde' });
  });

  section('Disabling and restoring:');

  check('disabling signs every device out, not just the account', () => {
    const target = byEmail('ana@firma.rs');
    AccountService.setPassword(null, {
      token: AuthService.generateSetPasswordToken(target), password: PASSWORD,
    });
    const session = AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD });
    AuthService.resolveAuth({ type: 'token', token: session.sessionToken });

    const res = UserAdminService.setUserStatus(admin, {
      userId: target.userId, status: 'disabled',
    });
    assert(res.devicesRevoked >= 1, 'no device was revoked');
    rejects(() => AuthService.resolveAuth({ type: 'token', token: session.sessionToken }),
      'a disabled user stayed signed in');
    rejects(() => AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD }),
      'a disabled user could sign in again');
  });

  check('restoring lets them back in, but not on the old devices', () => {
    const target = byEmail('ana@firma.rs');
    UserAdminService.setUserStatus(admin, { userId: target.userId, status: 'active' });
    AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD });
    assert(DeviceService.listForUser(target.userId, false).length === 1,
      'an old device came back to life');
  });

  check('setting the status it already has is a no-op, not an error', () => {
    const target = byEmail('ana@firma.rs');
    const res = UserAdminService.setUserStatus(admin, {
      userId: target.userId, status: 'active',
    });
    assert(res.devicesRevoked === 0, 'a no-op revoked devices');
  });

  section('Guardrails:');

  check('an admin cannot disable their own account', () =>
    rejects(() => UserAdminService.setUserStatus(admin, {
      userId: admin.userId, status: 'disabled',
    }), 'an admin disabled themselves'));

  check('an admin cannot remove their own admin rights', () =>
    rejects(() => UserAdminService.setUserRole(admin, {
      userId: admin.userId, role: 'inspector',
    }), 'an admin demoted themselves'));

  check('the last active admin cannot be disabled', () => {
    // Down to one: demote the second admin first, which is allowed.
    UserAdminService.setUserRole(admin, { userId: second.userId, role: 'inspector' });
    assert(UserService.countActiveAdmins() === 1, 'setup: expected exactly one admin left');

    rejects(() => UserAdminService.setUserStatus(second, {
      userId: admin.userId, status: 'disabled',
    }), 'the only administrator was disabled');
  });

  check('the last active admin cannot be demoted', () =>
    rejects(() => UserAdminService.setUserRole(second, {
      userId: admin.userId, role: 'inspector',
    }), 'the only administrator was demoted'));

  check('once someone else is promoted, both become possible again', () => {
    UserAdminService.setUserRole(admin, { userId: second.userId, role: 'admin' });
    assert(UserService.countActiveAdmins() === 2, 'promotion did not take');
    UserAdminService.setUserStatus(second, { userId: admin.userId, status: 'disabled' });
    UserAdminService.setUserStatus(second, { userId: admin.userId, status: 'active' });
  });

  // The self-checks refuse an admin acting on their own row, so they cannot be
  // what keeps the last administrator alive — one admin demoting *another* is
  // allowed right up to the point where none is left. This is the rule that
  // catches that, tested through a second account rather than through self.
  check('the last-admin rule holds even when the actor is someone else', () => {
    UserAdminService.setUserRole(admin, { userId: second.userId, role: 'inspector' });
    assert(UserService.countActiveAdmins() === 1, 'setup: expected one admin left');
    rejects(() => UserAdminService.setUserRole(second, {
      userId: admin.userId, role: 'inspector',
    }), 'the last administrator was demoted by a colleague');
    UserAdminService.setUserRole(admin, { userId: second.userId, role: 'admin' });
  });

  section('Roles take effect at once:');

  // Re-resolving the same token between steps is the whole point, and it is
  // what a real request does: the context is built fresh from the token on
  // every call, so it reflects the role as it stands now. Holding on to a
  // resolved context and reusing it — as an earlier version of this test did —
  // tests a snapshot instead, and passes whatever the sheet says.
  check('promotion opens the admin actions on a session issued beforehand', () => {
    const target = byEmail('inspector@firma.rs');
    const token = AccountService.login(null, {
      email: 'inspector@firma.rs', password: PASSWORD,
    }).sessionToken;
    const asInspector = () => AuthService.resolveAuth({ type: 'token', token });

    rejects(() => UserAdminService.listUsers(asInspector(), {}), 'setup: should start refused');

    UserAdminService.setUserRole(admin, { userId: target.userId, role: 'admin' });
    UserAdminService.listUsers(asInspector(), {});

    UserAdminService.setUserRole(admin, { userId: target.userId, role: 'inspector' });
    rejects(() => UserAdminService.listUsers(asInspector(), {}),
      'demotion did not close the door on the same token');
  });

  section('Locking:');

  check('an admin can unlock an account that locked itself', () => {
    const target = byEmail('ana@firma.rs');
    for (let i = 0; i < env.config.loginMaxFailures; i++) {
      rejects(() => AccountService.login(null, { email: 'ana@firma.rs', password: 'wrong' }));
    }
    assert(UserService.isLocked(UserService.getById(target.userId)), 'setup: expected a lock');

    UserAdminService.unlockUser(admin, { userId: target.userId });
    AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD });
  });

  section('Devices:');

  check('an admin sees and can sign out someone else\'s device', () => {
    const target = byEmail('ana@firma.rs');
    const session = AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD });
    const devices = UserAdminService.listUserDevices(admin, { userId: target.userId }).devices;
    assert(devices.length >= 1, 'no devices listed');

    const ctx = AuthService.resolveAuth({ type: 'token', token: session.sessionToken });
    UserAdminService.revokeDevice(admin, { deviceId: ctx.deviceId });
    rejects(() => AuthService.resolveAuth({ type: 'token', token: session.sessionToken }),
      'the revoked device still worked');
  });

  check('signing out all devices leaves none', () => {
    const target = byEmail('ana@firma.rs');
    AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD });
    AccountService.login(null, { email: 'ana@firma.rs', password: PASSWORD });
    UserAdminService.revokeAllDevices(admin, { userId: target.userId });
    assert(UserAdminService.listUserDevices(admin, { userId: target.userId })
      .devices.length === 0, 'a device survived');
  });

  section('Listing and history:');

  check('the list carries the badges the screen renders from', () => {
    const res = UserAdminService.listUsers(admin, {});
    const ana = res.users.find(u => u.email === 'ana@firma.rs');
    assert(ana, 'ana missing from the list');
    assert(typeof ana.deviceCount === 'number', 'no device count');
    assert(typeof ana.hasPassword === 'boolean', 'no hasPassword flag');
    assert(res.activeAdmins >= 1, 'no admin count');
  });

  check('no password hash ever reaches the list', () => {
    const serialized = JSON.stringify(UserAdminService.listUsers(admin, {}));
    assert(serialized.indexOf('pbkdf2-sha256') < 0, 'a password hash was sent to the client');
    assert(serialized.indexOf('passHash') < 0, 'the passHash field was sent to the client');
  });

  check('history for one user is about that user', () => {
    const target = byEmail('ana@firma.rs');
    const events = UserAdminService.getAuthLog(admin, { userId: target.userId }).events;
    assert(events.length > 0, 'no history recorded');
    assert(events.every(e => e.timestamp), 'an event has no timestamp');
  });

  check('history comes back newest first', () => {
    const events = UserAdminService.getAuthLog(admin, {}).events;
    for (let i = 1; i < events.length; i++) {
      assert(events[i - 1].timestamp >= events[i].timestamp, 'history is out of order');
    }
  });

  section('Assigning inspections:');

  check('an inspection can be handed to an active user', () => {
    db.inspections.push({
      inspectionId: 'INS-2026-000100', status: 'draft',
      createdBy: 'admin@firma.rs', assignedTo: 'admin@firma.rs',
    });
    const res = UserAdminService.assignInspection(admin, {
      inspectionId: 'INS-2026-000100', assignedTo: 'Ana@Firma.RS',
    });
    assert(res.assignedTo === 'ana@firma.rs', `assigned to ${res.assignedTo}`);
    assert(db.inspections.find(i => i.inspectionId === 'INS-2026-000100')
      .assignedTo === 'ana@firma.rs', 'the sheet was not updated');
  });

  check('it cannot be handed to someone with no account', () =>
    rejects(() => UserAdminService.assignInspection(admin, {
      inspectionId: 'INS-2026-000100', assignedTo: 'ghost@firma.rs',
    }), 'assigned to a non-existent user'));

  check('it cannot be handed to a disabled account', () => {
    const target = byEmail('ana@firma.rs');
    UserAdminService.setUserStatus(admin, { userId: target.userId, status: 'disabled' });
    rejects(() => UserAdminService.assignInspection(admin, {
      inspectionId: 'INS-2026-000100', assignedTo: 'ana@firma.rs',
    }), 'assigned to a disabled user');
    UserAdminService.setUserStatus(admin, { userId: target.userId, status: 'active' });
  });

  check('an unknown inspection is refused', () =>
    rejects(() => UserAdminService.assignInspection(admin, {
      inspectionId: 'INS-NOPE', assignedTo: 'ana@firma.rs',
    }), 'assigned an inspection that does not exist'));
};
