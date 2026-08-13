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

import { setAuth, api, ApiError } from './api.js';
import { setState } from './state.js';
import { navigate } from './router.js';
import { readJson, writeJson, clearCaches, CACHE_KEYS } from './utils/store.js';

const SESSION_KEY = 'handover.sessionToken';
const DEVICE_KEY = 'handover.deviceToken';

/**
 * Why the last boot ended where it did.
 *
 * Not a credential and not personal, so it survives clearTokens — the whole
 * point is to still be there on the screen that asks for a password. A phone is
 * where this goes wrong and a phone has no console: an iPhone signing in four
 * times in eighty seconds looks identical from the outside whether the device
 * token was thrown away, refused, or never stored at all, and those want three
 * different fixes.
 */
const RESTORE_KEY = 'handover.lastRestore';

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

// --- Why the app is asking for a password ---

/**
 * Did the server refuse this credential, or did we simply not reach it?
 *
 * api.js already tells these apart — UNAUTHORIZED comes from the server,
 * NETWORK_ERROR and NETWORK_TIMEOUT come from the fetch that never arrived —
 * and everything below turns on the difference. A refusal means the token is
 * dead. A network failure means nothing at all about the token, and a device
 * token is the one credential that survives an expired session: throwing it
 * away because a request timed out is the difference between opening the app
 * and signing in again.
 *
 * Written as an allowlist of refusals rather than a list of network codes, so
 * an unrecognised failure keeps the credential rather than destroying it.
 */
function isRefusal(e) {
  return e instanceof ApiError && (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN');
}

/**
 * `held` is read at the start of the boot rather than here, because half of
 * what this has to distinguish is "there was nothing in storage to begin with"
 * — and by the time an outcome is known the tokens may already be gone.
 */
function noteRestore(outcome, held, detail) {
  writeJson(RESTORE_KEY, {
    outcome: outcome,
    detail: detail || '',
    at: new Date().toISOString(),
    hadSession: !!(held && held.session),
    hadDevice: !!(held && held.device),
  });
}

/** What the last boot recorded, for the sign-in screen to explain itself. */
export function readLastRestore() {
  return readJson(RESTORE_KEY);
}

/**
 * Can this browser keep anything at all?
 *
 * Asked directly rather than inferred from history, because a device that
 * cannot write also cannot write down that it could not write — the record
 * above is missing in exactly the case it would be most wanted. Private
 * browsing throws on setItem, a full quota throws, and a store that silently
 * drops the value fails the read-back.
 */
export function storageUsable() {
  const probe = 'handover.probe';
  try {
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    return ok;
  } catch (_) {
    return false;
  }
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

  // Read straight back, and record what came out. localStorage can accept a
  // write and lose it — private browsing and a full quota both throw, and an
  // iOS storage container the system evicts later looks identical at write
  // time. Checking here is what separates "the app forgot" from "the app was
  // never able to remember": if the device token is missing one line after
  // being written, no amount of work on the restore path will help.
  noteRestore(
    'signed_in',
    { session: loadSessionToken(), device: loadDeviceToken() },
    result.deviceToken && !loadDeviceToken() ? 'device_token_did_not_persist' : ''
  );

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
  const held = { session: loadSessionToken(), device: loadDeviceToken() };
  const remembered = readJson(CACHE_KEYS.user);

  if (!held.session && !held.device) {
    // Nothing was in storage at all. Worth its own outcome: it is what an
    // evicted or unwritable store looks like from here, and it is not the same
    // failure as a credential the server turned down.
    //
    // The caches still go. There is no credential, so a remembered profile and
    // a remembered list are someone's name and address sitting on a device that
    // cannot use them.
    clearCaches();
    return _signedOut(held, 'empty', null, false);
  }

  if (held.session && remembered) {
    setAuth({ type: 'token', token: held.session });
    setState({ authMode: 'user', user: remembered });
    _verifyInBackground(held);
    return 'user';
  }

  if (held.session) {
    setAuth({ type: 'token', token: held.session });
    try {
      const me = await api.me();
      writeJson(CACHE_KEYS.user, me.user);
      setState({ authMode: 'user', user: me.user });
      noteRestore('session', held);
      return 'user';
    } catch (e) {
      if (!isRefusal(e)) return _signedOut(held, 'unreachable', e, false);
      // Expired or revoked. The device token below may still be good.
    }
  }

  const outcome = await _refreshFromDevice();
  if (outcome === 'ok') {
    noteRestore('refreshed', held);
    return 'user';
  }

  // 'unreachable' keeps the tokens: the server never said they were bad, and a
  // device token is worth two months of not signing in.
  return _signedOut(held, outcome, null, outcome !== 'unreachable');
}

/**
 * Give up on restoring, with or without forgetting what is stored.
 *
 * Forgetting is reserved for a credential the server actually rejected, or for
 * a device that has none. Anything else — a launch with no network, an Apps
 * Script redirect that failed, a timeout — leaves storage alone, because it
 * says nothing about whether the credential is good.
 */
function _signedOut(held, outcome, error, forget) {
  if (forget) clearTokens();
  noteRestore(outcome, held, error && error.code);
  setAuth(null);
  setState({
    authMode: 'none',
    user: null,
    authError: outcome === 'unreachable'
      ? 'Could not reach the server. Your sign-in is still saved on this device — try again in a moment.'
      : null,
  });
  return 'none';
}

/**
 * Exchange the remembered-device token for a session.
 * Returns 'ok', 'none' (nothing stored), 'refused' or 'unreachable'.
 */
async function _refreshFromDevice() {
  const deviceToken = loadDeviceToken();
  if (!deviceToken) return 'none';
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
    return 'ok';
  } catch (e) {
    // A refusal is a revoked device, a disabled account, or a password changed
    // elsewhere. Anything else is the network, and means nothing about it.
    return isRefusal(e) ? 'refused' : 'unreachable';
  }
}

/**
 * Confirm the session the app has already started using, and correct course if
 * it turns out to be dead.
 *
 * The app is already drawn and usable by the time this runs, which sets the bar
 * for interrupting it: only a credential the server has actually refused is
 * worth throwing someone back to the sign-in screen. This used to end at
 * clearTokens() for any failure at all, so a single unlucky moment on launch —
 * a phone whose radio is not up yet, a request that timed out — deleted the
 * remembered device and turned every cold start into signing in again.
 */
async function _verifyInBackground(held) {
  try {
    const me = await api.me();
    writeJson(CACHE_KEYS.user, me.user);
    // Role or name may have changed since this device last looked.
    setState({ user: me.user });
    noteRestore('session', held);
    return;
  } catch (e) {
    if (!isRefusal(e)) {
      // Unknown. The screen in front of the user works, so leave it there.
      noteRestore('unverified', held, e && e.code);
      return;
    }
    // Session gone. A remembered device can still produce a new one.
  }

  const outcome = await _refreshFromDevice();
  if (outcome === 'ok') {
    noteRestore('refreshed', held);
    return;
  }
  if (outcome === 'unreachable') {
    noteRestore('unverified', held, 'refresh_unreachable');
    return;
  }

  _signedOut(held, outcome, null, true);
  setState({ authError: 'Your session has ended. Please sign in again.' });
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
