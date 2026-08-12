/**
 * AuthService.gs
 * Authentication and authorization.
 *
 * Token types, all in the form base64url(payload).hmac:
 *
 *  - Session  { typ:'s', uid, did, exp, nonce }        12 hours
 *      Carries identity, never authority. Role and status are read from the
 *      Users row on every request — see below.
 *
 *  - Device   { typ:'d', uid, did, exp, nonce }        60 days
 *      Only ever exchanged for a fresh session by AccountService.refreshSession.
 *      Never accepted as a session itself.
 *
 *  - Set password { typ:'setpw', uid, exp, nonce }     48 hours, single use
 *      Sent by mail so a user can choose their own password.
 *
 *  - Tenant   { iid, role:'tenant', exp, nonce }
 *      Unchanged. Bound to one inspection, revoked by rotating that
 *      inspection's currentNonce.
 *
 * The pre-accounts admin token is gone. It belonged to no person, lasted a
 * year, and could only be revoked from the Apps Script editor. Any token of
 * that shape is now simply invalid, whoever holds it.
 *
 * THE RULE: a session token names who you are, never what you may do. Authority
 * comes from the Users sheet on every single request. Were the role baked into
 * the signed payload instead, revoking someone's admin rights would not take
 * effect until their token expired — which is not what an administrator means
 * when they click the button.
 *
 * Google login is not usable here: an Apps Script Web App deployed with
 * "Anyone" access provides no caller identity.
 */

const AuthService = (function () {

  const TOKEN_SESSION = 's';
  const TOKEN_DEVICE = 'd';
  const TOKEN_SETPW = 'setpw';

  // ============================================================
  // Signing
  // ============================================================

  function _signPayload(payload) {
    const payloadB64 = Utils.base64UrlEncodeString(JSON.stringify(payload));
    const sig = Utils.hmacSha256(payloadB64, Config.getTokenSecret());
    return `${payloadB64}.${sig}`;
  }

  /**
   * Signature and expiry only. Everything semantic — is the device revoked, is
   * the account still active — is decided by the caller.
   */
  function _verifySigned(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;

    const expectedSig = Utils.hmacSha256(payloadB64, Config.getTokenSecret());
    if (!Utils.safeEqual(sigB64, expectedSig)) return null;

    let payload;
    try {
      payload = JSON.parse(Utils.base64UrlDecodeToString(payloadB64));
    } catch (e) {
      return null;
    }
    if (!payload || !payload.exp || !payload.nonce) return null;
    if (payload.exp < Utils.nowEpochSeconds()) return null;
    return payload;
  }

  // ============================================================
  // Token generation
  // ============================================================

  function generateSessionToken(userId, deviceId, deviceNonce) {
    return _signPayload({
      typ: TOKEN_SESSION,
      uid: userId,
      did: deviceId,
      exp: Utils.nowEpochSeconds() + Config.getSessionTtlHours() * 3600,
      nonce: deviceNonce,
    });
  }

  function generateDeviceToken(userId, deviceId, deviceNonce) {
    return _signPayload({
      typ: TOKEN_DEVICE,
      uid: userId,
      did: deviceId,
      exp: Utils.nowEpochSeconds() + Config.getDeviceTtlDays() * 24 * 3600,
      nonce: deviceNonce,
    });
  }

  /**
   * The nonce is derived from the account's *current* password hash. Setting a
   * password changes that hash, so the link that was used to set it stops
   * verifying — single use, with no extra column and no cache entry. That
   * matters here because CacheService caps entries at six hours, while these
   * links must live for 48.
   *
   * It also means any older outstanding link dies at the same moment, which is
   * the behaviour you want from a password reset.
   */
  function _setPasswordNonce(user) {
    return Utils.hmacSha256(
      `setpw|${user.userId}|${user.passHash || ''}`,
      Config.getTokenSecret()
    );
  }

  function generateSetPasswordToken(user) {
    return _signPayload({
      typ: TOKEN_SETPW,
      uid: user.userId,
      exp: Utils.nowEpochSeconds() + Config.getSetPasswordTtlHours() * 3600,
      nonce: _setPasswordNonce(user),
    });
  }

  function generateTenantToken(inspectionId, ttlHours, nonce) {
    return _signPayload({
      iid: inspectionId,
      role: 'tenant',
      exp: Utils.nowEpochSeconds() + (ttlHours * 3600),
      nonce: nonce,
    });
  }

  // ============================================================
  // Token verification
  // ============================================================

  /**
   * Verify a tenant token, including revocation.
   * Session tokens are resolved through resolveAuth, which needs the Users row.
   */
  function verifyToken(token) {
    const payload = _verifySigned(token);
    if (!payload || payload.role !== 'tenant' || !payload.iid) return null;

    const inspection = SheetService.getInspection(payload.iid);
    if (!inspection) return null;
    if (inspection.currentNonce !== payload.nonce) return null;
    return payload;
  }

  /**
   * Resolve a set-password token to its user, or null.
   * Also returns null once the link has been used, or if the account was
   * disabled after the mail went out.
   */
  function verifySetPasswordToken(token) {
    const payload = _verifySigned(token);
    if (!payload || payload.typ !== TOKEN_SETPW || !payload.uid) return null;

    const user = UserService.getById(payload.uid);
    if (!user || user.status !== 'active') return null;
    if (!Utils.safeEqual(String(payload.nonce), _setPasswordNonce(user))) return null;
    return user;
  }

  /**
   * Resolve a device token to { user, device }, or null.
   * Used only by refreshSession — a device token is never a session.
   */
  function verifyDeviceToken(token) {
    const payload = _verifySigned(token);
    if (!payload || payload.typ !== TOKEN_DEVICE || !payload.uid || !payload.did) return null;

    const device = DeviceService.getById(payload.did);
    if (!DeviceService.checkUsable(device, payload.nonce).ok) return null;
    if (device.userId !== payload.uid) return null;

    const user = UserService.getById(payload.uid);
    if (!user || user.status !== 'active') return null;
    return { user: user, device: device };
  }

  // ============================================================
  // Auth resolution
  // ============================================================

  function resolveAuth(authBlock) {
    if (!authBlock || !authBlock.type) {
      throw new HandoverError('UNAUTHORIZED', 'Missing auth block.');
    }

    if (authBlock.type === 'google') {
      throw new HandoverError(
        'UNAUTHORIZED',
        'Google login is not supported by this deployment. Sign in with your email address.'
      );
    }

    if (authBlock.type !== 'token') {
      throw new HandoverError('UNAUTHORIZED', `Unknown auth type: ${authBlock.type}`);
    }

    const payload = _verifySigned(authBlock.token);
    if (!payload) {
      throw new HandoverError('UNAUTHORIZED', 'Invalid or expired token.');
    }

    if (payload.typ === TOKEN_SESSION) return _resolveSession(payload);
    if (payload.typ === TOKEN_DEVICE) {
      throw new HandoverError(
        'UNAUTHORIZED', 'This token cannot be used directly. Refresh the session first.');
    }
    if (payload.role === 'tenant') return _resolveTenant(payload, authBlock.token);

    throw new HandoverError('UNAUTHORIZED', 'Invalid or expired token.');
  }

  function _resolveSession(payload) {
    if (!payload.uid || !payload.did) {
      throw new HandoverError('UNAUTHORIZED', 'Invalid or expired token.');
    }

    const device = DeviceService.getById(payload.did);
    const usable = DeviceService.checkUsable(device, payload.nonce);
    if (!usable.ok || device.userId !== payload.uid) {
      throw new HandoverError(
        'UNAUTHORIZED', 'This session is no longer valid. Please sign in again.');
    }

    // Authority is read here, per request — never taken from the token.
    const user = UserService.getById(payload.uid);
    if (!user) {
      throw new HandoverError('UNAUTHORIZED', 'This session is no longer valid.');
    }
    if (user.status !== 'active') {
      throw new HandoverError('UNAUTHORIZED', 'This account has been disabled.');
    }

    // Deliberately no write here. Recording lastSeenAt used to happen on this
    // path and was what made one request in every few take ten seconds instead
    // of two — see DeviceService.touch. Resolving a session reads; it does not
    // write.

    return contextForUser(user, device.deviceId);
  }

  /**
   * The context a signed-in user acts under.
   *
   * Named and exported because sign-in needs one too. Issuing a session already
   * knows exactly who it is issuing to, so it can answer the first question
   * that user is about to ask — and a second copy of these seven fields,
   * assembled by hand over in AccountService, is the kind of thing that agrees
   * with this one until the day a field is added to one of them.
   *
   * Everything here is derived from the row just read from the sheet. Nothing
   * is taken from a token: a token says who, never what they may do.
   */
  function contextForUser(user, deviceId) {
    return {
      type: 'token',
      role: user.role,
      isAdmin: user.role === 'admin',
      userId: user.userId,
      email: user.email,
      name: user.name,
      deviceId: deviceId,
      actorString: `user:${user.email}`,
    };
  }

  function _resolveTenant(payload, token) {
    if (!payload.iid) {
      throw new HandoverError('UNAUTHORIZED', 'Invalid or expired token.');
    }
    const inspection = SheetService.getInspection(payload.iid);
    if (!inspection || inspection.currentNonce !== payload.nonce) {
      throw new HandoverError('UNAUTHORIZED', 'Invalid or expired token.');
    }
    return {
      type: 'token',
      role: 'tenant',
      inspectionId: payload.iid,
      isAdmin: false,
      actorString: `tenant_token:${token.substring(0, 8)}`,
    };
  }

  // ============================================================
  // Permission checks
  // ============================================================

  function requireAdmin(authCtx) {
    if (!authCtx || !authCtx.isAdmin) {
      throw new HandoverError('FORBIDDEN', 'This action requires admin access.');
    }
  }

  /**
   * Any signed-in member of staff — admin or inspector — but not a tenant.
   *
   * Before accounts existed there were only two kinds of caller, so "not a
   * tenant" and "admin" were the same test and requireAdmin did both jobs.
   * With a second staff role the two come apart: an inspector doing fieldwork
   * needs to list, edit and finalise inspections, and gating that on admin
   * would leave the role able to sign in and do nothing at all.
   *
   * What stays admin-only is supervisory: reopening a signed inspection,
   * reading the audit log, and managing accounts.
   *
   * This says nothing about *which* inspections — requireInspectionAccess does,
   * and every handler that names an inspection has to call it too.
   */
  function requireStaff(authCtx) {
    if (!authCtx || authCtx.role === 'tenant') {
      throw new HandoverError('FORBIDDEN', 'This action requires a staff account.');
    }
  }

  function requireMatchingInspection(authCtx, inspectionId) {
    if (authCtx.role === 'tenant' && authCtx.inspectionId !== inspectionId) {
      throw new HandoverError('FORBIDDEN', 'Token not valid for this inspection.');
    }
  }

  /**
   * May this caller touch this particular inspection?
   *
   * Three answers, one per kind of caller:
   *
   *   tenant     only the inspection its link was issued for
   *   admin      any of them
   *   inspector  only the ones assigned to them
   *
   * An inspector is told 'not found' rather than 'not yours', and gets the same
   * answer for an inspection that does not exist. Inspection ids run in
   * sequence, so a FORBIDDEN would let anyone with an account walk the range
   * and count the work — which is exactly what "an inspector sees only their
   * own" is meant to prevent.
   *
   * The row is fetched here even though most callers fetch it again straight
   * afterwards. Within one execution SheetService has already read the sheet,
   * so the second call is free, and the alternative — passing the row in — puts
   * the caller in charge of what the check looks at.
   */
  function requireInspectionAccess(authCtx, inspectionId) {
    if (!authCtx) {
      throw new HandoverError('UNAUTHORIZED', 'Not signed in.');
    }

    if (authCtx.role === 'tenant') {
      requireMatchingInspection(authCtx, inspectionId);
      return;
    }
    if (authCtx.isAdmin) return;

    const inspection = SheetService.getInspection(inspectionId);
    const owner = String((inspection && inspection.assignedTo) || '').trim().toLowerCase();
    const caller = String(authCtx.email || '').trim().toLowerCase();

    // An unassigned inspection has no owner to match, so it stays with the
    // admins until someone hands it over.
    if (!owner || !caller || owner !== caller) {
      throw new HandoverError('NOT_FOUND', 'Inspection not found.');
    }
  }

  /**
   * Narrow a list of inspection rows to what this caller may see. Same rule as
   * requireInspectionAccess, applied in bulk.
   *
   * Kept here rather than expressed as a filter argument to SheetService,
   * because the filter object on a list request comes from the client. A
   * restriction the client can name is a restriction the client can drop.
   */
  function visibleInspections(authCtx, rows) {
    if (!authCtx) return [];
    if (authCtx.isAdmin) return rows;

    const caller = String(authCtx.email || '').trim().toLowerCase();
    if (!caller) return [];
    return rows.filter(
      r => String(r.assignedTo || '').trim().toLowerCase() === caller);
  }

  function requireMatchingRole(authCtx, signerRole) {
    if (authCtx.role === 'tenant' && signerRole !== 'tenant') {
      throw new HandoverError(
        'FORBIDDEN',
        `Tenant token cannot sign as '${signerRole}'.`
      );
    }
  }

  return {
    // Generation
    generateTenantToken,
    generateSessionToken,
    generateDeviceToken,
    generateSetPasswordToken,
    // Verification
    verifyToken,
    verifySetPasswordToken,
    verifyDeviceToken,
    resolveAuth,
    contextForUser,
    // Permissions
    requireAdmin,
    requireStaff,
    requireMatchingInspection,
    requireInspectionAccess,
    visibleInspections,
    requireMatchingRole,
  };
})();
