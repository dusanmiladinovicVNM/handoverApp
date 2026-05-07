/**
 * Router.gs
 * Maps action strings to service handlers.
 */

const Router = (function () {

  const ROUTES = {
    'getSchemas': function (authCtx, data) {
      AuthService.requireAdmin(authCtx);
      return { schemas: SchemaService.listActiveSchemas() };
    },
    'getSchema': function (authCtx, data) {
      Utils.requireField(data, 'schemaId', 'string');
      return {
        schemaId: data.schemaId,
        schema: SchemaService.getSchemaJson(data.schemaId),
      };
    },
    'createInspection': InspectionService.createInspection,
    'getInspection': InspectionService.getInspection,
    'saveSection': InspectionService.saveSection,
    'lockInspection': InspectionService.lockInspection,
    'unlockInspection': InspectionService.unlockInspection,
    'regenerateTenantToken': InspectionService.regenerateTenantToken,
    'listInspections': InspectionService.listInspections,
    'uploadAttachment': AttachmentService.uploadAttachment,
    'deleteAttachment': AttachmentService.deleteAttachment,
    'saveSignature': SignatureService.saveSignature,
    'finalizeInspection': PdfService.finalizeInspection,
    'getAuditLog': AuditService.getEventsForInspection,
  };

  function dispatch(action, authCtx, data) {
    const handler = ROUTES[action];
    if (!handler) {
      throw new HandoverError('INVALID_REQUEST', `Unknown action: ${action}`);
    }
    return handler(authCtx, data || {});
  }

  return { dispatch };
})();
