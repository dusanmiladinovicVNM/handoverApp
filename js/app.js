/**
 * app.js
 * Main entry point. Resolves auth, registers routes, starts the router.
 */

import * as Router from './router.js';
import { setAuth, api, ApiError } from './api.js';
import { setState, getState } from './state.js';
import {
  pageHome,
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
// Service worker registration
// ============================================================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('[app] SW registration failed:', e);
    });
  });
}

// ============================================================
// Boot — resolve auth based on URL
// ============================================================

async function boot() {
  // Read tenant token from URL hash query, e.g. #/inspection/INS-...?t=<token>
  const route = Router.getCurrentRoute();
  const tenantToken = route.query.t;

  if (tenantToken) {
    // Tenant flow
    setAuth({ type: 'token', token: tenantToken });

    // Try to extract inspection ID from path
    const match = route.path.match(/^\/inspection\/([^/]+)/);
    const inspectionId = match ? match[1] : null;

    setState({
      authMode: 'tenant',
      tenantToken,
      tenantInspectionId: inspectionId,
    });
  } else {
    // Admin flow — try Google login
    setAuth({ type: 'google' });
    try {
      // Light call to verify session
      await api.getSchemas();
      const email = ''; // Not exposed by API; could add a 'whoami' endpoint later
      setState({ authMode: 'admin', adminEmail: email });
    } catch (e) {
      if (e.code === 'UNAUTHORIZED' || e.code === 'FORBIDDEN') {
        setState({ authMode: 'none', authError: e.message });
      } else if (e.code === 'INTERNAL_ERROR' && /Backend URL not configured/.test(e.message)) {
        setState({ authMode: 'none', authError: e.message });
      } else {
        // Network error — stay in unknown, but allow user to try
        setState({ authMode: 'none', authError: e.message });
      }
    }
  }

  registerRoutes();
  Router.start();
}

// ============================================================
// Routes
// ============================================================

function registerRoutes() {
  // Tenant lands directly on /inspection/:id (with ?t= token)
  Router.route('/', pageHome);
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

  // Run cleanup hooks when route changes (used by section page for autosave)
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
      // Tenants can't access admin routes — bounce home
      Router.navigate('/', true);
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
