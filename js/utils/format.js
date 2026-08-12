/**
 * utils/format.js
 * Formatting helpers (dates, statuses, etc).
 *
 * The date format is the same in both languages — dd.mm.yyyy is what Swiss
 * German writes and what this app has always shown — so only the words are
 * translated, and they are looked up per call rather than captured in a table,
 * because the language can change while the app is open.
 */

import { t } from '../i18n.js';

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

const STATUS_BADGE_CLASS = {
  draft: 'badge--draft',
  under_review: 'badge--review',
  locked_for_signature: 'badge--locked',
  partially_signed: 'badge--partial',
  signed: 'badge--signed',
  archived: 'badge--archived',
  cancelled: 'badge--cancelled',
};

/**
 * A status the app does not know is shown as the server named it, rather than
 * as a missing translation. Same for the type below.
 */
export function statusLabel(status) {
  const key = 'status.' + status;
  const label = t(key);
  return label === key ? status : label;
}

export function statusBadgeClass(status) {
  return STATUS_BADGE_CLASS[status] || 'badge--draft';
}

export function inspectionTypeLabel(type) {
  const key = 'type.' + type;
  const label = t(key);
  return label === key ? type : label;
}
