/**
 * ValidationService.gs
 * Conditional logic evaluation and validation rules for state transitions.
 */

const ValidationService = (function () {

  // --- Conditional logic engine ---

  /**
   * Evaluate a single condition against an answers map.
   * Condition format: { field, operator, value } or { all: [...] } or { any: [...] }
   * Answers map: { itemId: value }
   */
  function evaluateCondition(condition, answersByItemId) {
    if (!condition) return true;

    if (condition.all && Array.isArray(condition.all)) {
      return condition.all.every(c => evaluateCondition(c, answersByItemId));
    }
    if (condition.any && Array.isArray(condition.any)) {
      return condition.any.some(c => evaluateCondition(c, answersByItemId));
    }

    const fieldValue = answersByItemId[condition.field];
    const op = condition.operator;
    const target = condition.value;

    switch (op) {
      case 'equals': return fieldValue === target;
      case 'notEquals': return fieldValue !== target;
      case 'in': return Array.isArray(target) && target.indexOf(fieldValue) >= 0;
      case 'notIn': return Array.isArray(target) && target.indexOf(fieldValue) < 0;
      case 'truthy': return !!fieldValue && fieldValue !== '' && fieldValue !== '0';
      case 'falsy': return !fieldValue || fieldValue === '' || fieldValue === '0';
      default: return true;
    }
  }

  function isItemVisible(item, answersByItemId) {
    return evaluateCondition(item.visibleWhen, answersByItemId);
  }

  function isItemRequired(item, answersByItemId) {
    if (item.required === true) return true;
    if (item.requiredWhen) {
      return evaluateCondition(item.requiredWhen, answersByItemId);
    }
    return false;
  }

  // --- Build flat answers map from sheet rows ---

  function buildAnswersMap(answerRows) {
    const map = {};
    for (let i = 0; i < answerRows.length; i++) {
      map[answerRows[i].itemId] = answerRows[i].value;
    }
    return map;
  }

  // --- Validate that a value satisfies an item's constraints ---

  function _isAnswered(value, valueType) {
    if (value === undefined || value === null) return false;
    if (valueType === 'checkbox') return value === true || value === 'true' || value === 'TRUE';
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return !isNaN(value);
    return true;
  }

  /**
   * Returns array of missing required items.
   * Each entry: { sectionId, itemId, label, reason }
   */
  function findMissingRequiredItems(schemaJson, answerRows) {
    const answersByItemId = buildAnswersMap(answerRows);
    const missing = [];

    for (const section of (schemaJson.sections || [])) {
      for (const item of (section.items || [])) {
        if (!isItemVisible(item, answersByItemId)) continue;
        if (!isItemRequired(item, answersByItemId)) continue;

        // Find the answer row for this item
        const answerRow = answerRows.find(a =>
          a.sectionId === section.id && a.itemId === item.id
        );

        const value = answerRow ? answerRow.value : undefined;
        if (!_isAnswered(value, item.type)) {
          missing.push({
            sectionId: section.id,
            itemId: item.id,
            label: item.label,
            reason: 'no_value',
          });
          continue;
        }

        // Attachments min check
        if (item.attachments && item.attachments.min && item.attachments.min > 0) {
          const count = answerRow ? Number(answerRow.attachmentCount || 0) : 0;
          if (count < item.attachments.min) {
            missing.push({
              sectionId: section.id,
              itemId: item.id,
              label: item.label,
              reason: 'insufficient_attachments',
              required: item.attachments.min,
              actual: count,
            });
          }
        }
      }
    }

    return missing;
  }

  // --- State transition rules ---

  /**
   * The only statuses in which an inspection's content may change.
   *
   * The list used to be written out by hand at each place that needed it —
   * saveSection, uploadAttachment, deleteAttachment — and the three copies
   * drifted. Deleting a photo checked only 'signed' and 'archived', so a
   * photograph could be removed from an inspection that was locked for
   * signature, and even from one a party had already signed. For a document
   * whose only purpose is to be evidence in a dispute, that is the one thing
   * that must not be possible.
   *
   * This is an allowlist, and the distinction is the whole point. Written the
   * other way round — a list of frozen statuses, refuse if it matches — the
   * answer to anything it had not heard of was yes: a status misspelt in the
   * sheet, an empty cell, a status added to the app later, or an inspection
   * row that no longer exists. Every one of those let content through.
   *
   * A denylist is a reasonable default when the cost of a wrong answer is an
   * inconvenience. Here the cost is a signed document that no longer says what
   * was signed, so the unknown case has to close rather than open.
   *
   * Reopening a locked inspection goes through unlockInspection, which
   * invalidates the signatures and rotates the tenant nonce — deliberately,
   * visibly, and in the audit log.
   */
  const CONTENT_EDITABLE = ['draft', 'under_review'];

  /** The statuses unlockInspection will actually accept. */
  const UNLOCKABLE = ['locked_for_signature', 'partially_signed'];

  function isContentEditable(inspection) {
    return !!inspection && CONTENT_EDITABLE.indexOf(inspection.status) >= 0;
  }

  /**
   * @param verb  what the caller was trying to do, for the message
   */
  function assertContentEditable(inspection, verb) {
    // Not every caller checks this before asking, and the one that did not was
    // deleting attachments: a missing row used to stop it only by throwing on
    // a property access.
    if (!inspection) {
      throw new HandoverError('NOT_FOUND', 'Inspection not found.');
    }
    if (isContentEditable(inspection)) return;

    // "Unlock it first" is only true where unlockInspection would agree. For a
    // signed, archived or cancelled inspection it is advice that leads
    // straight to a second refusal.
    const canUnlock = UNLOCKABLE.indexOf(inspection.status) >= 0;
    throw new HandoverError('INSPECTION_LOCKED',
      `Cannot ${verb}: inspection is in status '${inspection.status}'. ` +
      (canUnlock
        ? 'Unlock it first, which invalidates any signatures already collected.'
        : 'It is no longer open for editing.'));
  }

  /**
   * Check whether transitioning to lock_for_signature is allowed.
   * Throws VALIDATION_FAILED with details if not.
   */
  function validateForLock(inspection, schemaJson, answerRows) {
    if (inspection.status === 'locked_for_signature' ||
        inspection.status === 'partially_signed' ||
        inspection.status === 'signed') {
      throw new HandoverError('INSPECTION_LOCKED',
        `Inspection is already in status '${inspection.status}'.`);
    }
    const missing = findMissingRequiredItems(schemaJson, answerRows);
    if (missing.length > 0) {
      throw new HandoverError('VALIDATION_FAILED',
        'Some required items are missing answers.',
        { missingItems: missing });
    }
  }

  /**
   * Check whether transitioning to finalize (PDF generation) is allowed.
   * Requires all signatures collected.
   */
  function validateForFinalize(inspection, signatures) {
    if (inspection.status !== 'partially_signed' && inspection.status !== 'signed') {
      // We allow finalize from 'signed' for re-finalization (regenerate PDF)
      throw new HandoverError('VALIDATION_FAILED',
        `Cannot finalize from status '${inspection.status}'. Must be 'signed'.`);
    }
    const validSignatures = signatures.filter(s => s.valid === true);
    const requiredRoles = ['landlord', 'tenant'];
    const collectedRoles = validSignatures.map(s => s.signerRole);
    const missingRoles = requiredRoles.filter(r => collectedRoles.indexOf(r) < 0);
    if (missingRoles.length > 0) {
      throw new HandoverError('VALIDATION_FAILED',
        `Missing signatures: ${missingRoles.join(', ')}.`,
        { missingSignatures: missingRoles });
    }
  }

  /**
   * Allowed status transitions. Used to prevent invalid state changes.
   */
  function canTransition(fromStatus, toStatus) {
    const allowed = {
      'draft':                  ['under_review', 'locked_for_signature', 'cancelled'],
      'under_review':           ['draft', 'locked_for_signature', 'cancelled'],
      'locked_for_signature':   ['draft', 'partially_signed', 'signed'],
      'partially_signed':       ['draft', 'signed'],
      'signed':                 ['draft', 'archived'],
      'archived':               [],
      'cancelled':              [],
    };
    return (allowed[fromStatus] || []).indexOf(toStatus) >= 0;
  }

  return {
    evaluateCondition,
    isItemVisible,
    isItemRequired,
    buildAnswersMap,
    findMissingRequiredItems,
    CONTENT_EDITABLE,
    isContentEditable,
    assertContentEditable,
    validateForLock,
    validateForFinalize,
    canTransition,
  };
})();
