/**
 * lifecycle.test.js
 * What may be changed, and when.
 *
 * The rule this protects is the reason the product exists. A handover report
 * is evidence in a dispute, so what a party signed has to still be there
 * afterwards. Anything else makes the document worse than useless — it makes
 * it misleading.
 *
 * It was broken twice, in two different ways, and both are covered here.
 *
 * First, the frozen-status list was written out by hand at each of the three
 * places that write content, and the copies drifted: deleting a photo checked
 * only 'signed' and 'archived'. A photograph could be removed from an
 * inspection locked for signature, and from one already half signed.
 *
 * Then the fix for that was written as a denylist — refuse if the status is
 * one of these five — which answers yes to everything it has not heard of: a
 * misspelt status, an empty cell, a status added later, a row that no longer
 * exists. The rule is an allowlist now, and most of what follows is about the
 * cases a denylist would have let through.
 *
 * The status table below is spelled out by hand rather than looped over the
 * constant the code uses. A test that reads the implementation's own list
 * would have passed against the first bug.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

function loadValidation() {
  const ctx = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });
  const code = ['Utils.gs', 'ValidationService.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { ValidationService, HandoverError };';
  vm.runInContext(code, ctx);
  return ctx.__exports;
}

/**
 * The real AttachmentService over recording stubs, so the question asked is
 * "did anything get deleted", not "does the source mention the check". A
 * source scan passes just as happily when the check is written *after* the
 * delete.
 */
function loadAttachmentService(inspection) {
  const calls = { softDeleted: 0, movedToDeleted: 0, updated: 0, audited: 0 };

  const ctx = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    AuthService: { requireStaff() {}, requireInspectionAccess() {} },
    SheetService: {
      getAttachment: () => ({
        attachmentId: 'ATT-1', inspectionId: 'INS-1',
        sectionId: 'kitchen', itemId: 'walls', driveFileId: 'file-1',
      }),
      getInspection: () => inspection,
      softDeleteAttachment: () => { calls.softDeleted++; },
      recomputeAttachmentCount: () => {},
      updateInspection: () => { calls.updated++; },
      createAttachment: () => {},
      countAttachmentsForItem: () => 0,
      countAttachmentsForInspection: () => 0,
    },
    DriveService: {
      moveToDeleted: () => { calls.movedToDeleted++; },
      savePhoto: () => ({ fileId: 'f', fileName: 'n' }),
      getThumbnailUrl: () => '',
    },
    AuditService: { log: () => { calls.audited++; } },
    Config: { getMaxAttachmentsPerItem: () => 5, getMaxAttachmentsPerInspection: () => 80 },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });

  const code = ['Utils.gs', 'ValidationService.gs', 'AttachmentService.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { AttachmentService, HandoverError };';
  vm.runInContext(code, ctx);

  return { AttachmentService: ctx.__exports.AttachmentService,
           HandoverError: ctx.__exports.HandoverError, calls };
}

/** Spelled out, not derived from the code under test. */
const EDITABLE = ['draft', 'under_review'];
const FROZEN = [
  'locked_for_signature',
  'partially_signed',
  'signed',
  'archived',
  'cancelled',
];
/** Things a denylist would have waved through. */
const NEITHER = [
  ['a status that does not exist', { status: 'singed' }],
  ['an empty status', { status: '' }],
  ['a missing status', {}],
  ['a status added to the app later', { status: 'disputed' }],
];

module.exports = function run() {
  const { ValidationService, HandoverError } = loadValidation();

  const refusal = (inspection, verb) => {
    let threw = null;
    try {
      ValidationService.assertContentEditable(inspection, verb || 'delete a photo');
    } catch (e) {
      threw = e;
    }
    return threw;
  };

  section('An inspection being worked on:');

  EDITABLE.forEach(status => {
    check(`'${status}' accepts changes`, () => {
      ValidationService.assertContentEditable({ status: status }, 'save this section');
    });
  });

  section('An inspection that is closed to change:');

  FROZEN.forEach(status => {
    check(`'${status}' refuses them`, () => {
      const e = refusal({ status: status });
      assert(e, `content could still be changed in '${status}'`);
      assert(e instanceof HandoverError, `threw ${e.name}`);
      assert(e.code === 'INSPECTION_LOCKED', `code was ${e.code}`);
    });
  });

  section('Anything the rule has not heard of is refused too:');

  NEITHER.forEach(([name, inspection]) => {
    check(`${name} is refused`, () => {
      const e = refusal(inspection);
      assert(e, 'a denylist would have allowed this; an allowlist must not');
      assert(e.code === 'INSPECTION_LOCKED', `code was ${e.code}`);
    });
  });

  check('an inspection that does not exist is NOT_FOUND, not a crash', () => {
    // Before the shared helper, deleteAttachment reached this with null and was
    // stopped only by the TypeError from reading .status — which the helper
    // then turned into a pass. It has to refuse on purpose.
    [null, undefined].forEach(value => {
      const e = refusal(value);
      assert(e, `${value} was allowed through`);
      assert(e.code === 'NOT_FOUND', `code was ${e.code}`);
    });
  });

  section('The refusal says something true:');

  check('an unlockable inspection is told to unlock', () => {
    ['locked_for_signature', 'partially_signed'].forEach(status => {
      assert(/unlock it first/i.test(refusal({ status: status }).message),
        `'${status}' can be unlocked, so say so`);
    });
  });

  check('one that cannot be unlocked is not sent to try', () => {
    // unlockInspection accepts only the two statuses above. Telling someone to
    // unlock a signed inspection sends them to a second refusal.
    ['signed', 'archived', 'cancelled'].forEach(status => {
      const message = refusal({ status: status }).message;
      assert(!/unlock/i.test(message),
        `'${status}': "${message}" — unlockInspection would refuse this`);
    });
  });

  check('and it names the status, so the reason is visible', () => {
    assert(/signed/.test(refusal({ status: 'signed' }).message), 'status not named');
  });

  section('The service actually stops, not just the helper:');

  FROZEN.concat(['singed']).forEach(status => {
    check(`deleteAttachment writes nothing when status is '${status}'`, () => {
      const { AttachmentService, HandoverError: HE, calls } =
        loadAttachmentService({ inspectionId: 'INS-1', status: status });

      let threw = null;
      try {
        AttachmentService.deleteAttachment(
          { actorString: 'test' }, { inspectionId: 'INS-1', attachmentId: 'ATT-1' });
      } catch (e) { threw = e; }

      assert(threw instanceof HE, `threw ${threw && threw.name}`);
      assert(calls.softDeleted === 0, 'the row was soft-deleted anyway');
      assert(calls.movedToDeleted === 0, 'the file was moved in Drive anyway');
      assert(calls.updated === 0 && calls.audited === 0, 'the inspection was touched anyway');
    });
  });

  check('deleteAttachment writes nothing when the inspection is gone', () => {
    const { AttachmentService, calls } = loadAttachmentService(null);
    let threw = null;
    try {
      AttachmentService.deleteAttachment(
        { actorString: 'test' }, { inspectionId: 'INS-1', attachmentId: 'ATT-1' });
    } catch (e) { threw = e; }

    assert(threw, 'an orphan attachment was deleted against a missing inspection');
    assert(calls.softDeleted === 0, 'the row was soft-deleted anyway');
    assert(calls.movedToDeleted === 0, 'the file was moved in Drive anyway');
  });

  check('and it still deletes when the inspection is open', () => {
    // The refusals above would all pass if delete were simply broken.
    const { AttachmentService, calls } =
      loadAttachmentService({ inspectionId: 'INS-1', status: 'draft' });
    AttachmentService.deleteAttachment(
      { actorString: 'test' }, { inspectionId: 'INS-1', attachmentId: 'ATT-1' });
    assert(calls.softDeleted === 1, 'a draft inspection would not let a photo be deleted');
    assert(calls.movedToDeleted === 1, 'the file was not moved in Drive');
  });

  section('The rule is one rule:');

  check('every writer of content asks the same question', () => {
    const writers = [
      ['InspectionService.gs', 'saveSection'],
      ['AttachmentService.gs', 'uploadAttachment'],
      ['AttachmentService.gs', 'deleteAttachment'],
    ];
    const missing = writers.filter(([file, name]) => {
      const source = fs.readFileSync(path.join(GAS_DIR, file), 'utf8');
      const start = source.indexOf(`\n  function ${name}(`);
      const rest = source.slice(start + 1);
      const end = rest.indexOf('\n  function ');
      const body = end < 0 ? rest : rest.slice(0, end);
      return !body.includes('assertContentEditable');
    });
    assert(missing.length === 0,
      `not going through the shared rule: ${missing.map(m => m[1]).join(', ')}`);
  });

  check('and nobody writes the list out again', () => {
    const offenders = ['InspectionService.gs', 'AttachmentService.gs']
      .filter(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')
        .includes("=== 'partially_signed'"));
    assert(offenders.length === 0,
      `a second copy of the status list is back in: ${offenders.join(', ')}`);
  });
};
