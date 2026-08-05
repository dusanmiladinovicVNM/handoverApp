/**
 * sheet-cache.test.js
 * The real SheetService, over a fake spreadsheet that counts round trips.
 *
 * Everything else in this suite replaces SheetService with an in-memory stub,
 * which means the file doing the actual reading and writing has had no cover at
 * all. That is the file where a caching mistake shows up as stale data rather
 * than as a crash — the kind that is only noticed once something has been saved
 * over.
 *
 * So this counts getValues() calls, because that is what the latency is made
 * of, and then checks the cache tells the truth after every kind of write.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * A spreadsheet that behaves like the real one for the operations used here,
 * and keeps a tally of how often it was asked for data.
 *
 * @param data  { SheetName: rows } with the header as row 0
 */
function fakeSpreadsheet(data, counters) {
  function rangeFor(name, row, col, numRows, numCols) {
    return {
      getValues() {
        counters.reads++;
        counters.readsBySheet[name] = (counters.readsBySheet[name] || 0) + 1;
        const out = [];
        for (let r = row - 1; r < row - 1 + numRows; r++) {
          out.push((data[name][r] || []).slice(col - 1, col - 1 + numCols));
        }
        return out;
      },
      setValues(values) {
        counters.writes++;
        for (let r = 0; r < values.length; r++) {
          const target = data[name][row - 1 + r] || (data[name][row - 1 + r] = []);
          for (let c = 0; c < values[r].length; c++) target[col - 1 + c] = values[r][c];
        }
      },
      setValue(value) {
        counters.writes++;
        const target = data[name][row - 1] || (data[name][row - 1] = []);
        target[col - 1] = value;
      },
    };
  }

  function sheetFor(name) {
    return {
      getLastRow: () => data[name].length,
      getRange: (row, col, numRows, numCols) =>
        rangeFor(name, row, col, numRows === undefined ? 1 : numRows,
          numCols === undefined ? 1 : numCols),
      appendRow: (row) => { counters.writes++; data[name].push(row.slice()); },
    };
  }

  return {
    openById: () => ({
      getSheetByName: (name) => (data[name] ? sheetFor(name) : null),
    }),
  };
}

/** A fresh SheetService, as if a new request had just started. */
function loadSheetService(data) {
  const counters = { reads: 0, writes: 0, readsBySheet: {} };

  const ctx = vm.createContext({
    SpreadsheetApp: fakeSpreadsheet(data, counters),
    Config: { getWorkbookId: () => 'fake-workbook' },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => '00000000-0000-4000-8000-000000000000' },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }),
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });

  const code = ['Utils.gs', 'SheetService.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { SheetService };';
  vm.runInContext(code, ctx);

  return { SheetService: ctx.__exports.SheetService, counters, data };
}

function seed() {
  return {
    Users: [
      ['userId', 'email', 'name', 'role', 'status', 'passHash', 'passSetAt',
       'failedCount', 'lockedUntil', 'createdAt', 'createdBy', 'disabledAt',
       'disabledBy', 'lastLoginAt', 'notes'],
      ['USR-2026-000001', 'ana@firma.rs', 'Ana', 'admin', 'active', '', '', 0, '',
       '2026-01-01', 'test', '', '', '', ''],
      ['USR-2026-000002', 'bob@firma.rs', 'Bob', 'inspector', 'active', '', '', 0, '',
       '2026-01-01', 'test', '', '', '', ''],
    ],
    Devices: [
      ['deviceId', 'userId', 'label', 'nonce', 'createdAt', 'lastSeenAt',
       'expiresAt', 'revokedAt', 'revokedBy', 'userAgent'],
      ['DEV-2026-000001', 'USR-2026-000002', 'iPhone', 'n1', '2026-01-01',
       '2026-01-01', '2030-01-01', '', '', 'test'],
      ['DEV-2026-000002', 'USR-2026-000002', 'Mac', 'n2', '2026-01-01',
       '2026-01-01', '2030-01-01', '', '', 'test'],
    ],
  };
}

module.exports = function run() {
  section('Reads are shared within one execution:');

  check('a repeated lookup costs one round trip, not two', () => {
    const { SheetService, counters } = loadSheetService(seed());
    SheetService.getUser('USR-2026-000001');
    const after = counters.reads;
    SheetService.getUser('USR-2026-000002');
    SheetService.getUser('USR-2026-000001');
    assert(counters.reads === after, `${counters.reads - after} extra read(s)`);
  });

  check('one lookup is one round trip', () => {
    // It used to be two: the key column, then the matching row. Halving that
    // matters because the count, not the size, is what costs the time.
    const { SheetService, counters } = loadSheetService(seed());
    SheetService.getUser('USR-2026-000002');
    assert(counters.reads === 1, `${counters.reads} reads for a single lookup`);
  });

  check('different sheets are cached independently', () => {
    const { SheetService, counters } = loadSheetService(seed());
    SheetService.getUser('USR-2026-000001');
    SheetService.getDevice('DEV-2026-000001');
    assert(counters.readsBySheet.Users === 1, 'Users read more than once');
    assert(counters.readsBySheet.Devices === 1, 'Devices read more than once');
  });

  check('a whole-sheet listing reuses what a lookup already read', () => {
    const { SheetService, counters } = loadSheetService(seed());
    SheetService.getUserByEmail('ana@firma.rs');
    const after = counters.reads;
    SheetService.listUsers();
    assert(counters.reads === after, 'listUsers went back to the sheet');
  });

  section('Writes make the cache tell the truth again:');

  check('an update is visible to the next read', () => {
    const { SheetService } = loadSheetService(seed());
    SheetService.getUser('USR-2026-000002');
    SheetService.updateUser('USR-2026-000002', { name: 'Bob Renamed' });
    assert(SheetService.getUser('USR-2026-000002').name === 'Bob Renamed',
      'the stale name survived the write');
  });

  check('an append is visible to the next read', () => {
    const { SheetService } = loadSheetService(seed());
    SheetService.listUsers();
    SheetService.createUser({
      userId: 'USR-2026-000003', email: 'new@firma.rs', name: 'New',
      role: 'inspector', status: 'active',
    });
    assert(SheetService.listUsers().length === 3, 'the new row was not seen');
    assert(SheetService.getUserByEmail('new@firma.rs'), 'lookup missed the new row');
  });

  check('a cell-level write is visible too', () => {
    // revokeDevicesForUser writes cells directly rather than whole rows, so it
    // has to invalidate on its own — the generic helpers never see it.
    const { SheetService } = loadSheetService(seed());
    assert(SheetService.getDevicesForUser('USR-2026-000002', false).length === 2,
      'setup: expected two live devices');

    SheetService.revokeDevicesForUser('USR-2026-000002', 'test');
    assert(SheetService.getDevicesForUser('USR-2026-000002', false).length === 0,
      'revoked devices still read as active');
    assert(SheetService.getDevicesForUser('USR-2026-000002', true).length === 2,
      'the rows themselves disappeared');
  });

  check('the row index used for an update still points at the right row', () => {
    const { SheetService, data } = loadSheetService(seed());
    SheetService.updateUser('USR-2026-000002', { name: 'Second' });
    assert(data.Users[1][2] === 'Ana', `row 1 became ${data.Users[1][2]}`);
    assert(data.Users[2][2] === 'Second', `row 2 became ${data.Users[2][2]}`);
  });

  section('Edge cases:');

  check('an empty sheet reads as no rows, and stays cheap', () => {
    const empty = seed();
    empty.Users = [empty.Users[0]];
    const { SheetService, counters } = loadSheetService(empty);
    assert(SheetService.listUsers().length === 0, 'phantom rows');
    assert(SheetService.getUser('USR-2026-000001') === null, 'found a row that is not there');
    assert(counters.reads === 0, 'read a sheet that has only a header');
  });

  check('a missing key returns null rather than throwing', () => {
    const { SheetService } = loadSheetService(seed());
    assert(SheetService.getUser('USR-NOPE') === null, 'unknown id did not return null');
    assert(SheetService.getUserByEmail('nobody@firma.rs') === null, 'unknown email did not return null');
  });
};
