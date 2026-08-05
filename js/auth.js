/**
 * auth.js
 * Credential storage and the sign-in calls that use it.
 *
 * Two tokens live on the device:
 *  - session, short-lived, sent with every request
 *  - device, long-lived, only ever exchanged for a fresh session
 *
 * A device token is stored only when the user asked to be remembered. Without
 * it, closing the session means signing in again — which is the point.
 */

import { setAuth, api } from './api.js';
import { setState } from './state.js';

const SESSION_KEY = 'handover.sessionToken';
const DEVICE_KEY = 'handover.deviceToken';

// Written by the pre-accounts build. Never read any more — the server refuses
// tokens of that shape — but still cleared, so a stale credential does not sit
// in localStorage on every device that ever ran the old version.
const RETIRED_KEYS = ['handover.adminToken', 'handover.adminLabel'];

// --- Storage ---
// Every access is wrapped: private browsing and a full quota both make
// localStorage throw, and neither is a reason to break the whole app.

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {}
}

export const loadSessionToken = () => read(SESSION_KEY);
export const loadDeviceToken = () => read(DEVICE_KEY);

export function storeTokens({ sessionToken, deviceToken }) {
  write(SESSION_KEY, sessionToken || '');
  // Absent deviceToken means "not remembered", so clear any earlier one rather
  // than leaving a stale token that would silently keep this device signed in.
  write(DEVICE_KEY, deviceToken || '');
}

export function clearTokens() {
  write(SESSION_KEY, '');
  write(DEVICE_KEY, '');
  RETIRED_KEYS.forEach(key => write(key, ''));
}

// --- Naming this device ---

/**
 * A guess at something the owner will recognise in the device list. Crude by
 * design — it only has to be better than "Unnamed device", and the user can
 * edit it on the sign-in form.
 */
export function suggestDeviceLabel() {
  const ua = navigator.userAgent || '';
  const platform =
    /iPhone/i.test(ua) ? 'iPhone' :
    /iPad/i.test(ua) ? 'iPad' :
    /Android/i.test(ua) ? 'Android' :
    /Macintosh/i.test(ua) ? 'Mac' :
    /Windows/i.test(ua) ? 'Windows' :
    /Linux/i.test(ua) ? 'Linux' : 'Device';
  const browser =
    /Edg\//i.test(ua) ? 'Edge' :
    /OPR\//i.test(ua) ? 'Opera' :
    /Chrome\//i.test(ua) ? 'Chrome' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Safari\//i.test(ua) ? 'Safari' : '';
  return browser ? `${platform} ${browser}` : platform;
}

// --- Applying a signed-in result ---

function applySession(result) {
  storeTokens(result);
  setAuth({ type: 'token', token: result.sessionToken });
  setState({
    authMode: 'user',
    user: result.user,
    authError: null,
  });
  return result.user;
}

// --- Sign-in flows ---

export async function login({ email, password, remember, deviceLabel }) {
  const result = await api.login({
    email,
    password,
    remember: !!remember,
    deviceLabel: deviceLabel || suggestDeviceLabel(),
    userAgent: navigator.userAgent || '',
  });
  return applySession(result);
}

export async function setPassword({ token, password, remember, deviceLabel }) {
  const result = await api.setPassword({
    token,
    password,
    remember: !!remember,
    deviceLabel: deviceLabel || suggestDeviceLabel(),
    userAgent: navigator.userAgent || '',
  });
  return applySession(result);
}

/**
 * Restore a signed-in state at boot.
 *
 * The session token is tried first because it costs one call and usually
 * works; the device token is the fallback that avoids asking for a password
 * every twelve hours.
 *
 * Returns 'user' or 'none'.
 */
export async function restoreSession() {
  const sessionToken = loadSessionToken();
  if (sessionToken) {
    setAuth({ type: 'token', token: sessionToken });
    try {
      const me = await api.me();
      setState({ authMode: 'user', user: me.user });
      return 'user';
    } catch (_) {
      // Expired or revoked. The device token below may still be good.
    }
  }

  const deviceToken = loadDeviceToken();
  if (deviceToken) {
    try {
      const refreshed = await api.refreshSession(deviceToken);
      storeTokens({ sessionToken: refreshed.sessionToken, deviceToken });
      setAuth({ type: 'token', token: refreshed.sessionToken });
      setState({ authMode: 'user', user: refreshed.user });
      return 'user';
    } catch (_) {
      // Revoked device, disabled account, or a password change elsewhere.
    }
  }

  clearTokens();
  setAuth(null);
  setState({ authMode: 'none', user: null });
  return 'none';
}

export async function signOut() {
  try {
    await api.signOut();
  } catch (_) {
    // The device may already be revoked, or the network may be down. Either
    // way the local tokens go — a sign-out that fails silently and leaves the
    // user signed in is worse than one that cannot reach the server.
  }
  clearTokens();
  setAuth(null);
  setState({ authMode: 'none', user: null, authError: null });
}
