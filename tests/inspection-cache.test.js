/**
 * inspection-cache.test.js
 * The last inspections opened, kept on the device.
 *
 * Opening one was measured at 3 329 ms, of which about 2 900 is transport and
 * 448 is the server actually working. No amount of backend effort gets that
 * screen under three seconds; the only way past it is to draw before asking.
 *
 * Which is fine for a list of jobs and a serious claim for a handover report,
 * so the rules below are the ones that make it defensible rather than merely
 * fast.
 *
 * A remembered copy decides what to draw and nothing else. Every write still
 * goes to the server, which re-reads the row.
 *
 * A device that cannot store anything must still run. Private browsing, a
 * denied permission and a full disk all fail here, and none of them is a
 * reason for the app to stop.
 *
 * And it must not accumulate. These payloads name people and their homes.
 */

const { section, check, assert, withoutComments } = require('./appsscript-stubs');

/**
 * IndexedDB, near enough: object stores, transactions that complete on a later
 * turn, and the ability to fail the way a browser fails.
 */
function fakeIndexedDB(options) {
  const opts = options || {};
  const stores = new Map();

  const later = (fn) => setTimeout(fn, 0);

  function makeRequest(work) {
    const request = { onsuccess: null, onerror: null, result: undefined };
    later(() => {
      try {
        request.result = work();
        if (request.onsuccess) request.onsuccess();
      } catch (e) {
        if (request.onerror) request.onerror();
      }
    });
    return request;
  }

  function objectStore(name) {
    const data = stores.get(name);
    return {
      get: (key) => makeRequest(() => data.get(key)),
      getAll: () => makeRequest(() => Array.from(data.values())),
      put: (row) => makeRequest(() => {
        if (opts.failWrites) throw new Error('QuotaExceededError');
        data.set(row.inspectionId, row);
      }),
      delete: (key) => makeRequest(() => { data.delete(key); }),
      clear: () => makeRequest(() => { data.clear(); }),
    };
  }

  return {
    _stores: stores,
    open() {
      if (opts.openThrows) throw new Error('SecurityError');
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null,
                        onblocked: null, result: null };
      later(() => {
        if (opts.openFails) { if (request.onerror) request.onerror(); return; }
        if (opts.openBlocks) { if (request.onblocked) request.onblocked(); return; }

        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => { stores.set(n, new Map()); return objectStore(n); },
          transaction: (name, mode) => {
            if (opts.txThrows) throw new Error('InvalidStateError');
            const tx = { oncomplete: null, onerror: null, onabort: null,
                         objectStore: () => objectStore(name) };
            // Completes after the requests made inside it, which is what the
            // real one does and what the module relies on.
            later(() => later(() => { if (tx.oncomplete) tx.oncomplete(); }));
            return tx;
          },
        };
        request.result = db;
        if (!stores.has('inspections')) {
          if (request.onupgradeneeded) request.onupgradeneeded();
        }
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

const payload = (id, status) => ({
  inspection: { inspectionId: id, status: status || 'draft', propertyAddress: 'Dobricka 17' },
  schema: { sections: [] },
  answers: {}, revisions: {}, attachments: [], signatures: [],
});

module.exports = async function run() {
  const cache = await import('../js/utils/inspection-cache.js');

  /** A fresh module state over a fresh fake, since the connection is memoised. */
  const fresh = (options) => {
    global.indexedDB = fakeIndexedDB(options);
    cache._reset();
  };

  section('What was written comes back:');

  await check('an inspection is remembered and read', async () => {
    fresh();
    await cache.write('INS-1', payload('INS-1'));
    const back = await cache.read('INS-1');
    assert(back && back.inspection.inspectionId === 'INS-1', `got ${JSON.stringify(back)}`);
    assert(back.inspection.propertyAddress === 'Dobricka 17', 'the payload was altered');
  });

  await check('one that was never written reads as nothing', async () => {
    fresh();
    assert(await cache.read('INS-NONE') === null, 'a phantom inspection');
  });

  await check('writing again replaces it', async () => {
    // Locking, signing and assigning all write here after the fact. A cache
    // that kept the first copy would show an inspection as draft forever.
    fresh();
    await cache.write('INS-1', payload('INS-1', 'draft'));
    await cache.write('INS-1', payload('INS-1', 'signed'));
    const back = await cache.read('INS-1');
    assert(back.inspection.status === 'signed', `still ${back.inspection.status}`);
  });

  await check('forgetting one leaves the others', async () => {
    fresh();
    await cache.write('INS-1', payload('INS-1'));
    await cache.write('INS-2', payload('INS-2'));
    await cache.forget('INS-1');
    assert(await cache.read('INS-1') === null, 'it was not forgotten');
    assert(await cache.read('INS-2') !== null, 'the wrong one went');
  });

  section('Signing out leaves nothing behind:');

  await check('clearAll empties it', async () => {
    // These payloads carry addresses, tenant names and telephone numbers, and
    // a device may be shared.
    fresh();
    await cache.write('INS-1', payload('INS-1'));
    await cache.write('INS-2', payload('INS-2'));
    await cache.clearAll();
    assert(await cache.read('INS-1') === null, 'an inspection survived sign-out');
    assert(await cache.read('INS-2') === null, 'an inspection survived sign-out');
  });

  section('It does not grow without limit:');

  await check('only the most recent are kept', async () => {
    fresh();
    for (let i = 1; i <= 25; i++) {
      // eslint-disable-next-line no-await-in-loop
      await cache.write(`INS-${i}`, payload(`INS-${i}`));
    }
    assert(await cache.read('INS-25') !== null, 'the newest was dropped');
    assert(await cache.read('INS-1') === null,
      'the oldest was kept, so nothing is ever released');
  });

  section('A device that cannot store anything still works:');

  const brokenStores = [
    ['IndexedDB is missing entirely', { openThrows: true }],
    ['opening the database fails', { openFails: true }],
    ['opening never completes', { openBlocks: true }],
    ['transactions cannot be started', { txThrows: true }],
    ['writes are refused', { failWrites: true }],
  ];

  for (const [label, options] of brokenStores) {
    // eslint-disable-next-line no-await-in-loop
    await check(`${label}: reads as empty rather than throwing`, async () => {
      fresh(options);
      let threw = null;
      let value = 'unset';
      try {
        await cache.write('INS-1', payload('INS-1'));
        value = await cache.read('INS-1');
        await cache.forget('INS-1');
        await cache.clearAll();
      } catch (e) { threw = e; }

      assert(!threw, `threw ${threw && threw.message} — the app would not open`);
      assert(value === null,
        `read returned ${JSON.stringify(value)} instead of nothing`);
    });
  }

  await check('and the module is usable again once storage returns', async () => {
    // A denied permission on one launch must not poison the next.
    fresh({ openFails: true });
    await cache.write('INS-1', payload('INS-1'));
    assert(await cache.read('INS-1') === null, 'the broken run stored something');

    fresh();
    await cache.write('INS-1', payload('INS-1'));
    assert(await cache.read('INS-1') !== null, 'the working run stayed broken');
  });

  section('The rule that makes drawing from memory defensible:');

  await check('a background refresh never overwrites unsaved work', async () => {
    // The one that would have been a real loss. setInspectionData replaces the
    // answers wholesale, so applying a reply that left the server *before*
    // somebody started typing would overwrite what they typed — with an older
    // copy, silently, while they were looking at it.
    //
    // Checked in pages.js rather than here because the guard lives at the seam
    // between the fetch and the store, and there is nothing to import: the
    // source is the artefact.
    const fs = require('fs');
    const path = require('path');
    // Comments stripped first. The comment above the guard warns about
    // setInspectionData by name, so matching the raw text finds the word before
    // the guard and concludes the guard runs too late — the same mistake, made
    // by the check rather than by the code.
    const source = withoutComments(fs.readFileSync(
      path.join(__dirname, '..', 'js', 'pages.js'), 'utf8'));

    const revalidate = source.slice(
      source.indexOf('function _revalidate('),
      source.indexOf('\n}', source.indexOf('function _revalidate(')));

    assert(revalidate.indexOf('setInspectionData') >= 0,
      '_revalidate no longer applies anything, so this checks nothing');

    const guard = revalidate.indexOf('draftSectionIds');
    const apply = revalidate.indexOf('setInspectionData');
    assert(guard >= 0, 'the refresh does not consult the drafts at all');
    assert(guard < apply,
      'the drafts are checked after the state is replaced, which is too late');
    assert(revalidate.indexOf('outstandingSaves') >= 0
      && revalidate.indexOf('outstandingSaves') < apply,
      'a save still in flight would be overwritten by an older reply');
  });

  await check('and a status change is not applied quietly', async () => {
    // Answers arriving in the background is fine. Discovering that what you are
    // about to edit has been locked, or signed, is not — it changes what may be
    // done on the screen that was drawn a moment ago.
    const fs = require('fs');
    const path = require('path');
    const source = withoutComments(fs.readFileSync(
      path.join(__dirname, '..', 'js', 'pages.js'), 'utf8'));
    const revalidate = source.slice(
      source.indexOf('function _revalidate('),
      source.indexOf('\n}', source.indexOf('function _revalidate(')));

    assert(/status !== shownStatus/.test(revalidate),
      'the refresh does not compare the status it replaced');
    assert(/toast/i.test(revalidate),
      'a changed status is applied without saying so');
  });

  await check('a failed refresh leaves the screen alone', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = withoutComments(fs.readFileSync(
      path.join(__dirname, '..', 'js', 'pages.js'), 'utf8'));
    const revalidate = source.slice(
      source.indexOf('function _revalidate('),
      source.indexOf('\n}', source.indexOf('function _revalidate(')));

    const catchBlock = revalidate.slice(revalidate.indexOf('.catch('));
    assert(catchBlock.length > 0, '_revalidate does not handle a failed fetch');
    assert(catchBlock.indexOf('setInspectionData') < 0
      && catchBlock.indexOf('showError') < 0,
      'a refresh that could not reach the server disturbs a usable screen');
  });

  section('Three risks the cache introduced, and what closes them:');

  await check('a locked inspection is announced even to someone typing', async () => {
    // The first version held the status back along with the answers whenever
    // anything was unsaved, which got it backwards. Someone who has started
    // typing is exactly who most needs to know the inspection was locked while
    // they were reading it — otherwise they keep typing into a screen that says
    // draft and every save fails, citing a status they cannot see.
    const fs = require('fs');
    const path = require('path');
    const source = withoutComments(fs.readFileSync(
      path.join(__dirname, '..', 'js', 'pages.js'), 'utf8'));
    const revalidate = source.slice(
      source.indexOf('function _revalidate('),
      source.indexOf('\n}', source.indexOf('function _revalidate(')));

    const status = revalidate.indexOf('statusChanged');
    const guard = revalidate.indexOf('draftSectionIds');
    assert(status >= 0, 'the status is no longer handled separately');
    assert(status < guard,
      'the status is still held back behind the unsaved-work guard');
  });

  await check('a tenant does not read what staff left on the device', async () => {
    // getInspection strips tenantTokenHash, currentNonce and createdBy from a
    // tenant's copy. Reading the cache regardless would hand back whatever the
    // last viewer stored — and the device the landlord passes across to be
    // signed on is the landlord's own.
    const fs = require('fs');
    const path = require('path');
    const source = withoutComments(fs.readFileSync(
      path.join(__dirname, '..', 'js', 'pages.js'), 'utf8'));
    const ensure = source.slice(
      source.indexOf('async function ensureInspection('),
      source.indexOf('\n}', source.indexOf('async function ensureInspection(')));

    assert(/authMode === 'tenant'/.test(ensure),
      'the cache is read without asking who is looking');
    assert(ensure.indexOf("authMode === 'tenant'") < ensure.indexOf('inspectionCache.read'),
      'the check comes after the read, which is too late');
  });

  await check('and nothing writes a tenant copy into it either', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = withoutComments(fs.readFileSync(
      path.join(__dirname, '..', 'js', 'pages.js'), 'utf8'));

    // Every write must be behind the same question. One that is not would put a
    // tenant's stripped payload where staff will read it back, which is the
    // same fault in the other direction.
    const writes = source.split('inspectionCache.write(').length - 1;
    const guarded = source.split(/authMode !== 'tenant'\) inspectionCache\.write\(/).length - 1;
    assert(writes > 0, 'nothing writes to the cache, so this checks nothing');
    assert(writes === guarded,
      `${writes - guarded} of ${writes} cache writes are not asking who is looking`);
  });
};
