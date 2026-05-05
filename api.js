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
      body: JSON.stringify({ action, auth: _authContext, data: data || {} }),
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
  // --- Schemas ---
  getSchemas: () => call('getSchemas'),
  getSchema: (schemaId) => call('getSchema', { schemaId }),

  // --- Inspections ---
  createInspection: (data) => call('createInspection', data),
  getInspection: (inspectionId) => call('getInspection', { inspectionId }),
  saveSection: (inspectionId, sectionId, items) =>
    call('saveSection', { inspectionId, sectionId, items }),
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
