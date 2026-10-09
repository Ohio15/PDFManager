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

export interface OpenPdfjsOptions {
  /**
   * Verification mode. pdf.js by default IGNORES evaluator errors: it drops a
   * Form XObject it cannot process, truncates the operator list at the first
   * bad operator, and substitutes a fallback font for a missing one. Read as
   * an oracle, that shorter output looks clean. In strict mode
   * (`stopAtErrors`) those errors reject instead, so the verifier can report
   * the page as NOT EXAMINED. Originals (rasterizing, search) stay lenient:
   * there a dropped object only means less is drawn, never that a check passed.
   */
  strict?: boolean;
}

export async function openPdfjs(env: PdfjsEnv, bytes: Uint8Array, options: OpenPdfjsOptions = {}): Promise<PDFDocumentProxy> {
  // pdf.js transfers (detaches) the buffer it is given; always hand it a copy.
  const task = env.lib.getDocument({
    ...(env.documentOptions ?? {}),
    data: new Uint8Array(bytes),
    // Raw pixel data (not ImageBitmap) is required to inspect/redact images.
    isOffscreenCanvasSupported: false,
    isEvalSupported: false,
    fontExtraProperties: true,
    ...(options.strict ? { stopAtErrors: true } : {}),
  });
  return task.promise;
}

export interface RawOperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

/**
 * Read a page's operator list and REJECT if pdf.js stopped early.
 *
 * pdf.js 4.10.38 cannot report an evaluator error through its public API,
 * even with `stopAtErrors`: when the worker's operator-list stream errors,
 * PDFPageProxy marks the list `lastChunk`, RESOLVES getOperatorList() (and
 * render()) with whatever arrived so far, and only then rejects a promise
 * that has already settled (pdf.mjs _pumpOperatorList). Measured: a page
 * whose first operator is an XObject with no /Subtype yields 6 operators
 * leniently and 0 in strict mode, both "successfully". An oracle reading
 * that empty list would call the page clean.
 *
 * So this reads the worker stream itself, exactly as _pumpOperatorList does
 * (same message, same arguments), where a worker error DOES reject the read,
 * and also rejects if the stream ends without its final chunk.
 *
 * DEBT: this uses pdf.js internals (_transport, _pageIndex,
 * getRenderingIntent, messageHandler.sendWithStream). pdfjs-dist is pinned in
 * the lockfile; if a version changes those internals this throws
 * PdfjsInternalsUnavailable, which the verifier reports as NOT EXAMINED (every
 * redaction then fails loudly), never as clean. Replace with a public API if
 * pdf.js ever exposes operator-list errors.
 */
export class PdfjsInternalsUnavailable extends Error {
  constructor(what: string) {
    super(`pdf.js internals needed to detect evaluator errors are unavailable (${what})`);
    this.name = 'PdfjsInternalsUnavailable';
  }
}

interface PageInternals {
  _pageIndex?: unknown;
  _transport?: {
    getRenderingIntent?: (
      intent: string,
      annotationMode: number,
      printAnnotationStorage: null,
      isEditing: boolean,
      isOpList: boolean
    ) => { renderingIntent: number; cacheKey: string; annotationStorageSerializable: { map: unknown; transfer?: unknown }; modifiedIds: unknown };
    messageHandler?: { sendWithStream?: (action: string, data: unknown, transfers?: unknown) => ReadableStream<{ fnArray: number[]; argsArray: unknown[]; length: number; lastChunk: boolean }> };
  };
}

export async function readOperatorListStrict(page: unknown, annotationMode = 0): Promise<RawOperatorList> {
  const p = page as PageInternals;
  const transport = p._transport;
  if (typeof p._pageIndex !== 'number') throw new PdfjsInternalsUnavailable('page index');
  if (typeof transport?.getRenderingIntent !== 'function') throw new PdfjsInternalsUnavailable('getRenderingIntent');
  if (typeof transport.messageHandler?.sendWithStream !== 'function') throw new PdfjsInternalsUnavailable('sendWithStream');
  // The transport DROPS page objects (decoded images) for a page with no
  // operator-list intent registered, so register one through the public call
  // first; its (possibly silently truncated) result is not used.
  const publicList = (page as { getOperatorList?: (o: unknown) => Promise<unknown> }).getOperatorList;
  if (typeof publicList !== 'function') throw new PdfjsInternalsUnavailable('getOperatorList');
  const registered = publicList.call(page, { annotationMode }).catch(() => undefined);
  const intent = transport.getRenderingIntent('display', annotationMode, null, false, true);
  const stream = transport.messageHandler.sendWithStream(
    'GetOperatorList',
    {
      pageIndex: p._pageIndex,
      intent: intent.renderingIntent,
      cacheKey: intent.cacheKey,
      annotationStorage: intent.annotationStorageSerializable.map,
      modifiedIds: intent.modifiedIds,
    },
    intent.annotationStorageSerializable.transfer
  );
  const reader = stream.getReader();
  const fnArray: number[] = [];
  const argsArray: unknown[] = [];
  let complete = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) {
        fnArray.push(value.fnArray[i]);
        argsArray.push(value.argsArray[i]);
      }
      if (value.lastChunk) complete = true;
    }
  } finally {
    reader.releaseLock();
    await registered;
  }
  if (!complete) throw new Error('pdf.js operator list ended before its final chunk');
  return { fnArray, argsArray };
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
