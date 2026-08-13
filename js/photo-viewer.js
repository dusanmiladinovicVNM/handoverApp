/**
 * photo-viewer.js
 * A photograph, large enough to look at.
 *
 * Tapping one used to do nothing at all — no handler, no cursor, no feedback.
 * On a phone that is indistinguishable from an app that has frozen, and the
 * pictures are the point of a handover report: a meter reading you cannot read
 * is not evidence of anything.
 *
 * It opens on the preview the screen already has, scaled up, and swaps in the
 * full picture when it arrives. Waiting on a blank screen for the three seconds
 * a request costs here would be the same non-response with a spinner on it,
 * while the blurry version answers "which photograph is this" immediately —
 * which is usually the whole question.
 */

import { h } from './utils/dom.js';
import * as thumbs from './utils/thumbs.js';

/**
 * @param fetcher  (inspectionId, attachmentId) -> { mimeType, base64Data }.
 *                 Injected rather than imported so this can be exercised
 *                 without the request layer.
 */
export function openPhoto({ inspectionId, attachment, fetcher }) {
  const preview = thumbs.peek(attachment.attachmentId);
  const full = thumbs.peekFull(attachment.attachmentId);

  const img = h('img', {
    class: 'photo-viewer__img' + (full ? '' : ' photo-viewer__img--preview'),
    src: full || preview || '',
    alt: attachment.caption || attachment.fileName || 'Photograph',
  });

  const status = h('div', { class: 'photo-viewer__status' },
    full ? '' : (preview ? 'Loading full size…' : 'Loading…'));

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  const backdrop = h('div', {
    class: 'photo-viewer',
    role: 'dialog',
    'aria-modal': 'true',
    // Anywhere. A full-screen picture has no obvious chrome to aim at, and on a
    // phone the close button is at the far end of a thumb's reach.
    onClick: close,
  },
    h('button', {
      class: 'photo-viewer__close',
      'aria-label': 'Close',
      onClick: close,
    }, '×'),
    img,
    status,
  );

  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);

  if (!full) {
    thumbs.loadFull(inspectionId, attachment.attachmentId, fetcher)
      .then((url) => {
        // Only if this viewer is still the one on screen. Opening a second
        // photograph while the first is loading would otherwise put the first
        // picture into the second's frame.
        if (!backdrop.isConnected) return;
        img.src = url;
        img.classList.remove('photo-viewer__img--preview');
        status.textContent = '';
      })
      .catch((e) => {
        if (!backdrop.isConnected) return;
        // The preview stays on screen. It is a real picture of the right thing,
        // and replacing it with an error would be a worse answer than a blurry
        // one — so the message explains rather than takes over.
        status.textContent = preview
          ? `Could not load full size: ${e.message || 'request failed'}`
          : `Could not load this photograph: ${e.message || 'request failed'}`;
      });
  }

  return { close };
}
