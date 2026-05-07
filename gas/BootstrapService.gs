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

  // Seed default Config rows if Config sheet is empty
  const configSheet = ss.getSheetByName('Config');
  if (configSheet.getLastRow() === 1) {
    const defaultConfig = [
      ['defaultTokenTtlHours', '168', 'Tenant link expiry hours (default 7 days)'],
      ['maxAttachmentsPerItem', '5', 'Max photos per item'],
      ['maxAttachmentsPerInspection', '80', 'Max photos per inspection'],
      ['imageMaxDimPx', '1600', 'Frontend should compress to this max dimension'],
      ['imageJpegQuality', '0.75', 'Frontend JPEG compression quality 0-1'],
    ];
    const now = Utils.nowIso();
    const rows = defaultConfig.map(row => [...row, now]);
    configSheet.getRange(2, 1, rows.length, 4).setValues(rows);
    Logger.log(`Seeded ${rows.length} config rows`);
  }

  Logger.log('Bootstrap complete.');
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
 * Generate an admin token. Run from Apps Script editor.
 *
 * EDIT THE LABEL below to identify the device/person before running.
 * Default TTL is 365 days (admin keeps device long-term).
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
  check('Admin tokens registered', () => {
    if (AuthService.listAdminTokens().length === 0) {
      throw new Error('no admin tokens — run generateAdminTokenForMe()');
    }
  });

  Logger.log(checks.join('\n'));
}


/**
 * Diagnostic: simulate what frontend sends for saveSection.
 * Run this directly in editor, then check Logs.
 */
function debugSaveSection() {
  // Replace with your real inspection ID and token
  const inspectionId = 'INS-2026-000001';  // ← stavi pravi ID
  const adminToken = 'eyJyb2xlIjoiYWRtaW4iLCJleHAiOjE4MDk2ODQ2MzMsIm5vbmNlIjoiNmZmNjMyMzRjNmU0NzI3YiIsImxhYmVsIjoiRHXFoWFuIG1haW4gZGV2aWNlIn0.iTNVq4isjs9WKGpT2Fn0wt1Qp6yJUMeACpuHHpNx_Xw'; // ← stavi pravi admin token

  const fakeRequest = {
    postData: {
      contents: JSON.stringify({
        action: 'saveSection',
        auth: { type: 'token', token: adminToken },
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
