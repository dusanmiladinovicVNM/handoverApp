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
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    ValidationService.assertContentEditable(inspection, 'upload a photo');

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

    // The count is written into the section, which moves its revision on. The
    // editor has to be told, or the next autosave sends the revision it read
    // before the upload and is refused as somebody else's edit.
    const recounted = SheetService.recomputeAttachmentCount(
      data.inspectionId, data.sectionId, data.itemId);
    SheetService.updateInspection(data.inspectionId, { updatedAt: Utils.nowIso() });

    AuditService.log(data.inspectionId, authCtx.actorString, 'attachment_uploaded', {
      sectionId: data.sectionId,
      itemId: data.itemId,
      attachmentId,
      sizeBytes,
    });

    // No thumbnail here. The screen that just uploaded already holds the
    // picture it read off the camera, and showing that is both instant and a
    // truer confirmation than a copy fetched back from Drive.
    return {
      attachmentId,
      fileId: saved.fileId,
      fileName: saved.fileName,
      sectionId: data.sectionId,
      attachmentCount: recounted.count,
      revision: recounted.revision,
    };
  }

  function deleteAttachment(authCtx, data) {
    AuthService.requireStaff(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'attachmentId', 'string');
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    const att = SheetService.getAttachment(data.attachmentId);
    if (!att) throw new HandoverError('NOT_FOUND', 'Attachment not found.');
    if (att.inspectionId !== data.inspectionId) {
      throw new HandoverError('FORBIDDEN', 'Attachment does not belong to this inspection.');
    }

    const inspection = SheetService.getInspection(data.inspectionId);
    // Was 'signed' and 'archived' only, which let evidence be removed from an
    // inspection that had been locked for signature — or already half signed.
    ValidationService.assertContentEditable(inspection, 'delete a photo');

    SheetService.softDeleteAttachment(data.attachmentId);
    try {
      DriveService.moveToDeleted(data.inspectionId, att.driveFileId);
    } catch (e) {
      Utils.log('WARN', 'Failed to move file to _deleted folder, soft-delete sheet flag still set.', { error: e.message });
    }

    const recounted = SheetService.recomputeAttachmentCount(
      data.inspectionId, att.sectionId, att.itemId);
    SheetService.updateInspection(data.inspectionId, { updatedAt: Utils.nowIso() });

    AuditService.log(data.inspectionId, authCtx.actorString, 'attachment_deleted', {
      attachmentId: data.attachmentId,
    });

    return {
      attachmentId: data.attachmentId,
      deleted: true,
      sectionId: att.sectionId,
      attachmentCount: recounted.count,
      revision: recounted.revision,
    };
  }


  /**
   * Previews for the photographs in one section.
   *
   * Replaces a Drive URL that the browser fetched for itself. That URL asked
   * Drive whether the *viewer's Google account* may read the file, which is a
   * question with no useful answer here: a tenant has no Google account, and an
   * administrator was given rights in this app rather than in Drive. The first
   * one added that way opened an inspection and found a broken-image icon where
   * the meter reading should have been — not a future risk, a defect in front
   * of a user.
   *
   * A section rather than a photograph, because a request to this backend costs
   * about three seconds whatever it carries; five separate ones for five photos
   * would be worse than the bug. Drive's own thumbnails are a few kilobytes
   * each, so a section fits comfortably in one reply.
   *
   * A photo Drive has no preview for comes back with base64Data null. That is
   * absence, not failure: the photograph is there and downloadable, and the one
   * thing this must not do is imply it was lost.
   */
  function getSectionThumbs(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'sectionId', 'string');
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    const wanted = SheetService.getAttachmentsForInspection(data.inspectionId, false)
      .filter(a => a.sectionId === data.sectionId);

    const thumbs = wanted.map(function (a) {
      let thumb = null;
      try {
        thumb = DriveService.getThumbnailBytes(a.driveFileId);
      } catch (e) {
        // One unreadable file must not cost the section its other previews.
        Utils.log('WARN', 'Could not read a thumbnail', {
          attachmentId: a.attachmentId, fileId: a.driveFileId, error: e.message,
        });
      }
      return {
        attachmentId: a.attachmentId,
        itemId: a.itemId,
        mimeType: thumb ? thumb.mimeType : '',
        base64Data: thumb ? thumb.base64Data : null,
      };
    });

    return { inspectionId: data.inspectionId, sectionId: data.sectionId, thumbs };
  }


  /**
   * One photograph at full size, for someone who tapped it to look closer.
   *
   * A separate action from the previews on purpose. A section's previews are a
   * few kilobytes each and fetched together the moment the screen opens; this
   * is hundreds of kilobytes and fetched only when asked for, so folding it
   * into getSectionThumbs would make opening any section pay for pictures
   * nobody looked at.
   */
  function getAttachmentFile(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'attachmentId', 'string');
    AuthService.requireInspectionAccess(authCtx, data.inspectionId);

    const att = SheetService.getAttachment(data.attachmentId);
    if (!att || att.deleted === true) {
      throw new HandoverError('NOT_FOUND', 'Photograph not found.');
    }
    // Checked rather than assumed. requireInspectionAccess vouches for the
    // inspection named in the request, not for an attachment id that happens to
    // be passed alongside it — and those are two different things when the id
    // comes from the caller.
    if (att.inspectionId !== data.inspectionId) {
      throw new HandoverError('FORBIDDEN', 'That photograph belongs to another inspection.');
    }

    const file = DriveService.getFileBytes(
      att.driveFileId, Config.getMaxPdfDownloadMb() * 1024 * 1024);

    return {
      attachmentId: att.attachmentId,
      fileName: att.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      base64Data: file.base64Data,
    };
  }

  return { uploadAttachment, deleteAttachment, getSectionThumbs, getAttachmentFile };
})();
