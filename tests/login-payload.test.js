/**
 * login-payload.test.js
 * Signing in answers the question the app is about to ask.
 *
 * Sign-in was two requests in a row: login, and then listInspections, because
 * the first did not answer the second. On Apps Script a request costs about
 * three seconds before it does any work — /exec answers 302, the body is served
 * from another host, and each call is its own execution with its own cold
 * start. The measured sign-in step was 11.5 s, of which roughly 6 s was the two
 * round trips. Building the list inside the request that is already happening
 * costs two sheet reads.
 *
 * The reason this file exists is the second property, not the first.
 *
 * The session has been issued, the device row written and the audit event
 * recorded by the time the list is built. If building it could fail the
 * response, a slow sheet or a bad schema would deny someone a session they
 * actually hold — and the app would sign in again, writing a second device row
 * for one sign-in. So every path here has to survive its list blowing up.
 */

const { createEnvironment, section, check, assert } = require('./appsscript-stubs');

/** A list service that answers, and remembers what it was asked. */
function listing(rows) {
  const asked = [];
  return {
    asked,
    service: {
      listInspections(authCtx, data) {
        asked.push({ authCtx, data });
        return { inspections: rows, totalCount: rows.length };
      },
    },
  };
}

const EXPLODES = {
  listInspections() { throw new Error('the Inspections sheet did not answer'); },
};

const PASSWORD = 'kisa pada trava raste';

/** A signed-in user, and the environment it lives in. */
function signedIn(inspectionService) {
  const env = createEnvironment(null, { inspectionService });
  const user = env.UserService.create({
    email: 'ana@firma.rs', name: 'Ana', role: 'inspector', createdBy: 'test',
  });
  env.AccountService.setPassword(null, {
    token: env.AuthService.generateSetPasswordToken(user), password: PASSWORD,
  });
  return env;
}

const login = (env, extra) => env.AccountService.login(
  null, Object.assign({ email: 'ana@firma.rs', password: PASSWORD }, extra || {}));

module.exports = function run() {

  section('The session arrives with the first page of the list:');

  check('login carries it', () => {
    const { service } = listing([{ inspectionId: 'INS-1' }, { inspectionId: 'INS-2' }]);
    const result = login(signedIn(service));
    assert(Array.isArray(result.inspections), 'no list came with the session');
    assert(result.inspections.length === 2, `${result.inspections.length} rows`);
    assert(result.totalCount === 2, `totalCount was ${result.totalCount}`);
  });

  check('setting a password from a mailed link carries it too', () => {
    // That link is the first sign-in of a new account, and it lands on the same
    // screen as any other.
    const { service } = listing([{ inspectionId: 'INS-1' }]);
    const env = createEnvironment(null, { inspectionService: service });
    const user = env.UserService.create({
      email: 'new@firma.rs', name: 'New', role: 'inspector', createdBy: 'test',
    });
    const result = env.AccountService.setPassword(null, {
      token: env.AuthService.generateSetPasswordToken(user), password: PASSWORD,
    });
    assert(Array.isArray(result.inspections), 'no list after setting a password');
  });

  check('refreshing a remembered device carries it', () => {
    // The boot path when the app is reopened days later. It lands on the list
    // as surely as a fresh sign-in does.
    const { service } = listing([{ inspectionId: 'INS-1' }]);
    const env = signedIn(service);
    const remembered = login(env, { remember: true });
    const refreshed = env.AccountService.refreshSession(
      null, { deviceToken: remembered.deviceToken });
    assert(Array.isArray(refreshed.inspections), 'no list on refresh');
  });

  check('it is the page the list screen asks for, in the same order', () => {
    // A different page or order would show one list and then rearrange itself
    // the moment the screen refreshed.
    //
    // Counted as a delta, because setting the password to create this account
    // is itself a sign-in and has already built one.
    const { service, asked } = listing([]);
    const env = signedIn(service);
    const before = asked.length;
    login(env);
    assert(asked.length - before === 1,
      `the list was built ${asked.length - before} times for one sign-in`);
    const data = asked[asked.length - 1].data;
    assert(data.page === 0 && data.pageSize === 100, `page ${data.page}/${data.pageSize}`);
    assert(data.sortBy === 'updatedAt' && data.sortOrder === 'desc',
      `sorted by ${data.sortBy} ${data.sortOrder}`);
  });

  section('The list is built for the person signing in, not for anyone:');

  check('the context carries their identity and role, read from the sheet', () => {
    const { service, asked } = listing([]);
    login(signedIn(service));
    const ctx = asked[asked.length - 1].authCtx;
    assert(ctx.email === 'ana@firma.rs', `built for ${ctx.email}`);
    assert(ctx.role === 'inspector' && ctx.isAdmin === false,
      `role ${ctx.role}, isAdmin ${ctx.isAdmin}`);
    assert(ctx.userId, 'no userId, so visibility filtering has nothing to filter by');
    assert(ctx.deviceId, 'no deviceId');
  });

  check('an admin gets an admin context', () => {
    const { service, asked } = listing([]);
    const env = createEnvironment(null, { inspectionService: service });
    const user = env.UserService.create({
      email: 'boss@firma.rs', name: 'Boss', role: 'admin', createdBy: 'test',
    });
    env.AccountService.setPassword(null, {
      token: env.AuthService.generateSetPasswordToken(user), password: PASSWORD,
    });
    env.AccountService.login(null, { email: 'boss@firma.rs', password: PASSWORD });
    const ctx = asked[asked.length - 1].authCtx;
    assert(ctx.isAdmin === true, 'an admin was given a non-admin context');
  });

  check('it is the same shape resolving a token produces', () => {
    // Two hand-assembled copies of a context would agree until the day a field
    // is added to one of them, and the one that is missing it decides what
    // somebody may see.
    const { service, asked } = listing([]);
    const env = signedIn(service);
    const result = login(env);
    const resolved = env.AuthService.resolveAuth(
      { type: 'token', token: result.sessionToken });

    // The last one, which is the sign-in whose token is being resolved — the
    // earlier one belongs to the setPassword that created the account, and
    // carries that sign-in's device.
    const built = asked[asked.length - 1].authCtx;
    Object.keys(resolved).forEach(field => {
      assert(field in built, `the sign-in context has no ${field}`);
      assert(String(built[field]) === String(resolved[field]),
        `${field} was '${built[field]}', resolved to '${resolved[field]}'`);
    });
  });

  section('A list that fails does not cost anyone their session:');

  check('login still returns a working session', () => {
    const env = signedIn(EXPLODES);
    let result = null;
    let threw = null;
    try { result = login(env); } catch (e) { threw = e; }

    assert(!threw, `sign-in threw ${threw && threw.message}`);
    assert(result.sessionToken, 'no session token');
    assert(!('inspections' in result), 'a broken list was attached anyway');
    // The token has to actually work, not merely be present.
    env.AuthService.resolveAuth({ type: 'token', token: result.sessionToken });
  });

  check('setting a password still returns one', () => {
    const env = createEnvironment(null, { inspectionService: EXPLODES });
    const user = env.UserService.create({
      email: 'new@firma.rs', name: 'New', role: 'inspector', createdBy: 'test',
    });
    const result = env.AccountService.setPassword(null, {
      token: env.AuthService.generateSetPasswordToken(user), password: PASSWORD,
    });
    assert(result.sessionToken, 'a failed list cost a new account its first session');
  });

  check('refreshing still returns one', () => {
    const good = listing([]);
    const env = signedIn(good.service);
    const remembered = login(env, { remember: true });
    // The list breaks between signing in and coming back.
    env.sandbox.InspectionService = EXPLODES;
    const refreshed = env.AccountService.refreshSession(
      null, { deviceToken: remembered.deviceToken });
    assert(refreshed.sessionToken, 'a failed list ended a remembered session');
  });

  check('and the sign-in is still recorded exactly once', () => {
    // The audit event is written before the list is built. If a failure here
    // could unwind the response, the record would say someone signed in when
    // they were told they had not.
    //
    // A delta again: creating the account signed it in once already.
    const env = signedIn(EXPLODES);
    const count = () =>
      env.audit.events.filter(e => e.eventType === 'login_succeeded').length;
    const before = count();
    login(env);
    assert(count() - before === 1, `${count() - before} login_succeeded events`);
  });

  check('a device row is written once, not once per retry', () => {
    // The failure this guards against is the app treating a thrown response as
    // "not signed in" and signing in again.
    const env = signedIn(EXPLODES);
    const before = env.db.devices.length;
    login(env);
    assert(env.db.devices.length - before === 1,
      `${env.db.devices.length - before} devices for one sign-in`);
  });
};
