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
import { navigate } from './router.js';
import { readJson, writeJson, clearCaches, CACHE_KEYS } from './utils/store.js';

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
  clearCaches();
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
  writeJson(CACHE_KEYS.user, result.user);
  setAuth({ type: 'token', token: result.sessionToken });
  setState({
    authMode: 'user',
    user: result.user,
    authError: null,
  });

  // Signing in used to be two requests in a row, and the second one existed
  // only because the first did not answer it. The server sends the first page
  // of the list with the session now; putting it where the list screen already
  // looks means that screen opens without a request at all.
  //
  // Stamped as fetched now on purpose. It was built moments ago, by the request
  // that is still being handled — it is not a remembered list being trusted, it
  // is this list, arriving early.
  if (Array.isArray(result.inspections)) {
    writeJson(CACHE_KEYS.inspectionList, {
      rows: result.inspections,
      fetchedAt: Date.now(),
    });
  }
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
 * When the device holds both a session token and a remembered profile, this
 * returns without waiting for the network. Opening the app used to block on
 * me() before the router even started, and only then fetch the list — two
 * requests in series, four to six seconds of blank screen, every single time.
 *
 * Nothing is given away by trusting the stored profile. It decides what to
 * *draw*, never what is allowed: the server re-reads the role from the Users
 * sheet on every request, so an edited copy in localStorage buys a menu item
 * and a refusal. The session is verified in the background, and a token that
 * has been revoked lands the user back on the sign-in screen a second later.
 *
 * Returns 'user' or 'none'.
 */
export async function restoreSession() {
  const sessionToken = loadSessionToken();
  const remembered = readJson(CACHE_KEYS.user);

  if (sessionToken && remembered) {
    setAuth({ type: 'token', token: sessionToken });
    setState({ authMode: 'user', user: remembered });
    _verifyInBackground();
    return 'user';
  }

  if (sessionToken) {
    setAuth({ type: 'token', token: sessionToken });
    try {
      const me = await api.me();
      writeJson(CACHE_KEYS.user, me.user);
      setState({ authMode: 'user', user: me.user });
      return 'user';
    } catch (_) {
      // Expired or revoked. The device token below may still be good.
    }
  }

  if (await _refreshFromDevice()) return 'user';

  clearTokens();
  setAuth(null);
  setState({ authMode: 'none', user: null });
  return 'none';
}

/** Exchange the remembered-device token for a session. */
async function _refreshFromDevice() {
  const deviceToken = loadDeviceToken();
  if (!deviceToken) return false;
  try {
    const refreshed = await api.refreshSession(deviceToken);
    storeTokens({ sessionToken: refreshed.sessionToken, deviceToken });
    writeJson(CACHE_KEYS.user, refreshed.user);
    setAuth({ type: 'token', token: refreshed.sessionToken });
    setState({ authMode: 'user', user: refreshed.user });
    // This reply carries the first page of the list too — see applySession.
    if (Array.isArray(refreshed.inspections)) {
      writeJson(CACHE_KEYS.inspectionList, {
        rows: refreshed.inspections,
        fetchedAt: Date.now(),
      });
    }
    return true;
  } catch (_) {
    // Revoked device, disabled account, or a password change elsewhere.
    return false;
  }
}

/**
 * Confirm the session the app has already started using, and correct course if
 * it turns out to be dead.
 */
async function _verifyInBackground() {
  try {
    const me = await api.me();
    writeJson(CACHE_KEYS.user, me.user);
    // Role or name may have changed since this device last looked.
    setState({ user: me.user });
    return;
  } catch (_) {
    // Session gone. A remembered device can still produce a new one.
  }

  if (await _refreshFromDevice()) return;

  clearTokens();
  setAuth(null);
  setState({
    authMode: 'none',
    user: null,
    authError: 'Your session has ended. Please sign in again.',
  });
  navigate('/login', true);
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
