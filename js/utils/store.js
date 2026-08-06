/**
 * utils/store.js
 * Small JSON-shaped wrapper over localStorage, plus the list of keys that hold
 * fetched data rather than credentials.
 *
 * Every access is wrapped: private browsing and a full quota both make
 * localStorage throw, and neither is a reason to break the app. A cache that
 * cannot be read is only slower.
 */

import { clearAllDrafts } from './drafts.js';

export function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function writeJson(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {}
}

/**
 * Data kept on the device purely to make the app open quickly.
 *
 * Some of it describes real people — addresses, tenant names — so it is cleared
 * on sign-out rather than left behind on a device that may be shared. It is
 * listed here, in one place, so that adding a cache and forgetting to clear it
 * takes deliberate effort.
 */
export const CACHE_KEYS = {
  user: 'handover.user',
  inspectionList: 'handover.inspectionList',
};

export function clearCaches() {
  Object.keys(CACHE_KEYS).forEach(name => writeJson(CACHE_KEYS[name], null));
  // Drafts are keyed per inspection rather than by a fixed name, so they
  // cannot be listed above. They hold the same kind of data and go the same
  // way — see utils/drafts.js for what that costs.
  clearAllDrafts();
}
