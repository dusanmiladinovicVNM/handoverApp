/**
 * thumbs.js
 * Photo previews, held on the device once fetched.
 *
 * They used to be `<img src="drive.google.com/thumbnail?id=…">`, which the
 * browser fetched with whatever Google account it happened to be signed into.
 * That is not the rule this app runs on: a tenant has no Google account, and an
 * administrator is given rights here rather than in Drive. The first admin
 * added that way opened an inspection and found a broken-image icon where the
 * meter reading photograph should have been.
 *
 * They come through the API now, a section at a time, and are kept because
 * fetching them again would cost another three-second request for a picture
 * that cannot change — an attachment is written once and deleted, never edited.
 *
 * Two sources, and the difference matters:
 *
 *   A photo just taken is put here from the camera, before it has been uploaded
 *   and long before Drive has made a preview of it. That is instant, offline,
 *   and a truer confirmation than a copy fetched back.
 *
 *   Everything else arrives from getSectionThumbs.
 *
 * Kept in memory, not in localStorage. A section of previews is hundreds of
 * kilobytes, localStorage is a few megabytes shared with the drafts that must
 * survive a lost tab, and losing a preview costs a request while losing a draft
 * costs someone's afternoon. The Cache API would suit this and is the obvious
 * next step; for now the win is not fetching five times per section.
 */

/** attachmentId -> data: URL, or null for "Drive has no preview of this". */
const _byId = new Map();

/** inspectionId|sectionId -> promise, so five images do not make five requests. */
const _inFlight = new Map();

function _key(inspectionId, sectionId) {
  return `${inspectionId}|${sectionId}`;
}

/** What we have for one photo: a data URL, null, or undefined for unknown. */
export function peek(attachmentId) {
  return _byId.get(attachmentId);
}

/**
 * Remember a preview the device already holds.
 *
 * Used straight after the camera, where the bytes are in hand and no request
 * could improve on them.
 */
export function remember(attachmentId, dataUrl) {
  if (attachmentId && dataUrl) _byId.set(attachmentId, dataUrl);
}

export function forget(attachmentId) {
  _byId.delete(attachmentId);
  _full.delete(attachmentId);
}

/**
 * Fetch a section's previews once, however many callers ask.
 *
 * @param fetcher  called with (inspectionId, sectionId); injected so this stays
 *                 testable without a network and without importing api.js,
 *                 which would drag the whole request layer into a unit test.
 */
export async function loadSection(inspectionId, sectionId, fetcher) {
  const key = _key(inspectionId, sectionId);
  if (_inFlight.has(key)) return _inFlight.get(key);

  const pending = (async () => {
    try {
      const res = await fetcher(inspectionId, sectionId);
      for (const t of (res && res.thumbs) || []) {
        // null base64Data is Drive having no preview — recorded as such, so a
        // second look does not ask again for something that will not arrive.
        _byId.set(t.attachmentId, t.base64Data
          ? `data:${t.mimeType || 'image/jpeg'};base64,${t.base64Data}`
          : null);
      }
      return true;
    } catch (e) {
      // Left out of the map entirely rather than recorded as absent: a request
      // that failed says nothing about whether a preview exists, and marking it
      // null would stop the next attempt from ever being made.
      _inFlight.delete(key);
      throw e;
    }
  })();

  _inFlight.set(key, pending);
  return pending;
}

/** Whether a section still has photos with no preview decided either way. */
export function needsLoading(attachmentIds) {
  return (attachmentIds || []).some(id => !_byId.has(id));
}


// --- Full-size pictures ---

/**
 * The last few photographs looked at, at full size.
 *
 * Bounded, unlike the previews. A preview is a few kilobytes and an inspection
 * has tens of them; a full picture is a few hundred, and thirty of those held
 * at once is most of what a phone will give a tab before it starts discarding
 * things — including, on iOS, the tab itself.
 *
 * Small on purpose. It exists so that going back to a photograph just looked
 * at, or just taken, is instant; it is not trying to be an offline copy of the
 * inspection.
 */
const FULL_LIMIT = 5;
const _full = new Map();

function _keepFull(attachmentId, dataUrl) {
  // Re-inserted so it counts as most recent — a Map iterates in insertion
  // order, which is what makes the oldest key the first one.
  _full.delete(attachmentId);
  _full.set(attachmentId, dataUrl);
  while (_full.size > FULL_LIMIT) {
    _full.delete(_full.keys().next().value);
  }
}

export function peekFull(attachmentId) {
  return _full.get(attachmentId);
}

/** Keep a picture the device already has — the one the camera just took. */
export function rememberFull(attachmentId, dataUrl) {
  if (attachmentId && dataUrl) _keepFull(attachmentId, dataUrl);
}

/**
 * Fetch one photograph at full size, once.
 *
 * Deduplicated like the sections, because a double tap is one gesture and
 * should not be two requests of several hundred kilobytes.
 */
export async function loadFull(inspectionId, attachmentId, fetcher) {
  const held = _full.get(attachmentId);
  if (held) return held;

  const key = `full:${attachmentId}`;
  if (_inFlight.has(key)) return _inFlight.get(key);

  const pending = (async () => {
    try {
      const res = await fetcher(inspectionId, attachmentId);
      const url = `data:${res.mimeType || 'image/jpeg'};base64,${res.base64Data}`;
      _keepFull(attachmentId, url);
      return url;
    } finally {
      // Cleared either way: a failed fetch must be retryable, and a successful
      // one is in the map now and will not come back here.
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, pending);
  return pending;
}

/** For tests, and for signing out. */
export function clear() {
  _byId.clear();
  _full.clear();
  _inFlight.clear();
}
