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

  let _configCache = null;
  let _configCacheAt = 0;
  const CONFIG_CACHE_TTL_MS = 30 * 1000; // 30 sec

  function _loadConfigSheet() {
    const now = Date.now();
    if (_configCache && (now - _configCacheAt) < CONFIG_CACHE_TTL_MS) {
      return _configCache;
    }
    const sheet = SpreadsheetApp.openById(getWorkbookId()).getSheetByName('Config');
    if (!sheet) {
      _configCache = {};
      _configCacheAt = now;
      return _configCache;
    }
    const data = sheet.getDataRange().getValues();
    const map = {};
    for (let i = 1; i < data.length; i++) {
      const [key, value] = data[i];
      if (key) map[String(key)] = String(value);
    }
    _configCache = map;
    _configCacheAt = now;
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
    _configCacheAt = 0;
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
   * benchmarkPbkdf2() and raise this to the largest value that keeps login
   * under one second — see docs/user-administration-proposal.md, section 5.
   * Raising it does not invalidate existing passwords: the iteration count is
   * stored alongside each hash and old rows are upgraded on next login.
   */
  function getPbkdf2Iterations() {
    return getNumber('pbkdf2Iterations', 1000);
  }

  /**
   * Sixteen, not the twelve first proposed. Measurement on the real deployment
   * put a PBKDF2 iteration at ~2.5 ms, almost all of it the JavaScript/platform
   * boundary — a cost the attacker does not pay. The reachable work factor is
   * therefore low enough that length, not the derivation, is what protects
   * these accounts. At sixteen characters people write a phrase instead of a
   * word, which is worth far more here than any number of iterations.
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

  /** How long a cached Users/Devices row stays valid, in seconds. */
  function getAuthCacheTtlSeconds() {
    return getNumber('authCacheTtlSeconds', 60);
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
  };
})();
