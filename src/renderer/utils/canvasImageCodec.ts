/**
 * canvasImageCodec — the renderer's ImageRecodec for compress.ts.
 *
 * Decodes with createImageBitmap, resamples with the browser's high-quality
 * scaler, and encodes JPEG via OffscreenCanvas. Colour management is disabled
 * (colorSpaceConversion: 'none') so samples keep the meaning of the PDF image
 * colour space they came from; compress.ts only sends 1- and 3-component
 * sources, never CMYK.
 */

import type { ImageRecodec, RecodeRequest } from './compress';

async function toBitmap(request: RecodeRequest): Promise<ImageBitmap> {
  const resize = {
    resizeWidth: request.targetWidth,
    resizeHeight: request.targetHeight,
    resizeQuality: 'high' as ResizeQuality,
    colorSpaceConversion: 'none' as ColorSpaceConversion,
    premultiplyAlpha: 'none' as PremultiplyAlpha,
  };
  const { source } = request;
  if (source.kind === 'jpeg') {
    // Copy into a fresh ArrayBuffer-backed view (Blob rejects SharedArrayBuffer-typed views).
    const blob = new Blob([new Uint8Array(source.bytes)], { type: 'image/jpeg' });
    return createImageBitmap(blob, resize);
  }
  const imageData = new ImageData(source.data, source.width, source.height);
  return createImageBitmap(imageData, resize);
}

export const canvasImageCodec: ImageRecodec = {
  async recode(request: RecodeRequest): Promise<Uint8Array> {
    const bitmap = await toBitmap(request);
    try {
      const canvas = new OffscreenCanvas(request.targetWidth, request.targetHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      // JPEG has no alpha: paint on white so any transparent pixel is defined.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, request.targetWidth, request.targetHeight);
      ctx.drawImage(bitmap, 0, 0, request.targetWidth, request.targetHeight);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: request.quality });
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      bitmap.close();
    }
  },
};
