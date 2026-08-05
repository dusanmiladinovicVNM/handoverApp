/**
 * account.test.js
 * The sign-in flows: login, lockout, set and change password, refresh.
 *
 * Two properties here are load bearing and easy to lose in a later edit.
 *
 * Lockout, because the achievable PBKDF2 work factor in Apps Script is low
 * enough that throttling online guessing is a real part of the defence rather
 * than a nicety.
 *
 * And uniform answers, because a login form that responds differently to an
 * unknown address than to a wrong password becomes a way to enumerate who
 * works here.
 */

const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

module.exports = function run() {
  const env = createEnvironment();
  const { UserService, DeviceService, AuthService, AccountService, PasswordService,
          HandoverError, mail, audit } = env;

  const PASSWORD = 'kisa pada trava raste';
  const rejects = (fn, note) => expectError(HandoverError, fn, note);

  function makeUser(email, role) {
    const user = UserService.create({
      email, name: email.split('@')[0], role: role || 'inspector', createdBy: 'test',
    });
    const link = AuthService.generateSetPasswordToken(user);
    AccountService.setPassword(null, { token: link, password: PASSWORD });
    return UserService.getById(user.userId);
  }

  const login = (email, password, extra) =>
    AccountService.login(null, Object.assign({ email, password }, extra || {}));

  section('Setting the first password:');

  const bob = makeUser('bob@firma.rs');

  check('the mailed link sets a password and signs the user in', () => {
    assert(PasswordService.hasPassword(UserService.getById(bob.userId)),
      'no password was stored');
  });

  check('a used link cannot be replayed', () => {
    const user = UserService.create({
      email: 'replay@firma.rs', name: 'Replay', role: 'inspector', createdBy: 'test',
    });
    const link = AuthService.generateSetPasswordToken(user);
    AccountService.setPassword(null, { token: link, password: PASSWORD });
    rejects(() => AccountService.setPassword(null, { token: link, password: 'another good one' }),
      'the same link set a password twice');
  });

  check('a link cannot be used to set a password that breaks policy', () => {
    const user = UserService.create({
      email: 'weak@firma.rs', name: 'Weak', role: 'inspector', createdBy: 'test',
    });
    const link = AuthService.generateSetPasswordToken(user);
    rejects(() => AccountService.setPassword(null, { token: link, password: 'short' }),
      'a 5-character password was accepted');
  });

  section('Login:')

  check('correct credentials return a session', () => {
    const result = login('bob@firma.rs', PASSWORD);
    assert(result.sessionToken, 'no session token returned');
    assert(result.user.email === 'bob@firma.rs', 'wrong user returned');
    assert(result.user.role === 'inspector', 'wrong role returned');
    AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
  });

  check('the response never carries the password hash', () => {
    const result = login('bob@firma.rs', PASSWORD);
    assert(!('passHash' in result.user), 'passHash was sent to the client');
    assert(result.user.hasPassword === true, 'hasPassword flag missing');
  });

  check('"remember this device" is what decides a device token is issued', () => {
    assert(!login('bob@firma.rs', PASSWORD).deviceToken,
      'a device token was issued without being asked for');
    assert(login('bob@firma.rs', PASSWORD, { remember: true }).deviceToken,
      'no device token when one was asked for');
  });

  check('an email address is matched regardless of case or padding', () => {
    login('  BOB@Firma.RS  ', PASSWORD);
  });

  section('Uniform answers, so the form cannot enumerate accounts:');

  const messageFor = (email, password) => {
    try {
      login(email, password);
    } catch (e) {
      return e.message;
    }
    throw new Error('expected a rejection');
  };

  check('unknown address and wrong password read identically', () => {
    const unknown = messageFor('nobody@firma.rs', PASSWORD);
    const wrong = messageFor('bob@firma.rs', 'definitely not the password');
    assert(unknown === wrong, `"${unknown}" vs "${wrong}"`);
  });

  check('a disabled account reads the same way', () => {
    const gone = makeUser('gone@firma.rs');
    UserService.update(gone.userId, { status: 'disabled' });
    assert(messageFor('gone@firma.rs', PASSWORD) === messageFor('nobody@firma.rs', PASSWORD),
      'a disabled account is distinguishable from an unknown one');
  });

  check('an account with no password set reads the same way', () => {
    UserService.create({
      email: 'nopass@firma.rs', name: 'Nopass', role: 'inspector', createdBy: 'test',
    });
    assert(messageFor('nopass@firma.rs', PASSWORD) === messageFor('nobody@firma.rs', PASSWORD),
      'an account without a password is distinguishable');
  });

  check('a password reset request answers the same either way', () => {
    const known = AccountService.requestPasswordReset(null, { email: 'bob@firma.rs' });
    const unknown = AccountService.requestPasswordReset(null, { email: 'nobody@firma.rs' });
    assert(known.sent === unknown.sent && known.message === unknown.message,
      'the reset endpoint reveals whether an address exists');
  });

  section('Lockout:');

  check('the account locks after the configured number of failures', () => {
    const target = makeUser('lockme@firma.rs');
    for (let i = 0; i < env.config.loginMaxFailures; i++) {
      rejects(() => login('lockme@firma.rs', 'wrong password entirely'));
    }
    assert(UserService.isLocked(UserService.getById(target.userId)), 'the account did not lock');
  });

  check('the correct password is refused while locked', () => {
    const error = rejects(() => login('lockme@firma.rs', PASSWORD),
      'the correct password was accepted during a lockout');
    assert(/try again/i.test(error.message),
      `expected the lockout message, got "${error.message}"`);
  });

  check('but the lockout is not announced to someone who lacks the password', () => {
    const duringLock = messageFor('lockme@firma.rs', 'still the wrong password');
    const unknown = messageFor('nobody@firma.rs', PASSWORD);
    assert(duringLock === unknown,
      'a wrong guess during lockout reveals that the account exists');
  });

  check('the lock lifts once it expires', () => {
    UserService.update(UserService.getByEmail('lockme@firma.rs').userId,
      { lockedUntil: new Date(Date.now() - 1000).toISOString() });
    login('lockme@firma.rs', PASSWORD);
  });

  check('a successful login clears the failure count', () => {
    const target = makeUser('counter@firma.rs');
    rejects(() => login('counter@firma.rs', 'wrong'));
    rejects(() => login('counter@firma.rs', 'wrong'));
    login('counter@firma.rs', PASSWORD);
    assert(Number(UserService.getById(target.userId).failedCount) === 0,
      'the failure count survived a successful sign-in');
  });

  section('Changing a password:');

  check('changing it signs every device out', () => {
    const user = makeUser('change@firma.rs');
    const first = login('change@firma.rs', PASSWORD, { remember: true });
    const second = login('change@firma.rs', PASSWORD);
    const ctx = AuthService.resolveAuth({ type: 'token', token: first.sessionToken });

    AccountService.changePassword(ctx, {
      oldPassword: PASSWORD, newPassword: 'sasvim druga duga lozinka',
    });

    rejects(() => AuthService.resolveAuth({ type: 'token', token: first.sessionToken }),
      'the session that made the change survived');
    rejects(() => AuthService.resolveAuth({ type: 'token', token: second.sessionToken }),
      'another device stayed signed in');
    assert(AuthService.verifyDeviceToken(first.deviceToken) === null,
      'a remembered device survived the password change');
    assert(UserService.getById(user.userId), 'user vanished');
  });

  check('the new password works and the old one does not', () => {
    login('change@firma.rs', 'sasvim druga duga lozinka');
    rejects(() => login('change@firma.rs', PASSWORD), 'the old password still worked');
  });

  check('a wrong current password is refused', () => {
    const result = login('bob@firma.rs', PASSWORD);
    const ctx = AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
    rejects(() => AccountService.changePassword(ctx, {
      oldPassword: 'not it', newPassword: 'a perfectly fine new one',
    }), 'the current password was not checked');
  });

  check('reusing the current password is refused', () => {
    const result = login('bob@firma.rs', PASSWORD);
    const ctx = AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
    rejects(() => AccountService.changePassword(ctx, {
      oldPassword: PASSWORD, newPassword: PASSWORD,
    }), 'the password was allowed to stay the same');
  });

  check('a tenant token cannot change anyone\'s password', () => {
    rejects(() => AccountService.changePassword(
      { role: 'tenant', isAdmin: false }, { oldPassword: 'x', newPassword: 'y' }),
      'a context with no user account was allowed through');
  });

  section('Password reset by mail:');

  check('a reset link is sent for a real account', () => {
    const before = mail.sent.length;
    AccountService.requestPasswordReset(null, { email: 'bob@firma.rs' });
    assert(mail.sent.length === before + 1, 'no mail was sent');
    assert(mail.sent.slice(-1)[0].to === 'bob@firma.rs', 'mail went to the wrong address');
  });

  check('no mail is sent for an unknown address', () => {
    const before = mail.sent.length;
    AccountService.requestPasswordReset(null, { email: 'nobody-here@firma.rs' });
    assert(mail.sent.length === before, 'mail was sent to an address with no account');
  });

  check('the link in the mail actually resets the password', () => {
    const user = makeUser('reset@firma.rs');
    AccountService.requestPasswordReset(null, { email: 'reset@firma.rs' });
    const body = mail.sent.slice(-1)[0].body;
    const token = decodeURIComponent(body.match(/set-password\?k=([^\s]+)/)[1]);

    AccountService.setPassword(null, { token: token, password: 'potpuno nova lozinka ovde' });
    login('reset@firma.rs', 'potpuno nova lozinka ovde');
    rejects(() => login('reset@firma.rs', PASSWORD), 'the old password still worked');
    assert(UserService.getById(user.userId).status === 'active', 'the account changed status');
  });

  section('Session refresh:');

  check('a remembered device exchanges for a fresh session', () => {
    const result = login('bob@firma.rs', PASSWORD, { remember: true });
    const refreshed = AccountService.refreshSession(null, { deviceToken: result.deviceToken });
    assert(refreshed.sessionToken, 'no session token returned');
    AuthService.resolveAuth({ type: 'token', token: refreshed.sessionToken });
    assert(refreshed.user.email === 'bob@firma.rs', 'wrong user');
  });

  check('a revoked device cannot refresh', () => {
    const result = login('bob@firma.rs', PASSWORD, { remember: true });
    const ctx = AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
    DeviceService.revoke(ctx.deviceId, 'test');
    rejects(() => AccountService.refreshSession(null, { deviceToken: result.deviceToken }),
      'a revoked device was refreshed');
  });

  check('a disabled account cannot refresh', () => {
    const user = makeUser('refresh@firma.rs');
    const result = login('refresh@firma.rs', PASSWORD, { remember: true });
    UserService.update(user.userId, { status: 'disabled' });
    rejects(() => AccountService.refreshSession(null, { deviceToken: result.deviceToken }),
      'a disabled account was refreshed');
  });

  section('Sign-out and identity:');

  check('signing out revokes only the device it was called on', () => {
    const staying = login('bob@firma.rs', PASSWORD);
    const leaving = login('bob@firma.rs', PASSWORD);
    const ctx = AuthService.resolveAuth({ type: 'token', token: leaving.sessionToken });

    AccountService.signOut(ctx);
    rejects(() => AuthService.resolveAuth({ type: 'token', token: leaving.sessionToken }),
      'the signed-out session survived');
    AuthService.resolveAuth({ type: 'token', token: staying.sessionToken });
  });

  check('me() reports the signed-in account', () => {
    const result = login('bob@firma.rs', PASSWORD);
    const ctx = AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
    const me = AccountService.me(ctx);
    assert(me.user.email === 'bob@firma.rs', `wrong identity: ${me.user.email}`);
    assert(me.user.role === 'inspector', `wrong role: ${me.user.role}`);
  });

  check('me() refuses a context with no account behind it', () =>
    rejects(() => AccountService.me({ role: 'tenant', isAdmin: false }),
      'a tenant link was told about an account'));

  section('Audit trail:');

  check('successful and failed sign-ins are both recorded', () => {
    const before = audit.events.length;
    login('bob@firma.rs', PASSWORD);
    rejects(() => login('bob@firma.rs', 'wrong'));
    const added = audit.events.slice(before).map(e => e.eventType);
    assert(added.indexOf('login_succeeded') >= 0, 'no login_succeeded event');
    assert(added.indexOf('login_failed') >= 0, 'no login_failed event');
  });

  check('a failed sign-in never records the attempted password', () => {
    const before = audit.events.length;
    rejects(() => login('bob@firma.rs', 'sup3r-s3cret-typo'));
    const written = JSON.stringify(audit.events.slice(before));
    assert(written.indexOf('sup3r-s3cret-typo') < 0, 'the attempted password was logged');
  });
};
