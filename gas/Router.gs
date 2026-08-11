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

    /**
     * Everything the New Inspection form needs, in one request.
     *
     * It used to make two, one after the other: getSchemas, then listUsers.
     * Neither depends on the other, so the screen sat on a spinner for the sum
     * of them — and each was a separate Apps Script execution, with its own
     * cold start, its own auth, and its own redirect. Running them in parallel
     * would have halved the wait and kept both executions; this removes one.
     *
     * The assignable list is admin-only because only an admin sees the
     * dropdown: an inspector's new inspection is theirs by definition.
     */
    'getNewInspectionOptions': (authCtx, data) => {
      AuthService.requireStaff(authCtx);
      return {
        schemas: SchemaService.listActiveSchemas(),
        assignableUsers: authCtx.isAdmin ? UserService.listAssignable() : [],
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

  /**
   * Actions after which the client used to turn straight around and call
   * getInspection.
   *
   * Every one of them changes what the inspection screen shows, so the screen
   * has to be redrawn from something — and the client had no way to get that
   * something except a second request. On this platform a request is not a few
   * milliseconds: /exec answers 302 and the body comes from a different host,
   * so every call is two HTTP round trips plus an execution with its own auth
   * and its own workbook open. Measured, that is two to four seconds spent
   * fetching state the server had in its hands a moment earlier.
   *
   * Attaching it here rather than in each service keeps the five handlers —
   * which live in four different files — from each growing their own copy of
   * getInspection's projection.
   */
  const RETURNS_INSPECTION_STATE = {
    'createInspection': true,
    'lockInspection': true,
    'unlockInspection': true,
    'assignInspection': true,
    'saveSignature': true,
    'finalizeInspection': true,
  };

  function dispatch(action, authCtx, data) {
    const handler = ROUTES[action];
    if (!handler) {
      throw new HandoverError('INVALID_REQUEST', `Unknown action: ${action}`);
    }
    const result = handler(authCtx, data || {});
    return _withInspectionState(action, authCtx, data || {}, result);
  }

  function _withInspectionState(action, authCtx, data, result) {
    if (!RETURNS_INSPECTION_STATE[action]) return result;
    if (!result || typeof result !== 'object') return result;

    // createInspection knows the id only from its own reply; the rest were
    // asked about an inspection by id in the first place.
    const inspectionId = result.inspectionId || data.inspectionId;
    if (!inspectionId) return result;

    try {
      result.state = InspectionService.getInspection(authCtx, {
        inspectionId: inspectionId,
      });
    } catch (e) {
      // The write already happened. Failing the response now would report a
      // successful mutation as an error, and the client could not tell which
      // it was. Dropping the convenience costs a round trip; the client falls
      // back to fetching, which is what it did before this existed.
      Utils.log('WARN', `Could not attach state after ${action}`, {
        inspectionId: inspectionId,
        error: e && e.message,
      });
    }
    return result;
  }

  /** Action names, for diagnostics. */
  function listActions() {
    return Object.keys(ROUTES);
  }

  return { dispatch, listActions };
})();
