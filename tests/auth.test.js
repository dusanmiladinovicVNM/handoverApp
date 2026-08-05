/**
 * auth.test.js
 * Token issuing and resolution.
 *
 * The first section is the one that matters most. The whole account-admin
 * screen rests on a single claim — that a token says who you are and the sheet
 * says what you may do — and if that claim ever quietly stops holding, the
 * screen keeps looking like it works while "revoke admin rights" does nothing
 * until the token expires.
 */

const crypto = require('crypto');
const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

module.exports = function run() {
  const env = createEnvironment();
  const { Utils, PasswordService, UserService, DeviceService, AuthService, HandoverError, db } = env;

  const alice = UserService.create({
    email: 'Alice@Firma.RS', name: 'Alice', role: 'admin', createdBy: 'test',
  });
  const bob = UserService.create({
    email: 'bob@firma.rs', name: 'Bob', role: 'inspector', createdBy: 'test',
  });

  function signIn(user) {
    const device = DeviceService.register(user.userId, 'Test device', 'node/test');
    return {
      device,
      session: AuthService.generateSessionToken(user.userId, device.deviceId, device.nonce),
      deviceToken: AuthService.generateDeviceToken(user.userId, device.deviceId, device.nonce),
    };
  }
  const auth = (token) => AuthService.resolveAuth({ type: 'token', token });
  const rejects = (fn, note) => expectError(HandoverError, fn, note);

  function signToken(payload, secret) {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', secret || env.config.tokenSecret)
      .update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
  }

  section('Authority is read from the record, never from the token:');

  check('the resolved role matches the stored role', () => {
    assert(auth(signIn(alice).session).isAdmin === true, 'admin not recognised');
    assert(auth(signIn(bob).session).isAdmin === false, 'inspector treated as admin');
  });

  check('demoting an admin takes effect on a token issued beforehand', () => {
    const session = signIn(alice).session;
    assert(auth(session).isAdmin === true, 'setup: should begin as admin');
    UserService.update(alice.userId, { role: 'inspector' });
    assert(auth(session).isAdmin === false,
      'still admin after demotion — authority is coming from the token');
    UserService.update(alice.userId, { role: 'admin' });
  });

  check('disabling an account rejects a token issued beforehand', () => {
    const session = signIn(bob).session;
    auth(session);
    UserService.update(bob.userId, { status: 'disabled' });
    rejects(() => auth(session), 'a disabled account was still accepted');
    UserService.update(bob.userId, { status: 'active' });
  });

  check('the resolved context names the person, for the audit trail', () => {
    const ctx = auth(signIn(bob).session);
    assert(ctx.actorString === 'user:bob@firma.rs', `actor reads ${ctx.actorString}`);
    assert(ctx.email === 'bob@firma.rs' && ctx.name === 'Bob', 'identity missing');
  });

  section('Device revocation:');

  check('revoking one device leaves the others alone', () => {
    const first = signIn(bob);
    const second = signIn(bob);
    DeviceService.revoke(first.device.deviceId, 'test');
    rejects(() => auth(first.session), 'a revoked device was still accepted');
    auth(second.session);
  });

  check('revoking all devices ends every session', () => {
    const a = signIn(bob);
    const b = signIn(bob);
    DeviceService.revokeAllForUser(bob.userId, 'test');
    rejects(() => auth(a.session));
    rejects(() => auth(b.session));
  });

  check('an expired device row is refused', () => {
    const s = signIn(bob);
    DeviceService.revoke(s.device.deviceId, 'test');
    db.devices.find(d => d.deviceId === s.device.deviceId).revokedAt = '';
    db.devices.find(d => d.deviceId === s.device.deviceId).expiresAt =
      new Date(Date.now() - 1000).toISOString();
    rejects(() => auth(s.session), 'an expired device was accepted');
  });

  section('Token types stay in their lane:');

  check('a device token is refused as a session', () =>
    rejects(() => auth(signIn(bob).deviceToken), 'device token accepted as a session'));

  check('a device token still refreshes into a session', () => {
    const resolved = AuthService.verifyDeviceToken(signIn(bob).deviceToken);
    assert(resolved && resolved.user.userId === bob.userId,
      'the refresh path rejected a valid device token');
  });

  check('a session token is refused by the refresh path', () =>
    assert(AuthService.verifyDeviceToken(signIn(bob).session) === null,
      'session token accepted as a device token'));

  section('Set-password links:');

  check('a fresh link resolves to its user', () => {
    const link = AuthService.generateSetPasswordToken(UserService.getById(bob.userId));
    assert(AuthService.verifySetPasswordToken(link).userId === bob.userId,
      'the link did not resolve');
  });

  check('the link dies once a password is set, with no extra state to keep', () => {
    const link = AuthService.generateSetPasswordToken(UserService.getById(bob.userId));
    UserService.update(bob.userId, {
      passHash: PasswordService.hashPassword('a decent length passphrase'),
    });
    assert(AuthService.verifySetPasswordToken(link) === null, 'a used link still verified');
  });

  check('an older outstanding link dies at the same moment', () => {
    const first = AuthService.generateSetPasswordToken(UserService.getById(bob.userId));
    const second = AuthService.generateSetPasswordToken(UserService.getById(bob.userId));
    assert(AuthService.verifySetPasswordToken(first) !== null, 'setup: first link should be valid');
    UserService.update(bob.userId, {
      passHash: PasswordService.hashPassword('another good passphrase'),
    });
    assert(AuthService.verifySetPasswordToken(first) === null, 'the first link survived');
    assert(AuthService.verifySetPasswordToken(second) === null, 'the second link survived');
  });

  check('a link for a disabled account does not resolve', () => {
    const link = AuthService.generateSetPasswordToken(UserService.getById(bob.userId));
    UserService.update(bob.userId, { status: 'disabled' });
    assert(AuthService.verifySetPasswordToken(link) === null, 'a disabled account resolved');
    UserService.update(bob.userId, { status: 'active' });
  });

  section('Forgery and tampering:');

  check('a tampered payload is rejected', () => {
    const [encoded, sig] = signIn(bob).session.split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.uid = alice.userId;
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + '.' + sig;
    rejects(() => auth(forged), 'a rewritten payload was accepted');
  });

  check('a foreign signature is rejected', () =>
    rejects(() => auth(signToken({
      typ: 's', uid: alice.userId, did: 'DEV-2026-000001',
      exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'x',
    }, 'wrong-secret')), 'a token signed with another secret was accepted'));

  check('an expired token is rejected', () => {
    const s = signIn(bob);
    rejects(() => auth(signToken({
      typ: 's', uid: bob.userId, did: s.device.deviceId,
      exp: Math.floor(Date.now() / 1000) - 60, nonce: s.device.nonce,
    })), 'an expired token was accepted');
  });

  check('a session naming someone else\'s device is rejected', () => {
    const bobs = signIn(bob);
    rejects(() => auth(AuthService.generateSessionToken(
      alice.userId, bobs.device.deviceId, bobs.device.nonce)),
      'a device belonging to another user was accepted');
  });

  check('malformed input is rejected cleanly', () => {
    ['', 'x', 'a.b.c', 'not-a-token', '.', 'YQ==.', '..'].forEach(bad =>
      rejects(() => auth(bad), `accepted ${JSON.stringify(bad)}`));
  });

  check('a missing or unknown auth block is rejected', () => {
    rejects(() => AuthService.resolveAuth(null));
    rejects(() => AuthService.resolveAuth({}));
    rejects(() => AuthService.resolveAuth({ type: 'google' }));
    rejects(() => AuthService.resolveAuth({ type: 'something-else', token: 'x' }));
  });

  section('The tenant flow is untouched:');

  check('a tenant token resolves and stays bound to its inspection', () => {
    const nonce = Utils.generateNonce();
    db.inspections.push({ inspectionId: 'INS-2026-000001', currentNonce: nonce });
    const ctx = auth(AuthService.generateTenantToken('INS-2026-000001', 24, nonce));
    assert(ctx.role === 'tenant' && ctx.isAdmin === false, 'tenant context is wrong');
    assert(ctx.inspectionId === 'INS-2026-000001', 'inspection not bound');
    AuthService.requireMatchingInspection(ctx, 'INS-2026-000001');
    expectError(HandoverError,
      () => AuthService.requireMatchingInspection(ctx, 'INS-2026-000002'),
      'a tenant token was accepted for a different inspection');
  });

  check('a tenant cannot sign in another party\'s role', () => {
    const nonce = Utils.generateNonce();
    db.inspections.push({ inspectionId: 'INS-2026-000003', currentNonce: nonce });
    const ctx = auth(AuthService.generateTenantToken('INS-2026-000003', 24, nonce));
    AuthService.requireMatchingRole(ctx, 'tenant');
    expectError(HandoverError, () => AuthService.requireMatchingRole(ctx, 'landlord'),
      'a tenant token was accepted as a landlord signature');
  });

  check('rotating the inspection nonce revokes the tenant token', () => {
    const nonce = Utils.generateNonce();
    db.inspections.push({ inspectionId: 'INS-2026-000002', currentNonce: nonce });
    const token = AuthService.generateTenantToken('INS-2026-000002', 24, nonce);
    auth(token);
    db.inspections.find(i => i.inspectionId === 'INS-2026-000002')
      .currentNonce = Utils.generateNonce();
    rejects(() => auth(token), 'the token survived a nonce rotation');
  });

  section('The retired admin token:');

  // The pre-accounts credential is gone, and one of them was published in this
  // repository's history. Its signature is still valid — the secret has not
  // changed — so nothing but the shape check stands between that token and
  // full admin access. This is the test that keeps it out.
  check('a token of the old admin shape is refused, signature notwithstanding', () => {
    const retired = signToken({
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: 'a'.repeat(16),
      label: 'Dušan main device',
    });
    rejects(() => auth(retired), 'a pre-accounts admin token was accepted');
  });

  check('nothing can mint one any more', () => {
    ['generateAdminToken', 'generateToken', 'listAdminTokens', 'revokeAdminToken']
      .forEach(name => assert(typeof AuthService[name] === 'undefined',
        `AuthService.${name} is still exported`));
  });
};
