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
    const totalMs = Date.now() - startedAt;
    const timing = {
      action: action,
      actor: authCtx ? authCtx.actorString : 'anonymous',
      authMs: authMs,
      handlerMs: totalMs - authMs,
      totalMs: totalMs,
    };
    Utils.log('INFO', 'API call', timing);
    _recordIfSlow(timing);

    return ResponseService.success(result);

  } catch (e) {
    return ResponseService.fromException(e);
  }
}

/**
 * Write a slow request's breakdown into AuditLog.
 *
 * The Executions panel already carries these numbers, but its rows do not
 * reliably expand for Web App calls — which makes the one place the timings
 * exist the one place they cannot be read. Putting the outliers in the sheet
 * means they can be looked at like any other data, by whoever is actually
 * wondering why something felt slow.
 *
 * Only requests over the threshold are recorded. They are rare by definition,
 * so the extra write costs nothing in aggregate; logging every call would add a
 * write to all of them in order to study a handful.
 */
function _recordIfSlow(timing) {
  try {
    const threshold = Config.getSlowRequestMs();
    if (threshold > 0 && timing.totalMs < threshold) return;
    // Where the handler's time actually went. Without this the row says four
    // seconds and leaves the reader to guess between opening the workbook, the
    // round trips after it, and the handler's own work.
    const sheets = SheetService.getStats();
    AuditService.logAuth(timing.actor, 'slow_request', {
      action: timing.action,
      authMs: timing.authMs,
      handlerMs: timing.handlerMs,
      totalMs: timing.totalMs,
      openMs: sheets.openMs,
      reads: sheets.reads,
      readMs: sheets.readMs,
    });
  } catch (e) {
    // Diagnostics must never be able to fail a request that has already
    // succeeded. The response is built and waiting by the time this runs.
    Utils.log('WARN', 'Slow-request log failed', { error: e.message });
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
