/**
 * api-timeouts.test.js
 * How long each call is given before it is abandoned.
 *
 * Sign-in ran on the default thirty seconds and outran it. A measured one spent
 * 20.2 s inside the handler, 15.4 s of that deriving the password hash — which
 * on a cold script costs an order of magnitude more than on a warm one — and
 * the cold start ahead of it is time the server never sees.
 *
 * The cost is not a slow screen. By the time the client gives up the server has
 * usually finished: the session is issued, the device row written, the sign-in
 * recorded. The person sees a failure they cannot tell from a wrong password,
 * signs in again, and writes a second device row for one sign-in — leaving the
 * device list describing something that did not happen. A timeout shorter than
 * the work manufactures the state it exists to prevent.
 *
 * These check the timeout each call is actually given, by watching the timer
 * the request arms rather than by reading api.js. A source scan would pass just
 * as happily if the constant were imported and then not used.
 */

const { section, check, assert } = require('./appsscript-stubs');

/**
 * Run a call with fetch and setTimeout replaced, and report the delay the
 * request armed its abort timer with.
 */
async function timeoutFor(api, invoke) {
  const realSetTimeout = global.setTimeout;
  const realFetch = global.fetch;
  const armed = [];

  global.setTimeout = (fn, ms, ...rest) => {
    armed.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  // Answers immediately and successfully, so the call finishes and clears its
  // timer instead of leaving one running for a minute and a half.
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: {} }),
  });

  try {
    await invoke(api);
  } finally {
    global.setTimeout = realSetTimeout;
    if (realFetch) global.fetch = realFetch; else delete global.fetch;
  }

  assert(armed.length > 0, 'the request armed no abort timer at all');
  return armed[0];
}

module.exports = async function run() {
  const { api, setAuth } = await import('../js/api.js');
  const config = await import('../js/config.js');

  // Every authenticated call refuses to go out without one.
  setAuth({ type: 'token', token: 'test-token' });

  section('The calls that derive a password hash get longer:');

  const derives = [
    ['login', (a) => a.login({ email: 'a@b.rs', password: 'x' })],
    ['setPassword', (a) => a.setPassword({ token: 't', password: 'x' })],
    ['changePassword', (a) => a.changePassword('old', 'new')],
  ];

  for (const [name, invoke] of derives) {
    // eslint-disable-next-line no-await-in-loop
    const ms = await timeoutFor(api, invoke);
    check(`${name} is given ${config.API_TIMEOUT_SIGN_IN} ms`, () => {
      assert(ms === config.API_TIMEOUT_SIGN_IN,
        `${name} was given ${ms} ms, so it can be abandoned while succeeding`);
    });
  }

  section('The ones that derive nothing stay on the default:');

  const cheap = [
    ['requestPasswordReset', (a) => a.requestPasswordReset('a@b.rs')],
    ['refreshSession', (a) => a.refreshSession('device-token')],
    ['getInspection', (a) => a.getInspection('INS-1')],
    ['me', (a) => a.me()],
  ];

  for (const [name, invoke] of cheap) {
    // eslint-disable-next-line no-await-in-loop
    const ms = await timeoutFor(api, invoke);
    check(`${name} is given the default`, () => {
      assert(ms === config.API_TIMEOUT_DEFAULT,
        `${name} was given ${ms}, expected ${config.API_TIMEOUT_DEFAULT}`);
    });
  }

  section('The slow ones keep the allowances they already had:');

  const slow = [
    ['uploadAttachment', (a) => a.uploadAttachment({ inspectionId: 'INS-1' }),
      () => config.API_TIMEOUT_UPLOAD],
    ['saveSignature', (a) => a.saveSignature({ inspectionId: 'INS-1' }),
      () => config.API_TIMEOUT_UPLOAD],
    ['finalizeInspection', (a) => a.finalizeInspection('INS-1'),
      () => config.API_TIMEOUT_FINALIZE],
  ];

  for (const [name, invoke, expected] of slow) {
    // eslint-disable-next-line no-await-in-loop
    const ms = await timeoutFor(api, invoke);
    check(`${name} keeps ${expected()} ms`, () => {
      assert(ms === expected(), `${name} was given ${ms}, expected ${expected()}`);
    });
  }

  section('The sign-in allowance covers what has actually been measured:');

  check('it is longer than the slowest sign-in seen', () => {
    // 20.2 s inside the handler, and a cold start ahead of it that the server
    // does not measure. A margin under two times that is not a margin.
    const SLOWEST_MEASURED_MS = 20219;
    assert(config.API_TIMEOUT_SIGN_IN >= SLOWEST_MEASURED_MS * 2,
      `${config.API_TIMEOUT_SIGN_IN} ms against a measured ${SLOWEST_MEASURED_MS} ms`);
  });

  check('and longer than the default it outran', () => {
    assert(config.API_TIMEOUT_SIGN_IN > config.API_TIMEOUT_DEFAULT,
      'sign-in is back on an allowance it has already been observed to exceed');
  });
};
