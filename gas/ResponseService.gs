/**
 * ResponseService.gs
 * Builds standardized success/error responses returned by doPost.
 * Apps Script Web App returns ContentService output, not raw JSON.
 */

const ResponseService = (function () {

  function _build(payload) {
    return ContentService
      .createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
  }

  function success(data) {
    return _build({ ok: true, data: data || {} });
  }

  function error(code, message, details) {
    Utils.log('ERROR', `API error: ${code}`, { message, details });
    return _build({
      ok: false,
      error: {
        code: code || 'INTERNAL_ERROR',
        message: message || 'An unexpected error occurred.',
        details: details || {},
      },
    });
  }

  function fromException(e) {
    if (e instanceof HandoverError) {
      return error(e.code, e.message, e.details);
    }
    Utils.log('ERROR', 'Uncaught exception', { message: e.message, stack: e.stack });
    return error('INTERNAL_ERROR', e.message || String(e));
  }

  return { success, error, fromException };
})();
