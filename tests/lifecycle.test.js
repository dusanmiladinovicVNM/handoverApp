/**
 * lifecycle.test.js
 * What may be changed, and when.
 *
 * The rule this protects is the reason the product exists. A handover report
 * is evidence in a dispute, so what a party signed has to still be there
 * afterwards. Anything else makes the document worse than useless — it makes
 * it misleading.
 *
 * It was broken. The frozen-status list was written out by hand at each of the
 * three places that write content, and the three copies drifted: deleting a
 * photo checked only 'signed' and 'archived'. A photograph could be removed
 * from an inspection locked for signature, and from one a party had already
 * signed.
 *
 * So the table below is written status by status rather than as a loop over
 * the same constant the code uses. A test that reads the implementation's own
 * list would have passed against the bug.
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

/** Spelled out, not derived from the code under test. */
const EDITABLE = ['draft', 'under_review'];
const FROZEN = [
  'locked_for_signature',
  'partially_signed',
  'signed',
  'archived',
  'cancelled',
];

module.exports = function run() {
  const { ValidationService, HandoverError } = loadValidation();

  section('An inspection being worked on:');

  EDITABLE.forEach(status => {
    check(`'${status}' accepts changes`, () => {
      ValidationService.assertContentEditable({ status: status }, 'save this section');
    });
  });

  section('An inspection that is closed to change:');

  FROZEN.forEach(status => {
    check(`'${status}' refuses them`, () => {
      let threw = null;
      try {
        ValidationService.assertContentEditable({ status: status }, 'delete a photo');
      } catch (e) {
        threw = e;
      }
      assert(threw, `content could still be changed in '${status}'`);
      assert(threw instanceof HandoverError, `threw ${threw.name}`);
      assert(threw.code === 'INSPECTION_LOCKED', `code was ${threw.code}`);
    });
  });

  check('and the message says how to proceed, not just no', () => {
    try {
      ValidationService.assertContentEditable({ status: 'signed' }, 'delete a photo');
    } catch (e) {
      assert(/unlock/i.test(e.message),
        `"${e.message}" leaves the reader with no way forward`);
    }
  });

  section('The rule is one rule:');

  /**
   * The bug was three hand-written copies of one list. This asserts there is
   * now one, by reading the sources — the only way to catch a fourth copy
   * being added, which is exactly how this happened the first time.
   */
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
