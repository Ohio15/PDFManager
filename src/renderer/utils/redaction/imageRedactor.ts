/**
 * Image pixel redaction.
 *
 * Image XObjects and inline images are decoded with pdf.js (it supports every
 * filter and colour space: DCT, JPX, JBIG2, CCITT, Flate+predictors, Indexed,
 * ICC, CMYK, /Decode, /SMask, /Mask), the pixels under each mark are painted
 * with the redaction colour, and the result is written as a NEW image object.
 * The original object is left untouched for any other page that still uses it;
 * if nothing references it any more, the engine's garbage collection drops it.
 *
 * Stencil masks (/ImageMask true) are 1-bit shapes painted with the fill
 * colour; they are decoded directly (uncompressed or Flate only) and the bits
 * under the mark are set to "not painted".
 */
import {
  PDFDocument as PDFLib,
  PDFContext,
  PDFDict,
  PDFName,
  PDFObject,
  PDFObjectCopier,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { Matrix, Rect, applyToPoint, boundsOfPoints, invert } from './geometry';
import { PdfjsEnv, PdfjsImageData, getPdfjsObject, imageDataToRgba, openPdfjs } from './pdfjsEnv';
import { decodeStreamStrict, dictGet, getBool, getDict, getNumber, numberArray, streamFilters } from './pdfObjects';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ImageEncoder {
  /** Optional JPEG encoder (RGBA in, JPEG bytes out) used when the source was DCT-encoded. */
  encodeJpeg?: (rgba: Uint8ClampedArray, width: number, height: number) => Promise<Uint8Array>;
}

export class ImageRedactionUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRedactionUnsupported';
  }
}

/** Pixel rectangles (inclusive start, exclusive end) covered by marks for an image placed by `ctm`. */
export function markPixelRects(ctm: Matrix, width: number, height: number, marks: Rect[]): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  const inv = invert(ctm);
  if (!inv) return [];
  const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const m of marks) {
    const corners = [
      applyToPoint(inv, m.x0, m.y0), applyToPoint(inv, m.x1, m.y0),
      applyToPoint(inv, m.x0, m.y1), applyToPoint(inv, m.x1, m.y1),
    ];
    const b = boundsOfPoints(corners)!;
    const u0 = Math.max(0, b.x0), u1 = Math.min(1, b.x1);
    const v0 = Math.max(0, b.y0), v1 = Math.min(1, b.y1);
    if (u1 <= u0 || v1 <= v0) continue;
    // Image row 0 is the TOP of the unit square (v = 1). One pixel of margin
    // covers resampling/interpolation bleed at the edges.
    out.push({
      x0: Math.max(0, Math.floor(u0 * width) - 1),
      x1: Math.min(width, Math.ceil(u1 * width) + 1),
      y0: Math.max(0, Math.floor((1 - v1) * height) - 1),
      y1: Math.min(height, Math.ceil((1 - v0) * height) + 1),
    });
  }
  return out;
}

function to255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** Decode any image (XObject stream or inline image bytes) to RGBA via a one-image pdf.js document. */
async function decodeWithPdfjs(
  env: PdfjsEnv,
  build: (mini: PDFLib) => { content: string | Uint8Array; resources: PDFDict }
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const mini = await PDFLib.create({ updateMetadata: false });
  const page = mini.addPage([1, 1]);
  const { content, resources } = build(mini);
  page.node.set(PDFName.of('Resources'), resources);
  page.node.set(PDFName.of('Contents'), mini.context.register(mini.context.stream(content)));
  const bytes = await mini.save({ useObjectStreams: false });

  const doc = await openPdfjs(env, bytes);
  try {
    const p = await doc.getPage(1);
    const ops = await p.getOperatorList({ annotationMode: 0 } as never);
    const OPS = env.lib.OPS;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown[];
      let img: PdfjsImageData | null = null;
      if (fn === OPS.paintImageXObject) img = await getPdfjsObject<PdfjsImageData>(p as never, args[0] as string);
      else if (fn === OPS.paintInlineImageXObject) img = args[0] as PdfjsImageData;
      if (img) {
        return { width: img.width, height: img.height, rgba: imageDataToRgba(img) };
      }
    }
    throw new ImageRedactionUnsupported('pdf.js produced no decodable image');
  } finally {
    await doc.destroy();
  }
}

async function encodeRedactedRgba(
  context: PDFContext,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  sourceDict: PDFDict,
  preferJpeg: boolean,
  encoder: ImageEncoder | undefined
): Promise<PDFRef> {
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let hasAlpha = false;
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    alpha[i] = rgba[i * 4 + 3];
    if (alpha[i] !== 255) hasAlpha = true;
  }

  const dict: Record<string, PDFObject | string | number | boolean> = {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
  };
  const interpolate = sourceDict.get(PDFName.of('Interpolate'));
  if (interpolate) dict.Interpolate = interpolate as PDFObject;
  const oc = sourceDict.get(PDFName.of('OC'));
  if (oc) dict.OC = oc as PDFObject;

  if (hasAlpha) {
    const smask = context.flateStream(alpha, {
      Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    });
    dict.SMask = context.register(smask);
  }

  if (preferJpeg && encoder?.encodeJpeg) {
    const jpeg = await encoder.encodeJpeg(rgba, width, height);
    const stream = context.stream(jpeg, { ...dict, Filter: 'DCTDecode' } as never);
    return context.register(stream);
  }
  return context.register(context.flateStream(rgb, dict as never));
}

function paintRgba(rgba: Uint8ClampedArray, width: number, rects: Array<{ x0: number; y0: number; x1: number; y1: number }>, fill: Rgb): number {
  const r = to255(fill.r), g = to255(fill.g), b = to255(fill.b);
  let painted = 0;
  for (const rect of rects) {
    for (let y = rect.y0; y < rect.y1; y++) {
      for (let x = rect.x0; x < rect.x1; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
        painted++;
      }
    }
  }
  return painted;
}

export interface ImageRedactionResult {
  ref: PDFRef;
  pixelsPainted: number;
}

/** Redact an image XObject placed by `ctm`. Returns a new image object reference. */
export async function redactImageXObject(
  srcDoc: PDFLib,
  imageStream: PDFStream,
  ctm: Matrix,
  marks: Rect[],
  fill: Rgb,
  env: PdfjsEnv,
  encoder?: ImageEncoder
): Promise<ImageRedactionResult> {
  const context = srcDoc.context;
  const dict = imageStream.dict;
  if (getBool(context, dictGet(dict, 'ImageMask')) === true) {
    return redactStencilMask(context, imageStream, ctm, marks);
  }

  const decoded = await decodeWithPdfjs(env, (mini) => {
    const copier = PDFObjectCopier.for(context, mini.context);
    const copied = copier.copy(imageStream);
    const ref = mini.context.register(copied);
    const resources = mini.context.obj({ XObject: { Im0: ref } });
    return { content: 'q 1 0 0 1 0 0 cm /Im0 Do Q', resources };
  });

  const rects = markPixelRects(ctm, decoded.width, decoded.height, marks);
  const pixelsPainted = paintRgba(decoded.rgba, decoded.width, rects, fill);
  const wasJpeg = streamFilters(context, imageStream).includes('DCTDecode');
  const ref = await encodeRedactedRgba(context, decoded.width, decoded.height, decoded.rgba, dict, wasJpeg, encoder);
  return { ref, pixelsPainted };
}

/**
 * Redact an inline image (bytes from BI to EI inclusive). Named colour spaces
 * are resolved against `colorSpaces` from the enclosing resource scope.
 * Returns a new image XObject that replaces the inline image.
 */
export async function redactInlineImage(
  srcDoc: PDFLib,
  inlineBytes: Uint8Array,
  inlineIsMask: boolean,
  colorSpaces: PDFDict | undefined,
  ctm: Matrix,
  marks: Rect[],
  fill: Rgb,
  env: PdfjsEnv
): Promise<ImageRedactionResult> {
  if (inlineIsMask) {
    throw new ImageRedactionUnsupported('Inline stencil masks are rasterized instead');
  }
  const context = srcDoc.context;
  const decoded = await decodeWithPdfjs(env, (mini) => {
    const res: Record<string, PDFObject> = {};
    if (colorSpaces) {
      const copier = PDFObjectCopier.for(context, mini.context);
      res.ColorSpace = copier.copy(colorSpaces);
    }
    const prefix = new TextEncoder().encode('q 1 0 0 1 0 0 cm\n');
    const suffix = new TextEncoder().encode('\nQ');
    const content = new Uint8Array(prefix.length + inlineBytes.length + suffix.length);
    content.set(prefix, 0);
    content.set(inlineBytes, prefix.length);
    content.set(suffix, prefix.length + inlineBytes.length);
    return { content, resources: mini.context.obj(res as never) as unknown as PDFDict };
  });
  const rects = markPixelRects(ctm, decoded.width, decoded.height, marks);
  const pixelsPainted = paintRgba(decoded.rgba, decoded.width, rects, fill);
  const ref = await encodeRedactedRgba(context, decoded.width, decoded.height, decoded.rgba, context.obj({}), false, undefined);
  return { ref, pixelsPainted };
}

function redactStencilMask(context: PDFContext, stream: PDFStream, ctm: Matrix, marks: Rect[]): ImageRedactionResult {
  const filters = streamFilters(context, stream);
  if (filters.some((f) => f !== 'FlateDecode')) {
    throw new ImageRedactionUnsupported(`Stencil mask filter ${filters.join(',')} is not decodable for redaction`);
  }
  const parms = getDict(context, dictGet(stream.dict, 'DecodeParms'));
  if (parms && (getNumber(context, dictGet(parms, 'Predictor')) ?? 1) > 1) {
    throw new ImageRedactionUnsupported('Predicted stencil masks are rasterized instead');
  }
  const width = getNumber(context, dictGet(stream.dict, 'Width')) ?? 0;
  const height = getNumber(context, dictGet(stream.dict, 'Height')) ?? 0;
  if (width <= 0 || height <= 0) throw new ImageRedactionUnsupported('Stencil mask has no size');
  const decodeArr = numberArray(context, dictGet(stream.dict, 'Decode'));
  // Default Decode [0 1]: sample 0 paints. With [1 0], sample 1 paints.
  const paintBit = decodeArr && decodeArr[0] === 1 ? 1 : 0;
  const rowBytes = (width + 7) >> 3;
  const data = new Uint8Array(decodeStreamStrict(stream));
  if (data.length < rowBytes * height) throw new ImageRedactionUnsupported('Stencil mask data is truncated');

  let painted = 0;
  for (const rect of markPixelRects(ctm, width, height, marks)) {
    for (let y = rect.y0; y < rect.y1; y++) {
      for (let x = rect.x0; x < rect.x1; x++) {
        const idx = y * rowBytes + (x >> 3);
        const bit = 0x80 >> (x & 7);
        if (paintBit === 0) data[idx] |= bit;
        else data[idx] &= ~bit;
        painted++;
      }
    }
  }
  const dict: Record<string, PDFObject | string | number | boolean> = {
    Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ImageMask: true, BitsPerComponent: 1,
  };
  const decodeObj = stream.dict.get(PDFName.of('Decode'));
  if (decodeObj) dict.Decode = decodeObj as PDFObject;
  const ref = context.register(context.flateStream(data, dict as never));
  return { ref, pixelsPainted: painted };
}

/** Encode raw RGB pixels as a Flate image XObject (used for rasterized regions). */
export function registerRgbImage(context: PDFContext, width: number, height: number, rgb: Uint8Array): PDFRef {
  return context.register(
    context.flateStream(rgb, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never)
  );
}
