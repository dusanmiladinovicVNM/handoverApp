/**
 * validator.js
 * Client-side mirror of ValidationService.gs.
 * Used for live UI feedback (greyed-out items, progress bars, lock-readiness).
 * Server is still source of truth — never trust client-only validation.
 */

/** Build a flat itemId -> value map from the nested answers state. */
export function buildAnswersMap(answers) {
  const map = {};
  for (const sectionId of Object.keys(answers || {})) {
    for (const itemId of Object.keys(answers[sectionId] || {})) {
      map[itemId] = (answers[sectionId][itemId] || {}).value;
    }
  }
  return map;
}

export function evaluateCondition(condition, answersMap) {
  if (!condition) return true;
  if (condition.all && Array.isArray(condition.all)) {
    return condition.all.every((c) => evaluateCondition(c, answersMap));
  }
  if (condition.any && Array.isArray(condition.any)) {
    return condition.any.some((c) => evaluateCondition(c, answersMap));
  }
  const v = answersMap[condition.field];
  switch (condition.operator) {
    case 'equals':    return v === condition.value;
    case 'notEquals': return v !== condition.value;
    case 'in':        return Array.isArray(condition.value) && condition.value.indexOf(v) >= 0;
    case 'notIn':     return Array.isArray(condition.value) && condition.value.indexOf(v) < 0;
    case 'truthy':    return !!v && v !== '' && v !== '0' && v !== 'false';
    case 'falsy':     return !v || v === '' || v === '0' || v === 'false';
    default: return true;
  }
}

export function isItemVisible(item, answersMap) {
  return evaluateCondition(item.visibleWhen, answersMap);
}

export function isItemRequired(item, answersMap) {
  if (item.required === true) return true;
  if (item.requiredWhen) return evaluateCondition(item.requiredWhen, answersMap);
  return false;
}

function _isAnswered(value, type) {
  if (value === undefined || value === null) return false;
  if (type === 'checkbox') return value === true || value === 'true' || value === 'TRUE';
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return !isNaN(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Compute progress for a section: { totalRequired, completedRequired, totalVisible, completedVisible }
 */
export function sectionProgress(section, answers) {
  const map = buildAnswersMap(answers);
  const sectionAnswers = answers[section.id] || {};
  let totalRequired = 0, completedRequired = 0;
  let totalVisible = 0, completedVisible = 0;
  let missingRequired = [];

  for (const item of (section.items || [])) {
    if (!isItemVisible(item, map)) continue;
    totalVisible++;
    const a = sectionAnswers[item.id];
    const value = a ? a.value : undefined;
    const answered = _isAnswered(value, item.type);

    let attachmentsOk = true;
    if (item.attachments && item.attachments.min) {
      const cnt = a ? Number(a.attachmentCount || 0) : 0;
      if (cnt < item.attachments.min) attachmentsOk = false;
    }

    if (answered && attachmentsOk) completedVisible++;

    if (isItemRequired(item, map)) {
      totalRequired++;
      if (answered && attachmentsOk) {
        completedRequired++;
      } else {
        missingRequired.push({
          itemId: item.id,
          label: item.label,
          reason: !answered ? 'no_value' : 'insufficient_attachments',
        });
      }
    }
  }

  return { totalRequired, completedRequired, totalVisible, completedVisible, missingRequired };
}

/** Aggregate progress across all sections. */
export function inspectionProgress(schema, answers) {
  let totalReq = 0, completedReq = 0;
  let totalVis = 0, completedVis = 0;
  for (const section of (schema.sections || [])) {
    const p = sectionProgress(section, answers);
    totalReq += p.totalRequired;
    completedReq += p.completedRequired;
    totalVis += p.totalVisible;
    completedVis += p.completedVisible;
  }
  return {
    totalRequired: totalReq,
    completedRequired: completedReq,
    totalVisible: totalVis,
    completedVisible: completedVis,
    isReadyForLock: totalReq > 0 && completedReq === totalReq,
  };
}

export function findAllMissingRequired(schema, answers) {
  const missing = [];
  for (const section of (schema.sections || [])) {
    const p = sectionProgress(section, answers);
    for (const m of p.missingRequired) {
      missing.push({ sectionId: section.id, sectionTitle: section.title, ...m });
    }
  }
  return missing;
}
