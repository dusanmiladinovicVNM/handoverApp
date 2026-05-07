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

  function randomHex(len) {
    const chars = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(Math.random() * 16)];
    }
    return out;
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
    return randomHex(8);
  }

  /**
   * Generates next inspection ID atomically using ScriptLock.
   * Format: INS-YYYY-NNNNNN
   */
  function generateInspectionId() {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const year = currentYear();
      const props = PropertiesService.getScriptProperties();
      const key = `inspectionCounter_${year}`;
      const current = parseInt(props.getProperty(key) || '0', 10);
      const next = current + 1;
      props.setProperty(key, String(next));
      const padded = String(next).padStart(6, '0');
      return `INS-${year}-${padded}`;
    } finally {
      lock.releaseLock();
    }
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
    generateAttachmentId,
    generateSignatureId,
    generateEventId,
    generateNonce,
    generateInspectionId,
    base64UrlEncode,
    base64UrlDecode,
    base64UrlEncodeString,
    base64UrlDecodeToString,
    hmacSha256,
    sha256,
    safeEqual,
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
