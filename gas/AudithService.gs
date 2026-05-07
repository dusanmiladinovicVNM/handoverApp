/**
 * AuditService.gs
 * Append-only event logging for traceability.
 */

const AuditService = (function () {

  function log(inspectionId, actor, eventType, details) {
    try {
      SheetService.appendAuditEvent({
        eventId: Utils.generateEventId(),
        inspectionId: inspectionId,
        actor: actor || 'system',
        eventType: eventType,
        timestamp: Utils.nowIso(),
        detailsJson: JSON.stringify(details || {}),
      });
    } catch (e) {
      // Never let audit failures break the main operation
      Utils.log('WARN', 'Audit log write failed', { error: e.message, eventType });
    }
  }

  function getEventsForInspection(authCtx, data) {
    AuthService.requireAdmin(authCtx);
    Utils.requireField(data, 'inspectionId', 'string');
    const events = SheetService.getAuditEventsForInspection(data.inspectionId);
    const projected = events.map(e => ({
      eventId: e.eventId,
      eventType: e.eventType,
      actor: e.actor,
      timestamp: e.timestamp,
      details: _safeParseJson(e.detailsJson),
    }));
    // Sort newest first
    projected.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return { events: projected };
  }

  function _safeParseJson(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return {};
    }
  }

  return { log, getEventsForInspection };
})(); 
