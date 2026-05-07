/**
 * AuthService.gs
 * Authentication and authorization.
 *
 * Two token types:
 *  - Tenant token: { iid, role: 'tenant', exp, nonce }
 *      - Bound to one inspection (iid)
 *      - nonce must match inspection.currentNonce
 *      - revoked by rotating inspection.currentNonce (regenerate or unlock)
 *  - Admin token: { role: 'admin', exp, nonce, label }
 *      - Not bound to any inspection
 *      - nonce must be in PropertiesService 'ADMIN_NONCES' (JSON array)
 *      - revoked by removing nonce from that list
 *      - label is a human-readable description ("Dušan iPhone") for audit
 *
 * Google login is no longer used (Apps Script Web App with "Anyone" access does
 * not provide caller identity).
 */

const AuthService = (function () {

  const ADMIN_NONCES_KEY = 'ADMIN_NONCES';

  // --- Admin nonce list (Script Properties) ---

  function _loadAdminNonces() {
    const raw = PropertiesService.getScriptProperties().getProperty(ADMIN_NONCES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function _saveAdminNonces(list) {
    PropertiesService.getScriptProperties()
      .setProperty(ADMIN_NONCES_KEY, JSON.stringify(list));
  }

  function _addAdminNonce(entry) {
    const list = _loadAdminNonces();
    list.push(entry);
    _saveAdminNonces(list);
  }

  function _hasAdminNonce(nonce) {
    const list = _loadAdminNonces();
    return list.some(e => e && e.nonce === nonce);
  }

  function _removeAdminNonce(nonce) {
    const list = _loadAdminNonces();
    const filtered = list.filter(e => e && e.nonce !== nonce);
    _saveAdminNonces(filtered);
    return list.length !== filtered.length;
  }

  // --- Token generation ---

  function generateTenantToken(inspectionId, ttlHours, nonce) {
    const payload = {
      iid: inspectionId,
      role: 'tenant',
      exp: Utils.nowEpochSeconds() + (ttlHours * 3600),
      nonce: nonce,
    };
    return _signPayload(payload);
  }

  /**
   * Generate an admin token. Stores its nonce in the admin nonce list.
   *
   * @param ttlHours  Long TTL is fine (admin keeps device).
   * @param label     Human description for audit/management UI.
   */
  function generateAdminToken(ttlHours, label) {
    const nonce = Utils.generateNonce() + Utils.generateNonce(); // 16 hex chars
    const payload = {
      role: 'admin',
      exp: Utils.nowEpochSeconds() + (ttlHours * 3600),
      nonce: nonce,
      label: label || 'unnamed admin device',
    };
    const token = _signPayload(payload);
    _addAdminNonce({
      nonce: nonce,
      label: payload.label,
      createdAt: Utils.nowIso(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      tokenHash: Utils.sha256(token),
    });
    return token;
  }

  /** Back-compat wrapper for old callers. */
  function generateToken(inspectionId, role, ttlHours, nonce) {
    if (role === 'admin') return generateAdminToken(ttlHours, 'legacy');
    return generateTenantToken(inspectionId, ttlHours, nonce);
  }

  function _signPayload(payload) {
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = Utils.base64UrlEncodeString(payloadStr);
    const sig = Utils.hmacSha256(payloadB64, Config.getTokenSecret());
    return `${payloadB64}.${sig}`;
  }

  // --- Token verification ---

  function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;

    const expectedSig = Utils.hmacSha256(payloadB64, Config.getTokenSecret());
    if (!Utils.safeEqual(sigB64, expectedSig)) return null;

    let payload;
    try {
      const payloadStr = Utils.base64UrlDecodeToString(payloadB64);
      payload = JSON.parse(payloadStr);
    } catch (e) {
      return null;
    }
    if (!payload || !payload.role || !payload.exp || !payload.nonce) return null;
    if (payload.exp < Utils.nowEpochSeconds()) return null;

    if (payload.role === 'admin') {
      if (!_hasAdminNonce(payload.nonce)) return null;
      return payload;
    }

    if (payload.role === 'tenant') {
      if (!payload.iid) return null;
      const inspection = SheetService.getInspection(payload.iid);
      if (!inspection) return null;
      if (inspection.currentNonce !== payload.nonce) return null;
      return payload;
    }

    return null;
  }

  // --- Auth resolution ---

  function resolveAuth(authBlock) {
    if (!authBlock || !authBlock.type) {
      throw new HandoverError('UNAUTHORIZED', 'Missing auth block.');
    }

    if (authBlock.type === 'token') {
      const payload = verifyToken(authBlock.token);
      if (!payload) {
        throw new HandoverError('UNAUTHORIZED', 'Invalid or expired token.');
      }
      if (payload.role === 'admin') {
        return {
          type: 'token',
          role: 'admin',
          isAdmin: true,
          adminLabel: payload.label || '',
          actorString: `admin:${payload.label || authBlock.token.substring(0, 8)}`,
        };
      }
      return {
        type: 'token',
        role: 'tenant',
        inspectionId: payload.iid,
        isAdmin: false,
        actorString: `tenant_token:${authBlock.token.substring(0, 8)}`,
      };
    }

    if (authBlock.type === 'google') {
      throw new HandoverError(
        'UNAUTHORIZED',
        'Google login is not supported by this deployment. Use an admin token.'
      );
    }

    throw new HandoverError('UNAUTHORIZED', `Unknown auth type: ${authBlock.type}`);
  }

  // --- Permission checks ---

  function requireAdmin(authCtx) {
    if (!authCtx.isAdmin) {
      throw new HandoverError('FORBIDDEN', 'This action requires admin access.');
    }
  }

  function requireMatchingInspection(authCtx, inspectionId) {
    if (authCtx.role === 'tenant' && authCtx.inspectionId !== inspectionId) {
      throw new HandoverError('FORBIDDEN', 'Token not valid for this inspection.');
    }
  }

  function requireMatchingRole(authCtx, signerRole) {
    if (authCtx.role === 'tenant' && signerRole !== 'tenant') {
      throw new HandoverError(
        'FORBIDDEN',
        `Tenant token cannot sign as '${signerRole}'.`
      );
    }
  }

  // --- Admin token management ---

  function listAdminTokens() {
    return _loadAdminNonces().map(e => ({
      label: e.label,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      nonce: e.nonce,
    }));
  }

  function revokeAdminToken(nonce) {
    return _removeAdminNonce(nonce);
  }

  return {
    generateToken,
    generateTenantToken,
    generateAdminToken,
    verifyToken,
    resolveAuth,
    requireAdmin,
    requireMatchingInspection,
    requireMatchingRole,
    listAdminTokens,
    revokeAdminToken,
  };
})();
