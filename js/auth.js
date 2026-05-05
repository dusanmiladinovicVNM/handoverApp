/**
 * auth.js
 * Admin token persistence and validation helpers.
 * Extracted from app.js so pages.js can import without circular dependency.
 */

import { setAuth, api } from './api.js';
import { setState } from './state.js';

const ADMIN_TOKEN_STORAGE_KEY = 'handover.adminToken';
const ADMIN_LABEL_STORAGE_KEY = 'handover.adminLabel';

export function saveAdminToken(token, label) {
  try {
    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    if (label) localStorage.setItem(ADMIN_LABEL_STORAGE_KEY, label);
  } catch (_) {}
}

export function loadAdminToken() {
  try {
    return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

export function loadAdminLabel() {
  try {
    return localStorage.getItem(ADMIN_LABEL_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

export function clearAdminToken() {
  try {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    localStorage.removeItem(ADMIN_LABEL_STORAGE_KEY);
  } catch (_) {}
}

/**
 * Validate a candidate admin token by calling getSchemas().
 * Returns true and stores the token on success.
 */
export async function tryAdminToken(token) {
  setAuth({ type: 'token', token });
  try {
    await api.getSchemas();
    saveAdminToken(token);
    setState({
      authMode: 'admin',
      adminToken: token,
      adminLabel: loadAdminLabel(),
      authError: null,
    });
    return true;
  } catch (e) {
    setAuth(null);
    return false;
  }
}
