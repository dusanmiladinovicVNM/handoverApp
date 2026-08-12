/**
 * api.js
 * Wraps fetch calls to the Apps Script backend.
 *
 * IMPORTANT: Content-Type must be 'text/plain;charset=utf-8' to bypass
 * CORS preflight (Apps Script does not support OPTIONS).
 */

import {
  BACKEND_URL,
  API_TIMEOUT_DEFAULT,
  API_TIMEOUT_UPLOAD,
  API_TIMEOUT_FINALIZE,
  API_TIMEOUT_SIGN_IN,
} from './config.js';

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details || {};
  }
}

/**
 * Auth context. Set once at app startup.
 *  - For internal users: { type: 'google' } — server reads Session.getActiveUser().
 *  - For tenant: { type: 'token', token: '...' } — token is read from URL ?t= param.
 */
let _authContext = null;

export function setAuth(auth) {
  _authContext = auth;
}

export function getAuth() {
  return _authContext;
}

/**
 * Generic call with action + data. Returns parsed `data` field on success.
 * Throws ApiError on failure.
 */
async function call(action, data, timeoutMs) {
  if (!_authContext) {
    throw new ApiError('UNAUTHORIZED', 'No auth context set.');
  }
  return _send(action, data, timeoutMs, _authContext);
}

/**
 * Call one of the actions that run before a session exists — signing in,
 * setting a password, asking for a reset link, refreshing.
 *
 * These are listed in PUBLIC_ACTIONS on the server, which dispatches them
 * without resolving auth at all, so no auth block is sent.
 */
async function callPublic(action, data, timeoutMs) {
  return _send(action, data, timeoutMs, null);
}

async function _send(action, data, timeoutMs, auth) {
  if (!BACKEND_URL || BACKEND_URL.startsWith('PASTE_')) {
    throw new ApiError(
      'INTERNAL_ERROR',
      'Backend URL not configured. Edit frontend/js/config.js.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || API_TIMEOUT_DEFAULT);

  let response;
  try {
    response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, auth: auth, data: data || {} }),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new ApiError('NETWORK_TIMEOUT', `Request '${action}' timed out.`);
    }
    throw new ApiError('NETWORK_ERROR', e.message || 'Network request failed.');
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new ApiError(
      'HTTP_ERROR',
      `HTTP ${response.status}: ${response.statusText}`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (e) {
    throw new ApiError('INVALID_RESPONSE', 'Server returned non-JSON response.');
  }

  if (!body.ok) {
    const err = body.error || {};
    throw new ApiError(err.code || 'UNKNOWN', err.message || 'Unknown error', err.details);
  }
  return body.data;
}

// ============================================================
// API methods
// ============================================================

export const api = {
  // --- Sign-in (no session required) ---
  //
  // The three that derive a password hash get their own timeout: it is by far
  // the most expensive thing this backend does, and on the default they timed
  // out while succeeding. See API_TIMEOUT_SIGN_IN.
  //
  // requestPasswordReset and refreshSession derive nothing — the first sends a
  // link, the second verifies a token — so they stay on the default.
  login: (data) => callPublic('login', data, API_TIMEOUT_SIGN_IN),
  setPassword: (data) => callPublic('setPassword', data, API_TIMEOUT_SIGN_IN),
  requestPasswordReset: (email) => callPublic('requestPasswordReset', { email }),
  refreshSession: (deviceToken) => callPublic('refreshSession', { deviceToken }),

  // --- Own account ---
  me: () => call('me'),
  signOut: () => call('signOut'),
  // Two derivations: verifying the old password and hashing the new one.
  changePassword: (oldPassword, newPassword) =>
    call('changePassword', { oldPassword, newPassword }, API_TIMEOUT_SIGN_IN),

  // --- Account administration ---
  listUsers: () => call('listUsers'),
  createUser: (name, email, role, notes) =>
    call('createUser', { name, email, role, notes }),
  setUserStatus: (userId, status) => call('setUserStatus', { userId, status }),
  setUserRole: (userId, role) => call('setUserRole', { userId, role }),
  unlockUser: (userId) => call('unlockUser', { userId }),
  sendPasswordLink: (userId) => call('sendPasswordLink', { userId }),
  listUserDevices: (userId) => call('listUserDevices', { userId }),
  revokeDevice: (deviceId) => call('revokeDevice', { deviceId }),
  revokeAllDevices: (userId) => call('revokeAllDevices', { userId }),
  getAuthLog: (userId, limit) => call('getAuthLog', { userId, limit }),
  assignInspection: (inspectionId, assignedTo) =>
    call('assignInspection', { inspectionId, assignedTo }),

  // --- Schemas ---
  getSchemas: () => call('getSchemas'),
  // Schemas plus the assignable-user list in one round trip; see the note
  // on pageAdminNew's load().
  getNewInspectionOptions: () => call('getNewInspectionOptions'),
  getSchema: (schemaId) => call('getSchema', { schemaId }),

  // --- Inspections ---
  createInspection: (data) => call('createInspection', data),
  getInspection: (inspectionId) => call('getInspection', { inspectionId }),
  // expectedRevision is what the editor read when it opened the section. The
  // server refuses the write if the section moved on in the meantime, rather
  // than overwriting whatever the other editor put there.
  saveSection: (inspectionId, sectionId, items, expectedRevision) =>
    call('saveSection', { inspectionId, sectionId, items, expectedRevision }),
  lockInspection: (inspectionId) => call('lockInspection', { inspectionId }),
  unlockInspection: (inspectionId, reason) =>
    call('unlockInspection', { inspectionId, reason }),
  regenerateTenantToken: (inspectionId, ttlHours) =>
    call('regenerateTenantToken', { inspectionId, ttlHours }),
  listInspections: (filter, page, pageSize, sortBy, sortOrder) =>
    call('listInspections', { filter, page, pageSize, sortBy, sortOrder }),

  // --- Attachments ---
  uploadAttachment: (data) => call('uploadAttachment', data, API_TIMEOUT_UPLOAD),
  deleteAttachment: (inspectionId, attachmentId) =>
    call('deleteAttachment', { inspectionId, attachmentId }),

  // --- Signatures ---
  saveSignature: (data) => call('saveSignature', data, API_TIMEOUT_UPLOAD),

  // --- Finalize ---
  finalizeInspection: (inspectionId) =>
    call('finalizeInspection', { inspectionId }, API_TIMEOUT_FINALIZE),

  // --- Audit ---
  getAuditLog: (inspectionId) => call('getAuditLog', { inspectionId }),
};

export { ApiError };

