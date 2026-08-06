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
    const startedAt = Date.now();
    const isPublic = PUBLIC_ACTIONS.indexOf(action) >= 0;
    const authCtx = isPublic ? null : AuthService.resolveAuth(body.auth);
    const authMs = Date.now() - startedAt;

    const result = Router.dispatch(action, authCtx, body.data);

    // Timed and split so that "the app feels slow" can be answered with numbers.
    // Auth runs on every single request and reads two rows behind a cache, so
    // it is worth knowing separately from whatever the action itself does —
    // otherwise the obvious suspect and the real one look identical from here.
    const workMs = Date.now() - startedAt;
    const timing = Object.assign({
      action: action,
      actor: authCtx ? authCtx.actorString : 'anonymous',
      authMs: authMs,
      handlerMs: workMs - authMs,
      totalMs: workMs,
    },
      SheetService.getStats(), DriveService.getStats(), PasswordService.getStats());

    _recordTiming(timing);

    // Measured after the diagnostics, so that whatever they cost is inside the
    // number rather than beside it.
    timing.responseReadyMs = Date.now() - startedAt;
    timing.diagnosticsMs = timing.responseReadyMs - workMs;
    Utils.log('INFO', 'API call', timing);

    // The caller gets the same breakdown it would otherwise have to ask the
    // sheet for, and only an admin: it names internal costs.
    return ResponseService.success(
      (authCtx && authCtx.isAdmin) ? Object.assign({ timing: timing }, result) : result);

  } catch (e) {
    return ResponseService.fromException(e);
  }
}

/**
 * Record a request's timing.
 *
 * This used to append a row to AuditLog, before the response was returned, for
 * requests over a threshold. Two things were wrong with that. A sheet write is
 * a remote round trip, so the diagnostic was adding to the wait of exactly the
 * requests that were already slow — and because totalMs was computed before
 * it, the number written down excluded the cost of writing it down. The
 * slowest requests in the log were the ones whose reported figure was furthest
 * from what the person actually waited.
 *
 * Logger output is local to the execution and shows up in the Executions panel
 * next to the run it belongs to, so it costs nothing on the request path. The
 * numbers also ride back in the response for an admin, which is how the
 * Playwright benchmark reads them without going near the sheet.
 */
function _recordTiming(timing) {
  try {
    const threshold = Config.getSlowRequestMs();
    const slow = threshold > 0 && timing.totalMs >= threshold;
    Utils.log(slow ? 'WARN' : 'INFO',
      slow ? 'slow_request' : 'timing', timing);
  } catch (e) {
    // Diagnostics must never be able to fail a request that has succeeded.
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
