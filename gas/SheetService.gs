/**
 * SheetService.gs
 * All Sheet read/write operations. Sheet is the canonical store.
 * Each sheet has a fixed column order matching docs/sheet-schema.md.
 */

const SheetService = (function () {

  // --- Column definitions (must match sheet-schema.md exactly) ---

  const COLUMNS = {
    Inspections: [
      'inspectionId', 'status', 'inspectionType', 'schemaId', 'schemaVersion',
      'propertyAddress', 'propertyUnit',
      'landlordName', 'landlordEmail', 'landlordPhone',
      'tenantName', 'tenantEmail', 'tenantPhone',
      'notes', 'createdAt', 'updatedAt', 'createdBy',
      'driveFolderId', 'finalPdfFileId',
      'currentNonce', 'tenantTokenHash',
      'lockedAt', 'signedAt',
      // Appended, never inserted: bootstrapSheet() rewrites the header row in
      // place, so a column added in the middle would shift every existing row.
      'assignedTo'
    ],
    Answers: [
      'inspectionId', 'sectionId', 'itemId', 'valueType',
      'value', 'comment', 'attachmentCount', 'updatedAt', 'updatedBy'
    ],
    Attachments: [
      'attachmentId', 'inspectionId', 'sectionId', 'itemId',
      'driveFileId', 'fileName', 'mimeType', 'sizeBytes',
      'width', 'height', 'caption', 'uploadedAt', 'uploadedBy', 'deleted'
    ],
    Signatures: [
      'signatureId', 'inspectionId', 'signerRole', 'signerName', 'accepted',
      'signatureFileId', 'signedAt', 'ipAddress', 'userAgent', 'nonce', 'valid'
    ],
    AuditLog: [
      'eventId', 'inspectionId', 'actor', 'eventType', 'timestamp', 'detailsJson'
    ],
    Schemas: [
      'schemaId', 'inspectionType', 'version', 'active', 'title',
      'schemaJson', 'createdAt', 'updatedAt'
    ],
    Config: [
      'key', 'value', 'description', 'updatedAt'
    ],
    Users: [
      'userId', 'email', 'name', 'role', 'status',
      'passHash', 'passSetAt',
      'failedCount', 'lockedUntil',
      'createdAt', 'createdBy',
      'disabledAt', 'disabledBy',
      'lastLoginAt', 'notes'
    ],
    Devices: [
      'deviceId', 'userId', 'label', 'nonce',
      'createdAt', 'lastSeenAt', 'expiresAt',
      'revokedAt', 'revokedBy', 'userAgent'
    ],
  };

  // --- Sheet access ---

  let _ssCache = null;

  /**
   * What this execution spent talking to Sheets.
   *
   * The split in Code.gs can say a handler took four seconds but not where they
   * went. Opening the workbook is one fixed cost; every getValues() after it is
   * a round trip, and so is every write.
   *
   * Writes were left out of the first version of this on the grounds that
   * nobody waits on them. That was wrong: an appendRow costs the same round
   * trip as a read, and a handler like createInspection does three of them
   * while the person sits looking at a spinner.
   */
  const _stats = {
    opened: false, openMs: 0,
    reads: 0, readMs: 0,
    writes: 0, writeMs: 0,
    locks: 0, lockWaitMs: 0,
  };

  function _ss() {
    if (!_ssCache) {
      const startedAt = Date.now();
      _ssCache = SpreadsheetApp.openById(Config.getWorkbookId());
      _stats.opened = true;
      _stats.openMs = Date.now() - startedAt;
    }
    return _ssCache;
  }

  function getStats() {
    return {
      openMs: _stats.openMs,
      reads: _stats.reads, readMs: _stats.readMs,
      writes: _stats.writes, writeMs: _stats.writeMs,
      locks: _stats.locks, lockWaitMs: _stats.lockWaitMs,
    };
  }

  /**
   * Count a read that does not go through _getAllRows.
   *
   * These were left out of the first version of the counters, on the reasoning
   * that direct-cell reads sit on write paths where nobody is waiting. That was
   * wrong, and wrong in the worst place: upsertAnswer scans the whole Answers
   * sheet on every item of every autosave, which is exactly where someone is
   * waiting. Uncounted, the numbers would have shown no improvement from
   * batching that loop — because they were never showing the cost.
   */
  function _rawRead(fn) {
    const startedAt = Date.now();
    try {
      return fn();
    } finally {
      _stats.reads += 1;
      _stats.readMs += Date.now() - startedAt;
    }
  }

  /**
   * Take the script lock, and record how long it was waited on.
   *
   * getScriptLock is application-wide: two inspectors saving two unrelated
   * inspections queue behind each other. That is a platform property rather
   * than a bug here, but time spent waiting on it is indistinguishable from
   * slowness unless it is measured separately.
   */
  function _withLock(timeoutMs, fn) {
    const lock = LockService.getScriptLock();
    const startedAt = Date.now();
    lock.waitLock(timeoutMs);
    _stats.locks += 1;
    _stats.lockWaitMs += Date.now() - startedAt;
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }

  /** Wrap a write so it shows up in the slow-request breakdown. */
  function _write(fn) {
    const startedAt = Date.now();
    try {
      return fn();
    } finally {
      _stats.writes += 1;
      _stats.writeMs += Date.now() - startedAt;
    }
  }

  function _sheet(name) {
    const sheet = _ss().getSheetByName(name);
    if (!sheet) throw new HandoverError('INTERNAL_ERROR', `Sheet '${name}' not found. Run bootstrapSheet().`);
    return sheet;
  }

  // --- Generic row helpers ---

  function _rowToObject(sheetName, row) {
    const cols = COLUMNS[sheetName];
    const obj = {};
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = row[i];
    }
    return obj;
  }

  function _objectToRow(sheetName, obj) {
    const cols = COLUMNS[sheetName];
    const row = [];
    for (let i = 0; i < cols.length; i++) {
      const v = obj[cols[i]];
      row.push(v === undefined || v === null ? '' : v);
    }
    return row;
  }

  /**
   * Rows already read during this execution.
   *
   * Every getValues() is a separate round trip to the Sheets backend, and a
   * single request reads the same sheet several times over: resolving auth
   * touches Users and Devices, then the handler walks Answers, Attachments and
   * Signatures, and a projection may go back to Users again for display names.
   *
   * An Apps Script execution serves one request and then dies, so this cache
   * cannot outlive the request or go stale between requests — the failure mode
   * that makes caching sheet data dangerous elsewhere does not exist here. It
   * only has to stay honest *within* a request, which is what the invalidation
   * on every write is for.
   */
  let _rowCache = {};

  function _invalidate(sheetName) {
    delete _rowCache[sheetName];
  }

  function _getAllRows(sheetName) {
    if (_rowCache[sheetName]) return _rowCache[sheetName];

    const startedAt = Date.now();
    const sheet = _sheet(sheetName);
    const lastRow = sheet.getLastRow();
    const rows = lastRow <= 1
      ? []
      : sheet.getRange(2, 1, lastRow - 1, COLUMNS[sheetName].length).getValues();
    _countRead(startedAt);

    _rowCache[sheetName] = rows;
    return rows;
  }

  /**
   * Time inside _ss() is the workbook open, counted separately; charging it to
   * the read that happened to trigger it would hide it.
   */
  function _countRead(startedAt) {
    _stats.reads += 1;
    _stats.readMs += Date.now() - startedAt - (_stats.opened ? _stats.openMs : 0);
    _stats.opened = false;
  }

  /**
   * Sheets with a column large enough that reading every row to find one is a
   * bad trade. Schemas holds a whole form definition per row.
   */
  const HEAVY_SHEETS = { Schemas: true };

  /**
   * Find row by primary key column. Returns { rowIndex (1-based, including header), data } or null.
   *
   * For ordinary sheets this reads all rows: one round trip instead of the two
   * it used to take, and the rows are then shared with every other lookup in
   * the same request.
   *
   * For a heavy sheet it reads the key column and then the single matching row,
   * which is two round trips but moves a fraction of the bytes. Reading every
   * row of Schemas pulls every form definition in the workbook in order to use
   * one of them — and getInspection does exactly that lookup on every open.
   */
  function _findRowByKey(sheetName, keyColumn, keyValue) {
    const colIndex = COLUMNS[sheetName].indexOf(keyColumn);
    if (colIndex < 0) throw new Error(`Column ${keyColumn} not in ${sheetName}`);

    const needle = String(keyValue);

    // A heavy sheet already in the cache costs nothing to scan; only go the
    // narrow route when the rows would otherwise have to be fetched.
    if (HEAVY_SHEETS[sheetName] && !_rowCache[sheetName]) {
      return _findRowNarrow(sheetName, colIndex, needle);
    }

    const rows = _getAllRows(sheetName);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][colIndex]) === needle) {
        return {
          rowIndex: i + 2, // +1 for 1-based, +1 for header
          data: _rowToObject(sheetName, rows[i]),
        };
      }
    }
    return null;
  }

  function _findRowNarrow(sheetName, colIndex, needle) {
    const startedAt = Date.now();
    const sheet = _sheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      _countRead(startedAt);
      return null;
    }

    const keys = sheet.getRange(2, colIndex + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) !== needle) continue;
      const rowIndex = i + 2;
      const row = sheet.getRange(rowIndex, 1, 1, COLUMNS[sheetName].length).getValues()[0];
      _countRead(startedAt);
      _stats.reads += 1; // the key column and the row are two round trips
      return { rowIndex: rowIndex, data: _rowToObject(sheetName, row) };
    }
    _countRead(startedAt);
    return null;
  }

  function _appendRow(sheetName, obj) {
    const sheet = _sheet(sheetName);
    const row = _objectToRow(sheetName, obj);
    _write(() => sheet.appendRow(row));
    _invalidate(sheetName);
  }

  function _updateRow(sheetName, rowIndex, obj) {
    const sheet = _sheet(sheetName);
    const row = _objectToRow(sheetName, obj);
    _write(() => sheet.getRange(rowIndex, 1, 1, COLUMNS[sheetName].length).setValues([row]));
    _invalidate(sheetName);
  }

  // ============================================================
  // Inspections
  // ============================================================

  function createInspection(inspection) {
    _appendRow('Inspections', inspection);
  }

  function getInspection(inspectionId) {
    const result = _findRowByKey('Inspections', 'inspectionId', inspectionId);
    return result ? result.data : null;
  }

  function updateInspection(inspectionId, updates) {
    const result = _findRowByKey('Inspections', 'inspectionId', inspectionId);
    if (!result) throw new HandoverError('NOT_FOUND', `Inspection ${inspectionId} not found.`);
    const merged = Object.assign({}, result.data, updates, { updatedAt: Utils.nowIso() });
    _updateRow('Inspections', result.rowIndex, merged);
    return merged;
  }

  function listInspections(filter) {
    filter = filter || {};
    const all = _getAllRows('Inspections').map(r => _rowToObject('Inspections', r));
    let filtered = all;
    if (filter.status && filter.status.length > 0) {
      filtered = filtered.filter(i => filter.status.indexOf(i.status) >= 0);
    }
    if (filter.inspectionType) {
      filtered = filtered.filter(i => i.inspectionType === filter.inspectionType);
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      filtered = filtered.filter(i =>
        String(i.propertyAddress).toLowerCase().includes(q) ||
        String(i.tenantName).toLowerCase().includes(q) ||
        String(i.landlordName).toLowerCase().includes(q) ||
        String(i.inspectionId).toLowerCase().includes(q)
      );
    }
    if (filter.fromDate) {
      filtered = filtered.filter(i => i.createdAt >= filter.fromDate);
    }
    if (filter.toDate) {
      filtered = filtered.filter(i => i.createdAt <= filter.toDate);
    }
    return filtered;
  }

  // ============================================================
  // Answers
  // ============================================================

  function getAnswersForInspection(inspectionId) {
    const all = _getAllRows('Answers').map(r => _rowToObject('Answers', r));
    return all.filter(a => a.inspectionId === inspectionId);
  }

  /**
   * Upsert an answer by composite key (inspectionId, sectionId, itemId).
   * Uses a script lock to prevent race conditions on rapid saves.
   */
  function upsertAnswer(answer) {
    return _withLock(10000, function () {
      const sheet = _sheet('Answers');
      const lastRow = sheet.getLastRow();
      let foundRowIndex = -1;
      if (lastRow > 1) {
        // Counted: this runs once per changed item, per autosave.
        const data = _rawRead(() =>
          sheet.getRange(2, 1, lastRow - 1, 3).getValues()); // inspectionId, sectionId, itemId
        for (let i = 0; i < data.length; i++) {
          if (String(data[i][0]) === answer.inspectionId &&
              String(data[i][1]) === answer.sectionId &&
              String(data[i][2]) === answer.itemId) {
            foundRowIndex = i + 2;
            break;
          }
        }
      }
      if (foundRowIndex > 0) {
        _updateRow('Answers', foundRowIndex, answer);
      } else {
        _appendRow('Answers', answer);
      }
    });
  }

  // ============================================================
  // Attachments
  // ============================================================

  function createAttachment(attachment) {
    _appendRow('Attachments', attachment);
  }

  function getAttachmentsForInspection(inspectionId, includeDeleted) {
    const all = _getAllRows('Attachments').map(r => _rowToObject('Attachments', r));
    return all.filter(a =>
      a.inspectionId === inspectionId && (includeDeleted || a.deleted !== true)
    );
  }

  function getAttachment(attachmentId) {
    const result = _findRowByKey('Attachments', 'attachmentId', attachmentId);
    return result ? result.data : null;
  }

  function softDeleteAttachment(attachmentId) {
    const result = _findRowByKey('Attachments', 'attachmentId', attachmentId);
    if (!result) throw new HandoverError('NOT_FOUND', `Attachment ${attachmentId} not found.`);
    const updated = Object.assign({}, result.data, { deleted: true });
    _updateRow('Attachments', result.rowIndex, updated);
    return updated;
  }

  function countAttachmentsForItem(inspectionId, sectionId, itemId) {
    return getAttachmentsForInspection(inspectionId, false)
      .filter(a => a.sectionId === sectionId && a.itemId === itemId).length;
  }

  function countAttachmentsForInspection(inspectionId) {
    return getAttachmentsForInspection(inspectionId, false).length;
  }

  /**
   * After a new attachment is added/deleted, denormalize attachmentCount on the
   * Answer row so frontend doesn't have to recompute.
   */
  function recomputeAttachmentCount(inspectionId, sectionId, itemId) {
    const count = countAttachmentsForItem(inspectionId, sectionId, itemId);
    const sheet = _sheet('Answers');
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;
    const data = _rawRead(() => sheet.getRange(2, 1, lastRow - 1, 3).getValues());
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]) === inspectionId &&
          String(data[i][1]) === sectionId &&
          String(data[i][2]) === itemId) {
        const colIndex = COLUMNS.Answers.indexOf('attachmentCount') + 1;
        _write(() => sheet.getRange(i + 2, colIndex).setValue(count));
        _invalidate('Answers');
        return;
      }
    }
    // No answer row exists yet — create empty answer row to track the count
    upsertAnswer({
      inspectionId, sectionId, itemId,
      valueType: '', value: '', comment: '',
      attachmentCount: count,
      updatedAt: Utils.nowIso(),
      updatedBy: 'system',
    });
  }

  // ============================================================
  // Signatures
  // ============================================================

  function createSignature(signature) {
    _appendRow('Signatures', signature);
  }

  function getSignaturesForInspection(inspectionId, validOnly) {
    const all = _getAllRows('Signatures').map(r => _rowToObject('Signatures', r));
    return all.filter(s => s.inspectionId === inspectionId && (!validOnly || s.valid === true));
  }

  /**
   * Mark all signatures for an inspection as invalid (used when reopening).
   */
  function invalidateSignatures(inspectionId) {
    const sheet = _sheet('Signatures');
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];
    const data = _rawRead(() =>
      sheet.getRange(2, 1, lastRow - 1, COLUMNS.Signatures.length).getValues());
    const validColIdx = COLUMNS.Signatures.indexOf('valid');
    const inspectionIdColIdx = COLUMNS.Signatures.indexOf('inspectionId');
    const invalidated = [];
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][inspectionIdColIdx]) === inspectionId && data[i][validColIdx] === true) {
        _write(() => sheet.getRange(i + 2, validColIdx + 1).setValue(false));
        invalidated.push(data[i][COLUMNS.Signatures.indexOf('signatureId')]);
      }
    }
    if (invalidated.length) _invalidate('Signatures');
    return invalidated;
  }

  // ============================================================
  // AuditLog
  // ============================================================

  function appendAuditEvent(event) {
    _appendRow('AuditLog', event);
  }

  function getAuditEventsForInspection(inspectionId) {
    const all = _getAllRows('AuditLog').map(r => _rowToObject('AuditLog', r));
    return all.filter(e => e.inspectionId === inspectionId);
  }

  /**
   * Account and sign-in events — the rows with no inspection attached.
   *
   * Reads the whole log and filters in memory, which is fine at this scale but
   * will not stay that way forever. When the log grows past comfort, this is
   * the function to move onto its own sheet.
   */
  function getAuthAuditEvents() {
    return _getAllRows('AuditLog')
      .map(r => _rowToObject('AuditLog', r))
      .filter(e => !e.inspectionId);
  }

  // ============================================================
  // Schemas
  // ============================================================

  function getActiveSchemas() {
    const all = _getAllRows('Schemas').map(r => _rowToObject('Schemas', r));
    return all.filter(s => s.active === true);
  }

  /**
   * Active schemas without their definitions.
   *
   * A form that lists inspection types needs four short columns. Going through
   * getActiveSchemas fetched every row in full, and a Schemas row carries an
   * entire form definition in schemaJson — tens of kilobytes to render a
   * dropdown of two entries.
   *
   * Reads the narrow range instead, and does not warm the row cache: a request
   * that only lists schemas has no use for the definitions, and one that needs
   * a definition takes the narrow lookup path in _findRowByKey.
   */
  function getActiveSchemaSummaries() {
    const cols = COLUMNS.Schemas;
    const wanted = ['schemaId', 'inspectionType', 'version', 'active', 'title'];
    const last = Math.max.apply(null, wanted.map(c => cols.indexOf(c))) + 1;

    const sheet = _sheet('Schemas');
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = _rawRead(() => sheet.getRange(2, 1, lastRow - 1, last).getValues());
    return rows
      .map(r => {
        const o = {};
        wanted.forEach(c => { o[c] = r[cols.indexOf(c)]; });
        return o;
      })
      .filter(s => s.active === true);
  }

  function getSchema(schemaId) {
    const result = _findRowByKey('Schemas', 'schemaId', schemaId);
    return result ? result.data : null;
  }

  function upsertSchema(schema) {
    const result = _findRowByKey('Schemas', 'schemaId', schema.schemaId);
    if (result) {
      const merged = Object.assign({}, result.data, schema, { updatedAt: Utils.nowIso() });
      _updateRow('Schemas', result.rowIndex, merged);
    } else {
      _appendRow('Schemas', schema);
    }
    // The copy SchemaService keeps would otherwise outlive this write by up to
    // six hours. Resolved here rather than at load time, like every other
    // cross-service reference.
    SchemaService.invalidate(schema.schemaId);
  }

  // ============================================================
  // Users
  // ============================================================

  function createUser(user) {
    _appendRow('Users', user);
  }

  function getUser(userId) {
    const result = _findRowByKey('Users', 'userId', userId);
    return result ? result.data : null;
  }

  /** Email lookup is case-insensitive — the stored value is already lowercased. */
  function getUserByEmail(email) {
    const needle = String(email || '').trim().toLowerCase();
    if (!needle) return null;
    const all = _getAllRows('Users').map(r => _rowToObject('Users', r));
    return all.find(u => String(u.email).trim().toLowerCase() === needle) || null;
  }

  function updateUser(userId, updates) {
    const result = _findRowByKey('Users', 'userId', userId);
    if (!result) throw new HandoverError('NOT_FOUND', `User ${userId} not found.`);
    const merged = Object.assign({}, result.data, updates);
    _updateRow('Users', result.rowIndex, merged);
    return merged;
  }

  function listUsers() {
    return _getAllRows('Users').map(r => _rowToObject('Users', r));
  }

  // ============================================================
  // Devices
  // ============================================================

  function createDevice(device) {
    _appendRow('Devices', device);
  }

  function getDevice(deviceId) {
    const result = _findRowByKey('Devices', 'deviceId', deviceId);
    return result ? result.data : null;
  }

  function updateDevice(deviceId, updates) {
    const result = _findRowByKey('Devices', 'deviceId', deviceId);
    if (!result) throw new HandoverError('NOT_FOUND', `Device ${deviceId} not found.`);
    const merged = Object.assign({}, result.data, updates);
    _updateRow('Devices', result.rowIndex, merged);
    return merged;
  }

  function getDevicesForUser(userId, includeRevoked) {
    const all = _getAllRows('Devices').map(r => _rowToObject('Devices', r));
    return all.filter(d => d.userId === userId && (includeRevoked || !d.revokedAt));
  }

  function listDevices() {
    return _getAllRows('Devices').map(r => _rowToObject('Devices', r));
  }

  // ============================================================
  // Config
  // ============================================================

  /**
   * The Config sheet as rows, through the same handle and cache as everything
   * else. Config used to open the workbook itself, which meant a second
   * SpreadsheetApp.openById on every execution for a sheet the request was
   * usually going to touch anyway.
   */
  function getConfigRows() {
    return _getAllRows('Config').map(r => _rowToObject('Config', r));
  }

  // ============================================================
  // Diagnostics
  // ============================================================

  /**
   * Highest NNNNNN in use on a sheet, for IDs shaped PRE-YYYY-NNNNNN.
   * Rows from other years are ignored — each year counts from one.
   *
   * Lives here rather than in BootstrapService so it goes through the same
   * spreadsheet handle and the same per-execution cache. Opening the workbook
   * again for each sheet, which is what it did before, is one of the most
   * expensive calls available.
   */
  function highestIdSuffix(sheetName, idColumn, year) {
    const index = COLUMNS[sheetName].indexOf(idColumn);
    if (index < 0) throw new Error(`Column ${idColumn} not in ${sheetName}`);

    let highest = 0;
    _getAllRows(sheetName).forEach(row => {
      const match = String(row[index]).match(/^[A-Z]+-(\d{4})-(\d+)$/);
      if (!match || Number(match[1]) !== year) return;
      const n = Number(match[2]);
      if (n > highest) highest = n;
    });
    return highest;
  }

  /**
   * Revoke every active device of one user in a single pass.
   * Used on password change and when an account is disabled.
   */
  function revokeDevicesForUser(userId, revokedBy) {
    const sheet = _sheet('Devices');
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];
    const data = _rawRead(() =>
      sheet.getRange(2, 1, lastRow - 1, COLUMNS.Devices.length).getValues());
    const userIdIdx = COLUMNS.Devices.indexOf('userId');
    const revokedAtIdx = COLUMNS.Devices.indexOf('revokedAt');
    const revokedByIdx = COLUMNS.Devices.indexOf('revokedBy');
    const deviceIdIdx = COLUMNS.Devices.indexOf('deviceId');
    const now = Utils.nowIso();
    const revoked = [];
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][userIdIdx]) === userId && !data[i][revokedAtIdx]) {
        _write(() => sheet.getRange(i + 2, revokedAtIdx + 1).setValue(now));
        _write(() => sheet.getRange(i + 2, revokedByIdx + 1).setValue(revokedBy || 'system'));
        revoked.push(String(data[i][deviceIdIdx]));
      }
    }
    if (revoked.length) _invalidate('Devices');
    return revoked;
  }

  // ============================================================
  // Public API
  // ============================================================

  return {
    COLUMNS,
    // Inspections
    createInspection,
    getInspection,
    updateInspection,
    listInspections,
    // Answers
    getAnswersForInspection,
    upsertAnswer,
    // Attachments
    createAttachment,
    getAttachmentsForInspection,
    getAttachment,
    softDeleteAttachment,
    countAttachmentsForItem,
    countAttachmentsForInspection,
    recomputeAttachmentCount,
    // Signatures
    createSignature,
    getSignaturesForInspection,
    invalidateSignatures,
    // Audit
    appendAuditEvent,
    getAuditEventsForInspection,
    getAuthAuditEvents,
    // Schemas
    getActiveSchemas,
    getActiveSchemaSummaries,
    getSchema,
    upsertSchema,
    // Users
    createUser,
    getUser,
    getUserByEmail,
    updateUser,
    listUsers,
    // Devices
    createDevice,
    getDevice,
    updateDevice,
    getDevicesForUser,
    listDevices,
    revokeDevicesForUser,
    getConfigRows,
    // Diagnostics
    highestIdSuffix,
    getStats,
  };
})();
