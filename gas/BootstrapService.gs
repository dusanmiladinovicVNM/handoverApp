/**
 * BootstrapService.gs
 * One-time setup. Run bootstrapSheet() and loadInitialSchemas() manually
 * from the Apps Script editor after configuring Script Properties.
 */

/**
 * Creates all required sheet tabs in the workbook with correct headers.
 * Idempotent: safe to run multiple times.
 */
function bootstrapSheet() {
  const ss = SpreadsheetApp.openById(Config.getWorkbookId());
  const SHEETS = SheetService.COLUMNS;

  for (const sheetName of Object.keys(SHEETS)) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log(`Created sheet: ${sheetName}`);
    }
    const headers = SHEETS[sheetName];
    // Set headers if missing or wrong
    const currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const needsHeaders = currentHeaders.some((h, i) => h !== headers[i]);
    if (needsHeaders) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
      Logger.log(`Set headers on: ${sheetName}`);
    }
  }

  _seedMissingConfigKeys(ss);
  // Keys just written would otherwise be invisible for five minutes.
  Config.invalidateCache();

  Logger.log('Bootstrap complete.');
}

/**
 * Add any config key that is missing, leaving existing values alone.
 *
 * Seeding only into an empty sheet would mean an existing installation never
 * picks up keys added later — it would silently run on code defaults while the
 * sheet that is meant to be the editable source of truth stays incomplete.
 */
/**
 * Every key the code reads from the Config sheet, with the value it falls back
 * to when the sheet does not answer.
 *
 * One table, used both to seed a new installation and to check an existing one.
 * Two tables would drift, and the drift is exactly the fault worth catching:
 * this installation ran for weeks with authCacheTtlSeconds at 60 because the
 * code default was raised to 21600 and the sheet row, written earlier, was
 * never revisited.
 */
function CONFIG_DEFAULTS() {
  return [
    ['defaultTokenTtlHours', '168', 'Tenant link expiry hours (default 7 days)'],
    ['maxAttachmentsPerItem', '5', 'Max photos per item'],
    ['maxAttachmentsPerInspection', '80', 'Max photos per inspection'],
    ['imageMaxDimPx', '1600', 'Frontend should compress to this max dimension'],
    ['imageJpegQuality', '0.75', 'Frontend JPEG compression quality 0-1'],
    ['maxPdfDownloadMb', '20', 'Largest final PDF downloadPdf will return in one response'],
    ['appName', 'Handover', 'Name used in outgoing email'],
    ['pbkdf2Iterations', '1000', 'Password work factor — set from benchmarkPbkdf2()'],
    ['passwordMinLength', '16', 'Minimum password length — long enough to force a phrase'],
    ['sessionTtlHours', '12', 'How long a session token lasts'],
    ['deviceTtlDays', '60', 'How long a remembered device lasts'],
    ['setPasswordTtlHours', '48', 'How long a set-password link stays valid'],
    ['loginMaxFailures', '5', 'Failed sign-ins before an account locks'],
    ['loginLockMinutes', '15', 'How long an account stays locked'],
    ['authCacheTtlSeconds', '21600', 'How long a mirrored user or device row is trusted; revocation through the app is immediate regardless. 0 disables mirroring'],
    ['slowRequestMs', '5000', 'Requests slower than this record their timing in AuditLog; 0 logs all'],
  ];
}

function _seedMissingConfigKeys(ss) {
  const defaults = CONFIG_DEFAULTS();

  const sheet = ss.getSheetByName('Config');
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues()
      .forEach(r => { if (r[0]) existing[String(r[0])] = true; });
  }

  const now = Utils.nowIso();
  const missing = defaults.filter(d => !existing[d[0]]).map(d => [...d, now]);
  if (missing.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 4).setValues(missing);
    Logger.log(`Added ${missing.length} config key(s): ${missing.map(m => m[0]).join(', ')}`);
  } else {
    Logger.log('Config keys already complete.');
  }
}

/**
 * Backfill assignedTo on inspections created before the column existed.
 * Idempotent — run it once after bootstrapSheet().
 *
 * Rows whose createdBy is an old token label rather than an email are left
 * empty on purpose: nobody knows who actually did those, and guessing would
 * hand someone an inspection that was never theirs. They stay admin-only.
 */
function migrateAssignedTo() {
  const ss = SpreadsheetApp.openById(Config.getWorkbookId());
  const sheet = ss.getSheetByName('Inspections');
  const cols = SheetService.COLUMNS.Inspections;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log('No inspections to migrate.');
    return;
  }

  const createdByIdx = cols.indexOf('createdBy');
  const assignedToIdx = cols.indexOf('assignedTo');
  const data = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();

  let filled = 0;
  let skipped = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i][assignedToIdx]) continue;
    const createdBy = String(data[i][createdByIdx] || '');
    if (createdBy.indexOf('@') > 0 && createdBy.indexOf(':') < 0) {
      sheet.getRange(i + 2, assignedToIdx + 1).setValue(createdBy.toLowerCase());
      filled++;
    } else {
      skipped++;
    }
  }
  Logger.log(`assignedTo filled on ${filled} row(s); ${skipped} left empty (no identifiable owner).`);
}

/**
 * Move the answers from one row per question to one row per section.
 *
 * Idempotent, and non-destructive: the Answers sheet is read and left alone,
 * so this can be run again, and the old rows remain to compare against if the
 * result looks wrong. Delete that sheet by hand once you are satisfied.
 *
 * Run once after bootstrapSheet() adds the SectionAnswers tab.
 */
function migrateAnswersToSections() {
  const ss = SpreadsheetApp.openById(Config.getWorkbookId());
  const sheet = ss.getSheetByName('Answers');
  if (!sheet) {
    Logger.log('No Answers sheet — nothing to migrate.');
    return;
  }
  const cols = SheetService.COLUMNS.Answers;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log('Answers sheet is empty — nothing to migrate.');
    return;
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();
  const idx = {};
  cols.forEach((c, i) => { idx[c] = i; });

  // Group into { inspectionId: { sectionId: { itemId: {...} } } }
  const grouped = {};
  rows.forEach(r => {
    const inspectionId = String(r[idx.inspectionId] || '');
    const sectionId = String(r[idx.sectionId] || '');
    const itemId = String(r[idx.itemId] || '');
    if (!inspectionId || !sectionId || !itemId) return;

    if (!grouped[inspectionId]) grouped[inspectionId] = {};
    if (!grouped[inspectionId][sectionId]) grouped[inspectionId][sectionId] = {};
    grouped[inspectionId][sectionId][itemId] = {
      valueType: r[idx.valueType] || '',
      value: r[idx.value] === undefined || r[idx.value] === null ? '' : r[idx.value],
      comment: r[idx.comment] || '',
      attachmentCount: Number(r[idx.attachmentCount] || 0),
      updatedAt: r[idx.updatedAt] || '',
      updatedBy: r[idx.updatedBy] || '',
    };
  });

  let sections = 0;
  let items = 0;
  Object.keys(grouped).forEach(inspectionId => {
    Object.keys(grouped[inspectionId]).forEach(sectionId => {
      const answers = grouped[inspectionId][sectionId];
      // Through the same path a save takes, so the migration cannot produce a
      // shape the app would not have written itself. No revision expected: an
      // existing row is merged into rather than refused.
      SheetService.upsertSectionAnswers(
        inspectionId, sectionId, answers, 'migration', null);
      sections++;
      items += Object.keys(answers).length;
    });
  });

  Logger.log(`Migrated ${items} answer(s) into ${sections} section row(s).`);
  Logger.log('The Answers sheet is untouched. Compare, then delete it by hand.');
}

/**
 * Loads initial schemas from SchemaSeed.gs into the Schemas sheet.
 * Run after bootstrapSheet().
 */
function loadInitialSchemas() {
  const seeds = SchemaSeed.getAllSeeds();
  for (const seed of seeds) {
    SheetService.upsertSchema({
      schemaId: seed.schemaId,
      inspectionType: seed.inspectionType,
      version: seed.version,
      active: true,
      title: seed.title,
      schemaJson: JSON.stringify(seed.schema),
      createdAt: Utils.nowIso(),
      updatedAt: Utils.nowIso(),
    });
    Logger.log(`Loaded schema: ${seed.schemaId}`);
  }
  Logger.log('Schemas loaded.');
}

/**
 * Read the Config sheet and say what is wrong with it.
 *
 * Report only — nothing is written. A value that differs from the default is
 * usually deliberate, and silently "correcting" a deployment's tuning would be
 * worse than the faults this looks for.
 *
 * It looks for three things, all of which this installation had at once and
 * none of which was visible from the app:
 *
 *   missing     the key is not in the sheet, so the code default applies. New
 *               keys arrive this way; bootstrapSheet() adds them.
 *   unusable    there is a value and it is not a number, so the default applies
 *               anyway — a setting that looks configured but is not.
 *   stale       the value is a number but predates a change to the default. Not
 *               an error, and the reason it is listed rather than fixed.
 */
/**
 * Make a Config edit take effect now rather than within five minutes.
 *
 * The sheet is read through a short-lived cache so that resolving a session
 * does not have to open the workbook — see Config. This drops it.
 */
function reloadConfig() {
  Config.invalidateCache();
  Logger.log('Config cache cleared. The next request reads the sheet.');
  checkConfig();
}

function checkConfig() {
  const defaults = CONFIG_DEFAULTS();
  // Straight from the sheet, never the cache: the point of this function is to
  // report what is actually written down.
  Config.invalidateCache();
  const rows = SheetService.getConfigRows();

  const inSheet = {};
  rows.forEach(r => { if (r.key) inSheet[String(r.key)] = String(r.value); });

  const missing = [];
  const unusable = [];
  const differing = [];

  defaults.forEach(function (entry) {
    const key = entry[0];
    const fallback = entry[1];

    if (!(key in inSheet) || inSheet[key] === '') {
      missing.push(`${key}  (code default: ${fallback})`);
      return;
    }

    const value = inSheet[key];
    const numericDefault = !isNaN(Number(fallback));
    if (numericDefault && isNaN(Number(value))) {
      unusable.push(`${key} = "${value}"  → falling back to ${fallback}`);
      return;
    }
    if (value !== fallback) {
      differing.push(`${key} = ${value}  (code default: ${fallback})`);
    }
  });

  const known = {};
  defaults.forEach(d => { known[d[0]] = true; });
  const unread = Object.keys(inSheet).filter(k => !known[k]);

  Logger.log('=== Config sheet ===');
  _logConfigGroup('Missing — the code default applies. Run bootstrapSheet() to add them.', missing);
  _logConfigGroup('Unusable — a value is set but cannot be read. Fix these.', unusable);
  _logConfigGroup('Read by nothing — a typo, or a key the code stopped using.', unread);
  _logConfigGroup('Differing from the default — check each is still what you meant.', differing);

  if (!missing.length && !unusable.length && !unread.length) {
    Logger.log('Nothing wrong. Values differing from the defaults are listed above, if any.');
  }
  return { missing: missing, unusable: unusable, unread: unread, differing: differing };
}

function _logConfigGroup(title, items) {
  if (!items.length) return;
  Logger.log('');
  Logger.log(title);
  items.forEach(i => Logger.log(`  · ${i}`));
}

/**
 * Forget the cached schema JSON. upsertSchema already does this, so the only
 * reason to run it by hand is an edit typed straight into the Schemas sheet.
 */
function clearSchemaCache() {
  const ids = SheetService.getActiveSchemas().map(s => s.schemaId);
  SchemaService.invalidate(ids);
  Logger.log(`Schema cache cleared for: ${ids.join(', ') || '(none)'}`);
}

/**
 * Generate the TOKEN_SECRET. Run once during setup, copy output into
 * Script Properties as TOKEN_SECRET.
 */
function generateSecret() {
  const secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  Logger.log('Generated TOKEN_SECRET:');
  Logger.log(secret);
  Logger.log('Copy the above into Script Properties → TOKEN_SECRET.');
}

/**
 * Verify that every service made it into the project intact.
 *
 * Run this after copying files by hand. Files are moved one at a time, and a
 * paste into the wrong one both duplicates its content and silently destroys
 * whatever it landed on. A duplicate is loud — the project stops loading — but
 * the destroyed half is quiet: everything runs until the missing service is
 * finally called, which may be days later and in front of a customer.
 *
 * File *names* are irrelevant to Apps Script; only the declarations matter. So
 * this checks the declarations, not the file list.
 *
 * The identifiers are referenced through arrow functions on purpose: a top
 * level `const` is lexical and never becomes a property of the global object,
 * so it cannot be looked up by name — but referencing it directly throws
 * ReferenceError when it is missing, which is exactly the signal wanted.
 */
function verifyDeployment() {
  const SERVICES = [
    ['Utils', () => Utils, ['nowIso', 'secureRandomHex', 'secureRandomBytes',
      'safeEqual', 'safeEqualBytes', 'toByteArray', 'generateUserId',
      'generateDeviceId', 'generateInspectionId', 'hmacSha256', 'sha256']],
    ['Config', () => Config, ['getWorkbookId', 'getTokenSecret', 'getFrontendUrl',
      'getPbkdf2Iterations', 'getPasswordMinLength', 'getSessionTtlHours',
      'getDeviceTtlDays', 'getSetPasswordTtlHours', 'getLoginMaxFailures',
      'getAuthCacheTtlSeconds']],
    ['SheetService', () => SheetService, ['createUser', 'getUser', 'getUserByEmail',
      'updateUser', 'listUsers', 'createDevice', 'getDevice', 'updateDevice',
      'getDevicesForUser', 'listDevices', 'revokeDevicesForUser',
      'getAuthAuditEvents', 'getInspection', 'updateInspection',
      'getConfigRows', 'highestIdSuffix']],
    ['PasswordService', () => PasswordService, ['hashPassword', 'verifyPassword',
      'hasPassword', 'validatePolicy', 'getStats']],
    ['UserService', () => UserService, ['getById', 'getByEmail', 'listAll', 'listAssignable',
      'countActiveAdmins', 'create', 'update', 'isLocked', 'registerFailedLogin',
      'normalizeEmail', 'toPublic']],
    ['DeviceService', () => DeviceService, ['register', 'getById', 'checkUsable',
      'touch', 'revoke', 'revokeAllForUser', 'listForUser']],
    ['MailService', () => MailService, ['sendSetPasswordLink']],
    ['AuthService', () => AuthService, ['generateSessionToken', 'generateDeviceToken',
      'generateSetPasswordToken', 'generateTenantToken', 'verifyToken',
      'verifySetPasswordToken', 'verifyDeviceToken', 'resolveAuth',
      'contextForUser',
      'requireAdmin', 'requireStaff', 'requireMatchingInspection',
      'requireInspectionAccess', 'visibleInspections']],
    ['AccountService', () => AccountService, ['login', 'setPassword',
      'changePassword', 'requestPasswordReset', 'refreshSession', 'me', 'signOut']],
    ['UserAdminService', () => UserAdminService, ['listUsers', 'createUser',
      'setUserStatus', 'setUserRole', 'unlockUser', 'sendPasswordLink',
      'listUserDevices', 'revokeDevice', 'revokeAllDevices', 'getAuthLog',
      'assignInspection']],
    ['AuthMirror', () => AuthMirror, ['get', 'put', 'remove']],
    ['AuditService', () => AuditService, ['log', 'logAuth', 'getEventsForInspection']],
    ['InspectionService', () => InspectionService, ['createInspection', 'getInspection',
      'saveSection', 'lockInspection', 'unlockInspection', 'listInspections']],
    ['AttachmentService', () => AttachmentService, ['uploadAttachment', 'deleteAttachment']],
    ['SignatureService', () => SignatureService, ['saveSignature']],
    ['PdfService', () => PdfService, ['finalizeInspection', 'downloadPdf']],
    ['DriveService', () => DriveService, ['createInspectionFolders', 'getThumbnailUrl',
      'getInspectionFolder', 'getSubfolder', 'getStats']],
    ['SchemaService', () => SchemaService, ['listActiveSchemas', 'getSchemaJson',
      'invalidate']],
    ['SchemaSeed', () => SchemaSeed, ['getAllSeeds']],
    ['ValidationService', () => ValidationService, []],
    ['ResponseService', () => ResponseService, ['success', 'error', 'fromException']],
    ['Router', () => Router, ['dispatch', 'listActions']],
  ];

  const problems = [];
  let checked = 0;

  SERVICES.forEach(function (entry) {
    const name = entry[0];
    let service;
    try {
      service = entry[1]();
    } catch (e) {
      problems.push(`✗ ${name} is missing entirely — its file was lost or overwritten`);
      return;
    }
    if (!service) {
      problems.push(`✗ ${name} is declared but empty`);
      return;
    }
    const missing = entry[2].filter(fn => typeof service[fn] !== 'function');
    if (missing.length) {
      problems.push(`✗ ${name} is incomplete — missing: ${missing.join(', ')}`);
    } else {
      checked++;
    }
  });

  // The routing table is the other place a partial copy shows up: a stale
  // Router.gs loads perfectly well and simply has no idea the new actions exist.
  const EXPECTED_ACTIONS = [
    'login', 'requestPasswordReset', 'setPassword', 'refreshSession',
    'changePassword', 'me', 'signOut',
    'listUsers', 'createUser', 'setUserStatus', 'setUserRole', 'unlockUser',
    'sendPasswordLink', 'listUserDevices', 'revokeDevice', 'revokeAllDevices',
    'getAuthLog', 'assignInspection',
    'getSchemas', 'getSchema', 'getNewInspectionOptions',
    'createInspection', 'getInspection', 'saveSection',
    'lockInspection', 'unlockInspection', 'regenerateTenantToken', 'listInspections',
    'uploadAttachment', 'deleteAttachment', 'saveSignature', 'finalizeInspection',
    'downloadPdf', 'getAuditLog',
  ];
  try {
    const actions = Router.listActions();
    const missingRoutes = EXPECTED_ACTIONS.filter(a => actions.indexOf(a) < 0);
    if (missingRoutes.length) {
      problems.push(`✗ Router is out of date — missing routes: ${missingRoutes.join(', ')}`);
    }
  } catch (e) {
    problems.push(`✗ Router could not be read: ${e.message}`);
  }

  try {
    const publicActions = PUBLIC_ACTIONS;
    const expectedPublic = ['login', 'requestPasswordReset', 'setPassword', 'refreshSession'];
    const unexpected = publicActions.filter(a => expectedPublic.indexOf(a) < 0);
    if (unexpected.length) {
      problems.push(`✗ these actions run without authentication and should not: ${unexpected.join(', ')}`);
    }
    expectedPublic.forEach(a => {
      if (publicActions.indexOf(a) < 0) {
        problems.push(`✗ PUBLIC_ACTIONS is missing '${a}' — signing in will be refused`);
      }
    });
  } catch (e) {
    problems.push('✗ PUBLIC_ACTIONS is missing — Code.gs did not make it across');
  }

  if (problems.length === 0) {
    Logger.log(`✓ All ${checked} services present and complete.`);
    Logger.log('✓ Routing table and public action list match this version.');
    Logger.log('');
    Logger.log('Now run smokeTest() to check the configuration and the workbook.');
  } else {
    Logger.log(`${problems.length} problem(s) found:`);
    Logger.log('');
    problems.forEach(p => Logger.log('  ' + p));
    Logger.log('');
    Logger.log('Re-copy the named files from gas/ in the repository. A file whose');
    Logger.log('content went missing was almost certainly overwritten by a paste');
    Logger.log('meant for it — check its neighbours too.');
  }
}

/**
 * Quick smoke test. Run after full setup to verify all components.
 * Logs PASS/FAIL for each check.
 */
function smokeTest() {
  const checks = [];
  const startedAt = Date.now();

  // Each check is timed, because the total on its own says nothing about where
  // the time went. This run touches Drive, Sheets and the password derivation,
  // and those differ by orders of magnitude — without the split, a slow run
  // invites guessing, and guessing about performance has been wrong every time
  // it has been tried on this project.
  function check(name, fn) {
    const at = Date.now();
    let outcome;
    try {
      fn();
      outcome = `✓ ${name}`;
    } catch (e) {
      outcome = `✗ ${name}: ${e.message}`;
    }
    const ms = Date.now() - at;
    // Only worth the noise once a check is slow enough to matter.
    checks.push(ms >= 250 ? `${outcome}   [${(ms / 1000).toFixed(1)}s]` : outcome);
  }

  check('Config: WORKBOOK_ID', () => Config.getWorkbookId());
  check('Config: TOKEN_SECRET', () => Config.getTokenSecret());
  check('Config: FRONTEND_URL', () => Config.getFrontendUrl());
  check('Config: TEMPLATE_DOC_ID resolves', () => DriveApp.getFileById(Config.getTemplateDocId()).getName());
  check('Config: INSPECTIONS_ROOT_FOLDER_ID resolves', () => DriveApp.getFolderById(Config.getInspectionsRootFolderId()).getName());
  check('Sheet tabs exist', () => {
    const ss = SpreadsheetApp.openById(Config.getWorkbookId());
    for (const name of Object.keys(SheetService.COLUMNS)) {
      if (!ss.getSheetByName(name)) throw new Error(`missing sheet: ${name}`);
    }
  });
  check('Schemas loaded', () => {
    if (SheetService.getActiveSchemas().length === 0) throw new Error('no schemas');
  });
  // Missing keys and stale values are not failures — the code default applies
  // and the app runs. A value that is set but cannot be read is a failure: it
  // looks configured and is not, which is how passwordMinLength sat holding the
  // word "passwordMinLength" without anyone noticing.
  check('Config sheet usable', () => {
    const report = checkConfig();
    if (report.unusable.length) {
      throw new Error(`${report.unusable.length} unusable value(s) — run checkConfig()`);
    }
  });
  check('Tenant token roundtrip', () => {
    const nonce = Utils.generateNonce();
    const token = AuthService.generateTenantToken('TEST-INS', 1, nonce);
    if (!token.includes('.')) throw new Error('malformed');
  });
  check('Users sheet reachable', () => SheetService.listUsers());
  check('At least one active admin', () => {
    if (UserService.countActiveAdmins() === 0) {
      throw new Error('none — run bootstrapFirstAdmin("email", "name")');
    }
  });
  check('Password hash roundtrip', () => {
    const stored = PasswordService.hashPassword('correct horse battery staple');
    if (!PasswordService.verifyPassword('correct horse battery staple', stored).ok) {
      throw new Error('correct password rejected');
    }
    if (PasswordService.verifyPassword('wrong horse battery staple', stored).ok) {
      throw new Error('wrong password accepted');
    }
  });
  check('Password policy rejects short input', () => {
    try {
      PasswordService.validatePolicy('short');
      throw new Error('an 5-character password was accepted');
    } catch (e) {
      if (!(e instanceof HandoverError)) throw e;
    }
  });
  check('assignedTo column present', () => {
    if (SheetService.COLUMNS.Inspections.indexOf('assignedTo') < 0) {
      throw new Error('missing — re-run bootstrapSheet()');
    }
  });

  // Sequential IDs come from Script Properties, not from the sheets, so that a
  // deleted row can never have its ID handed to someone else — userId is
  // referenced from Devices, from AuditLog details, and from createdBy and
  // assignedTo on Inspections, and reuse would silently transfer one person's
  // history to another.
  //
  // The cost of keeping them apart is that they can drift. Clearing the
  // property while rows remain is the dangerous direction: the next ID issued
  // is one that already exists, and nothing complains at the time.
  check('ID counters are ahead of the rows they number', () => {
    const props = PropertiesService.getScriptProperties();
    const year = Utils.currentYear();
    const behind = [];

    [['userCounter', 'Users', 'userId'],
     ['deviceCounter', 'Devices', 'deviceId'],
     ['inspectionCounter', 'Inspections', 'inspectionId']].forEach(function (entry) {
      const counter = parseInt(props.getProperty(`${entry[0]}_${year}`) || '0', 10);
      const highest = SheetService.highestIdSuffix(entry[1], entry[2], year);
      if (highest > counter) {
        behind.push(`${entry[0]}_${year} is ${counter} but ${entry[1]} already reaches ${highest}`);
      }
    });

    if (behind.length) {
      throw new Error(behind.join('; ') + ' — the next ID issued would be a duplicate');
    }
  });

  Logger.log(checks.join('\n'));
  Logger.log('');
  Logger.log(`Total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  Logger.log('Timings are shown for checks over 250 ms. Three things here are');
  Logger.log('slow by nature and say nothing about the app: Drive lookups, the');
  Logger.log(`password roundtrip (three derivations at ${Config.getPbkdf2Iterations()} iterations,`);
  Logger.log('by design), and the first read of each sheet.');

  // Printed rather than asserted: no check here can tell a working address from
  // a plausible one, and this single value builds both the tenant links and the
  // set-password links. A wrong case in it fails silently, at the far end.
  Logger.log('');
  try {
    Logger.log(`FRONTEND_URL: ${Config.getFrontendUrl()}`);
    Logger.log('Open it. If it 404s, every link this backend sends out is dead.');
  } catch (e) {
    Logger.log(`FRONTEND_URL: not configured — ${e.message}`);
  }
}


/**
 * Delete the leftover ADMIN_NONCES property.
 *
 * Nothing reads it any more — tokens of the old shape are refused by
 * resolveAuth whatever the list says, so this is tidying rather than a fix.
 * Run it once after this version is deployed and everyone signs in with an
 * account.
 *
 * Worth stating plainly, because it is easy to assume otherwise: deleting the
 * property does not un-publish the admin token that was committed to this
 * public repository. What makes that token useless is the code that no longer
 * accepts its shape. The property is just the last trace of the mechanism.
 */
function removeLegacyAdminTokens() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('ADMIN_NONCES');
  if (!raw) {
    Logger.log('ADMIN_NONCES is already gone. Nothing to do.');
    return;
  }
  let count = 0;
  try {
    const parsed = JSON.parse(raw);
    count = Array.isArray(parsed) ? parsed.length : 0;
  } catch (e) {
    count = 0;
  }
  props.deleteProperty('ADMIN_NONCES');
  Logger.log(`Removed ADMIN_NONCES (${count} entr${count === 1 ? 'y' : 'ies'}).`);
  Logger.log('Tokens of that shape were already being refused by resolveAuth.');
}

/**
 * Diagnostic: simulate what the frontend sends for saveSection.
 *
 * Pass the credentials as arguments — never paste a live token into a source
 * file. An earlier version of this function carried a working admin token in
 * the repository, which is a public one; anything committed here is published,
 * and deleting it later does not un-publish it because the git history keeps
 * every version.
 *
 *   debugSaveSection('INS-2026-000001', '<session token>')
 */
function debugSaveSection(inspectionId, sessionToken) {
  if (!inspectionId || !sessionToken) {
    Logger.log('Usage: debugSaveSection("INS-YYYY-NNNNNN", "<session token>")');
    return;
  }

  const fakeRequest = {
    postData: {
      contents: JSON.stringify({
        action: 'saveSection',
        auth: { type: 'token', token: sessionToken },
        data: {
          inspectionId: inspectionId,
          sectionId: 'general',
          items: {
            general_inspector_name: { value: 'Test Name', comment: '' }
          }
        }
      })
    }
  };

  const response = doPost(fakeRequest);
  Logger.log('Response:');
  Logger.log(response.getContent());
}

// ============================================================
// Accounts
// ============================================================

/**
 * ⇩⇩⇩  EDIT THE TWO LINES BELOW, THEN RUN THIS FUNCTION  ⇩⇩⇩
 *
 * The editor's Run button cannot pass arguments — it only runs functions that
 * take none. So the values live here instead.
 *
 * Select "setupFirstAdmin" in the function dropdown at the top of the editor,
 * press Run, and watch the log (Ctrl+Enter). A link to set your password
 * arrives by email; it is also printed in the log in case the mail is slow or
 * lands in spam.
 *
 * Safe to run more than once: an existing account with that address is
 * promoted and re-enabled rather than duplicated.
 */
function setupFirstAdmin() {
  const EMAIL = 'promeni.me@primer.rs';   // ← your email address
  const NAME  = 'Ime Prezime';            // ← your name

  if (EMAIL === 'promeni.me@primer.rs') {
    Logger.log('Edit EMAIL and NAME at the top of setupFirstAdmin() first.');
    return;
  }
  bootstrapFirstAdmin(EMAIL, NAME);
}

/**
 * ⇩⇩⇩  SET A PASSWORD WITHOUT A BROWSER  ⇩⇩⇩
 *
 * The set-password screen is frontend work and does not exist yet, so the
 * mailed link has nowhere to land until it does. This does the same job from
 * the editor: edit the two lines, select "setMyPassword" in the dropdown, Run.
 *
 * It goes through AccountService.setPassword rather than writing a hash
 * directly, so the policy check, the device revocation and the audit entry all
 * happen exactly as they will for a real user. Nothing here is a shortcut
 * around the rules.
 *
 * Afterwards, clear PASSWORD below and save. A password typed into a source
 * file stays in the editor's revision history otherwise.
 */
function setMyPassword() {
  const EMAIL    = 'promeni.me@primer.rs';   // ← your email address
  const PASSWORD = '';                       // ← at least 16 characters, then clear this

  if (EMAIL === 'promeni.me@primer.rs' || !PASSWORD) {
    Logger.log('Edit EMAIL and PASSWORD at the top of setMyPassword() first.');
    Logger.log(`Minimum length is ${Config.getPasswordMinLength()} characters —`);
    Logger.log('a phrase of four unrelated words is the shape to aim for.');
    return;
  }

  const user = UserService.getByEmail(EMAIL);
  if (!user) {
    Logger.log(`No account for ${EMAIL}. Run setupFirstAdmin() first.`);
    return;
  }

  try {
    AccountService.setPassword(null, {
      token: AuthService.generateSetPasswordToken(user),
      password: PASSWORD,
      deviceLabel: 'Apps Script editor',
    });
  } catch (e) {
    Logger.log(`Rejected: ${e.message}`);
    return;
  }

  Logger.log(`Password set for ${EMAIL}. Now clear the PASSWORD line above and save.`);
  Logger.log('Any device that was signed in has been signed out, as it would be');
  Logger.log('for any password change.');
}

/**
 * Create the very first administrator, or repair access when nobody can get in.
 *
 * Takes arguments, so it is callable from other code and from the editor's
 * console. From the Run button, use setupFirstAdmin() above instead.
 *
 * This stays in the editor permanently, not just for initial setup. Everything
 * else about accounts moves into the app, which leaves one gap: if the last
 * administrator loses both their password and their mailbox, there is no path
 * back in through the UI. This is that path. It is deliberate, and it is the
 * reason the editor must stay restricted to people who could rewrite the
 * backend anyway.
 *
 *   bootstrapFirstAdmin('ime.prezime@firma.rs', 'Ime Prezime')
 *
 * An existing account with that address is promoted and re-enabled rather than
 * duplicated, and is sent a fresh set-password link.
 */
function bootstrapFirstAdmin(email, name) {
  if (!email || !name) {
    Logger.log('Usage: bootstrapFirstAdmin("email@firma.rs", "Ime Prezime")');
    return;
  }

  const normalized = UserService.normalizeEmail(email);
  let user = UserService.getByEmail(normalized);

  if (user) {
    user = UserService.update(user.userId, {
      role: 'admin',
      status: 'active',
      failedCount: 0,
      lockedUntil: '',
      disabledAt: '',
      disabledBy: '',
    });
    Logger.log(`Existing account ${normalized} promoted to admin and re-enabled.`);
  } else {
    user = UserService.create({
      email: normalized,
      name: name,
      role: 'admin',
      createdBy: 'bootstrap',
    });
    Logger.log(`Admin account created: ${user.userId} (${normalized})`);
  }

  const token = AuthService.generateSetPasswordToken(user);
  AuditService.logAuth('bootstrap', 'user_created', { userId: user.userId, role: 'admin' });

  // Printed before the mail is attempted, and deliberately so. This function is
  // the way back in when nothing else works, and mail is the part of it most
  // likely to fail — a missing scope, a spent quota, a message in spam. Sending
  // first would mean a failure leaves an account created and its only link
  // discarded, which is the exact situation this function exists to prevent.
  Logger.log('=========================================');
  Logger.log('SET-PASSWORD LINK');
  Logger.log(`Valid for ${Config.getSetPasswordTtlHours()} hours, single use.`);
  Logger.log('-----------------------------------------');
  Logger.log(`${Config.getFrontendUrl()}#/set-password?k=${token}`);
  Logger.log('-----------------------------------------');
  Logger.log('NOTE: the screen this link opens is frontend work and does not');
  Logger.log('exist yet. Until it does, set the password from the editor with');
  Logger.log('setMyPassword(). Keep the link only if the screen is already live.');
  Logger.log('');
  Logger.log(`Frontend URL in use: ${Config.getFrontendUrl()}`);
  Logger.log('Check that against the address that actually serves the app —');
  Logger.log('GitHub Pages project paths are case-sensitive, and the same');
  Logger.log('setting also builds the links sent to tenants.');
  Logger.log('-----------------------------------------');

  try {
    MailService.sendSetPasswordLink(user, token, PasswordService.hasPassword(user));
    Logger.log(`Also emailed to ${normalized}.`);
  } catch (e) {
    Logger.log(`Email could not be sent: ${e.message}`);
    Logger.log('Use the link above — the account is created and the link works.');
  }
  Logger.log('=========================================');
}

/**
 * Measure PBKDF2 cost on this deployment and recommend an iteration count.
 *
 * The right number cannot be decided in advance: each iteration crosses the
 * JavaScript/native boundary, and that cost differs enough between deployments
 * that a figure copied from documentation would be meaningless. Run this, then
 * put the chosen value into the Config sheet under pbkdf2Iterations.
 *
 * Raising it later is safe — the iteration count is stored with every hash and
 * existing rows upgrade themselves on the owner's next sign-in.
 *
 * It measures twice, because there are two costs and they are far apart.
 *
 * The first version of this measured a cold runtime and was wrong by a factor
 * of four the cheap way: 2.5 ms per iteration against a real warm cost nearer
 * 0.6, so the recommendation came out four times too low, which is four times
 * less work for anyone attacking a stolen hash. The fix was to warm up first.
 *
 * That fix was right and it introduced the opposite silence. A live sign-in was
 * later measured at 20.2 s, of which 15.4 s was PBKDF2 — six times the budget
 * this function was sizing to, because the script was cold. The warm figure is
 * what an attacker's throughput resembles; the cold figure is what a person
 * waits on the first sign-in of the morning, when nobody has touched the script
 * for hours. Neither one alone is the answer, so both are printed and the trade
 * is stated rather than decided here.
 */
function benchmarkPbkdf2() {
  const password = 'benchmark-passphrase-of-realistic-length';
  const salt = Utils.secureRandomBytes(16);

  // A sign-in happens once per session — twelve hours, or sixty days on a
  // remembered device, where refreshSession derives nothing at all. Several
  // seconds is not a cost anyone meets often, and every millisecond spent is
  // one the work factor gets.
  const budgetMs = 2500;
  const SAMPLE = 500;

  // Timed before anything else runs, so this really is the first derivation of
  // the execution. Everything below warms the runtime and cannot be repeated.
  const coldStarted = Date.now();
  PasswordService._pbkdf2Sha256(password, salt, SAMPLE);
  const coldPerIteration = (Date.now() - coldStarted) / SAMPLE;

  Logger.log('Measuring PBKDF2-HMAC-SHA256 …');
  Logger.log(`  cold: ${SAMPLE} iterations → ${coldPerIteration.toFixed(4)} ms each`);

  let warmPerIteration = 0;
  [200, 500, 1000].forEach(function (iterations) {
    const started = Date.now();
    PasswordService._pbkdf2Sha256(password, salt, iterations);
    const elapsed = Date.now() - started;
    const perIteration = elapsed / iterations;
    Logger.log(`  warm: ${iterations} iterations → ${elapsed} ms (${perIteration.toFixed(4)} ms each)`);
    if (perIteration > warmPerIteration) warmPerIteration = perIteration;
  });

  const fits = (perIteration) => perIteration > 0
    ? Math.max(100, Math.floor(budgetMs / perIteration / 100) * 100)
    : 0;
  const warmFit = fits(warmPerIteration);
  const coldFit = fits(coldPerIteration);
  const current = Config.getPbkdf2Iterations();

  Logger.log('');
  Logger.log(`Currently set: ${current}`);
  Logger.log(`  warm, that is about ${Math.round(current * warmPerIteration)} ms`);
  Logger.log(`  cold, about ${Math.round(current * coldPerIteration)} ms — `
    + `${(coldPerIteration / Math.max(warmPerIteration, 0.0001)).toFixed(1)}x`);
  Logger.log('');
  Logger.log(`Fits the ${(budgetMs / 1000).toFixed(1)} s budget:`);
  Logger.log(`  ${warmFit} if the script is warm`);
  Logger.log(`  ${coldFit} if it is cold`);
  Logger.log('');
  Logger.log('Pick between them knowingly; this deliberately does not pick for you.');
  Logger.log('');
  Logger.log('The cold figure is what a person waits on the first sign-in of the');
  Logger.log('morning, when nobody has touched the script for hours. The warm one is');
  Logger.log('nearer what an attacker grinding a stolen hash would see — and they');
  Logger.log('are running native code, so each iteration buys them far less than');
  Logger.log('these milliseconds suggest. A few thousand iterations here is nowhere');
  Logger.log('near what bcrypt or Argon2 would give on an ordinary server.');
  Logger.log('');
  Logger.log('Which is why lowering this is not free, and why it is not the first');
  Logger.log('thing to reach for. A remembered device signs in through');
  Logger.log('refreshSession, which verifies a token and derives nothing — so the');
  Logger.log('cold cost is paid once every sixty days, not every morning. Account');
  Logger.log('lockout is the other half of the defence, and it is doing more work');
  Logger.log('here than the work factor is.');
  Logger.log('');
  Logger.log('Put the number you chose in the Config sheet under: pbkdf2Iterations');
}


/**
 * Why an account cannot sign in.
 *
 * The sign-in response says the same thing for a wrong password, an unknown
 * address, an account with no password set, a disabled one and a locked one.
 * That is deliberate: any difference turns the form into a way of finding out
 * who works here. It also means that when sign-in stops working there is
 * nothing to go on, and the person locked out is usually the one person who
 * could have looked.
 *
 * This is where to look instead. It reads the account and the last few
 * sign-in events and says which of the five it is, in plain words.
 *
 * Asks for no password, so it is safe to run and safe to paste the output of.
 * Nothing here is a secret: whether an account exists and whether it is locked
 * is hidden from the sign-in form, not from someone who already has the editor
 * open — and anyone with the editor open could rewrite the backend anyway.
 *
 * Reads through UserService.getByEmail, which is the same path sign-in takes,
 * mirror and all. If a stale mirrored row were ever the cause, it would show
 * up here rather than be read around.
 */
function whyCantISignIn(email) {
  const address = UserService.normalizeEmail(
    email || 'promeni.me@primer.rs');

  if (address === 'promeni.me@primer.rs') {
    Logger.log('Pass the address to check: whyCantISignIn("ime@firma.rs")');
    return;
  }

  const user = UserService.getByEmail(address);
  if (!user) {
    Logger.log(`No account for ${address}.`);
    Logger.log('Either the address is misspelt, or the account was never created.');
    Logger.log('bootstrapFirstAdmin(email, name) creates one.');
    return;
  }

  Logger.log(`Account: ${user.name} <${user.email}>`);
  Logger.log(`  role        ${user.role}`);
  Logger.log(`  status      ${user.status}`);
  Logger.log(`  password    ${PasswordService.hasPassword(user) ? 'set' : 'NOT SET'}`
    + (user.passSetAt ? ` (${user.passSetAt})` : ''));
  Logger.log(`  failures    ${Number(user.failedCount || 0)}`);
  Logger.log(`  lockedUntil ${user.lockedUntil || '—'}`);
  Logger.log(`  lastLogin   ${user.lastLoginAt || 'never'}`);

  // Said outright rather than left to be worked out from the fields above.
  const verdict = [];
  if (user.status !== 'active') {
    verdict.push(`Access is disabled. Re-enable it in the app, or set status to `
      + `'active' in the Users sheet.`);
  }
  if (!PasswordService.hasPassword(user)) {
    verdict.push('No password has ever been set. Run setMyPassword(), or send a '
      + 'set-password link from the app.');
  }
  if (UserService.isLocked(user)) {
    verdict.push(`Locked after too many failed attempts, until ${user.lockedUntil}. `
      + 'setMyPassword() clears the lock as well as setting the password.');
  }
  if (verdict.length === 0) {
    verdict.push('Nothing is wrong with the account itself, so sign-in is being '
      + 'refused because the password does not match. Run setMyPassword() and use '
      + 'exactly what you set — copy it, do not retype it.');
  }
  Logger.log('');
  verdict.forEach(line => Logger.log(line));

  // The last few attempts, because the reason for each is recorded even though
  // it is never sent to the browser.
  const recent = SheetService.getAuthAuditEvents()
    .filter(e => String(e.actor || '').toLowerCase().indexOf(address) >= 0)
    .slice(-8);

  if (recent.length) {
    Logger.log('');
    Logger.log('Recent sign-in events, oldest first:');
    recent.forEach(e => {
      let reason = '';
      try {
        const details = JSON.parse(e.detailsJson || '{}');
        reason = details.reason ? ` (${details.reason})` : '';
      } catch (parseError) {
        reason = ' (details unreadable)';
      }
      Logger.log(`  ${e.timestamp}  ${e.eventType}${reason}`);
    });
  }
}

/**
 * Compare the two ways of reading the sheets an inspection needs.
 *
 * getInspection is the only call left that someone waits on in the app. Its
 * server time is roughly a workbook open plus four reads, and the open is the
 * larger half — SpreadsheetApp.openById runs afresh in every execution, and
 * there is no cache that survives one.
 *
 * The Sheets advanced service does not open anything, and batchGet fetches
 * every range in a single request. Whether that is actually faster on this
 * deployment, with this much data, is a question about numbers, and the
 * numbers in this project have contradicted the reasoning four times.
 *
 * So: run this, read the two lines, and decide. Nothing else calls Sheets yet;
 * enabling the service costs nothing until something does.
 *
 * The open is sampled once and only once. Asking for the same spreadsheet
 * twice in one execution is served from the platform's own cache, so a second
 * sample would measure that cache and not the thing a real request pays.
 */
function benchmarkSheetReads() {
  if (typeof Sheets === 'undefined') {
    Logger.log('The Sheets advanced service is not enabled for this project.');
    Logger.log('');
    Logger.log('Editor → Services → + → Google Sheets API → Add.');
    Logger.log('It is already declared in appsscript.json, so a clasp push may');
    Logger.log('be all that is needed; the editor is the fallback.');
    return;
  }

  const workbookId = Config.getWorkbookId();
  // The four getInspection reads, in the order it makes them.
  const SHEETS = ['Inspections', 'SectionAnswers', 'Attachments', 'Signatures'];
  const ROUNDS = 5;

  const ranges = SHEETS.map(function (name) {
    const width = SheetService.COLUMNS[name].length;
    return `${name}!A2:${_columnLetter(width)}`;
  });

  // Warm up before timing anything. Measuring a cold runtime and reporting it
  // as the steady cost is a mistake this project has already made once, in
  // benchmarkPbkdf2, and it was wrong by a factor of four.
  try {
    Sheets.Spreadsheets.Values.batchGet(workbookId, { ranges: ranges });
  } catch (e) {
    Logger.log(`batchGet failed: ${e.message}`);
    Logger.log('If this says the caller does not have permission, re-authorise:');
    Logger.log('run any function from the editor and accept the prompt.');
    return;
  }

  Logger.log(`Reading ${SHEETS.join(', ')} — ${ROUNDS} rounds each.`);
  Logger.log('');

  // --- The current path ---
  const openStarted = Date.now();
  const ss = SpreadsheetApp.openById(workbookId);
  const openMs = Date.now() - openStarted;

  const currentSamples = [];
  let rowsSeen = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const started = Date.now();
    let rows = 0;
    SHEETS.forEach(function (name) {
      const sheet = ss.getSheetByName(name);
      const lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        rows += sheet.getRange(
          2, 1, lastRow - 1, SheetService.COLUMNS[name].length).getValues().length;
      }
    });
    currentSamples.push(Date.now() - started);
    rowsSeen = rows;
  }

  // --- batchGet ---
  const batchSamples = [];
  let batchRows = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const started = Date.now();
    const result = Sheets.Spreadsheets.Values.batchGet(workbookId, { ranges: ranges });
    batchSamples.push(Date.now() - started);
    batchRows = (result.valueRanges || []).reduce(
      function (n, r) { return n + ((r.values || []).length); }, 0);
  }

  const report = function (label, samples) {
    const sorted = samples.slice().sort(function (a, b) { return a - b; });
    Logger.log(`  ${label}`);
    Logger.log(`    min ${sorted[0]}  median ${sorted[Math.floor(sorted.length / 2)]}`
      + `  max ${sorted[sorted.length - 1]}  — ${samples.join(', ')}`);
  };

  Logger.log(`  workbook open (one sample only): ${openMs} ms`);
  Logger.log('');
  report('SpreadsheetApp, four reads', currentSamples);
  report('Sheets batchGet, one request', batchSamples);
  Logger.log('');

  const median = function (a) {
    const s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.floor(s.length / 2)];
  };
  const currentTotal = openMs + median(currentSamples);
  const batchTotal = median(batchSamples);

  Logger.log(`Per request, on the medians:`);
  Logger.log(`  now:      ${currentTotal} ms  (${openMs} open + ${median(currentSamples)} reading)`);
  Logger.log(`  batchGet: ${batchTotal} ms`);
  Logger.log(`  difference: ${currentTotal - batchTotal} ms`);
  Logger.log('');
  Logger.log(`Rows read: ${rowsSeen} the current way, ${batchRows} through batchGet.`);
  Logger.log('They should match. If they do not, the two are not reading the same');
  Logger.log('thing and the timings above are not comparable.');
  Logger.log('');
  Logger.log('Read the difference against what it would buy. Opening an inspection');
  Logger.log('was measured at 4 337 ms end to end, of which about 2 400 is transport');
  Logger.log('that no change here can touch. A saving under half a second is not');
  Logger.log('worth rewriting the read path for.');
  Logger.log('');
  Logger.log('Note also that batchGet returns text as displayed, not the typed');
  Logger.log('values getValues gives. Dates and numbers would arrive as strings,');
  Logger.log('which is a second cost to weigh and not a detail.');
}

/**
 * A1 column letter, delegated so there is one implementation.
 *
 * SheetService needs it to build ranges, and these diagnostics need the same
 * answer. Two copies would agree until one of them was corrected.
 */
function _columnLetter(index) {
  return SheetService.columnLetter(index);
}


/**
 * Whether batchGet returns the same data getValues does, cell for cell.
 *
 * This has to be settled before anything reads through the Sheets API, and it
 * cannot be settled by reasoning. Five places in SheetService compare against
 * the literal `true`:
 *
 *   a.deleted !== true      an attachment removed from a signed report
 *   s.valid === true        a signature that counts
 *   s.active === true       a schema the app can find at all
 *
 * If the values arrive as the text 'TRUE' rather than as booleans, every one of
 * those flips silently. The first is the worst thing this app could do: a
 * photograph deleted from an inspection reappearing in the evidence.
 *
 * Two known differences are checked for by name, because both are quiet:
 *
 *   Types. batchGet renders as displayed unless asked otherwise, so numbers and
 *   booleans come back as text. UNFORMATTED_VALUE is meant to prevent that, and
 *   this confirms it rather than trusting it.
 *
 *   Ragged rows. batchGet stops at the last cell with anything in it, so a row
 *   whose trailing columns are empty comes back short — and _rowToObject
 *   indexes by position, so the missing fields become undefined instead of ''.
 *   A row of answers ending in an empty comment is enough to trigger it.
 */
function checkBatchGetFidelity() {
  if (typeof Sheets === 'undefined') {
    Logger.log('The Sheets advanced service is not enabled — see benchmarkSheetReads().');
    return;
  }

  const workbookId = Config.getWorkbookId();
  const ss = SpreadsheetApp.openById(workbookId);
  const names = Object.keys(SheetService.COLUMNS);

  let problems = 0;
  let ragged = 0;
  let compared = 0;

  names.forEach(function (name) {
    const width = SheetService.COLUMNS[name].length;
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      Logger.log(`- ${name}: not in the workbook, skipped`);
      return;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      Logger.log(`- ${name}: empty, nothing to compare`);
      return;
    }

    const viaApp = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    const range = `${name}!A2:${_columnLetter(width)}${lastRow}`;
    const answer = Sheets.Spreadsheets.Values.batchGet(workbookId, {
      ranges: [range],
      // The two options this whole exercise turns on.
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const viaApi = (answer.valueRanges[0] || {}).values || [];

    if (viaApi.length !== viaApp.length) {
      Logger.log(`✗ ${name}: ${viaApp.length} rows via getValues, ${viaApi.length} via batchGet`);
      problems++;
    }

    const rows = Math.min(viaApp.length, viaApi.length);
    for (let r = 0; r < rows; r++) {
      if ((viaApi[r] || []).length < width) ragged++;
      for (let c = 0; c < width; c++) {
        const a = viaApp[r][c];
        // A short row means an empty trailing cell, which getValues gives as ''.
        const b = (viaApi[r] || []).length > c ? viaApi[r][c] : '';
        compared++;

        // Dates are the one place a difference is expected and harmless: this
        // app writes them as ISO text, but a cell someone formatted as a date
        // comes back as a Date object one way and a string the other. Compared
        // as text, since that is how every reader of them treats them.
        if (a instanceof Date) {
          if (String(b) === '') {
            Logger.log(`✗ ${name} row ${r + 2} col ${SheetService.COLUMNS[name][c]}: `
              + `a date via getValues, empty via batchGet`);
            problems++;
          }
          continue;
        }

        if (typeof a !== typeof b) {
          Logger.log(`✗ ${name} row ${r + 2} col ${SheetService.COLUMNS[name][c]}: `
            + `${typeof a} ${JSON.stringify(a)} via getValues, `
            + `${typeof b} ${JSON.stringify(b)} via batchGet`);
          problems++;
          continue;
        }
        if (a !== b) {
          Logger.log(`✗ ${name} row ${r + 2} col ${SheetService.COLUMNS[name][c]}: `
            + `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
          problems++;
        }
      }
    }
  });

  Logger.log('');
  Logger.log(`Compared ${compared} cells across ${names.length} sheets.`);
  Logger.log(`${ragged} row(s) came back short and were padded to compare.`);
  Logger.log('');

  if (problems === 0) {
    Logger.log('No differences. batchGet with UNFORMATTED_VALUE returns what');
    Logger.log('getValues returns, so the read path can move to it — as long as');
    Logger.log('short rows are padded to the column count on the way in. They are');
    Logger.log(ragged > 0
      ? `real in this workbook: ${ragged} row(s) above.`
      : 'absent here only because no row happens to end in an empty cell — which');
    if (ragged === 0) {
      Logger.log('is luck, not a property. Pad regardless.');
    }
    return;
  }

  Logger.log(`${problems} difference(s). Do not move the read path until each is`);
  Logger.log('understood — five comparisons in SheetService are against the literal');
  Logger.log("true, and a string 'TRUE' passes none of them.");
}

/**
 * Whether the apostrophe trick actually works on this platform.
 *
 * SheetService puts a leading apostrophe in front of any string that starts
 * with a character Sheets would read as a formula, because a tenant's phone
 * number written as `+381 60 …` was being evaluated and left as #ERROR!.
 *
 * That fix rests on a claim about Sheets: the apostrophe marks the cell as
 * text and is not part of the value, so it does not come back from getValues.
 * If that is wrong, every phone number gains a stray character and the fix is
 * worse than the bug. The unit tests cannot settle it — their fake spreadsheet
 * strips the apostrophe because I told it to, which proves nothing about here.
 *
 * So this writes into a scratch sheet, reads it back both ways, and deletes it.
 * It touches no real data.
 */
function checkTextEscaping() {
  const RISKY = [
    '+381 60 123 45 67',
    '+41 79 000 00 00',
    '=SUM(A1:A2)',
    '-not a negative',
    '@someone',
    'Dobricka 17',
    '',
  ];

  const ss = SpreadsheetApp.openById(Config.getWorkbookId());
  const name = 'ScratchEscapingCheck';
  let sheet = ss.getSheetByName(name);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(name);

  try {
    // Written exactly the way SheetService writes a row.
    const escaped = RISKY.map(function (v) {
      return (typeof v === 'string' && v !== ''
        && ['=', '+', '-', '@'].indexOf(v.charAt(0)) >= 0) ? `'${v}` : v;
    });
    sheet.getRange(1, 1, 1, escaped.length).setValues([escaped]);
    SpreadsheetApp.flush();

    const back = sheet.getRange(1, 1, 1, RISKY.length).getValues()[0];

    let wrong = 0;
    for (let i = 0; i < RISKY.length; i++) {
      const same = String(back[i]) === String(RISKY[i]);
      if (!same) wrong++;
      Logger.log(`${same ? 'ok  ' : '✗   '} wrote ${JSON.stringify(RISKY[i])}`
        + `  →  read ${JSON.stringify(back[i])}`);
    }

    Logger.log('');
    if (wrong === 0) {
      Logger.log('Every value came back as written. The apostrophe marks the cell');
      Logger.log('as text and is not part of the value, which is what the escaping');
      Logger.log('in SheetService depends on.');
    } else {
      Logger.log(`${wrong} value(s) did not survive. The escaping in SheetService`);
      Logger.log('is not doing what it claims and phone numbers are still at risk.');
    }

    // And through the other reader, since that is where the app is heading.
    if (typeof Sheets !== 'undefined') {
      const range = `${name}!A1:${_columnLetter(RISKY.length)}1`;
      const api = Sheets.Spreadsheets.Values.batchGet(Config.getWorkbookId(), {
        ranges: [range],
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
      const viaApi = ((api.valueRanges[0] || {}).values || [[]])[0];
      let apiWrong = 0;
      for (let i = 0; i < RISKY.length; i++) {
        const got = viaApi.length > i ? viaApi[i] : '';
        if (String(got) !== String(RISKY[i])) {
          apiWrong++;
          Logger.log(`✗   batchGet: wrote ${JSON.stringify(RISKY[i])}`
            + `  →  read ${JSON.stringify(got)}`);
        }
      }
      Logger.log(apiWrong === 0
        ? 'batchGet agrees, so the escaping survives the move to the Sheets API.'
        : `${apiWrong} value(s) differ through batchGet — the read path cannot move yet.`);
    }
  } finally {
    const scratch = ss.getSheetByName(name);
    if (scratch) ss.deleteSheet(scratch);
  }
}
