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
      'lockedAt', 'signedAt'
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
  };

  // --- Sheet access ---

  let _ssCache = null;

  function _ss() {
    if (!_ssCache) {
      _ssCache = SpreadsheetApp.openById(Config.getWorkbookId());
    }
    return _ssCache;
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

  function _getAllRows(sheetName) {
    const sheet = _sheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];
    const range = sheet.getRange(2, 1, lastRow - 1, COLUMNS[sheetName].length);
    return range.getValues();
  }

  /**
   * Find row by primary key column. Returns { rowIndex (1-based, including header), data } or null.
   */
  function _findRowByKey(sheetName, keyColumn, keyValue) {
    const sheet = _sheet(sheetName);
    const colIndex = COLUMNS[sheetName].indexOf(keyColumn);
    if (colIndex < 0) throw new Error(`Column ${keyColumn} not in ${sheetName}`);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;
    const colValues = sheet.getRange(2, colIndex + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < colValues.length; i++) {
      if (String(colValues[i][0]) === String(keyValue)) {
        const rowIndex = i + 2; // +1 for 1-based, +1 for header
        const fullRow = sheet.getRange(rowIndex, 1, 1, COLUMNS[sheetName].length).getValues()[0];
        return { rowIndex, data: _rowToObject(sheetName, fullRow) };
      }
    }
    return null;
  }

  function _appendRow(sheetName, obj) {
    const sheet = _sheet(sheetName);
    const row = _objectToRow(sheetName, obj);
    sheet.appendRow(row);
  }

  function _updateRow(sheetName, rowIndex, obj) {
    const sheet = _sheet(sheetName);
    const row = _objectToRow(sheetName, obj);
    sheet.getRange(rowIndex, 1, 1, COLUMNS[sheetName].length).setValues([row]);
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
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = _sheet('Answers');
      const lastRow = sheet.getLastRow();
      let foundRowIndex = -1;
      if (lastRow > 1) {
        const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // first 3 columns: inspectionId, sectionId, itemId
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
    } finally {
      lock.releaseLock();
    }
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
    const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][0]) === inspectionId &&
          String(data[i][1]) === sectionId &&
          String(data[i][2]) === itemId) {
        const colIndex = COLUMNS.Answers.indexOf('attachmentCount') + 1;
        sheet.getRange(i + 2, colIndex).setValue(count);
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
    const data = sheet.getRange(2, 1, lastRow - 1, COLUMNS.Signatures.length).getValues();
    const validColIdx = COLUMNS.Signatures.indexOf('valid');
    const inspectionIdColIdx = COLUMNS.Signatures.indexOf('inspectionId');
    const invalidated = [];
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][inspectionIdColIdx]) === inspectionId && data[i][validColIdx] === true) {
        sheet.getRange(i + 2, validColIdx + 1).setValue(false);
        invalidated.push(data[i][COLUMNS.Signatures.indexOf('signatureId')]);
      }
    }
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

  // ============================================================
  // Schemas
  // ============================================================

  function getActiveSchemas() {
    const all = _getAllRows('Schemas').map(r => _rowToObject('Schemas', r));
    return all.filter(s => s.active === true);
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
    // Schemas
    getActiveSchemas,
    getSchema,
    upsertSchema,
  };
})();
