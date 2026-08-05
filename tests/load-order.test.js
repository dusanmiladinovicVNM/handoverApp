/**
 * load-order.test.js
 * Loads every .gs file in alphabetical order and checks nothing blows up.
 *
 * Apps Script shares one global scope across files but evaluates them in order,
 * and every service is declared with `const`, so a name stays in the temporal
 * dead zone until its own file has run. Any file that dereferences another
 * service while loading therefore works or throws depending purely on where it
 * sits in that order — and the order shifts whenever a file is added.
 *
 * That is not hypothetical: adding the account services moved Router.gs ahead
 * of SignatureService.gs and bootstrapSheet() started failing with
 * "SignatureService is not defined", in a call that has nothing to do with
 * signatures. Alphabetical order is used here because it is a plausible worst
 * case; the point is that no order should matter.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * Enough of the platform for files to *load*. Nothing here needs to behave
 * correctly — if a stub is ever actually called, that is itself the finding,
 * because it means a file is doing real work at load time.
 */
function buildLoadTimeGlobals() {
  const notAtLoadTime = (name) => () => {
    throw new Error(`${name} was called while files were still loading`);
  };

  return {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => null, setProperty: () => {}, deleteProperty: () => {},
      }),
    },
    SpreadsheetApp: { openById: notAtLoadTime('SpreadsheetApp.openById') },
    DriveApp: { getFileById: notAtLoadTime('DriveApp.getFileById') },
    DocumentApp: { openById: notAtLoadTime('DocumentApp.openById') },
    MailApp: { sendEmail: notAtLoadTime('MailApp.sendEmail') },
    UrlFetchApp: { fetch: notAtLoadTime('UrlFetchApp.fetch') },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {}, removeAll: () => {} }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: notAtLoadTime('ContentService.createTextOutput'), MimeType: { JSON: 'JSON' } },
    HtmlService: { createHtmlOutput: notAtLoadTime('HtmlService.createHtmlOutput') },
    Session: { getActiveUser: notAtLoadTime('Session.getActiveUser') },
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => '00000000-0000-4000-8000-000000000000',
      computeHmacSha256Signature: () => [],
      computeDigest: () => [],
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      newBlob: () => ({ getBytes: () => [], getDataAsString: () => '' }),
      base64Encode: () => '', base64Decode: () => [],
      base64EncodeWebSafe: () => '', base64DecodeWebSafe: () => [],
      sleep: () => {},
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  };
}

module.exports = function run() {
  const files = fs.readdirSync(GAS_DIR).filter(f => f.endsWith('.gs')).sort();

  section('Every file loads regardless of order:');

  check(`all ${files.length} .gs files load in alphabetical order`, () => {
    const ctx = vm.createContext(buildLoadTimeGlobals());
    for (const file of files) {
      try {
        vm.runInContext(fs.readFileSync(path.join(GAS_DIR, file), 'utf8'), ctx, {
          filename: file,
        });
      } catch (e) {
        throw new Error(
          `${file} failed to load: ${e.message}\n` +
          '        A service is being dereferenced at load time. Wrap the ' +
          'reference in a function so it resolves when called.'
        );
      }
    }
  });

  section('Routing table:');

  const ctx = vm.createContext(buildLoadTimeGlobals());
  files.forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(
    'globalThis.__exports = { Router, PUBLIC_ACTIONS };', ctx);
  const { Router, PUBLIC_ACTIONS } = ctx.__exports;

  check('the routing table is readable once everything has loaded', () => {
    const actions = Router.listActions();
    assert(actions.length > 0, 'no actions registered');
    ['login', 'setPassword', 'saveSignature', 'finalizeInspection']
      .forEach(a => assert(actions.indexOf(a) >= 0, `missing route: ${a}`));
  });

  check('every unauthenticated action is a real route', () => {
    const actions = Router.listActions();
    PUBLIC_ACTIONS.forEach(a => assert(actions.indexOf(a) >= 0,
      `PUBLIC_ACTIONS lists "${a}", which is not a route — a typo here silently ` +
      'exempts nothing, or exempts the wrong thing'));
  });

  check('nothing unexpected has been made public', () => {
    const expected = ['login', 'requestPasswordReset', 'setPassword', 'refreshSession'];
    const unexpected = PUBLIC_ACTIONS.filter(a => expected.indexOf(a) < 0);
    assert(unexpected.length === 0,
      `these actions run without authentication and should not: ${unexpected.join(', ')}`);
  });
};
