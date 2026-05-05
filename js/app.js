/**
 * app.js
 * Main entry point. Resolves auth, registers routes, starts the router.
 *
 * Auth flow:
 *  - URL has ?t=<token> → tenant flow
 *  - localStorage has admin token → admin flow
 *  - Neither → login page (paste admin token)
 */

import * as Router from './router.js';
import { setAuth, api } from './api.js';
import { setState, getState } from './state.js';
import { loadAdminToken, loadAdminLabel, clearAdminToken } from './auth.js';
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
// Boot
// ============================================================

async function boot() {
  const route = Router.getCurrentRoute();
  const tenantToken = route.query.t;

  if (tenantToken) {
    setAuth({ type: 'token', token: tenantToken });
    const match = route.path.match(/^\/inspection\/([^/]+)/);
    setState({
      authMode: 'tenant',
      tenantToken,
      tenantInspectionId: match ? match[1] : null,
    });
  } else {
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
