/**
 * config.js
 *
 * Edit BACKEND_URL after Apps Script deployment (Step 8 of setup-guide.md).
 *
 * FRONTEND_BASE_PATH must match GitHub Pages project path.
 * For default GitHub Pages: '/handover-app/'.
 * For custom domain at root: '/'.
 */

export const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzeHAPRXUJyJnA3K5KmtEAEiaGYZcu0IFtA9qBVAtxAf_WjQo6ZcCduTwKV6e7PrQql/exec';
export const FRONTEND_BASE_PATH = '/handoverApp/';

export const APP_VERSION = '1.0.0';

// Image compression targets (must match server-side limits in Config sheet)
export const IMAGE_MAX_DIM_PX = 1600;
export const IMAGE_JPEG_QUALITY = 0.75;
export const MAX_ATTACHMENTS_PER_ITEM = 5;
export const MAX_ATTACHMENTS_PER_INSPECTION = 80;

// API timeouts (ms)
export const API_TIMEOUT_DEFAULT = 30000;
export const API_TIMEOUT_UPLOAD = 60000;
export const API_TIMEOUT_FINALIZE = 90000;

/**
 * Signing in, which is the slowest call this app makes.
 *
 * It ran on the default and outran it. A measured sign-in spent 20.2 s inside
 * the handler — 15.4 s of that deriving the password hash, which on a cold
 * script costs an order of magnitude more than on a warm one — and the cold
 * start ahead of it is time the server never sees. Thirty seconds is not a
 * generous margin over that; it is inside the range.
 *
 * The cost of getting this wrong is not a slow screen. By the time the client
 * gives up, the server has usually finished: the session is issued, the device
 * row written, the sign-in recorded. The person sees a failure indistinguishable
 * from a wrong password, signs in again, and writes a second device row for one
 * sign-in — leaving the account's device list describing something that did not
 * happen. A timeout has to be longer than the work can legitimately take, or it
 * manufactures exactly the state it was meant to protect against.
 *
 * Set from the measurement rather than chosen: the slowest observed handler
 * time, plus the cold start, plus room. Lower it when PBKDF2 gets cheaper, not
 * before — see benchmarkPbkdf2() in BootstrapService.gs.
 */
export const API_TIMEOUT_SIGN_IN = 90000;

// Autosave debounce
export const AUTOSAVE_DEBOUNCE_MS = 1500;
