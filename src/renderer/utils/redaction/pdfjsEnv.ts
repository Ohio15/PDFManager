/**
 * Injection point for pdf.js.
 *
 * The redaction engine uses pdf.js for three things it must not implement
 * itself: decoding image XObjects of every filter/colour space, rasterizing
 * page regions, and acting as an INDEPENDENT oracle (its own font decoding) to
 * verify the output. The renderer passes the bundled pdfjs-dist build with its
 * worker; tests pass the Node legacy build. Both expose the same API.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface PdfjsLib {
  getDocument: (src: Record<string, unknown>) => { promise: Promise<PDFDocumentProxy>; destroy?: () => Promise<void> };
  OPS: Record<string, number>;
}

export interface PdfjsEnv {
  lib: PdfjsLib;
  /** Extra getDocument options (standardFontDataUrl, cMapUrl, …). */
  documentOptions?: Record<string, unknown>;
}

export async function openPdfjs(env: PdfjsEnv, bytes: Uint8Array): Promise<PDFDocumentProxy> {
  // pdf.js transfers (detaches) the buffer it is given; always hand it a copy.
  const task = env.lib.getDocument({
    ...(env.documentOptions ?? {}),
    data: new Uint8Array(bytes),
    // Raw pixel data (not ImageBitmap) is required to inspect/redact images.
    isOffscreenCanvasSupported: false,
    isEvalSupported: false,
    fontExtraProperties: true,
  });
  return task.promise;
}

/** Resolve a pdf.js object (image or font) by id, waiting until it arrives. */
export function getPdfjsObject<T = unknown>(
  page: { objs: unknown; commonObjs: unknown },
  objId: string,
  forceCommon = false
): Promise<T> {
  const store = (forceCommon || objId.startsWith('g_') ? page.commonObjs : page.objs) as {
    get: (id: string, cb: (data: T) => void) => unknown;
  };
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`pdf.js object ${objId} did not resolve`)), 30000);
    store.get(objId, (data: T) => {
      clearTimeout(timer);
      resolvePromise(data);
    });
  });
}

/** pdf.js ImageKind values (src/shared/util.js). */
export const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

export interface PdfjsImageData {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: unknown;
}

/** Convert pdf.js decoded image data to tightly packed RGBA. */
export function imageDataToRgba(img: PdfjsImageData): Uint8ClampedArray {
  const { width, height } = img;
  if (!img.data) throw new Error('pdf.js returned an image without pixel data');
  const src = img.data;
  const out = new Uint8ClampedArray(width * height * 4);
  if (img.kind === IMAGE_KIND.RGBA_32BPP) {
    out.set(src.subarray(0, out.length));
  } else if (img.kind === IMAGE_KIND.RGB_24BPP) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = src[j];
      out[i * 4 + 1] = src[j + 1];
      out[i * 4 + 2] = src[j + 2];
      out[i * 4 + 3] = 255;
    }
  } else if (img.kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
  } else {
    throw new Error(`Unsupported pdf.js image kind ${img.kind}`);
  }
  return out;
}
