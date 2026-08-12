/**
 * batch-read.test.js
 * Reading whole sheets through the Sheets API instead of opening the workbook.
 *
 * Measured on the four sheets getInspection needs: 525 ms to open the workbook
 * plus 561 median to read, against 150 median for one batchGet. The spread is
 * the better half of that — the old path ranged 214 to 934 across five rounds,
 * this one 138 to 156.
 *
 * The saving only exists if the sheets are asked for together. One at a time
 * they are four requests and the point is lost, so "one request for four
 * sheets" is counted here rather than assumed.
 *
 * Everything else in this file is about the ways this substitution can be
 * wrong quietly, which are the ones that matter:
 *
 *   Values arriving as displayed text. Five comparisons in SheetService are
 *   against the literal true; a string 'TRUE' passes none of them, and a
 *   deleted attachment would reappear on a signed report.
 *
 *   Short rows. batchGet stops at the last cell with anything in it, and
 *   _rowToObject indexes by position, so a row ending in an empty comment
 *   yields undefined where '' belongs. Eleven rows of the live workbook were
 *   short when this was measured.
 *
 *   Results paired by position. The API returns ranges in the order asked, but
 *   pairing on that would read Users as Inspections if it ever did not.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

const HEADERS = {
  Inspections: ['inspectionId', 'status', 'inspectionType', 'schemaId', 'schemaVersion',
    'propertyAddress', 'propertyUnit', 'landlordName', 'landlordEmail', 'landlordPhone',
    'tenantName', 'tenantEmail', 'tenantPhone', 'notes', 'createdAt', 'updatedAt',
    'createdBy', 'driveFolderId', 'finalPdfFileId', 'currentNonce', 'tenantTokenHash',
    'lockedAt', 'signedAt', 'assignedTo'],
};

/**
 * A Sheets advanced service that answers from a table of rows and records what
 * it was asked for. `reverse` returns the ranges back to front, which is legal
 * and which position-pairing would not survive.
 */
function fakeSheets(rows, calls, options) {
  const opts = options || {};
  return {
    Spreadsheets: {
      Values: {
        batchGet(id, request) {
          calls.push(request);
          const ranges = request.ranges.slice();
          const answer = ranges.map(function (range) {
            const name = range.split('!')[0];
            return { range: range, values: (rows[name] || []).map(r => r.slice()) };
          });
          if (opts.reverse) answer.reverse();
          if (opts.dropMissing) {
            return { valueRanges: answer.filter(v => rows[v.range.split('!')[0]]) };
          }
          return { valueRanges: answer };
        },
      },
    },
  };
}

/** The SpreadsheetApp fallback, which must still work where Sheets is absent. */
function fallbackSpreadsheet(rows, opened) {
  const sheet = (name) => ({
    getLastRow: () => (rows[name] || []).length + 1,
    getRange: (r, c, nr, nc) => ({
      getValues() {
        const out = [];
        for (let i = r - 2; i < r - 2 + (nr || 1); i++) {
          out.push(((rows[name] || [])[i] || []).slice(c - 1, c - 1 + (nc || 1)));
        }
        return out;
      },
      setValues() {}, setValue() {}, setFontWeight() {},
    }),
    appendRow() {}, setFrozenRows() {},
  });
  return {
    openById: () => {
      opened.count++;
      return { getSheetByName: (n) => (rows[n] ? sheet(n) : null) };
    },
  };
}

function load(rows, options) {
  const opts = options || {};
  const calls = [];
  const opened = { count: 0 };
  const sandbox = {
    SpreadsheetApp: fallbackSpreadsheet(rows, opened),
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
  };
  if (!opts.withoutSheets) sandbox.Sheets = fakeSheets(rows, calls, opts);

  const ctx = vm.createContext(sandbox);
  const code = ['Utils.gs', 'SheetService.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { SheetService, HandoverError };';
  vm.runInContext(code, ctx);
  return {
    SheetService: ctx.__exports.SheetService,
    HandoverError: ctx.__exports.HandoverError,
    calls, opened,
  };
}

/** One inspection row, full width. */
function inspectionRow(id) {
  const row = new Array(HEADERS.Inspections.length).fill('');
  row[0] = id;
  row[1] = 'draft';
  return row;
}

function seed() {
  return {
    Inspections: [inspectionRow('INS-1')],
    SectionAnswers: [['INS-1', 'kitchen', '{"walls":{"value":"good"}}', 1, '', '']],
    Attachments: [['ATT-1', 'INS-1', 'kitchen', 'walls', 'FILE', 'a.jpg',
      'image/jpeg', 2048, 800, 600, '', '', '', false]],
    Signatures: [['SIG-1', 'INS-1', 'tenant', 'Ana', true, 'F', '', '', '', 'n', true]],
    Users: [['U1', 'a@b.rs', 'A', 'admin', 'active', '', '', 0, '', '', '', '', '', '', '']],
  };
}

const FOUR = ['Inspections', 'SectionAnswers', 'Attachments', 'Signatures'];

module.exports = function run() {

  section('Four sheets cost one request:');

  check('prefetch asks once for all of them', () => {
    const env = load(seed());
    env.SheetService.prefetch(FOUR);
    assert(env.calls.length === 1, `${env.calls.length} requests for four sheets`);
    assert(env.calls[0].ranges.length === 4,
      `${env.calls[0].ranges.length} ranges in the request`);
  });

  check('and the workbook is never opened', () => {
    // The open was the larger half of the old cost. If it still happens, the
    // saving is gone whatever the reads do.
    const env = load(seed());
    env.SheetService.prefetch(FOUR);
    env.SheetService.getAnswersForInspection('INS-1');
    assert(env.opened.count === 0, `the workbook was opened ${env.opened.count} time(s)`);
  });

  check('a prefetched sheet is not asked for again', () => {
    const env = load(seed());
    env.SheetService.prefetch(FOUR);
    env.SheetService.getAnswersForInspection('INS-1');
    env.SheetService.getAttachmentsForInspection('INS-1', false);
    env.SheetService.getInspection('INS-1');
    assert(env.calls.length === 1, `${env.calls.length} requests after prefetching`);
  });

  check('prefetching twice costs nothing the second time', () => {
    const env = load(seed());
    env.SheetService.prefetch(FOUR);
    env.SheetService.prefetch(FOUR);
    assert(env.calls.length === 1, `${env.calls.length} requests`);
  });

  check('a sheet nobody named still works, at one request', () => {
    const env = load(seed());
    env.SheetService.prefetch(FOUR);
    env.SheetService.listUsers();
    assert(env.calls.length === 2, `${env.calls.length} requests`);
    assert(env.calls[1].ranges.length === 1, 'the second request was not just Users');
  });

  section('Values keep their types:');

  check('the request asks for unformatted values', () => {
    // Without this every value arrives as displayed text. It is the single
    // option the whole substitution depends on.
    const env = load(seed());
    env.SheetService.prefetch(FOUR);
    assert(env.calls[0].valueRenderOption === 'UNFORMATTED_VALUE',
      `valueRenderOption was ${env.calls[0].valueRenderOption}`);
  });

  check('a boolean stays a boolean', () => {
    // deleted !== true decides whether a removed photograph is visible. A
    // string here puts it back on a signed report.
    const env = load(seed());
    const attachments = env.SheetService.getAttachmentsForInspection('INS-1', false);
    assert(attachments.length === 1, `${attachments.length} attachments`);
    assert(attachments[0].deleted === false,
      `deleted came back as ${typeof attachments[0].deleted}`);
  });

  check('and a deleted one stays hidden', () => {
    const rows = seed();
    rows.Attachments[0][13] = true;
    const env = load(rows);
    assert(env.SheetService.getAttachmentsForInspection('INS-1', false).length === 0,
      'a deleted attachment came back');
  });

  check('a valid signature is still valid', () => {
    const env = load(seed());
    const signatures = env.SheetService.getSignaturesForInspection('INS-1', true);
    assert(signatures.length === 1, 'a valid signature was not counted');
  });

  check('a number stays a number', () => {
    const env = load(seed());
    const a = env.SheetService.getAttachmentsForInspection('INS-1', false)[0];
    assert(a.sizeBytes === 2048, `sizeBytes came back as ${typeof a.sizeBytes}`);
  });

  section('A short row is filled out, not left ragged:');

  check('missing trailing cells read as empty, not undefined', () => {
    // batchGet stops at the last cell holding anything. Eleven rows of the live
    // workbook were short; one answer ending in an empty comment does it.
    const rows = seed();
    rows.SectionAnswers = [['INS-1', 'kitchen', '{"a":{"value":"1"}}', 1]];
    const env = load(rows);

    const answers = env.SheetService.getAnswersForInspection('INS-1');
    assert(answers.length === 1, `${answers.length} answers`);
    assert(answers[0].updatedBy === '',
      `updatedBy came back as ${JSON.stringify(answers[0].updatedBy)}`);
  });

  check('a badly short inspection row still reads', () => {
    const rows = seed();
    rows.Inspections = [['INS-1', 'draft']];
    const env = load(rows);
    const inspection = env.SheetService.getInspection('INS-1');
    assert(inspection && inspection.inspectionId === 'INS-1', 'the row was lost');
    assert(inspection.assignedTo === '',
      `assignedTo came back as ${JSON.stringify(inspection.assignedTo)}`);
  });

  section('Results are paired by name, not by position:');

  check('ranges returned out of order still land on the right sheets', () => {
    // The API returns them in order. Relying on that would read Users as
    // Inspections the day it did not, and nothing would look wrong.
    const env = load(seed(), { reverse: true });
    env.SheetService.prefetch(FOUR);

    const inspection = env.SheetService.getInspection('INS-1');
    assert(inspection && inspection.status === 'draft',
      'the inspection was read from the wrong sheet');
    assert(env.SheetService.getAnswersForInspection('INS-1').length === 1,
      'the answers were read from the wrong sheet');
  });

  section('A missing sheet is an error, not an empty list:');

  check('it says which sheet, rather than reading as nothing', () => {
    // Handing back [] would let a caller conclude there are no users, which is
    // a far worse answer than a refusal.
    const rows = seed();
    delete rows.Users;
    const env = load(rows, { dropMissing: true });

    let threw = null;
    try { env.SheetService.listUsers(); } catch (e) { threw = e; }
    assert(threw, 'a missing sheet read as empty');
    assert(String(threw.message).indexOf('Users') >= 0,
      `the error does not name the sheet: ${threw.message}`);
  });

  section('Without the advanced service, it still works:');

  check('a deployment that never enabled it falls back', () => {
    // Slower, and correct. Failing outright would take the whole app down over
    // a setting.
    const env = load(seed(), { withoutSheets: true });
    const answers = env.SheetService.getAnswersForInspection('INS-1');
    assert(answers.length === 1, `${answers.length} answers through the fallback`);
    assert(env.opened.count > 0, 'the fallback did not open the workbook');
  });

  check('and the fallback keeps types too', () => {
    const env = load(seed(), { withoutSheets: true });
    const a = env.SheetService.getAttachmentsForInspection('INS-1', false)[0];
    assert(a.deleted === false && a.sizeBytes === 2048,
      'the fallback changed the types');
  });
};
