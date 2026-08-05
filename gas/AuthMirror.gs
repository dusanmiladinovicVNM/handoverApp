/**
 * AuthMirror.gs
 * A fast copy of the rows that authentication reads on every request.
 *
 * Resolving a session needs one user row and one device row. Both live in the
 * spreadsheet, and the spreadsheet is the slowest thing this backend touches:
 * a measured request spent 4.9 s in auth against 123 ms of its own work, almost
 * all of it opening the workbook. Auth is the first code to touch Sheets in any
 * request, so auth is what paid for it.
 *
 * Three layers, fastest first:
 *
 *   CacheService        in-memory across executions, capped at six hours
 *   Script Properties   durable key-value, survives a cache eviction
 *   the sheet           canonical, and the only writer
 *
 * The sheet remains the source of truth. Nothing here is authoritative — these
 * are copies, refreshed from the sheet whenever they are missing or older than
 * the configured window, and dropped outright whenever the row is written.
 *
 * That last part is what makes the window safe. Every path that disables an
 * account, changes a role or revokes a device goes through UserService.update
 * or DeviceService.revoke, and both call remove() here. Revocation through the
 * app takes effect on the next request regardless of how long the window is.
 * What the window bounds is a change typed directly into the spreadsheet.
 *
 * Set authCacheTtlSeconds to 0 to switch the whole thing off and read through
 * to the sheet every time.
 */

const AuthMirror = (function () {

  function _ttlSeconds() {
    return Config.getAuthCacheTtlSeconds();
  }

  function _cache() {
    return CacheService.getScriptCache();
  }

  function _props() {
    return PropertiesService.getScriptProperties();
  }

  /** Properties entries carry their own timestamp; CacheService expires itself. */
  function _propKey(key) {
    return `am:${key}`;
  }

  /**
   * Look for a copy, newest layer first. Returns null when there is none worth
   * trusting, which tells the caller to read the sheet.
   */
  function get(key) {
    const ttl = _ttlSeconds();
    if (ttl <= 0) return null;

    try {
      const hit = _cache().get(key);
      if (hit) return JSON.parse(hit);
    } catch (e) {
      // A cache that cannot be read is only slower.
    }

    try {
      const stored = _props().getProperty(_propKey(key));
      if (stored) {
        const entry = JSON.parse(stored);
        const ageSeconds = (Date.now() - (entry.at || 0)) / 1000;
        if (ageSeconds < ttl) {
          // Promote back into the fast layer so the next request skips this.
          _putCache(key, entry.v, ttl);
          return entry.v;
        }
        // Too old to trust. Drop it rather than leave it to be found again.
        _props().deleteProperty(_propKey(key));
      }
    } catch (e) {
      Utils.log('WARN', 'Auth mirror read failed', { key: key, error: e.message });
    }

    return null;
  }

  function put(key, value) {
    const ttl = _ttlSeconds();
    if (ttl <= 0 || value === null || value === undefined) return;

    _putCache(key, value, ttl);
    try {
      _props().setProperty(_propKey(key), JSON.stringify({ v: value, at: Date.now() }));
    } catch (e) {
      // Script Properties has a size limit. Losing the durable copy costs a
      // sheet read after the cache expires, which is where this started.
      Utils.log('WARN', 'Auth mirror write failed', { key: key, error: e.message });
    }
  }

  function _putCache(key, value, ttl) {
    try {
      // CacheService refuses anything over six hours.
      _cache().put(key, JSON.stringify(value), Math.min(ttl, 21600));
    } catch (e) {
      // Same as above: slower, not wrong.
    }
  }

  /**
   * Forget a row in every layer. Called on write, which is what keeps
   * revocation immediate no matter how long the window is.
   */
  function remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.length === 0) return;
    try {
      _cache().removeAll(list);
    } catch (e) {}
    list.forEach(key => {
      try {
        _props().deleteProperty(_propKey(key));
      } catch (e) {}
    });
  }

  return { get, put, remove };
})();
