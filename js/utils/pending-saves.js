/**
 * pending-saves.js
 * Saves that have been sent and not yet answered.
 *
 * Leaving a section used to wait for its save before drawing the next screen —
 * four buttons, all `await flushSave()`. On this backend that is about five
 * seconds, and an inspection has fifteen sections, so the wait was most of the
 * time spent filling one in.
 *
 * It bought nothing. What was typed is already in local state, so the next
 * screen is right either way; it is already in localStorage, so a failed save
 * loses nothing; and a failure already reports itself, on whichever screen the
 * person has reached by then. The wait was there to make the save feel
 * finished, not to make it safe.
 *
 * There is one place where it genuinely matters. Locking asks the server
 * whether every required item is answered, and a save still in flight is an
 * answer the server does not have yet — the lock would be refused over
 * something the person can see on their own screen. So instead of every
 * navigation waiting, the one action that depends on the server being current
 * waits, and only for as long as something is actually outstanding.
 */

const inFlight = new Set();

/**
 * Watch a save. Returns the same promise, so a caller that does want to wait
 * still can.
 *
 * Rejections are absorbed here and nowhere else: the save's own catch reports
 * them, and settled() must not turn one person's failed save into a thrown
 * error inside an unrelated screen.
 */
export function track(promise) {
  inFlight.add(promise);
  const forget = () => inFlight.delete(promise);
  promise.then(forget, forget);
  return promise;
}

/** Resolves once nothing is outstanding, immediately when nothing is. */
export function settled() {
  if (inFlight.size === 0) return Promise.resolve();
  // A settled save removes itself, and a save started while waiting is not
  // waited for — the snapshot is deliberate. Waiting for whatever arrives next
  // would let a section still being typed into hold up a lock indefinitely.
  return Promise.allSettled(Array.from(inFlight)).then(() => undefined);
}

/** How many are outstanding. For tests, and for anything that wants to say so. */
export function outstanding() {
  return inFlight.size;
}

/** Drop the lot without waiting. Signing out, and starting a test from clean. */
export function forgetAll() {
  inFlight.clear();
}
