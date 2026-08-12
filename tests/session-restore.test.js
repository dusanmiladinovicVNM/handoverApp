/**
 * session-restore.test.js
 * What opening the app does with the credentials on the device.
 *
 * Written after an iPhone signed in four times in eighty seconds. The audit log
 * showed four `login_succeeded` with `remembered: true` and no revocation of
 * any kind, which puts the fault on this side: the device was being asked for a
 * password while holding a device token good for sixty days.
 *
 * The cause is one `catch (_)`. Restoring a session could not tell a server
 * that said no from a server it never reached, and answered both by deleting
 * every credential on the device — so one bad moment on a cold start, which on
 * a phone is most of them, cost the remembered device permanently.
 *
 * So the rule these checks are about: forget a credential only when the server
 * has actually refused it. Nothing else — not a timeout, not a failed fetch,
 * not an unrecognised error — is allowed to reach clearTokens.
 */

const { section, check, assert } = require('./appsscript-stubs');

/** localStorage, close enough: string values, and it can be made to throw. */
function fakeLocalStorage() {
  const map = new Map();
  return {
    fail: false,
    getItem(k) {
      if (this.fail) throw new Error('SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (this.fail) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (this.fail) throw new Error('SecurityError');
      map.delete(k);
    },
    _map: map,
  };
}

/** Let the un-awaited background verification finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));

module.exports = async function run() {
  // location and history exist for navigate(), which the signed-out path calls.
  global.location = { hash: '#/' };
  global.history = { replaceState(_s, _t, target) { global.location.hash = target; } };
  global.navigator = { userAgent: 'node' };

  const auth = await import('../js/auth.js');
  const { api, ApiError } = await import('../js/api.js');
  const { getState, setState } = await import('../js/state.js');
  // Signing the user out navigates, and an unregistered route falls through to
  // a handler that draws into the DOM. The route is what is being exercised
  // here, not the page, so it is registered empty.
  const router = await import('../js/router.js');
  router.route('/login', () => {});

  const realApi = { me: api.me, refreshSession: api.refreshSession, login: api.login };

  const refuse = () => Promise.reject(new ApiError('UNAUTHORIZED', 'Please sign in again.'));
  const unreachable = () => Promise.reject(new ApiError('NETWORK_ERROR', 'Load failed'));
  const timeout = () => Promise.reject(new ApiError('NETWORK_TIMEOUT', "Request 'me' timed out."));

  const USER = { userId: 'USR-1', email: 'dmi@cpmh.ch', name: 'D M', role: 'inspector' };

  /**
   * A device that signed in and was remembered, then closed the app.
   * `stored` overrides what is on it when the app opens again.
   */
  function device(stored) {
    const storage = fakeLocalStorage();
    global.localStorage = storage;

    const held = Object.assign({ session: 'SESSION-1', device: 'DEVICE-1', profile: USER }, stored);
    if (held.session) storage.setItem('handover.sessionToken', held.session);
    if (held.device) storage.setItem('handover.deviceToken', held.device);
    if (held.profile) storage.setItem('handover.user', JSON.stringify(held.profile));

    setState({ authMode: 'unknown', user: null, authError: null });
    Object.assign(api, realApi);
    return storage;
  }

  const stored = (storage, key) => storage._map.get(`handover.${key}`) || null;

  section('A cold start that cannot reach the server:');

  await check('keeps the remembered device when verification fails on the network', async () => {
    const storage = device();
    api.me = unreachable;
    api.refreshSession = unreachable;

    const outcome = await auth.restoreSession();
    await settle();

    assert(outcome === 'user', `boot returned ${outcome} instead of drawing the app`);
    assert(stored(storage, 'deviceToken') === 'DEVICE-1',
      'the device token was deleted because a request did not arrive — this is ' +
      'the bug: the next launch has nothing left to restore from');
    assert(stored(storage, 'sessionToken') === 'SESSION-1', 'the session token went too');
    assert(getState().authMode === 'user',
      `dropped the user to ${getState().authMode} over a network failure`);
  });

  await check('and when it times out', async () => {
    const storage = device();
    api.me = timeout;
    api.refreshSession = timeout;

    await auth.restoreSession();
    await settle();

    assert(stored(storage, 'deviceToken') === 'DEVICE-1', 'a timeout cost the device token');
  });

  await check('and when there is no cached profile to draw from either', async () => {
    // This path awaits the network rather than deferring it, and used to end at
    // the same clearTokens().
    const storage = device({ profile: null });
    api.me = unreachable;
    api.refreshSession = unreachable;

    const outcome = await auth.restoreSession();

    assert(outcome === 'none', `returned ${outcome} without ever confirming a session`);
    assert(stored(storage, 'deviceToken') === 'DEVICE-1',
      'nothing was confirmed and nothing was refused, yet the credential is gone');
    assert(/could not reach/i.test(getState().authError || ''),
      `told the user: ${getState().authError}`);
  });

  section('A cold start the server answers:');

  await check('an expired session is exchanged for a new one', async () => {
    const storage = device();
    api.me = refuse;
    api.refreshSession = () => Promise.resolve({
      sessionToken: 'SESSION-2', user: USER, inspections: [],
    });

    await auth.restoreSession();
    await settle();

    assert(stored(storage, 'sessionToken') === 'SESSION-2', 'the fresh session was not stored');
    assert(stored(storage, 'deviceToken') === 'DEVICE-1', 'the device token was not kept');
    assert(getState().authMode === 'user', `ended at ${getState().authMode}`);
  });

  await check('a refused device token does clear everything', async () => {
    // The other half of the rule. A revoked device, a disabled account or a
    // password changed elsewhere all arrive as a refusal, and leaving a dead
    // credential in place would strand the user on a screen that cannot work.
    const storage = device();
    api.me = refuse;
    api.refreshSession = refuse;

    await auth.restoreSession();
    await settle();

    assert(!stored(storage, 'deviceToken'), 'a refused device token was kept');
    assert(!stored(storage, 'sessionToken'), 'a refused session token was kept');
    assert(getState().authMode === 'none', `left the user at ${getState().authMode}`);
  });

  await check('and so does a device that never held anything', async () => {
    const storage = device({ session: null, device: null, profile: USER });

    const outcome = await auth.restoreSession();

    assert(outcome === 'none', `returned ${outcome}`);
    assert(!stored(storage, 'user'),
      'no credential, but the remembered profile — a name and an address — stayed behind');
  });

  section('What the sign-in screen is told:');

  await check('storage that drops writes is caught at sign-in, not next launch', async () => {
    const storage = device({ session: null, device: null, profile: null });
    api.login = () => Promise.resolve({
      sessionToken: 'SESSION-1', deviceToken: 'DEVICE-1', user: USER,
    });
    storage.fail = true;

    await auth.login({ email: USER.email, password: 'x', remember: true });
    storage.fail = false;

    // Nothing was written, so nothing can be read — including the note itself.
    // storageUsable() is what answers this case, which is why it asks the
    // browser directly instead of consulting the record.
    assert(!stored(storage, 'deviceToken'), 'the fixture is wrong: the write went through');
    assert(auth.storageUsable() === true, 'the probe should pass once storage works again');

    storage.fail = true;
    assert(auth.storageUsable() === false,
      'a store that throws on write was reported as usable, so the sign-in screen ' +
      'would have no way to say why it keeps asking');
    storage.fail = false;
  });

  await check('an unreachable server is recorded as unreachable, not as a refusal', async () => {
    device();
    api.me = unreachable;
    api.refreshSession = unreachable;

    await auth.restoreSession();
    await settle();

    const last = auth.readLastRestore();
    assert(last && last.outcome === 'unverified',
      `recorded ${last && last.outcome}; the sign-in screen would name the wrong fault`);
    assert(last.hadDevice === true, 'the record says the device token was missing when it was not');
  });

  await check('a refusal is recorded as one', async () => {
    device();
    api.me = refuse;
    api.refreshSession = refuse;

    await auth.restoreSession();
    await settle();

    const last = auth.readLastRestore();
    assert(last && last.outcome === 'refused', `recorded ${last && last.outcome}`);
  });

  Object.assign(api, realApi);
};
