/**
 * PdfService.gs
 * Final PDF generation. Copies template Google Doc, populates content, exports as PDF.
 *
 * Strategy:
 *  1. Copy template doc into the inspection's output folder.
 *  2. Replace simple placeholders ({{INSPECTION_ID}}, etc.) with body.replaceText().
 *  3. Find anchor placeholders ({{SECTIONS_PLACEHOLDER}}, {{PHOTOS_PLACEHOLDER}}, {{SIGNATURES_PLACEHOLDER}})
 *     and replace with structured content using DocumentApp APIs.
 *  4. saveAndClose, then export as PDF blob.
 *  5. Save PDF and JSON snapshot to Drive output folder.
 *  6. Trash the temporary working doc.
 *
 * Performance: typical inspection (~10 sections, ~30 photos) ~30-60 seconds.
 * Apps Script timeout is 6 minutes — we have plenty of headroom.
 */

const PdfService = (function () {

  function finalizeInspection(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    const signatures = SheetService.getSignaturesForInspection(data.inspectionId, true);
    ValidationService.validateForFinalize(inspection, signatures);

    const schemaJson = SchemaService.getSchemaJson(inspection.schemaId);
    const answerRows = SheetService.getAnswersForInspection(data.inspectionId);
    const attachmentRows = SheetService.getAttachmentsForInspection(data.inspectionId, false);

    let workingDocId;
    let pdfFileId;
    let snapshotFileId;
    try {
      // Step 1: Copy template
      const templateFile = DriveApp.getFileById(Config.getTemplateDocId());
      const outputFolder = DriveService.getSubfolder(data.inspectionId, 'output');
      const workingDocName = `${data.inspectionId}_working`;
      const workingFile = templateFile.makeCopy(workingDocName, outputFolder);
      workingDocId = workingFile.getId();

      const doc = DocumentApp.openById(workingDocId);
      const body = doc.getBody();

      // Step 2: Replace simple placeholders
      _replaceSimpleText(body, '{{INSPECTION_ID}}', inspection.inspectionId);
      _replaceSimpleText(body, '{{INSPECTION_TYPE}}', _humanizeType(inspection.inspectionType));
      _replaceSimpleText(body, '{{DATE}}', _formatDate(inspection.createdAt));
      _replaceSimpleText(body, '{{PROPERTY_ADDRESS}}', inspection.propertyAddress);
      _replaceSimpleText(body, '{{PROPERTY_UNIT}}', inspection.propertyUnit || '-');
      _replaceSimpleText(body, '{{LANDLORD_NAME}}', inspection.landlordName);
      _replaceSimpleText(body, '{{LANDLORD_EMAIL}}', inspection.landlordEmail);
      _replaceSimpleText(body, '{{LANDLORD_PHONE}}', inspection.landlordPhone);
      _replaceSimpleText(body, '{{TENANT_NAME}}', inspection.tenantName);
      _replaceSimpleText(body, '{{TENANT_EMAIL}}', inspection.tenantEmail);
      _replaceSimpleText(body, '{{TENANT_PHONE}}', inspection.tenantPhone);
      _replaceSimpleText(body, '{{NOTES}}', inspection.notes || '-');
      _replaceSimpleText(body, '{{GENERATED_AT}}', _formatDate(Utils.nowIso(), true));

      // Step 3: Replace structured placeholders with rich content
      _replaceWithSections(body, '{{SECTIONS_PLACEHOLDER}}', schemaJson, answerRows);
      _replaceWithPhotos(body, '{{PHOTOS_PLACEHOLDER}}', attachmentRows, schemaJson);
      _replaceWithSignatures(body, '{{SIGNATURES_PLACEHOLDER}}', signatures);

      // Step 4: Save and export
      doc.saveAndClose();

      const docFile = DriveApp.getFileById(workingDocId);
      const pdfBlob = docFile.getAs('application/pdf');
      const pdfName = `${data.inspectionId}_final.pdf`;
      const pdfSaved = DriveService.saveOutputFile(data.inspectionId, pdfBlob, pdfName);
      pdfFileId = pdfSaved.fileId;

      // Step 5: JSON snapshot for archival
      const snapshot = {
        inspection,
        schema: schemaJson,
        answerRows,
        attachmentRows: attachmentRows.map(a => ({
          attachmentId: a.attachmentId,
          sectionId: a.sectionId,
          itemId: a.itemId,
          fileName: a.fileName,
          driveFileId: a.driveFileId,
        })),
        signatures,
        finalizedAt: Utils.nowIso(),
      };
      const snapshotName = `${data.inspectionId}_snapshot.json`;
      snapshotFileId = DriveService.saveJsonFile(
        data.inspectionId,
        JSON.stringify(snapshot, null, 2),
        snapshotName
      ).fileId;

      // Step 6: Trash working doc
      docFile.setTrashed(true);

    } catch (e) {
      // Clean up working doc if it exists
      if (workingDocId) {
        try { DriveApp.getFileById(workingDocId).setTrashed(true); } catch (_) {}
      }
      Utils.log('ERROR', 'PDF generation failed', { message: e.message, stack: e.stack });
      throw new HandoverError('PDF_GENERATION_FAILED', e.message);
    }

    // Update inspection record
    SheetService.updateInspection(data.inspectionId, {
      finalPdfFileId: pdfFileId,
      updatedAt: Utils.nowIso(),
    });
    AuditService.log(data.inspectionId, authCtx.actorString, 'pdf_generated', {
      pdfFileId,
      snapshotFileId,
    });

    return {
      status: 'signed',
      pdfFileId,
      pdfUrl: `https://drive.google.com/file/d/${pdfFileId}/view`,
      snapshotFileId,
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  function _replaceSimpleText(body, placeholder, value) {
    body.replaceText(_escapeRegex(placeholder), String(value || ''));
  }

  function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function _humanizeType(type) {
    const map = {
      'move_in': 'Move-in',
      'move_out': 'Move-out',
      'periodic': 'Periodic Inspection',
      'damage_report': 'Damage Report',
      'key_handover': 'Key Handover',
    };
    return map[type] || type;
  }

  function _formatDate(iso, withTime) {
    try {
      const d = new Date(iso);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      if (!withTime) return `${dd}.${mm}.${yyyy}`;
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
    } catch (e) {
      return String(iso);
    }
  }

  /**
   * Find a placeholder paragraph and replace with structured content
   * generated by `builder(insertAtIndex)`. Returns the new index after insertion.
   */
  function _replacePlaceholderWithBuilder(body, placeholder, builder) {
    const numChildren = body.getNumChildren();
    let placeholderIndex = -1;
    for (let i = 0; i < numChildren; i++) {
      const child = body.getChild(i);
      const text = child.getText ? child.getText() : '';
      if (text && text.indexOf(placeholder) >= 0) {
        placeholderIndex = i;
        break;
      }
    }
    if (placeholderIndex < 0) {
      Utils.log('WARN', `Placeholder not found: ${placeholder}`, {});
      return;
    }
    body.removeChild(body.getChild(placeholderIndex));
    builder(placeholderIndex);
  }

  // --- Sections ---

  function _replaceWithSections(body, placeholder, schemaJson, answerRows) {
    _replacePlaceholderWithBuilder(body, placeholder, function (insertAt) {
      // Build map: sectionId -> [{itemId, value, comment, schemaItem}]
      const sections = schemaJson.sections || [];
      const answersByItem = {};
      for (const a of answerRows) {
        const k = `${a.sectionId}__${a.itemId}`;
        answersByItem[k] = a;
      }

      let pos = insertAt;
      for (const section of sections) {
        // Section heading
        const heading = body.insertParagraph(pos++, section.title || section.id);
        heading.setHeading(DocumentApp.ParagraphHeading.HEADING2);

        // Items as a table: [Label | Answer | Comment]
        const items = (section.items || []).filter(it =>
          ValidationService.isItemVisible(it, ValidationService.buildAnswersMap(answerRows))
        );
        if (items.length === 0) {
          body.insertParagraph(pos++, '(No items)').setItalic(true);
          continue;
        }
        const tableData = [['Item', 'Answer', 'Comment']];
        for (const item of items) {
          const a = answersByItem[`${section.id}__${item.id}`];
          tableData.push([
            item.label || item.id,
            _formatAnswerValue(a, item),
            (a && a.comment) ? a.comment : '',
          ]);
        }
        const table = body.insertTable(pos++, tableData);
        // Style header row
        if (table.getNumRows() > 0) {
          const headerRow = table.getRow(0);
          for (let c = 0; c < headerRow.getNumCells(); c++) {
            headerRow.getCell(c).editAsText().setBold(true);
          }
        }
      }
    });
  }

  function _formatAnswerValue(answerRow, schemaItem) {
    if (!answerRow || answerRow.value === '' || answerRow.value === undefined) {
      return '—';
    }
    const v = answerRow.value;
    const type = schemaItem.type;

    if (type === 'checkbox') {
      return (v === 'true' || v === true) ? 'Yes' : 'No';
    }
    if (type === 'select' || type === 'radio') {
      // Try to resolve label from options
      const opts = schemaItem.options || [];
      const found = opts.find(o => o.value === v);
      return found ? found.label : String(v);
    }
    if (type === 'multiselect') {
      try {
        const arr = JSON.parse(v);
        if (Array.isArray(arr)) {
          const opts = schemaItem.options || [];
          return arr.map(val => {
            const found = opts.find(o => o.value === val);
            return found ? found.label : val;
          }).join(', ');
        }
      } catch (e) {}
      return String(v);
    }
    return String(v);
  }

  // --- Photos ---

  function _replaceWithPhotos(body, placeholder, attachmentRows, schemaJson) {
    _replacePlaceholderWithBuilder(body, placeholder, function (insertAt) {
      if (attachmentRows.length === 0) {
        body.insertParagraph(insertAt, '(No photos attached)').setItalic(true);
        return;
      }

      // Group by section
      const sectionTitles = {};
      for (const s of (schemaJson.sections || [])) sectionTitles[s.id] = s.title;

      const itemLabels = {};
      for (const s of (schemaJson.sections || [])) {
        for (const it of (s.items || [])) {
          itemLabels[`${s.id}__${it.id}`] = it.label;
        }
      }

      const grouped = {};
      for (const att of attachmentRows) {
        if (!grouped[att.sectionId]) grouped[att.sectionId] = {};
        if (!grouped[att.sectionId][att.itemId]) grouped[att.sectionId][att.itemId] = [];
        grouped[att.sectionId][att.itemId].push(att);
      }

      let pos = insertAt;
      const sectionIds = Object.keys(grouped);
      for (const sectionId of sectionIds) {
        const heading = body.insertParagraph(pos++, sectionTitles[sectionId] || sectionId);
        heading.setHeading(DocumentApp.ParagraphHeading.HEADING2);

        const itemIds = Object.keys(grouped[sectionId]);
        for (const itemId of itemIds) {
          const itemHeader = body.insertParagraph(
            pos++,
            itemLabels[`${sectionId}__${itemId}`] || itemId
          );
          itemHeader.setHeading(DocumentApp.ParagraphHeading.HEADING3);

          for (const att of grouped[sectionId][itemId]) {
            try {
              const blob = DriveService.getFileBlob(att.driveFileId);
              const para = body.insertParagraph(pos++, '');
              const img = para.appendInlineImage(blob);
              // Resize to fit page width (max ~400pt)
              const maxWidth = 400;
              if (img.getWidth() > maxWidth) {
                const ratio = maxWidth / img.getWidth();
                img.setWidth(maxWidth);
                img.setHeight(Math.floor(img.getHeight() * ratio));
              }
              if (att.caption) {
                const cap = body.insertParagraph(pos++, att.caption);
                cap.setItalic(true);
                cap.editAsText().setFontSize(9);
              }
            } catch (e) {
              Utils.log('WARN', `Failed to embed photo ${att.attachmentId}`, { error: e.message });
              body.insertParagraph(pos++, `[Could not embed photo: ${att.fileName}]`).setItalic(true);
            }
          }
        }
      }
    });
  }

  // --- Signatures ---

  function _replaceWithSignatures(body, placeholder, signatures) {
    _replacePlaceholderWithBuilder(body, placeholder, function (insertAt) {
      if (signatures.length === 0) {
        body.insertParagraph(insertAt, '(No signatures collected)').setItalic(true);
        return;
      }

      let pos = insertAt;
      // Two-column layout via table
      const tableData = [];
      for (const sig of signatures) {
        tableData.push([_humanizeRole(sig.signerRole), sig.signerName]);
        tableData.push(['Date', _formatDate(sig.signedAt, true)]);
        tableData.push(['Signature', '']);
        tableData.push(['', '']); // Spacer for image insertion
      }
      const table = body.insertTable(pos++, tableData);

      // Now insert signature images into the appropriate cells
      let rowOffset = 0;
      for (const sig of signatures) {
        // Bold the role label
        table.getRow(rowOffset).getCell(0).editAsText().setBold(true);
        // Insert image in the "Signature" row's second cell
        try {
          const imgRow = table.getRow(rowOffset + 2);
          const cell = imgRow.getCell(1);
          cell.clear();
          const blob = DriveService.getFileBlob(sig.signatureFileId);
          const img = cell.appendImage(blob);
          if (img.getWidth() > 200) {
            const ratio = 200 / img.getWidth();
            img.setWidth(200);
            img.setHeight(Math.floor(img.getHeight() * ratio));
          }
        } catch (e) {
          Utils.log('WARN', `Failed to embed signature ${sig.signatureId}`, { error: e.message });
        }
        rowOffset += 4;
      }
    });
  }

  function _humanizeRole(role) {
    const map = {
      'landlord': 'Landlord',
      'tenant': 'Tenant',
      'witness': 'Witness',
      'agent': 'Agent',
    };
    return map[role] || role;
  }

  return { finalizeInspection };
})();
