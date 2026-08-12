/**
 * cell-values.test.js
 * A value written to a cell comes back as the value that was written.
 *
 * A tenant's phone number did not. `+381 60 123 45 67` reaches a sheet cell
 * through appendRow, and a leading plus makes Sheets try to evaluate it — so
 * the cell keeps #ERROR! and the number is gone. Silently: nothing in the app
 * complains, and the final PDF would print #ERROR! where a phone number
 * belongs, in a document whose only purpose is to be evidence later.
 *
 * It was found by comparing 5 603 cells of a live workbook against a second way
 * of reading them, which is not a thing anyone does twice. Hence this file.
 *
 * A leading apostrophe is Sheets' own marker for "treat this as text". It is
 * not part of the value and does not come back from getValues, so it is the
 * cheapest correct fix — but it must be applied to strings only. Five
 * comparisons in SheetService are against the literal `true`, and one against a
 * number; putting an apostrophe in front of those would break them in exactly
 * the way this is meant to prevent.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * A spreadsheet that records what it was asked to store, and reads it back the
 * way Sheets does — stripping the leading apostrophe, because that is what
 * makes the fix work and what a test asserting on the raw cell would miss.
 */
function recordingSpreadsheet(data, written) {
  const strip = (v) =>
    (typeof v === 'string' && v.charAt(0) === "'") ? v.slice(1) : v;

  const sheet = (name) => ({
    getLastRow: () => (data[name] || []).length,
    getRange: (r, c, nr, nc) => ({
      getValues() {
        const out = [];
        for (let i = r - 1; i < r - 1 + (nr || 1); i++) {
          out.push(((data[name][i] || []).slice(c - 1, c - 1 + (nc || 1))).map(strip));
        }
        return out;
      },
      setValues(values) {
        for (let i = 0; i < values.length; i++) {
          written.push(...values[i]);
          const target = data[name][r - 1 + i] || (data[name][r - 1 + i] = []);
          for (let j = 0; j < values[i].length; j++) target[c - 1 + j] = values[i][j];
        }
      },
      setValue(v) {
        written.push(v);
        data[name][r - 1][c - 1] = v;
      },
      setFontWeight() {},
    }),
    appendRow(row) { written.push(...row); data[name].push(row.slice()); },
    setFrozenRows() {},
  });

  return { openById: () => ({ getSheetByName: (n) => (data[n] ? sheet(n) : null) }) };
}

function load(data) {
  const written = [];
  const ctx = vm.createContext({
    SpreadsheetApp: recordingSpreadsheet(data, written),
    Config: { getWorkbookId: () => 'fake' },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SchemaService: { invalidate() {} },
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
  return { SheetService: ctx.__exports.SheetService, written, data };
}

function seed() {
  return {
    Inspections: [[
      'inspectionId', 'status', 'inspectionType', 'schemaId', 'schemaVersion',
      'propertyAddress', 'propertyUnit',
      'landlordName', 'landlordEmail', 'landlordPhone',
      'tenantName', 'tenantEmail', 'tenantPhone',
      'notes', 'createdAt', 'updatedAt', 'createdBy',
      'driveFolderId', 'finalPdfFileId',
      'currentNonce', 'tenantTokenHash',
      'lockedAt', 'signedAt', 'assignedTo',
    ]],
    Attachments: [[
      'attachmentId', 'inspectionId', 'sectionId', 'itemId',
      'driveFileId', 'fileName', 'mimeType', 'sizeBytes',
      'width', 'height', 'caption', 'uploadedAt', 'uploadedBy', 'deleted',
    ]],
    Signatures: [[
      'signatureId', 'inspectionId', 'signerRole', 'signerName', 'accepted',
      'signatureFileId', 'signedAt', 'ipAddress', 'userAgent', 'nonce', 'valid',
    ]],
  };
}

/** What the cell holds after a write, as the app would read it back. */
function storedValue(env, sheetName, column) {
  const cols = env.SheetService.COLUMNS[sheetName];
  return env.data[sheetName][1][cols.indexOf(column)];
}

module.exports = function run() {

  section('A phone number survives being written down:');

  check('a leading plus does not become a formula', () => {
    // The one that was actually lost. #ERROR! is what the cell held instead.
    const env = load(seed());
    env.SheetService.createInspection({
      inspectionId: 'INS-1', tenantPhone: '+381 60 123 45 67',
    });
    const cell = storedValue(env, 'Inspections', 'tenantPhone');
    assert(String(cell).charAt(0) === "'",
      `the cell holds ${JSON.stringify(cell)}, which Sheets will try to evaluate`);
  });

  check('and it reads back without the marker', () => {
    // The apostrophe is Sheets' own way of saying "text". If it survived into
    // the value, every phone number would gain a stray character and this fix
    // would be worse than the bug.
    const env = load(seed());
    env.SheetService.createInspection({
      inspectionId: 'INS-1', tenantPhone: '+381 60 123 45 67',
    });
    const back = env.SheetService.getInspection('INS-1');
    assert(back.tenantPhone === '+381 60 123 45 67',
      `read back as ${JSON.stringify(back.tenantPhone)}`);
  });

  ['=', '+', '-', '@'].forEach(ch => {
    check(`a value starting with ${ch} is stored as text`, () => {
      const env = load(seed());
      env.SheetService.createInspection({
        inspectionId: 'INS-1', notes: `${ch}something`,
      });
      const cell = storedValue(env, 'Inspections', 'notes');
      assert(String(cell).charAt(0) === "'", `stored as ${JSON.stringify(cell)}`);
      assert(env.SheetService.getInspection('INS-1').notes === `${ch}something`,
        'the value changed on the way back');
    });
  });

  check('an ordinary string is left alone', () => {
    const env = load(seed());
    env.SheetService.createInspection({
      inspectionId: 'INS-1', propertyAddress: 'Dobricka 17',
    });
    assert(storedValue(env, 'Inspections', 'propertyAddress') === 'Dobricka 17',
      'a harmless value was escaped anyway');
  });

  check('and so is an empty one', () => {
    const env = load(seed());
    env.SheetService.createInspection({ inspectionId: 'INS-1' });
    assert(storedValue(env, 'Inspections', 'notes') === '',
      'an empty cell gained a character');
  });

  section('Types survive it, which is what the fix must not cost:');

  check('a boolean stays a boolean', () => {
    // deleted !== true and valid === true are compared against the literal.
    // An apostrophe here would make a deleted attachment visible again on a
    // signed report — a worse failure than the one being fixed.
    const env = load(seed());
    env.SheetService.createAttachment({
      attachmentId: 'ATT-1', inspectionId: 'INS-1', deleted: true,
    });
    const cell = storedValue(env, 'Attachments', 'deleted');
    assert(cell === true, `stored as ${typeof cell} ${JSON.stringify(cell)}`);
  });

  check('false stays false, not the word', () => {
    const env = load(seed());
    env.SheetService.createSignature({
      signatureId: 'SIG-1', inspectionId: 'INS-1', valid: false, accepted: true,
    });
    assert(storedValue(env, 'Signatures', 'valid') === false,
      `stored as ${JSON.stringify(storedValue(env, 'Signatures', 'valid'))}`);
  });

  check('a number stays a number', () => {
    const env = load(seed());
    env.SheetService.createAttachment({
      attachmentId: 'ATT-1', inspectionId: 'INS-1', sizeBytes: 20480, width: 1600,
    });
    assert(storedValue(env, 'Attachments', 'sizeBytes') === 20480,
      'a size was turned into text');
    assert(storedValue(env, 'Attachments', 'width') === 1600,
      'a width was turned into text');
  });

  check('a negative number is not mistaken for a formula', () => {
    // -5 as a number must reach the cell as -5. Only strings are escaped, and
    // this is the case where confusing the two would be easy.
    const env = load(seed());
    env.SheetService.createAttachment({
      attachmentId: 'ATT-1', inspectionId: 'INS-1', width: -5,
    });
    const cell = storedValue(env, 'Attachments', 'width');
    assert(cell === -5, `stored as ${typeof cell} ${JSON.stringify(cell)}`);
  });

  section('An update is protected as well as an insert:');

  check('writing a phone number onto an existing row escapes it too', () => {
    const env = load(seed());
    env.SheetService.createInspection({ inspectionId: 'INS-1', tenantPhone: '' });
    env.SheetService.updateInspection('INS-1', { tenantPhone: '+41 79 000 00 00' });
    assert(String(storedValue(env, 'Inspections', 'tenantPhone')).charAt(0) === "'",
      'an update wrote a formula where an insert would not have');
    assert(env.SheetService.getInspection('INS-1').tenantPhone === '+41 79 000 00 00',
      'the updated value did not read back');
  });
};
