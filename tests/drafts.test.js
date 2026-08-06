/**
 * drafts.test.js
 * The record of answers typed but not yet sent.
 *
 * The first frontend module with cover, and it earns it: everything else in
 * js/ fails visibly, while this one fails by losing an inspector's afternoon
 * quietly, on a device nobody is watching.
 *
 * Two rules carry the whole design, and both are here. A draft is cleared only
 * by a confirmed save — never by a failed one, which is what makes the offline
 * case work without any code that knows about being offline. And a save clears
 * only the items it was given, because anything typed while it was in flight
 * is still outstanding.
 */

const { section, check, assert } = require('./appsscript-stubs');

/** localStorage, close enough: string values, and it can be made to throw. */
function fakeLocalStorage() {
  const map = new Map();
  return {
    fail: false,
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i]; },
    getItem(k) {
      if (this.fail) throw new Error('SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (this.fail) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (this.fail) throw new Error('SecurityError');
      map.delete(k);
    },
    _map: map,
  };
}

module.exports = async function run() {
  // The module reads localStorage off the global at call time, so one import
  // is enough as long as the global is replaced between checks.
  const drafts = await import('../js/utils/drafts.js');

  function fresh() {
    const storage = fakeLocalStorage();
    global.localStorage = storage;
    return storage;
  }

  section('What is outstanding:');

  check('a change is readable straight back', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'minor', comment: 'scuff' } });
    const back = drafts.readDraft('INS-1', 'kitchen');
    assert(back.walls && back.walls.value === 'minor' && back.walls.comment === 'scuff',
      `got ${JSON.stringify(back)}`);
  });

  check('a later change merges rather than replaces', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'minor' } });
    drafts.rememberDraft('INS-1', 'kitchen', { floor: { value: 'ok' } });

    const back = drafts.readDraft('INS-1', 'kitchen');
    assert(back.walls && back.floor,
      `writing one item dropped the other: ${JSON.stringify(back)}`);
  });

  check('sections and inspections do not bleed into each other', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    drafts.rememberDraft('INS-1', 'bath', { walls: { value: 'b' } });
    drafts.rememberDraft('INS-2', 'kitchen', { walls: { value: 'c' } });

    assert(drafts.readDraft('INS-1', 'kitchen').walls.value === 'a', 'INS-1/kitchen');
    assert(drafts.readDraft('INS-1', 'bath').walls.value === 'b', 'INS-1/bath');
    assert(drafts.readDraft('INS-2', 'kitchen').walls.value === 'c', 'INS-2/kitchen');
  });

  check('nothing outstanding reads as nothing, not as a crash', () => {
    fresh();
    assert(Object.keys(drafts.readDraft('INS-NONE', 'kitchen')).length === 0, 'unknown inspection');
    assert(drafts.draftSectionIds('INS-NONE').length === 0, 'unknown inspection, sections');
  });

  section('Only a confirmed save clears it:');

  check('a save forgets exactly the items it sent', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', {
      walls: { value: 'a' }, floor: { value: 'b' },
    });

    // A save was in flight for walls; floor was typed while it was.
    drafts.forgetDraft('INS-1', 'kitchen', ['walls']);

    const back = drafts.readDraft('INS-1', 'kitchen');
    assert(!back.walls, 'the confirmed item was kept');
    assert(back.floor, 'an item typed during the save was discarded with it');
  });

  check('a section with nothing left disappears', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    drafts.forgetDraft('INS-1', 'kitchen', ['walls']);
    assert(drafts.draftSectionIds('INS-1').length === 0,
      `still listed: ${drafts.draftSectionIds('INS-1')}`);
  });

  check('and so does the inspection, leaving no key behind', () => {
    const storage = fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    drafts.forgetDraft('INS-1', 'kitchen', ['walls']);
    assert(storage.length === 0, `${storage.length} key(s) left on the device`);
  });

  check('one section clearing leaves the others alone', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    drafts.rememberDraft('INS-1', 'bath', { walls: { value: 'b' } });
    drafts.forgetDraft('INS-1', 'kitchen', ['walls']);

    assert(drafts.draftSectionIds('INS-1').join() === 'bath',
      `left: ${drafts.draftSectionIds('INS-1')}`);
  });

  check('forgetting something that was never there is harmless', () => {
    fresh();
    drafts.forgetDraft('INS-1', 'kitchen', ['walls']);
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    drafts.forgetDraft('INS-1', 'bath', ['walls']);
    assert(drafts.readDraft('INS-1', 'kitchen').walls, 'an unrelated forget took the answer');
  });

  section('A failed save keeps it — the offline case:');

  check('what was never confirmed is still there next time', () => {
    fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'minor' } });

    // The save threw, so forgetDraft was never reached. Nothing else runs.
    const back = drafts.readDraft('INS-1', 'kitchen');
    assert(back.walls && back.walls.value === 'minor',
      'work was lost by a save that failed');
  });

  section('Signing out:');

  check('takes every draft with it', () => {
    const storage = fresh();
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    drafts.rememberDraft('INS-2', 'bath', { walls: { value: 'b' } });

    drafts.clearAllDrafts();
    assert(storage.length === 0, `${storage.length} draft(s) left on a shared device`);
  });

  check('and leaves everything that is not a draft', () => {
    const storage = fresh();
    storage.setItem('handover.sessionToken', 'tok');
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });

    drafts.clearAllDrafts();
    assert(storage.getItem('handover.sessionToken') === 'tok',
      'the prefix scan took an unrelated key');
  });

  section('Storage that will not cooperate:');

  check('a write that throws does not throw at the caller', () => {
    const storage = fresh();
    storage.fail = true;
    drafts.rememberDraft('INS-1', 'kitchen', { walls: { value: 'a' } });
    // Private browsing and a full quota both throw. The change is still in the
    // in-memory buffer and will still be sent; only the safety net is lost.
  });

  check('a read that throws answers empty', () => {
    const storage = fresh();
    storage.fail = true;
    assert(Object.keys(drafts.readDraft('INS-1', 'kitchen')).length === 0, 'read');
    assert(drafts.draftSectionIds('INS-1').length === 0, 'sections');
  });

  check('and sign-out still completes', () => {
    const storage = fresh();
    storage.fail = true;
    drafts.clearAllDrafts();
  });
};
