/**
 * auth-mirror.test.js
 * The copy of the user and device rows that keeps auth off the spreadsheet.
 *
 * Every other suite runs with mirroring switched off, because a remembered row
 * would mask the property they exist to protect — that role and status are
 * re-read on every request. This one switches it on, which makes it the only
 * place the mirror's own behaviour is examined.
 *
 * Two things have to hold at once, and they pull against each other. Reads must
 * stop touching the sheet, or the mirror is pointless. Revocation must still
 * take effect on the next request, or the mirror is dangerous. The second is
 * what the invalidation on every write is for, and it is what most of this file
 * checks.
 */

const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

const HOUR = 3600;

module.exports = function run() {

  /**
   * An environment with mirroring on.
   *
   * Whether a read reached the store is proved by emptying the store and asking
   * again — an answer that still arrives can only have come from the mirror.
   * Blunt, but it cannot be fooled by a counter placed on the wrong call.
   */
  function mirrored(ttlSeconds) {
    const env = createEnvironment(
      { authCacheTtlSeconds: ttlSeconds === undefined ? 6 * HOUR : ttlSeconds },
      { cache: true }
    );

    return env;
  }

  section('Reads stop touching the store:');

  check('a repeated lookup by id is served from the mirror', () => {
    const env = mirrored();
    const user = env.UserService.create({
      email: 'a@firma.rs', name: 'A', role: 'admin', createdBy: 'test',
    });

    env.UserService.getById(user.userId);
    // Remove the row entirely. A second lookup that still answers can only be
    // coming from the mirror.
    env.db.users.length = 0;
    const again = env.UserService.getById(user.userId);
    assert(again && again.email === 'a@firma.rs', 'the second read went to the store');
  });

  check('a device lookup is mirrored too', () => {
    const env = mirrored();
    const device = env.DeviceService.register('USR-1', 'Phone', 'test');

    env.DeviceService.getById(device.deviceId);
    env.db.devices.length = 0;
    assert(env.DeviceService.getById(device.deviceId), 'the second read went to the store');
  });

  check('a miss is still a miss — nothing is invented', () => {
    const env = mirrored();
    assert(env.UserService.getById('USR-NOPE') === null, 'a phantom user appeared');
    assert(env.DeviceService.getById('DEV-NOPE') === null, 'a phantom device appeared');
  });

  section('Revocation is immediate, whatever the window:');

  check('disabling an account is visible on the very next read', () => {
    const env = mirrored();
    const user = env.UserService.create({
      email: 'b@firma.rs', name: 'B', role: 'inspector', createdBy: 'test',
    });
    env.UserService.getById(user.userId);

    env.UserService.update(user.userId, { status: 'disabled' });
    assert(env.UserService.getById(user.userId).status === 'disabled',
      'the mirror kept serving an account that had been disabled');
  });

  check('a role change is visible on the very next read', () => {
    const env = mirrored();
    const user = env.UserService.create({
      email: 'c@firma.rs', name: 'C', role: 'admin', createdBy: 'test',
    });
    env.UserService.getById(user.userId);

    env.UserService.update(user.userId, { role: 'inspector' });
    assert(env.UserService.getById(user.userId).role === 'inspector',
      'the mirror kept serving admin rights that had been removed');
  });

  check('revoking a device is visible on the very next read', () => {
    const env = mirrored();
    const device = env.DeviceService.register('USR-2', 'Phone', 'test');
    env.DeviceService.getById(device.deviceId);

    env.DeviceService.revoke(device.deviceId, 'test');
    assert(env.DeviceService.getById(device.deviceId).revokedAt,
      'a revoked device still read as live');
  });

  check('revoking every device of a user clears each of them', () => {
    const env = mirrored();
    const first = env.DeviceService.register('USR-3', 'One', 'test');
    const second = env.DeviceService.register('USR-3', 'Two', 'test');
    env.DeviceService.getById(first.deviceId);
    env.DeviceService.getById(second.deviceId);

    env.DeviceService.revokeAllForUser('USR-3', 'test');
    assert(env.DeviceService.getById(first.deviceId).revokedAt, 'first device survived');
    assert(env.DeviceService.getById(second.deviceId).revokedAt, 'second device survived');
  });

  check('an email lookup is invalidated as well as an id lookup', () => {
    const env = mirrored();
    const user = env.UserService.create({
      email: 'd@firma.rs', name: 'D', role: 'admin', createdBy: 'test',
    });
    env.UserService.getByEmail('d@firma.rs');

    env.UserService.update(user.userId, { status: 'disabled' });
    assert(env.UserService.getByEmail('d@firma.rs').status === 'disabled',
      'the by-email copy outlived the change');
  });

  section('The window still bounds a change made outside the app:');

  check('a copy older than the window is not trusted', () => {
    const env = mirrored(6 * HOUR);
    const user = env.UserService.create({
      email: 'e@firma.rs', name: 'E', role: 'admin', createdBy: 'test',
    });
    env.UserService.getById(user.userId);

    // Edit the row the way someone typing into the spreadsheet would — behind
    // the app's back, so nothing invalidates. Then age the durable copy past
    // the window and drop the fast layer, as an eviction would.
    env.db.users[0].role = 'inspector';
    Object.keys(env.properties)
      .filter(k => k.indexOf('am:') === 0)
      .forEach(k => {
        const entry = JSON.parse(env.properties[k]);
        entry.at = Date.now() - (7 * HOUR * 1000);
        env.properties[k] = JSON.stringify(entry);
      });
    env.CacheService.getScriptCache().removeAll([`u:${user.userId}`]);

    assert(env.UserService.getById(user.userId).role === 'inspector',
      'an expired copy was served instead of re-reading the store');
  });

  check('and a copy inside the window is', () => {
    const env = mirrored(6 * HOUR);
    const user = env.UserService.create({
      email: 'f@firma.rs', name: 'F', role: 'admin', createdBy: 'test',
    });
    env.UserService.getById(user.userId);

    env.db.users[0].role = 'inspector';
    env.CacheService.getScriptCache().removeAll([`u:${user.userId}`]);

    // Fresh in Script Properties, so a hand edit is not seen yet. This is the
    // trade the window names out loud: change accounts through the screen.
    assert(env.UserService.getById(user.userId).role === 'admin',
      'the durable copy was skipped, which would put the sheet back on the path');
  });

  section('Switching it off:');

  check('a TTL of zero reads through every time', () => {
    const env = mirrored(0);
    const user = env.UserService.create({
      email: 'g@firma.rs', name: 'G', role: 'admin', createdBy: 'test',
    });
    env.UserService.getById(user.userId);

    env.db.users[0].role = 'inspector';
    assert(env.UserService.getById(user.userId).role === 'inspector',
      'something was remembered with mirroring disabled');
    assert(Object.keys(env.properties).filter(k => k.indexOf('am:') === 0).length === 0,
      'a durable copy was written with mirroring disabled');
  });

  section('Authorisation still behaves:');

  check('a disabled account is refused on a token issued beforehand', () => {
    const env = mirrored();
    const user = env.UserService.create({
      email: 'h@firma.rs', name: 'H', role: 'admin', createdBy: 'test',
    });
    const device = env.DeviceService.register(user.userId, 'Phone', 'test');
    const token = env.AuthService.generateSessionToken(
      user.userId, device.deviceId, device.nonce);

    env.AuthService.resolveAuth({ type: 'token', token: token });

    env.UserService.update(user.userId, { status: 'disabled' });
    expectError(env.HandoverError,
      () => env.AuthService.resolveAuth({ type: 'token', token: token }),
      'a disabled account was still resolved through the mirror');
  });

  check('demotion takes effect on a token issued beforehand', () => {
    const env = mirrored();
    const user = env.UserService.create({
      email: 'i@firma.rs', name: 'I', role: 'admin', createdBy: 'test',
    });
    const device = env.DeviceService.register(user.userId, 'Phone', 'test');
    const token = env.AuthService.generateSessionToken(
      user.userId, device.deviceId, device.nonce);

    assert(env.AuthService.resolveAuth({ type: 'token', token: token }).isAdmin,
      'setup: should start as admin');

    env.UserService.update(user.userId, { role: 'inspector' });
    assert(env.AuthService.resolveAuth({ type: 'token', token: token }).isAdmin === false,
      'admin rights survived demotion because the mirror was not cleared');
  });
};
