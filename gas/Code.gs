/**
 * Code.gs
 * Entry point for the Web App. Apps Script invokes doPost/doGet here.
 */

/**
 * Actions that run before a session exists, and are therefore dispatched with
 * no auth context at all.
 *
 * This is the only exception to "every request is authenticated", so it stays
 * an explicit allowlist rather than a property of each handler — adding an
 * action here is a decision someone has to make on purpose. Each of these
 * handlers is responsible for its own rate limiting and for answering
 * identically whether or not the account exists.
 */
const PUBLIC_ACTIONS = [
  'login',
  'requestPasswordReset',
  'setPassword',
  'refreshSession',
];

/**
 * Main API entry point.
 * Frontend calls with Content-Type: text/plain;charset=utf-8 to bypass CORS preflight.
 * Body shape: { action, auth, data }
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ResponseService.error('INVALID_REQUEST', 'Empty request body.');
    }

    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseError) {
      return ResponseService.error('INVALID_REQUEST', 'Body is not valid JSON.');
    }

    const action = body.action;
    if (!action) {
      return ResponseService.error('INVALID_REQUEST', 'Missing action field.');
    }

    // Resolve auth before dispatch, except for the sign-in actions themselves
    const isPublic = PUBLIC_ACTIONS.indexOf(action) >= 0;
    const authCtx = isPublic ? null : AuthService.resolveAuth(body.auth);

    Utils.log('INFO', 'API call', {
      action, actor: authCtx ? authCtx.actorString : 'anonymous',
    });

    const result = Router.dispatch(action, authCtx, body.data);
    return ResponseService.success(result);

  } catch (e) {
    return ResponseService.fromException(e);
  }
}

/**
 * GET endpoint — only supports a simple health check / version response.
 * All real API calls go through POST.
 */
function doGet(e) {
  return ResponseService.success({
    service: 'handover-backend',
    version: '1.0.0',
    timestamp: Utils.nowIso(),
  });
}
