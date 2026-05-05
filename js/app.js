/**
 * app.js
 * Main entry point. Resolves auth, registers routes, starts the router.
 *
 * Auth flow:
 *  - URL has ?t=<token> → tenant flow, token validated server-side on first call
 *  - localStorage has 'adminToken' → admin flow
 *  - Neither → show admin login page (paste token)
 */

import * as Router from './router.js';
import { setAuth, api, ApiError } from './api.js';
import { setState, getState } from './state.js';
import {
  pageHome,
  pageAdminLogin,
  pageAdminList,
  pageAdminNew,
  pageAdminDetail,
  pageInspectionHome,
  pageInspectionSection,
  pageReview,
  pageSign,
  pageSuccess,
} from './pages.js';

const ADMIN_TOKEN_STORAGE_KEY = 'handover.adminToken';
const ADMIN_LABEL_STORAGE_KEY = 'handover.adminLabel';

// ============================================================
// Service worker
// ============================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('[app] SW registration failed:', e);
    });
  });
}

// ============================================================
// Admin token helpers (exported for use by pages)
// ============================================================

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
 * Try a candidate admin token. Returns true if it works.
 * Used by login page after user pastes one.
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

// ============================================================
// Boot
// ============================================================

async function boot() {
  const route = Router.getCurrentRoute();
  const tenantToken = route.query.t;

  if (tenantToken) {
    // Tenant flow — token in URL
    setAuth({ type: 'token', token: tenantToken });
    const match = route.path.match(/^\/inspection\/([^/]+)/);
    const inspectionId = match ? match[1] : null;
    setState({
      authMode: 'tenant',
      tenantToken,
      tenantInspectionId: inspectionId,
    });
  } else {
    // Admin flow — try saved token
    const savedToken = loadAdminToken();
    if (savedToken) {
      setAuth({ type: 'token', token: savedToken });
      try {
        await api.getSchemas();
        setState({
          authMode: 'admin',
          adminToken: savedToken,
          adminLabel: loadAdminLabel(),
        });
      } catch (e) {
        // Token expired or revoked — clear and show login
        clearAdminToken();
        setAuth(null);
        setState({
          authMode: 'none',
          authError: e.code === 'UNAUTHORIZED'
            ? 'Saved admin token is invalid or expired. Paste a new one.'
            : e.message,
        });
      }
    } else {
      setState({ authMode: 'none' });
    }
  }

  registerRoutes();
  Router.start();
}

// ============================================================
// Routes
// ============================================================

function registerRoutes() {
  Router.route('/', pageHome);
  Router.route('/login', pageAdminLogin);
  Router.route('/admin', requireAdmin(pageAdminList));
  Router.route('/admin/new', requireAdmin(pageAdminNew));
  Router.route('/admin/inspection/:id', requireAdmin(pageAdminDetail));

  Router.route('/inspection/:id', pageInspectionHome);
  Router.route('/inspection/:id/section/:sectionId', pageInspectionSection);
  Router.route('/inspection/:id/review', requireAdmin(pageReview));
  Router.route('/inspection/:id/sign', pageSign);
  Router.route('/inspection/:id/success', pageSuccess);

  Router.setNotFoundHandler((path) => {
    document.getElementById('app-root').innerHTML = `
      <div class="app-body">
        <h1 class="page__title">Page not found</h1>
        <p class="text-muted">No route for <code>${path}</code></p>
        <a href="#/" class="btn btn--primary mt-4">Back to home</a>
      </div>`;
  });

  Router.onChange(() => {
    if (window._currentPageCleanup) {
      try { window._currentPageCleanup(); } catch (_) {}
      window._currentPageCleanup = null;
    }
  });
}

function requireAdmin(handler) {
  return (ctx) => {
    if (getState().authMode !== 'admin') {
      Router.navigate('/login', true);
      return;
    }
    handler(ctx);
  };
}

// ============================================================
// Start
// ============================================================

boot().catch((e) => {
  console.error('Boot failed:', e);
  document.getElementById('app-root').innerHTML = `
    <div class="app-body">
      <div class="banner banner--danger">
        <strong>Boot failed:</strong> ${e.message || e}
      </div>
    </div>`;
});
