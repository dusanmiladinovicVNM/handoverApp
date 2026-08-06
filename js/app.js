/**
 * app.js
 * Main entry point. Resolves auth, registers routes, starts the router.
 *
 * Auth flow:
 *  - URL has ?t=<token> → tenant flow, unchanged
 *  - #/set-password → no auth at all; the link is the credential
 *  - stored session or device token → signed-in account
 *  - none of the above → sign-in page
 */

import * as Router from './router.js';
import { h, mount } from './utils/dom.js';
import { setAuth } from './api.js';
import { setState, getState, isAdmin } from './state.js';
import { restoreSession } from './auth.js';
import {
  pageHome,
  pageLogin,
  pageSetPassword,
  pageForgotPassword,
  pageProfile,
  pageAdminUsers,
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
  } else if (route.path === '/set-password') {
    // The link in the mail is the credential. Restoring a session first would
    // be pointless, and worse: whoever follows a reset link is often the person
    // whose stored session no longer works.
    setState({ authMode: 'none' });
  } else {
    await restoreSession();
  }

  registerRoutes();
  Router.start();
}

// ============================================================
// Routes
// ============================================================

function registerRoutes() {
  Router.route('/', pageHome);
  Router.route('/login', pageLogin);
  Router.route('/set-password', pageSetPassword);
  Router.route('/forgot-password', pageForgotPassword);
  Router.route('/profile', requireUser(pageProfile));
  Router.route('/admin', requireUser(pageAdminList));
  Router.route('/admin/users', requireAdmin(pageAdminUsers));
  Router.route('/admin/new', requireUser(pageAdminNew));
  Router.route('/admin/inspection/:id', requireUser(pageAdminDetail));

  Router.route('/inspection/:id', pageInspectionHome);
  Router.route('/inspection/:id/section/:sectionId', pageInspectionSection);
  // Staff, not admin. Locking for signature is the end of fieldwork, so gating
  // it on admin left an inspector able to fill an inspection in and not able to
  // finish it. The server asks the same question the other way round:
  // lockInspection is requireStaff plus requireInspectionAccess, so an
  // inspector can only lock what is theirs.
  Router.route('/inspection/:id/review', requireUser(pageReview));
  Router.route('/inspection/:id/sign', pageSign);
  Router.route('/inspection/:id/success', pageSuccess);

  // Nodes, not markup — see the note on the default handler in router.js. The
  // path is whatever was in the address bar.
  Router.setNotFoundHandler((path) => {
    const code = h('code', null, path);
    mount(document.getElementById('app-root'),
      h('div', { class: 'app-body' },
        h('h1', { class: 'page__title' }, 'Page not found'),
        h('p', { class: 'text-muted' }, 'No route for ', code),
        h('a', { href: '#/', class: 'btn btn--primary mt-4' }, 'Back to home'),
      ));
  });

  Router.onChange(() => {
    if (window._currentPageCleanup) {
      try { window._currentPageCleanup(); } catch (_) {}
      window._currentPageCleanup = null;
    }
  });
}

/**
 * Route guards. These decide what to *render*, not what is allowed — the
 * server re-reads the role from the Users sheet on every request and is the
 * only thing standing between a user and an action. Hiding a screen is a
 * courtesy to the person, not a control on them.
 */
function requireUser(handler) {
  return (ctx) => {
    if (getState().authMode !== 'user') {
      Router.navigate('/login', true);
      return;
    }
    handler(ctx);
  };
}

function requireAdmin(handler) {
  return (ctx) => {
    const state = getState();
    if (state.authMode !== 'user') {
      Router.navigate('/login', true);
      return;
    }
    if (!isAdmin()) {
      Router.navigate('/admin', true);
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
  // e.message can carry text the server built from something the caller sent,
  // so it is no safer here than the URL is.
  mount(document.getElementById('app-root'),
    h('div', { class: 'app-body' },
      h('div', { class: 'banner banner--danger' },
        h('strong', null, 'Boot failed: '),
        String((e && e.message) || e),
      )));
});
