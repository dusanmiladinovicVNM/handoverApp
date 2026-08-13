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

  /**
   * The Config sheet, in two layers.
   *
   * The per-execution copy is the life of one request; module state does not
   * survive between them, so the TTL this once carried could never expire and
   * never applied.
   *
   * Above it sits CacheService, and that layer exists because of a circle
   * measured on this deployment. Resolving a session asks AuthMirror whether it
   * may use a remembered row; AuthMirror asks Config for the window; Config
   * opened the workbook to answer. So the cache built to keep authentication
   * off the spreadsheet had to touch the spreadsheet to decide whether it was
   * allowed to. A `me` request that read nothing still spent 1.1 s in auth, 592
   * of them opening the workbook for one config lookup.
   *
   * Five minutes, not the six hours used for auth rows and schemas. Config is
   * how a deployment is tuned, and someone changing a value expects it to take
   * effect while they are still looking at the sheet. Five minutes removes the
   * workbook open from nearly every request and still behaves the way the sheet
   * being "live, editable" implies. reloadConfig() makes an edit take hold at
   * once.
   */
  const CACHE_KEY = 'cfg:sheet';
  const CACHE_TTL_SECONDS = 300;

  let _configCache = null;

  function _loadConfigSheet() {
    if (_configCache) return _configCache;

    try {
      const hit = CacheService.getScriptCache().get(CACHE_KEY);
      if (hit) {
        _configCache = JSON.parse(hit);
        return _configCache;
      }
    } catch (e) {
      // A cache that cannot be read is only slower.
    }

    const map = {};
    let read = false;
    try {
      SheetService.getConfigRows().forEach(row => {
        if (row.key) map[String(row.key)] = String(row.value);
      });
      read = true;
    } catch (e) {
      // A missing or unreadable Config sheet means every getter falls back to
      // its default, which is a working app rather than a broken one.
      Utils.log('WARN', 'Config sheet unreadable, using defaults', { error: e.message });
    }

    // Only remember a map that came from the sheet. Caching the empty one would
    // pin every setting to its default for the next five minutes on the
    // strength of a single failed read.
    if (read) {
      try {
        CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(map), CACHE_TTL_SECONDS);
      } catch (e) {}
    }

    _configCache = map;
    return _configCache;
  }

  function getString(key, fallback) {
    const cfg = _loadConfigSheet();
    return cfg[key] !== undefined ? cfg[key] : fallback;
  }

  /**
   * A value that will not parse falls back to the default, and says so.
   *
   * The silent version of this hid a real fault for weeks: the Config sheet had
   * `passwordMinLength` with the word `passwordMinLength` in its value column,
   * and because 16 is also the default, nothing looked wrong anywhere. A
   * setting that appears to be configured but is not is worse than one that is
   * missing.
   */
  function getNumber(key, fallback) {
    const cfg = _loadConfigSheet();
    if (cfg[key] === undefined || cfg[key] === '') return fallback;
    const n = Number(cfg[key]);
    if (isNaN(n)) {
      Utils.log('WARN', 'Config value is not a number, using the default', {
        key: key, value: cfg[key], using: fallback,
      });
      return fallback;
    }
    return n;
  }

  /** Forget both layers, so the next read goes to the sheet. */
  function invalidateCache() {
    _configCache = null;
    try {
      CacheService.getScriptCache().remove(CACHE_KEY);
    } catch (e) {}
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

  /**
   * The largest single photograph uploadAttachment will accept, decoded.
   *
   * The client compresses to 1600px at quality 0.75, which lands well under a
   * megabyte, so eight is roughly ten times a normal photo — generous enough
   * that no honest upload meets it, small enough that a request cannot spend
   * the execution's memory before anything has looked at it.
   */
  function getMaxAttachmentMb() {
    return getNumber('maxAttachmentMb', 8);
  }

  function getImageMaxDimPx() {
    return getNumber('imageMaxDimPx', 1600);
  }

  function getImageJpegQuality() {
    return getNumber('imageJpegQuality', 0.75);
  }

  /**
   * The largest final PDF downloadPdf will carry back in one response.
   *
   * The file is read into memory, base64-encoded — a third larger again — and
   * serialised into JSON, all inside one execution. Twenty megabytes is well
   * clear of a typical report (a hundred-odd photos at 1600px) and well under
   * where the platform starts failing in ways that are hard to read from the
   * client.
   */
  function getMaxPdfDownloadMb() {
    return getNumber('maxPdfDownloadMb', 20);
  }

  // --- Accounts and sessions ---

  /**
   * PBKDF2 work factor.
   *
   * The default is deliberately low. Measure on the real deployment with
   * benchmarkPbkdf2() and set this to what it prints.
   *
   * Do not expect a stable number. Successive runs on the same deployment have
   * measured 0.63, 0.82, 0.92 and 1.22 ms per iteration, so the recommendation
   * moves between roughly 2000 and 3000 depending on how busy the platform is
   * that minute. Anywhere in that band is right; chasing the exact figure is
   * not, and neither is treating one run as the truth.
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
   * Six hours, which is also the ceiling CacheService will accept. Under it sits
   * a durable copy in Script Properties, so an evicted cache costs a key-value
   * read rather than opening the workbook — see AuthMirror.
   *
   * It started at sixty seconds, and the short window was guarding against
   * something the code already handles: every path that disables an account,
   * changes a role or revokes a device goes through UserService.update or
   * DeviceService.revoke, and both drop the cached entry on the spot. Revocation
   * through the app is immediate at any TTL.
   *
   * What the window actually bounds is a change made by editing the spreadsheet
   * by hand, which then takes up to this long to be noticed. That is a good
   * reason to disable an account through the screen rather than the sheet, and
   * a poor reason to make every request pay for a sheet read.
   *
   * It is worth paying for: resolving a session is the first thing to touch
   * Sheets in any request, so it was auth that paid to open the workbook —
   * measured at 4.9 s on a request whose own work took 123 ms.
   *
   * This value lives in the Config sheet, and the sheet wins. Raising the
   * default here does nothing to an installation whose row already says 60 —
   * which is what happened, and what checkConfig() now reports.
   *
   * Set to 0 to disable both layers and read through to the sheet every time.
   */
  function getAuthCacheTtlSeconds() {
    return getNumber('authCacheTtlSeconds', 21600);
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
    getMaxAttachmentMb,
    getMaxAttachmentsPerInspection,
    getImageMaxDimPx,
    getImageJpegQuality,
    getMaxPdfDownloadMb,
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
