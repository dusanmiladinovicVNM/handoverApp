/**
 * config.js
 *
 * Edit BACKEND_URL after Apps Script deployment (Step 8 of setup-guide.md).
 *
 * FRONTEND_BASE_PATH must match GitHub Pages project path.
 * For default GitHub Pages: '/handover-app/'.
 * For custom domain at root: '/'.
 */

export const BACKEND_URL = 'PASTE_DEPLOYMENT_URL_HERE';
export const FRONTEND_BASE_PATH = '/handover-app/';

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

// Autosave debounce
export const AUTOSAVE_DEBOUNCE_MS = 1500;
