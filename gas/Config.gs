/**
 * Config.gs
 * Reads runtime configuration from PropertiesService (set once during setup)
 * and from the Config sheet (editable by admin without code change).
 */

const Config = (function () {
  const props = PropertiesService.getScriptProperties();

  // --- From Script Properties (set during setup) ---

  function getWorkbookId() {
    const id = props.getProperty('WORKBOOK_ID');
    if (!id) throw new Error('WORKBOOK_ID not configured. See setup-guide.md.');
    return id;
  }

  function getInspectionsRootFolderId() {
    const id = props.getProperty('INSPECTIONS_ROOT_FOLDER_ID');
    if (!id) throw new Error('INSPECTIONS_ROOT_FOLDER_ID not configured.');
    return id;
  }

  function getTemplateDocId() {
    const id = props.getProperty('TEMPLATE_DOC_ID');
    if (!id) throw new Error('TEMPLATE_DOC_ID not configured.');
    return id;
  }

  function getTokenSecret() {
    const s = props.getProperty('TOKEN_SECRET');
    if (!s) throw new Error('TOKEN_SECRET not configured.');
    return s;
  }

  function getAdminEmails() {
    const emails = props.getProperty('ADMIN_EMAILS') || '';
    return emails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  }

  function getFrontendUrl() {
    const url = props.getProperty('FRONTEND_URL');
    if (!url) throw new Error('FRONTEND_URL not configured.');
    return url.endsWith('/') ? url : url + '/';
  }

  // --- From Config sheet (live, editable) ---

  // Held for the life of one execution, which is the life of one request —
  // module state does not survive between them, so the TTL this once carried
  // could never expire and never applied. Reads go through SheetService so the
  // workbook is opened once per request rather than once here and once there.
  let _configCache = null;

  function _loadConfigSheet() {
    if (_configCache) return _configCache;

    const map = {};
    try {
      SheetService.getConfigRows().forEach(row => {
        if (row.key) map[String(row.key)] = String(row.value);
      });
    } catch (e) {
      // A missing or unreadable Config sheet means every getter falls back to
      // its default, which is a working app rather than a broken one.
      Utils.log('WARN', 'Config sheet unreadable, using defaults', { error: e.message });
    }
    _configCache = map;
    return _configCache;
  }

  function getString(key, fallback) {
    const cfg = _loadConfigSheet();
    return cfg[key] !== undefined ? cfg[key] : fallback;
  }

  function getNumber(key, fallback) {
    const cfg = _loadConfigSheet();
    if (cfg[key] === undefined) return fallback;
    const n = Number(cfg[key]);
    return isNaN(n) ? fallback : n;
  }

  function invalidateCache() {
    _configCache = null;
  }

  // --- Convenience getters for common config keys ---

  function getDefaultTokenTtlHours() {
    return getNumber('defaultTokenTtlHours', 168);
  }

  function getMaxAttachmentsPerItem() {
    return getNumber('maxAttachmentsPerItem', 5);
  }

  function getMaxAttachmentsPerInspection() {
    return getNumber('maxAttachmentsPerInspection', 80);
  }

  function getImageMaxDimPx() {
    return getNumber('imageMaxDimPx', 1600);
  }

  function getImageJpegQuality() {
    return getNumber('imageJpegQuality', 0.75);
  }

  // --- Accounts and sessions ---

  /**
   * PBKDF2 work factor.
   *
   * The default is deliberately low. Measure on the real deployment with
   * benchmarkPbkdf2() and set this to what it prints — the largest value that
   * keeps a sign-in near 2.5 s, which on this deployment is around 3000.
   *
   * Raising it does not invalidate existing passwords: the iteration count is
   * stored alongside each hash and old rows are upgraded on next login. So
   * leaving it below the measurement buys nothing and costs the difference.
   */
  function getPbkdf2Iterations() {
    return getNumber('pbkdf2Iterations', 1000);
  }

  /**
   * Sixteen, not the twelve first proposed.
   *
   * A PBKDF2 iteration costs ~0.7 ms here, almost all of it the
   * JavaScript/platform boundary — a cost the attacker does not pay, since
   * native code pays only for the SHA-256. Even at 3000 iterations a guess
   * against a stolen sheet costs the attacker roughly 6000 SHA-256 operations,
   * which a GPU does by the million per second.
   *
   * So length, not the derivation, is what protects these accounts. At sixteen
   * characters people write a phrase instead of a word, and that is worth more
   * than any iteration count reachable on this platform.
   *
   * (An earlier version of this comment cited 2.5 ms, from a benchmark that
   * timed a cold pass. The figure was wrong by a factor of four; the conclusion
   * it supported was not.)
   */
  function getPasswordMinLength() {
    return getNumber('passwordMinLength', 16);
  }

  function getSessionTtlHours() {
    return getNumber('sessionTtlHours', 12);
  }

  function getDeviceTtlDays() {
    return getNumber('deviceTtlDays', 60);
  }

  function getSetPasswordTtlHours() {
    return getNumber('setPasswordTtlHours', 48);
  }

  function getLoginMaxFailures() {
    return getNumber('loginMaxFailures', 5);
  }

  function getLoginLockMinutes() {
    return getNumber('loginLockMinutes', 15);
  }

  /**
   * How long a cached Users/Devices row stays valid, in seconds.
   *
   * Thirty minutes, not the sixty seconds this started at. The short window was
   * guarding against something the code already handles: every path that
   * disables an account, changes a role or revokes a device goes through
   * UserService.update or DeviceService.revoke, and both drop the cached entry
   * on the spot. Revocation through the app is immediate at any TTL.
   *
   * What the window actually bounds is a change made by editing the spreadsheet
   * by hand, which then takes up to this long to be noticed. That is a good
   * reason to disable an account through the screen rather than the sheet, and
   * a poor reason to make every request pay for a sheet read.
   *
   * It is worth paying for: resolving a session is the first thing to touch
   * Sheets in any request, so it was auth that paid to open the workbook —
   * measured at 4.9 s on a request whose own work took 123 ms.
   */
  function getAuthCacheTtlSeconds() {
    return getNumber('authCacheTtlSeconds', 1800);
  }

  /**
   * A request slower than this records its own timing breakdown in AuditLog.
   *
   * Set to 0 to record every request. Occasional outliers are the ones worth
   * catching, and they are rare enough that the extra write costs nothing in
   * aggregate — while an always-on log would add a write to every call in order
   * to study the few that matter.
   */
  function getSlowRequestMs() {
    return getNumber('slowRequestMs', 5000);
  }

  return {
    getWorkbookId,
    getInspectionsRootFolderId,
    getTemplateDocId,
    getTokenSecret,
    getAdminEmails,
    getFrontendUrl,
    getString,
    getNumber,
    invalidateCache,
    getDefaultTokenTtlHours,
    getMaxAttachmentsPerItem,
    getMaxAttachmentsPerInspection,
    getImageMaxDimPx,
    getImageJpegQuality,
    getPbkdf2Iterations,
    getPasswordMinLength,
    getSessionTtlHours,
    getDeviceTtlDays,
    getSetPasswordTtlHours,
    getLoginMaxFailures,
    getLoginLockMinutes,
    getAuthCacheTtlSeconds,
    getSlowRequestMs,
  };
})();
