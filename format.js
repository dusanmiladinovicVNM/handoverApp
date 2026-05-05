/**
 * utils/format.js
 * Formatting helpers (dates, statuses, etc).
 */

export function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  } catch (_) {
    return String(iso);
  }
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const date = formatDate(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${date} ${hh}:${min}`;
  } catch (_) {
    return String(iso);
  }
}

const STATUS_LABELS = {
  draft: 'Draft',
  under_review: 'Under Review',
  locked_for_signature: 'Awaiting Signature',
  partially_signed: 'Partially Signed',
  signed: 'Signed',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

const STATUS_BADGE_CLASS = {
  draft: 'badge--draft',
  under_review: 'badge--review',
  locked_for_signature: 'badge--locked',
  partially_signed: 'badge--partial',
  signed: 'badge--signed',
  archived: 'badge--archived',
  cancelled: 'badge--cancelled',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function statusBadgeClass(status) {
  return STATUS_BADGE_CLASS[status] || 'badge--draft';
}

const TYPE_LABELS = {
  move_in: 'Move-in',
  move_out: 'Move-out',
  periodic: 'Periodic',
  damage_report: 'Damage Report',
  key_handover: 'Key Handover',
};

export function inspectionTypeLabel(type) {
  return TYPE_LABELS[type] || type;
}
