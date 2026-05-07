/**
 * AttachmentService.gs
 * Photo upload, listing, deletion.
 */

const AttachmentService = (function () {

  function uploadAttachment(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'sectionId', 'string');
    Utils.requireField(data, 'itemId', 'string');
    Utils.requireField(data, 'fileName', 'string');
    Utils.requireField(data, 'mimeType', 'string');
    Utils.requireField(data, 'base64Data', 'string');
    AuthService.requireMatchingInspection(authCtx, data.inspectionId);

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    // Block uploads on locked/finalized
    if (inspection.status === 'locked_for_signature' ||
        inspection.status === 'partially_signed' ||
        inspection.status === 'signed' ||
        inspection.status === 'archived' ||
        inspection.status === 'cancelled') {
      throw new HandoverError('INSPECTION_LOCKED',
        `Cannot upload photo: inspection is in status '${inspection.status}'.`);
    }

    // Quota checks
    const itemMax = Config.getMaxAttachmentsPerItem();
    const inspectionMax = Config.getMaxAttachmentsPerInspection();
    const itemCount = SheetService.countAttachmentsForItem(
      data.inspectionId, data.sectionId, data.itemId
    );
    const inspectionCount = SheetService.countAttachmentsForInspection(data.inspectionId);
    if (itemCount >= itemMax) {
      throw new HandoverError('VALIDATION_FAILED',
        `Maximum ${itemMax} photos per item exceeded.`,
        { itemMax, itemCount });
    }
    if (inspectionCount >= inspectionMax) {
      throw new HandoverError('VALIDATION_FAILED',
        `Maximum ${inspectionMax} photos per inspection exceeded.`,
        { inspectionMax, inspectionCount });
    }

    // Validate mime
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedMimes.indexOf(data.mimeType) < 0) {
      throw new HandoverError('VALIDATION_FAILED',
        `Unsupported mime type: ${data.mimeType}.`);
    }

    // Save to Drive
    let saved;
    try {
      saved = DriveService.savePhoto(
        data.inspectionId,
        data.sectionId,
        data.itemId,
        data.base64Data,
        data.mimeType,
        data.fileName
      );
    } catch (e) {
      throw new HandoverError('UPLOAD_FAILED', 'Failed to save photo to Drive.', { detail: e.message });
    }

    const attachmentId = Utils.generateAttachmentId();
    const sizeBytes = Math.floor(data.base64Data.length * 0.75); // approximate

    SheetService.createAttachment({
      attachmentId,
      inspectionId: data.inspectionId,
      sectionId: data.sectionId,
      itemId: data.itemId,
      driveFileId: saved.fileId,
      fileName: saved.fileName,
      mimeType: data.mimeType,
      sizeBytes,
      width: data.width || '',
      height: data.height || '',
      caption: data.caption || '',
      uploadedAt: Utils.nowIso(),
      uploadedBy: authCtx.actorString,
      deleted: false,
    });

    SheetService.recomputeAttachmentCount(data.inspectionId, data.sectionId, data.itemId);
    SheetService.updateInspection(data.inspectionId, { updatedAt: Utils.nowIso() });

    AuditService.log(data.inspectionId, authCtx.actorString, 'attachment_uploaded', {
      sectionId: data.sectionId,
      itemId: data.itemId,
      attachmentId,
      sizeBytes,
    });

    return {
      attachmentId,
      fileId: saved.fileId,
      fileName: saved.fileName,
      thumbnailUrl: DriveService.getThumbnailUrl(saved.fileId),
    };
  }

  function deleteAttachment(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'attachmentId', 'string');

    const att = SheetService.getAttachment(data.attachmentId);
    if (!att) throw new HandoverError('NOT_FOUND', 'Attachment not found.');
    if (att.inspectionId !== data.inspectionId) {
      throw new HandoverError('FORBIDDEN', 'Attachment does not belong to this inspection.');
    }

    const inspection = SheetService.getInspection(data.inspectionId);
    if (inspection.status === 'signed' || inspection.status === 'archived') {
      throw new HandoverError('INSPECTION_LOCKED',
        `Cannot delete photo on '${inspection.status}' inspection.`);
    }

    SheetService.softDeleteAttachment(data.attachmentId);
    try {
      DriveService.moveToDeleted(data.inspectionId, att.driveFileId);
    } catch (e) {
      Utils.log('WARN', 'Failed to move file to _deleted folder, soft-delete sheet flag still set.', { error: e.message });
    }

    SheetService.recomputeAttachmentCount(data.inspectionId, att.sectionId, att.itemId);
    SheetService.updateInspection(data.inspectionId, { updatedAt: Utils.nowIso() });

    AuditService.log(data.inspectionId, authCtx.actorString, 'attachment_deleted', {
      attachmentId: data.attachmentId,
    });

    return { attachmentId: data.attachmentId, deleted: true };
  }

  return { uploadAttachment, deleteAttachment };
})();
