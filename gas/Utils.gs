/**
 * Utils.gs
 * Common utility functions used across services.
 */

const Utils = (function () {

  // --- Date helpers ---

  function nowIso() {
    return new Date().toISOString();
  }

  function nowEpochSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function currentYear() {
    return new Date().getFullYear();
  }

  function dateStringYYYYMMDD(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  // --- ID generation ---

  /**
   * Cosmetic random suffix for human-readable IDs (ATT-, SIG-, EVT-).
   *
   * NOT FOR SECURITY. Math.random() is not a cryptographic generator — a caller
   * that observes enough output can predict the rest. Anything that must be
   * unguessable (nonces, salts, one-time values) uses secureRandomHex instead.
   */
  function randomHex(len) {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
  }

  /**
   * Unpredictable hex string, for nonces, salts and one-time values.
   *
   * Apps Script exposes no crypto.getRandomValues(), so the entropy source is
   * Utilities.getUuid() — a type 4 UUID, which carries 122 random bits in its
   * 32 hex characters. Several are concatenated when more length is asked for.
   */
  function secureRandomHex(len) {
    let out = '';
    while (out.length < len) {
      out += Utilities.getUuid().replace(/-/g, '');
    }
    return out.substring(0, len);
  }

  /** Unpredictable byte array of the given length. Values are signed (-128..127). */
  function secureRandomBytes(count) {
    const hex = secureRandomHex(count * 2);
    const bytes = [];
    for (let i = 0; i < count; i++) {
      const v = parseInt(hex.substr(i * 2, 2), 16);
      bytes.push(v > 127 ? v - 256 : v);
    }
    return bytes;
  }

  function generateAttachmentId() {
    return `ATT-${dateStringYYYYMMDD()}-${randomHex(6)}`;
  }

  function generateSignatureId() {
    return `SIG-${dateStringYYYYMMDD()}-${randomHex(6)}`;
  }

  function generateEventId() {
    return `EVT-${dateStringYYYYMMDD()}-${randomHex(6)}`;
  }

  function generateNonce() {
    return secureRandomHex(16);
  }

  /**
   * Generates the next sequential ID atomically using ScriptLock.
   * Format: <PREFIX>-YYYY-NNNNNN
   */
  function _generateSequentialId(prefix, counterName) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const year = currentYear();
      const props = PropertiesService.getScriptProperties();
      const key = `${counterName}_${year}`;
      const current = parseInt(props.getProperty(key) || '0', 10);
      const next = current + 1;
      props.setProperty(key, String(next));
      const padded = String(next).padStart(6, '0');
      return `${prefix}-${year}-${padded}`;
    } finally {
      lock.releaseLock();
    }
  }

  function generateInspectionId() {
    return _generateSequentialId('INS', 'inspectionCounter');
  }

  function generateUserId() {
    return _generateSequentialId('USR', 'userCounter');
  }

  function generateDeviceId() {
    return _generateSequentialId('DEV', 'deviceCounter');
  }

  // --- Base64 / encoding ---

  function base64UrlEncode(bytes) {
    return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
  }

  function base64UrlDecode(str) {
    return Utilities.base64DecodeWebSafe(str);
  }

  function base64UrlEncodeString(str) {
    return base64UrlEncode(Utilities.newBlob(str).getBytes());
  }

  function base64UrlDecodeToString(str) {
    return Utilities.newBlob(base64UrlDecode(str)).getDataAsString();
  }

  // --- HMAC ---

  function hmacSha256(message, secret) {
    const bytes = Utilities.computeHmacSha256Signature(message, secret);
    return base64UrlEncode(bytes);
  }

  function sha256(input) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
    // Return hex
    return bytes.map(b => {
      const v = (b < 0 ? b + 256 : b);
      return v.toString(16).padStart(2, '0');
    }).join('');
  }

  /**
   * Constant-time string comparison to prevent timing attacks on token verification.
   */
  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /** Constant-time comparison of two byte arrays. Used for password digests. */
  function safeEqualBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= (a[i] ^ b[i]);
    }
    return diff === 0;
  }

  /**
   * Apps Script hands back Byte[] values that are not always plain JS arrays.
   * Normalising once keeps concat/slice/index access predictable.
   */
  function toByteArray(bytes) {
    return Array.prototype.slice.call(bytes);
  }

  // --- Validation ---

  function isString(v) {
    return typeof v === 'string';
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function requireField(obj, field, type) {
    if (obj == null || obj[field] === undefined || obj[field] === null) {
      throw new HandoverError('INVALID_REQUEST', `Missing required field: ${field}`);
    }
    if (type === 'string' && typeof obj[field] !== 'string') {
      throw new HandoverError('INVALID_REQUEST', `Field '${field}' must be a string.`);
    }
    if (type === 'object' && !isPlainObject(obj[field])) {
      throw new HandoverError('INVALID_REQUEST', `Field '${field}' must be an object.`);
    }
    if (type === 'boolean' && typeof obj[field] !== 'boolean') {
      throw new HandoverError('INVALID_REQUEST', `Field '${field}' must be a boolean.`);
    }
    return obj[field];
  }

  // --- Logging ---

  function log(level, message, data) {
    const entry = `[${level}] ${message}` + (data ? ' ' + JSON.stringify(data) : '');
    if (level === 'ERROR') {
      console.error(entry);
    } else {
      console.log(entry);
    }
  }

  return {
    nowIso,
    nowEpochSeconds,
    currentYear,
    dateStringYYYYMMDD,
    randomHex,
    secureRandomHex,
    secureRandomBytes,
    generateAttachmentId,
    generateSignatureId,
    generateEventId,
    generateNonce,
    generateInspectionId,
    generateUserId,
    generateDeviceId,
    base64UrlEncode,
    base64UrlDecode,
    base64UrlEncodeString,
    base64UrlDecodeToString,
    hmacSha256,
    sha256,
    safeEqual,
    safeEqualBytes,
    toByteArray,
    isString,
    isNonEmptyString,
    isPlainObject,
    requireField,
    log,
  };
})();

/**
 * Custom error class for typed errors that map to API error codes.
 */
class HandoverError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HandoverError';
    this.code = code;
    this.details = details || {};
  }
}
