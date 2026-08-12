/**
 * InspectionService.gs
 * Inspection lifecycle: create, fetch, update answers, lock/unlock, finalize.
 * Coordinates SheetService, DriveService, AuthService, and AuditService.
 */

const InspectionService = (function () {

  function createInspection(authCtx, data) {
    AuthService.requireStaff(authCtx);
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

    const tenantToken = AuthService.generateTenantToken(
      inspectionId,
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
      // Who the inspection is *for*, which is not always who typed it in. The
      // office commonly opens the job and an inspector goes out to do it, so
      // ownership cannot be inferred from createdBy. This column now governs
      // what an inspector may see, which is why only an admin may point it at
      // someone else: an inspector naming another owner would be handing away
      // the inspection it had just created, and could not get it back.
      assignedTo: (authCtx.isAdmin
        ? UserService.normalizeEmail(data.assignedTo)
        : '') || authCtx.email || '',
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
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    // Named together, so they arrive in one request instead of four.
    //
    // This is the only call anyone waits on inside the app, and its server time
    // was mostly the sheets: 525 ms opening the workbook plus 561 reading,
    // against 150 for one batchGet of the same four ranges. Asking for them one
    // at a time would keep four round trips and throw the saving away.
    //
    // Naming a sheet that is not needed costs a range in a request that is
    // happening anyway; forgetting one costs a whole extra request, so the list
    // errs towards complete.
    SheetService.prefetch(
      ['Inspections', 'SectionAnswers', 'Attachments', 'Signatures']);

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

    // The revision of each section, so the editor can send back the one it
    // read. Without it a save cannot tell "nothing changed underneath me" from
    // "someone else saved while I was typing".
    const revisions = {};
    (schemaJson.sections || []).forEach(sec => {
      revisions[sec.id] = SheetService.getSectionRevision(data.inspectionId, sec.id);
    });

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

    // Display name for the assignee, resolved here so the client never has to
    // ask who an address belongs to — which it could not do anyway without
    // admin rights.
    if (inspection.assignedTo) {
      const assignee = UserService.getByEmail(inspection.assignedTo);
      inspection.assignedToName = assignee ? assignee.name : '';
    } else {
      inspection.assignedToName = '';
    }

    return {
      inspection,
      schema: schemaJson,
      answers,
      revisions,
      attachments,
      signatures,
    };
  }

  /**
   * A sheet cell holds text. Multi-select answers become JSON, booleans become
   * the words, and absent becomes empty — the same coercion the per-item loop
   * did inline, now somewhere it can be read.
   */
  function _storedValue(value) {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value === undefined || value === null) return '';
    return String(value);
  }

  function saveSection(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'sectionId', 'string');
    Utils.requireField(data, 'items', 'object');
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    ValidationService.assertContentEditable(inspection, 'save this section');

    const schemaJson = SchemaService.getSchemaJson(inspection.schemaId);
    const sectionItems = SchemaService.getSectionItems(schemaJson, data.sectionId);
    if (sectionItems.length === 0) {
      throw new HandoverError('INVALID_REQUEST', `Section ${data.sectionId} not in schema.`);
    }
    const itemTypeMap = {};
    for (const it of sectionItems) itemTypeMap[it.id] = it.type;

    const now = Utils.nowIso();

    // Built first, written once. The loop this replaced took the script lock,
    // scanned the whole Answers sheet and wrote a row for every changed item —
    // around eighteen round trips for an eight-item save, on the path someone
    // waits on to leave a section.
    const toSave = {};
    for (const itemId of Object.keys(data.items)) {
      if (!itemTypeMap[itemId]) {
        // Skip unknown items silently rather than fail the whole save
        Utils.log('WARN', `Unknown itemId '${itemId}' for section '${data.sectionId}'`, {});
        continue;
      }
      const itemData = data.items[itemId];
      toSave[itemId] = {
        valueType: itemTypeMap[itemId],
        value: _storedValue(itemData.value),
        comment: itemData.comment || '',
      };
    }

    // attachmentCount is not touched here. It is maintained by
    // recomputeAttachmentCount on upload and delete, and the merge leaves
    // fields it was not given alone — so a save no longer has to count
    // attachments per item just to avoid clobbering the number.
    const result = SheetService.upsertSectionAnswers(
      data.inspectionId, data.sectionId, toSave, authCtx.actorString,
      data.expectedRevision);

    SheetService.updateInspection(data.inspectionId, { updatedAt: now });
    AuditService.log(data.inspectionId, authCtx.actorString, 'section_saved', {
      sectionId: data.sectionId,
      itemCount: result.savedItems.length,
      revision: result.revision,
    });

    return {
      savedItems: result.savedItems,
      revision: result.revision,
      updatedAt: now,
    };
  }

  function lockInspection(authCtx, data) {
    AuthService.requireStaff(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

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
    AuthService.requireStaff(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    const ttlHours = Number(data.ttlHours) || Config.getDefaultTokenTtlHours();

    // Bump nonce so old tokens stop working
    const newNonce = Utils.generateNonce();
    const newToken = AuthService.generateTenantToken(data.inspectionId, ttlHours, newNonce);

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
    AuthService.requireStaff(authCtx);
    const filter = (data && data.filter) || {};
    // Narrowed after the sheet, not through it: the filter object above comes
    // from the client, and a restriction sent by the client is one the client
    // can leave out. totalCount and the paging below then count what this
    // caller can actually see.
    const all = AuthService.visibleInspections(
      authCtx, SheetService.listInspections(filter));

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

    // One pass over the users to turn stored addresses into names — but only
    // for an admin. The screen shows the assignee to nobody else, and an
    // inspector's list is their own work anyway, so for them this was a whole
    // sheet read to build a map nothing rendered.
    const nameByEmail = {};
    if (authCtx.isAdmin) {
      UserService.listAll().forEach(u => {
        nameByEmail[String(u.email).toLowerCase()] = u.name;
      });
    }

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
      // The address stays the stored value — it is the identity, and names
      // change. The name rides alongside it, for display only.
      assignedTo: i.assignedTo || '',
      assignedToName: nameByEmail[String(i.assignedTo || '').toLowerCase()] || '',
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
