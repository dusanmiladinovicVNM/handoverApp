/**
 * Code.gs
 * Entry point for the Web App. Apps Script invokes doPost/doGet here.
 */

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

    // Resolve auth before dispatch
    const authCtx = AuthService.resolveAuth(body.auth);

    Utils.log('INFO', 'API call', { action, actor: authCtx.actorString });

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
