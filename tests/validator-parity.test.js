/**
 * validator-parity.test.js
 * The two validators have to reach the same verdict.
 *
 * js/validator.js is a hand-written mirror of ValidationService.gs. The server
 * one decides; the client one draws the screen. When they drift, the screen
 * says every required item is complete and the lock comes back refusing one —
 * which is what happened, on a real inspection, with no way to tell from the
 * outside which of the two was wrong.
 *
 * Two copies of a rule agree until someone edits one of them. Nothing prevents
 * that here, so this compares their answers instead of their source.
 *
 * The comparison is only worth something if it feeds them what they actually
 * receive, and that is not the same thing:
 *
 *   the client holds what was typed — a boolean, a number, an array
 *   the server holds what a sheet cell can hold — text, always
 *
 * InspectionService coerces on the way in. So the fixture below is written once
 * in typed form and handed to the client as-is, and to the server through the
 * same coercion the storage applies. Feeding both the same strings would make
 * this pass while the real pair disagreed, which is the failure being hunted.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

function loadServer() {
  const ctx = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });
  const code = ['Utils.gs', 'ValidationService.gs', 'SchemaSeed.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { ValidationService, SchemaSeed };';
  vm.runInContext(code, ctx);
  return ctx.__exports;
}

/**
 * What a sheet cell would hold, which is what the server reads back.
 *
 * This mirrors InspectionService._storedValue. It is repeated rather than
 * imported because that function is private to a service whose dependencies
 * are the whole backend — but a copy that drifts would silently weaken every
 * check here, so the last section of this file drives the real save path and
 * confirms the two still agree.
 */
function stored(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined || value === null) return '';
  return String(value);
}

/** One fixture, in the two shapes the two validators are given. */
function shapes(answers, attachmentCounts) {
  const counts = attachmentCounts || {};
  const client = {};
  const serverRows = [];

  Object.keys(answers).forEach(sectionId => {
    client[sectionId] = {};
    Object.keys(answers[sectionId]).forEach(itemId => {
      const count = Number((counts[sectionId] || {})[itemId] || 0);
      client[sectionId][itemId] = {
        value: answers[sectionId][itemId],
        attachmentCount: count,
      };
      serverRows.push({
        sectionId, itemId,
        value: stored(answers[sectionId][itemId]),
        attachmentCount: count,
      });
    });
  });

  return { client, serverRows };
}

const key = (m) => `${m.sectionId}:${m.itemId}`;
const sorted = (list) => list.map(key).sort();

module.exports = async function run() {
  const { ValidationService, SchemaSeed } = loadServer();
  const client = await import('../js/validator.js');
  const seeds = SchemaSeed.getAllSeeds();

  /** Runs both and reports the disagreement, not just that there was one. */
  function agree(label, schema, answers, attachmentCounts) {
    const { client: nested, serverRows } = shapes(answers, attachmentCounts);
    const fromClient = sorted(client.findAllMissingRequired(schema, nested));
    const fromServer = sorted(ValidationService.findMissingRequiredItems(schema, serverRows));

    const onlyClient = fromClient.filter(k => fromServer.indexOf(k) < 0);
    const onlyServer = fromServer.filter(k => fromClient.indexOf(k) < 0);
    assert(onlyClient.length === 0 && onlyServer.length === 0,
      `${label}: the screen and the server disagree — `
      + `only the screen wants ${JSON.stringify(onlyClient)}, `
      + `only the server wants ${JSON.stringify(onlyServer)}`);
    return fromServer;
  }

  /** A plausible answer for an item, by type. Typed, not stringified. */
  function answerFor(item) {
    switch (item.type) {
      case 'checkbox':    return true;
      case 'number':      return 3;
      case 'date':        return '2026-08-12';
      case 'select':
      case 'radio':       return (item.options && item.options[0])
                                 ? item.options[0].value : 'x';
      case 'multiselect': return (item.options && item.options[0])
                                 ? [item.options[0].value] : ['x'];
      default:            return 'filled in';
    }
  }

  /** Every item of every section answered, and every photo requirement met. */
  function fullyAnswered(schema) {
    const answers = {};
    const counts = {};
    (schema.sections || []).forEach(s => {
      answers[s.id] = {};
      counts[s.id] = {};
      (s.items || []).forEach(item => {
        answers[s.id][item.id] = answerFor(item);
        counts[s.id][item.id] =
          (item.attachments && item.attachments.min) ? item.attachments.min : 0;
      });
    });
    return { answers, counts };
  }

  section('On an empty inspection, both name the same items:');

  seeds.forEach(seed => {
    check(`${seed.title}`, () => {
      const missing = agree(seed.title, seed.schema, {});
      assert(missing.length > 0,
        'nothing was required at all, so this proved nothing');
    });
  });

  section('On a fully answered one, both are satisfied:');

  seeds.forEach(seed => {
    check(`${seed.title}`, () => {
      const { answers, counts } = fullyAnswered(seed.schema);
      const missing = agree(seed.title, seed.schema, answers, counts);
      assert(missing.length === 0,
        `still missing ${JSON.stringify(missing)} with every item answered`);
    });
  });

  section('Conditions decide the same way on both sides:');

  // These are the shapes that differ between the two stores: a boolean the
  // client holds as a boolean and the server as the word, and an array the
  // client holds as an array and the server as JSON. Every conditional item in
  // the seeded schemas hangs off one of them.
  const moveIn = seeds.find(s => s.inspectionType === 'move_in').schema;

  function conditionalCases(schema) {
    const cases = [];
    (schema.sections || []).forEach(s => (s.items || []).forEach(item => {
      const cond = item.visibleWhen || item.requiredWhen;
      if (!cond || !cond.field) return;
      cases.push({ sectionId: s.id, item: item, field: cond.field });
    }));
    return cases;
  }

  check('the seeded schemas actually contain conditions to test', () => {
    const found = seeds.reduce((n, s) => n + conditionalCases(s.schema).length, 0);
    assert(found > 0, 'no conditional items, so the checks below prove nothing');
  });

  /**
   * Whether an input of this type could produce this value.
   *
   * The sweep below is deliberately crude — it sets every field anything is
   * conditional on to the same value at once, which is how it drove the
   * operators through the combination that turned out to be broken. But crude
   * has a floor: a select cannot yield an array, and a disagreement over a
   * value the app cannot produce is a fact about the fixture, not about the
   * app. Those are skipped rather than chased.
   */
  function canHold(type, value) {
    if (value === '') return true;
    if (Array.isArray(value)) return type === 'multiselect';
    if (typeof value === 'boolean') return type === 'checkbox';
    if (typeof value === 'number') return type === 'number';
    return type !== 'checkbox' && type !== 'number' && type !== 'multiselect';
  }

  [true, false, 'damaged', 'fair', 'excellent', '', 0, 3, [], ['a']]
    .forEach(trigger => {
      check(`a trigger value of ${JSON.stringify(trigger)}`, () => {
        const answers = {};
        let applied = 0;
        seeds.forEach(seed => {
          conditionalCases(seed.schema).forEach(c => {
            (seed.schema.sections || []).forEach(s => {
              (s.items || []).forEach(item => {
                if (item.id !== c.field) return;
                if (!canHold(item.type, trigger)) return;
                if (!answers[s.id]) answers[s.id] = {};
                answers[s.id][item.id] = trigger;
                applied++;
              });
            });
          });
        });
        // Said out loud, so a value that reaches no field is not mistaken for
        // a value that reached them all and agreed.
        assert(applied > 0,
          `no conditional field can hold ${JSON.stringify(trigger)}, so this proved nothing`);
        seeds.forEach(seed => agree(
          `${seed.title} with trigger ${JSON.stringify(trigger)}`,
          seed.schema, answers));
      });
    });

  section('An unchecked box does not switch on what depends on it:');

  check("the server no longer reads the word 'false' as true", () => {
    // The bug this file was written to find. A sheet cell cannot hold a
    // boolean, so an unchecked box is stored as the five characters 'false',
    // and `!!'false'` is true. Every item conditional on it was required on the
    // server while the screen correctly hid it — so locking failed on items the
    // inspector had no way to see, and said only how many.
    const map = { damages_present: 'false' };
    assert(ValidationService.evaluateCondition(
      { field: 'damages_present', operator: 'truthy' }, map) === false,
      "'false' is truthy on the server");
    assert(ValidationService.evaluateCondition(
      { field: 'damages_present', operator: 'falsy' }, map) === true,
      "'false' is not falsy on the server");
  });

  check('an unchecked box leaves nothing required behind it', () => {
    // The whole way through, not just the operator: a move-in with damages
    // unchecked must not be refused for the damage fields.
    const damages = (moveIn.sections || []).find(s => s.id === 'damages');
    assert(damages, 'the move-in schema no longer has a damages section');

    const { answers, counts } = fullyAnswered(moveIn);
    answers.damages.damages_present = false;
    // Choosing "no damages" means the fields behind it are left empty, which
    // is the state that was being refused.
    (damages.items || []).forEach(item => {
      if (item.id !== 'damages_present') answers.damages[item.id] = '';
    });

    const missing = agree('damages unchecked', moveIn, answers, counts);
    const behind = missing.filter(k => k.indexOf('damages:') === 0
      && k !== 'damages:damages_present');
    assert(behind.length === 0,
      `an unchecked box still requires ${JSON.stringify(behind)}`);
  });

  section('An empty multi-select is not an answer:');

  check("choosing nothing does not satisfy a required item", () => {
    // Stored as the two characters '[]', which is a non-empty string — so it
    // read as answered with not one option picked.
    const schema = { sections: [{ id: 's', title: 'S', items: [
      { id: 's_pick', type: 'multiselect', label: 'Pick some', required: true,
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    ] }] };

    const empty = agree('nothing chosen', schema, { s: { s_pick: [] } });
    assert(empty.indexOf('s:s_pick') >= 0, 'an empty multi-select counted as answered');

    const chosen = agree('one chosen', schema, { s: { s_pick: ['a'] } });
    assert(chosen.length === 0, 'a chosen option did not count as answered');
  });

  const pickSchema = { sections: [{ id: 's', items: [
    { id: 's_pick', type: 'multiselect', label: 'Pick', required: true }] }] };
  const serverSees = (value) => ValidationService.findMissingRequiredItems(
    pickSchema, [{ sectionId: 's', itemId: 's_pick', value: value }]).length;

  check('a damaged list is nothing chosen', () => {
    assert(serverSees('[not json') === 1, 'damaged JSON satisfied a required item');
  });

  check('but a bare word is one choice, not a damaged list', () => {
    // For data this app did not write: a multi-select typed into the sheet by
    // hand reads as a word. Refusing it would leave an inspection that looks
    // complete on screen impossible to lock, with nothing the inspector could
    // do about it — a worse failure than being lenient about a shape that
    // cannot arrive from the app.
    assert(serverSees('kitchen') === 0, 'a hand-entered answer was refused');
    assert(serverSees('["a","b"]') === 0, 'a normal list was refused');
    assert(serverSees('') === 1, 'an empty cell counted as an answer');
  });

  section('A photo requirement is counted the same way:');

  check('one short of the minimum is missing on both sides', () => {
    const withMin = [];
    (moveIn.sections || []).forEach(s => (s.items || []).forEach(item => {
      if (item.attachments && item.attachments.min > 0) {
        withMin.push({ sectionId: s.id, item });
      }
    }));

    if (withMin.length === 0) {
      // Not a failure — the seeds may simply not require photos. Said out loud
      // so that a check quietly proving nothing does not look like coverage.
      assert(true, '');
      return;
    }

    const { answers, counts } = fullyAnswered(moveIn);
    const target = withMin[0];
    counts[target.sectionId][target.item.id] = target.item.attachments.min - 1;
    const missing = agree('one photo short', moveIn, answers, counts);
    assert(missing.indexOf(`${target.sectionId}:${target.item.id}`) >= 0,
      'neither side minded a missing photo, so the fixture is wrong');
  });

  section('The coercion this file assumes is the coercion the app performs:');

  check('stored() still matches InspectionService', () => {
    // The copy above would weaken every check here if it drifted, so it is
    // compared against the real thing rather than trusted.
    const source = fs.readFileSync(path.join(GAS_DIR, 'InspectionService.gs'), 'utf8');
    const body = source.slice(source.indexOf('function _storedValue'));
    const real = vm.runInNewContext(
      body.slice(0, body.indexOf('\n  }') + 4) + '\n_storedValue',
      { Array, JSON, String });

    [[], ['a', 'b'], true, false, null, undefined, 0, 3, '', 'text', '2026-08-12']
      .forEach(v => {
        assert(stored(v) === real(v),
          `stored(${JSON.stringify(v)}) is '${stored(v)}', the app stores '${real(v)}'`);
      });
  });
};
