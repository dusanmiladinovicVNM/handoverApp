/**
 * inspection-cache.js
 * The last inspections opened, kept on the device.
 *
 * Opening one was measured at 3 329 ms, of which about 2 900 is transport: the
 * /exec redirect, a body served from another host, and a cold script. The
 * server's own share is 448 ms. So no amount of work on the backend gets this
 * screen under three seconds — the only way past it is not to make the request
 * before drawing.
 *
 * That is what makes this safe rather than reckless, and it is worth being
 * precise about why, because a handover report is evidence in a dispute and
 * showing a stale one is not a small thing.
 *
 * Nothing here is trusted to decide anything. It decides what to *draw* while a
 * fresh copy is on its way. Every write still goes to the server, which re-reads
 * the row: saving a section sends the revision it read and is refused with
 * CONFLICT if the section moved on; locking re-validates every required item;
 * signing and unlocking check the status. A screen drawn from a remembered copy
 * can be out of date, and the machinery that catches that was built before this
 * — it is not being invented to justify it.
 *
 * IndexedDB rather than localStorage. A payload is tens of kilobytes and
 * localStorage is a few megabytes shared with the drafts, which hold work that
 * has not reached the server: losing a cached inspection costs a request, and
 * losing a draft costs someone's afternoon. They should not compete.
 *
 * Every operation degrades to "no cache" rather than throwing. Private
 * browsing, a denied storage permission and a full disk all fail here, and none
 * of them is a reason for the app to stop working.
 */

const DB_NAME = 'handover';
const DB_VERSION = 1;
const STORE = 'inspections';

/**
 * How many to keep.
 *
 * Not for space — a payload carries no image bytes, only their metadata, so
 * twenty is a couple of megabytes at most. It is for what is left behind: this
 * holds addresses, tenant names and telephone numbers, and a device that has
 * been used once for a colleague's inspection should not keep it indefinitely.
 * Sign-out clears the lot; this bounds what accumulates before then.
 */
const KEEP = 20;

let _dbPromise = null;

function _open() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (_) {
      // No IndexedDB at all. Resolved rather than rejected: every caller wants
      // "there is no cache", not an error to handle.
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'inspectionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Firefox in private mode leaves the request pending rather than failing,
    // so a launch would otherwise wait on it forever.
    request.onblocked = () => resolve(null);
  });

  return _dbPromise;
}

function _tx(db, mode, fn) {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (_) {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    let result = null;
    try {
      result = fn(store);
    } catch (_) {
      resolve(null);
      return;
    }
    tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

/** Wraps a request so _tx can hand back its result once the transaction lands. */
function _req(request) {
  return { __req: request };
}

/** The remembered payload for one inspection, or null. */
export async function read(inspectionId) {
  const db = await _open();
  if (!db) return null;
  const row = await _tx(db, 'readonly', (store) => _req(store.get(inspectionId)));
  return row ? row.data : null;
}

/**
 * Remember what the server last said about one inspection.
 *
 * Not awaited by its callers: a screen has already been drawn by the time this
 * runs, and a write that fails changes nothing except that the next open is
 * slow again.
 */
export async function write(inspectionId, data) {
  const db = await _open();
  if (!db) return;
  await _tx(db, 'readwrite', (store) => {
    store.put({ inspectionId, data, fetchedAt: Date.now() });
  });
  await _prune(db);
}

export async function forget(inspectionId) {
  const db = await _open();
  if (!db) return;
  await _tx(db, 'readwrite', (store) => { store.delete(inspectionId); });
}

/**
 * Everything, on sign-out.
 *
 * These payloads name people and their homes. A device may be shared, and the
 * next person to sign in on it has no business seeing the last one's work.
 */
export async function clearAll() {
  const db = await _open();
  if (!db) return;
  await _tx(db, 'readwrite', (store) => { store.clear(); });
}

/** Drop the oldest once there are more than KEEP. */
async function _prune(db) {
  const rows = await _tx(db, 'readonly', (store) => _req(store.getAll()));
  if (!rows || rows.length <= KEEP) return;

  const doomed = rows
    .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))
    .slice(KEEP)
    .map(r => r.inspectionId);

  await _tx(db, 'readwrite', (store) => {
    doomed.forEach(id => store.delete(id));
  });
}

/** For tests: forget the connection so a fresh fake can be installed. */
export function _reset() {
  _dbPromise = null;
}
