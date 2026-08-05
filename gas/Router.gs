/**
 * Router.gs
 * Maps action strings to service handlers.
 *
 * Every entry is a function that looks its service up when called, rather than
 * a direct reference resolved while this file loads.
 *
 * Apps Script shares one global scope across .gs files but evaluates them in
 * order, and each service is declared with `const`, so a name is in the
 * temporal dead zone until its own file has run. Writing
 * `SignatureService.saveSignature` here would therefore work or throw purely
 * depending on where this file happens to sit in that order — which shifts as
 * files are added. Deferring the lookup to dispatch time removes the ordering
 * question altogether.
 */

const Router = (function () {

  const ROUTES = {
    // --- Accounts and sessions ---
    // The first four run unauthenticated; see PUBLIC_ACTIONS in Code.gs.
    'login': (authCtx, data) => AccountService.login(authCtx, data),
    'requestPasswordReset': (authCtx, data) => AccountService.requestPasswordReset(authCtx, data),
    'setPassword': (authCtx, data) => AccountService.setPassword(authCtx, data),
    'refreshSession': (authCtx, data) => AccountService.refreshSession(authCtx, data),
    'changePassword': (authCtx, data) => AccountService.changePassword(authCtx, data),
    'me': (authCtx, data) => AccountService.me(authCtx, data),
    'signOut': (authCtx, data) => AccountService.signOut(authCtx, data),

    // --- Account administration (admin only, enforced in the service) ---
    'listUsers': (authCtx, data) => UserAdminService.listUsers(authCtx, data),
    'createUser': (authCtx, data) => UserAdminService.createUser(authCtx, data),
    'setUserStatus': (authCtx, data) => UserAdminService.setUserStatus(authCtx, data),
    'setUserRole': (authCtx, data) => UserAdminService.setUserRole(authCtx, data),
    'unlockUser': (authCtx, data) => UserAdminService.unlockUser(authCtx, data),
    'sendPasswordLink': (authCtx, data) => UserAdminService.sendPasswordLink(authCtx, data),
    'listUserDevices': (authCtx, data) => UserAdminService.listUserDevices(authCtx, data),
    'revokeDevice': (authCtx, data) => UserAdminService.revokeDevice(authCtx, data),
    'revokeAllDevices': (authCtx, data) => UserAdminService.revokeAllDevices(authCtx, data),
    'getAuthLog': (authCtx, data) => UserAdminService.getAuthLog(authCtx, data),
    'assignInspection': (authCtx, data) => UserAdminService.assignInspection(authCtx, data),

    // --- Schemas ---
    // Staff, not admin. This was admin-only from before inspectors existed,
    // which left the New Inspection form unable to load its list of forms for
    // exactly the role that goes out and fills them in.
    'getSchemas': (authCtx, data) => {
      AuthService.requireStaff(authCtx);
      return { schemas: SchemaService.listActiveSchemas() };
    },
    // Staff only. It used to accept any valid token, which let a tenant link
    // pull any schema by id — a small leak, but a pointless one: a tenant
    // already receives the schema for their own inspection inside
    // getInspection, and has no use for the others.
    'getSchema': (authCtx, data) => {
      AuthService.requireStaff(authCtx);
      Utils.requireField(data, 'schemaId', 'string');
      return {
        schemaId: data.schemaId,
        schema: SchemaService.getSchemaJson(data.schemaId),
      };
    },

    // --- Inspections ---
    'createInspection': (authCtx, data) => InspectionService.createInspection(authCtx, data),
    'getInspection': (authCtx, data) => InspectionService.getInspection(authCtx, data),
    'saveSection': (authCtx, data) => InspectionService.saveSection(authCtx, data),
    'lockInspection': (authCtx, data) => InspectionService.lockInspection(authCtx, data),
    'unlockInspection': (authCtx, data) => InspectionService.unlockInspection(authCtx, data),
    'regenerateTenantToken': (authCtx, data) => InspectionService.regenerateTenantToken(authCtx, data),
    'listInspections': (authCtx, data) => InspectionService.listInspections(authCtx, data),

    // --- Attachments, signatures, output ---
    'uploadAttachment': (authCtx, data) => AttachmentService.uploadAttachment(authCtx, data),
    'deleteAttachment': (authCtx, data) => AttachmentService.deleteAttachment(authCtx, data),
    'saveSignature': (authCtx, data) => SignatureService.saveSignature(authCtx, data),
    'finalizeInspection': (authCtx, data) => PdfService.finalizeInspection(authCtx, data),
    'getAuditLog': (authCtx, data) => AuditService.getEventsForInspection(authCtx, data),
  };

  function dispatch(action, authCtx, data) {
    const handler = ROUTES[action];
    if (!handler) {
      throw new HandoverError('INVALID_REQUEST', `Unknown action: ${action}`);
    }
    return handler(authCtx, data || {});
  }

  /** Action names, for diagnostics. */
  function listActions() {
    return Object.keys(ROUTES);
  }

  return { dispatch, listActions };
})();
