/**
 * utils/drafts.js
 * Answers that have been typed but have not reached the server yet.
 *
 * The editor already buffers changes and sends them on a debounce, and it
 * flushes on navigation and on beforeunload. That covers leaving the page. It
 * does not cover the tab being killed, the phone running out of battery, the
 * browser reclaiming memory in the background, or the save simply failing
 * because there is no signal — which is the normal state of an empty flat.
 * In all of those the buffer dies in a closure and the typing is gone.
 *
 * So every change is written here the moment it is made, and removed only once
 * the server has confirmed it. Nothing is "saved locally then synced later" —
 * this is a record of what is *outstanding*, and it is empty whenever the
 * server is up to date.
 *
 * localStorage rather than IndexedDB, deliberately. IndexedDB is asynchronous,
 * and a write started during beforeunload or a background kill is not
 * guaranteed to finish; localStorage writes synchronously and is done before
 * the next line runs. Photos would need IndexedDB for their size, but answers
 * are a few hundred bytes and correctness under a sudden kill matters more
 * here than capacity.
 */

const PREFIX = 'handover.draft.';

/**
 * Its own read/write rather than store.js's, because store.js clears drafts on
 * sign-out and importing back the other way would make a cycle. A module whose
 * job is to survive adverse conditions is also the wrong one to give extra
 * dependencies.
 */
function readJson(k) {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeJson(k, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(value));
  } catch (_) {
    // A full quota throws here. The change stays in the in-memory buffer and
    // will still be sent; only the crash-safety net is lost.
  }
}

function key(inspectionId) {
  return PREFIX + inspectionId;
}

/**
 * Record that these items are typed but unsent.
 *
 * Merged rather than replaced: a section may be edited, left, and returned to,
 * and an item already outstanding must not be dropped by a later write that
 * happens to carry different items.
 */
export function rememberDraft(inspectionId, sectionId, items) {
  if (!inspectionId || !sectionId || !items || Object.keys(items).length === 0) return;

  const draft = readJson(key(inspectionId)) || { sections: {} };
  if (!draft.sections) draft.sections = {};
  const section = { ...(draft.sections[sectionId] || {}) };

  Object.keys(items).forEach(itemId => {
    section[itemId] = { ...(section[itemId] || {}), ...items[itemId] };
  });

  draft.sections[sectionId] = section;
  draft.updatedAt = new Date().toISOString();
  writeJson(key(inspectionId), draft);
}

/**
 * Forget items the server has now confirmed.
 *
 * Only the named items: a save in flight covers what it was given, and
 * anything typed while it was in flight is still outstanding. Clearing the
 * whole section here would silently discard those.
 */
export function forgetDraft(inspectionId, sectionId, itemIds) {
  const draft = readJson(key(inspectionId));
  if (!draft || !draft.sections || !draft.sections[sectionId]) return;

  const section = { ...draft.sections[sectionId] };
  (itemIds || []).forEach(itemId => { delete section[itemId]; });

  if (Object.keys(section).length === 0) delete draft.sections[sectionId];
  else draft.sections[sectionId] = section;

  // An inspection with nothing outstanding leaves nothing behind.
  if (Object.keys(draft.sections).length === 0) writeJson(key(inspectionId), null);
  else writeJson(key(inspectionId), draft);
}

/** What is still outstanding for one section, as { itemId: {value, comment} }. */
export function readDraft(inspectionId, sectionId) {
  const draft = readJson(key(inspectionId));
  if (!draft || !draft.sections) return {};
  return draft.sections[sectionId] || {};
}

/** Every section of one inspection that has something outstanding. */
export function draftSectionIds(inspectionId) {
  const draft = readJson(key(inspectionId));
  if (!draft || !draft.sections) return [];
  return Object.keys(draft.sections);
}

/**
 * Drop every draft on this device.
 *
 * Called on sign-out, with the same reasoning as the other caches: comments
 * name real people and describe their homes, and a shared device must not keep
 * them. The cost is that signing out while genuinely offline discards work
 * that never reached the server — rare, deliberate, and the safer side of the
 * trade.
 */
export function clearAllDrafts() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) doomed.push(k);
    }
    doomed.forEach(k => localStorage.removeItem(k));
  } catch (_) {
    // Private browsing and a full quota both throw. Neither is a reason to
    // fail a sign-out.
  }
}
