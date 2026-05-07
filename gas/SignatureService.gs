/**
 * SignatureService.gs
 * Signature collection. Handles role-based access and status transitions.
 */

const SignatureService = (function () {

  function saveSignature(authCtx, data) {
    Utils.requireField(data, 'inspectionId', 'string');
    Utils.requireField(data, 'signerRole', 'string');
    Utils.requireField(data, 'signerName', 'string');
    Utils.requireField(data, 'accepted', 'boolean');
    Utils.requireField(data, 'base64Png', 'string');

    AuthService.requireMatchingInspection(authCtx, data.inspectionId);
    AuthService.requireMatchingRole(authCtx, data.signerRole);

    if (!data.accepted) {
      throw new HandoverError('VALIDATION_FAILED', 'Signer must accept terms before signing.');
    }
    if (!data.signerName.trim()) {
      throw new HandoverError('VALIDATION_FAILED', 'Signer name cannot be empty.');
    }

    const inspection = SheetService.getInspection(data.inspectionId);
    if (!inspection) throw new HandoverError('NOT_FOUND', 'Inspection not found.');

    if (inspection.status !== 'locked_for_signature' && inspection.status !== 'partially_signed') {
      throw new HandoverError('VALIDATION_FAILED',
        `Cannot sign: inspection must be locked_for_signature or partially_signed, got '${inspection.status}'.`);
    }

    const allowedRoles = ['landlord', 'tenant', 'witness', 'agent'];
    if (allowedRoles.indexOf(data.signerRole) < 0) {
      throw new HandoverError('VALIDATION_FAILED', `Invalid signer role: ${data.signerRole}.`);
    }

    // Invalidate any prior valid signature from same role (re-signing replaces)
    const existing = SheetService.getSignaturesForInspection(data.inspectionId, true)
      .filter(s => s.signerRole === data.signerRole);
    if (existing.length > 0) {
      SheetService.invalidateSignatures(data.inspectionId);
      // Note: this invalidates ALL signatures, not just same role.
      // For MVP this is acceptable — if landlord re-signs, tenant must too.
      // Document this behavior in user-facing UX if needed.
    }

    // Save PNG to Drive
    let saved;
    try {
      saved = DriveService.saveSignaturePng(data.inspectionId, data.signerRole, data.base64Png);
    } catch (e) {
      throw new HandoverError('UPLOAD_FAILED', 'Failed to save signature image.', { detail: e.message });
    }

    const signatureId = Utils.generateSignatureId();
    const now = Utils.nowIso();

    SheetService.createSignature({
      signatureId,
      inspectionId: data.inspectionId,
      signerRole: data.signerRole,
      signerName: data.signerName.trim(),
      accepted: true,
      signatureFileId: saved.fileId,
      signedAt: now,
      ipAddress: '', // Apps Script does not expose this reliably
      userAgent: data.userAgent || '',
      nonce: inspection.currentNonce,
      valid: true,
    });

    AuditService.log(data.inspectionId, authCtx.actorString, 'signature_saved', {
      signatureId,
      signerRole: data.signerRole,
      signerName: data.signerName,
    });

    // Determine new status
    const validSignatures = SheetService.getSignaturesForInspection(data.inspectionId, true);
    const collectedRoles = validSignatures.map(s => s.signerRole);
    const requiredRoles = ['landlord', 'tenant'];
    const allCollected = requiredRoles.every(r => collectedRoles.indexOf(r) >= 0);

    let newStatus;
    if (allCollected) {
      newStatus = 'signed';
      SheetService.updateInspection(data.inspectionId, {
        status: 'signed',
        signedAt: now,
        updatedAt: now,
      });
    } else {
      newStatus = 'partially_signed';
      SheetService.updateInspection(data.inspectionId, {
        status: 'partially_signed',
        updatedAt: now,
      });
    }

    return {
      signatureId,
      signatureFileId: saved.fileId,
      signedAt: now,
      allRequiredSignaturesCollected: allCollected,
      newStatus,
    };
  }

  return { saveSignature };
})();
