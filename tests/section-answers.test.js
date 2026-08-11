/**
 * section-answers.test.js
 * One row per section, and what it cost to get there.
 *
 * Answers used to be one row per question, and saving a section wrote them one
 * at a time: the script lock taken, the whole Answers sheet scanned and a row
 * written *per changed item*. An eight-item autosave was about eighteen round
 * trips, on the path someone waits on to leave a section, and the sheet grew by
 * roughly a hundred rows per inspection — so opening any inspection read every
 * answer of every inspection ever made.
 *
 * Two things have to hold now, and they are what this file is about.
 *
 * The write is one lock and one write, whatever the item count. That is
 * measured by counting, not asserted by reading the code, because the whole
 * point is a number.
 *
 * And a save merges rather than replaces. A section holds every answer in one
 * cell, so a save that carried only the changed items and wrote the cell whole
 * would erase everything it was not given — which is a far worse failure than
 * the slowness it was fixing.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/** A spreadsheet that counts what it is asked to do. */
function fakeSpreadsheet(data, counters) {
  function rangeFor(name, row, col, numRows, numCols) {
    return {
      getValues() {
        counters.reads++;
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
      setValue(v) { counters.writes++; data[name][row - 1][col - 1] = v; },
      setFontWeight() {},
    };
  }
  const sheet = (name) => ({
    getLastRow: () => (data[name] || []).length,
    getRange: (r, c, nr, nc) => rangeFor(name, r, c, nr || 1, nc || 1),
    appendRow(row) { counters.writes++; data[name].push(row.slice()); },
    setFrozenRows() {},
  });
  return {
    openById: () => ({ getSheetByName: (n) => (data[n] ? sheet(n) : null) }),
  };
}

function load(data) {
  const counters = { reads: 0, writes: 0, locks: 0 };
  const ctx = vm.createContext({
    SpreadsheetApp: fakeSpreadsheet(data, counters),
    Config: { getWorkbookId: () => 'fake' },
    LockService: {
      getScriptLock: () => ({
        waitLock() { counters.locks++; },
        releaseLock() {},
      }),
    },
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
    + '\nglobalThis.__exports = { SheetService, HandoverError };';
  vm.runInContext(code, ctx);
  return { SheetService: ctx.__exports.SheetService,
           HandoverError: ctx.__exports.HandoverError, counters, data };
}

function seed() {
  return {
    SectionAnswers: [
      ['inspectionId', 'sectionId', 'answersJson', 'revision', 'updatedAt', 'updatedBy'],
    ],
    Attachments: [
      ['attachmentId', 'inspectionId', 'sectionId', 'itemId', 'driveFileId',
       'fileName', 'mimeType', 'sizeBytes', 'width', 'height', 'caption',
       'uploadedAt', 'uploadedBy', 'deleted'],
    ],
  };
}

const eight = () => {
  const items = {};
  for (let i = 1; i <= 8; i++) items['item' + i] = { value: 'v' + i, comment: '' };
  return items;
};

module.exports = function run() {

  section('A save is one lock and one write:');

  check('eight items cost one of each', () => {
    const { SheetService, counters } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen', eight(), 'tester', null);

    // One row per question took the lock, scanned the sheet and wrote once per
    // item: sixteen round trips plus eight lock cycles.
    assert(counters.locks === 1, `${counters.locks} locks for one save`);
    assert(counters.writes === 1, `${counters.writes} writes for eight items`);
  });

  check('and one item costs the same as eight', () => {
    const { SheetService, counters } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen', { a: { value: '1' } }, 'x', null);
    assert(counters.writes === 1, `${counters.writes} writes`);
  });

  check('one row per section, not per question', () => {
    const { SheetService, data } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen', eight(), 'tester', null);
    assert(data.SectionAnswers.length === 2,
      `${data.SectionAnswers.length - 1} rows for one section of eight answers`);
  });

  section('A save merges, it does not replace:');

  check('answers not named in the save survive it', () => {
    // The whole section lives in one cell, so a save that wrote the cell whole
    // would erase every answer it was not given.
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen',
      { walls: { value: 'good' }, floor: { value: 'worn' } }, 'tester', null);
    SheetService.upsertSectionAnswers('INS-1', 'kitchen',
      { walls: { value: 'damaged' } }, 'tester', null);

    const rows = SheetService.getAnswersForInspection('INS-1');
    const byId = {};
    rows.forEach(r => { byId[r.itemId] = r; });
    assert(byId.walls.value === 'damaged', 'the changed answer did not change');
    assert(byId.floor && byId.floor.value === 'worn',
      'an answer that was not part of the save was erased');
  });

  check('fields not named in an item survive too', () => {
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen',
      { walls: { value: 'good', comment: 'scuff by the door' } }, 'tester', null);
    // A photo upload writes only the count.
    SheetService.upsertSectionAnswers('INS-1', 'kitchen',
      { walls: { attachmentCount: 3 } }, 'system', null);

    const walls = SheetService.getAnswersForInspection('INS-1')[0];
    assert(walls.comment === 'scuff by the door', 'the comment was lost');
    assert(walls.value === 'good', 'the value was lost');
    assert(walls.attachmentCount === 3, 'the count was not written');
  });

  check('sections do not bleed into each other', () => {
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen', { a: { value: 'k' } }, 'x', null);
    SheetService.upsertSectionAnswers('INS-1', 'bath', { a: { value: 'b' } }, 'x', null);

    const rows = SheetService.getAnswersForInspection('INS-1');
    assert(rows.length === 2, `${rows.length} answers`);
    assert(rows.find(r => r.sectionId === 'kitchen').value === 'k', 'kitchen');
    assert(rows.find(r => r.sectionId === 'bath').value === 'b', 'bath');
  });

  check('inspections do not either', () => {
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen', { a: { value: '1' } }, 'x', null);
    SheetService.upsertSectionAnswers('INS-2', 'kitchen', { a: { value: '2' } }, 'x', null);

    assert(SheetService.getAnswersForInspection('INS-1').length === 1, 'INS-1');
    assert(SheetService.getAnswersForInspection('INS-1')[0].value === '1', 'INS-1 value');
    assert(SheetService.getAnswersForInspection('INS-2')[0].value === '2', 'INS-2 value');
  });

  section('The shape callers see did not change:');

  check('answers still come back one object per question', () => {
    // getInspection, the PDF and the lock validation all read this shape. Moving
    // the storage was only safe because they did not have to know.
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'kitchen',
      { walls: { value: 'good', comment: 'c', valueType: 'condition' } }, 'tester', null);

    const row = SheetService.getAnswersForInspection('INS-1')[0];
    ['inspectionId', 'sectionId', 'itemId', 'valueType', 'value', 'comment',
     'attachmentCount', 'updatedAt', 'updatedBy'].forEach(field => {
      assert(field in row, `the flat row lost its ${field}`);
    });
    assert(row.inspectionId === 'INS-1' && row.sectionId === 'kitchen'
      && row.itemId === 'walls', 'the keys are wrong');
  });

  check('an inspection with nothing saved reads as nothing', () => {
    const { SheetService } = load(seed());
    assert(SheetService.getAnswersForInspection('INS-NONE').length === 0, 'phantom answers');
  });

  section('A concurrent edit is refused, not silently applied:');

  check('the revision goes up on every save', () => {
    const { SheetService } = load(seed());
    const first = SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '1' } }, 'x', null);
    const second = SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '2' } }, 'x', null);
    assert(first.revision === 1 && second.revision === 2,
      `revisions were ${first.revision} and ${second.revision}`);
  });

  check('saving against the revision you read is allowed', () => {
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '1' } }, 'x', null);
    const revision = SheetService.getSectionRevision('INS-1', 'k');
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '2' } }, 'x', revision);
  });

  check('saving against a stale revision is refused', () => {
    const { SheetService, HandoverError } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '1' } }, 'first', null);
    const stale = SheetService.getSectionRevision('INS-1', 'k');
    // Somebody else saves in between.
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '2' } }, 'second', null);

    let threw = null;
    try {
      SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '3' } }, 'first', stale);
    } catch (e) { threw = e; }

    assert(threw instanceof HandoverError, `threw ${threw && threw.name}`);
    assert(threw.code === 'CONFLICT', `code was ${threw.code}`);
    assert(SheetService.getAnswersForInspection('INS-1')[0].value === '2',
      "the refused save wrote anyway, which is the thing this exists to stop");
  });

  check('omitting the revision skips the check', () => {
    // Photo counts and the migration write without having read a revision.
    const { SheetService } = load(seed());
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '1' } }, 'x', null);
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '2' } }, 'x', undefined);
    assert(SheetService.getAnswersForInspection('INS-1')[0].value === '2', 'was refused');
  });

  check('a first save expects revision zero', () => {
    const { SheetService } = load(seed());
    assert(SheetService.getSectionRevision('INS-1', 'k') === 0, 'unsaved section');
    SheetService.upsertSectionAnswers('INS-1', 'k', { a: { value: '1' } }, 'x', 0);
  });

  section('Damaged JSON does not make an inspection unopenable:');

  check('a section that will not parse reads as empty, not as a crash', () => {
    const data = seed();
    data.SectionAnswers.push(['INS-1', 'kitchen', '{not json', 1, '', '']);
    data.SectionAnswers.push(['INS-1', 'bath', '{"a":{"value":"ok"}}', 1, '', '']);
    const { SheetService } = load(data);

    const rows = SheetService.getAnswersForInspection('INS-1');
    assert(rows.length === 1 && rows[0].sectionId === 'bath',
      'one bad section took the whole inspection with it');
  });
};
