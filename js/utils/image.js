/**
 * utils/image.js
 * Client-side image compression using canvas.
 * Server enforces no resize — we must do it here.
 */

import { IMAGE_MAX_DIM_PX, IMAGE_JPEG_QUALITY } from '../config.js';

/**
 * Compress a File or Blob image:
 *  - resize so max(width, height) <= maxDim
 *  - re-encode as JPEG at given quality
 *  - return { blob, base64Data, width, height, mimeType }
 *
 * The base64Data has no `data:image/jpeg;base64,` prefix — backend expects raw base64.
 */
export async function compressImage(file, opts = {}) {
  const maxDim = opts.maxDim || IMAGE_MAX_DIM_PX;
  const quality = opts.quality || IMAGE_JPEG_QUALITY;

  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);

  // Determine target dimensions
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round(height * (maxDim / width));
      width = maxDim;
    } else {
      width = Math.round(width * (maxDim / height));
      height = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // White background in case of transparent PNGs
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('toBlob returned null')),
      'image/jpeg',
      quality
    );
  });

  const base64Data = await blobToBase64(blob);

  return {
    blob,
    base64Data,
    width,
    height,
    mimeType: 'image/jpeg',
    sizeBytes: blob.size,
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:image/jpeg;base64,XXXX" — strip prefix
      const result = reader.result;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.substring(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Convert a canvas/blob to base64 string (no data: prefix). */
export function canvasToBase64(canvas, mimeType = 'image/png') {
  const dataUrl = canvas.toDataURL(mimeType);
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl;
}
