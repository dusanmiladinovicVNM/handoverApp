/**
 * InspectionService.gs
 * Inspection lifecycle: create, fetch, update answers, lock/unlock, finalize.
 * Coordinates SheetService, DriveService, AuthService, and AuditService.
 */

const InspectionService = (function () {

  function createInspection(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionType', 'string');
    Utils.requireField(data, 'schemaId', 'string');
    Utils.requireField(data, 'property', 'object');
    Utils.requireField(data, 'parties', 'object');

    // Verify schema exists and is active
    const schema = SheetService.getSchema(data.schemaId);
    if (!schema || schema.active !== true) {
      throw new HandoverError('INVALID_SCHEMA', `Schema ${data.schemaId} not found or inactive.`);
    }

    const inspectionId = Utils.generateInspectionId();
    const driveFolderId = DriveService.createInspectionFolders(inspectionId);
    const nonce = Utils.generateNonce();

    const tenantToken = AuthService.generateToken(
      inspectionId,
      'tenant',
      Config.getDefaultTokenTtlHours(),
      nonce
    );

    const property = data.property || {};
    const parties = data.parties || {};
    const landlord = parties.landlord || {};
    const tenant = parties.tenant || {};

    const propertyAddress = [
      property.addressLine1,
      property.city,
      property.postalCode,
    ].filter(Boolean).join(', ');

    const inspection = {
      inspectionId,
      status: 'draft',
      inspectionType: data.inspectionType,
      schemaId: data.schemaId,
      schemaVersion: schema.version,
      propertyAddress,
      propertyUnit: property.unitNumber || '',
      landlordName: landlord.name || '',
      landlordEmail: landlord.email || '',
      landlordPhone: landlord.phone || '',
      tenantName: tenant.name || '',
      tenantEmail: tenant.email || '',
      tenantPhone: tenant.phone || '',
      notes: data.notes || '',
      createdAt: Utils.nowIso(),
      updatedAt: Utils.nowIso(),
      createdBy: authCtx.email || authCtx.actorString || 'unknown',
      driveFolderId,
      finalPdfFileId: '',
      currentNonce: nonce,
      tenantTokenHash: Utils.sha256(tenantToken),
      lockedAt: '',
      signedAt: '',
    };

    SheetService.createInspection(inspection);
    AuditService.log(inspectionId, authCtx.actorString, 'inspection_created', {
      inspectionType: data.inspectionType,
      schemaId: data.schemaId,
    });
    AuditService.log(inspectionId, authCtx.actorString, 'tenant_token_generated', {
      ttlHours: Config.getDefaultTokenTtlHours(),
    });

    const tenantUrl = `${Config.getFrontendUrl()}#/inspection/${inspectionId}?t=${tenantToken}`;

    return {
      inspectionId,
      status: 'draft',
      driveFolderId,
      tenantToken,
      tenantUrl,
    };
  }

  function getInspection(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    AuthService.requireMatchingInspection(authCtx, data.inspectionId);

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    // Hide sensitive fields from tenant
    if (!authCtx.isAdmin) {
      delete inspection.tenantTokenHash;
      delete inspection.currentNonce;
      delete inspection.createdBy;
    }

    const schemaJson = SchemaService.getSchemaJson(inspection.schemaId);
    const answerRows = SheetService.getAnswersForInspection(data.inspectionId);
    const attachmentRows = SheetService.getAttachmentsForInspection(data.inspectionId, false);
    const signatureRows = SheetService.getSignaturesForInspection(data.inspectionId, false);

    // Pivot answers into nested structure: { sectionId: { itemId: {...} } }
    const answers = {};
    for (const a of answerRows) {
      if (!answers[a.sectionId]) answers[a.sectionId] = {};
      answers[a.sectionId][a.itemId] = {
        value: a.value,
        valueType: a.valueType,
        comment: a.comment,
        attachmentCount: Number(a.attachmentCount || 0),
        updatedAt: a.updatedAt,
      };
    }

    const attachments = attachmentRows.map(a => ({
      attachmentId: a.attachmentId,
      sectionId: a.sectionId,
      itemId: a.itemId,
      fileId: a.driveFileId,
      fileName: a.fileName,
      mimeType: a.mimeType,
      caption: a.caption,
      thumbnailUrl: DriveService.getThumbnailUrl(a.driveFileId),
      uploadedAt: a.uploadedAt,
    }));

    const signatures = signatureRows.map(s => ({
      signatureId: s.signatureId,
      signerRole: s.signerRole,
      signerName: s.signerName,
      accepted: s.accepted,
      signatureFileId: s.signatureFileId,
      signedAt: s.signedAt,
      valid: s.valid,
    }));

    return {
      inspection,
      schema: schemaJson,
      answers,
      attachments,
      signatures,
    };
  }

  function saveSection(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'sectionId', 'string');
    Utils.requireField(data, 'items', 'object');
    AuthService.requireMatchingInspection(authCtx, data.inspectionId);

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    // Block writes on locked/finalized inspections
    if (inspection.status === 'locked_for_signature' ||
        inspection.status === 'partially_signed' ||
        inspection.status === 'signed' ||
        inspection.status === 'archived' ||
        inspection.status === 'cancelled') {
      throw new HandoverError('INSPECTION_LOCKED',
        `Cannot save section: inspection is in status '${inspection.status}'.`);
    }

    const schemaJson = SchemaService.getSchemaJson(inspection.schemaId);
    const sectionItems = SchemaService.getSectionItems(schemaJson, data.sectionId);
    if (sectionItems.length === 0) {
      throw new HandoverError('INVALID_REQUEST', `Section ${data.sectionId} not in schema.`);
    }
    const itemTypeMap = {};
    for (const it of sectionItems) itemTypeMap[it.id] = it.type;

    const savedItems = [];
    const now = Utils.nowIso();

    for (const itemId of Object.keys(data.items)) {
      if (!itemTypeMap[itemId]) {
        // Skip unknown items silently rather than fail the whole save
        Utils.log('WARN', `Unknown itemId '${itemId}' for section '${data.sectionId}'`, {});
        continue;
      }
      const itemData = data.items[itemId];
      const value = itemData.value;
      const comment = itemData.comment || '';

      // Stringify multi-select arrays for storage
      let storedValue;
      if (Array.isArray(value)) {
        storedValue = JSON.stringify(value);
      } else if (typeof value === 'boolean') {
        storedValue = value ? 'true' : 'false';
      } else if (value === undefined || value === null) {
        storedValue = '';
      } else {
        storedValue = String(value);
      }

      const existingCount = SheetService.countAttachmentsForItem(
        data.inspectionId, data.sectionId, itemId
      );

      SheetService.upsertAnswer({
        inspectionId: data.inspectionId,
        sectionId: data.sectionId,
        itemId: itemId,
        valueType: itemTypeMap[itemId],
        value: storedValue,
        comment: comment,
        attachmentCount: existingCount,
        updatedAt: now,
        updatedBy: authCtx.actorString,
      });
      savedItems.push(itemId);
    }

    SheetService.updateInspection(data.inspectionId, { updatedAt: now });
    AuditService.log(data.inspectionId, authCtx.actorString, 'section_saved', {
      sectionId: data.sectionId,
      itemCount: savedItems.length,
    });

    return { savedItems, updatedAt: now };
  }

  function lockInspection(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    const schemaJson = SchemaService.getSchemaJson(inspection.schemaId);
    const answerRows = SheetService.getAnswersForInspection(data.inspectionId);

    ValidationService.validateForLock(inspection, schemaJson, answerRows);

    const now = Utils.nowIso();
    const updated = SheetService.updateInspection(data.inspectionId, {
      status: 'locked_for_signature',
      lockedAt: now,
      updatedAt: now,
    });

    AuditService.log(data.inspectionId, authCtx.actorString, 'inspection_locked', {});
    return { status: updated.status, lockedAt: now };
  }

  function unlockInspection(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    if (inspection.status !== 'locked_for_signature' && inspection.status !== 'partially_signed') {
      throw new HandoverError('VALIDATION_FAILED',
        `Cannot unlock from status '${inspection.status}'.`);
    }

    // Invalidate all signatures
    const invalidatedIds = SheetService.invalidateSignatures(data.inspectionId);

    // Regenerate nonce — invalidates outstanding tenant tokens
    const newNonce = Utils.generateNonce();
    const now = Utils.nowIso();
    SheetService.updateInspection(data.inspectionId, {
      status: 'draft',
      currentNonce: newNonce,
      lockedAt: '',
      signedAt: '',
      updatedAt: now,
    });

    for (const sigId of invalidatedIds) {
      AuditService.log(data.inspectionId, authCtx.actorString, 'signature_invalidated', { signatureId: sigId });
    }
    AuditService.log(data.inspectionId, authCtx.actorString, 'inspection_unlocked', {
      reason: data.reason || '',
      invalidatedSignatures: invalidatedIds.length,
    });

    return {
      status: 'draft',
      invalidatedSignatures: invalidatedIds,
      newNonce: newNonce,
    };
  }

  function regenerateTenantToken(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    const ttlHours = Number(data.ttlHours) || Config.getDefaultTokenTtlHours();

    // Bump nonce so old tokens stop working
    const newNonce = Utils.generateNonce();
    const newToken = AuthService.generateToken(data.inspectionId, 'tenant', ttlHours, newNonce);

    SheetService.updateInspection(data.inspectionId, {
      currentNonce: newNonce,
      tenantTokenHash: Utils.sha256(newToken),
      updatedAt: Utils.nowIso(),
    });

    AuditService.log(data.inspectionId, authCtx.actorString, 'tenant_token_generated', {
      ttlHours,
      nonceRotated: true,
    });

    const tenantUrl = `${Config.getFrontendUrl()}#/inspection/${data.inspectionId}?t=${newToken}`;
    const expiresAt = new Date((Utils.nowEpochSeconds() + ttlHours * 3600) * 1000).toISOString();

    return { tenantToken: newToken, tenantUrl, expiresAt };
  }

  function listInspections(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    const filter = (data && data.filter) || {};
    const all = SheetService.listInspections(filter);

    const sortBy = (data && data.sortBy) || 'updatedAt';
    const sortOrder = (data && data.sortOrder) || 'desc';
    all.sort((a, b) => {
      const av = String(a[sortBy] || '');
      const bv = String(b[sortBy] || '');
      const cmp = av < bv ? -1 : (av > bv ? 1 : 0);
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    const page = Math.max(0, parseInt((data && data.page) || 0, 10));
    const pageSize = Math.max(1, Math.min(200, parseInt((data && data.pageSize) || 50, 10)));
    const start = page * pageSize;
    const slice = all.slice(start, start + pageSize);

    const projected = slice.map(i => ({
      inspectionId: i.inspectionId,
      status: i.status,
      inspectionType: i.inspectionType,
      propertyAddress: i.propertyAddress,
      propertyUnit: i.propertyUnit,
      landlordName: i.landlordName,
      tenantName: i.tenantName,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));

    return {
      inspections: projected,
      totalCount: all.length,
      page,
      pageSize,
    };
  }

  return {
    createInspection,
    getInspection,
    saveSection,
    lockInspection,
    unlockInspection,
    regenerateTenantToken,
    listInspections,
  };
})();
