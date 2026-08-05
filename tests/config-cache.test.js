/**
 * config-cache.test.js
 * The real Config, over a Config sheet that counts how often it is read.
 *
 * This layer exists because of a circle that showed up in the measurements.
 * Resolving a session asks AuthMirror whether it may use a remembered row;
 * AuthMirror asks Config for the window; Config opened the workbook to answer.
 * The cache built to keep authentication off the spreadsheet had to touch the
 * spreadsheet to find out whether it was allowed to — so a `me` request that
 * read no rows at all still spent 1.1 s in auth.
 *
 * Two properties, and the second is the one with teeth. Repeated reads must not
 * reach the sheet. And a failed read must not be remembered, because caching an
 * empty map would pin every setting in the app to its default for the length of
 * the window on the strength of one bad moment.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

const ROWS = [
  { key: 'pbkdf2Iterations', value: '3000' },
  { key: 'authCacheTtlSeconds', value: '21600' },
  { key: 'passwordMinLength', value: 'passwordMinLength' },
  { key: 'sessionTtlHours', value: '' },
];

/**
 * @param shared  a previous run's cache store, to continue from — which is how
 *                a second request against the same installation is simulated
 */
function loadConfig(shared) {
  const counters = { sheetReads: 0, warnings: [] };
  const state = { rows: ROWS.slice(), fail: false };
  const store = shared || new Map();

  const ctx = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => 'set', setProperty: () => {} }),
    },
    SheetService: {
      getConfigRows: () => {
        counters.sheetReads++;
        if (state.fail) throw new Error('Config sheet unreadable');
        return state.rows;
      },
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (store.has(k) ? store.get(k) : null),
        put: (k, v) => { store.set(k, v); },
        remove: (k) => { store.delete(k); },
        removeAll: (keys) => { (keys || []).forEach(k => store.delete(k)); },
      }),
    },
    Utils: {
      log: (level, message, detail) => {
        if (level === 'WARN') counters.warnings.push(`${message} ${JSON.stringify(detail || {})}`);
      },
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });

  const code = fs.readFileSync(path.join(GAS_DIR, 'Config.gs'), 'utf8')
    + '\nglobalThis.__exports = { Config };';
  vm.runInContext(code, ctx);

  return { Config: ctx.__exports.Config, counters, state, store };
}

module.exports = function run() {

  section('Within one request:');

  check('many lookups cost one read', () => {
    const { Config, counters } = loadConfig();
    Config.getPbkdf2Iterations();
    Config.getAuthCacheTtlSeconds();
    Config.getSessionTtlHours();
    assert(counters.sheetReads === 1, `${counters.sheetReads} reads for three lookups`);
  });

  section('Across requests:');

  check('a second request does not read the sheet at all', () => {
    const first = loadConfig();
    first.Config.getPbkdf2Iterations();

    const second = loadConfig(first.store);
    second.Config.getPbkdf2Iterations();
    assert(second.counters.sheetReads === 0,
      'the second request opened the workbook to read config');
  });

  check('and gets the same values', () => {
    const first = loadConfig();
    first.Config.getPbkdf2Iterations();

    const second = loadConfig(first.store);
    assert(second.Config.getPbkdf2Iterations() === 3000,
      `read back ${second.Config.getPbkdf2Iterations()}`);
    assert(second.Config.getAuthCacheTtlSeconds() === 21600,
      'the auth window came back wrong, which would silently change how long rows are trusted');
  });

  check('invalidating sends the next request back to the sheet', () => {
    const first = loadConfig();
    first.Config.getPbkdf2Iterations();
    first.Config.invalidateCache();

    const second = loadConfig(first.store);
    second.Config.getPbkdf2Iterations();
    assert(second.counters.sheetReads === 1, 'the copy outlived the invalidation');
  });

  check('an edit made after invalidating is seen', () => {
    const first = loadConfig();
    first.Config.getPbkdf2Iterations();
    first.Config.invalidateCache();

    const second = loadConfig(first.store);
    second.state.rows = [{ key: 'pbkdf2Iterations', value: '2000' }];
    assert(second.Config.getPbkdf2Iterations() === 2000,
      'the superseded value was served');
  });

  section('A read that failed is not remembered:');

  check('the defaults apply, but only for that request', () => {
    const first = loadConfig();
    first.state.fail = true;
    assert(first.Config.getPbkdf2Iterations() === 1000, 'an unreadable sheet should fall back');

    // If the empty map had been cached, every setting in the app would sit at
    // its default until the window closed — on the strength of one bad read.
    const second = loadConfig(first.store);
    assert(second.Config.getPbkdf2Iterations() === 3000,
      'a failed read was cached, pinning the whole app to its defaults');
  });

  section('Values that cannot be read say so:');

  check('a non-numeric value falls back and warns', () => {
    const { Config, counters } = loadConfig();
    assert(Config.getPasswordMinLength() === 16, 'should fall back to the default');
    assert(counters.warnings.some(w => w.indexOf('passwordMinLength') >= 0),
      'the fallback was silent, which is how this went unnoticed for weeks');
  });

  check('an empty value falls back without warning', () => {
    // An empty cell is "not set", not "set to something wrong".
    const { Config, counters } = loadConfig();
    assert(Config.getSessionTtlHours() === 12, 'should fall back to the default');
    assert(!counters.warnings.some(w => w.indexOf('sessionTtlHours') >= 0),
      'an empty cell was reported as a fault');
  });
};
