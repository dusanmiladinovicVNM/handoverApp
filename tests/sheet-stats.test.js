/**
 * sheet-stats.test.js
 * The numbers the request timing is built from.
 *
 * These decide what gets worked on. Four rounds of this backend's performance
 * work were steered by them, and twice they steered it wrong — first by not
 * counting direct-cell reads at all, so batching an autosave loop appeared to
 * change nothing; then by reporting reads(2) at **minus 445 ms**.
 *
 * That second one is what this file is mostly about, because of how it hid.
 * The workbook open was excluded from reads with a flag: whichever read
 * triggered the open raised it, and the next read to be counted subtracted the
 * open time and lowered it. The narrow-read path counted its own time without
 * ever lowering the flag, so the open was added once inside that read and then
 * subtracted again from an unrelated read later. Two errors of the same size in
 * opposite directions — the total was very nearly right, and only a negative
 * column gave it away.
 *
 * So the checks below are not "is the number plausible". They are the
 * invariants a number that cannot be believed would break: nothing negative,
 * the open counted once and charged to nobody, and the parts never exceeding
 * the whole.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * A spreadsheet whose every operation costs measurable time.
 *
 * Real time, advanced by a busy wait, because the code under test reads
 * Date.now() directly and the whole question is what it subtracts from what.
 * The costs are lopsided on purpose: an open far dearer than a read is exactly
 * the shape that made the old arithmetic produce a negative.
 */
function slowSpreadsheet(data, cost) {
  const spend = (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* deliberately */ }
  };

  const sheet = (name) => ({
    getLastRow: () => { spend(cost.read); return (data[name] || []).length; },
    getRange: (r, c, nr, nc) => ({
      getValues() {
        spend(cost.read);
        const out = [];
        for (let i = r - 1; i < r - 1 + (nr || 1); i++) {
          out.push((data[name][i] || []).slice(c - 1, c - 1 + (nc || 1)));
        }
        return out;
      },
      setValues() { spend(cost.write); },
      setValue() { spend(cost.write); },
      setFontWeight() {},
    }),
    appendRow(row) { spend(cost.write); data[name].push(row.slice()); },
    setFrozenRows() {},
  });

  return {
    openById: () => {
      spend(cost.open);
      return { getSheetByName: (n) => (data[n] ? sheet(n) : null) };
    },
  };
}

function load(data, cost) {
  const ctx = vm.createContext({
    SpreadsheetApp: slowSpreadsheet(data, cost),
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
  return ctx.__exports.SheetService;
}

/** Enough sheets that a request can touch several, plus a heavy one. */
function seed() {
  return {
    Users: [
      ['userId', 'email', 'name', 'role', 'status', 'passHash', 'passSetAt',
       'failedCount', 'lockedUntil', 'lastLoginAt', 'createdAt', 'createdBy', 'notes'],
      ['U1', 'a@b.rs', 'A', 'admin', 'active', '', '', 0, '', '', '', '', ''],
    ],
    SectionAnswers: [
      ['inspectionId', 'sectionId', 'answersJson', 'revision', 'updatedAt', 'updatedBy'],
      ['INS-1', 'kitchen', '{"walls":{"value":"good"}}', 1, '', ''],
    ],
    Attachments: [
      ['attachmentId', 'inspectionId', 'sectionId', 'itemId', 'driveFileId',
       'fileName', 'mimeType', 'sizeBytes', 'width', 'height', 'caption',
       'uploadedAt', 'uploadedBy', 'deleted'],
    ],
    Schemas: [
      ['schemaId', 'inspectionType', 'version', 'active', 'title',
       'schemaJson', 'createdAt', 'updatedAt'],
      ['S1', 'move_in', 1, true, 'Move-in', '{"sections":[]}', '', ''],
    ],
  };
}

// An open far dearer than a read: the shape that produced the negative.
const LOPSIDED = { open: 60, read: 10, write: 10 };

module.exports = function run() {

  section('No figure can be negative:');

  const paths = [
    ['a plain read', (s) => s.getAnswersForInspection('INS-1')],
    ['a narrow read of a heavy sheet', (s) => s.getActiveSchemaSummaries()],
    // The sequence that produced minus 445 in a live run: the narrow read
    // opens the workbook, and the plain read after it is the one that had the
    // open subtracted from it. getNewInspectionOptions does exactly this.
    ['a narrow read then a plain one', (s) => {
      s.getActiveSchemaSummaries();
      s.listUsers();
    }],
    ['a write', (s) => s.upsertSectionAnswers('INS-1', 'bath', { a: { value: '1' } }, 'x', null)],
    ['a read then a write', (s) => {
      s.getAnswersForInspection('INS-1');
      s.upsertSectionAnswers('INS-1', 'bath', { a: { value: '1' } }, 'x', null);
    }],
    ['a write then a read', (s) => {
      s.upsertSectionAnswers('INS-1', 'bath', { a: { value: '1' } }, 'x', null);
      s.getAnswersForInspection('INS-1');
    }],
    ['several sheets in one request', (s) => {
      s.getAnswersForInspection('INS-1');
      s.getAttachmentsForInspection('INS-1', false);
      s.listUsers();
    }],
  ];

  paths.forEach(([name, run_]) => {
    check(name, () => {
      const SheetService = load(seed(), LOPSIDED);
      run_(SheetService);
      const stats = SheetService.getStats();
      ['openMs', 'readMs', 'writeMs', 'lockWaitMs', 'reads', 'writes'].forEach(field => {
        assert(stats[field] >= 0,
          `${field} came back as ${stats[field]}, which is not a duration`);
      });
    });
  });

  section('The workbook is opened once, and charged to nobody:');

  check('opening is counted, and only once', () => {
    const SheetService = load(seed(), LOPSIDED);
    SheetService.getAnswersForInspection('INS-1');
    SheetService.getAttachmentsForInspection('INS-1', false);
    SheetService.listUsers();

    const stats = SheetService.getStats();
    assert(stats.openMs >= LOPSIDED.open,
      `openMs was ${stats.openMs}, under the cost of a single open`);
    assert(stats.openMs < LOPSIDED.open * 2,
      `openMs was ${stats.openMs}, which is more than one open for a cached workbook`);
  });

  check('the read that triggered it is not billed for it', () => {
    // The reason the exclusion exists: whichever read gets there first would
    // otherwise look enormous, and which read that is depends on nothing more
    // meaningful than the order of the handler.
    const SheetService = load(seed(), LOPSIDED);
    SheetService.getAnswersForInspection('INS-1');

    const stats = SheetService.getStats();
    assert(stats.reads === 1, `${stats.reads} reads for one sheet`);
    assert(stats.readMs < LOPSIDED.open,
      `readMs was ${stats.readMs}, which includes the ${LOPSIDED.open} ms open`);
  });

  check('and neither is a write that triggered it', () => {
    const SheetService = load(seed(), LOPSIDED);
    SheetService.upsertSectionAnswers('INS-1', 'bath', { a: { value: '1' } }, 'x', null);

    const stats = SheetService.getStats();
    assert(stats.writeMs < LOPSIDED.open,
      `writeMs was ${stats.writeMs}, which includes the ${LOPSIDED.open} ms open`);
  });

  check('nor is a later read credited with it', () => {
    // The failure exactly: the open was subtracted from a read that never paid
    // it, which is how a column reached minus 445.
    const SheetService = load(seed(), LOPSIDED);
    SheetService.getAnswersForInspection('INS-1');   // opens
    const afterFirst = SheetService.getStats().readMs;
    SheetService.getAttachmentsForInspection('INS-1', false);   // does not
    const afterSecond = SheetService.getStats().readMs;

    assert(afterSecond >= afterFirst,
      `readMs fell from ${afterFirst} to ${afterSecond} across a second read`);
  });

  check('not even when the open happened on the narrow path', () => {
    // The live failure came through getNewInspectionOptions, which reads the
    // schema summaries narrowly and then the user list. The narrow path opens
    // the workbook outside the timed region, so a scheme that marks the open on
    // one read and clears it on another leaves the mark standing for the next
    // read along — which then has the whole open deducted from it.
    const SheetService = load(seed(), LOPSIDED);
    SheetService.getActiveSchemaSummaries();
    const afterNarrow = SheetService.getStats().readMs;
    SheetService.listUsers();
    const afterPlain = SheetService.getStats().readMs;

    assert(afterNarrow >= 0, `the narrow read alone reported ${afterNarrow} ms`);
    assert(afterPlain >= afterNarrow,
      `readMs fell from ${afterNarrow} to ${afterPlain} — the open was deducted twice`);
  });

  section('The parts do not exceed the whole:');

  check('reads and writes together fit inside the elapsed time', () => {
    const SheetService = load(seed(), LOPSIDED);
    const startedAt = Date.now();
    SheetService.getAnswersForInspection('INS-1');
    SheetService.upsertSectionAnswers('INS-1', 'bath', { a: { value: '1' } }, 'x', null);
    SheetService.listUsers();
    const elapsed = Date.now() - startedAt;

    const stats = SheetService.getStats();
    const accounted = stats.openMs + stats.readMs + stats.writeMs;
    assert(accounted <= elapsed,
      `${accounted} ms accounted for inside ${elapsed} ms of work`);
  });

  check('every round trip is counted', () => {
    // Under-counting is the other way these numbers have been wrong: direct
    // cell reads went uncounted, so a loop doing one per item looked free.
    const SheetService = load(seed(), LOPSIDED);
    SheetService.getAnswersForInspection('INS-1');
    SheetService.getAttachmentsForInspection('INS-1', false);
    SheetService.listUsers();
    assert(SheetService.getStats().reads === 3,
      `${SheetService.getStats().reads} reads for three sheets`);
  });

  check('a cached sheet is not counted again', () => {
    const SheetService = load(seed(), LOPSIDED);
    SheetService.getAnswersForInspection('INS-1');
    SheetService.getAnswersForInspection('INS-1');
    assert(SheetService.getStats().reads === 1,
      `${SheetService.getStats().reads} reads for the same sheet twice`);
  });
};
