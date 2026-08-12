/**
 * timing-visibility.test.js
 * Who is shown how long a request took inside, and who is not.
 *
 * The breakdown names internal costs — which sheets were read, how many writes,
 * how long the password hash took — so it goes to admins and nobody else.
 *
 * The sign-in actions had no way to qualify. They are dispatched with no
 * context at all, on purpose, so the admin check found nothing to look at and
 * every sign-in came back without timing. That left the slowest request in the
 * app, measured near ten seconds, as the one request whose inside could not be
 * seen — which is a bad thing to be blind to when three earlier assumptions
 * about this backend have already been corrected by measurement.
 *
 * A successful sign-in has just proved who the caller is, so identity is read
 * from the reply. The risk that creates is the whole point of this file: a
 * result is not a context, and treating one as the other anywhere else would
 * let a handler that returns some other user decide what its caller may see.
 * Hence the narrowing to public actions, and hence the checks below that try
 * to get past it.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

function load() {
  const ctx = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });
  vm.runInContext(
    fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8')
    + '\nglobalThis.__exports = { _maySeeTiming, _actorFor, PUBLIC_ACTIONS };',
    ctx);
  return ctx.__exports;
}

const ADMIN_CTX = { isAdmin: true, actorString: 'user:boss@firma.rs' };
const STAFF_CTX = { isAdmin: false, actorString: 'user:ana@firma.rs' };
const TENANT_CTX = { isAdmin: false, actorString: 'tenant_token:abc12345' };

const adminReply = { user: { email: 'boss@firma.rs', role: 'admin' }, sessionToken: 't' };
const staffReply = { user: { email: 'ana@firma.rs', role: 'inspector' }, sessionToken: 't' };

module.exports = function run() {
  const { _maySeeTiming, _actorFor, PUBLIC_ACTIONS } = load();

  section('With a session, the context decides:');

  check('an admin sees the breakdown', () => {
    assert(_maySeeTiming(ADMIN_CTX, false, {}) === true, 'an admin was refused');
  });

  check('an inspector does not', () => {
    assert(_maySeeTiming(STAFF_CTX, false, {}) === false, 'timing leaked to staff');
  });

  check('nor does a tenant link', () => {
    assert(_maySeeTiming(TENANT_CTX, false, {}) === false, 'timing leaked to a tenant');
  });

  check('a reply naming an admin cannot promote a caller who is not one', () => {
    // setUserRole and createUser both answer with a user object, and both are
    // reached with a real context. If the reply were consulted there, a handler
    // returning somebody else would decide what its caller is shown.
    assert(_maySeeTiming(STAFF_CTX, false, adminReply) === false,
      'an inspector saw the breakdown because the reply mentioned an admin');
  });

  section('Signing in has no context, so the proved identity decides:');

  check('an admin signing in sees the breakdown', () => {
    assert(_maySeeTiming(null, true, adminReply) === true,
      'the slowest request in the app is still unmeasurable');
  });

  check('an inspector signing in does not', () => {
    assert(_maySeeTiming(null, true, staffReply) === false, 'timing leaked to staff');
  });

  check('and a reply with no user at all does not', () => {
    // requestPasswordReset is public and answers without one, deliberately.
    [{}, { user: null }, { user: {} }, { user: { role: '' } }].forEach(reply => {
      assert(_maySeeTiming(null, true, reply) === false,
        `${JSON.stringify(reply)} was shown the breakdown`);
    });
  });

  check('a missing result is not an error', () => {
    assert(_maySeeTiming(null, true, null) === false, 'null result threw or passed');
    assert(_maySeeTiming(null, true, undefined) === false, 'undefined result threw or passed');
  });

  section('The result is consulted only where there is no context to consult:');

  check('an action that is not public is refused outright', () => {
    // The belt to the braces above. Even handed an admin-looking reply, an
    // action that had a context available must be judged on that context.
    assert(_maySeeTiming(null, false, adminReply) === false,
      'a non-public action was judged by its own reply');
  });

  check('the public list is still only the sign-in actions', () => {
    // This test exists because the rule above is "public actions may be judged
    // by their reply". Widening that list widens this, so the list is pinned
    // here rather than left to be noticed later.
    assert(PUBLIC_ACTIONS.slice().sort().join(',')
      === ['login', 'refreshSession', 'requestPasswordReset', 'setPassword'].join(','),
      `PUBLIC_ACTIONS is now ${PUBLIC_ACTIONS.join(', ')}`);
  });

  section('The log names who it was:');

  check('a session is named by its context', () => {
    assert(_actorFor(ADMIN_CTX, false, {}) === 'user:boss@firma.rs',
      _actorFor(ADMIN_CTX, false, {}));
  });

  check('a successful sign-in is named by the account it proved', () => {
    // 'anonymous' was right for a failed attempt and wrong for a successful
    // one, which left the record of the app's slowest request naming nobody.
    assert(_actorFor(null, true, staffReply) === 'user:ana@firma.rs',
      _actorFor(null, true, staffReply));
  });

  check('a sign-in that proved nothing stays anonymous', () => {
    assert(_actorFor(null, true, {}) === 'anonymous', 'named an account that did not sign in');
    assert(_actorFor(null, true, null) === 'anonymous', 'null result threw or named someone');
  });
};
