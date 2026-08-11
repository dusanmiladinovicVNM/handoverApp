/**
 * state.js
 * Tiny pub/sub store for app-wide state.
 * Not a framework — just a way to keep auth, current inspection, and session
 * state in one place and notify when it changes.
 */

const _state = {
  // Auth resolution at boot:
  //   'unknown'  — not yet checked
  //   'user'     — signed in with an account
  //   'tenant'   — tenant token from URL ?t=, verified
  //   'none'     — not signed in (show the sign-in screen)
  authMode: 'unknown',
  authError: null,

  // The signed-in account: { userId, email, name, role, status, ... }
  // Role lives here rather than in the token, and the server re-reads it on
  // every request — so this copy is for rendering only. Never treat it as the
  // thing that grants permission.
  user: null,

  tenantToken: null,
  tenantInspectionId: null,

  // Currently loaded inspection (null when not on inspection page)
  inspection: null,
  schema: null,
  answers: {},
  // Per section, the revision the server had when this data was fetched. Sent
  // back on save so a concurrent edit is refused rather than silently lost.
  revisions: {},
  attachments: [],
  signatures: [],

  // Per-section dirty/saving state
  saveStatus: 'idle', // 'idle' | 'saving' | 'saved' | 'error'
  saveError: null,
};

const _listeners = new Set();

export function getState() {
  return _state;
}

export function setState(patch) {
  Object.assign(_state, patch);
  for (const fn of _listeners) {
    try { fn(_state); } catch (e) { console.error('state listener error', e); }
  }
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Convenience for rendering. Authorization itself is decided on the server. */
export function isAdmin() {
  return !!(_state.user && _state.user.role === 'admin');
}

/**
 * Replace inspection-related state at once when loading a new inspection.
 */
export function setInspectionData(payload) {
  setState({
    inspection: payload.inspection,
    schema: payload.schema,
    answers: payload.answers || {},
    revisions: payload.revisions || {},
    attachments: payload.attachments || [],
    signatures: payload.signatures || [],
    saveStatus: 'idle',
    saveError: null,
  });
}

/**
 * Local update: merge new answers into state without round-trip.
 * Used by autosave optimistic update.
 */
/** Record the revision the server returned, so the next save is not stale. */
export function setSectionRevision(sectionId, revision) {
  const revisions = { ..._state.revisions };
  revisions[sectionId] = revision;
  setState({ revisions });
}

export function patchAnswer(sectionId, itemId, patch) {
  const answers = { ..._state.answers };
  if (!answers[sectionId]) answers[sectionId] = {};
  answers[sectionId] = { ...answers[sectionId] };
  answers[sectionId][itemId] = { ...(answers[sectionId][itemId] || {}), ...patch };
  setState({ answers });
}

export function addAttachmentLocally(att) {
  const attachments = [..._state.attachments, att];
  setState({ attachments });
  // Bump count on the answer row in local state
  const cur = (_state.answers[att.sectionId] || {})[att.itemId] || {};
  patchAnswer(att.sectionId, att.itemId, {
    attachmentCount: (cur.attachmentCount || 0) + 1,
  });
}

export function removeAttachmentLocally(attachmentId) {
  const att = _state.attachments.find(a => a.attachmentId === attachmentId);
  if (!att) return;
  const attachments = _state.attachments.filter(a => a.attachmentId !== attachmentId);
  setState({ attachments });
  const cur = (_state.answers[att.sectionId] || {})[att.itemId] || {};
  patchAnswer(att.sectionId, att.itemId, {
    attachmentCount: Math.max(0, (cur.attachmentCount || 1) - 1),
  });
}
