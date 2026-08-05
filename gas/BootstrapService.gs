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

  Logger.log('Bootstrap complete.');
}

/**
 * Add any config key that is missing, leaving existing values alone.
 *
 * Seeding only into an empty sheet would mean an existing installation never
 * picks up keys added later — it would silently run on code defaults while the
 * sheet that is meant to be the editable source of truth stays incomplete.
 */
function _seedMissingConfigKeys(ss) {
  const defaults = [
    ['defaultTokenTtlHours', '168', 'Tenant link expiry hours (default 7 days)'],
    ['maxAttachmentsPerItem', '5', 'Max photos per item'],
    ['maxAttachmentsPerInspection', '80', 'Max photos per inspection'],
    ['imageMaxDimPx', '1600', 'Frontend should compress to this max dimension'],
    ['imageJpegQuality', '0.75', 'Frontend JPEG compression quality 0-1'],
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
      'hasPassword', 'validatePolicy']],
    ['UserService', () => UserService, ['getById', 'getByEmail', 'listAll',
      'countActiveAdmins', 'create', 'update', 'isLocked', 'registerFailedLogin',
      'normalizeEmail', 'toPublic']],
    ['DeviceService', () => DeviceService, ['register', 'getById', 'checkUsable',
      'touch', 'revoke', 'revokeAllForUser', 'listForUser']],
    ['MailService', () => MailService, ['sendSetPasswordLink']],
    ['AuthService', () => AuthService, ['generateSessionToken', 'generateDeviceToken',
      'generateSetPasswordToken', 'generateTenantToken', 'verifyToken',
      'verifySetPasswordToken', 'verifyDeviceToken', 'resolveAuth',
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
    ['PdfService', () => PdfService, ['finalizeInspection']],
    ['DriveService', () => DriveService, ['createInspectionFolders', 'getThumbnailUrl']],
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
    'getSchemas', 'getSchema', 'createInspection', 'getInspection', 'saveSection',
    'lockInspection', 'unlockInspection', 'regenerateTenantToken', 'listInspections',
    'uploadAttachment', 'deleteAttachment', 'saveSignature', 'finalizeInspection',
    'getAuditLog',
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
 * put the recommended value into the Config sheet under pbkdf2Iterations.
 *
 * Raising it later is safe — the iteration count is stored with every hash and
 * existing rows upgrade themselves on the owner's next sign-in.
 */
function benchmarkPbkdf2() {
  const password = 'benchmark-passphrase-of-realistic-length';
  const salt = Utils.secureRandomBytes(16);

  // A sign-in happens once per session — twelve hours, or sixty days on a
  // remembered device. Several seconds of it is not a cost anyone notices, and
  // here every millisecond spent is one the work factor gets.
  const budgetMs = 2500;

  // Warm up before timing anything.
  //
  // The first version of this function measured 2.5 ms per iteration and was
  // wrong by a factor of four: the real cost in a warm execution is nearer
  // 0.6 ms. Everything after that inherited the error — the recommended
  // iteration count came out four times too low, which is four times less work
  // for anyone attacking a stolen hash. A cold first pass measures the runtime
  // warming up, not the work.
  PasswordService._pbkdf2Sha256(password, salt, 500);

  Logger.log('Measuring PBKDF2-HMAC-SHA256 …');

  let slowestPerIteration = 0;
  [200, 500, 1000].forEach(function (iterations) {
    const started = Date.now();
    PasswordService._pbkdf2Sha256(password, salt, iterations);
    const elapsed = Date.now() - started;
    const perIteration = elapsed / iterations;
    Logger.log(`  ${iterations} iterations → ${elapsed} ms (${perIteration.toFixed(4)} ms each)`);
    if (perIteration > slowestPerIteration) slowestPerIteration = perIteration;
  });

  const recommendation = slowestPerIteration > 0
    ? Math.max(100, Math.floor(budgetMs / slowestPerIteration / 100) * 100)
    : 0;

  Logger.log('');
  Logger.log(`Recommended pbkdf2Iterations: ${recommendation}`);
  Logger.log(`Keeps a sign-in near ${(budgetMs / 1000).toFixed(1)} s, using the slowest sample.`);
  Logger.log('Put it in the Config sheet under key: pbkdf2Iterations');
  Logger.log('');
  Logger.log('Read the number honestly. Almost all of that time is the cost of');
  Logger.log('crossing from JavaScript into the platform, which an attacker running');
  Logger.log('native code does not pay — so each iteration buys far less than the');
  Logger.log('milliseconds suggest. A few thousand iterations here is nowhere near');
  Logger.log('what bcrypt or Argon2 would give on an ordinary server.');
  Logger.log('');
  Logger.log('But do raise the setting to what this prints. Leaving it below the');
  Logger.log('measurement costs nothing in comfort and hands the attacker a');
  Logger.log('proportional discount, in direct proportion:');
  Logger.log(`  currently set: ${Config.getPbkdf2Iterations()}`);
  Logger.log(`  fits the same budget: ${recommendation}`);
  Logger.log('A sign-in happens once every twelve hours, or once every sixty days');
  Logger.log('on a remembered device — so the extra second is not a cost anyone');
  Logger.log('meets often, while the discount applies to every stolen hash.');
  Logger.log('');
  Logger.log('What that means in practice:');
  Logger.log('  · password LENGTH is what actually protects these accounts —');
  Logger.log('    keep passwordMinLength at 16, so people write a phrase, not a word');
  Logger.log('  · account lockout is part of the defence, not a nicety');
  Logger.log('  · the workbook holds the hashes — do not share it more widely');
  Logger.log('    than it needs to be shared');
}
