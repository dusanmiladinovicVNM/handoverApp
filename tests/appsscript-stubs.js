/**
 * appsscript-stubs.js
 *
 * Loads the real .gs sources into a sandbox with the Apps Script built-ins
 * replaced by Node equivalents, so the backend can be exercised without
 * deploying it.
 *
 * The point is to test the shipped code, not a copy of it — every service comes
 * from gas/ verbatim. Only the platform underneath is substituted: HMAC and
 * SHA-256 map onto node:crypto, and the spreadsheet becomes an array.
 */

/* eslint-env node */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const process = require('process');

const GAS_DIR = path.join(__dirname, '..', 'gas');

function toBuf(x) {
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  return Buffer.from(Array.from(x).map(b => (b < 0 ? b + 256 : b)));
}

/** Apps Script byte arrays are signed (-128..127); Node buffers are not. */
function toSigned(buf) {
  return Array.from(buf).map(b => (b > 127 ? b - 256 : b));
}

function buildUtilities() {
  return {
    computeHmacSha256Signature: (value, key) =>
      toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
    computeDigest: (_algorithm, input) =>
      toSigned(crypto.createHash('sha256').update(toBuf(input)).digest()),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    // Accepts a string or a byte array, like the real one — decoding a token
    // payload goes through the byte-array form.
    newBlob: (data) => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuf(data);
      return { getBytes: () => toSigned(buf), getDataAsString: () => buf.toString('utf8') };
    },
    base64Encode: (bytes) => toBuf(bytes).toString('base64'),
    base64Decode: (str) => toSigned(Buffer.from(str, 'base64')),
    base64EncodeWebSafe: (bytes) =>
      toBuf(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64DecodeWebSafe: (str) =>
      toSigned(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    getUuid: () => crypto.randomUUID(),
  };
}

/** In-memory stand-in for SheetService, holding only what the tests touch. */
function buildSheetService(db) {
  return {
    getUser: (id) => db.users.find(u => u.userId === id) || null,
    getUserByEmail: (email) =>
      db.users.find(u => u.email === String(email).trim().toLowerCase()) || null,
    createUser: (user) => { db.users.push(user); },
    updateUser: (id, patch) => {
      const user = db.users.find(u => u.userId === id);
      if (!user) throw new Error(`no such user: ${id}`);
      return Object.assign(user, patch);
    },
    listUsers: () => db.users.slice(),

    getDevice: (id) => db.devices.find(d => d.deviceId === id) || null,
    createDevice: (device) => { db.devices.push(device); },
    updateDevice: (id, patch) => {
      const device = db.devices.find(d => d.deviceId === id);
      if (!device) throw new Error(`no such device: ${id}`);
      return Object.assign(device, patch);
    },
    getDevicesForUser: (userId, includeRevoked) =>
      db.devices.filter(d => d.userId === userId && (includeRevoked || !d.revokedAt)),
    listDevices: () => db.devices.slice(),
    revokeDevicesForUser: (userId) => {
      const hit = db.devices.filter(d => d.userId === userId && !d.revokedAt);
      hit.forEach(d => { d.revokedAt = new Date().toISOString(); });
      return hit.map(d => d.deviceId);
    },

    getInspection: (id) => db.inspections.find(i => i.inspectionId === id) || null,
    createInspection: (inspection) => { db.inspections.push(inspection); },
    updateInspection: (id, patch) => {
      const inspection = db.inspections.find(i => i.inspectionId === id);
      if (!inspection) throw new Error(`no such inspection: ${id}`);
      return Object.assign(inspection, patch);
    },

    appendAuditEvent: (event) => { db.auditLog.push(event); },
    getAuditEventsForInspection: (id) => db.auditLog.filter(e => e.inspectionId === id),
    getAuthAuditEvents: () => db.auditLog.filter(e => !e.inspectionId),
  };
}

/**
 * Caching is off by default. A cached user row would mask exactly the
 * behaviour most of these tests are about — that authority is re-read per
 * request — so the default makes every lookup hit the store.
 */
function buildCacheService(enabled) {
  const store = new Map();
  return {
    getScriptCache: () => ({
      get: (k) => (enabled && store.has(k) ? store.get(k) : null),
      put: (k, v) => { if (enabled) store.set(k, v); },
      remove: (k) => { store.delete(k); },
      removeAll: (keys) => { (keys || []).forEach(k => store.delete(k)); },
    }),
    _store: store,
  };
}

/**
 * @param overrides  config values to change from the defaults below
 * @param options    { cache: true } to exercise the caching path
 */
function createEnvironment(overrides, options) {
  options = options || {};

  const db = { users: [], devices: [], inspections: [], auditLog: [] };
  const mail = { sent: [], failNext: false };
  const properties = {};

  const config = Object.assign({
    tokenSecret: 'test-secret-not-a-real-one',
    // Low on purpose: these tests are about behaviour, not work factor, and a
    // realistic setting would make the suite crawl.
    pbkdf2Iterations: 100,
    passwordMinLength: 16,
    sessionTtlHours: 12,
    deviceTtlDays: 60,
    setPasswordTtlHours: 48,
    loginMaxFailures: 5,
    loginLockMinutes: 15,
    // Mirroring off by default. A remembered row would mask exactly the
    // property most of these tests exist to protect — that role and status are
    // re-read per request — so the default reads through to the store every
    // time. auth-mirror.test.js turns it on deliberately.
    authCacheTtlSeconds: 0,
  }, overrides || {});

  const Config = {
    getTokenSecret: () => config.tokenSecret,
    getPbkdf2Iterations: () => config.pbkdf2Iterations,
    getPasswordMinLength: () => config.passwordMinLength,
    getSessionTtlHours: () => config.sessionTtlHours,
    getDeviceTtlDays: () => config.deviceTtlDays,
    getSetPasswordTtlHours: () => config.setPasswordTtlHours,
    getLoginMaxFailures: () => config.loginMaxFailures,
    getLoginLockMinutes: () => config.loginLockMinutes,
    getAuthCacheTtlSeconds: () => config.authCacheTtlSeconds,
    getFrontendUrl: () => 'https://example.test/app/',
    getString: (_k, fallback) => fallback,
    getNumber: (_k, fallback) => fallback,
  };

  const sandbox = {
    Utilities: buildUtilities(),
    SheetService: buildSheetService(db),
    CacheService: buildCacheService(!!options.cache),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in properties ? properties[k] : null),
        setProperty: (k, v) => { properties[k] = v; },
        deleteProperty: (k) => { delete properties[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: {
      sendEmail: (msg) => {
        if (mail.failNext) {
          mail.failNext = false;
          throw new Error('Specified permissions are not sufficient to call MailApp.sendEmail');
        }
        mail.sent.push(msg);
      },
    },
    Config,
    // The services log freely at INFO and WARN, which would bury the results.
    // Errors still come through, and VERBOSE=1 restores the rest.
    console: process.env.VERBOSE
      ? console
      : { log: () => {}, warn: () => {}, error: console.error },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  };

  const ctx = vm.createContext(sandbox);

  // Order matters only for `const` visibility at load time, not for the code
  // under test — Router.gs proves that by resolving its services lazily.
  const sources = [
    'Utils.gs', 'PasswordService.gs', 'AuthMirror.gs', 'UserService.gs',
    'DeviceService.gs', 'MailService.gs', 'AuditService.gs', 'AuthService.gs',
    'AccountService.gs', 'UserAdminService.gs',
  ];
  const code = sources
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8'))
    .join('\n')
    // `const` at script top level is lexical, so the values have to be handed
    // out explicitly rather than read off the context.
    + '\nglobalThis.__exports = { Utils, PasswordService, AuthMirror, UserService, ' +
      'DeviceService, MailService, AuditService, AuthService, AccountService, ' +
      'UserAdminService, HandoverError };';

  vm.runInContext(code, ctx);

  // audit.events is the same array the log writes into, not a copy.
  return Object.assign({}, ctx.__exports, {
    db, mail, config, properties, audit: { events: db.auditLog },
    // Exposed so auth-mirror.test.js can age or evict a copy the way the
    // platform would, rather than waiting six hours.
    CacheService: sandbox.CacheService,
  });
}

// --- Minimal assertion helpers ---

const state = { failures: 0, total: 0 };

function section(title) {
  console.log(`\n${title}`);
}

function check(name, fn) {
  state.total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    state.failures++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

/** Assert that fn() throws a HandoverError, and return it. */
function expectError(HandoverError, fn, note) {
  try {
    fn();
  } catch (e) {
    assert(e instanceof HandoverError, `threw ${e.name} instead of HandoverError: ${e.message}`);
    return e;
  }
  throw new Error(note || 'expected a rejection, but the call succeeded');
}

function summary() {
  console.log(state.failures
    ? `\n${state.failures} of ${state.total} check(s) failed.\n`
    : `\nAll ${state.total} checks passed.\n`);
  return state.failures;
}

module.exports = {
  createEnvironment, section, check, assert, expectError, summary, state,
};
