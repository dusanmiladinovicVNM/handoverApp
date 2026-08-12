/**
 * download.js
 * Turning a base64 payload from the API into a file the browser saves.
 *
 * The final report used to be an <a href="https://drive.google.com/…"> — the
 * browser followed it and Drive decided who was allowed to read it, which is a
 * question Drive cannot answer for a tenant holding a link token. Now the bytes
 * come back through the API, already checked, and have to be handed to the
 * browser here.
 */

/**
 * atob gives one character per byte; Blob wants the bytes.
 *
 * Done in one pass over a typed array rather than by splitting the string:
 * a 15 MB report is 20 MB of base64, and the intermediate arrays of a
 * chunk-and-map version cost more than the copy they avoid.
 */
export function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

/**
 * Save a blob under a name.
 *
 * A synthetic click on a download link, not window.open: the fetch that
 * produced the blob is asynchronous, so by the time there is anything to show
 * the user's click is long over and a popup would be blocked. A download is
 * not.
 *
 * The object URL is revoked on a timer rather than straight after the click.
 * Revoking it immediately races the browser's own read of it — on iOS Safari
 * that reliably produces an empty file.
 */
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'download';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
