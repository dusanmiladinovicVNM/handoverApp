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
    ['pbkdf2Iterations', '1000', 'Password work factor — raise it after running benchmarkPbkdf2()'],
    ['passwordMinLength', '12', 'Minimum password length'],
    ['sessionTtlHours', '12', 'How long a session token lasts'],
    ['deviceTtlDays', '60', 'How long a remembered device lasts'],
    ['setPasswordTtlHours', '48', 'How long a set-password link stays valid'],
    ['loginMaxFailures', '5', 'Failed sign-ins before an account locks'],
    ['loginLockMinutes', '15', 'How long an account stays locked'],
    ['authCacheTtlSeconds', '60', 'How long a cached user or device row is trusted'],
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
 * DEPRECATED — use bootstrapFirstAdmin() instead.
 *
 * Kept only so that anyone already holding one of these tokens is not locked
 * out while accounts are being rolled out. Removed in phase 3, along with the
 * ADMIN_NONCES property. Do not issue new ones: a token minted here belongs to
 * no person, expires in a year, and can only be revoked from this editor.
 *
 * EDIT THE LABEL below to identify the device/person before running.
 *
 * Steps:
 *   1. Edit the LABEL below.
 *   2. Run this function in the Apps Script editor.
 *   3. View Logs (Ctrl+Enter or View → Logs).
 *   4. Copy the token from the log.
 *   5. Open the frontend app — paste token when prompted.
 *
 * To revoke a token later, run listAdminTokens() to find its nonce, then
 * revokeAdminTokenByNonce('the-nonce').
 */
function generateAdminTokenForMe() {
  const LABEL = 'Dušan main device';   // ← EDIT THIS
  const TTL_HOURS = 24 * 365;          // 1 year

  const token = AuthService.generateAdminToken(TTL_HOURS, LABEL);
  Logger.log('=========================================');
  Logger.log('ADMIN TOKEN GENERATED');
  Logger.log('Label: ' + LABEL);
  Logger.log('TTL hours: ' + TTL_HOURS);
  Logger.log('Token (copy everything between the lines):');
  Logger.log('-----------------------------------------');
  Logger.log(token);
  Logger.log('-----------------------------------------');
  Logger.log('Now open the frontend app and paste this token when prompted.');
  Logger.log('=========================================');
}

/**
 * List all currently valid admin tokens.
 * Run in Apps Script editor to see who has access.
 */
function listAdminTokens() {
  const list = AuthService.listAdminTokens();
  if (list.length === 0) {
    Logger.log('No admin tokens. Run generateAdminTokenForMe() first.');
    return;
  }
  Logger.log(`${list.length} admin token(s):`);
  list.forEach((t, i) => {
    Logger.log(`  ${i + 1}. label="${t.label}" nonce=${t.nonce}`);
    Logger.log(`     created=${t.createdAt} expires=${t.expiresAt}`);
  });
}

/**
 * Revoke an admin token by its nonce.
 * Get the nonce from listAdminTokens().
 *
 *   revokeAdminTokenByNonce('a7f3b2c1d4e5f6a7');
 */
function revokeAdminTokenByNonce(nonce) {
  if (!nonce) {
    Logger.log('Pass the nonce as argument: revokeAdminTokenByNonce("...")');
    return;
  }
  const removed = AuthService.revokeAdminToken(nonce);
  Logger.log(removed ? 'Token revoked.' : 'Nonce not found — already revoked?');
}

/**
 * Quick smoke test. Run after full setup to verify all components.
 * Logs PASS/FAIL for each check.
 */
function smokeTest() {
  const checks = [];

  function check(name, fn) {
    try {
      fn();
      checks.push(`✓ ${name}`);
    } catch (e) {
      checks.push(`✗ ${name}: ${e.message}`);
    }
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

  Logger.log(checks.join('\n'));
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
 * Create the very first administrator, or repair access when nobody can get in.
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
  MailService.sendSetPasswordLink(user, token, PasswordService.hasPassword(user));
  AuditService.logAuth('bootstrap', 'user_created', { userId: user.userId, role: 'admin' });

  Logger.log(`Set-password link sent to ${normalized}, valid for ${Config.getSetPasswordTtlHours()}h.`);
  Logger.log('If mail does not arrive, the link is also printed below:');
  Logger.log(`${Config.getFrontendUrl()}#/set-password?k=${token}`);
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
  const budgetMs = 1000;

  Logger.log('Measuring PBKDF2-HMAC-SHA256 …');

  let recommendation = 0;
  [1000, 5000, 20000].forEach(function (iterations) {
    const started = Date.now();
    PasswordService._pbkdf2Sha256(password, salt, iterations);
    const elapsed = Date.now() - started;
    const perIteration = elapsed / iterations;
    Logger.log(`  ${iterations} iterations → ${elapsed} ms (${perIteration.toFixed(4)} ms each)`);
    if (!recommendation && perIteration > 0) {
      recommendation = Math.floor(budgetMs / perIteration / 100) * 100;
    }
  });

  Logger.log('');
  Logger.log(`Recommended pbkdf2Iterations: ${recommendation}`);
  Logger.log('That is the largest value keeping a sign-in near one second.');
  Logger.log('Put it in the Config sheet under key: pbkdf2Iterations');
  Logger.log('');
  Logger.log('Worth remembering: even at this setting the work factor stays far');
  Logger.log('below bcrypt or Argon2. Password length is what carries this scheme —');
  Logger.log('do not lower passwordMinLength below 12.');
}
