/**
 * pending-saves.test.js
 * What waits for a save, and what no longer does.
 *
 * Leaving a section used to wait for its save before drawing the next screen.
 * On this backend that is about five seconds, and an inspection has fifteen
 * sections, so the wait was most of the time spent filling one in — and it
 * bought nothing. What was typed is already in local state and on the device,
 * and a failure reports itself wherever the person has reached by then.
 *
 * One thing does still depend on the server being current: locking asks
 * whether every required item is answered, and a save still in flight is an
 * answer the server does not have. Refusing a lock over something visible on
 * the screen in front of someone is a bad way to be fast.
 *
 * So the rules this file holds are: a rejected save must not become a thrown
 * error inside whatever screen happened to be waiting; and waiting must not be
 * open-ended, because a section still being typed into would otherwise hold up
 * a lock forever.
 */

const { section, check, assert } = require('./appsscript-stubs');

/** A promise with its settle handles, so a test can control the timing. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets every already-queued microtask run. */
const drain = () => new Promise(r => setImmediate(r));

module.exports = async function run() {
  const saves = await import('../js/utils/pending-saves.js');

  section('Nothing outstanding means nothing to wait for:');

  await check('settled() resolves straight away', async () => {
    saves.forgetAll();
    let done = false;
    saves.settled().then(() => { done = true; });
    await drain();
    assert(done, 'waited for nothing');
  });

  await check('and outstanding() says so', () => {
    saves.forgetAll();
    assert(saves.outstanding() === 0, `${saves.outstanding()} outstanding`);
  });

  section('A save in flight is waited for:');

  await check('settled() holds until it finishes', async () => {
    saves.forgetAll();
    const save = deferred();
    saves.track(save.promise);
    assert(saves.outstanding() === 1, 'the save was not tracked');

    let done = false;
    saves.settled().then(() => { done = true; });
    await drain();
    assert(!done, 'stopped waiting while the save was still in flight');

    save.resolve({ revision: 2 });
    await drain();
    assert(done, 'never stopped waiting after the save finished');
  });

  await check('and it stops being outstanding once it lands', async () => {
    saves.forgetAll();
    const save = deferred();
    saves.track(save.promise);
    save.resolve({});
    await drain();
    assert(saves.outstanding() === 0,
      `${saves.outstanding()} still outstanding after finishing`);
  });

  await check('two are both waited for', async () => {
    saves.forgetAll();
    const a = deferred();
    const b = deferred();
    saves.track(a.promise);
    saves.track(b.promise);

    let done = false;
    saves.settled().then(() => { done = true; });
    a.resolve({});
    await drain();
    assert(!done, 'stopped waiting with one still in flight');

    b.resolve({});
    await drain();
    assert(done, 'never stopped waiting');
  });

  section('A failed save does not become somebody else\'s error:');

  await check('settled() resolves rather than rejecting', async () => {
    // The save reports its own failure — a toast, the indicator, the draft left
    // in place. If the rejection escaped here it would land inside whichever
    // screen was waiting, as an error about locking rather than about saving.
    saves.forgetAll();
    const save = deferred();
    saves.track(save.promise);

    let resolved = false;
    let rejected = null;
    const waiting = saves.settled().then(() => { resolved = true; }, (e) => { rejected = e; });

    save.reject(new Error('save failed'));
    await waiting;
    assert(resolved && !rejected, `settled() rejected with ${rejected}`);
  });

  await check('and it stops being outstanding too', async () => {
    saves.forgetAll();
    const save = deferred();
    saves.track(save.promise);
    save.reject(new Error('save failed'));
    await drain();
    assert(saves.outstanding() === 0,
      'a failed save stayed outstanding, so the next lock would wait on it forever');
  });

  await check('track() hands the promise back unchanged', async () => {
    // The caller keeps its own then/catch — that is where the toast and the
    // revision update live.
    saves.forgetAll();
    const save = deferred();
    const returned = saves.track(save.promise);
    assert(returned === save.promise, 'track() replaced the promise');

    let caught = null;
    returned.catch(e => { caught = e; });
    save.reject(new Error('still mine'));
    await drain();
    assert(caught && caught.message === 'still mine',
      'the caller stopped seeing its own failure');
  });

  section('Waiting is not open-ended:');

  await check('a save started while waiting is not waited for', async () => {
    // Otherwise a section being typed into during the wait would keep the lock
    // waiting for as long as someone kept typing.
    saves.forgetAll();
    const first = deferred();
    saves.track(first.promise);

    let done = false;
    saves.settled().then(() => { done = true; });

    const second = deferred();
    saves.track(second.promise);
    first.resolve({});
    await drain();

    assert(done, 'the wait was extended by a save that started after it');
    assert(saves.outstanding() === 1, 'the later save stopped being tracked');
    second.resolve({});
  });
};
