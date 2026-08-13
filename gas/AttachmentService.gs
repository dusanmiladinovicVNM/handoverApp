/**
 * AttachmentService.gs
 * Photo upload, listing, deletion.
 */

const AttachmentService = (function () {

  /**
   * What a file's opening bytes have to look like for each mime type we accept.
   *
   * The mimeType in the request is a string the caller chose; it says what the
   * sender claims, not what arrived. These are the bytes the format itself
   * requires, so they say what the file actually is.
   *
   * WEBP needs two runs: 'RIFF' at 0, then 'WEBP' at 8, with a four-byte length
   * in between that can be anything.
   */
  const MAGIC = {
    'image/jpeg': [{ at: 0, bytes: [0xFF, 0xD8, 0xFF] }],
    'image/png':  [{ at: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }],
    'image/webp': [{ at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
                   { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
  };

  /**
   * How many bytes the base64 decodes to, without decoding it.
   *
   * A four-megabyte photograph should not be turned into a byte array just so
   * its size can be refused. Four base64 characters carry three bytes, less
   * whatever the padding stands in for.
   *
   * Exact only for base64 with no line breaks in it, which is why the caller
   * checks the length is a multiple of four first — whitespace would make this
   * an over-estimate, and an over-estimate is not something to reject an upload
   * on.
   */
  function _decodedSize(base64Data) {
    const len = base64Data.length;
    if (len === 0) return 0;
    let padding = 0;
    if (base64Data.charAt(len - 1) === '=') padding++;
    if (base64Data.charAt(len - 2) === '=') padding++;
    return (len / 4) * 3 - padding;
  }

  /**
   * The first `count` bytes, decoded from the front of the string alone.
   *
   * Utilities.base64Decode returns Java bytes, so anything above 0x7F arrives
   * negative — 0xFF, the first byte of every JPEG, comes back as -1. The mask
   * puts it back.
   */
  function _leadingBytes(base64Data, count) {
    const chars = Math.ceil(count / 3) * 4;
    if (base64Data.length < chars) return null;
    let decoded;
    try {
      decoded = Utilities.base64Decode(base64Data.substring(0, chars));
    } catch (e) {
      return null;
    }
    const out = [];
    for (let i = 0; i < decoded.length; i++) out.push(decoded[i] & 0xFF);
    return out;
  }

  function _looksLike(mimeType, base64Data) {
    const runs = MAGIC[mimeType];
    if (!runs) return false;
    let needed = 0;
    runs.forEach(r => { needed = Math.max(needed, r.at + r.bytes.length); });
    const head = _leadingBytes(base64Data, needed);
    if (!head) return false;
    return runs.every(run =>
      run.bytes.every((b, i) => head[run.at + i] === b));
  }

  /**
   * Everything about the upload that can be decided before Drive is touched.
   *
   * The order matters. Until this ran, an upload naming a section that does not
   * exist, or an item that takes no photographs, wrote a file into Drive and a
   * row into the sheet and only then found nowhere to count it — so the file
   * stayed, invisible to the app and to the report, and the only trace was a
   * count that never moved. Refusing first costs one schema read, which is
   * cached, against a Drive write that is not undone.
   */
  function _validateUpload(inspection, data) {
    const schemaJson = SchemaService.getSchemaJson(inspection.schemaId);
    const sectionItems = SchemaService.getSectionItems(schemaJson, data.sectionId);
    if (sectionItems.length === 0) {
      throw new HandoverError('INVALID_REQUEST',
        `Section ${data.sectionId} not in schema.`);
    }
    const item = sectionItems.filter(it => it.id === data.itemId)[0];
    if (!item) {
      throw new HandoverError('INVALID_REQUEST',
        `Item ${data.itemId} not in section ${data.sectionId}.`);
    }
    if (!item.attachments || item.attachments.enabled !== true) {
      throw new HandoverError('VALIDATION_FAILED',
        `Item ${data.itemId} does not take photographs.`);
    }

    const allowedMimes = Object.keys(MAGIC);
    if (allowedMimes.indexOf(data.mimeType) < 0) {
      throw new HandoverError('VALIDATION_FAILED',
        `Unsupported mime type: ${data.mimeType}.`);
    }

    // Rejected rather than tidied. Stripping whitespace means copying the whole
    // string, and a body this app never sends is not worth a copy of a
    // multi-megabyte photograph to be lenient about.
    if (data.base64Data.length === 0 || data.base64Data.length % 4 !== 0) {
      throw new HandoverError('VALIDATION_FAILED',
        'Photo data is not valid base64.');
    }

    const sizeBytes = _decodedSize(data.base64Data);
    const maxBytes = Config.getMaxAttachmentMb() * 1024 * 1024;
    if (sizeBytes > maxBytes) {
      throw new HandoverError('VALIDATION_FAILED',
        `Photo is larger than the ${Config.getMaxAttachmentMb()} MB limit.`,
        { sizeBytes, maxBytes });
    }

    if (!_looksLike(data.mimeType, data.base64Data)) {
      throw new HandoverError('VALIDATION_FAILED',
        `This file is not a ${data.mimeType}.`);
    }

    // The schema's own per-item limit, which until now only the browser
    // enforced — so it held for the app's own uploader and for nothing else.
    const schemaMax = Number(item.attachments.max);
    const configMax = Config.getMaxAttachmentsPerItem();
    const itemMax = (schemaMax > 0) ? Math.min(schemaMax, configMax) : configMax;

    return { itemMax, sizeBytes };
  }

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

    const checked = _validateUpload(inspection, data);

    // Quota checks
    const inspectionMax = Config.getMaxAttachmentsPerInspection();
    const itemCount = SheetService.countAttachmentsForItem(
      data.inspectionId, data.sectionId, data.itemId
    );
    const inspectionCount = SheetService.countAttachmentsForInspection(data.inspectionId);
    if (itemCount >= checked.itemMax) {
      throw new HandoverError('VALIDATION_FAILED',
        `Maximum ${checked.itemMax} photos per item exceeded.`,
        { itemMax: checked.itemMax, itemCount });
    }
    if (inspectionCount >= inspectionMax) {
      throw new HandoverError('VALIDATION_FAILED',
        `Maximum ${inspectionMax} photos per inspection exceeded.`,
        { inspectionMax, inspectionCount });
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
    const sizeBytes = checked.sizeBytes;

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
